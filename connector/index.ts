import {existsSync,mkdirSync,readFileSync,writeFileSync,realpathSync} from 'node:fs'
import {basename,isAbsolute,resolve,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {agentCommand,agentHome,agentHomeVariable,agentRuntimeKey,agentRuntimeScope} from '../contracts/agent-runtime.ts'
import WebSocket from 'ws'
import {registry} from './adapters/index.ts'
import {runKeyedSerializedOperation} from './keyed-serialized-operations.ts'
import {Store,type ReceiptStatus} from './store.ts'
import {grantFiles} from './grant-files.ts'
import type {Command,Instance,Adapter,Run,Input,Capabilities} from './types.ts'

const config=JSON.parse(readFileSync(process.argv[2]||'connector/config.example.json','utf8').replace(/^\uFEFF/,''))
const expectedScopes=new Map<string,string>(Object.entries(JSON.parse(process.env.MAOQIU_EXPECTED_AGENT_SCOPES||'{}')))
const token=process.env.NODE_TOKEN
if(!token) throw new Error('需要设置 NODE_TOKEN')
const url=new URL(process.env.MAOQIU_NODE_URL||config.url)
const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname)
if(!(url.protocol==='wss:' || url.protocol==='ws:' && loopback)) throw new Error('跨机连接需要 wss://')
const baseUrl=new URL('/api/v1/',url)
baseUrl.protocol=url.protocol==='wss:'?'https:':'http:'
const stateDir=resolve(config.stateDir)
mkdirSync(stateDir,{recursive:true,mode:0o700})
const store=new Store(join(stateDir,'connector.sqlite'))
type Entry={config:Instance,adapter?:Adapter,caps:Capabilities,runtimeScopeId?:string,error?:string,restart?:NodeJS.Timeout,
  generation:number,starting?:Promise<void>}
