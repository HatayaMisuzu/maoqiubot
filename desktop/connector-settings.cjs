const { existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { accountRuntimeKey, agentCommand, agentHome, agentHomeVariable, agentRuntimeKey, agentRuntimeScope } = require('../contracts/agent-runtime.ts')
const { commitCodexSwitch } = require('./codex-switch-recovery.cjs')
const git = promisify(execFile)
const confirmationSalt = randomUUID()
const officialNames = {
  codex: /^codex(?:\.exe)?$/i,
  dsh: /^dsh(?:\.exe|\.cmd)?$/i,
  hermes: /^hermes(?:\.exe|\.cmd)?$/i
}

function normalizeStablePath(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return targetPath
  const resolved = resolve(targetPath)
  const suffix = []
  let probe = resolved
  while (true) {
    try {
      const real = realpathSync.native(probe)
      return suffix.length ? join(real, ...suffix.reverse()) : real
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return resolved
      const parent = dirname(probe)
      if (parent === probe) return resolved
      suffix.push(basename(probe))
      probe = parent
    }
  }
}
function detectedCommand(adapterKey, command, configurationHome) {
  return detectedCommands(adapterKey, command, configurationHome)[0] ?? null
}
function detectedCommands(adapterKey, command, configurationHome, environment = process.env) {
  if (typeof command !== 'string' || !officialNames[adapterKey]?.test(basename(command)) ||
      (!isAbsolute(command) && command !== basename(command))) return []
  const names = adapterKey === 'hermes' && command.toLowerCase() !== 'hermes' ? [basename(command)] :
    ['dsh','hermes'].includes(adapterKey) && process.platform === 'win32' ? [adapterKey+'.exe', adapterKey+'.cmd'] :
    adapterKey === 'codex' && process.platform === 'win32' ? ['codex.exe'] : [adapterKey]
  const pathDirs = (environment.Path ?? environment.PATH ?? '').split(delimiter)
    .map(dir => dir.replace(/^"|"$/g, '')).filter(dir => isAbsolute(dir))
  const installs = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA,'Programs')]
    .filter(Boolean).map(dir => join(dir,'DeepSeekHarness','resources','runtime','cli','bin'))
  const hermesHome = configurationHome ?? agentHome('hermes')
  const candidates = isAbsolute(command) ? [command] : [
    ...(adapterKey === 'dsh' && process.env.MAOQIU_DSH_EXECUTABLE ? [process.env.MAOQIU_DSH_EXECUTABLE] : []),
    ...[...(adapterKey==='hermes'?[join(hermesHome,'bin')]:[]),...pathDirs,...(adapterKey==='dsh'?installs:[])]
      .flatMap(dir => names.map(name => join(dir,name)))
  ]
  const seen = new Set()
  return candidates.filter(path => {
    if (!isAbsolute(path) || !officialNames[adapterKey].test(basename(path))) return false
    try {
      if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return false
      const real = realpathSync.native(path)
      const key = process.platform === 'win32' ? real.toLowerCase() : real
      if (seen.has(key)) return false
      seen.add(key)
      return true
    } catch { /* PATH can contain inaccessible directories. Continue discovery. */ }
    return false
  })
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
  return parseConfig(readFileSync(file, 'utf8'))
}

function parseConfig(text) {
  const config = JSON.parse(text.replace(/^\uFEFF/, ''))
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

function readCodexLocalSummary(codexHome) {
  if (!codexHome || typeof codexHome !== 'string') return { modelProvider: null, model: null }
  const configFile = join(codexHome, 'config.toml')
  try {
    const meta = statSync(configFile, { throwIfNoEntry: false })
    if (!meta?.isFile() || meta.size > 2 * 1024 * 1024) return { modelProvider: null, model: null }
    const text = readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '')
    let modelProvider = null
    let model = null
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      // Only inspect top-level keys before the first TOML section header.
      if (line.startsWith('[')) break
      const pair = line.match(/^(model_provider|model)\s*=\s*(.+)$/)
      if (!pair) continue
      const key = pair[1]
      const valueText = pair[2].trim()
      let parsed = null
      const dq = valueText.match(/^"((?:[^"\\]|\\.)*)"(?:\s*(?:#.*)?)?$/)
      if (dq) {
        parsed = dq[1].replace(/\\(.)/g, '$1')
      } else {
        const sq = valueText.match(/^'([^']*)'(?:\s*(?:#.*)?)?$/)
        if (sq) parsed = sq[1]
      }
      if (!parsed) continue
      if (key === 'model_provider') modelProvider = parsed
      else if (key === 'model') model = parsed
    }
    return { modelProvider, model }
  } catch {
    return { modelProvider: null, model: null }
  }
}

