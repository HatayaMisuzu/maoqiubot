import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packager } from '@electron/packager'

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)))
const out = process.env.MAOQIU_PACKAGE_OUT ? resolve(process.env.MAOQIU_PACKAGE_OUT) : join(root, 'dist')
const name = 'Xiaomaoqiu'
const target = join(out, name + '-win32-x64')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const lockfile = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
const checksums = JSON.parse(readFileSync(join(root, 'node_modules/electron/checksums.json'), 'utf8'))
const runtimePackages = Object.entries(lockfile.packages)
  .filter(([path, info]) => path.startsWith('node_modules/') && !info.dev)
  .map(([path]) => path)
const runtimeDirectories = new Set(['desktop', 'server', 'connector', 'contracts', 'web-demo', 'plugins'])
const runtimeFiles = new Set([
  'package.json',
  'THIRD_PARTY_NOTICES.md',
  'connector/config.example.json',
  'server/chat/decision.json',
  'scripts/project-api.ts',
  'scripts/backup.ts'
])

function exclude(path) {
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
    parts[0]==='plugins'&&/\.(?:json|md)$/.test(file))
}

mkdirSync(out, { recursive: true })
if (realpathSync(out) !== out || lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
  throw Error('桌面构建目录及包目标须为实际目录，不能通过符号链接覆盖其他文件')
}

const [release] = await packager({
  dir: root,
  out,
  name,
  platform: 'win32',
  arch: 'x64',
  electronVersion: manifest.devDependencies.electron,
  download: { checksums },
  icon: join(root, 'desktop', 'icon.ico'),
  win32metadata: { ProductName: '小毛球工作台', FileDescription: '小毛球工作台' },
  asar: false,
  prune: false,
  overwrite: true,
  ignore: exclude
})
console.log('桌面应用 ' + join(release, name + '.exe'))
