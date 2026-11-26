const { existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { basename, delimiter, isAbsolute, join, relative, resolve, sep } = require('node:path')
const { randomUUID } = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const git = promisify(execFile)
const officialNames = {
  codex: /^codex(?:\.exe)?$/i,
  dsh: /^dsh(?:\.exe|\.cmd)?$/i
}
function detectedCommand(adapterKey, command) {
  if (!officialNames[adapterKey]?.test(basename(command))) return null
  const names = adapterKey === 'dsh' && process.platform === 'win32' ? ['dsh.exe', 'dsh.cmd'] :
    adapterKey === 'codex' && process.platform === 'win32' ? ['codex.exe'] : [adapterKey]
  const pathDirs = (process.env.Path ?? process.env.PATH ?? '').split(delimiter)
    .map(dir => dir.replace(/^"|"$/g, '')).filter(dir => isAbsolute(dir))
  const installs = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA,'Programs')]
    .filter(Boolean).map(dir => join(dir,'DeepSeekHarness','resources','runtime','cli','bin'))
  const candidates = isAbsolute(command) ? [command] : [
    ...(adapterKey === 'dsh' && process.env.MAOQIU_DSH_EXECUTABLE ? [process.env.MAOQIU_DSH_EXECUTABLE] : []),
    ...[...pathDirs,...(adapterKey==='dsh'?installs:[])].flatMap(dir => names.map(name => join(dir,name)))
  ]
  for (const path of candidates) {
    if (!isAbsolute(path) || !officialNames[adapterKey].test(basename(path))) continue
    try {
      if (statSync(path, { throwIfNoEntry: false })?.isFile()) return path
    } catch { /* PATH can contain inaccessible directories. Continue discovery. */ }
  }
  return null
}

function connectorSettings({ root, workspace, dataDir }) {
  const override = process.env.MAOQIU_CONNECTOR_CONFIG
  const local = join(workspace, 'connector', 'config.local.json')
  const managed = join(dataDir, 'desktop-connector.json')
  const file = override ? resolve(override) : existsSync(local) ? local : managed
  const editable = file === managed
  if (editable && !existsSync(file)) {
    const config = JSON.parse(readFileSync(join(root, 'connector', 'config.example.json'), 'utf8'))
    config.stateDir = join(dataDir, 'node-local')
    for (const instance of config.instances) if (instance.adapterKey === 'dsh')
      instance.command = detectedCommand('dsh','dsh') ?? (process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
    write(file, config)
  }
  return { file, editable, workspace }
}

function configFrom(file) {
  const config = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  if (!Array.isArray(config.instances) || typeof config.stateDir !== 'string' || !config.stateDir) {
    throw Error('连接器配置缺少 stateDir 或 instances')
  }
  return config
}

function write(file, config) {
  const stage = file + '.' + randomUUID()
  try {
    writeFileSync(stage, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    renameSync(stage, file)
  } finally { rmSync(stage, { force: true }) }
}

function settingsView(settings) {
  const instances = configFrom(settings.file).instances.map(({ id, name, adapterKey, profileId, workspaceRef, command, worktree }) =>
    ({ id, name, adapterKey, profileId: profileId ?? 'default', workspaceRef, command, worktree,
      detectedCommand:detectedCommand(adapterKey,command) }))
  return { file: settings.file, editable: settings.editable, workspace: settings.workspace, instances }
}

function saveInstance(settings, db, input) {
  if (!settings.editable) throw Error('当前使用独立 JSON 配置，请在原文件中修改')
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('实例配置无效')
  const { adapterKey } = input
  if (!['codex', 'dsh'].includes(adapterKey)) throw Error('请选择 Codex 或 DSH')
  function required(key) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 1000 || /[\r\n\0]/.test(input[key])) {
      throw Error('请填写有效的 ' + key)
    }
    return input[key].trim()
  }
  const id = required('id'), name = required('name'), profileId = required('profileId'), command = required('command')
  if (!/^[\w-]{1,64}$/.test(id) || id === 'main' || !/^[\w.-]{1,64}$/.test(profileId)) throw Error('请使用有效的实例 ID 和 profile 标识')
  const basenamePattern = officialNames[adapterKey]
  if (!basenamePattern.test(basename(command)) || (!isAbsolute(command) && command !== basename(command))) {
    throw Error('请填写官方可执行程序名或完整路径')
  }
  if (isAbsolute(command) && !statSync(command, { throwIfNoEntry: false })?.isFile()) throw Error('找不到指定的 Agent 可执行程序')
  const workspace = resolve(settings.workspace, required('workspaceRef'))
  if (!statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) throw Error('找不到指定的工作区目录')
  const workspaceRef = realpathSync(workspace), config = configFrom(settings.file)
  const existing = config.instances.find(i => i.id === id)
  const registered = db.prepare('SELECT workspaceRef,profileId,adapterKey FROM instances WHERE id=?').get(id)
  const inUse = registered && db.prepare('SELECT 1 FROM threads WHERE instanceId=? LIMIT 1').get(id)
  if (registered && (registered.workspaceRef !== workspaceRef || registered.profileId !== profileId || registered.adapterKey !== adapterKey ||
    (inUse && existing?.command !== command))) throw Error('此实例已登记。修改执行入口、工作区或 profile 时请使用新实例 ID')
  const args = existing?.adapterKey === adapterKey ? existing.args : adapterKey === 'codex' ? ['app-server'] : ['--profile', 'acp']
  const next = { ...existing, id, name, adapterKey, profileId, workspaceRef, command, args }
  if (workspaceRef !== existing?.workspaceRef || adapterKey !== existing?.adapterKey) delete next.worktree
  config.instances = existing ? config.instances.map(i => i.id === id ? next : i) : [...config.instances, next]
  write(settings.file, config)
  return settingsView(settings)
}

