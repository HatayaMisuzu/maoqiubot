import { execFileSync } from 'node:child_process'
import { closeSync, copyFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { packager } from '@electron/packager'

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)))
const name = 'Xiaomaoqiu'
const packageDirName = name + '-win32-x64'
const requiredManagerFiles = ['agent-manager.exe', 'LICENSE-CC-Switch.txt', 'THIRD_PARTY_NOTICES-agent-manager.txt']
const runtimeDirectories = new Set(['desktop', 'server', 'connector', 'contracts', 'web-demo', 'plugins'])
const sourceDirectories = [...runtimeDirectories, '.git', '.github', 'node_modules', 'data', 'docs', 'test', 'e2e', 'vendor', 'scripts']
const runtimeFiles = new Set([
  'package.json',
  'THIRD_PARTY_NOTICES.md',
  'connector/config.example.json',
  'server/chat/decision.json',
  'scripts/project-api.ts',
  'scripts/backup.ts'
])
const requiredAppFiles = [
  ...runtimeFiles, 'desktop/main.cjs', 'desktop/preload.cjs', 'desktop/connector.mjs',
  'desktop/agent-manager.cjs', 'desktop/connector-settings.cjs', 'desktop/codex-switch-recovery.cjs',
  'desktop/connector-maintenance.cjs', 'desktop/hermes-discovery.cjs', 'server/index.ts', 'server/db/index.ts',
  'connector/index.ts', 'connector/store.ts', 'contracts/agent-runtime.ts', 'web-demo/index.html',
  'web-demo/app.js', 'web-demo/connector-connection.js', 'plugins/web/plugin.json', 'plugins/web/index.ts'
]
const testPaths = /(?:^|\/)(?:__tests__|__fixtures__|tests?|fixtures?|test-results|playwright-report)(?:\/|$)|(?:^|[/.])(?:test|spec)[.-][^/]+$/i
const privatePaths = /(?:^|\/)(?:data|backups?|credentials?|secrets?)(?:\/|\.|$)|(?:^|\/)(?:auth|desktop-connector)\.json$|\.(?:local|private)(?:\.|$)/i
const moveOperations = { cpSync, renameSync, rmSync }

