import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { transaction, changed, now, required, one, must, fail } from '../db/index.ts'
import { applyEvent, addProjectContext, assertNativeBindingScope, checkQueuedInput, markUncertain, nativeBindingInScope, nativeSessionBinding, nativeSessionReleaseScope, nativeSessionCatalogTarget } from '../tasks/index.ts'
import type { NativeSession, NativeHistory, NativeUsage, NodeCommand } from '../../contracts/node.ts'
import { secret,hash } from './auth.ts'
import { isLocal } from './local.ts'

type LocalRegistration={id:string;online:boolean;runtimeScopeId:string|null;error?:string}
function localHandshakeError(error:unknown){
  if(typeof error==='string'&&error.startsWith('原生账号、供应商或 profile 已变化'))
    return '原生账号、供应商或 profile 已变化。请核对配置与历史绑定。'
  if(typeof error==='string'&&error.includes('等待原生响应超时'))return '原生握手超时。'
  if(error==='找不到配置的 Agent 可执行程序')return error
  return '原生 Agent 未完成握手。请检查启动器、配置目录和登录状态。'
}

export function attachNodes(server:Server,db:DatabaseSync,authenticate:(token:string)=>string|undefined,dataDir:string,
  worktreeSource?:(instance:{id:string;workspaceRef:string;adapterKey:string})=>string|undefined){
  const wss=new WebSocketServer({noServer:true,maxPayload:4*1024*1024})
  const online=new Map<string,{ws:WebSocket,sent:Set<string>,lookups:Map<string,number>,missing:Set<string>,receiptLookup:boolean,cancelBeforeStart:boolean,scopedCommands:boolean,alive:boolean,instances:Set<string>}>()
  const catalogs=new Map<string,{ws:WebSocket; type:string; respond:(frame:any)=>void}>()
  let localDispatchPaused=false
  let expectedLocalGeneration:string|null|undefined
  let localRegistration:{generation:string,ws:WebSocket,instances:LocalRegistration[],error?:string}|undefined
  server.on('upgrade',(req,socket,head)=>{
    const nodeId=authenticate((req.headers.authorization??'').replace(/^Bearer /,''))
    if(!nodeId || nodeId==='@model-api' || req.url?.split('?')[0]!=='/api/v1/node'){socket.destroy();return}
    const header=req.headers['x-maoqiu-connector-generation']
    const generation=nodeId==='local'&&isLocal(req)&&typeof header==='string'&&/^[0-9a-f-]{36}$/i.test(header)?header:undefined
    if(nodeId==='local'&&expectedLocalGeneration!==undefined&&generation!==expectedLocalGeneration){socket.destroy();return}
    wss.handleUpgrade(req,socket,head,ws=>{
      let registered=false
      const helloTimeout=setTimeout(()=>{if(!registered) ws.terminate()},10000)
      ws.on('error',()=>ws.terminate())
      ws.on('pong',()=>{const link=online.get(nodeId);if(link?.ws===ws){link.alive=true;db.prepare('UPDATE instances SET lastSeen=? WHERE nodeId=? AND online=1').run(now(),nodeId)}})
      ws.on('close',()=>{
        clearTimeout(helloTimeout)
        if(online.get(nodeId)?.ws!==ws)return
        online.delete(nodeId)
        transaction(db,()=>{db.prepare('UPDATE instances SET online=0 WHERE nodeId=?').run(nodeId);changed(db,'presence',{nodeId,online:false})})
      })
      ws.on('message',raw=>{
        try {
          const m=JSON.parse(raw.toString())
          if(nodeId==='local'&&expectedLocalGeneration!==undefined&&generation!==expectedLocalGeneration){ws.terminate();return}
          if(!registered){
            if(m.type!=='hello'||(m.nodeId && m.nodeId!==nodeId)||!Array.isArray(m.instances)) fail('节点握手失败')
            transaction(db,()=>{
              db.prepare('UPDATE instances SET online=0 WHERE nodeId=?').run(nodeId)
              for(const i of m.instances){
                const key=required(i.id,'instanceId'),old=one(db,'SELECT * FROM instances WHERE id=?',key)
                const profileId=required(i.profileId??'default','profileId')
                const runtimeScopeId=i.runtimeScopeId==null?null:required(i.runtimeScopeId,'runtimeScopeId')
                if(runtimeScopeId&&!/^[a-f0-9]{64}$/.test(runtimeScopeId))fail('原生运行范围标识无效')
                if(key==='main'||i.adapterKey==='model-api'|| (old && (old.nodeId!==nodeId || old.workspaceRef!==i.workspaceRef || old.adapterKey!==i.adapterKey || old.profileId!==profileId ||
                  old.runtimeScopeId&&runtimeScopeId&&old.runtimeScopeId!==runtimeScopeId))) fail('实例绑定冲突，请用新实例 ID')
                if(!Array.isArray(i.availableActions)) fail('缺少实例能力')
                const blocked=i.adapterKey==='codex'&&!isLocal(req)
                const unverified=i.adapterKey==='codex'&&(!runtimeScopeId||m.scopedCommands!==true)
                const caps={version:i.version,resume:i.resume,history:i.history,sessionList:i.sessionList===true,nativeHistory:i.nativeHistory===true,
                  sessionImport:i.sessionList===true&&i.sessionImport!==false,nativeBindingRelease:i.nativeBindingRelease===true,
                  usage:i.adapterKey==='codex'&&i.usage===true,
                  nativeActions:['fork','archive','unarchive','delete'].filter(action=>Array.isArray(i.nativeActions)&&i.nativeActions.includes(action)),
                  error:blocked?'个人 Codex 登录限本机':i.error||(unverified?'Codex 原生账号和供应商尚未核对':undefined),models:Array.isArray(i.models)?i.models.slice(0,200):[]}
                db.prepare(`INSERT INTO instances(id,nodeId,name,adapterKey,workspaceRef,availableActions,lastSeen,online,capabilities,profileId,runtimeScopeId)
                  VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,availableActions=excluded.availableActions,
                  lastSeen=excluded.lastSeen,online=excluded.online,capabilities=excluded.capabilities,
                  runtimeScopeId=COALESCE(excluded.runtimeScopeId,instances.runtimeScopeId)`)
                  .run(key,nodeId,required(i.name,'name'),required(i.adapterKey,'adapterKey'),required(i.workspaceRef,'workspaceRef'),
                    JSON.stringify(i.availableActions),now(),blocked||unverified||i.online===false?0:1,JSON.stringify(caps),profileId,runtimeScopeId)
                const source=!old&&nodeId==='local'&&isLocal(req)?worktreeSource?.(i):undefined
                if(source)db.prepare(`INSERT INTO bot_settings(instanceId,description,enabled,allowDirect,allowDelegate,allowedProjects,updatedAt)
                  SELECT ?,description,enabled,allowDirect,allowDelegate,allowedProjects,? FROM bot_settings WHERE instanceId=?`)
                  .run(key,now(),source)
              }
              changed(db,'presence',{nodeId,online:true})
            })
            registered=true
            const previous=online.get(nodeId)
            const ids=db.prepare('SELECT id FROM instances WHERE nodeId=? AND online=1').all(nodeId).map(r=>String(r.id))
            if(generation){
              const onlineIds=new Set(ids)
              const instances:LocalRegistration[]=m.instances.map((i:any)=>{
                const online=onlineIds.has(i.id)&&i.online===true&&typeof i.runtimeScopeId==='string'&&
                  i.availableActions.includes('run')&&!i.error
                return {id:i.id,online,runtimeScopeId:i.runtimeScopeId??null,...(!online?{error:localHandshakeError(i.error)}:{})}
              })
              localRegistration={generation,ws,instances}
            }
            online.set(nodeId,{ws,sent:new Set(),lookups:new Map(),missing:new Set(),receiptLookup:m.receiptLookup===true,cancelBeforeStart:m.cancelBeforeStart===true,scopedCommands:m.scopedCommands===true,alive:true,instances:new Set(ids)})
            previous?.ws.terminate()
            if(m.nativeBindingProofs===true&&isLocal(req)){
              const unknown=db.prepare(`SELECT t.id AS thread,t.instanceId AS instance,t.sessionId AS session,i.workspaceRef AS workspace
                FROM threads t JOIN instances i ON i.id=t.instanceId WHERE i.nodeId=? AND i.adapterKey='codex'
                AND t.kind='native' AND t.sessionId IS NOT NULL AND t.nativeReleased=0 AND t.nativeRuntimeScopeId IS NULL`).all(nodeId)
              for(let offset=0;offset<unknown.length;offset+=200)
                ws.send(JSON.stringify({type:'verify_native_bindings',bindings:unknown.slice(offset,offset+200)}))
            }
            flush()
            return
          }
          if(online.get(nodeId)?.ws!==ws)return
          if(m.type==='native_binding_proofs'){
            if(!isLocal(req)||!Array.isArray(m.bindings)||m.bindings.length>200)fail('原生绑定核对无效')
            transaction(db,()=>{
              const verify=db.prepare(`UPDATE threads SET nativeRuntimeScopeId=? WHERE id=? AND instanceId=? AND sessionId=?
                AND kind='native' AND nativeReleased=0 AND nativeRuntimeScopeId IS NULL AND EXISTS(SELECT 1 FROM instances i
                  WHERE i.id=threads.instanceId AND i.nodeId=? AND i.adapterKey='codex' AND i.workspaceRef=?)`)
              for(const proof of m.bindings){
                if(!proof||typeof proof.scope!=='string'||!/^[a-f0-9]{64}$/.test(proof.scope))fail('原生绑定核对无效')
                const threadId=required(proof.thread,'threadId'),instanceId=required(proof.instance,'instanceId')
                const result=verify.run(proof.scope,threadId,instanceId,required(proof.session,'sessionId'),nodeId,required(proof.workspace,'workspaceRef'))
                if(result.changes)changed(db,'thread',{threadId,instanceId})
              }
            })
          }else if(m.type==='event'){
            transaction(db,()=>applyEvent(db,nodeId,m.event))
            ws.send(JSON.stringify({type:'ack',key:m.event.key}))
          }else if(m.type==='sessions'||m.type==='history'||m.type==='usage'){
            const request=catalogs.get(m.id)
            if(request?.ws===ws&&request.type===m.type)request.respond(m)
          }else if(m.type==='receipt_missing'){
            const link=online.get(nodeId)!
            if(link.lookups.delete(m.commandId))link.missing.add(m.commandId)
          }else if(m.type==='command_conflict'){
            const detail=String(m.detail??'节点检测到同一命令 ID 的内容冲突').slice(0,1200)
            transaction(db,()=>{
              const c=must(db,'SELECT c.* FROM commands c JOIN instances i ON c.instanceId=i.id WHERE c.id=? AND i.nodeId=?',m.commandId,nodeId)
              if(['done','failed','withdrawn'].includes(c.status))return
              db.prepare("UPDATE commands SET status='uncertain',detail=? WHERE id=?").run(detail,c.id)
              if(['run','prepare'].includes(c.kind))markUncertain(db,c,'连接器检测到命令内容冲突，原生操作待核对')
              changed(db,'receipt',{threadId:c.threadId,instanceId:c.instanceId,runId:c.runId,commandId:c.id,status:'uncertain'})
            })
            ws.send(JSON.stringify({type:'receipt_ack',commandId:m.commandId,status:'uncertain'}))
          }else if(m.type==='receipt'){
            const link=online.get(nodeId)!
            if(link.lookups.delete(m.commandId))link.sent.add(m.commandId)
            transaction(db,()=>{
              const c=must(db,'SELECT c.* FROM commands c JOIN instances i ON c.instanceId=i.id WHERE c.id=? AND i.nodeId=?',m.commandId,nodeId)
              if(!['received','done','uncertain','failed'].includes(m.status))fail('无效回执')
              if(['done','failed','withdrawn'].includes(c.status)||m.status===c.status||c.status==='uncertain'&&m.status==='received')return
              db.prepare('UPDATE commands SET status=?,detail=? WHERE id=?').run(m.status,m.detail?String(m.detail):null,c.id)
              if(['run','prepare'].includes(c.kind) && m.status==='uncertain')markUncertain(db,c,m.detail?'原生运行待核对：'+String(m.detail).slice(0,1200):'原生运行待核对')
              if(m.status==='done' && c.kind==='answer') {
                db.prepare("UPDATE runs SET status=CASE WHEN status='waiting_input' THEN 'running' ELSE status END,pendingRequest=NULL WHERE id=? AND status IN ('waiting_input','cancelling') AND json_extract(pendingRequest,'$.requestId')=?").run(c.runId,JSON.parse(c.payload).requestId)
                db.prepare("UPDATE tasks SET status='running' WHERE id=? AND status='waiting_input' AND EXISTS(SELECT 1 FROM runs WHERE id=? AND status='running')").run(c.taskId,c.runId)
              }
              if(m.status==='failed' && c.kind==='cancel'){
                const before=JSON.parse(c.payload).priorStatus
                const prior=['queued','uncertain'].includes(before)?before:'running'
                const run=db.prepare("UPDATE runs SET status=CASE WHEN pendingRequest IS NOT NULL THEN 'waiting_input' ELSE ? END WHERE id=? AND status='cancelling' RETURNING status").get(prior,c.runId)
                if(run)db.prepare('UPDATE tasks SET status=? WHERE id=?').run(run.status,c.taskId)
              }
              changed(db,'receipt',{threadId:c.threadId,runId:c.runId,commandId:c.id,status:m.status})
            })
            ws.send(JSON.stringify({type:'receipt_ack',commandId:m.commandId,status:m.status}))
          }else fail('未知节点消息')
          flush()
        }catch(err){
          if(!registered&&generation)localRegistration={generation,ws,instances:[],error:'工作台拒绝了本次实例登记。请核对实例 ID、工作区、profile 和绑定范围。'}
          console.error('节点协议',nodeId,(err as Error).message)
          ws.close(1008,'invalid message')
        }
      })
    })
  })
  const timer=setInterval(()=>{
    db.prepare('DELETE FROM run_grants WHERE expiresAt<=?').run(now())
    db.prepare(`DELETE FROM communication_grants WHERE expiresAt<=? OR runId IN
      (SELECT id FROM runs WHERE status NOT IN ('queued','running','waiting_input','cancelling'))`).run(now())
    db.prepare('DELETE FROM grants WHERE expiresAt<=?').run(now())
    for(const c of online.values()){if(!c.alive)c.ws.terminate();else{c.alive=false;c.ws.ping()}}
  },30000)
  timer.unref()
  function reject(c:any,detail:string){
    const uncertain=c.status!=='queued'
    db.prepare("UPDATE commands SET status=?,detail=? WHERE id=?").run(uncertain?'uncertain':'failed',detail,c.id)
    if(uncertain && ['run','prepare','steer'].includes(c.kind))markUncertain(db,c,detail)
    else if(!uncertain&&['run','prepare'].includes(c.kind)){
      db.prepare("UPDATE runs SET status='blocked',pendingRequest=NULL WHERE id=?").run(c.runId)
      db.prepare("UPDATE tasks SET status='blocked' WHERE id=?").run(c.taskId)
      db.prepare("UPDATE commands SET status='held' WHERE runId=? AND status='waiting'").run(c.runId)
      db.prepare('DELETE FROM run_grants WHERE runId=?').run(c.runId)
    }
    changed(db,'receipt',{threadId:c.threadId,runId:c.runId,commandId:c.id,status:uncertain?'uncertain':'failed'})
  }
  function freeze(c:any,scopedCommands:boolean):NodeCommand{
    const {dispatch:previous,attachmentIds,modelId,requestId,choice,text,inputText,communication,importSessionId,...rest}=JSON.parse(c.payload)
    const input=['run','steer','prepare'].includes(c.kind)
    const projectRun=c.kind==='run'&&c.projectId
    const binding=projectRun?one(db,'SELECT agentPermission FROM project_workspaces WHERE projectId=? AND instanceId=? AND allowAgentAccess=1',c.projectId,c.instanceId)?.agentPermission??null:null
    if(input)checkQueuedInput(db,dataDir,c,{...rest,attachmentIds,communication,importSessionId})
    if(c.status!=='queued'&&!previous)fail('旧版本发送记录缺少冻结材料，需人工核对',409)
    if(c.adapterKey==='codex'&&(!c.runtimeScopeId||previous&&!previous.runtimeScopeId)||
      previous?.runtimeScopeId&&(!scopedCommands||previous.runtimeScopeId!==c.runtimeScopeId))
      fail('命令的原生账号或供应商范围无法核对，停止发送',409)
    if(previous&&['run','prepare'].includes(c.kind)&&
      (c.runStatus!=='queued'||c.nativeRunId||c.sessionId!==previous.sessionId))
      fail('工作台已有原生会话或运行回执，停止重发并核对节点记录',409)
    if(previous && previous.binding!==binding)fail('实例资料授权已变化，停止重发',409)
    const fullText=binding?addProjectContext(db,c,text??'',!previous):text
    if(previous && previous.text!==fullText)fail('已发送的项目上下文发生变化，停止重发',409)
    const dispatch=previous??{sessionId:c.sessionId,nativeRunId:c.nativeRunId,text:fullText,binding,
      ...(scopedCommands&&c.runtimeScopeId?{runtimeScopeId:c.runtimeScopeId}:{})}
    let grant=binding&&one(db,'SELECT token,projectId,permission FROM run_grants WHERE runId=? AND expiresAt>? AND permission=?',c.runId,now(),binding)
    if(binding&&!grant){
      if(previous)fail('原运行令牌已过期或撤销，停止重发',409)
      const token=secret(),expiresAt=new Date(Date.now()+24*3600000).toISOString()
      db.prepare('INSERT INTO run_grants(runId,tokenHash,token,projectId,instanceId,expiresAt,permission) VALUES(?,?,?,?,?,?,?)')
        .run(c.runId,hash(token),token,c.projectId,c.instanceId,expiresAt,binding)
      grant={token,projectId:c.projectId,permission:binding}
    }
    let communicationAccess=c.kind==='run'&&c.taskId&&one(db,'SELECT token FROM communication_grants WHERE runId=? AND expiresAt>?',c.runId,now())
    if(!communicationAccess&&c.kind==='run'&&c.taskId&&!previous){
      const token=secret()
      db.prepare('INSERT INTO communication_grants(runId,token,tokenHash,expiresAt) VALUES(?,?,?,?)')
        .run(c.runId,token,hash(token),new Date(Date.now()+24*3600000).toISOString())
      communicationAccess={token}
    }
    if(!previous)db.prepare("UPDATE commands SET payload=json_set(payload,'$.dispatch',json(?)),status='sent' WHERE id=?")
      .run(JSON.stringify(dispatch),c.id)
    return {id:c.id,threadId:c.threadId,runId:c.runId,taskId:c.taskId,instanceId:c.instanceId,projectId:c.projectId,
      profileId:c.profileId,workspaceRef:c.workspaceRef,runtimeScopeId:dispatch.runtimeScopeId,kind:c.kind,payload:{text:dispatch.text,sessionId:dispatch.sessionId,nativeRunId:dispatch.nativeRunId,
        attachmentIds,modelId,requestId,choice,inputText,materials:rest.materials,nativeOperation:rest.nativeOperation,communication,importSessionId,
        ...(grant?{homeAccess:grant}:{}),...(communicationAccess?{communicationAccess}:{})}}
  }
  function flush(){
    for(const [nodeId,link] of online){
      if(nodeId==='local'&&localDispatchPaused)continue
      if(link.ws.readyState!==WebSocket.OPEN) continue
      const rows=db.prepare(`SELECT c.*,t.sessionId,t.projectId,r.nativeRunId,r.status AS runStatus,i.adapterKey,i.profileId,i.workspaceRef,i.runtimeScopeId FROM commands c JOIN instances i ON i.id=c.instanceId JOIN threads t ON t.id=c.threadId JOIN runs r ON r.id=c.runId
        WHERE i.nodeId=? AND (c.status IN ('queued','sent','received') OR c.status='uncertain' AND c.kind IN ('run','prepare'))
          AND (r.status NOT IN ('completed','cancelled','blocked','failed','uncertain') OR r.status='uncertain' AND c.kind IN ('run','prepare','cancel'))
        ORDER BY c.rowid`).all(nodeId) as any[]
      const activeIds=new Set(rows.map(c=>c.id))
      for(const id of link.sent)if(!activeIds.has(id))link.sent.delete(id)
      for(const id of link.lookups.keys())if(!activeIds.has(id))link.lookups.delete(id)
      for(const id of link.missing)if(!activeIds.has(id))link.missing.delete(id)
      const pending=new Set<string>()
      for(const c of rows){
        if(!link.instances.has(c.instanceId)||pending.has(c.threadId)&&c.kind!=='cancel')continue
        if(c.status==='queued')pending.add(c.threadId)
        if(link.sent.has(c.id))continue
        const fresh=one(db,'SELECT c.status,r.status AS runStatus FROM commands c JOIN runs r ON r.id=c.runId WHERE c.id=?',c.id)
        if(fresh?.status!==c.status||fresh?.runStatus!==c.runStatus)continue
        if(c.status!=='queued'){
          const at=link.lookups.get(c.id)
          if(!link.missing.delete(c.id)){
            if(link.receiptLookup && at===undefined){
              link.lookups.set(c.id,Date.now())
              link.ws.send(JSON.stringify({type:'inspect_command',commandId:c.id}))
              continue
            }
            if(at!==undefined&&Date.now()-at<10000)continue
            link.lookups.delete(c.id)
            link.sent.add(c.id)
            if(c.status!=='uncertain')transaction(db,()=>reject(c,'节点没有可核对的持久回执，已停止重发'))
            continue
          }
          if(c.status!=='sent'||c.runStatus==='uncertain'&&c.kind!=='cancel'){
            link.sent.add(c.id)
            if(c.status!=='uncertain')transaction(db,()=>reject(c,'节点缺少此前已接收的命令记录，需人工核对'))
            continue
          }
        }
        if(!['run','prepare'].includes(c.kind)&&!c.nativeRunId){
          // ACP controls address the session once the node marks it ready for the current run.
          const ready=['dsh','hermes'].includes(c.adapterKey)&&c.sessionId&&one(db,`SELECT 1 FROM messages
            WHERE threadId=? AND kind='activity' AND json_extract(data,'$.runId')=?
              AND json_extract(data,'$.controlReady')=1 LIMIT 1`,c.threadId,c.runId)
          const preparing= c.kind==='cancel'&&one(db,"SELECT 1 FROM commands WHERE runId=? AND kind='prepare' LIMIT 1",c.runId)
          if(!ready&&!preparing&&!(c.kind==='cancel'&&link.cancelBeforeStart&&JSON.parse(c.payload).priorStatus==='queued'))continue
        }
        try {
          const command=transaction(db,()=>freeze(c,link.scopedCommands))
          link.sent.add(c.id)
          link.ws.send(JSON.stringify({type:'command',command}),err=>{if(err)link.ws.terminate()})
        }catch(e){
          const detail=(e as {status?:number,message:string}).status?(e as Error).message:'命令材料或发送快照无效，请重新提交'
          transaction(db,()=>reject(c,detail))
        }
      }
    }
  }
  function queryNative(inst:any,type:string,request:Record<string,unknown>){
    if(inst.nodeId==='local'&&localDispatchPaused)fail('本机 Agent 连接器正在维护，请稍后重试',409)
    const link=online.get(inst.nodeId)
    if(!link?.instances.has(inst.id)||link.ws.readyState!==WebSocket.OPEN)fail('原生节点离线',409)
    const {ws}=link
    if(catalogs.size>=10)fail('读取原生会话的请求过多，请稍后重试',429)
    return new Promise<any>((resolve,reject)=>{
      const id=secret()
      function cleanup(){catalogs.delete(id);clearTimeout(timeout);ws.off('close',disconnected)}
      function error(text:string){cleanup();reject(Object.assign(Error(text),{status:502}))}
      const disconnected=()=>error('读取原生会话时节点断开')
      const timeout=setTimeout(()=>error('读取原生会话超时'),6500)
      ws.once('close',disconnected)
      catalogs.set(id,{ws,type,respond(frame){
        if(frame.error||!Array.isArray(frame.items)){error('原生实例无法返回当前工作区的会话');return}
        cleanup()
        resolve(frame)
      }})
      ws.send(JSON.stringify({...request,id,instanceId:inst.id,workspaceRef:inst.workspaceRef,profileId:inst.profileId,runtimeScopeId:inst.runtimeScopeId}),
        failure=>{if(failure)error('原生节点未能接收会话查询')})
    })
  }
  async function listSessions(inst:any,cursor:string|null,projectId:string|null):Promise<{items:NativeSession[];nextCursor:string|null}>{
    const frame=await queryNative(inst,'sessions',{type:'list_sessions',cursor:cursor??undefined})
    const current=nativeSessionCatalogTarget(db,inst.id,projectId)
    if(current.runtimeScopeId!==inst.runtimeScopeId)fail('原生会话的账号或 profile 已变化',409)
    const seen=new Set<string>()
    const items=frame.items.slice(0,200).filter((item:any)=>{
      if(typeof item?.id!=='string'||!/^[\w-]{1,128}$/.test(item.id)||seen.has(item.id))return false
      seen.add(item.id)
      const binding=nativeSessionBinding(db,inst,item.id)
      const released=nativeSessionReleaseScope(db,inst,item.id)
      const isReleasedScope=released&&!released.conflict&&released.instanceId===inst.id&&released.projectId===projectId
      return (!binding||nativeBindingInScope(binding,inst.id,projectId))&&(!released||isReleasedScope)
    })
      .map((item:any)=>({id:item.id,title:String(item.title??'').slice(0,140),updatedAt:Number(item.updatedAt)||0,active:item.active===true}))
    return {items,nextCursor:typeof frame.nextCursor==='string'&&frame.nextCursor.length<=2000?frame.nextCursor:null}
  }
  async function readHistory(thread:any,before?:string):Promise<NativeHistory>{
    const inst=must(db,'SELECT * FROM instances WHERE id=?',thread.instanceId)
    if(!thread.sessionId||!JSON.parse(inst.capabilities).nativeHistory)fail('此实例未提供绑定会话的只读历史',409)
    assertNativeBindingScope(db,inst,thread)
    if(thread.nativeInvalid)fail('原生绑定已失效，可查看工作台已保存的记录',409)
    if(before&&before.length>2000)fail('原生历史游标无效')
    const frame=await queryNative(inst,'history',{type:'read_history',threadId:thread.id,sessionId:thread.sessionId,before})
    const latest=must(db,'SELECT * FROM threads WHERE id=?',thread.id)
    const current=must(db,'SELECT * FROM instances WHERE id=?',thread.instanceId)
    assertNativeBindingScope(db,current,latest)
    if(latest.state!==thread.state||latest.sessionId!==thread.sessionId||latest.nativeInvalid||current.runtimeScopeId!==inst.runtimeScopeId)
      fail('会话可见范围已变化',409)
    const items=frame.items.filter((i:any)=>typeof i.id==='string'&&typeof i.turnId==='string'&&typeof i.text==='string'&&['user','assistant'].includes(i.role))
      .map(({id,turnId,role,text}:any)=>({id,turnId,role,text}))
    if(typeof frame.archived==='boolean'&&Boolean(thread.nativeArchived)!==frame.archived){
      transaction(db,()=>{
        db.prepare('UPDATE threads SET nativeArchived=?,state=? WHERE id=?').run(Number(frame.archived),frame.archived?'archived':'active',thread.id)
      changed(db,'thread',{threadId:thread.id,instanceId:thread.instanceId,source:'native'})
      })
    }
    return {items,nextBefore:typeof frame.nextBefore==='string'&&frame.nextBefore.length<=2000?frame.nextBefore:null,archived:frame.archived,source:'native' as const,fetchedAt:now()}
  }
  async function readUsage(instanceId:string):Promise<NativeUsage>{
    const inst=must(db,'SELECT * FROM instances WHERE id=?',instanceId)
    const unknown={source:null,fetchedAt:null,windows:[]}
    if(!inst.online||!inst.runtimeScopeId||!JSON.parse(inst.capabilities).usage)return unknown
    try{
      const frame=await queryNative(inst,'usage',{type:'read_usage'})
      const windows=frame.items.slice(0,2).filter((w:any)=>Number.isFinite(w?.usedPercent)&&w.usedPercent>=0&&w.usedPercent<=100)
        .map((w:any)=>({usedPercent:w.usedPercent,durationMinutes:Number.isSafeInteger(w.durationMinutes)&&w.durationMinutes>0?w.durationMinutes:null,
          resetsAt:Number.isSafeInteger(w.resetsAt)&&w.resetsAt>0?w.resetsAt:null}))
      return {source:'codex_app_server',fetchedAt:now(),windows}
    }catch{return unknown}
  }
  return {flush,listSessions,readHistory,readUsage,
  expectLocalGeneration(generation:string|null){
    expectedLocalGeneration=generation
    const previous=online.get('local')
    if(!previous)return
    online.delete('local')
    transaction(db,()=>{
      db.prepare("UPDATE instances SET online=0 WHERE nodeId='local'").run()
      changed(db,'presence',{nodeId:'local',online:false})
    })
    previous.ws.terminate()
  },
  pauseLocalDispatch(paused:boolean){
    const previous=localDispatchPaused
    localDispatchPaused=paused
    if(previous&&!paused)flush()
    return previous
  },
  localQueriesPending(){
    const socket=online.get('local')?.ws
    return !!socket&&[...catalogs.values()].some(request=>request.ws===socket)
  },
  localConnectorStatus(generation?:string){
    const current=localRegistration
    if(!current||current.generation!==generation)return {instances:[]}
    if(current.error)return {instances:[],error:current.error}
    return {instances:online.get('local')?.ws===current.ws&&current.ws.readyState===WebSocket.OPEN?current.instances:[]}
  },inspect(runId:string){
    for(const command of db.prepare(`SELECT c.id,i.nodeId FROM commands c JOIN instances i ON i.id=c.instanceId
      WHERE c.runId=? AND c.status IN ('sent','received','uncertain')`).all(runId)){
      const link=online.get(String(command.nodeId)),id=String(command.id)
      link?.sent.delete(id)
      link?.lookups.delete(id)
    }
    flush()
  },close(){
    clearInterval(timer)
    online.clear()
    for(const ws of wss.clients)ws.terminate()
    wss.close()
  }}
}
