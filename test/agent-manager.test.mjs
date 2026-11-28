import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { agentManagerEnvironment, createAgentManager } = require('../desktop/agent-manager.cjs')

test('内置 Agent 管理器只继承运行所需环境，不接收工作台访问密钥', () => {
  const env = agentManagerEnvironment({
    Path: 'C:\\Windows\\System32',
    USERPROFILE: 'C:\\Users\\fixture',
    HTTPS_PROXY: 'http://proxy.invalid:8080',
    OWNER_TOKEN: 'owner-secret',
    NODE_TOKEN: 'node-secret',
    OPENAI_API_KEY: 'provider-secret',
    MAOQIU_NODE_URL: 'http://127.0.0.1:1234',
    ELECTRON_RUN_AS_NODE: '1'
  }, { DSH_HOME: 'C:\\fixture\\dsh' }, 'C:\\fixture\\manager-data')

  assert.equal(env.Path, 'C:\\Windows\\System32')
  assert.equal(env.USERPROFILE, 'C:\\Users\\fixture')
  assert.equal(env.HTTPS_PROXY, 'http://proxy.invalid:8080')
  assert.equal(env.DSH_HOME, 'C:\\fixture\\dsh')
  assert.equal(env.MAOQIU_AGENT_MANAGER_DATA, 'C:\\fixture\\manager-data')
  assert.equal(env.OWNER_TOKEN, undefined)
  assert.equal(env.NODE_TOKEN, undefined)
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.MAOQIU_NODE_URL, undefined)
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined)
})

test('Windows 桌面管理器可打开随包可执行文件并正常退出', { skip: process.platform !== 'win32' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'maoqiu-agent-manager-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const directory = join(root, 'build', 'agent-manager')
  mkdirSync(directory, { recursive: true })
  copyFileSync(process.execPath, join(directory, 'agent-manager.exe'))
  let stopped = 0
  const manager = createAgentManager({
    root,
    resourcesPath: '',
    packaged: false,
    userData: join(root, 'userData'),
    stopConnector: async () => { stopped++ },
    resumeConnector: () => {},
    assertIdle: () => {},
    instanceHomes: () => ({
      CODEX_HOME: join(root, 'codex'),
      DSH_HOME: join(root, 'dsh'),
      HERMES_HOME: join(root, 'hermes')
    })
  })

  assert.equal(manager.status().available, true)
  assert.deepEqual(await manager.open('dsh'), { available: true, active: true, instanceId: 'dsh' })
  assert.equal(stopped, 1)
  await manager.stop()
  assert.equal(manager.status().active, false)
})
