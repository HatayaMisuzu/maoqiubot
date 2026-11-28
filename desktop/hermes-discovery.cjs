const { realpathSync } = require('node:fs')
const { resolve } = require('node:path')
const { agentHome } = require('../contracts/agent-runtime.ts')
const { configFrom, detectedCommands } = require('./connector-settings.cjs')

function hermesCandidates(settings) {
  let configured
  try { configured = configFrom(settings.file).instances.filter(instance => instance.adapterKey === 'hermes') }
  catch { throw Error('无法读取连接器配置，请核对路径和 JSON 内容。') }
  const defaultHome = agentHome('hermes', undefined, settings.workspace)
  const known = new Set()
  const candidates = configured.map(instance => {
    const configurationHome = agentHome('hermes', instance.env, settings.workspace)
    const command = detectedCommands('hermes', instance.command, configurationHome, {...process.env,...instance.env})[0]
    if (command) known.add(command)
    return {
      entry: {...instance,command},
      view: { instanceId: instance.id, name: instance.name, command: command ?? instance.command,
        configurationHome, profileId: instance.profileId ?? 'default', found: Boolean(command) }
    }
  })
  for (const command of detectedCommands('hermes', 'hermes', defaultHome)) {
    if (known.has(command)) continue
    candidates.push({
      entry: { id:'hermes-probe', name:'Hermes', adapterKey:'hermes', command, args:['acp'], workspaceRef:settings.workspace },
      view: { command, configurationHome: defaultHome, profileId: 'default', found: true }
    })
  }
  return candidates
}

function discoverHermes(settings) {
  return { editable:settings.editable, candidates:hermesCandidates(settings).map(candidate=>candidate.view) }
}

async function probeHermes(settings, selection) {
  const candidate = hermesCandidates(settings).find(({view})=>
    view.instanceId===selection?.instanceId&&view.command===selection?.command&&
    view.profileId===selection?.profileId&&view.configurationHome===selection?.configurationHome)
  if (!candidate?.view.found) return { status:'missing', detail:'启动器未找到，请重新扫描。' }
  const { entry, view } = candidate
  const { Hermes } = await import('../connector/adapters/hermes.ts')
  let adapter
  try {
    adapter = new Hermes({...entry,workspaceRef:realpathSync(resolve(settings.workspace,entry.workspaceRef)),
      env:{...entry.env,HERMES_HOME:view.configurationHome}})
    await adapter.probe()
    return { status:'ready', detail:'ACP 握手成功。模型调用还需要模型配置和额度。' }
  } catch (error) {
    const message = typeof error?.message==='string' ? error.message : ''
    const detail = message==='initialize 等待原生响应超时' ? 'ACP 握手超时，请核对 Hermes 安装和配置。' :
      message==='ACP 握手返回了另一种 Agent' ? '启动器返回了其他 Agent 的身份。' :
      'ACP 握手失败，请运行 hermes --version 检查运行时及 hermes_cli 安装。'
    return { status:'failed', detail }
  } finally {
    adapter?.close()
  }
}

module.exports = { discoverHermes, probeHermes }
