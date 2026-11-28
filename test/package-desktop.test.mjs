import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { archiveExistingDist, publishDesktopPackage } from '../scripts/package-desktop.mjs'

const packageName = 'Xiaomaoqiu-win32-x64'
const operations = { cpSync, renameSync, rmSync }
const marker = 'previous build'
const executableFixture = Buffer.alloc(70)
executableFixture.write('MZ')
executableFixture.writeUInt32LE(64, 60)
executableFixture.writeUInt32LE(0x4550, 64)
executableFixture.writeUInt16LE(0x8664, 68)

function write(path, content = 'fixture') {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function stageRelease(path) {
  for (const file of [
    'ffmpeg.dll', 'icudtl.dat', 'resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin',
    'locales/en-US.pak', 'LICENSE', 'LICENSES.chromium.html',
    'resources/agent-manager/LICENSE-CC-Switch.txt', 'resources/agent-manager/THIRD_PARTY_NOTICES-agent-manager.txt'
  ]) write(join(path, file))
  for (const file of [
    'THIRD_PARTY_NOTICES.md', 'connector/config.example.json', 'server/chat/decision.json', 'scripts/project-api.ts',
    'scripts/backup.ts', 'desktop/main.cjs', 'desktop/preload.cjs', 'desktop/connector.mjs', 'desktop/agent-manager.cjs',
    'desktop/connector-settings.cjs', 'desktop/codex-switch-recovery.cjs', 'desktop/connector-maintenance.cjs', 'desktop/hermes-discovery.cjs',
    'server/index.ts', 'server/db/index.ts', 'connector/index.ts', 'connector/store.ts', 'contracts/agent-runtime.ts',
    'web-demo/index.html', 'web-demo/app.js', 'web-demo/connector-connection.js', 'plugins/web/plugin.json', 'plugins/web/index.ts', 'node_modules/ws/package.json'
  ]) write(join(path, 'resources/app', file))
  write(join(path, 'resources/app/package.json'), JSON.stringify({ name: 'xiaomaoqiu-workbench', main: 'desktop/main.cjs', dependencies: { ws: 'test' } }))
  write(join(path, 'Xiaomaoqiu.exe'), executableFixture)
  write(join(path, 'resources/agent-manager/agent-manager.exe'), executableFixture)
}

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'maoqiu-package-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const out = join(root, 'out')
  const archiveDir = join(root, 'archive')
  const stagedRelease = join(root, 'staged', packageName)
  const target = join(out, packageName)
  write(join(target, 'marker'), marker)
  return { root, out, archiveDir, stagedRelease, target, archiveAll: true }
}

function archiveMarker(archiveDir) {
  const [archived] = readdirSync(archiveDir)
  return join(archiveDir, archived, 'marker')
}

test('默认发布只留完整新包，自定义输出保留其他内容', t => {
  for (const archiveAll of [true, false]) {
    const paths = setup(t)
    stageRelease(paths.stagedRelease)
    write(join(paths.out, 'legacy', 'marker'), 'older build')
    const result = publishDesktopPackage({ ...paths, archiveAll })
    assert.equal(result.target, paths.target)
    assert.equal(result.archived.length, archiveAll ? 2 : 1)
    assert.deepEqual(readdirSync(paths.out).sort(), archiveAll ? [packageName] : [packageName, 'legacy'])
    assert.deepEqual(readFileSync(join(paths.target, 'Xiaomaoqiu.exe')), executableFixture)
    assert.equal(readFileSync(join(result.archived.find(item => item.name === packageName).to, 'marker'), 'utf8'), marker)
  }
})

test('构建路径相互重叠或经过联接时不移动旧包', t => {
  const paths = setup(t)
  const archive = archiveDir => archiveExistingDist({ distDir: paths.out, archiveDir })
  assert.throws(() => archive(join(paths.out, 'nested')), /重叠/)
  assert.throws(() => archive(paths.root), /重叠/)
  assert.throws(() => archive(paths.out), /重叠/)
  assert.throws(() => publishDesktopPackage({ ...paths, stagedRelease: paths.target }), /重叠/)
  const link = join(paths.root, 'alias')
  symlinkSync(paths.out, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => archive(join(link, 'archive')), /符号链接或联接/)
  assert.equal(readFileSync(join(paths.target, 'marker'), 'utf8'), marker)
})

test('运行资源、依赖及组件许可缺失时保留原有包', t => {
  const paths = setup(t)
  for (const missing of ['resources/app/web-demo/index.html', 'resources/app/node_modules/ws/package.json', 'resources/agent-manager/LICENSE-CC-Switch.txt']) {
    stageRelease(paths.stagedRelease)
    rmSync(join(paths.stagedRelease, missing))
    assert.throws(() => publishDesktopPackage(paths), /缺少有效资源/)
    assert.equal(readFileSync(join(paths.target, 'marker'), 'utf8'), marker)
    assert.equal(existsSync(paths.archiveDir), false)
  }
})

