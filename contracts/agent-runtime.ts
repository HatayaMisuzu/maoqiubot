import {createHash} from 'node:crypto'
import {homedir} from 'node:os'
import {basename,isAbsolute,join,resolve} from 'node:path'

const homeVariables=new Map([
  ['codex','CODEX_HOME'],
  ['dsh','DSH_HOME'],
  ['hermes','HERMES_HOME']
])

export function agentHomeVariable(adapterKey:string){
  return homeVariables.get(adapterKey)
}

export function agentHome(adapterKey:string,env?:Record<string,string>,cwd=process.cwd()){
  const key=agentHomeVariable(adapterKey)
  if(!key)return undefined
  const userHome=homedir()
  const defaultHome=adapterKey==='hermes'?
    join(process.platform==='win32'?(process.env.LOCALAPPDATA||join(userHome,'AppData','Local')):userHome,
      (process.platform==='win32'?'hermes':'.hermes')+(process.env.HERMES_DATA_DIR_SUFFIX??'')):
    join(userHome,'.'+adapterKey)
  return resolve(cwd,env?.[key]||process.env[key]||defaultHome)
}

export function agentCommand(adapterKey:string,command:string){
  const dshLauncher=/^dsh(?:\.cmd|\.exe)?$/i
  const configured=process.env.MAOQIU_DSH_EXECUTABLE
  if(adapterKey==='dsh'&&!isAbsolute(command)&&dshLauncher.test(command)&&configured&&isAbsolute(configured)&&dshLauncher.test(basename(configured)))
    return configured
  return command
}

export function agentRuntimeKey(profileId:string,home:string,command:string,args:string[]){
  return JSON.stringify([profileId,home,command,args])
}

export function agentRuntimeScope(runtime:string){
  return createHash('sha256').update(runtime).digest('hex')
}
