const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const { once } = require('node:events')
const { mkdirSync, readdirSync, statSync } = require('node:fs')
const { join } = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const inheritedEnvironment = new Set([
  'path', 'systemroot', 'windir', 'comspec', 'userprofile', 'homedrive', 'homepath', 'home',
  'appdata', 'localappdata', 'programdata', 'programfiles', 'programfiles(x86)', 'temp', 'tmp',
  'lang', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'ssl_cert_file', 'ssl_cert_dir'
])

function agentManagerEnvironment(source, homes, data) {
  const env = Object.fromEntries(Object.entries(source).filter(([key, value]) =>
    inheritedEnvironment.has(key.toLowerCase()) && typeof value === 'string'))
  return { ...env, ...homes, MAOQIU_AGENT_MANAGER_DATA: data }
}

function createAgentManager({ root, resourcesPath, packaged, userData, stopConnector, resumeConnector, assertIdle, instanceHomes }) {
  function resolveManagerPaths() {
    if (packaged) {
      const directory = join(resourcesPath, 'agent-manager')
      return { directory, binary: join(directory, 'agent-manager.exe') }
    }
    const buildDir = join(root, 'build', 'agent-manager')
    const legacyDir = join(root, 'dist', 'agent-manager')
    const buildBin = join(buildDir, 'agent-manager.exe')
    const legacyBin = join(legacyDir, 'agent-manager.exe')
    if (statSync(buildBin, { throwIfNoEntry: false })?.isFile() || !statSync(legacyBin, { throwIfNoEntry: false })?.isFile()) {
      return { directory: buildDir, binary: buildBin }
    }
    return { directory: legacyDir, binary: legacyBin }
  }
  const stateDir = join(userData, 'agent-manager')
  let child, opening, stopping, failure, activeInstanceId = null

  function scope(value) {
    return createHash('sha256').update(JSON.stringify(value.map(path => process.platform === 'win32' ? path.toLowerCase() : path))).digest('hex')
  }

  function dshScope(home) {
    return join(stateDir, scope([home]))
  }

  function dshDatabases(home) {
    try {
      const directory = dshScope(home)
      return readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
        .map(entry => join(directory, entry.name, 'cc-switch.db'))
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }

  function codexProviders(homes) {
    if (!homes?.DSH_HOME || !homes?.CODEX_HOME || !homes?.HERMES_HOME) return []
    const dbPath = join(dshScope(homes.DSH_HOME), scope([homes.CODEX_HOME, homes.HERMES_HOME]), 'cc-switch.db')
    if (!statSync(dbPath, { throwIfNoEntry: false })?.isFile()) return []
    let db
    try {
      db = new DatabaseSync(dbPath, { open: true, readOnly: true })
      const rows = db.prepare(`SELECT id, name, category, is_current
        FROM providers
        WHERE app_type = 'codex'
        ORDER BY is_current DESC, rowid ASC`).all()
      return rows.map(row => ({
        id: String(row.id),
        name: String(row.name),
        category: row.category == null ? null : String(row.category),
        isCurrent: Boolean(row.is_current)
      }))
    } catch {
      return []
    } finally {
      try { db?.close() } catch {}
    }
  }

  function status() {
    const active = Boolean(child || opening)
    const { binary } = resolveManagerPaths()
    return {
      available: process.platform === 'win32' && Boolean(statSync(binary, { throwIfNoEntry: false })?.isFile()),
      active,
      ...(active && activeInstanceId ? { instanceId: activeInstanceId } : {}),
      ...(failure ? { error: failure } : {})
    }
  }

  async function launch(instanceId) {
    assertIdle()
    const { directory, binary } = resolveManagerPaths()
    const homes = instanceHomes(instanceId)
    // Native history and enabled-provider metadata must stay with the homes that produced them.
    const data = join(dshScope(homes.DSH_HOME), scope([homes.CODEX_HOME, homes.HERMES_HOME]))
    const env = agentManagerEnvironment(process.env, homes, data)
    mkdirSync(data, { recursive: true })
    await stopConnector()
    if (stopping) return

    activeInstanceId = instanceId ?? null
    const managerProcess = spawn(binary, [], { cwd: directory, env, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    child = managerProcess
    managerProcess.stdin.on('error', () => {})
    const exited = () => {
      if (child !== managerProcess) return
      child = undefined
      activeInstanceId = null
      if (!stopping) {
        try { resumeConnector() }
        catch { failure = '本机 Agent 连接器未能恢复，请在 Agent 设置里测试连接。' }
      }
    }
    managerProcess.once('exit', (code, signal) => {
      if (!stopping && (code !== 0 || signal)) failure = '外接 Agent 管理进程已停止，可重新打开。'
      exited()
    })
    managerProcess.once('error', () => {
      failure = '无法启动内置 Agent 管理进程。'
      exited()
    })
    try { await once(managerProcess, 'spawn') }
    catch { activeInstanceId = null; throw Error(failure ?? '无法启动内置 Agent 管理进程。') }
  }

  async function open(instanceId) {
    if (stopping) throw Error('工作台正在退出')
    if (opening) {
      await opening
      if (child && instanceId !== undefined && activeInstanceId !== instanceId) {
        throw Error('外接 Agent 管理窗口正打开其他配置目录，请先关闭当前管理窗口后再切换')
      }
      return status()
    }
    if (child) {
      if (instanceId !== undefined && activeInstanceId !== instanceId) {
        throw Error('外接 Agent 管理窗口正打开其他配置目录，请先关闭当前管理窗口后再切换')
      }
      child.stdin.write('show\n')
      return status()
    }
    if (!status().available) throw Error('当前桌面包缺少内置 Agent 管理组件。')
    failure = undefined
    opening = launch(instanceId).catch(error => {
      if (!child) activeInstanceId = null
      throw error
    }).finally(() => { opening = undefined })
    await opening
    return status()
  }

  async function stop() {
    stopping = true
    await opening?.catch(() => {})
    if (!child) return
    const process = child
    const exited = once(process, 'exit').catch(() => {})
    process.stdin.end('quit\n')
    let timer
    try {
      await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 2000) })])
      if (child === process) process.kill()
    } finally { clearTimeout(timer) }
  }

  return { status, open, stop, dshDatabases, codexProviders }
}

module.exports = { agentManagerEnvironment, createAgentManager }