function settingsView(settings) {
  const instances = configFrom(settings.file).instances.map(instance => {
    const { id, name, adapterKey, profileId, workspaceRef, command, args, env, worktree } = instance
    const home = agentHome(adapterKey, env, settings.workspace)
    const configurationHome = home ? normalizeStablePath(home) : home
    let dsh
    if (adapterKey === 'dsh' && Array.isArray(args)) {
      const at = args.indexOf('--profile')
      const selected = at >= 0 ? args[at+1] : args.find(arg => typeof arg === 'string' && arg.startsWith('--profile='))?.slice(10) ?? args[0]
      const nativeProfile = typeof selected === 'string' && /^[\w-]+$/.test(selected) ? selected : null
      dsh = {
        nativeProfile,
        nativeProfileInitialized: Boolean(nativeProfile && existsSync(join(home,'profiles',nativeProfile,'cordis.patch.yml'))),
        dshRuntimeScopeId: agentRuntimeScope(agentRuntimeKey(profileId ?? 'default',home,agentCommand(adapterKey,command),args)),
        hasDshOverrides: existsSync(join(home,'cordis.patch.yml')) ||
          args.some(arg => typeof arg === 'string' && (arg === '--patch' || arg.startsWith('--patch=')))
      }
    }
    return { id, name, adapterKey, profileId: profileId ?? 'default', workspaceRef, command, worktree, configurationHome,
      configuredHome: env?.[agentHomeVariable(adapterKey)] || '',
      ...(adapterKey === 'codex' ? {
        codexProviderMode: instance.codexProviderMode ?? 'official',
        codexLocal: readCodexLocalSummary(home)
      } : {}),
      ...dsh, detectedCommand: detectedCommand(adapterKey,command,home) }
  })
  return { file: settings.file, editable: settings.editable, workspace: settings.workspace, instances }
}

