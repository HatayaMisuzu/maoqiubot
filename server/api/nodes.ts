import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { transaction, changed, now, required, one, must, fail } from '../db/index.ts'
import { applyEvent, addProjectContext, checkQueuedInput } from '../tasks/index.ts'
import type { NodeCommand } from '../../contracts/node.ts'
import { secret,hash } from './auth.ts'
import { isLocal } from './local.ts'

export function attachNodes(server:Server,db:DatabaseSync,authenticate:(token:string)=>string|undefined){
  const wss=new WebSocketServer({noServer:true,maxPayload:4*1024*1024})
  const online=new Map<string,{ws:WebSocket,sent:Set<string>,alive:boolean,instances:Set<string>}>()
  server.on('upgrade',(req,socket,head)=>{
    const nodeId=authenticate((req.headers.authorization??'').replace(/^Bearer /,''))
    if(!nodeId || req.url?.split('?')[0]!=='/api/v1/node'){socket.destroy();return}
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
          if(!registered){
            if(m.type!=='hello'||(m.nodeId && m.nodeId!==nodeId)||!Array.isArray(m.instances)) fail('节点握手失败')
            transaction(db,()=>{
              db.prepare('UPDATE instances SET online=0 WHERE nodeId=?').run(nodeId)
              for(const i of m.instances){
                const key=required(i.id,'instanceId'),old=one(db,'SELECT * FROM instances WHERE id=?',key)
                const profileId=required(i.profileId??'default','profileId')
                if(key==='main'|| (old && (old.nodeId!==nodeId || old.workspaceRef!==i.workspaceRef || old.adapterKey!==i.adapterKey || old.profileId!==profileId))) fail('实例绑定冲突，请用新实例 ID')
                if(!Array.isArray(i.availableActions)) fail('缺少实例能力')
                const blocked=i.adapterKey==='codex'&&!isLocal(req)
                const caps={version:i.version,resume:i.resume,history:i.history,error:blocked?'个人 Codex 登录限本机':i.error,models:Array.isArray(i.models)?i.models.slice(0,200):[]}
                db.prepare('INSERT INTO instances(id,nodeId,name,adapterKey,workspaceRef,availableActions,lastSeen,online,capabilities,profileId) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,availableActions=excluded.availableActions,lastSeen=excluded.lastSeen,online=excluded.online,capabilities=excluded.capabilities').run(key,nodeId,required(i.name,'name'),required(i.adapterKey,'adapterKey'),required(i.workspaceRef,'workspaceRef'),JSON.stringify(i.availableActions),now(),blocked||i.online===false?0:1,JSON.stringify(caps),profileId)
              }
              changed(db,'presence',{nodeId,online:true})
            })
            registered=true
            const previous=online.get(nodeId)
            const ids=db.prepare('SELECT id FROM instances WHERE nodeId=? AND online=1').all(nodeId).map(r=>String(r.id))
            online.set(nodeId,{ws,sent:new Set(),alive:true,instances:new Set(ids)})
            previous?.ws.terminate()
            flush()
            return
          }
          if(online.get(nodeId)?.ws!==ws)return
          if(m.type==='event'){
            transaction(db,()=>applyEvent(db,nodeId,m.event))
            ws.send(JSON.stringify({type:'ack',key:m.event.key}))
          }else if(m.type==='receipt'){
            transaction(db,()=>{
              const c=must(db,'SELECT c.* FROM commands c JOIN instances i ON c.instanceId=i.id WHERE c.id=? AND i.nodeId=?',m.commandId,nodeId)
              if(!['received','done','uncertain','failed'].includes(m.status))fail('无效回执')
              if(['done','failed','withdrawn'].includes(c.status)||m.status===c.status||c.status==='uncertain'&&m.status==='received')return
              db.prepare('UPDATE commands SET status=?,detail=? WHERE id=?').run(m.status,m.detail?String(m.detail):null,c.id)
              if(['run','prepare'].includes(c.kind) && m.status==='uncertain'){
                db.prepare("UPDATE runs SET status='uncertain',pendingRequest=NULL WHERE id=? AND status IN ('queued','running','waiting_input','cancelling')").run(c.runId)
                db.prepare("UPDATE tasks SET status='uncertain' WHERE id=? AND EXISTS(SELECT 1 FROM runs WHERE id=? AND status='uncertain')").run(c.taskId,c.runId)
                db.prepare("UPDATE commands SET status='held' WHERE runId=? AND status='waiting' AND EXISTS(SELECT 1 FROM runs WHERE id=? AND status='uncertain')").run(c.runId,c.runId)
                db.prepare('DELETE FROM run_grants WHERE runId=?').run(c.runId)
              }
              if(m.status==='done' && c.kind==='answer') {
                db.prepare("UPDATE runs SET status=CASE WHEN status='waiting_input' THEN 'running' ELSE status END,pendingRequest=NULL WHERE id=? AND status IN ('waiting_input','cancelling') AND json_extract(pendingRequest,'$.requestId')=?").run(c.runId,JSON.parse(c.payload).requestId)
                db.prepare("UPDATE tasks SET status='running' WHERE id=? AND status='waiting_input' AND EXISTS(SELECT 1 FROM runs WHERE id=? AND status='running')").run(c.taskId,c.runId)
              }
              if(m.status==='failed' && c.kind==='cancel'){
                const run=db.prepare("UPDATE runs SET status=CASE WHEN pendingRequest IS NOT NULL THEN 'waiting_input' ELSE 'running' END WHERE id=? AND status='cancelling' RETURNING status").get(c.runId)
                if(run)db.prepare('UPDATE tasks SET status=? WHERE id=?').run(run.status,c.taskId)
              }
              changed(db,'receipt',{threadId:c.threadId,runId:c.runId,commandId:c.id,status:m.status})
            })
            ws.send(JSON.stringify({type:'receipt_ack',commandId:m.commandId,status:m.status}))
          }else fail('未知节点消息')
          flush()
        }catch(err){console.error('节点协议',nodeId,(err as Error).message);ws.close(1008,'invalid message')}
      })
    })
  })
  const timer=setInterval(()=>{
    db.prepare('DELETE FROM run_grants WHERE expiresAt<=?').run(now())
    db.prepare('DELETE FROM grants WHERE expiresAt<=?').run(now())
    for(const c of online.values()){if(!c.alive)c.ws.terminate();else{c.alive=false;c.ws.ping()}}
  },30000)
  timer.unref()
  function flush(){
    for(const [nodeId,link] of online){
      if(link.ws.readyState!==WebSocket.OPEN) continue
      const rows=db.prepare(`SELECT c.*,t.sessionId,t.projectId,r.nativeRunId,i.adapterKey,i.profileId,i.workspaceRef FROM commands c JOIN instances i ON i.id=c.instanceId JOIN threads t ON t.id=c.threadId JOIN runs r ON r.id=c.runId
        WHERE i.nodeId=? AND c.status IN ('queued','sent','received') AND r.status NOT IN ('completed','cancelled','blocked','failed','uncertain')
        ORDER BY c.rowid`).all(nodeId) as any[]
      const activeIds=new Set(rows.map(c=>c.id))
      for(const id of link.sent)if(!activeIds.has(id))link.sent.delete(id)
      const pending=new Set<string>()
      for(const c of rows){
        if(!link.instances.has(c.instanceId)||pending.has(c.threadId))continue
        if(c.status!=='received')pending.add(c.threadId)
        if(link.sent.has(c.id))continue
        if(!['run','prepare'].includes(c.kind)&&!c.nativeRunId){
          // ACP controls address the session. A session binding can predate prompt submission.
          const ready=c.adapterKey==='dsh'&&c.sessionId&&one(db,`SELECT 1 FROM messages
            WHERE threadId=? AND kind='activity' AND json_extract(data,'$.runId')=?
              AND json_extract(data,'$.controlReady')=1 LIMIT 1`,c.threadId,c.runId)
          if(!ready)continue
        }
        const command:NodeCommand={id:c.id,threadId:c.threadId,runId:c.runId,taskId:c.taskId,instanceId:c.instanceId,projectId:c.projectId,profileId:c.profileId,workspaceRef:c.workspaceRef,kind:c.kind,payload:{...JSON.parse(c.payload),sessionId:c.sessionId,nativeRunId:c.nativeRunId}}
        if(c.projectId&&c.status==='queued'&&['run','steer','prepare'].includes(c.kind)){
          try{checkQueuedInput(db,c,command.payload)}
          catch(e){
            if(!(e as {status?:number}).status)throw e
            const detail=(e as Error).message
            transaction(db,()=>{
              db.prepare("UPDATE commands SET status='failed',detail=? WHERE id=?").run(detail,c.id)
              if(c.kind!=='steer'){
                db.prepare("UPDATE runs SET status='blocked' WHERE id=?").run(c.runId)
                db.prepare("UPDATE tasks SET status='blocked' WHERE id=?").run(c.taskId)
                db.prepare("UPDATE commands SET status='held' WHERE runId=? AND status='waiting'").run(c.runId)
                db.prepare('DELETE FROM run_grants WHERE runId=?').run(c.runId)
              }
              changed(db,'receipt',{threadId:c.threadId,runId:c.runId,commandId:c.id,status:'failed'})
            })
            continue
          }
        }
        if(c.kind==='run' && c.projectId){
          const binding=one(db,'SELECT agentPermission FROM project_workspaces WHERE projectId=? AND instanceId=? AND allowAgentAccess=1',c.projectId,c.instanceId)
          let grant=binding&&one(db,'SELECT token,projectId,permission FROM run_grants WHERE runId=? AND expiresAt>? AND permission=?',c.runId,now(),binding.agentPermission)
          if(binding&&!grant&&c.status==='queued'){
            const token=secret(),expiresAt=new Date(Date.now()+24*3600000).toISOString()
            db.prepare('INSERT INTO run_grants(runId,tokenHash,token,projectId,instanceId,expiresAt,permission) VALUES(?,?,?,?,?,?,?)').run(c.runId,hash(token),token,c.projectId,c.instanceId,expiresAt,binding.agentPermission)
            grant={token,projectId:c.projectId,permission:binding.agentPermission}
          }
          if(grant){
            command.payload.homeAccess=grant
            command.payload.text=addProjectContext(db,c,command.payload.text??'')
          }
        }
        link.sent.add(c.id)
        db.prepare("UPDATE commands SET status='sent' WHERE id=? AND status='queued'").run(c.id)
        link.ws.send(JSON.stringify({type:'command',command}),err=>{if(err)link.ws.terminate()})
      }
    }
  }
  return {flush,close(){
    clearInterval(timer)
    online.clear()
    for(const ws of wss.clients)ws.terminate()
    wss.close()
  }}
}
