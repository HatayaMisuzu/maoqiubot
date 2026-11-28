import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const vendor = join(root, 'vendor', 'cc-switch')
const upstream = 'https://github.com/farion1231/cc-switch.git'
const revision = '754fed72d428c66c1e6ed45f38601ac25ded90c6'
const buildDir = join(root, 'build', '.agent-manager-work')
const source = join(buildDir, 'source')
const patch = join(vendor, 'maoqiu.patch')
const normalizedPatch = join(buildDir, 'maoqiu.patch')
const artifact = join(root, 'build', 'agent-manager', 'agent-manager.exe')
const target = 'x86_64-pc-windows-msvc'

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw Error(`${command} failed (${result.status}): ${args.join(' ')}`)
  return result.stdout
}

function git(...args) {
  return run('git', ['-c', 'core.autocrlf=false', ...args], source)
}

function prepareSource() {
  mkdirSync(source, { recursive: true })
  if (!existsSync(join(source, '.git'))) git('init', '--quiet')
  const hasRevision = spawnSync('git', ['cat-file', '-e', revision + '^{commit}'], {
    cwd: source, stdio: 'ignore'
  }).status === 0
  if (!hasRevision) git('fetch', '--depth=1', upstream, revision)

  // Always revert any prior applied patch before switching commits.
  const appliedFile = join(buildDir, 'applied.patch')
  const patchContents = Buffer.from(readFileSync(patch, 'utf8').replace(/\r\n/g, '\n'))
  writeFileSync(normalizedPatch, patchContents)

  const current = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
  })
  const currentHead = current.status === 0 ? current.stdout.trim() : ''
  const sameCommit = currentHead === revision
  const samePatch = existsSync(appliedFile) && readFileSync(appliedFile).equals(patchContents)

  if (sameCommit && samePatch) {
    git('apply', '--reverse', '--check', normalizedPatch)
    return
  }
  if (existsSync(appliedFile) && currentHead) {
    const rev = spawnSync('git', ['-c', 'core.autocrlf=false', 'apply', '--reverse', '--index', appliedFile], {
      cwd: source, stdio: 'ignore'
    })
    if (rev.status !== 0) {
      git('reset', '--hard', '--quiet')
      git('clean', '-fd', '--quiet')
    }
    rmSync(appliedFile, { force: true })
  }
  if (!sameCommit) git('checkout', '--detach', '--quiet', revision)
  git('apply', '--index', normalizedPatch)
  copyFileSync(normalizedPatch, appliedFile)
}

function collectNpmPackages(sourceDir) {
  const manifest = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8'))
  const direct = Object.keys(manifest.dependencies || {})
  const results = new Map()
  const pnpmDir = join(sourceDir, 'node_modules', '.pnpm')
  if (existsSync(pnpmDir)) {
    for (const storeEntry of readdirSync(pnpmDir, { withFileTypes: true })) {
      if (!storeEntry.isDirectory()) continue
      const nm = join(pnpmDir, storeEntry.name, 'node_modules')
      if (!existsSync(nm)) continue
      for (const pkg of readdirSync(nm, { withFileTypes: true })) {
        if (!pkg.isDirectory() && !pkg.isSymbolicLink()) continue
        const dirs = pkg.name.startsWith('@')
          ? readdirSync(join(nm, pkg.name), { withFileTypes: true }).map(sub => [pkg.name + '/' + sub.name, join(nm, pkg.name, sub.name)])
          : [[pkg.name, join(nm, pkg.name)]]
        for (const [name, dir] of dirs) {
          const pkgJson = join(dir, 'package.json')
          if (!existsSync(pkgJson)) continue
          try {
            const info = JSON.parse(readFileSync(pkgJson, 'utf8'))
            const ver = info.version || 'unknown'
            const key = `${name}@${ver}`
            if (!results.has(key)) {
              const license = typeof info.license === 'string' ? info.license : info.license?.type || 'see package'
              results.set(key, `${name}@${ver} (${license})`)
            }
          } catch {}
        }
      }
    }
  }
  return {
    directCount: direct.length,
    direct,
    packages: [...results.values()].sort()
  }
}

function collectCargoPackages(sourceDir) {
  const lockPath = join(sourceDir, 'src-tauri', 'Cargo.lock')
  if (!existsSync(lockPath)) return []
  const raw = readFileSync(lockPath, 'utf8')
  const blocks = raw.split(/\r?\n\[\[package\]\]\r?\n/).slice(1)
  return blocks.map(block => {
    const name = /^name = "([^"]+)"/m.exec(block)?.[1]
    const version = /^version = "([^"]+)"/m.exec(block)?.[1]
    return name && version ? `${name} ${version}` : null
  }).filter(Boolean).sort()
}

export function writeAgentManagerNotices(sourceDir, outDir) {
  mkdirSync(outDir, { recursive: true })
  const npmInfo = collectNpmPackages(sourceDir)
  const crates = collectCargoPackages(sourceDir)
  const lines = [
    'THIRD-PARTY SOFTWARE NOTICES FOR agent-manager.exe',
    '====================================================',
    '',
    `Built from upstream farion1231/cc-switch (commit ${revision}, MIT License).`,
    'See LICENSE-CC-Switch.txt in this directory for the full CC Switch MIT license.',
    '',
    `Bundled Direct Frontend Dependencies (${npmInfo.directCount}):`,
    ...npmInfo.direct.map(name => `- ${name}`),
    '',
    `Resolved Frontend Packages in Build Tree (${npmInfo.packages.length}):`,
    ...(npmInfo.packages.length ? npmInfo.packages.map(entry => `- ${entry}`) : ['- (node_modules not present during offline notice generation)']),
    '',
    `Bundled Rust / Tauri Crates from Cargo.lock (${crates.length}):`,
    ...crates.map(crate => `- ${crate}`),
    '',
    'For full upstream license texts of each crate or npm package, consult',
    `${upstream} at revision ${revision} and crates.io / npm registries.`
  ]
  const outPath = join(outDir, 'THIRD_PARTY_NOTICES-agent-manager.txt')
  writeFileSync(outPath, lines.join('\n') + '\n', 'utf8')
  return outPath
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw Error('外接 Agent 管理后台当前构建目标为 Windows x64')
  }
  prepareSource()

  const pnpm = command => {
    // Only fixed build commands are passed to the Windows package-manager shim.
    run('cmd.exe', ['/d', '/s', '/c', 'pnpm ' + command], source)
  }

  pnpm('install --frozen-lockfile')
  pnpm('run build:renderer')
  const cargoTarget = join(buildDir, 'target')
  run('cargo', [
    'build', '--release', '--locked', '--target', target, '--target-dir', cargoTarget,
    '--features', 'tauri/custom-protocol'
  ], join(source, 'src-tauri'))
  mkdirSync(dirname(artifact), { recursive: true })
  copyFileSync(join(cargoTarget, target, 'release', 'cc-switch.exe'), artifact)
  copyFileSync(join(source, 'LICENSE'), join(dirname(artifact), 'LICENSE-CC-Switch.txt'))
  writeAgentManagerNotices(source, dirname(artifact))
  console.log('外接 Agent 管理后台 ' + artifact)
}
