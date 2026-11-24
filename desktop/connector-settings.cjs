const { existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { basename, isAbsolute, join, resolve } = require('node:path')
const { randomUUID } = require('node:crypto')

function connectorSettings({ root, workspace, dataDir }) {
  const override = process.env.MAOQIU_CONNECTOR_CONFIG
  const local = join(workspace, 'connector', 'config.local.json')
  const managed = join(dataDir, 'desktop-connector.json')
  const file = override ? resolve(override) : existsSync(local) ? local : managed
  const editable = file === managed
  if (editable && !existsSync(file)) {
    const config = JSON.parse(readFileSync(join(root, 'connector', 'config.example.json'), 'utf8'))
    config.stateDir = join(dataDir, 'node-local')
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
  const instances = configFrom(settings.file).instances.map(({ id, name, adapterKey, profileId, workspaceRef, command }) =>
    ({ id, name, adapterKey, profileId: profileId ?? 'default', workspaceRef, command }))
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
  const basenamePattern = adapterKey === 'codex' ? /^codex(?:\.exe)?$/i : /^dsh(?:\.exe|\.cmd)?$/i
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
  config.instances = existing ? config.instances.map(i => i.id === id ? next : i) : [...config.instances, next]
  write(settings.file, config)
  return settingsView(settings)
}

module.exports = { connectorSettings, settingsView, saveInstance }
