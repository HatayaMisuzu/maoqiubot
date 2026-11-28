import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'

import { codexEnvironment } from '../contracts/codex-local.ts'
import { agentEnvironment } from '../connector/rpc.ts'
import { sanitizeConnectorConfig, transfer } from '../scripts/backup.ts'
import { archiveExistingDist, resolveAgentManagerDir } from '../scripts/package-desktop.mjs'
import { startServer } from '../server/index.ts'
import { agentMonitor } from '../server/tasks/agent-monitor.ts'
import { dshSessionUsage } from '../server/tasks/dsh-monitor.ts'

const require = createRequire(import.meta.url)
const {
  normalizeStablePath, connectorSettings, settingsView, validateWorktreeRequest,
  readCodexLocalSummary, switchCodexProviderMode, clearUnboundNativeCodexScopes
} = require('../desktop/connector-settings.cjs')
const { createAgentManager } = require('../desktop/agent-manager.cjs')

test('环境隔离同时剥离 MAOQIU_PLUGIN_KEY_* 与 MAOQIU_MODEL_KEY_*', () => {
  const dirtyEnv = {
    PATH: 'C:\\Windows\\System32',
    HTTP_PROXY: 'http://127.0.0.1:7890',
    MAOQIU_PLUGIN_KEY_BRAVE: 'plugin-secret',
    MAOQIU_MODEL_KEY_OPENAI: 'model-secret',
    OWNER_TOKEN: 'owner-secret',
    NODE_TOKEN: 'node-secret',
    OPENAI_API_KEY: 'upstream-secret',
    CUSTOM_SAFE_FLAG: 'keep-me'
  }

  const codexCleaned = codexEnvironment(dirtyEnv)
  assert.equal(codexCleaned.MAOQIU_PLUGIN_KEY_BRAVE, undefined)
  assert.equal(codexCleaned.MAOQIU_MODEL_KEY_OPENAI, undefined)
  assert.equal(codexCleaned.OWNER_TOKEN, undefined)
  assert.equal(codexCleaned.NODE_TOKEN, undefined)
  assert.equal(codexCleaned.OPENAI_API_KEY, undefined)
  assert.equal(codexCleaned.HTTP_PROXY, 'http://127.0.0.1:7890')
  assert.equal(codexCleaned.CUSTOM_SAFE_FLAG, 'keep-me')

  const prev = process.env.MAOQIU_PLUGIN_KEY_TEMP
  process.env.MAOQIU_PLUGIN_KEY_TEMP = 'host-plugin-secret'
  try {
    const rpcEnv = agentEnvironment({
      id: 'dsh-test',
      name: 'DSH',
      adapterKey: 'dsh',
      profileId: 'default',
      workspaceRef: process.cwd(),
      command: 'dsh',
      args: ['--profile', 'acp'],
      env: {
        DSH_HOME: 'C:\\fixture\\dsh',
        MAOQIU_PLUGIN_KEY_CUSTOM: 'instance-plugin-secret',
        MAOQIU_MODEL_KEY_CUSTOM: 'instance-model-secret',
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: '--inspect'
      }
    })
    assert.equal(rpcEnv.MAOQIU_PLUGIN_KEY_TEMP, undefined)
    assert.equal(rpcEnv.MAOQIU_PLUGIN_KEY_CUSTOM, undefined)
    assert.equal(rpcEnv.MAOQIU_MODEL_KEY_CUSTOM, undefined)
    assert.equal(rpcEnv.ELECTRON_RUN_AS_NODE, undefined)
    assert.equal(rpcEnv.NODE_OPTIONS, undefined)
    assert.equal(rpcEnv.DSH_HOME, 'C:\\fixture\\dsh')
  } finally {
    if (prev === undefined) delete process.env.MAOQIU_PLUGIN_KEY_TEMP
    else process.env.MAOQIU_PLUGIN_KEY_TEMP = prev
  }
})

