import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, copyFileSync, renameSync, mkdtempSync, rmSync, statSync, realpathSync, readFileSync, chmodSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import {resolve,join,basename,dirname,relative,isAbsolute,sep} from 'node:path'
import {pathToFileURL} from 'node:url'
import { tree,writeTree } from '../server/plugins/files.ts'
import { scrubCachedGrantTokens } from '../server/db/index.ts'

type Options={connectorDir?:string,connectorConfig?:string,offline?:boolean,includeAccess?:boolean}
const fileDigest=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex')
const activeRuns="SELECT id FROM runs WHERE status IN ('queued','running','waiting_input','cancelling','uncertain') ORDER BY rowid"
function table(db:DatabaseSync,name:string){return !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name)}
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
  if(restore&&(opts.connectorDir||opts.connectorConfig||opts.offline||opts.includeAccess))throw Error('恢复时从备份读取连接器状态与配置')
  if(opts.connectorConfig&&!opts.connectorDir)throw Error('备份连接器配置时需要同时指定状态目录')
  const manifestFile=join(src,'backup.json')
  const fromManifest=restore&&existsSync(manifestFile)?JSON.parse(readFileSync(manifestFile,'utf8')):null
  const stage=mkdtempSync(join(dirname(dest),'.maoqiu-copy-'))
  const manifest={version:1,createdAt:new Date().toISOString(),mode:opts.offline?'offline':'online',
    schema:0,activeRunIds:[] as string[],attachmentHashes:{} as Record<string,string>,connector:false,includedAccess:false,excludedConnectorCommands:0}
  try{
    const file=join(stage,'workbench.sqlite')
    snapshot(join(src,'workbench.sqlite'),file)
    const snap=new DatabaseSync(file)
    try{
      checkDatabase(snap)
      manifest.schema=Number(snap.prepare('PRAGMA user_version').get()?.user_version)
      if(table(snap,'runs'))manifest.activeRunIds=snap.prepare(activeRuns).all().map(r=>String(r.id))
      if(opts.offline&&(manifest.activeRunIds.length||table(snap,'chat_jobs')&&snap.prepare("SELECT 1 FROM chat_jobs WHERE status IN ('queued','working')").get()))
        throw Error('仍有待处理运行或主聊，请在结束或人工放弃后执行停机备份')
      if(table(snap,'run_grants'))snap.exec('DELETE FROM run_grants')
      if(table(snap,'communication_grants'))snap.exec('DELETE FROM communication_grants')
      if(table(snap,'requests')){
        snap.exec('PRAGMA secure_delete=ON')
        scrubCachedGrantTokens(snap)
      }
      if(restore){
        // An online or older snapshot may predate a durable receipt on the connector.
        snap.exec(`UPDATE commands SET status='uncertain',detail='从备份恢复，原生送达需核对'
          WHERE status IN ('queued','sent','received') AND runId IN (${activeRuns});
          UPDATE commands SET status='held' WHERE status='waiting' AND runId IN (${activeRuns});
          UPDATE tasks SET status='uncertain' WHERE id IN (SELECT taskId FROM runs WHERE id IN (${activeRuns}));
          UPDATE runs SET status='uncertain',pendingRequest=NULL WHERE id IN (${activeRuns});
          UPDATE chat_jobs SET status='failed' WHERE status IN ('queued','working');`)
        if(snap.prepare("SELECT 1 FROM pragma_table_info('chat_jobs') WHERE name='operation'").get())
          snap.exec("UPDATE chat_jobs SET status=CASE WHEN status='awaiting_approval' THEN 'cancelled' ELSE status END,operation=NULL")
        if(snap.prepare("SELECT 1 FROM pragma_table_info('chat_jobs') WHERE name='checkpoint'").get())
          snap.exec("UPDATE chat_jobs SET status=CASE WHEN status='budget_paused' THEN 'cancelled' ELSE status END,checkpoint=NULL,inFlight=NULL")
      }
      const files=snap.prepare('SELECT id,bytes FROM attachments').all()
      mkdirSync(join(stage,'attachments'),{mode:0o700})
      for(const file of files){
        const key=String(file.id)
        if(basename(key)!==key || !/^[a-zA-Z0-9_-]+$/.test(key))throw Error('附件 ID 无效')
        const target=join(stage,'attachments',key)
        privateCopy(join(src,'attachments',key),target)
        if(statSync(target).size!==file.bytes)throw Error('附件长度不符 '+key)
        const digest=fileDigest(target)
        if(fromManifest && fromManifest.attachmentHashes?.[key]!==digest)throw Error('附件内容不符 '+key)
        manifest.attachmentHashes[key]=digest
      }
    }finally{snap.close()}
    const access=join(src,'access.local.json')
    if((restore||opts.includeAccess!==false)&&existsSync(access)){
      const config=JSON.parse(readFileSync(access,'utf8'))
      const nodes=config?.nodes
      if(typeof config?.ownerToken!=='string'||config.ownerToken.length<16||!nodes||typeof nodes!=='object'||Array.isArray(nodes)||
        Object.values(nodes).some(v=>typeof v!=='string'||v.length<16)||
        new Set([config.ownerToken,...Object.values(nodes)]).size!==1+Object.keys(nodes).length)throw Error('备份访问配置无效')
      privateCopy(access,join(stage,'access.local.json'))
      manifest.includedAccess=true
    }
    if(existsSync(join(src,'persona.md')))privateCopy(join(src,'persona.md'),join(stage,'persona.md'))
    for(const name of ['chat-models.json','chat-policy.json'])if(existsSync(join(src,name)))privateCopy(join(src,name),join(stage,name))
    const plugins=join(src,'plugins.json')
    if(existsSync(plugins)){
      const state=JSON.parse(readFileSync(plugins,'utf8'))
      const copied=new Set<string>()
      for(const item of Object.values(state.entries) as any[]){
        if(restore&&item.current?.source!=='bundled'){item.enabled=false;delete item.trusted}
        for(const version of [item.current,item.previous,item.pending]){
          if(!version||version.source==='bundled'||copied.has(version.folder))continue
          if(!/^[a-f0-9-]{36}$/.test(version.folder))throw Error('无效的插件备份目录')
          writeTree(join(stage,'plugins','packages',version.folder),tree(join(src,'plugins','packages',version.folder)))
          copied.add(version.folder)
        }
      }
      if(restore)state.revision++
      writeFileSync(join(stage,'plugins.json'),JSON.stringify(state,null,2),{mode:0o600})
    }
    const connectorSource=restore?join(src,'connector'):opts.connectorDir
    if(connectorSource&&(!restore||existsSync(connectorSource))){
      const connectorTarget=join(stage,restore?'node-local':'connector'),targetFile=join(connectorTarget,'connector.sqlite')
      const sourceFile=join(connectorSource,'connector.sqlite')
      if(!existsSync(sourceFile))throw Error('连接器备份没有 connector.sqlite')
      mkdirSync(connectorTarget,{mode:0o700})
      snapshot(sourceFile,targetFile)
      const connector=new DatabaseSync(targetFile)
      const workbench=new DatabaseSync(file,{readOnly:true})
      try{
        checkDatabase(connector)
        if(connector.prepare("SELECT 1 FROM bindings WHERE instance='' OR workspace='' OR session='' LIMIT 1").get())throw Error('连接器会话绑定无效')
        const thread=workbench.prepare('SELECT t.instanceId,t.sessionId,i.workspaceRef FROM threads t LEFT JOIN instances i ON i.id=t.instanceId WHERE t.id=?')
        for(const row of connector.prepare('SELECT thread,instance,workspace,session FROM bindings').all()){
          const recorded=thread.get(row.thread)
          if(recorded && (recorded.instanceId!==row.instance || recorded.workspaceRef&&recorded.workspaceRef!==row.workspace ||
            recorded.sessionId&&recorded.sessionId!==row.session))throw Error('工作台与连接器的原生会话绑定不一致')
        }
        if(table(connector,'commands')){
          const exists=workbench.prepare('SELECT 1 FROM commands WHERE id=?')
          for(const row of connector.prepare('SELECT id,status FROM commands').all()){
            const pending=['received','uncertain'].includes(String(row.status))
            if(opts.offline&&pending)throw Error('连接器仍有待核对命令，不能标记为停机完整备份')
            if(exists.get(row.id))continue
            manifest.excludedConnectorCommands++
            if(restore){
              connector.prepare("DELETE FROM outbox WHERE json_extract(event,'$.commandId')=?").run(row.id)
              connector.prepare('DELETE FROM receipt_acks WHERE id=?').run(row.id)
              connector.prepare('DELETE FROM commands WHERE id=?').run(row.id)
            }
          }
        }
        manifest.connector=true
      }finally{connector.close();workbench.close()}
      const config=restore?join(connectorSource,'config.json'):opts.connectorConfig
      if(config&&(!restore||existsSync(config))){
        const parsed=JSON.parse(readFileSync(config,'utf8').replace(/^\uFEFF/,''))
        if(!Array.isArray(parsed.instances)||typeof parsed.stateDir!=='string')throw Error('连接器实例配置无效')
        const address=typeof parsed.url==='string'?new URL(parsed.url):null
        if(address){address.username='';address.password='';address.search='';address.hash=''}
        const safe={stateDir:parsed.stateDir,url:address?.href,nodeId:parsed.nodeId,instances:parsed.instances.map((i:any)=>({
          id:i.id,name:i.name,adapterKey:i.adapterKey,workspaceRef:i.workspaceRef,profileId:i.profileId,
          command:i.command,args:i.adapterKey==='dsh'?['--profile','acp']:i.adapterKey==='codex'?['app-server']:i.adapterKey==='hermes'?['acp']:[]}))}
        writeFileSync(restore?join(stage,'connector-config.backed-up.json'):join(connectorTarget,'config.json'),JSON.stringify(safe,null,2),{mode:0o600})
      }
    }
    if(fromManifest?.connector&&!manifest.connector)throw Error('备份缺少连接器数据库')
    writeFileSync(join(stage,'backup.json'),JSON.stringify({...manifest,mode:restore?fromManifest?.mode??'legacy':manifest.mode},null,2),{mode:0o600})
    if(existsSync(dest))throw Error('目标目录必须尚未存在')
    renameSync(stage,dest)
  }catch(e){
    if(existsSync(stage)&&dirname(realpathSync(stage))===dirname(dest))rmSync(stage,{recursive:true,force:true})
    throw e
  }
  return {operation:restore?'restore':'backup',directory:dest,needsReview:manifest.activeRunIds.length,excludedConnectorCommands:manifest.excludedConnectorCommands}
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const [mode,src,dest,...args]=process.argv.slice(2),opts:Options={}
  const usage='用法：npm run backup -- save|restore 源目录 新目标目录 [--offline] [--without-access] [--connector 状态目录] [--connector-config 配置文件]'
  if(!['save','restore'].includes(mode)||!src||!dest)throw Error(usage)
  for(let i=0;i<args.length;i++){
    if(args[i]==='--offline')opts.offline=true
    else if(args[i]==='--without-access')opts.includeAccess=false
    else if(args[i]==='--connector'&&args[i+1])opts.connectorDir=args[++i]
    else if(args[i]==='--connector-config'&&args[i+1])opts.connectorConfig=args[++i]
    else throw Error(usage)
  }
  console.log(transfer(src,dest,mode==='restore',opts))
}