function saveInstance(settings, db, input) {
  if (!settings.editable) throw Error('当前使用独立 JSON 配置，请在原文件中修改')
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('实例配置无效')
  const { adapterKey } = input
  if (!Object.hasOwn(officialNames, adapterKey)) throw Error('请选择 Codex、DSH 或 Hermes')
  function required(key) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 1000 || /[\r\n\0]/.test(input[key])) {
      throw Error('请填写有效的 ' + key)
    }
    return input[key].trim()
  }
  const id = required('id'), name = required('name'), profileId = required('profileId'), requested = required('command')
  if (!/^[\w-]{1,64}$/.test(id) || id === 'main' || !/^[\w.-]{1,64}$/.test(profileId)) throw Error('请使用有效的实例 ID 和 profile 标识')
  const basenamePattern = officialNames[adapterKey]
  if (!basenamePattern.test(basename(requested)) || (!isAbsolute(requested) && requested !== basename(requested))) {
    throw Error('请填写官方可执行程序名或完整路径')
  }
  const workspace = resolve(settings.workspace, required('workspaceRef'))
  if (!statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) throw Error('找不到指定的工作区目录')
  const workspaceRef = realpathSync(workspace), config = configFrom(settings.file)
  const existing = config.instances.find(i => i.id === id)
  const source = input.sourceId === undefined ? undefined : config.instances.find(i => i.id === input.sourceId)
  if (input.sourceId !== undefined && (!source || existing || source.adapterKey !== adapterKey)) throw Error('复制来源或目标实例已变化')
  const defaults = existing ?? source
  const homeKey = agentHomeVariable(adapterKey)
  const env = {...defaults?.env}
  if (input.configurationHome !== undefined) {
    if (typeof input.configurationHome !== 'string' || input.configurationHome.length > 1000 || /[\r\n\0]/.test(input.configurationHome)) {
      throw Error('请填写有效的 Agent 配置目录')
    }
    const configuredHome = input.configurationHome.trim()
    if (configuredHome) {
      if (!isAbsolute(configuredHome) && configuredHome !== defaults?.env?.[homeKey]) throw Error('Agent 配置目录须为绝对路径')
      env[homeKey] = configuredHome
    } else delete env[homeKey]
  }
  const home = agentHome(adapterKey, env, settings.workspace)
  const command = adapterKey === 'hermes' ? detectedCommand(adapterKey,requested,home) ?? requested : requested
  if (isAbsolute(command) && !statSync(command, { throwIfNoEntry: false })?.isFile()) throw Error('找不到指定的 Agent 可执行程序')
  const oldMode = defaults?.codexProviderMode ?? 'official'
  const codexProviderMode = input.codexProviderMode ?? oldMode
  if (adapterKey === 'codex' && !['official','native'].includes(codexProviderMode)) throw Error('请选择有效的 Codex 供应商模式')
  const registered = db.prepare('SELECT workspaceRef,profileId,adapterKey,runtimeScopeId FROM instances WHERE id=?').get(id)
  const inUse = registered && db.prepare('SELECT 1 FROM threads WHERE instanceId=? LIMIT 1').get(id)
  if (registered && (registered.workspaceRef !== workspaceRef || registered.profileId !== profileId || registered.adapterKey !== adapterKey ||
    ((inUse || registered.runtimeScopeId) && (existing?.command !== command || home !== agentHome(adapterKey, existing?.env, settings.workspace) ||
      (adapterKey === 'codex' && codexProviderMode !== oldMode))))) {
    throw Error('此实例已登记。更换执行入口、配置目录、供应商模式、工作区或 profile 时请使用新实例 ID')
  }
  const args = defaults?.adapterKey === adapterKey ? defaults.args :
    adapterKey === 'codex' ? ['app-server'] : adapterKey === 'hermes' ? ['acp'] : ['--profile', 'acp']
  const next = { ...existing, id, name, adapterKey, profileId, workspaceRef, command, args }
  if (Object.keys(env).length) next.env = env
  else delete next.env
  if (adapterKey === 'codex' && codexProviderMode === 'native') next.codexProviderMode = codexProviderMode
  else delete next.codexProviderMode
  if (workspaceRef !== existing?.workspaceRef || adapterKey !== existing?.adapterKey) delete next.worktree
  config.instances = existing ? config.instances.map(i => i.id === id ? next : i) : [...config.instances, next]
  write(settings.file, config)
  return settingsView(settings)
}

function validateWorktreeRequest(settings, db, sourceId, instanceId) {
  if (!settings.editable) throw Error('当前使用独立 JSON 配置，请在原环境管理工作区')
  if (typeof instanceId !== 'string' || !/^[a-zA-Z0-9][\w-]{0,47}$/.test(instanceId) || instanceId === 'main' ||
    /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])$/i.test(instanceId)) throw Error('请为新实例填写有效且唯一的 ID')
  const config = configFrom(settings.file)
  const source = config.instances.find(item => item.id === sourceId)
  if (!source || !officialNames[source.adapterKey]?.test(basename(source.command))) throw Error('请选择本机 Agent 实例')
  if (config.instances.some(i => i.id.toLowerCase() === instanceId.toLowerCase()) ||
    db.prepare('SELECT id FROM instances WHERE id=? COLLATE NOCASE').get(instanceId)) throw Error('这个实例 ID 已存在，请换一个 ID')
  return source
}