async function createWorktree(settings, db, sourceId, instanceId, parent) {
  if (!settings.editable) throw Error('当前使用独立 JSON 配置，请在原环境管理工作区')
  if (typeof instanceId !== 'string' || !/^[a-zA-Z0-9][\w-]{0,47}$/.test(instanceId) || instanceId === 'main' ||
    /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])$/i.test(instanceId)) throw Error('请为新实例填写有效且唯一的 ID')
  const source = configFrom(settings.file).instances.find(item => item.id === sourceId)
  if (!source || !officialNames[source.adapterKey]?.test(basename(source.command))) throw Error('请选择本机 Codex 或 DSH 实例')
  function available(config) {
    if (config.instances.some(i => i.id.toLowerCase() === instanceId.toLowerCase()) ||
      db.prepare('SELECT id FROM instances WHERE id=? COLLATE NOCASE').get(instanceId)) throw Error('这个实例 ID 已存在，请换一个 ID')
  }
  available(configFrom(settings.file))
  // Git can expand Windows short paths even when Node's realpathSync preserves them.
  const cwd = realpathSync.native(resolve(settings.workspace, source.workspaceRef))
  const destinationParent = realpathSync.native(parent)
  const workspaceRef = join(destinationParent, instanceId)
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key]
  async function run(args, directory = cwd) {
    try {
      const { stdout } = await git('git', ['--no-optional-locks', ...args], {
        cwd: directory, env, windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024
      })
      return stdout.trim()
    } catch (error) {
      if (error.code === 'ENOENT') throw Error('找不到 Git，请检查本机 Git 安装')
      throw Error('Git 操作失败：' + String(error.stderr || error.message).trim().slice(0, 700))
    }
  }
  const root = realpathSync.native(await run(['rev-parse', '--show-toplevel']))
  if (relative(root, cwd) !== '') throw Error('请从以仓库根目录为工作区的实例创建 Worktree')
  const inside = relative(root, destinationParent)
  if (!inside || (!isAbsolute(inside) && inside !== '..' && !inside.startsWith('..' + sep))) throw Error('请选择原工作区以外的 Worktree 父目录')
  if (lstatSync(workspaceRef, { throwIfNoEntry: false })) throw Error('目标路径已存在，请换一个目录或实例 ID')
  const branch = 'maoqiu/' + instanceId
  const baseCommit = await run(['rev-parse', '--verify', 'HEAD^{commit}'])
  if (!/^[a-f0-9]{40,64}$/.test(baseCommit)) throw Error('无法核对仓库的当前提交')
  const dirty = Boolean(await run(['status', '--porcelain']))
  await run(['worktree', 'add', '-b', branch, '--', workspaceRef, baseCommit])
  try {
    const actual = realpathSync.native(workspaceRef)
    if (relative(actual, workspaceRef) !== '' || await run(['branch', '--show-current'], actual) !== branch ||
      await run(['rev-parse', 'HEAD'], actual) !== baseCommit) throw Error('Git 回执与目标目录、分支或基准提交不一致')
    const config = configFrom(settings.file)
    available(config)
    if (JSON.stringify(config.instances.find(item => item.id === sourceId)) !== JSON.stringify(source)) throw Error('来源实例配置已变化')
    const worktree = { branch, baseCommit, sourceId }
    config.instances.push({ ...source, id: instanceId, name: source.name + ' · ' + instanceId, workspaceRef: actual, worktree })
    write(settings.file, config)
    return { workspaceRef: actual, branch, baseCommit, dirty }
  } catch (error) {
    throw Error('Git 已创建目录 ' + workspaceRef + '，实例未保存：' + error.message)
  }
}

function worktreeSource(settings, instance) {
  if (!settings.editable) return undefined
  return configFrom(settings.file).instances.find(i => i.id === instance.id && i.workspaceRef === instance.workspaceRef &&
    i.adapterKey === instance.adapterKey)?.worktree?.sourceId
}

module.exports = { connectorSettings, settingsView, saveInstance, createWorktree, worktreeSource }
