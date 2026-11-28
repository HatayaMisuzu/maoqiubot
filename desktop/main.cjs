const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, session, shell, utilityProcess } = require('electron')
const { once } = require('node:events')
const { randomUUID } = require('node:crypto')
const { existsSync, mkdirSync, readdirSync, readFileSync, statSync } = require('node:fs')
const { delimiter, dirname, join, resolve } = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { pathToFileURL } = require('node:url')
const { createAgentManager } = require('./agent-manager.cjs')
const { recoverCodexSwitch } = require('./codex-switch-recovery.cjs')
const { maintainConnector } = require('./connector-maintenance.cjs')
const { discoverHermes, probeHermes } = require('./hermes-discovery.cjs')
const { agentHome } = require('../contracts/agent-runtime.ts')
const {
  connectorSettings, settingsView, saveInstance, createWorktree, validateWorktreeRequest, worktreeSource, normalizeStablePath,
  previewCodexProviderSwitch, switchCodexProviderMode, probeCodexScope, localConnectorStatePath
} = require('./connector-settings.cjs')

app.setName('小毛球 Bot 工作台')
app.setAppUserModelId('local.xiaomaoqiu.workbench')
if (process.env.MAOQIU_DESKTOP_PROFILE) {
  const profile = resolve(process.env.MAOQIU_DESKTOP_PROFILE)
  mkdirSync(profile, { recursive: true })
  app.setPath('userData', profile)
}

let workbench, connector, window, tray, agentManager
let closing = false
let allowExit = false
let origin, connectorExit, connectorGeneration, restarting

function isProjectDirectory(path) {
  try {
    const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))
    return manifest.name === 'xiaomaoqiu-workbench' &&
      existsSync(join(path, 'server', 'index.ts')) &&
      existsSync(join(path, 'connector', 'config.example.json'))
  } catch {
    return false
  }
}

function appPaths() {
  const root = app.getAppPath()
  const packagedSource = resolve(dirname(process.execPath), '..', '..')
  const repo = !app.isPackaged ? root : isProjectDirectory(packagedSource) ? packagedSource : null
  const workspace = repo ?? join(app.getPath('userData'), 'workspace')
  const dataDir = process.env.MAOQIU_DATA ? resolve(process.env.MAOQIU_DATA) :
    repo ? join(repo, 'data') : join(app.getPath('userData'), 'workbench')
  return { root, workspace, dataDir }
}

function addInstalledCodexToPath() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return
  const bin = join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin')
  if (!existsSync(bin)) return
  const installed = readdirSync(bin, { withFileTypes: true }).flatMap(entry => {
    if (!entry.isDirectory()) return []
    const path = join(bin, entry.name, 'codex.exe')
    const metadata = statSync(path, { throwIfNoEntry: false })
    return metadata?.isFile() ? [{ path, updated: metadata.mtimeMs }] : []
  }).sort((a, b) => b.updated - a.updated)[0]
  if (installed) process.env.Path = [dirname(installed.path), process.env.Path].filter(Boolean).join(delimiter)
}

function show() {
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function createWindow(root, login, restartConnector) {
  const iconFile = join(root, 'desktop', 'icon.png')
  const icon = nativeImage.createFromPath(iconFile)
  const privateSession = session.fromPartition('xiaomaoqiu-workbench')
  privateSession.setPermissionCheckHandler(() => false)
  privateSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))

  window = new BrowserWindow({
    title: '小毛球 Bot 工作台',
    width: 1200, height: 840, minWidth: 390, minHeight: 530,
    show: false, autoHideMenuBar: true,
    ...(icon.isEmpty() ? {} : { icon }),
    backgroundColor: '#fafafa',
    webPreferences: {
      session: privateSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: join(root, 'desktop', 'preload.cjs'),
      devTools: false
    }
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    const destination = URL.parse(url)
    if (destination && ['https:', 'http:'].includes(destination.protocol) && destination.origin !== origin) {
      void shell.openExternal(destination.href).catch(() => {})
    }
    return { action: 'deny' }
  })
  const preventExternalNavigation = event => {
    if (URL.parse(event.url)?.origin !== origin) event.preventDefault()
  }
  window.webContents.on('will-navigate', preventExternalNavigation)
  window.webContents.on('will-redirect', preventExternalNavigation)
  window.webContents.on('will-attach-webview', event => event.preventDefault())

  if (!icon.isEmpty()) {
    tray = new Tray(icon)
    tray.setToolTip('小毛球 Bot 工作台')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开小毛球', click: show },
      { label: '重启 Agent 连接器', click: () => {
        void Promise.resolve().then(restartConnector).then(result => {
          if (result.lastError) dialog.showErrorBox('无法重启连接器', result.lastError)
        }).catch(error => dialog.showErrorBox('无法重启连接器', error.message))
      } },
      { label: '退出工作台', click: () => app.quit() }
    ]))
    tray.on('double-click', show)
  }
  window.on('close', event => {
    if (tray && !closing) {
      event.preventDefault()
      window.hide()
    }
  })
  window.once('ready-to-show', show)
  return window.loadURL(login)
}