test('备份脱敏保留安全连接器配置并随 save/restore 完整往返', async t => {
  const root = mkdtempSync(join(tmpdir(), 'maoqiu-backup-reg-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

  const sanitized = sanitizeConnectorConfig({
    stateDir: join(root, 'node-local'),
    url: 'ws://user:pass@127.0.0.1:4317/api/v1/node?token=secret#frag',
    nodeId: 'local',
    instances: [
      {
        id: 'codex-native',
        name: 'Codex Native',
        adapterKey: 'codex',
        workspaceRef: root,
        profileId: 'default',
        command: 'codex',
        args: ['app-server', '--evil'],
        codexProviderMode: 'native',
        env: {
          CODEX_HOME: 'C:\\safe\\codex',
          HERMES_DATA_DIR_SUFFIX: '-test',
          MAOQIU_PLUGIN_KEY_SECRET: 'strip-me',
          OPENAI_API_KEY: 'strip-me-too'
        },
        worktree: { branch: 'maoqiu/wt1', baseCommit: '0'.repeat(40), sourceId: 'codex-local' }
      },
      {
        id: 'dsh-patch',
        name: 'DSH Patched',
        adapterKey: 'dsh',
        workspaceRef: root,
        profileId: 'acp-custom',
        command: 'dsh',
        args: ['--profile', 'acp', '--patch', 'C:\\patch.yml'],
        env: { DSH_HOME: 'C:\\safe\\dsh', NODE_TOKEN: 'strip' }
      }
    ]
  })
  assert.equal(sanitized.url, 'ws://127.0.0.1:4317/api/v1/node')
  assert.deepEqual(sanitized.instances[0].args, ['app-server'])
  assert.equal(sanitized.instances[0].codexProviderMode, 'native')
  assert.deepEqual(sanitized.instances[0].env, { CODEX_HOME: 'C:\\safe\\codex', HERMES_DATA_DIR_SUFFIX: '-test' })
  assert.deepEqual(sanitized.instances[0].worktree, { branch: 'maoqiu/wt1', baseCommit: '0'.repeat(40), sourceId: 'codex-local' })
  assert.deepEqual(sanitized.instances[1].args, ['--profile', 'acp', '--patch', 'C:\\patch.yml'])
  assert.deepEqual(sanitized.instances[1].env, { DSH_HOME: 'C:\\safe\\dsh' })

  const dataDir = join(root, 'data')
  const app = startServer({ port: 0, dataDir, chat: false })
  await once(app.server, 'listening')
  await app.close()

  writeFileSync(join(dataDir, 'desktop-connector.json'), JSON.stringify({
    stateDir: join(dataDir, 'node-local'),
    url: 'ws://127.0.0.1:4317/api/v1/node',
    nodeId: 'local',
    instances: sanitized.instances
  }, null, 2))

  const snapDir = join(root, 'snap')
  const restoredDir = join(root, 'restored')
  transfer(dataDir, snapDir, false, { offline: true })
  const backedUp = JSON.parse(readFileSync(join(snapDir, 'desktop-connector.json'), 'utf8'))
  assert.equal(backedUp.instances[0].codexProviderMode, 'native')
  assert.equal(backedUp.instances[1].args.includes('--patch'), true)

  transfer(snapDir, restoredDir, true)
  const restoredCfg = JSON.parse(readFileSync(join(restoredDir, 'desktop-connector.json'), 'utf8'))
  assert.equal(restoredCfg.instances[0].worktree.branch, 'maoqiu/wt1')
  assert.equal(restoredCfg.instances[0].env.HERMES_DATA_DIR_SUFFIX, '-test')
})

test('API Bot 动态反映模型离线状态、强制非流式收集完整用量、支持取消并受 /agent-monitor 权限与统计约束', async t => {
  const observedBodies = []
  let slowMode = false
  let releaseSlow
  const model = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    observedBodies.push(parsed)
    if (req.url?.includes('/chat/completions') && parsed.stream) {
      res.setHeader('Content-Type', 'text/event-stream')
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) + '\n\n')
      res.end('data: [DONE]\n\n')
      return
    }
    if (slowMode) {
      await new Promise(resolvePromise => {
        releaseSlow = resolvePromise
        req.once('close', resolvePromise)
      })
      if (!res.writableEnded) res.end()
      return
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '非流式回复' } }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
    }))
  })
  model.listen(0, '127.0.0.1')
  await once(model, 'listening')

  const dir = mkdtempSync(join(tmpdir(), 'maoqiu-api-reg-'))
  const app = startServer({ port: 0, dataDir: dir, chat: false })
  await once(app.server, 'listening')
  t.after(async () => {
    releaseSlow?.()
    const close = app.close()
    app.server.closeAllConnections()
    await close
    await new Promise(resolveClose => model.close(resolveClose))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  const baseUrl = 'http://127.0.0.1:' + app.server.address().port + '/api/v1'
  async function callApi(path, body, status = 200, token = app.auth.cfg.ownerToken) {
    const res = await fetch(baseUrl + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const data = await res.json()
    assert.equal(res.status, status, JSON.stringify(data))
    return data
  }

  const saved = await callApi('/chat/models', {
    action: 'save',
    name: '测试兼容模型',
    baseUrl: 'http://127.0.0.1:' + model.address().port + '/v1',
    model: 'compat-1',
    protocol: 'openai-compatible',
    stream: true
  })
  const modelId = saved.models.find(m => m.name === '测试兼容模型').id
  const capRes = await callApi('/chat/models/capability', { id: modelId, capability: 'stream' })
  assert.equal(capRes.ok, true)
  assert.equal(capRes.capability, 'stream')

  const bot = await callApi('/instances/api', { modelId })
  const onlineList = await callApi('/instances')
  const onlineEntry = onlineList.find(i => i.id === bot.id)
  assert.equal(onlineEntry.online, true)
  assert.equal(onlineEntry.availableActions.includes('cancel'), true)

  const { thread } = await callApi('/threads', { instanceId: bot.id, firstMessage: { text: '统计用量验证' } })
  for (let i = 0; i < 100; i++) {
    const snap = await callApi('/threads/' + thread.id)
    if (snap.messages.some(m => m.role === 'assistant' && m.kind === 'message')) break
    await delay(20)
  }
  const apiCallBody = observedBodies.at(-1)
  assert.equal(apiCallBody.stream, false)

  const monitor = await callApi('/agent-monitor?days=30')
  const row = monitor.usage.find(u => u.instanceId === bot.id)
  assert.equal(row.inputTokens, 11)
  assert.equal(row.outputTokens, 7)
  assert.equal(row.totalTokens, 18)

  slowMode = true
  await callApi('/threads/' + thread.id + '/messages', { text: '测试可取消的长请求' })
  let activeRunId
  for (let i = 0; i < 100; i++) {
    const snap = await callApi('/threads/' + thread.id)
    if (snap.run && ['queued', 'running'].includes(snap.run.status)) {
      activeRunId = snap.run.id
      if (snap.run.status === 'running') break
    }
    await delay(20)
  }
  assert.ok(activeRunId)
  await callApi('/runs/' + activeRunId + '/commands', { kind: 'cancel' })
  for (let i = 0; i < 100; i++) {
    const snap = await callApi('/threads/' + thread.id)
    if (snap.run?.status === 'cancelled') break
    await delay(20)
  }
  assert.equal((await callApi('/threads/' + thread.id)).run.status, 'cancelled')
  slowMode = false

  await callApi('/chat/models', { action: 'toggle', id: modelId, disabled: true })
  const afterDisable = (await callApi('/instances')).find(i => i.id === bot.id)
  assert.equal(afterDisable.online, false)
  assert.ok(afterDisable.capabilities.error)

  const proj = await callApi('/projects', { name: '监控权限测试' })
  const grant = await callApi('/grants', { projectId: proj.id })
  await callApi('/agent-monitor', undefined, 403, grant.token)
  await callApi('/instances/' + bot.id + '/usage', undefined, 403, grant.token)
  await callApi('/threads/' + thread.id + '/native', undefined, 403, grant.token)
  const apiUsage = await callApi('/instances/' + bot.id + '/usage', undefined, 200)
  assert.deepEqual(apiUsage, { source: null, fetchedAt: null, windows: [] })
  await callApi('/threads/' + thread.id + '/native', undefined, 409)
})

test('agentMonitor 计入 prepare 命令的活跃/待核对/异常统计且 dshSessionUsage 正确把 NULL cache 视作 0', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'maoqiu-monitor-reg-'))
  const app = startServer({ port: 0, dataDir: dir, chat: false })
  await once(app.server, 'listening')
  t.after(async () => {
    const close = app.close()
    app.server.closeAllConnections()
    await close
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  app.db.prepare(`INSERT INTO instances(id,nodeId,name,adapterKey,workspaceRef,availableActions,lastSeen,online,capabilities,profileId,runtimeScopeId)
    VALUES('dsh-1','local','DSH 统计','dsh',?, '["run","prepare"]', ?, 1, '{"usage":false}', 'acp', 'scope-1')`)
    .run(dir, new Date().toISOString())
  app.db.prepare(`INSERT INTO threads(id,title,instanceId,projectId,sessionId,createdAt,kind,state,nativeReleased)
    VALUES('t-dsh','DSH 话题','dsh-1',NULL,'native-sess-1',?,'native','active',0)`).run(new Date().toISOString())

  const insertPrepRun = (runId, cmdId, status, createdAt) => {
    app.db.prepare(`INSERT INTO runs(id,taskId,threadId,instanceId,status,createdAt) VALUES(?,NULL,'t-dsh','dsh-1',?,?)`)
      .run(runId, status, createdAt)
    app.db.prepare(`INSERT INTO commands(id,runId,threadId,instanceId,kind,payload,status,createdAt) VALUES(?,?, 't-dsh','dsh-1','prepare','{}','sent',?)`)
      .run(cmdId, runId, createdAt)
  }
  insertPrepRun('r-active', 'c-active', 'running', '2026-11-27T01:00:00.000Z')
  insertPrepRun('r-uncertain', 'c-uncertain', 'uncertain', '2026-11-27T02:00:00.000Z')
  insertPrepRun('r-failed', 'c-failed', 'failed', '2026-11-27T03:00:00.000Z')

  const snap = agentMonitor(app.db, dir, { days: 30 }, [])
  const dshRow = snap.instances.find(i => i.id === 'dsh-1')
  assert.equal(dshRow.activeRuns, 1)
  assert.equal(dshRow.uncertainRuns, 1)
  assert.deepEqual(dshRow.lastFailure, { status: 'failed', startedAt: '2026-11-27T03:00:00.000Z' })

  const dshDbPath = join(dir, 'cc-switch.db')
  const dshDb = new DatabaseSync(dshDbPath)
  dshDb.exec(`CREATE TABLE proxy_request_logs(
    request_id TEXT PRIMARY KEY,
    app_type TEXT,
    data_source TEXT,
    session_id TEXT,
    model TEXT,
    created_at INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_creation_tokens INTEGER
  )`)
  const recentUnix = Math.floor(Date.now() / 1000) - 60
  dshDb.prepare(`INSERT INTO proxy_request_logs VALUES('req-null-cache','dsh','dsh_session','native-sess-1','deepseek-chat',?,25,10,NULL,NULL)`)
    .run(recentUnix)
  dshDb.close()

  const usageRes = dshSessionUsage(app.db, [{ databasePath: dshDbPath, instances: [{ id: 'dsh-1', runtimeScopeId: 'scope-1' }] }], new Date(Date.now() - 86400_000))
  assert.equal(usageRes.rows.length, 1)
  assert.equal(usageRes.rows[0].inputTokens, 25)
  assert.equal(usageRes.rows[0].outputTokens, 10)
  assert.equal(usageRes.rows[0].totalTokens, 35)
})