async function createWorktree(settings, db, sourceId, instanceId, parent) {
  const source = validateWorktreeRequest(settings, db, sourceId, instanceId)
  function available(config) {
    if (config.instances.some(i => i.id.toLowerCase() === instanceId.toLowerCase()) ||
      db.prepare('SELECT id FROM instances WHERE id=? COLLATE NOCASE').get(instanceId)) throw Error('这个实例 ID 已存在，请换一个 ID')
  }
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

function codexBindings(db, instanceId, currentScope) {
  return db.prepare(`SELECT id,state,sessionId,nativeRuntimeScopeId,nativeInvalid FROM threads
    WHERE instanceId=?
      AND sessionId IS NOT NULL
      AND COALESCE(nativeReleased,0)=0
      AND (nativeRuntimeScopeId IS NULL OR nativeRuntimeScopeId=?)
    ORDER BY id`).all(instanceId, currentScope)
}

function codexInstance(settings, config, instanceId, mode) {
  const source = config.instances.find(item => item.id === instanceId && item.adapterKey === 'codex')
  if (!source) throw Error('找不到指定的本机 Codex 实例')
  const home = agentHome('codex', source.env, settings.workspace)
  return { ...source, codexProviderMode: mode, profileId: source.profileId ?? 'default',
    workspaceRef: realpathSync(resolve(settings.workspace, source.workspaceRef)),
    env: { ...source.env, CODEX_HOME: home } }
}

async function probeCodexScope(settings, instanceId, mode) {
  const instance = codexInstance(settings, configFrom(settings.file), instanceId, mode)
  const { Codex } = await import('../connector/adapters/codex.ts')
  const agent = new Codex(instance)
  try {
    await agent.initialize()
    const account = await agent.identity()
    const runtime = agentRuntimeKey(instance.profileId, instance.env.CODEX_HOME, instance.command, instance.args)
    return agentRuntimeScope(accountRuntimeKey(runtime, account))
  } catch {
    throw Error('无法核对本机 Codex 原生供应商或账号，请检查启动入口和登录状态')
  } finally {
    agent.close()
  }
}

function codexConfigEvidence(instance, mode) {
  const hash = createHash('sha256')
  function read(path) {
    try {
      const meta = statSync(path)
      if (!meta.isFile() || meta.size > 2 * 1024 * 1024) throw Error('无法核对 Codex 本机配置')
      return readFileSync(path)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw Error('无法核对 Codex 本机配置')
      return Buffer.alloc(0)
    }
  }
  const home = instance.env.CODEX_HOME
  if (mode === 'native') {
    hash.update(JSON.stringify([home, read(join(home, 'config.toml')).toString('base64')]))
    for (let cwd = instance.workspaceRef; ; cwd = dirname(cwd)) {
      hash.update(JSON.stringify([cwd, read(join(cwd, '.codex', 'config.toml')).toString('base64')]))
      if (dirname(cwd) === cwd) break
    }
  }
  const auth = read(join(home, 'auth.json'))
  try {
    const data = JSON.parse(auth.toString('utf8'))
    // Avoid binding confirmation to routine ChatGPT access/refresh token rotation.
    hash.update(JSON.stringify([data.auth_mode, data.tokens?.account_id, data.OPENAI_API_KEY]))
  } catch { hash.update(auth) }
  return hash.digest('hex')
}

function prepareCodexSwitch(settings, db, input, verifiedScope) {
  if (!settings.editable) throw Error('当前使用独立 JSON 配置，请在原文件中修改')
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('实例配置无效')
  const instanceId = typeof input.instanceId === 'string' ? input.instanceId.trim() : ''
  const previous = readFileSync(settings.file)
  const config = parseConfig(previous.toString('utf8'))
  const existing = config.instances.find(item => item.id === instanceId && item.adapterKey === 'codex')
  if (!existing) throw Error('找不到指定的本机 Codex 实例')
  const codexProviderMode = input.codexProviderMode
  if (!['official', 'native'].includes(codexProviderMode)) throw Error('请选择有效的 Codex 供应商模式')
  const registered = db.prepare('SELECT nodeId,adapterKey,runtimeScopeId FROM instances WHERE id=?').get(instanceId)
  if (config.nodeId !== 'local' || (registered && (registered.nodeId !== 'local' || registered.adapterKey !== 'codex'))) {
    throw Error('供应商切换仅支持本机 Codex 实例')
  }
  const previousMode = existing.codexProviderMode === 'native' ? 'native' : 'official'
  const previousScope = registered?.runtimeScopeId ?? null
  const modeChanged = previousMode !== codexProviderMode
  const identityChanged = !modeChanged && previousScope && verifiedScope && verifiedScope !== previousScope
  const noChange = !modeChanged && !identityChanged
  const threads = noChange ? [] : codexBindings(db, instanceId, previousScope)
  let confirmationToken
  if (!noChange) {
    const instance = codexInstance(settings, config, instanceId, codexProviderMode)
    confirmationToken = createHash('sha256').update(confirmationSalt).update(previous)
      .update(JSON.stringify([instanceId, codexProviderMode, previousScope, verifiedScope ?? null, threads,
        codexConfigEvidence(instance, codexProviderMode),
        modeChanged ? codexConfigEvidence(instance, previousMode) : null])).digest('hex')
  }
  return {
    config, previous, threads, modeChanged,
    preview: { instanceId, codexProviderMode, previousMode, noChange, boundThreads: threads.length, confirmationToken }
  }
}

function previewCodexProviderSwitch(settings, db, input, verifiedScope) {
  return prepareCodexSwitch(settings, db, input, verifiedScope).preview
}

function localConnectorStatePath(settings) {
  return join(resolve(settings.workspace, configFrom(settings.file).stateDir), 'connector.sqlite')
}

function switchCodexProviderMode(settings, db, input, verifiedScope) {
  const { config, previous, threads, modeChanged, preview } = prepareCodexSwitch(settings, db, input, verifiedScope)
  const { instanceId, codexProviderMode, boundThreads, noChange, confirmationToken } = preview
  if (noChange) return { applied: false, noChange: true, requiresConfirmation: false, boundThreads: 0 }
  if ((input.confirmationToken && input.confirmationToken !== confirmationToken) ||
    (boundThreads > 0 && input.confirmationToken !== confirmationToken)) {
    return { applied: false, noChange: false, requiresConfirmation: true, boundThreads, confirmationToken }
  }
  config.instances = config.instances.map(item => {
    if (item.id !== instanceId) return item
    const next = { ...item }
    if (codexProviderMode === 'native') next.codexProviderMode = 'native'
    else delete next.codexProviderMode
    return next
  })
  const next = modeChanged ? Buffer.from(JSON.stringify(config, null, 2) + '\n') : previous
  commitCodexSwitch(settings.file, db, previous, next, () => {
    const invalidate = db.prepare(`UPDATE threads SET nativeInvalid=COALESCE(nativeInvalid,?),
      state=CASE WHEN state='active' THEN 'archived' ELSE state END WHERE id=?`)
    for (const thread of threads) invalidate.run('Codex 供应商配置已切换，请新建话题或创建替代话题继续', thread.id)
    db.prepare("UPDATE instances SET runtimeScopeId=?,online=0 WHERE id=? AND nodeId='local' AND adapterKey='codex'")
      .run(verifiedScope ?? null, instanceId)
  })
  return {
    applied: true,
    noChange: false,
    requiresConfirmation: false,
    boundThreads,
    invalidatedThreads: threads.filter(item => !item.nativeInvalid).length
  }
}

function worktreeSource(settings, instance) {
  if (!settings.editable) return undefined
  return configFrom(settings.file).instances.find(i => i.id === instance.id && i.workspaceRef === instance.workspaceRef &&
    i.adapterKey === instance.adapterKey)?.worktree?.sourceId
}

module.exports = {
  configFrom, detectedCommands,
  connectorSettings, settingsView, saveInstance, createWorktree, validateWorktreeRequest, worktreeSource, normalizeStablePath,
  readCodexLocalSummary, previewCodexProviderSwitch, switchCodexProviderMode, probeCodexScope, localConnectorStatePath
}