async function start() {
  const paths = appPaths()
  const managedFile = join(paths.dataDir, 'desktop-connector.json')
  const codexIdentityChanges = new Set()
  let recoveryError
  const settings = () => connectorSettings(paths)
  mkdirSync(paths.workspace, { recursive: true })
  addInstalledCodexToPath()
  Menu.setApplicationMenu(null)
  const { startServer } = await import(pathToFileURL(join(paths.root, 'server', 'index.ts')).href)
  workbench = startServer({ host: '127.0.0.1', port: 0, dataDir: paths.dataDir, desktop: {
    status: () => {
      const result = view()
      return { connectorRunning:result.connectorRunning, lastError:result.lastError,
        instances:result.instances.map(({id,name,adapterKey,workspaceRef,profileId,detectedCommand})=>({id,name,adapterKey,workspaceRef,profileId,detectedCommand})) }
    },
    save: saveConnectorInstance,
    worktreeSource: instance => worktreeSource(settings(), instance),
    restart: async () => { await restartConnector(); return {connectorRunning:!!connector} },
    openPath: path => shell.openPath(path),
    notify: body => { if(Notification.isSupported())new Notification({title:'小毛球提醒',body}).show() }
  } })
  workbench.pauseLocalDispatch(true)
  workbench.expectLocalGeneration(null)
  await once(workbench.server, 'listening')
  const { port } = workbench.server.address()
  origin = 'http://127.0.0.1:' + port
  function resolveInstanceHomes(instanceId, instanceList = view().instances) {
    const variables = { codex: 'CODEX_HOME', dsh: 'DSH_HOME', hermes: 'HERMES_HOME' }
    const instances = instanceList.filter(instance => instance.configurationHome)
    const selected = instances.find(instance => instance.id === instanceId)
    if (instanceId != null && !selected) throw Error('找不到指定的本机 Agent 实例')
    const env = {}
    for (const [adapter, key] of Object.entries(variables)) {
      const homes = new Set(instances.filter(instance => instance.adapterKey === adapter)
        .map(instance => instance.configurationHome))
      const home = homes.size === 1 ? [...homes][0] :
        selected?.adapterKey === adapter ? selected.configurationHome : agentHome(adapter, undefined, paths.workspace)
      env[key] = normalizeStablePath(home)
    }
    return env
  }
  function view() {
    let s
    const connectorRegistration = workbench.localConnectorStatus(connectorGeneration)
    try {
      if (recoveryError) throw Error(recoveryError)
      s = settings()
      const base = settingsView(s)
      const instances = base.instances.map(instance => {
        if (instance.adapterKey !== 'codex' || !agentManager) return instance
        let codexManagerProviders = []
        try {
          codexManagerProviders = agentManager.codexProviders(resolveInstanceHomes(instance.id, base.instances))
        } catch {}
        const registration = connectorRegistration.instances.find(item => item.id === instance.id)
        const codexIdentityChanged = codexIdentityChanges.has(instance.id) || registration?.error?.startsWith('原生账号、供应商或 profile 已变化')
        return { ...instance, codexManagerProviders, codexIdentityChanged: Boolean(codexIdentityChanged) }
      })
      return { ...base, instances, connectorGeneration, connectorRegistration, connectorRunning: !!connector, lastError: connectorExit }
    } catch {
      return { ...s, instances: [], connectorGeneration, connectorRegistration, connectorRunning: false,
        lastError: recoveryError ?? '无法读取连接器配置，请核对路径和 JSON 内容。' }
    }
  }
  function localReceiptsPending() {
    const filename = localConnectorStatePath(settings())
    if (!existsSync(filename)) return false
    const nodeDb = new DatabaseSync(filename, { readOnly: true })
    try {
      const table = nodeDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='commands'").get()
      return !!table && !!nodeDb.prepare("SELECT 1 FROM commands WHERE status IN ('received','uncertain') LIMIT 1").get()
    } finally { nodeDb.close() }
  }
  function assertConnectorIdle(restart) {
    if (closing) throw Error('工作台正在退出')
    if (restart && !connector) return
    const busy = workbench.localQueriesPending() || workbench.db.prepare(`SELECT 1 FROM runs r JOIN instances i ON r.instanceId=i.id
      WHERE i.nodeId='local' AND (
        r.status IN ('running','waiting_input','cancelling')
        OR (?=0 AND r.status IN ('queued','uncertain'))
        OR (r.status='queued' AND EXISTS(SELECT 1 FROM commands c WHERE c.runId=r.id AND c.status IN ('sent','received')))
        OR (?=0 AND EXISTS(SELECT 1 FROM commands c WHERE c.runId=r.id AND c.status IN ('sent','received','uncertain')))
      ) LIMIT 1`).get(Number(restart), Number(restart)) || (!restart && localReceiptsPending())
    if (busy) throw Error('本机 Agent 仍有运行或待核对操作。请等待结束、在工作话题停止，或先完成待核对运行核对')
  }
  function resumeConnector() {
    if (closing || connector) return
    try {
      recoverCodexSwitch(managedFile, workbench.db)
      recoveryError = undefined
    } catch (error) {
      recoveryError = '连接器已暂停。' + error.message
      throw Error(recoveryError)
    }
    const config = settings()
    settingsView(config)
    launchConnector(paths, config.file, port)
    workbench.pauseLocalDispatch(false)
  }
  async function resumeConnectorAfterManager() {
    if (closing || connector) return
    const config = settings()
    if (config.editable) {
      for (const instance of settingsView(config).instances) {
        if (closing) return
        if (instance.adapterKey !== 'codex' || !registeredScope(instance.id)) continue
        try {
          const scope = await probeCodexScope(config, instance.id, instance.codexProviderMode)
          const input = { instanceId: instance.id, codexProviderMode: instance.codexProviderMode }
          const preview = previewCodexProviderSwitch(config, workbench.db, input, scope)
          if (preview.noChange) {
            codexIdentityChanges.delete(instance.id)
            continue
          }
          codexIdentityChanges.add(instance.id)
          if (!preview.boundThreads) {
            assertConnectorIdle(false)
            const result = switchCodexProviderMode(config, workbench.db, { ...input, confirmationToken: preview.confirmationToken }, scope)
            if (result.applied) codexIdentityChanges.delete(instance.id)
          }
        } catch (error) {
          // Keeping the old expected scope lets other instances resume and prevents unverified Codex dispatch.
          connectorExit = error.message
        }
      }
    }
    resumeConnector()
  }
  function registeredScope(instanceId) {
    return workbench.db.prepare("SELECT runtimeScopeId FROM instances WHERE id=? AND nodeId='local' AND adapterKey='codex'").get(instanceId)?.runtimeScopeId
  }
  const lifecycle = {
    pause: workbench.pauseLocalDispatch,
    assertIdle: assertConnectorIdle,
    stop: stopConnector,
    running: () => !!connector,
    resume: resumeConnector,
    resumeAfterExit: () => {
      connectorExit = '旧连接器未确认退出，已暂停本机派发。'
      const old = connector
      old?.once('exit', () => setImmediate(() => {
        if (closing || connector || restarting || agentManager.status().active) return
        try { resumeConnector() }
        catch (error) { connectorExit = error.message }
      }))
    }
  }
  agentManager = createAgentManager({
    root: paths.root, resourcesPath: process.resourcesPath, packaged: app.isPackaged,
    userData: app.getPath('userData'),
    stopConnector: () => maintainConnector(lifecycle, { keepPaused: true }),
    resumeConnector: resumeConnectorAfterManager,
    instanceHomes: instanceId => resolveInstanceHomes(instanceId),
    assertIdle: () => {
      if (closing || restarting || recoveryError) throw Error(recoveryError ?? '连接器正在切换或退出，请稍后打开外接 Agent 管理')
    }
  })
  function assertSettingsAvailable({ recovery = false } = {}) {
    if (closing) throw Error('工作台正在退出')
    if (restarting) throw Error('连接器操作正在进行，请稍后再试')
    if (agentManager.status().active) throw Error('请先关闭外接 Agent 管理窗口，等待连接器恢复后再试')
    if (!recovery && recoveryError) throw Error(recoveryError)
  }
  function exclusively(operation, options) {
    assertSettingsAvailable(options)
    restarting = Promise.resolve().then(operation).finally(() => { restarting = undefined })
    return restarting
  }
  function saveConnectorInstance(value) {
    assertSettingsAvailable()
    return saveInstance(settings(), workbench.db, value)
  }
  function restartConnector() {
    return exclusively(async () => {
      const { startError } = await maintainConnector(lifecycle, { restart: true })
      if (startError) connectorExit = startError.message
      return view()
    }, { recovery: true })
  }
  function setCodexProvider(value) {
    return exclusively(async () => {
      const config = settings()
      let preview = previewCodexProviderSwitch(config, workbench.db, value)
      const identityChanged = view().instances.find(instance => instance.id === preview.instanceId)?.codexIdentityChanged
      const verifyIdentity = preview.noChange && (preview.previousMode === 'native' || identityChanged) && registeredScope(preview.instanceId)
      const verifyTarget = !preview.noChange && preview.boundThreads > 0
      function probeTarget() {
        const identity = probeCodexScope(config, preview.instanceId, preview.codexProviderMode)
        return verifyIdentity ? identity : identity.catch(() => undefined)
      }
      const scope = verifyIdentity || verifyTarget ? await probeTarget() : undefined
      if (verifyIdentity || verifyTarget) preview = previewCodexProviderSwitch(config, workbench.db, value, scope)
      if (preview.noChange) {
        codexIdentityChanges.delete(preview.instanceId)
        return { ...preview, applied: false, requiresConfirmation: false, view: view() }
      }
      if (verifyIdentity) codexIdentityChanges.add(preview.instanceId)
      if ((preview.boundThreads || value.confirmationToken) && value.confirmationToken !== preview.confirmationToken) {
        return { ...preview, applied: false, requiresConfirmation: true, view: view() }
      }
      const { result, startError } = await maintainConnector(lifecycle, {}, async () => {
        const confirmedScope = verifyIdentity || verifyTarget ? await probeTarget() : undefined
        assertConnectorIdle(false)
        return switchCodexProviderMode(settings(), workbench.db, {
          ...value, confirmationToken: preview.confirmationToken
        }, confirmedScope)
      })
      if (result.applied) codexIdentityChanges.delete(preview.instanceId)
      if (startError) connectorExit = startError.message
      return { ...result, view: view() }
    })
  }
  function handle(channel, callback) {
    ipcMain.handle(channel, (event, value) => {
      if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame ||
        URL.parse(event.senderFrame.url)?.origin !== origin) throw Error('连接器设置限工作台主窗口')
      return callback(value)
    })
  }
  handle('connector:settings', view)
  handle('connector:save', saveConnectorInstance)
  handle('connector:codex-provider', setCodexProvider)
  handle('connector:restart', restartConnector)
  handle('connector:hermes-discover', () => discoverHermes(settings()))
  handle('connector:hermes-probe', value => exclusively(() => probeHermes(settings(), value)))
  handle('agent-manager:status', agentManager.status)
  handle('agent-manager:open', agentManager.open)
  handle('agent-manager:monitor', value => {
    const groups = Map.groupBy(view().instances.filter(instance => instance.adapterKey === 'dsh' &&
      instance.configurationHome && instance.dshRuntimeScopeId), instance => instance.configurationHome)
    const databases = [...groups].flatMap(([home, items]) => agentManager.dshDatabases(home).map(databasePath => ({
      databasePath,
      instances: items.map(({id, dshRuntimeScopeId}) => ({id, runtimeScopeId: dshRuntimeScopeId}))
    })))
    return workbench.agentMonitor(value, databases)
  })
  handle('agent-manager:quota', instanceId => workbench.agentQuota(instanceId))
  handle('connector:worktree', value => exclusively(async () => {
    const current = settings()
    validateWorktreeRequest(current, workbench.db, value?.sourceId, value?.instanceId)
    const choice = await dialog.showOpenDialog(window, { title: '选择新 Git 工作树的父目录', properties: ['openDirectory'] })
    if (choice.canceled || closing) return null
    return createWorktree(current, workbench.db, value?.sourceId, value?.instanceId, choice.filePaths[0])
  }))
  try {
    resumeConnector()
  } catch (error) { connectorExit = error.message }
  await createWindow(paths.root, origin + '/login?ticket=' + workbench.ticket, restartConnector)
}