test('桌面端 normalizeStablePath 支持未创建尾级子目录，validateWorktreeRequest 与 agentManager 准确拦截冲突', async t => {
  const root = mkdtempSync(join(tmpdir(), 'maoqiu-desktop-reg-'))
  let app
  t.after(async () => {
    if (app) {
      const close = app.close()
      app.server.closeAllConnections()
      await close
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  const existingParent = join(root, 'existing-home')
  mkdirSync(existingParent, { recursive: true })
  const missingLeaf = join(existingParent, 'profiles', 'custom')
  assert.equal(normalizeStablePath(missingLeaf), join(existingParent, 'profiles', 'custom'))
  assert.equal(resolve(normalizeStablePath(join(existingParent, 'profiles', '..', 'nested'))), join(existingParent, 'nested'))

  const dataDir = join(root, 'data')
  app = startServer({ port: 0, dataDir, chat: false })
  await once(app.server, 'listening')

  const settings = connectorSettings({ root: process.cwd(), workspace: root, dataDir })
  assert.throws(() => validateWorktreeRequest(settings, app.db, 'codex-local', 'main'), /有效且唯一/)
  assert.throws(() => validateWorktreeRequest(settings, app.db, 'codex-local', 'con'), /有效且唯一/)
  assert.throws(() => validateWorktreeRequest(settings, app.db, 'missing-src', 'wt-new'), /请选择本机 Agent 实例/)
  assert.throws(() => validateWorktreeRequest(settings, app.db, 'codex-local', 'CODEX-LOCAL'), /已存在/)
  const validSource = validateWorktreeRequest(settings, app.db, 'codex-local', 'wt-clean')
  assert.equal(validSource.id, 'codex-local')

  if (process.platform === 'win32') {
    const binDir = join(root, 'build', 'agent-manager')
    mkdirSync(binDir, { recursive: true })
    copyFileSync(process.execPath, join(binDir, 'agent-manager.exe'))
    const manager = createAgentManager({
      root,
      resourcesPath: '',
      packaged: false,
      userData: join(root, 'userData'),
      stopConnector: async () => {},
      resumeConnector: () => {},
      assertIdle: () => {},
      instanceHomes: () => ({ CODEX_HOME: root, DSH_HOME: root, HERMES_HOME: root })
    })
    assert.deepEqual(await manager.open('codex-local'), { available: true, active: true, instanceId: 'codex-local' })
    await assert.rejects(() => manager.open('dsh-local'), /先关闭当前管理窗口后再切换/)
    await manager.stop()
    assert.equal(manager.status().active, false)
    assert.equal(manager.status().instanceId, undefined)
  }
})

test('resolveAgentManagerDir 与 archiveExistingDist 确保 dist 仅留新包并将旧包归档留档', t => {
  const root = mkdtempSync(join(tmpdir(), 'maoqiu-dist-policy-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

  const legacyDir = join(root, 'dist', 'agent-manager')
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(join(legacyDir, 'agent-manager.exe'), 'legacy')
  assert.equal(resolveAgentManagerDir(root), legacyDir)

  const preferredDir = join(root, 'build', 'agent-manager')
  mkdirSync(preferredDir, { recursive: true })
  writeFileSync(join(preferredDir, 'agent-manager.exe'), 'preferred')
  assert.equal(resolveAgentManagerDir(root), preferredDir)

  const distDir = join(root, 'dist-stage-test')
  const archiveDir = join(root, 'backups', 'desktop-packages')
  mkdirSync(join(distDir, 'Xiaomaoqiu-win32-x64'), { recursive: true })
  mkdirSync(join(distDir, 'stability-20261126'), { recursive: true })
  writeFileSync(join(distDir, 'Xiaomaoqiu-win32-x64', 'marker.txt'), 'old-latest')
  writeFileSync(join(distDir, 'stability-20261126', 'marker.txt'), 'old-stability')
  mkdirSync(join(archiveDir, 'Xiaomaoqiu-win32-x64-20261128-110000'), { recursive: true })

  const moved = archiveExistingDist({ distDir, archiveDir, keepName: 'Xiaomaoqiu-win32-x64', stamp: '20261128-110000' })
  assert.equal(moved.length, 2)
  assert.deepEqual(readdirSync(distDir), [])
  assert.equal(readFileSync(join(archiveDir, 'Xiaomaoqiu-win32-x64-20261128-110000-2', 'marker.txt'), 'utf8'), 'old-latest')
  assert.equal(readFileSync(join(archiveDir, 'stability-20261126', 'marker.txt'), 'utf8'), 'old-stability')
})

test('connectorSettings 首次初始化时自动检测本机 Hermes，未安装时不生成无效实例', t => {
  const root = mkdtempSync(join(tmpdir(), 'maoqiu-hermes-init-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

  const saved = {
    HERMES_HOME: process.env.HERMES_HOME,
    Path: process.env.Path,
    PATH: process.env.PATH,
    MAOQIU_CONNECTOR_CONFIG: process.env.MAOQIU_CONNECTOR_CONFIG
  }
  const restoreEnv = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  t.after(restoreEnv)

  delete process.env.MAOQIU_CONNECTOR_CONFIG

  const fakeHermesHome = join(root, 'fake-hermes-home')
  const binDir = join(fakeHermesHome, 'bin')
  mkdirSync(binDir, { recursive: true })
  const fakeHermesBin = join(binDir, process.platform === 'win32' ? 'hermes.exe' : 'hermes')
  writeFileSync(fakeHermesBin, '')
  process.env.HERMES_HOME = fakeHermesHome

  const dataWithHermes = join(root, 'data-with')
  mkdirSync(dataWithHermes, { recursive: true })
  const s1 = connectorSettings({ root: process.cwd(), workspace: root, dataDir: dataWithHermes })
  const cfg1 = JSON.parse(readFileSync(s1.file, 'utf8'))
  const hermes1 = cfg1.instances.find(i => i.adapterKey === 'hermes')
  assert.ok(hermes1)
  assert.equal(hermes1.id, 'hermes-local')
  assert.equal(hermes1.command, fakeHermesBin)
  assert.deepEqual(hermes1.args, ['acp'])

  process.env.HERMES_HOME = join(root, 'missing-hermes-home')
  if ('Path' in process.env) process.env.Path = ''
  if ('PATH' in process.env) process.env.PATH = ''
  const dataWithoutHermes = join(root, 'data-without')
  mkdirSync(dataWithoutHermes, { recursive: true })
  const s2 = connectorSettings({ root: process.cwd(), workspace: root, dataDir: dataWithoutHermes })
  const cfg2 = JSON.parse(readFileSync(s2.file, 'utf8'))
  assert.equal(cfg2.instances.some(i => i.adapterKey === 'hermes'), false)
})

test('readCodexLocalSummary 只读解析顶层供应商字段并在首个 section 前停止', t => {
  const root = mkdtempSync(join(tmpdir(), 'maoqiu-codex-toml-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

  assert.deepEqual(readCodexLocalSummary(root), { modelProvider: null, model: null })
  writeFileSync(join(root, 'config.toml'), [
    '# 注释行',
    'model = "gpt-6.1-sol" # 行尾注释',
    "model_provider = 'custom' # 单引号",
    '[model_providers.custom]',
    'model = "must-not-read"',
    'model_provider = "other"',
    'api_key = "TOP-SECRET"'
  ].join('\n'))
  assert.deepEqual(readCodexLocalSummary(root), { modelProvider: 'custom', model: 'gpt-6.1-sol' })
})

test('单一 Codex 实例可安全切换供应商模式并在无绑定话题时自动解除旧范围', async t => {
  const root = mkdtempSync(join(tmpdir(), 'maoqiu-codex-switch-'))
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  const savedOverride = process.env.MAOQIU_CONNECTOR_CONFIG
  delete process.env.MAOQIU_CONNECTOR_CONFIG
  let app
  t.after(async () => {
    if (savedOverride === undefined) delete process.env.MAOQIU_CONNECTOR_CONFIG
    else process.env.MAOQIU_CONNECTOR_CONFIG = savedOverride
    if (app) {
      const close = app.close()
      app.server.closeAllConnections()
      await close
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  app = startServer({ port: 0, dataDir, chat: false })
  await once(app.server, 'listening')
  const settings = connectorSettings({ root: process.cwd(), workspace: root, dataDir })

  const codexScope1 = '1'.repeat(64)
  const dshScope = '2'.repeat(64)
  app.db.prepare(`INSERT INTO instances(id,nodeId,name,adapterKey,workspaceRef,availableActions,lastSeen,online,capabilities,profileId,runtimeScopeId)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run('codex-local', 'local', 'Codex', 'codex', root, '["run"]', new Date().toISOString(), 1, '{}', 'default', codexScope1)
  app.db.prepare(`INSERT INTO instances(id,nodeId,name,adapterKey,workspaceRef,availableActions,lastSeen,online,capabilities,profileId,runtimeScopeId)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run('dsh-local', 'local', 'DSH', 'dsh', root, '["run"]', new Date().toISOString(), 1, '{}', 'default', dshScope)

  // 无绑定原生会话时，同一实例可直接切换并清旧 scope。
  const firstSwitch = switchCodexProviderMode(settings, app.db, { instanceId: 'codex-local', codexProviderMode: 'native' })
  assert.equal(firstSwitch.applied, true)
  assert.equal(firstSwitch.requiresConfirmation, false)
  assert.equal(firstSwitch.boundThreads, 0)
  assert.equal(settingsView(settings).instances.find(i => i.id === 'codex-local').codexProviderMode, 'native')
  const afterFirst = app.db.prepare('SELECT online, runtimeScopeId FROM instances WHERE id=?').get('codex-local')
  assert.equal(afterFirst.online, 0)
  assert.equal(afterFirst.runtimeScopeId, null)
  assert.equal(app.db.prepare('SELECT runtimeScopeId FROM instances WHERE id=?').get('dsh-local').runtimeScopeId, dshScope)

  // 存在已绑定原生话题时，未确认前不改文件也不改数据库；确认后标记失效并归档旧话题。
  const codexScope2 = '3'.repeat(64)
  app.db.prepare("UPDATE instances SET runtimeScopeId=?, online=1 WHERE id='codex-local'").run(codexScope2)
  const createdAt = new Date().toISOString()
  app.db.prepare(`INSERT INTO threads(id,kind,title,instanceId,state,sessionId,createdAt,nativeReleased)
    VALUES(?,?,?,?,?,?,?,0)`)
    .run('thread-codex-bound', 'native', '旧 Codex 话题', 'codex-local', 'active', 'native-codex-sess-1', createdAt)

  const needConfirm = switchCodexProviderMode(settings, app.db, { instanceId: 'codex-local', codexProviderMode: 'official' })
  assert.deepEqual(needConfirm, { applied: false, requiresConfirmation: true, boundThreads: 1 })
  assert.equal(settingsView(settings).instances.find(i => i.id === 'codex-local').codexProviderMode, 'native')
  assert.equal(app.db.prepare('SELECT runtimeScopeId FROM instances WHERE id=?').get('codex-local').runtimeScopeId, codexScope2)
  assert.equal(app.db.prepare('SELECT nativeInvalid FROM threads WHERE id=?').get('thread-codex-bound').nativeInvalid, null)

  const confirmed = switchCodexProviderMode(settings, app.db, {
    instanceId: 'codex-local',
    codexProviderMode: 'official',
    confirmRebind: true
  })
  assert.equal(confirmed.applied, true)
  assert.equal(confirmed.boundThreads, 1)
  assert.equal(confirmed.invalidatedThreads, 1)
  assert.equal(settingsView(settings).instances.find(i => i.id === 'codex-local').codexProviderMode, 'official')
  const archived = app.db.prepare('SELECT state, nativeInvalid FROM threads WHERE id=?').get('thread-codex-bound')
  assert.equal(archived.state, 'archived')
  assert.match(archived.nativeInvalid, /Codex 供应商配置已切换/)
  assert.equal(app.db.prepare('SELECT runtimeScopeId FROM instances WHERE id=?').get('codex-local').runtimeScopeId, null)

  // clearUnboundNativeCodexScopes 仅清无有效绑定话题的 native 模式 Codex 实例。
  switchCodexProviderMode(settings, app.db, { instanceId: 'codex-local', codexProviderMode: 'native' })
  const codexScope3 = '4'.repeat(64)
  app.db.prepare("UPDATE instances SET runtimeScopeId=? WHERE id='codex-local'").run(codexScope3)
  app.db.prepare(`INSERT INTO threads(id,kind,title,instanceId,state,sessionId,createdAt,nativeReleased)
    VALUES(?,?,?,?,?,?,?,0)`)
    .run('thread-codex-bound-2', 'native', '新 Codex 话题', 'codex-local', 'active', 'native-codex-sess-2', createdAt)
  assert.deepEqual(clearUnboundNativeCodexScopes(settings, app.db), [])
  assert.equal(app.db.prepare('SELECT runtimeScopeId FROM instances WHERE id=?').get('codex-local').runtimeScopeId, codexScope3)

  app.db.prepare("UPDATE threads SET nativeInvalid='已失效' WHERE id='thread-codex-bound-2'").run()
  assert.deepEqual(clearUnboundNativeCodexScopes(settings, app.db), ['codex-local'])
  assert.equal(app.db.prepare('SELECT runtimeScopeId FROM instances WHERE id=?').get('codex-local').runtimeScopeId, null)
  assert.equal(app.db.prepare('SELECT runtimeScopeId FROM instances WHERE id=?').get('dsh-local').runtimeScopeId, dshScope)
})

test('createAgentManager.codexProviders 仅读取非敏感供应商摘要且缺库时返回空数组', t => {
  const root = mkdtempSync(join(tmpdir(), 'maoqiu-am-codex-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

  const userData = join(root, 'userData')
  const homes = {
    CODEX_HOME: join(root, 'codex-home'),
    DSH_HOME: join(root, 'dsh-home'),
    HERMES_HOME: join(root, 'hermes-home')
  }
  const manager = createAgentManager({
    root,
    resourcesPath: '',
    packaged: false,
    userData,
    stopConnector: async () => {},
    resumeConnector: () => {},
    assertIdle: () => {},
    instanceHomes: () => homes
  })

  assert.deepEqual(manager.codexProviders(homes), [])

  const scope = values => createHash('sha256')
    .update(JSON.stringify(values.map(p => process.platform === 'win32' ? p.toLowerCase() : p)))
    .digest('hex')
  const dbDir = join(userData, 'agent-manager', scope([homes.DSH_HOME]), scope([homes.CODEX_HOME, homes.HERMES_HOME]))
  mkdirSync(dbDir, { recursive: true })
  const db = new DatabaseSync(join(dbDir, 'cc-switch.db'))
  db.exec(`CREATE TABLE providers (
    id TEXT PRIMARY KEY,
    app_type TEXT NOT NULL,
    name TEXT NOT NULL,
    settings_config TEXT NOT NULL,
    category TEXT,
    is_current BOOLEAN NOT NULL DEFAULT 0
  )`)
  db.prepare('INSERT INTO providers VALUES(?,?,?,?,?,?)')
    .run('codex-official', 'codex', 'OpenAI Official', '{"auth":{"token":"SECRET-TOKEN"}}', 'official', 0)
  db.prepare('INSERT INTO providers VALUES(?,?,?,?,?,?)')
    .run('default', 'codex', 'default', '{"env":{"OPENAI_API_KEY":"SECRET-KEY"}}', 'custom', 1)
  db.prepare('INSERT INTO providers VALUES(?,?,?,?,?,?)')
    .run('dsh-1', 'dsh', 'DSH Provider', '{"api_key":"SECRET-DSH"}', 'custom', 1)
  db.close()

  const listed = manager.codexProviders(homes)
  assert.deepEqual(listed, [
    { id: 'default', name: 'default', category: 'custom', isCurrent: true },
    { id: 'codex-official', name: 'OpenAI Official', category: 'official', isCurrent: false }
  ])
  assert.equal(JSON.stringify(listed).includes('SECRET'), false)
})