test('归档中途失败会还原已移动的旧包', t => {
  const paths = setup(t)
  const last = join(paths.out, 'zz-locked')
  write(join(last, 'marker'), 'another build')
  stageRelease(paths.stagedRelease)
  const rename = (from, to) => {
    if (from === last) throw Error('归档目标占用')
    renameSync(from, to)
  }
  assert.throws(() => publishDesktopPackage({ ...paths, operations: { ...operations, renameSync: rename } }), /归档目标占用/)
  assert.equal(readFileSync(join(paths.target, 'marker'), 'utf8'), marker)
  assert.equal(readFileSync(join(last, 'marker'), 'utf8'), 'another build')
  assert.deepEqual(readdirSync(paths.archiveDir), [])
})

test('发布失败还原旧版，并在无法恢复时报告完整副本的路径', t => {
  for (const restoreFails of [false, true]) {
    const paths = setup(t)
    stageRelease(paths.stagedRelease)
    const rename = (from, to) => {
      if (from === paths.stagedRelease) throw Error('发布目标占用')
      if (restoreFails && to === paths.target) throw Error('原路径不可写')
      renameSync(from, to)
    }
    assert.throws(() => publishDesktopPackage({ ...paths, operations: { ...operations, renameSync: rename } }), error => {
      assert.match(error.message, /发布目标占用/)
      if (restoreFails) {
        assert.match(error.message, /原路径不可写/)
        assert.ok(error.message.includes(dirname(archiveMarker(paths.archiveDir))))
      }
      return true
    })
    assert.equal(readFileSync(restoreFails ? archiveMarker(paths.archiveDir) : join(paths.target, 'marker'), 'utf8'), marker)
  }
})

function crossVolumeRename(source) {
  return (from, to) => {
    if (from === source) throw Object.assign(Error('cross volume'), { code: 'EXDEV' })
    renameSync(from, to)
  }
}

test('跨盘复制出错或同长度内容损坏时不会移除唯一旧包', t => {
  for (const corrupted of [false, true]) {
    const paths = setup(t)
    stageRelease(paths.stagedRelease)
    const copy = (from, to, options) => {
      cpSync(from, to, options)
      if (!corrupted) throw Error('磁盘写入故障')
      write(join(to, 'marker'), marker.replace('previous', 'replaced'))
    }
    assert.throws(() => publishDesktopPackage({ ...paths, operations: { ...operations, cpSync: copy, renameSync: crossVolumeRename(paths.target) } }), corrupted ? /内容不一致/ : /磁盘写入故障/)
    assert.equal(readFileSync(join(paths.target, 'marker'), 'utf8'), marker)
    assert.deepEqual(readdirSync(paths.archiveDir), [])
  }
})

test('跨盘发布校验副本，归档清理失败时保留完整可恢复副本', t => {
  const successful = setup(t)
  stageRelease(successful.stagedRelease)
  publishDesktopPackage({ ...successful, operations: { ...operations, renameSync: crossVolumeRename(successful.stagedRelease) } })
  assert.equal(existsSync(successful.stagedRelease), false)
  assert.deepEqual(readdirSync(successful.out), [packageName])
  assert.equal(readFileSync(archiveMarker(successful.archiveDir), 'utf8'), marker)

  const failed = setup(t)
  stageRelease(failed.stagedRelease)
  const remove = source => {
    assert.equal(source, failed.target)
    rmSync(join(source, 'marker'))
    throw Error('源文件仍被占用')
  }
  assert.throws(() => publishDesktopPackage({ ...failed, operations: { ...operations, rmSync: remove, renameSync: crossVolumeRename(failed.target) } }), error => {
    assert.match(error.message, /源文件仍被占用/)
    assert.ok(error.message.includes(dirname(archiveMarker(failed.archiveDir))))
    return true
  })
  assert.equal(readFileSync(archiveMarker(failed.archiveDir), 'utf8'), marker)
})

test('Windows 运行中的旧包会阻止发布且进程保持运行', { skip: process.platform !== 'win32' }, async t => {
  const paths = setup(t)
  stageRelease(paths.stagedRelease)
  const exe = join(paths.target, 'Xiaomaoqiu.exe')
  copyFileSync(process.env.ComSpec, exe)
  const running = spawn(exe, ['/d', '/q', '/k'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] })
  const exited = once(running, 'exit')
  try {
    await once(running, 'spawn')
    assert.throws(() => publishDesktopPackage(paths), /正在运行/)
    assert.equal(running.exitCode, null)
    assert.equal(readFileSync(join(paths.target, 'marker'), 'utf8'), marker)
    assert.equal(existsSync(paths.archiveDir), false)
  } finally {
    running.stdin.end('exit\r\n')
    await exited
  }
})
