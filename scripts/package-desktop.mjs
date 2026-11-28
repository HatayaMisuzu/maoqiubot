import { cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { packager } from '@electron/packager'

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)))
const name = 'Xiaomaoqiu'
const packageDirName = name + '-win32-x64'
const requiredManagerFiles = ['agent-manager.exe', 'LICENSE-CC-Switch.txt', 'THIRD_PARTY_NOTICES-agent-manager.txt']
const runtimeDirectories = new Set(['desktop', 'server', 'connector', 'contracts', 'web-demo', 'plugins'])
const runtimeFiles = new Set([
  'package.json',
  'THIRD_PARTY_NOTICES.md',
  'connector/config.example.json',
  'server/chat/decision.json',
  'scripts/project-api.ts',
  'scripts/backup.ts'
])

function formatTimestamp(date = new Date()) {
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function moveEntry(sourcePath, destinationPath) {
  try {
    renameSync(sourcePath, destinationPath)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    cpSync(sourcePath, destinationPath, { recursive: true })
    rmSync(sourcePath, { recursive: true, force: true })
  }
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

export function archiveExistingDist({ distDir, archiveDir, keepName = packageDirName, stamp = formatTimestamp() }) {
  if (!lstatSync(distDir, { throwIfNoEntry: false })?.isDirectory()) return []
  const entries = readdirSync(distDir)
  if (!entries.length) return []
  mkdirSync(archiveDir, { recursive: true })
  const resolvedArchive = realpathSync(archiveDir)
  if (resolvedArchive !== resolve(archiveDir)) {
    throw Error('桌面包留档目录须为真实路径，不能为符号链接')
  }
  const moved = []
  try {
    for (const entryName of entries) {
      const from = join(distDir, entryName)
      if (lstatSync(from).isSymbolicLink()) {
        throw Error('dist 目录内存在符号链接，拒绝留档：' + entryName)
      }
      const to = nextArchivePath(archiveDir, entryName, keepName, stamp)
      moveEntry(from, to)
      moved.push({ name: entryName, from, to })
    }
  } catch (error) {
    for (const item of [...moved].reverse()) {
      try {
        if (!lstatSync(item.from, { throwIfNoEntry: false })) moveEntry(item.to, item.from)
      } catch {}
    }
    throw error
  }
  return moved
}

function assertAgentManagerReady(directory) {
  for (const file of requiredManagerFiles) {
    if (!lstatSync(join(directory, file), { throwIfNoEntry: false })?.isFile()) {
      throw Error(`缺少内置 Agent 管理文件 ${file}，请先运行 npm run build:agent-manager。`)
    }
  }
}

function createExclude(runtimePackages) {
  return function exclude(path) {
    const file = path.replace(/^\//, '')
    if (!file) return false
    const stat = lstatSync(join(root, file))
    if (stat.isSymbolicLink()) return true
    if (runtimeFiles.has(file) || file === 'scripts' || file === 'node_modules') return false
    if (file.startsWith('node_modules/')) {
      return !runtimePackages.some(pkg => file === pkg || pkg.startsWith(file + '/') || file.startsWith(pkg + '/'))
    }
    const parts = file.split('/')
    if (!runtimeDirectories.has(parts[0]) || parts.some(part => part.startsWith('.') || part === 'data')) return true
    return !(stat.isDirectory() || /\.(?:cjs|mjs|js|ts|html|css|ico|png|svg|webp|woff2)$/.test(file) ||
      parts[0] === 'plugins' && /\.(?:json|md)$/.test(file))
  }
}

async function runCli() {
  const defaultDist = join(root, 'dist')
  const out = process.env.MAOQIU_PACKAGE_OUT ? resolve(process.env.MAOQIU_PACKAGE_OUT) : defaultDist
  const archiveDir = process.env.MAOQIU_PACKAGE_ARCHIVE ? resolve(process.env.MAOQIU_PACKAGE_ARCHIVE) : join(root, 'backups', 'desktop-packages')
  const isDefaultDist = resolve(out) === resolve(defaultDist)
  const target = join(out, packageDirName)
  const agentManager = resolveAgentManagerDir(root)
  assertAgentManagerReady(agentManager)

  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const lockfile = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
  const checksums = JSON.parse(readFileSync(join(root, 'node_modules/electron/checksums.json'), 'utf8'))
  const runtimePackages = Object.entries(lockfile.packages)
    .filter(([pkgPath, info]) => pkgPath.startsWith('node_modules/') && !info.dev)
    .map(([pkgPath]) => pkgPath)

  mkdirSync(out, { recursive: true })
  if (realpathSync(out) !== resolve(out) || lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw Error('桌面构建目录及包目标须为实际目录，不能通过符号链接覆盖其他文件')
  }

  const packOptions = {
    dir: root,
    name,
    platform: 'win32',
    arch: 'x64',
    electronVersion: manifest.devDependencies.electron,
    download: { checksums },
    icon: join(root, 'desktop', 'icon.ico'),
    win32metadata: { ProductName: '小毛球工作台', FileDescription: '小毛球工作台' },
    extraResource: [agentManager],
    asar: false,
    prune: false,
    overwrite: true,
    ignore: createExclude(runtimePackages)
  }

  if (!isDefaultDist) {
    const [release] = await packager({ ...packOptions, out })
    console.log('桌面应用 ' + join(release, name + '.exe'))
    return
  }

  const stageDir = join(root, 'build', '.package-stage-' + Date.now())
  mkdirSync(stageDir, { recursive: true })
  let archived = []
  try {
    const [stagedRelease] = await packager({ ...packOptions, out: stageDir })
    if (!lstatSync(join(stagedRelease, name + '.exe'), { throwIfNoEntry: false })?.isFile()) {
      throw Error('桌面打包产物缺少 Xiaomaoqiu.exe')
    }
    const stagedManager = join(stagedRelease, 'resources', 'agent-manager')
    assertAgentManagerReady(stagedManager)

    archived = archiveExistingDist({ distDir: out, archiveDir })
    try {
      moveEntry(stagedRelease, target)
    } catch (error) {
      for (const item of [...archived].reverse()) {
        try {
          if (!lstatSync(item.from, { throwIfNoEntry: false })) moveEntry(item.to, item.from)
        } catch {}
      }
      throw error
    }
  } finally {
    rmSync(stageDir, { recursive: true, force: true })
  }

  for (const item of archived) {
    console.log(`已留档旧包 ${item.name} -> ${item.to}`)
  }
  console.log('桌面应用 ' + join(target, name + '.exe'))
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runCli()
}