function launchConnector(paths, config, port) {
  const env = { ...process.env }
  delete env.OWNER_TOKEN
  connectorExit = undefined
  connectorGeneration = randomUUID()
  workbench.expectLocalGeneration(connectorGeneration)
  const scopes = workbench.db.prepare("SELECT id,runtimeScopeId FROM instances WHERE nodeId='local' AND runtimeScopeId IS NOT NULL").all()
  const child = utilityProcess.fork(join(paths.root, 'desktop', 'connector.mjs'), [config], {
    cwd: paths.workspace,
    serviceName: '小毛球 Agent 连接器',
    stdio: 'ignore',
    env: {
      ...env,
      NODE_TOKEN: workbench.auth.cfg.nodes.local,
      MAOQIU_NODE_URL: 'ws://127.0.0.1:' + port + '/api/v1/node',
      MAOQIU_CONNECTOR_GENERATION: connectorGeneration,
      MAOQIU_EXPECTED_AGENT_SCOPES: JSON.stringify(Object.fromEntries(scopes.map(({id,runtimeScopeId}) => [id,runtimeScopeId])))
    }
  })
  connector = child
  let fatal = false
  child.on('error', () => { fatal = true })
  child.once('exit', code => {
    if (connector !== child) return
    connector = undefined
    if (!closing) connectorExit = (fatal ? '连接器异常退出' : '连接器已退出') + '（代码 ' + code + '）。可在 Agent 设置或托盘中重启。'
  })
}