function formatTimestamp(date = new Date()) {
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function pathExists(path) {
  return lstatSync(path, { throwIfNoEntry: false })
}

function containsPath(parent, child) {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function overlaps(first, second) {
  return containsPath(first, second) || containsPath(second, first)
}

function checkedDirectory(path) {
  const directory = resolve(path)
  const volume = parse(directory).root
  if (process.platform === 'win32' && (volume.startsWith('\\\\?\\') || volume.startsWith('\\\\.\\') ||
      directory.slice(volume.length).split(sep).some(part => /[<>:"|?*\x00-\x1f]|[. ]$|^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)))) {
    throw Error(`拒绝有歧义的 Windows 构建路径 ${directory}`)
  }
  for (let current = directory; ; current = dirname(current)) {
    const entry = pathExists(current)
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink() || relative(current, realpathSync(current)) !== '')) {
      throw Error(`构建路径须使用真实目录，不能经过符号链接或联接 ${current}`)
    }
    if (current === volume) break
  }
  return directory
}

function assertDisjointPaths(...directories) {
  for (const [index, first] of directories.entries()) {
    if (first === parse(first).root) throw Error(`拒绝使用磁盘根目录 ${first}`)
    for (const second of directories.slice(index + 1)) {
      if (overlaps(first, second)) throw Error(`打包目录互相重叠 ${first} / ${second}`)
    }
  }
}

function assertDestinationAvailable(destination) {
  if (pathExists(destination)) throw Error(`发布或归档目标已存在 ${destination}`)
}

function verifyCopy(source, copy, buffers) {
  const from = lstatSync(source)
  const to = lstatSync(copy)
  if (from.isDirectory() && to.isDirectory()) {
    const names = readdirSync(source).sort()
    const copiedNames = readdirSync(copy).sort()
    if (names.length === copiedNames.length && names.every((name, index) => name === copiedNames[index])) {
      for (const name of names) verifyCopy(join(source, name), join(copy, name), buffers)
      return
    }
  } else if (from.isFile() && to.isFile() && from.size === to.size) {
    const [sourceBytes, copyBytes] = buffers
    const sourceFd = openSync(source, 'r')
    try {
      const copyFd = openSync(copy, 'r')
      try {
        for (let position = 0; position < from.size; position += sourceBytes.length) {
          const length = Math.min(sourceBytes.length, from.size - position)
          if (readSync(sourceFd, sourceBytes, 0, length, position) !== length ||
              readSync(copyFd, copyBytes, 0, length, position) !== length ||
              !sourceBytes.subarray(0, length).equals(copyBytes.subarray(0, length))) {
            throw Error(`跨盘复制内容不一致 ${source}`)
          }
        }
        return
      } finally {
        closeSync(copyFd)
      }
    } finally {
      closeSync(sourceFd)
    }
  }
  throw Error(`跨盘复制内容不一致 ${source}`)
}

function withCleanup(action, cleanup, directory) {
  let failure
  try {
    return action()
  } catch (error) {
    failure = error
    throw error
  } finally {
    try {
      cleanup()
    } catch (error) {
      const message = `无法清理临时目录 ${directory}：${error.message}`
      throw failure ? new AggregateError([failure, error], `${failure.message}\n${message}`) : Error(message, { cause: error })
    }
  }
}

function moveEntry(source, destination, operations) {
  assertDestinationAvailable(destination)
  try {
    operations.renameSync(source, destination)
    return
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
  }

  const transferDir = mkdtempSync(join(dirname(destination), '.maoqiu-transfer-'))
  const temporary = join(transferDir, 'entry')
  withCleanup(() => {
    operations.cpSync(source, temporary, {
      recursive: true, force: false, errorOnExist: true,
      filter(path) {
        const entry = lstatSync(path)
        if (!entry.isFile() && !entry.isDirectory()) throw Error(`拒绝跨盘复制链接或特殊文件 ${path}`)
        return true
      }
    })
    verifyCopy(source, temporary, [Buffer.alloc(1024 * 1024), Buffer.alloc(1024 * 1024)])
    assertDestinationAvailable(destination)
    operations.renameSync(temporary, destination)
    try {
      operations.rmSync(source, { recursive: true })
    } catch (error) {
      throw Error(`跨盘复制已校验，完整副本位于 ${destination}。未能移除源路径 ${source}：${error.message}`, { cause: error })
    }
  }, () => rmSync(transferDir, { recursive: true, force: true }), transferDir)
}

function nextArchivePath(archiveDir, entryName, keepName, stamp) {
  const preferred = entryName === keepName ? `${entryName}-${stamp}` : entryName
  let candidate = join(archiveDir, preferred)
  if (!lstatSync(candidate, { throwIfNoEntry: false })) return candidate
  const stamped = entryName === keepName ? preferred : `${entryName}-${stamp}`
  candidate = join(archiveDir, stamped)
  if (!lstatSync(candidate, { throwIfNoEntry: false })) return candidate
  for (let index = 2; ; index++) {
    const numbered = join(archiveDir, `${stamped}-${index}`)
    if (!lstatSync(numbered, { throwIfNoEntry: false })) return numbered
  }
}

export function resolveAgentManagerDir(projectRoot = root) {
  const preferred = join(projectRoot, 'build', 'agent-manager')
  const legacy = join(projectRoot, 'dist', 'agent-manager')
  if (lstatSync(join(preferred, 'agent-manager.exe'), { throwIfNoEntry: false })?.isFile()) return preferred
  if (lstatSync(join(legacy, 'agent-manager.exe'), { throwIfNoEntry: false })?.isFile()) return legacy
  return preferred
}

function restoreArchived(moved, failure, operations) {
  const errors = []
  for (const item of [...moved].reverse()) {
    try {
      moveEntry(item.to, item.from, operations)
    } catch (error) {
      errors.push(Error(`恢复旧包失败。检查归档 ${item.to}，将 ${item.from} 的现有内容移到其他位置后再恢复。${error.message}`, { cause: error }))
    }
  }
  if (errors.length) throw new AggregateError([failure, ...errors], [failure.message, ...errors.map(error => error.message)].join('\n'))
  throw failure
}

function assertWindowsPackageIdle(entries) {
  if (process.platform !== 'win32') return
  const query = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Process -ErrorAction Stop | Where-Object { $_.ProcessName -in '${name}', 'agent-manager' } | ForEach-Object { if ($_.Path) { $_.Path } else { '?' } }`
  const running = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
  for (const path of running.trim().split(/\r?\n/).filter(Boolean)) {
    const executable = pathExists(path) ? realpathSync(path) : path
    if (path === '?' || entries.some(entry => containsPath(entry, executable))) {
      throw Error('检测到正在运行且可能使用旧包的工作台或 Agent 管理窗口，请从托盘退出该工作台并关闭管理窗口后重试。')
    }
  }
}

export function archiveExistingDist({ distDir, archiveDir, keepName = packageDirName, stamp = formatTimestamp(), onlyTarget = false, operations = moveOperations }) {
  distDir = checkedDirectory(distDir)
  archiveDir = checkedDirectory(archiveDir)
  assertDisjointPaths(distDir, archiveDir)
  if (!pathExists(distDir)) return []
  const entries = readdirSync(distDir).filter(entry => !onlyTarget || relative(join(distDir, keepName), join(distDir, entry)) === '')
  if (!entries.length) return []
  for (const entryName of entries) {
    const stat = lstatSync(join(distDir, entryName))
    if (!stat.isFile() && !stat.isDirectory()) throw Error(`拒绝归档链接或特殊文件 ${entryName}`)
  }
  assertWindowsPackageIdle(entries.map(entry => join(distDir, entry)))
  mkdirSync(archiveDir, { recursive: true })
  checkedDirectory(archiveDir)
  const moved = []
  try {
    for (const entryName of entries) {
      const from = join(distDir, entryName)
      const to = nextArchivePath(archiveDir, entryName, keepName, stamp)
      moveEntry(from, to, operations)
      moved.push({ name: entryName, from, to })
    }
  } catch (error) {
    restoreArchived(moved, error, operations)
  }
  return moved
}

function assertAgentManagerReady(directory) {
  checkedDirectory(directory)
  try {
    assertExecutable(join(directory, requiredManagerFiles[0]))
    for (const file of requiredManagerFiles.slice(1)) assertFile(join(directory, file))
  } catch (error) {
    throw Error(`${error.message}。请先运行 npm run build:agent-manager。`, { cause: error })
  }
}

function assertFile(file) {
  checkedDirectory(dirname(file))
  const stat = pathExists(file)
  if (!stat?.isFile() || !stat.size) throw Error(`桌面打包缺少有效资源 ${file}`)
}

function assertExecutable(file) {
  assertFile(file)
  const dos = Buffer.alloc(64)
  const pe = Buffer.alloc(6)
  const fd = openSync(file, 'r')
  try {
    if (readSync(fd, dos, 0, dos.length, 0) !== dos.length || dos.toString('ascii', 0, 2) !== 'MZ' ||
        readSync(fd, pe, 0, pe.length, dos.readUInt32LE(60)) !== pe.length || pe.readUInt32LE(0) !== 0x4550 || pe.readUInt16LE(4) !== 0x8664) {
      throw Error(`桌面打包包含无效的 Windows x64 入口文件 ${file}`)
    }
  } finally {
    closeSync(fd)
  }
}

function assertDesktopPackage(release, runtimePackages) {
  assertExecutable(join(release, `${name}.exe`))
  for (const file of ['ffmpeg.dll', 'icudtl.dat', 'resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'locales/en-US.pak', 'LICENSE', 'LICENSES.chromium.html']) {
    assertFile(join(release, file))
  }
  const app = checkedDirectory(join(release, 'resources', 'app'))
  for (const file of requiredAppFiles) assertFile(join(app, file))
  const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'))
  if (manifest.name !== 'xiaomaoqiu-workbench' || manifest.main !== 'desktop/main.cjs') throw Error('打包应用入口配置无效')
  const requiredDependencies = new Set([...runtimePackages, ...Object.keys(manifest.dependencies ?? {}).map(dep => `node_modules/${dep}`)])
  for (const pkg of requiredDependencies) assertFile(join(checkedDirectory(join(app, pkg)), 'package.json'))
  assertAgentManagerReady(join(release, 'resources', 'agent-manager'))
}

export function publishDesktopPackage({ stagedRelease, out, archiveDir, archiveAll, runtimePackages = [], operations = moveOperations }) {
  out = checkedDirectory(out)
  archiveDir = checkedDirectory(archiveDir)
  stagedRelease = checkedDirectory(stagedRelease)
  assertDisjointPaths(out, archiveDir, stagedRelease)
  assertDesktopPackage(stagedRelease, runtimePackages)
  mkdirSync(out, { recursive: true })
  checkedDirectory(out)
  const target = checkedDirectory(join(out, packageDirName))
  const archived = archiveExistingDist({ distDir: out, archiveDir, onlyTarget: !archiveAll, operations })
  try {
    moveEntry(stagedRelease, target, operations)
  } catch (error) {
    restoreArchived(archived, error, operations)
  }
  return { target, archived }
}

function createExclude(runtimePackages, privateLocations) {
  const packages = new Set(runtimePackages)
  return function exclude(path) {
    const file = path.replace(/^\//, '')
    if (!file) return false
    const source = join(root, file)
    if (privateLocations.some(location => containsPath(location, source))) return true
    const stat = lstatSync(source)
    if (!stat.isFile() && !stat.isDirectory()) return true
    if (runtimeFiles.has(file) || file === 'scripts' || file === 'node_modules') return false
    const parts = file.split('/')
    if (parts.some(part => part.startsWith('.')) || testPaths.test(file)) return true
    if (file.startsWith('node_modules/')) {
      if (runtimePackages.some(pkg => pkg.startsWith(file + '/'))) return false
      const owner = /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+/g
      const matches = [...file.matchAll(owner)]
      const last = matches.at(-1)
      const ownerPath = file.slice(0, last.index + last[0].length)
      return !packages.has(ownerPath) || file.endsWith('/node_modules')
    }
    if (!runtimeDirectories.has(parts[0]) || privatePaths.test(file) || file === 'connector/native-smoke.ts') return true
    if (parts[0] === 'plugins' && file !== 'plugins' && file !== 'plugins/README.md' && !/^plugins\/(?:web|examples)(?:\/|$)/.test(file)) return true
    return !(stat.isDirectory() || /\.(?:cjs|mjs|js|ts|html|css|ico|png|svg|webp|woff2)$/.test(file) ||
      parts[0] === 'plugins' && /\.(?:json|md)$/.test(file))
  }
}

async function runCli() {
  const defaultDist = join(root, 'dist')
  const out = checkedDirectory(process.env.MAOQIU_PACKAGE_OUT || defaultDist)
  const archiveDir = checkedDirectory(process.env.MAOQIU_PACKAGE_ARCHIVE || join(root, 'backups', 'desktop-packages'))
  const stageBase = checkedDirectory(join(root, 'build'))
  const isDefaultDist = relative(defaultDist, out) === ''
  assertDisjointPaths(out, archiveDir)
  checkedDirectory(join(out, packageDirName))
  const privateLocations = ['MAOQIU_DATA', 'MAOQIU_DESKTOP_PROFILE', 'MAOQIU_CONNECTOR_CONFIG']
    .map(key => process.env[key]).filter(Boolean).map(path => resolve(path))
  const protectedPaths = [...sourceDirectories.map(dir => join(root, dir)), ...privateLocations]
  for (const directory of [out, archiveDir]) {
    if (containsPath(directory, stageBase) || protectedPaths.some(path => overlaps(directory, path)) ||
        (!isDefaultDist || directory === archiveDir) && overlaps(directory, defaultDist)) {
      throw Error(`构建路径与源码、数据或默认发行目录重叠 ${directory}`)
    }
  }

  const agentManager = resolveAgentManagerDir(root)
  assertAgentManagerReady(agentManager)

  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const lockfile = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
  const checksums = JSON.parse(readFileSync(join(root, 'node_modules/electron/checksums.json'), 'utf8'))
  const production = Object.entries(lockfile.packages)
    .filter(([pkgPath, info]) => pkgPath.startsWith('node_modules/') && !info.dev)
  mkdirSync(stageBase, { recursive: true })
  const stageDir = mkdtempSync(join(stageBase, '.package-stage-'))
  let failure
  try {
    checkedDirectory(stageDir)
    assertDisjointPaths(out, archiveDir, stageDir)
    const stageManager = join(stageDir, 'agent-manager')
    mkdirSync(stageManager)
    for (const file of requiredManagerFiles) copyFileSync(join(agentManager, file), join(stageManager, file))
    const [stagedRelease] = await packager({
      dir: root, name, out: stageDir, platform: 'win32', arch: 'x64',
      electronVersion: manifest.devDependencies.electron,
      download: { checksums },
      icon: join(root, 'desktop', 'icon.ico'),
      win32metadata: { ProductName: '小毛球工作台', FileDescription: '小毛球工作台' },
      extraResource: [stageManager], asar: false, prune: false,
      ignore: createExclude(production.map(([path]) => path), privateLocations)
    })
    const { target, archived } = publishDesktopPackage({
      stagedRelease, out, archiveDir, archiveAll: isDefaultDist,
      runtimePackages: production.filter(([, info]) => !info.optional).map(([path]) => path)
    })
    for (const item of archived) {
      console.log(`已留档旧包 ${item.name} -> ${item.to}`)
    }
    console.log('桌面应用 ' + join(target, name + '.exe'))
  } catch (error) {
    failure = error
    throw error
  } finally {
    try {
      rmSync(stageDir, { recursive: true, force: true })
    } catch (error) {
      const message = `无法清理打包暂存目录 ${stageDir}：${error.message}`
      throw failure ? new AggregateError([failure, error], `${failure.message}\n${message}`) : Error(message, { cause: error })
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runCli()
}
