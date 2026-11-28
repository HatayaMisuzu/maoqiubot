const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, session, shell, utilityProcess } = require('electron')
const { once } = require('node:events')
const { existsSync, mkdirSync, readdirSync, readFileSync, statSync } = require('node:fs')
const { delimiter, dirname, join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const { createAgentManager } = require('./agent-manager.cjs')
const { agentHome } = require('../contracts/agent-runtime.ts')
const { connectorSettings, settingsView, saveInstance, createWorktree, validateWorktreeRequest, worktreeSource, normalizeStablePath } = require('./connector-settings.cjs')

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
let origin, connectorExit, restarting

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
        void restartConnector().catch(error => dialog.showErrorBox('无法重启连接器', error.message))
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
    save: value => saveInstance(settings(), workbench.db, value),
    worktreeSource: instance => worktreeSource(settings(), instance),
    restart: async () => { await restartConnector(); return {connectorRunning:!!connector} },
    openPath: path => shell.openPath(path),
    notify: body => { if(Notification.isSupported())new Notification({title:'小毛球提醒',body}).show() }
  } })
  await once(workbench.server, 'listening')
  const { port } = workbench.server.address()
  origin = 'http://127.0.0.1:' + port
  function view() {
    const s = settings()
    try { return { ...settingsView(s), connectorRunning: !!connector, lastError: connectorExit } }
    catch { return { ...s, instances: [], connectorRunning: false, lastError: '无法读取连接器配置，请核对路径和 JSON 内容。' } }
  }
  function assertConnectorIdle({ allowPurgedReleaseUncertain = false } = {}) {
    const uncertainFilter = allowPurgedReleaseUncertain
      ? `r.status='uncertain' AND NOT (
          EXISTS(SELECT 1 FROM threads t WHERE t.id=r.threadId AND t.state='purged')
          AND EXISTS(SELECT 1 FROM commands c WHERE c.runId=r.id AND c.kind='prepare' AND json_extract(c.payload,'$.nativeOperation.action')='release')
        )`
      : `r.status='uncertain'`
    const busy = connector && workbench.db.prepare(`SELECT 1 FROM runs r JOIN instances i ON r.instanceId=i.id
      WHERE i.nodeId='local' AND (
        r.status IN ('running','waiting_input','cancelling')
        OR (${uncertainFilter})
        OR (r.status='queued' AND EXISTS(SELECT 1 FROM commands c WHERE c.runId=r.id AND c.status IN ('sent','received')))
      ) LIMIT 1`).get()
    if (busy) throw Error('本机 Agent 仍有运行或待核对操作。请等待结束、在工作话题停止，或先完成待核对运行核对')
  }
  function resumeConnector() {
    if (closing || connector) return
    const config = settings()
    settingsView(config)
    launchConnector(paths, config.file, port)
  }
  agentManager = createAgentManager({
    root: paths.root, resourcesPath: process.resourcesPath, packaged: app.isPackaged,
    userData: app.getPath('userData'), stopConnector, resumeConnector,
    instanceHomes: instanceId => {
      const variables = { codex: 'CODEX_HOME', dsh: 'DSH_HOME', hermes: 'HERMES_HOME' }
      const instances = view().instances.filter(instance => instance.configurationHome)
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
    },
    assertIdle: () => {
      if (restarting) throw Error('连接器正在重启，请稍后打开外接 Agent 管理')
      assertConnectorIdle({ allowPurgedReleaseUncertain: false })
    }
  })
  function restartConnector() {
    if (restarting) return restarting
    if (closing) return Promise.reject(Error('工作台正在退出'))
    if (agentManager.status().active) return Promise.reject(Error('请先关闭外接 Agent 管理窗口，再测试连接'))
    try { assertConnectorIdle({ allowPurgedReleaseUncertain: true }) }
    catch (error) { return Promise.reject(error) }
    restarting = (async () => {
      await stopConnector()
      resumeConnector()
      return view()
    })().finally(() => { restarting = undefined })
    return restarting
  }
  function handle(channel, callback) {
    ipcMain.handle(channel, (event, value) => {
      if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame ||
        URL.parse(event.senderFrame.url)?.origin !== origin) throw Error('连接器设置限工作台主窗口')
      return callback(value)
    })
  }
  handle('connector:settings', view)
  handle('connector:save', value => saveInstance(settings(), workbench.db, value))
  handle('connector:restart', restartConnector)
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
  handle('connector:worktree', async value => {
    const current = settings()
    validateWorktreeRequest(current, workbench.db, value?.sourceId, value?.instanceId)
    const choice = await dialog.showOpenDialog(window, { title: '选择新 Git 工作树的父目录', properties: ['openDirectory'] })
    if (choice.canceled) return null
    return createWorktree(current, workbench.db, value?.sourceId, value?.instanceId, choice.filePaths[0])
  })
  try {
    resumeConnector()
  } catch { connectorExit = '连接器未启动，请在 Agent 设置中检查配置。' }
  await createWindow(paths.root, origin + '/login?ticket=' + workbench.ticket, restartConnector)
}

function launchConnector(paths, config, port) {
  const env = { ...process.env }
  delete env.OWNER_TOKEN
  connectorExit = undefined
  const scopes = workbench.db.prepare("SELECT id,runtimeScopeId FROM instances WHERE nodeId='local' AND runtimeScopeId IS NOT NULL").all()
  connector = utilityProcess.fork(join(paths.root, 'desktop', 'connector.mjs'), [config], {
    cwd: paths.workspace,
    serviceName: '小毛球 Agent 连接器',
    stdio: 'ignore',
    env: {
      ...env,
      NODE_TOKEN: workbench.auth.cfg.nodes.local,
      MAOQIU_NODE_URL: 'ws://127.0.0.1:' + port + '/api/v1/node',
      MAOQIU_EXPECTED_AGENT_SCOPES: JSON.stringify(Object.fromEntries(scopes.map(({id,runtimeScopeId}) => [id,runtimeScopeId])))
    }
  })
  connector.once('exit', code => {
    connector = undefined
    if (!closing && !restarting) connectorExit = '连接器已退出（代码 ' + code + '）。可在 Agent 设置或托盘中重启。'
  })
}

async function stopConnector() {
  if (connector) {
    const child = connector
    const exited = once(child, 'exit')
    child.postMessage('stop')
    let timer
    try {
      await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 2000) })])
      if (connector === child) {
        child.kill()
        await Promise.race([exited, new Promise(resolve => { setTimeout(resolve, 2000).unref() })])
        if (connector === child) throw Error('旧连接器仍在退出，请稍后重试')
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
async function stop() {
  await restarting?.catch(() => {})
  await agentManager?.stop()
  await stopConnector()
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