const instances=new Map<string,Entry>()
const running=new Map<string,{run:Run,adapter:Adapter}>()
const preparing=new Map<string,{command:Command,adapter:Adapter,cancelled:boolean,started:boolean}>()
const handling=new Set<string>()
const occupied=new Set<string>()
const workspaceTails=new Map<string,Promise<void>>()
const grantCleanups=new Set<()=>void>()
const credentials=grantFiles()
try{credentials.sweep()}catch{console.warn('连接器无法检查过期的临时凭据')}
let ws:WebSocket|undefined
let stopping=false
function send(frame:object) {
  if(ws?.readyState===WebSocket.OPEN) ws.send(JSON.stringify(frame))
}
function receipt(commandId:string,status:ReceiptStatus,detail='') {
  store.status(commandId,status,detail)
  send({type:'receipt',commandId,status,detail})
}
function emit(c:Command,kind:string,data:any) {
  const event=store.emit(c,kind,data)
  if(event) send({type:'event',event})
}
async function input(c:Command):Promise<Input> {
  const files:Input['files']=[]
  for(const a of c.payload.attachments??c.payload.attachmentIds??[]) {
    const id=typeof a==='string'?a:a.id
    const address=new URL('attachments/'+encodeURIComponent(id),baseUrl)
    address.searchParams.set('commandId',c.id)
    const res=await fetch(address,{headers:{Authorization:'Bearer '+token,'X-Node-Id':config.nodeId},redirect:'error',signal:AbortSignal.timeout(30000)})
    if(!res.ok) throw new Error('附件下载失败 '+res.status)
    const file:any=await res.json()
    if(file.id!==id || typeof file.data!=='string') throw new Error('附件响应 ID 或内容无效')
    const bytes=Buffer.from(file.data,'base64')
    if(bytes.length!==file.size) throw new Error('附件大小不一致')
    const dir=join(stateDir,'attachments',createHash('sha256').update(id).digest('hex'))
    mkdirSync(dir,{recursive:true,mode:0o700})
    const name=basename(String(file.name)).replace(/[^\p{L}\p{N}_. -]/gu,'_').slice(0,120)||'file'
    const path=join(dir,'item-'+name)
    writeFileSync(path,bytes,{mode:0o600})
    files.push({id,name,path,mime:file.contentType||'application/octet-stream'})
  }
  const communication=c.payload.communication
  const prefix=communication?'工作台通信 '+JSON.stringify({
    from:communication.sender,to:communication.recipient,type:communication.type,taskId:c.taskId,runId:c.runId,
    projectId:c.projectId??null,replyTo:communication.replyTo,sourceMessageId:communication.sourceMessageId,
    userOriginal:communication.sender.kind==='user'&&communication.type==='user_message'
  })+'\n\n':''
  return {text:prefix+String(c.payload.text??''),files}
}
const helper=fileURLToPath(new URL('../scripts/project-api.ts',import.meta.url))
function grant(c:Command,i:Input) {
  const access=c.payload.homeAccess
  const communication=c.payload.communicationAccess
  if(!access&&!communication) return ()=>{}
  const files=credentials.create()
  const dir=files.dir
  const path=join(dir,'project.json'),report=join(dir,'communication.json')
  const cleanup=()=>{
    grantCleanups.delete(cleanup)
    try{files.dispose()}catch{console.warn('连接器无法清理临时凭据，将在重启后重新检查')}
  }
  try {
    grantCleanups.add(cleanup)
    const credentials={baseUrl:baseUrl.href.replace(/\/$/,'')}
    if(access){
      files.write('project.json',{...credentials,token:access.token,projectId:access.projectId})
      const permission=access.permission??'read'
      i.text+='\n\n本次运行拥有项目 '+access.projectId+' 的资料权限（'+permission+'）。读取简报：node "'+helper+'" "'+path+'" GET /projects/'+encodeURIComponent(access.projectId)+'/brief 。请勿读取或输出凭据文件内容。'
    }
    if(communication)files.write('communication.json',{...credentials,token:communication.token})
    if(c.taskId)i.text+='\n向小毛球报告：node "'+helper+'" "'+(communication?report:path)+'" POST /runs/'+encodeURIComponent(c.runId)+
      '/communication <JSON> ，提交 kind（question、progress、blocked、handoff、delivery 或 request）、text 和唯一 requestId。报告保留 Bot 身份，不代表用户已验收。需要等待答复时先结束或挂起当前推理，之后续接原生会话。'
  } catch(e){cleanup();throw e}
  return cleanup
}
async function handle(c:Command) {
  if(!c.id || !c.instanceId || !c.runId || !c.threadId || !c.payload) throw new Error('节点命令缺少标识')
  let prior
  try{prior=store.command(c)}catch(e:any){
    const detail=String(e.message||e).slice(0,1000)
    if(e.code==='COMMAND_CONFLICT')send({type:'command_conflict',commandId:c.id,detail})
    else send({type:'receipt',commandId:c.id,status:'failed',detail:'连接器未能持久化原生命令'})
    return
  }
  if(prior) {send({type:'receipt',commandId:c.id,status:prior.status,detail:prior.detail});return}
  handling.add(c.id)
  const inst=instances.get(c.instanceId)
  let started=false
  let locked=false
  let cleanup=()=>{}
  try {
    receipt(c.id,'received')
    if(!inst?.adapter || !inst.caps.availableActions.includes(c.kind)) throw new Error('实例离线或不支持该操作')
    if(c.workspaceRef!==inst.config.workspaceRef || c.profileId!==inst.config.profileId) throw new Error('命令的工作区或 profile 与节点不一致')
    const adapter=inst.adapter
    if(c.kind==='run'||c.kind==='prepare') {
      if(preparing.has(c.runId)||running.has(c.runId))throw Error('运行已经排队或已启动')
      const pending={command:c,adapter,cancelled:false,started:false}
      preparing.set(c.runId,pending)
      const path=inst.config.workspaceRef
      const key=process.platform==='win32'?path.toLowerCase():path
      await runKeyedSerializedOperation(workspaceTails,key,async()=>{
        if(pending.cancelled)return
        if(stopping||inst.adapter!==adapter)throw Error('原生进程已断开，指令尚未发送')
        if(occupied.has(c.threadId)) throw new Error('话题正在处理上一轮输入')
        occupied.add(c.threadId);locked=true
        const runtimeKey=await checkedRuntime(inst,adapter)
        if(pending.cancelled)return
        const bound=store.binding(c,inst.config.workspaceRef,runtimeKey)
        if(c.payload.sessionId && c.payload.sessionId!==bound) throw new Error('请求不属于本节点绑定的会话')
        const incoming=c.kind==='prepare'?c.payload.importSessionId:undefined
        const op=c.kind==='prepare'?c.payload.nativeOperation:undefined
        if(op?.action==='release'){
          const busy=[...running.values()].some(value=>value.run.sessionId===op.sourceSessionId)||
            [...preparing.values()].some(value=>value.command.threadId===op.sourceThreadId&&value.command.id!==c.id)
          if(!inst.caps.sessionList||op.sourceThreadId!==c.threadId||bound!==op.sourceSessionId||busy)
            throw Error('原生绑定的会话、范围或运行状态已变化')
          const event=store.release(c,inst.config.workspaceRef,runtimeKey,op.sourceSessionId)
          send({type:'event',event})
          receipt(c.id,'done')
          return
        }
        if(op){
          if(!adapter.sessionAction||!inst.caps.nativeActions?.includes(op.action)||
            store.binding({...c,threadId:op.sourceThreadId},inst.config.workspaceRef,runtimeKey)!==op.sourceSessionId||
            (op.action==='fork'?bound||op.sourceThreadId===c.threadId:bound!==op.sourceSessionId))throw Error('原生操作能力或来源绑定不匹配')
          started=true
          pending.started=true
          store.submit(c.id)
          emit(c,'accepted',{sessionId:op.sourceSessionId})
          const sessionId=await adapter.sessionAction(op.action,op.sourceSessionId)
          if(op.action==='fork')store.bind(c,inst.config.workspaceRef,sessionId,runtimeKey)
          emit(c,'completed',{sessionId,nativeAction:op.action})
          receipt(c.id,'done')
          return
        }
        if(incoming&&(bound&&bound!==incoming||!inst.caps.sessionImport||!adapter.importSession))throw Error('当前绑定或原生协议无法导入此会话')
        pending.started=true
        store.submit(c.id)
        if(c.kind==='prepare')emit(c,'accepted',{})
        const sessionId=incoming&&!bound?await adapter.importSession!(incoming):await adapter.open(bound)
        if(stopping||inst.adapter!==adapter)throw Error('原生进程已断开，指令尚未发送')
        store.bind(c,inst.config.workspaceRef,sessionId,runtimeKey)
        if(pending.cancelled)return
        const run:Run={command:c,sessionId,emit:(kind,data)=>emit(c,kind,data)}
        if(c.kind==='prepare'){
          run.emit('model_state',{sessionId,...adapter.describeModels?.(sessionId)})
          run.emit('completed',{sessionId})
        }else{
          const material=await input(c)
          if(pending.cancelled)return
          if(stopping||inst.adapter!==adapter) throw Error('原生进程已断开，输入尚未发送')
          if(inst.config.codexProviderMode==='native')await checkedRuntime(inst,adapter)
          if(pending.cancelled)return
          cleanup=grant(c,material)
          running.set(c.runId,{run,adapter})
          preparing.delete(c.runId)
          store.submit(c.id)
          started=true
          await adapter.run(run,material)
        }
      })
    } else {
      const pending=preparing.get(c.runId)
      if(c.kind==='cancel'&&pending?.adapter===adapter&&pending.command.threadId===c.threadId&&
        pending.command.instanceId===c.instanceId&&pending.command.projectId===c.projectId){
        if(pending.started)throw Error('原生准备操作已开始，无法安全撤销，请等待回执或核对节点状态')
        pending.cancelled=true
        emit(pending.command,'cancelled',{text:'排队中的原生操作已取消，尚未调用原生端'})
        receipt(pending.command.id,'done')
        receipt(c.id,'done')
        return
      }
      const target=running.get(c.runId),run=target?.run
      if(!run || target.adapter!==adapter || run.command.threadId!==c.threadId || run.command.instanceId!==c.instanceId ||
        (c.payload.sessionId!==run.sessionId && !(c.kind==='cancel'&&!c.payload.sessionId)) || c.projectId!==run.command.projectId ||
        (c.payload.nativeRunId && c.payload.nativeRunId!==run.nativeRunId)) throw new Error('该运行不再接收控制命令')
      const material=c.kind==='steer'?await input(c):undefined
      if(inst.adapter!==adapter || running.get(c.runId)!==target) throw Error('原运行已结束或已断开')
      store.submit(c.id)
      started=true
      switch(c.kind) {
        case 'steer': await adapter.steer!(run,material!); break
        case 'cancel': await adapter.cancel(run); break
        case 'answer': await adapter.answer(run,String(c.payload.requestId),String(c.payload.choice)); break
        default: throw new Error('未知命令')
      }
    }
    const result=store.saved(c.id)
    receipt(c.id,result?.status==='failed'?'failed':'done',result?.detail||'')
  } catch(e:any) {
    const result=store.saved(c.id)
    if(result?.status==='done'||result?.status==='failed'){
      receipt(c.id,result.status,result.detail||'')
      return
    }
    const detail=String(e.message||e).slice(0,1200)
    const uncertain=started && !Number.isInteger(e.code)
    if((c.kind==='run'||c.kind==='prepare') && !uncertain) emit(c,'failed',{text:detail})
    receipt(c.id,uncertain?'uncertain':'failed',detail)
  } finally {
    handling.delete(c.id)
    if(preparing.get(c.runId)?.command===c)preparing.delete(c.runId)
    if(locked) {running.delete(c.runId);occupied.delete(c.threadId)}
    cleanup()
  }
}
async function runtimeIdentity(inst:{config:Instance,adapter?:Adapter}) {
  const account=await inst.adapter?.identity?.()
  const runtimeKey=inst.config.runtimeKey??''
  return account?JSON.stringify([runtimeKey,account]):runtimeKey
}
async function checkedRuntime(entry:Entry,adapter:Adapter,expected=entry.runtimeScopeId){
  const runtime=await runtimeIdentity({config:entry.config,adapter})
  if(stopping||entry.adapter!==adapter)throw Error('原生进程已断开，指令尚未发送')
  if(expected&&agentRuntimeScope(runtime)!==expected)throw Error('原生账号、供应商或 profile 已变化。请恢复原配置或使用新实例 ID')
  return runtime
}
async function recover(inst:Entry) {
  for(const row of store.pending(inst.config.id)) {
    if(handling.has(row.id))continue
    const c:Command=JSON.parse(row.body)
    if(row.submitted===0){
      const detail=c.kind==='prepare'?'连接中断，请重新读取会话模型':'原生进程中断，指令尚未发送'
      if(c.kind==='run'||c.kind==='prepare')emit(c,'failed',{text:detail})
      store.status(c.id,'failed',detail)
      continue
    }
    let verified=false
    try {
      const adapter=inst.adapter
      if(c.kind==='run' && adapter?.inspect){
        const sessionId=store.binding(c,inst.config.workspaceRef,await runtimeIdentity(inst))
        const saved=store.db.prepare('SELECT native FROM runs WHERE id=?').get(c.runId)
        if(sessionId && typeof saved?.native==='string')
          verified=await adapter.inspect({command:c,sessionId,nativeRunId:saved.native,emit:(kind,data)=>emit(c,kind,data)})
      }
    } catch {}
    if(!verified) store.status(c.id,'uncertain','原生进程中断，送达待核对')
  }
}
const offline=():Capabilities=>({availableActions:[],history:false,resume:false})
function retry(entry:Entry) {
  if(stopping||entry.restart)return
  entry.restart=setTimeout(()=>{
    entry.restart=undefined
    void startAdapter(entry,true)
  },2000)
}
async function startAdapter(entry:Entry,restarting=false) {
  if(stopping)return
  if(entry.starting)return entry.starting
  const generation=entry.generation+1
  entry.generation=generation
  const starting=startAdapterOnce(entry,restarting,generation)
  entry.starting=starting
  try{await starting}
  finally{if(entry.starting===starting)entry.starting=undefined}
}
async function startAdapterOnce(entry:Entry,restarting:boolean,generation:number) {
  if(stopping)return
  const instance=entry.config
  let adapter:Adapter|undefined
  let ready=false
  try {
    const registration=registry.get(instance.adapterKey)
    if(!registration)throw Error('未注册原生连接器：'+instance.adapterKey)
    if(registration.localOnly&&!loopback)throw Error('该原生账号只支持同机运行')
    if(isAbsolute(instance.command)&&!existsSync(instance.command))throw Error('找不到配置的 Agent 可执行程序')
    instance.workspaceRef=realpathSync(instance.workspaceRef)
    const key=agentHomeVariable(instance.adapterKey)!
    const home=agentHome(instance.adapterKey,instance.env)!
    instance.env={...instance.env,[key]:home}
    instance.runtimeKey=agentRuntimeKey(instance.profileId??'default',home,instance.command,instance.args)
    adapter=new registration.create(instance)
    entry.adapter=adapter
    adapter.onDisconnect(error=>{
      if(entry.generation!==generation||entry.adapter!==adapter)return
      entry.error=error.message
      entry.caps=offline()
      entry.adapter=undefined
      if(ready&&!stopping)ws?.terminate()
      if(ready||restarting)retry(entry)
    })
    const caps=await adapter.probe()
    entry.runtimeScopeId=agentRuntimeScope(await checkedRuntime(entry,adapter,expectedScopes.get(instance.id)??entry.runtimeScopeId))
    await recover(entry)
    if(stopping||entry.generation!==generation)return
    if(entry.adapter!==adapter)throw Error(entry.error??'原生进程已断开')
    entry.caps=caps
    entry.error=undefined
    ready=true
    if(restarting)ws?.terminate()
  } catch(e:any) {
    if(stopping||entry.generation!==generation){adapter?.close();return}
    entry.adapter=undefined
    entry.error=String(e.message)
    adapter?.close()
    await recover(entry)
    if(restarting)retry(entry)
  }
}
for(const instance of config.instances as Instance[]) {
  if(instances.has(instance.id)) throw new Error('实例 ID 重复')
  instance.workspaceRef=resolve(instance.workspaceRef)
  instance.profileId=instance.profileId??'default'
  instance.command=agentCommand(instance.adapterKey,instance.command)
  instances.set(instance.id,{config:instance,caps:offline(),generation:0})
}
function connect(){
  if(stopping) return
  ws=new WebSocket(url,{headers:{Authorization:'Bearer '+token,'X-Node-Id':config.nodeId},maxPayload:4*1024*1024,handshakeTimeout:15000})
  ws.on('open',async()=>{
    const socket=ws
    const registrations=[...instances.values()].map(entry=>{
      const {config:i,caps,error,adapter}=entry
      const runtimeScopeId=adapter&&entry.runtimeScopeId
      return {id:i.id,name:i.name,workspaceRef:i.workspaceRef,profileId:i.profileId,adapterKey:i.adapterKey,
        ...(runtimeScopeId?{runtimeScopeId}:{}),...caps,nativeBindingRelease:caps.sessionList===true,
        usage:typeof entry.adapter?.readUsage==='function'&&caps.usage!==false,error,online:!error}
    })
    if(ws!==socket||socket?.readyState!==WebSocket.OPEN)return
    send({type:'hello',nodeId:config.nodeId,receiptLookup:true,cancelBeforeStart:true,instances:registrations})
    for(const row of store.db.prepare('SELECT event FROM outbox ORDER BY rowid').iterate()) send({type:'event',event:JSON.parse(String(row.event))})
    for(const row of store.db.prepare('SELECT c.id,c.status,c.detail FROM commands c LEFT JOIN receipt_acks a ON c.id=a.id WHERE c.status IS NOT a.status ORDER BY c.rowid').iterate()) send({type:'receipt',commandId:row.id,status:row.status,detail:row.detail})
  })
  ws.on('message',async bytes=>{
    try{
      const frame=JSON.parse(bytes.toString())
      if(frame.type==='command') await handle(frame.command)
      else if(frame.type==='read_history'&&typeof frame.id==='string'){
        const entry=instances.get(frame.instanceId),socket=ws
        try{
          const adapter=entry?.adapter
          if(!entry?.caps.nativeHistory||!adapter?.readHistory||entry.config.workspaceRef!==frame.workspaceRef||
            entry.config.profileId!==frame.profileId||!frame.sessionId)throw Error('原生历史绑定不匹配')
          const runtime=await checkedRuntime(entry,adapter,frame.runtimeScopeId||undefined)
          if(store.binding(frame,entry.config.workspaceRef,runtime)!==frame.sessionId)throw Error('原生历史绑定不匹配')
          const page=await adapter.readHistory(frame.sessionId,frame.before)
          if(ws===socket)send({type:'history',id:frame.id,...page})
        }catch{if(ws===socket)send({type:'history',id:frame.id,error:true})}
      }
      else if(frame.type==='list_sessions'&&typeof frame.id==='string'){
        const entry=instances.get(frame.instanceId),adapter=entry?.adapter
        if(!entry?.caps.sessionList||!adapter?.listSessions||entry.config.workspaceRef!==frame.workspaceRef||entry.config.profileId!==frame.profileId){
          send({type:'sessions',id:frame.id,error:true});return
        }
        const socket=ws
        try{
          await checkedRuntime(entry,adapter,frame.runtimeScopeId||undefined)
          const result=await adapter.listSessions(frame.cursor)
          if(ws===socket)send({type:'sessions',id:frame.id,...result})
        }catch{if(ws===socket)send({type:'sessions',id:frame.id,error:true})}
      }
      else if(frame.type==='read_usage'&&typeof frame.id==='string'){
        const entry=instances.get(frame.instanceId),adapter=entry?.adapter,socket=ws
        try{
          if(!entry||!adapter?.readUsage||entry.config.workspaceRef!==frame.workspaceRef||entry.config.profileId!==frame.profileId)
            throw Error('原生额度范围不匹配')
          if(!frame.runtimeScopeId)throw Error('缺少原生额度账号范围')
          await checkedRuntime(entry,adapter,frame.runtimeScopeId)
          const items=await adapter.readUsage()
          if(ws===socket)send({type:'usage',id:frame.id,items})
        }catch{if(ws===socket)send({type:'usage',id:frame.id,error:true})}
      }
      else if(frame.type==='inspect_command'&&typeof frame.commandId==='string'){
        let saved=store.saved(frame.commandId)
        if(!saved){send({type:'receipt_missing',commandId:frame.commandId});return}
        const command:Command=JSON.parse(saved.body)
        const entry=instances.get(command.instanceId)
        if(saved.status==='uncertain'&&entry?.adapter&&!handling.has(command.id)){
          await recover(entry)
          saved=store.saved(command.id)!
        }
        for(const row of store.db.prepare("SELECT event FROM outbox WHERE json_extract(event,'$.commandId')=? ORDER BY rowid").all(command.id))
          send({type:'event',event:JSON.parse(String(row.event))})
        send({type:'receipt',commandId:command.id,status:saved.status,detail:saved.detail})
      }
      else if(frame.type==='ack' && typeof frame.key==='string') store.db.prepare('DELETE FROM outbox WHERE key=?').run(frame.key)
      else if(frame.type==='receipt_ack' && typeof frame.commandId==='string' && typeof frame.status==='string')
        store.db.prepare('INSERT OR REPLACE INTO receipt_acks SELECT id,status FROM commands WHERE id=? AND status=?').run(frame.commandId,frame.status)
    }catch(e){console.error('节点帧处理失败',String(e))}
  })
  ws.on('error',e=>console.error('节点连接错误',e.message))
  ws.once('close',()=>{if(!stopping)setTimeout(connect,2000)})
}
function stop(){
  stopping=true
  ws?.close()
  for(const cleanup of grantCleanups)try{cleanup()}catch{}
  for(const entry of instances.values()){
    clearTimeout(entry.restart)
    entry.adapter?.close()
  }
}
process.once('SIGINT',stop)
process.once('SIGTERM',stop)
if(process.send)process.once('disconnect',stop)
await Promise.all([...instances.values()].map(entry=>startAdapter(entry)))
connect()