async function stopConnector(force = false) {
  if (connector) {
    const child = connector
    let onExit
    const exited = new Promise(resolve => { onExit = resolve; child.once('exit', onExit) })
    let onMessage
    const denied = new Promise((_, reject) => {
      onMessage = data => {
        if (!force && data === 'stop-blocked') reject(Object.assign(
          Error('连接器仍在处理原生操作，请等待结束或停止原运行后再试'), { connectorStillServing: true }))
      }
      child.on('message', onMessage)
    })
    let timer
    try {
      child.postMessage(force ? 'quit' : 'stop')
      await Promise.race([exited, denied, new Promise(resolve => { timer = setTimeout(resolve, 2000) })])
      if (force && connector === child) {
        child.kill()
        await Promise.race([exited, new Promise(resolve => { setTimeout(resolve, 2000).unref() })])
      }
      if (connector === child) throw Error('旧连接器没有确认退出，已暂停派发。可在 Agent 设置中重试')
    } finally {
      clearTimeout(timer)
      child.off('exit', onExit)
      child.off('message', onMessage)
    }
  }
}
async function stop() {
  await restarting?.catch(() => {})
  await agentManager?.stop()
  await stopConnector(true)
  if (workbench) await workbench.close()
  tray?.destroy()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', show)
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', event => {
    if (allowExit) return
    event.preventDefault()
    if (closing) return
    closing = true
    void stop().catch(error => console.error('关闭工作台失败', error)).finally(() => {
      allowExit = true
      app.quit()
    })
  })
  app.whenReady().then(start).catch(error => {
    dialog.showErrorBox('无法打开小毛球', error.message)
    app.quit()
  })
}
