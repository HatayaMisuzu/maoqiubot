const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, session, shell, utilityProcess } = require('electron')
const { once } = require('node:events')
const { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } = require('node:fs')
const { delimiter, dirname, join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')

app.setName('小毛球 Bot 工作台')
app.setAppUserModelId('local.xiaomaoqiu.workbench')
if (process.env.MAOQIU_DESKTOP_PROFILE) {
  const profile = resolve(process.env.MAOQIU_DESKTOP_PROFILE)
  mkdirSync(profile, { recursive: true })
  app.setPath('userData', profile)
}

let workbench, connector, window, tray
let closing = false
let allowExit = false
let origin

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

function connectorConfig({ root, workspace, dataDir }) {
  const configured = process.env.MAOQIU_CONNECTOR_CONFIG
  if (configured) return resolve(configured)
  const localConfig = join(workspace, 'connector', 'config.local.json')
  if (existsSync(localConfig)) return localConfig
  const config = JSON.parse(readFileSync(join(root, 'connector', 'config.example.json'), 'utf8'))
  config.stateDir = join(dataDir, 'node-local')
  const file = join(dataDir, 'desktop-connector.json')
  writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 })
  return file
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

function createWindow(root, login) {
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
    backgroundColor: '#f7f9f6',
    webPreferences: {
      session: privateSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
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
  mkdirSync(paths.workspace, { recursive: true })
  addInstalledCodexToPath()
  Menu.setApplicationMenu(null)
  const { startServer } = await import(pathToFileURL(join(paths.root, 'server', 'index.ts')).href)
  workbench = startServer({ host: '127.0.0.1', port: 0, dataDir: paths.dataDir })
  await once(workbench.server, 'listening')
  const { port } = workbench.server.address()
  origin = 'http://127.0.0.1:' + port
  const config = connectorConfig(paths)
  const env = { ...process.env }
  delete env.OWNER_TOKEN
  connector = utilityProcess.fork(join(paths.root, 'desktop', 'connector.mjs'), [config], {
    cwd: paths.workspace,
    serviceName: '小毛球 Agent 连接器',
    stdio: 'ignore',
    env: {
      ...env,
      NODE_TOKEN: workbench.auth.cfg.nodes.local,
      MAOQIU_NODE_URL: 'ws://127.0.0.1:' + port + '/api/v1/node'
    }
  })
  connector.once('exit', code => {
    connector = undefined
    if (!closing) dialog.showErrorBox('Agent 连接器已退出', '退出代码 ' + code + '。可以继续查看项目和记录，重新打开工作台可启动连接器。')
  })
  await createWindow(paths.root, origin + '/login?ticket=' + workbench.ticket)
}

async function stop() {
  if (connector) {
    const child = connector
    const exited = once(child, 'exit')
    child.postMessage('stop')
    let timer
    try {
      await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 2000) })])
      if (connector === child) child.kill()
    } finally {
      clearTimeout(timer)
    }
  }
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
