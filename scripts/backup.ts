import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, copyFileSync, renameSync, mkdtempSync, rmSync, statSync, realpathSync, readFileSync, chmodSync } from 'node:fs'
import {resolve,join,basename,dirname,relative,isAbsolute,sep} from 'node:path'
import {pathToFileURL} from 'node:url'

type Options={connectorDir?:string,connectorConfig?:string}
function outside(source:string,target:string){
  const rel=relative(source,target)
  return isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep)
}
function snapshot(source:string,destination:string){
  const db=new DatabaseSync(source,{readOnly:true})
  try{
    db.exec('PRAGMA busy_timeout=10000')
    db.prepare('VACUUM INTO ?').run(destination)
  }finally{db.close()}
  chmodSync(destination,0o600)
}
function checkDatabase(db:DatabaseSync){
  if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').get()){
    throw Error('备份数据库一致性检查失败')
  }
}
function privateCopy(source:string,dest:string){
  copyFileSync(source,dest)
  chmodSync(dest,0o600)
}
export function transfer(source:string,destination:string,restore=false,opts:Options={}){
  const src=realpathSync(source),requested=resolve(destination)
  if(existsSync(requested))throw Error('目标目录必须尚未存在')
  if(!existsSync(join(src,'workbench.sqlite')))throw Error('源目录没有 workbench.sqlite')
  if(!outside(src,requested))throw Error('请选择数据目录外的目标目录')
  mkdirSync(dirname(requested),{recursive:true,mode:0o700})
  const dest=join(realpathSync(dirname(requested)),basename(requested))
  if(!outside(src,dest))throw Error('请选择数据目录外的目标目录')
  if(restore&&(opts.connectorDir||opts.connectorConfig))throw Error('恢复时从备份读取连接器状态')
  if(opts.connectorConfig&&!opts.connectorDir)throw Error('备份连接器配置时需要同时指定状态目录')
  const stage=mkdtempSync(join(dirname(dest),'.maoqiu-copy-'))
  try{
    const file=join(stage,'workbench.sqlite')
    snapshot(join(src,'workbench.sqlite'),file)
    const snap=new DatabaseSync(file)
    try{
      checkDatabase(snap)
      if(snap.prepare("SELECT 1 FROM sqlite_schema WHERE name='run_grants'").get())snap.exec('DELETE FROM run_grants')
      const files=snap.prepare('SELECT id,bytes FROM attachments').all()
      mkdirSync(join(stage,'attachments'),{mode:0o700})
      for(const file of files){
        const key=String(file.id)
        if(basename(key)!==key || !/^[a-zA-Z0-9_-]+$/.test(key))throw Error('附件 ID 无效')
        const target=join(stage,'attachments',key)
        privateCopy(join(src,'attachments',key),target)
        if(statSync(target).size!==file.bytes)throw Error('附件长度不符 '+key)
      }
    }finally{snap.close()}
    const access=join(src,'access.local.json')
    if(existsSync(access)){
      const config=JSON.parse(readFileSync(access,'utf8'))
      const nodes=config?.nodes
      if(typeof config?.ownerToken!=='string'||config.ownerToken.length<16||!nodes||typeof nodes!=='object'||Array.isArray(nodes)||
        Object.values(nodes).some(v=>typeof v!=='string'||v.length<16)||
        new Set([config.ownerToken,...Object.values(nodes)]).size!==1+Object.keys(nodes).length)throw Error('备份访问配置无效')
      privateCopy(access,join(stage,'access.local.json'))
    }
    if(existsSync(join(src,'persona.md')))privateCopy(join(src,'persona.md'),join(stage,'persona.md'))
    const connectorSource=restore?join(src,'connector'):opts.connectorDir
    if(connectorSource&&(!restore||existsSync(connectorSource))){
      const connectorTarget=join(stage,restore?'node-local':'connector'),targetFile=join(connectorTarget,'connector.sqlite')
      const sourceFile=join(connectorSource,'connector.sqlite')
      if(!existsSync(sourceFile))throw Error('连接器备份没有 connector.sqlite')
      mkdirSync(connectorTarget,{mode:0o700})
      snapshot(sourceFile,targetFile)
      const connector=new DatabaseSync(targetFile,{readOnly:true})
      try{
        checkDatabase(connector)
        if(connector.prepare("SELECT 1 FROM bindings WHERE instance='' OR workspace='' OR session='' LIMIT 1").get())throw Error('连接器会话绑定无效')
      }finally{connector.close()}
      const config=restore?join(connectorSource,'config.json'):opts.connectorConfig
      if(config&&(!restore||existsSync(config))){
        const parsed=JSON.parse(readFileSync(config,'utf8').replace(/^\uFEFF/,''))
        if(!Array.isArray(parsed.instances)||typeof parsed.stateDir!=='string')throw Error('连接器实例配置无效')
        privateCopy(config,restore?join(stage,'connector-config.backed-up.json'):join(connectorTarget,'config.json'))
      }
    }
    if(existsSync(dest))throw Error('目标目录必须尚未存在')
    renameSync(stage,dest)
  }catch(e){
    if(existsSync(stage)&&dirname(realpathSync(stage))===dirname(dest))rmSync(stage,{recursive:true,force:true})
    throw e
  }
  return {operation:restore?'restore':'backup',directory:dest}
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const [mode,src,dest,...args]=process.argv.slice(2),opts:Options={}
  const usage='用法：npm run backup -- save|restore 源目录 新目标目录 [--connector 状态目录] [--connector-config 配置文件]'
  if(!['save','restore'].includes(mode)||!src||!dest||args.length%2)throw Error(usage)
  for(let i=0;i<args.length;i+=2){
    if(args[i]==='--connector')opts.connectorDir=args[i+1]
    else if(args[i]==='--connector-config')opts.connectorConfig=args[i+1]
    else throw Error(usage)
  }
  console.log(transfer(src,dest,mode==='restore',opts))
}
