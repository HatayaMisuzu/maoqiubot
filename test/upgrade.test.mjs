import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import WebSocket from 'ws'
import { startServer } from '../server/index.ts'
import { openDatabase, owner, transaction } from '../server/db/index.ts'
import { initHome, homeApi } from '../server/home/index.ts'
import { message } from '../server/tasks/index.ts'
import { Store } from '../connector/store.ts'
import { transfer } from '../scripts/backup.ts'
import { hash } from '../server/api/auth.ts'

async function eventually(fn){
  for(let attempt=0;attempt<200;attempt++){
    const result=await fn()
    if(result)return result
    await sleep(15)
  }
  throw Error('等待测试条件超时')
}
async function server(t,options={}){
  const dir=mkdtempSync(join(tmpdir(),'maoqiu-upgrade-'))
  let app
  t.after(async()=>{if(app)await app.close();rmSync(dir,{recursive:true,force:true})})
  async function start(){
    app=startServer({port:0,dataDir:dir,chat:false,...options})
    await once(app.server,'listening')
    return app
  }
  await start()
  const base=()=> 'http://127.0.0.1:'+app.server.address().port+'/api/v1'
  async function api(path,body,options={}){
    const headers={Authorization:'Bearer '+(options.token??app.auth.cfg.ownerToken),'Content-Type':'application/json',...options.headers}
    const response=await fetch(base()+path,{method:options.method??(body?'POST':'GET'),headers,body:body&&JSON.stringify(body)})
    const data=await response.json()
    assert.equal(response.status,options.status??200,data.error)
    return data
  }
  return {get app(){return app},dir,base,api,async reopen(){await app.close();app=null;return start()}}
}
async function node(fixture){
  const frames=[]
  const ws=new WebSocket(fixture.base().replace('http:','ws:')+'/node',{headers:{Authorization:'Bearer '+fixture.app.auth.cfg.nodes.local}})
  ws.on('message',frame=>frames.push(JSON.parse(frame)))
  await once(ws,'open')
  const send=frame=>ws.send(JSON.stringify(frame))
  send({type:'hello',nodeId:'local',instances:[{id:'worker',name:'Worker',workspaceRef:fixture.dir,adapterKey:'test',availableActions:['run','cancel']},
    {id:'worker-b',name:'Worker B',workspaceRef:fixture.dir,adapterKey:'test',availableActions:['run','cancel']}]})
  await eventually(async()=>(await fixture.api('/instances')).find(i=>i.id==='worker'&&i.online))
  return {frames,ws,command:runId=>eventually(()=>frames.find(f=>f.command?.runId===runId)?.command),
    async event(c,kind,data={}){
      const seq=frames.length+1,key=c.runId+'-'+seq
      send({type:'event',event:{key,seq,kind,data,commandId:c.id,runId:c.runId,instanceId:c.instanceId}})
      await eventually(()=>frames.some(f=>f.type==='ack'&&f.key===key))
    },
    async receipt(c,status){
      send({type:'receipt',commandId:c.id,status})
      await eventually(()=>frames.some(f=>f.type==='receipt_ack'&&f.commandId===c.id&&f.status===status))
    }}
}

test('运行授权经过 HTTP 验证范围、权限、到期、解绑及所有终态',async t=>{
  const f=await server(t),n=await node(f),{api}=f
  const p=await api('/projects',{name:'运行范围'}),other=await api('/projects',{name:'其他项目'})
  const workspaces='/projects/'+p.id+'/workspaces',brief='/projects/'+p.id+'/brief',records='/projects/'+p.id+'/records'
  const space=await api('/spaces/'+p.spaceId)
  const attachment=await api('/attachments',{projectId:p.id,name:'证据.html',contentType:'text/html',data:'QUJD'})
  const origin=await api('/threads',{projectId:p.id})
  const source=await api('/submissions',{projectId:p.id,source:{title:'观测记录',attachmentIds:[attachment.id]}})
  const bind=(permission='read',allowAgentAccess=true,instanceId='worker')=>api(workspaces,{instanceId,workspaceRef:f.dir,allowAgentAccess,agentPermission:permission})
  const run=async(instanceId='worker')=>{
    const task=await api('/tasks',{originThreadId:origin.id,instanceId,goal:'整理资料',doneWhen:['检查依据']})
    const command=await n.command(task.runId)
    return {task,command,token:command.payload.homeAccess?.token}
  }
  const invitation=await api('/grants',{projectId:p.id,expiresInDays:2})
  assert.ok(Date.parse(invitation.expiresAt)>Date.now())
  const existing=await api(records,{body:'已存在的记录'},invitation)
  const privateRecord=await api('/records',{type:'preference',body:'私人偏好',confirmation:'user'})
  const oldFact=await api(records,{type:'requirement',body:'旧约束',factKey:'tag',confirmation:'user'})
  const currentFact=await api(records,{type:'requirement',body:'当前约束',factKey:'tag',confirmation:'user'})
  await api(records,{type:'requirement',body:'外部覆盖',factKey:'tag',confirmation:'user'},invitation)
  await api('/records/'+currentFact.id,{expectedRevision:1,body:'外部改写'},{...invitation,method:'PATCH',status:403})
  await api('/submissions',{projectId:p.id,source:{title:'需要回滚'},records:[{body:'有效记录'},{type:'不存在的类型',body:'无效记录'}]},{status:400})
  assert.equal(f.app.db.prepare("SELECT COUNT(*) n FROM sources WHERE title='需要回滚'").get().n,0)
  assert.equal(f.app.db.prepare("SELECT COUNT(*) n FROM record_revisions WHERE json_extract(snapshot,'$.body')='有效记录'").get().n,0)
  await api(records,{type:'decision',body:'已过期',validUntil:'2000-01-01'})
  await api(records,{type:'handoff',body:'交接样本',extra:{remaining:['标记附件']}})
  await bind()
  const read=await run(),token=read.token
  assert.ok(token)
  assert.equal(read.command.payload.homeAccess.permission,'read')
  assert.match(read.command.payload.text,/当前约束/)
  assert.match(read.command.payload.text,/交接样本/)
  assert.doesNotMatch(read.command.payload.text,/旧约束|外部覆盖|私人偏好|已过期/)
  const task=await api('/tasks/'+read.task.taskId)
  assert.equal(task.task.brief.projectContext.refs.some(r=>r.id===oldFact.id),false)
  assert.equal((await api(brief,null,{token})).project.id,p.id)
  await api('/sources/'+source.sourceId,null,{token})
  await api('/attachments/'+attachment.id,null,{token})
  for(const [path,body,method] of [
    [records,{body:'未允许的写操作'},'POST'],
    ['/records/'+existing.id,{expectedRevision:1,body:'改写'},'PATCH'],
    ['/sources/'+source.sourceId,{projectIds:[]},'PATCH'],
    ['/attachments/'+attachment.id,{projectIds:[]},'PATCH'],
    ['/spaces/'+p.spaceId+'/restore',{expectedRevision:1,targetRevision:1},'POST'],
    ['/events/latest',null,'GET'],
    ['/records/'+privateRecord.id,null,'GET'],
    ['/projects/'+other.id+'/brief',null,'GET']
  ])await api(path,body,{method,token,status:403})
  await n.receipt(read.command,'received')
  await sleep(540)
  assert.equal(n.frames.filter(f=>f.command?.id===read.command.id).length,1)
  await n.event(read.command,'artifact',{text:'提交的成果'})
  await n.event(read.command,'completed',{verified:['检查依据']})
  const workThread=task.task.workThreadId
  transaction(f.app.db,()=>{
    for(let i=0;i<60;i++)message(f.app.db,workThread,'assistant','activity','后续记录 '+i,{runId:read.command.runId})
  })
  const snapshot=await api('/threads/'+workThread+'?messageLimit=60')
  assert.equal(snapshot.messages.some(m=>m.kind==='artifact'),false)
  assert.equal(snapshot.submittedArtifacts,true)
  await api(brief,null,{token,status:401})
  const reviewBrief=await api(brief)
  assert.deepEqual(reviewBrief.verified,[])
  assert.equal(reviewBrief.claimedVerification[0].body,'检查依据')
  assert.deepEqual(reviewBrief.pendingVerification[0].criteria,['检查依据'])
  await api('/tasks/'+read.task.taskId+'/review',{runId:read.task.runId,checks:[{criterion:'检查依据',met:true,evidence:'所有者已检查原件'}]})
  assert.equal((await api(brief)).verified[0].verificationSource,'user')
  assert.equal((await api('/tasks/'+read.task.taskId)).review.by,'owner')

  await bind('append',true,'worker-b')
  const append=await run('worker-b'),appendAuth={token:append.token}
  assert.match(append.command.payload.text,/当前约束/)
  const added=await api(records,{type:'handoff',body:'追加交接',confirmation:'user'},appendAuth)
  assert.equal(added.confirmation,'unconfirmed')
  await api('/submissions',{projectId:p.id,source:{title:'新成果'}},appendAuth)
  await api('/projects/'+other.id+'/records',{body:'越界'}, {...appendAuth,status:403})
  await api(records,{type:'verified',body:'试图声明验收'}, {...appendAuth,status:403})
  await api('/records/'+added.id,{expectedRevision:1,body:'改历史'}, {...appendAuth,method:'PATCH',status:403})
  await api('/records/'+added.id,{expectedRevision:1}, {...appendAuth,method:'DELETE',status:403})
  await api('/collections/'+space.structure.collections[0].id+'/entries',{values:{title:'条目'}},{...appendAuth,status:403})
  await n.receipt(append.command,'uncertain')
  await api(brief,null,{...appendAuth,status:401})
  assert.equal((await api('/tasks/'+append.task.taskId)).run.status,'uncertain')

  for(const status of ['failed','blocked','cancelled']){
    const active=await run()
    await api(brief,null,{token:active.token})
    await n.event(active.command,status,{text:'测试 '+status})
    await api(brief,null,{token:active.token,status:401})
    assert.equal(f.app.db.prepare('SELECT COUNT(*) n FROM run_grants WHERE runId=?').get(active.command.runId).n,0)
  }
  await bind('manage')
  const manager=await run(),managerAuth={token:manager.token}
  await api('/spaces/'+p.spaceId+'/changes',{mode:'apply',expectedRevision:1,operations:[{op:'updatePage',pageId:p.pageId,title:'已委托编辑'}]},managerAuth)
  await api('/attachments/'+attachment.id,{projectIds:[]},{...managerAuth,method:'PATCH',status:403})
  await bind('read',false)
  await api(brief,null,{...managerAuth,status:401})
  await bind()
  await api(brief,null,{...managerAuth,status:401})
  const expiring=await run()
  f.app.db.prepare('UPDATE run_grants SET expiresAt=? WHERE runId=?').run('2000-01-01',expiring.task.runId)
  await api(brief,null,{token:expiring.token,status:401})
  const unbinding=await run()
  await api(workspaces,{instanceId:'worker'},{method:'DELETE'})
  await api(brief,null,{token:unbinding.token,status:401})
  await api(brief,null,invitation)
  await api('/grants/'+invitation.id,{}, {method:'DELETE'})
  await api(brief,null,{...invitation,status:401})
  await f.reopen()
  await api(brief,null,{...appendAuth,status:401})
  await api(brief,null,{token:unbinding.token,status:401})
})

test('中文检索分页与 ACL 生效，空间恢复保留条目并可显式转换',async t=>{
  const {app,api}=await server(t)
  assert.ok(app.db.prepare("SELECT name FROM sqlite_schema WHERE name='archive_search'").get())
  const p=await api('/projects',{name:'可检索'}),other=await api('/projects',{name:'私有项目'})
  const reader=await api('/grants',{projectId:p.id})
  const r=await api('/submissions',{projectId:p.id,source:{title:'档案摩羯座',platform:'记录台'},records:[{body:'关键字摩羯座'}]})
  const protectedSource=await api('/submissions',{projectId:other.id,source:{title:'其他项目摩羯座'}})
  for(const term of ['羯','摩羯','摩羯座']){
    const query=new URLSearchParams({q:term,limit:'1',ref:protectedSource.sourceId})
    const start=await api('/search?'+query,null,reader)
    assert.ok(start.nextCursor)
    query.set('cursor',start.nextCursor)
    const end=await api('/search?'+query,null,reader)
    assert.deepEqual(new Set([...start.items,...end.items].map(x=>x.id)),new Set([r.sourceId,r.records[0].id]))
    assert.equal(end.nextCursor,null)
  }
  const record='/records/'+r.records[0].id
  await api(record,{expectedRevision:1,body:'星座更新'}, {method:'PATCH'})
  assert.equal((await api('/search?q=摩羯座&kind=record',null,reader)).items.length,0)
  assert.equal((await api('/search?q=星座更新&kind=record',null,reader)).items[0].revision,2)
  await api(record,{expectedRevision:2},{method:'DELETE'})
  assert.equal((await api('/search?q=星座更新',null,reader)).items.length,0)
  await api('/sources/'+r.sourceId,{projectIds:[]},{method:'PATCH'})
  assert.equal((await api('/search?q=摩羯座',null,reader)).items.length,0)
  await api('/search?cursor=bad',null,{status:400})
  const space='/spaces/'+p.spaceId,initial=await api(space),c=initial.structure.collections[0]
  const entries='/collections/'+c.id+'/entries'
  const first=await api(entries,{values:{title:'2'}})
  await api(space+'/changes',{expectedRevision:1,mode:'apply',operations:[
    {op:'updatePage',pageId:p.pageId,title:'更新后'},
    {op:'updateField',collectionId:c.id,fieldId:'title',field:{type:'number'},migration:{[first.id]:2}}
  ]})
  const later=await api(entries,{values:{title:3}})
  const layout={expectedRevision:2,targetRevision:1,scope:'layout'}
  const preview=await api(space+'/restore',{...layout,mode:'preview'})
  assert.equal(preview.structure.collections[0].fields[0].type,'number')
  assert.equal((await api(space)).structure.pages[0].title,'更新后')
  await api(space+'/restore',layout)
  assert.deepEqual((await api(entries)).items.map(e=>e.values.title),[2,3])
  const historical={expectedRevision:3,targetRevision:1,scope:'structure'}
  assert.equal((await api(space+'/restore',{...historical,mode:'preview'})).conflicts.length,2)
  await api(space+'/restore',historical,{status:409})
  await api(space+'/restore',{...historical,migrations:{[first.id]:{title:'二'},[later.id]:{title:'三'}}})
  assert.deepEqual((await api(entries)).items.map(e=>e.values.title),['二','三'])
})

test('下载原件强制附件响应，并保留兼容的 JSON 读取与历史消息分页',async t=>{
  const f=await server(t),{api,app}=f
  const a=await api('/attachments',{name:'文件.svg',contentType:'image/svg+xml',data:'PHN2Zz4='})
  const response=await fetch(f.base()+'/attachments/'+a.id+'?download=1',{headers:{Authorization:'Bearer '+app.auth.cfg.ownerToken}})
  assert.equal(response.status,200)
  assert.match(response.headers.get('content-disposition'),/^attachment;/)
  assert.equal(response.headers.get('x-content-type-options'),'nosniff')
  assert.equal(response.headers.get('content-type'),'application/octet-stream')
  assert.equal(await response.text(),'<svg>')
  assert.equal((await api('/attachments/'+a.id)).data,'PHN2Zz4=')
  await api('/attachments',{name:'超限.bin',data:Buffer.alloc(16*1024*1024+1).toString('base64')},{status:413})
  const thread=await api('/threads',{title:'长对话'}),separate=await api('/threads',{title:'别的话题'})
  let foreignId
  transaction(app.db,()=>{
    foreignId=message(app.db,separate.id,'user','message','别的话题')
    for(let i=0;i<1000;i++)message(app.db,thread.id,'user','message','消息 '+i)
  })
  const path='/threads/'+thread.id
  const first=await api(path+'?messageLimit=60')
  assert.equal(first.messages.length,60)
  assert.equal(first.messages[0].text,'消息 940')
  const older=await api(path+'/messages?before='+first.nextBefore+'&limit=100')
  assert.equal(older.messages[0].text,'消息 840')
  assert.equal(older.messages.at(-1).text,'消息 939')
  await api(path+'/messages?before='+foreignId,null,{status:404})
  assert.equal((await api(path)).messages.length,1000)
})

test('主聊下一轮读取人格、持久摘要及相关记忆，调用失败不重复执行',async t=>{
  const prompts=[]
  let shouldFail=false
  const provider={name:'fixture',async generate(prompt){
    prompts.push(JSON.parse(prompt.slice(prompt.indexOf('\n')+1)))
    if(shouldFail)throw Error('private-fixture-secret')
    return {action:'reply',text:'已接续',goal:'',taskId:'',instanceId:'',constraints:[],doneWhen:[],
      summary:prompts.at(-1).olderMessages.length?'早先约定保留星图标记':''}
  }}
  const f=await server(t,{chat:true,chatProvider:provider}),{api}=f
  const p=await api('/projects',{name:'星图项目'})
  await api('/projects/'+p.id+'/records',{type:'note',body:'星图使用摩羯座标记',confirmation:'user'})
  await api('/records',{type:'preference',body:'星图私人消息'})
  const chat=await api('/threads',{projectId:p.id})
  const path='/threads/'+chat.id
  transaction(f.app.db,()=>{
    for(let i=0;i<35;i++){
      message(f.app.db,chat.id,'user','message',i===0?'约定保留星图标记':'旧消息 '+i)
      message(f.app.db,chat.id,'assistant','message','答复 '+i)
    }
  })
  assert.equal((await api('/chat/persona')).source,'default')
  await api('/chat/persona',{text:'使用新称呼'})
  await api(path+'/messages',{text:'按照星图继续',requestId:'recall'})
  await eventually(()=>f.app.db.prepare('SELECT throughMessageId FROM thread_summaries WHERE threadId=?').get(chat.id))
  assert.equal(prompts[0].persona,'使用新称呼')
  assert.ok(prompts[0].olderMessages.some(m=>m.text.includes('约定保留')))
  assert.deepEqual(prompts[0].memory.map(r=>r.body),['星图使用摩羯座标记'])
  assert.equal((await api(path)).messages.length,72)
  await f.reopen()
  await api('/chat/persona',{reset:true})
  shouldFail=true
  await api(path+'/messages',{text:'下一轮保持约定',requestId:'failing'})
  await eventually(async()=>(await api(path)).messages.some(m=>m.kind==='error'&&m.text.includes('暂时不可用')))
  await api(path+'/messages',{text:'下一轮保持约定',requestId:'failing'})
  assert.equal(prompts.length,2)
  assert.equal(prompts[1].previousSummary,'早先约定保留星图标记')
  assert.notEqual(prompts[1].persona,'使用新称呼')
  assert.equal(f.app.db.prepare('SELECT COUNT(*) n FROM tasks').get().n,0)
  assert.ok((await api(path)).messages.every(m=>!m.text.includes('private-fixture-secret')))
})

test('旧版主库及连接器库迁移可重复打开，备份恢复前检查附件与绑定',t=>{
  const root=mkdtempSync(join(tmpdir(),'maoqiu-migration-'))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const old=join(root,'old'),connector=join(root,'node')
  mkdirSync(old);mkdirSync(connector)
  const db=new DatabaseSync(join(old,'workbench.sqlite'))
  initHome(db)
  const call=(path,body)=>homeApi(db,{path,body,dataDir:old,principal:owner,method:'POST',query:new URLSearchParams()})
  const p=call('/projects',{name:'可迁移项目'})
  const a=call('/attachments',{projectId:p.id,name:'附件',data:'QUJD'})
  const source=call('/submissions',{projectId:p.id,source:{title:'旧版迁移原件',attachmentIds:[a.id]}})
  db.exec(`
    PRAGMA user_version=1;
    CREATE TABLE grants(tokenHash TEXT PRIMARY KEY,id TEXT,projectId TEXT);
    CREATE TABLE run_grants(runId TEXT PRIMARY KEY REFERENCES runs(id),tokenHash TEXT UNIQUE,token TEXT,projectId TEXT,instanceId TEXT);
    CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,instanceId TEXT,projectId TEXT,taskId TEXT,sessionId TEXT,createdAt TEXT);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,originThreadId TEXT REFERENCES threads(id),workThreadId TEXT REFERENCES threads(id),instanceId TEXT,projectId TEXT,goal TEXT,brief TEXT,status TEXT,createdAt TEXT);
    CREATE TABLE runs(id TEXT PRIMARY KEY,threadId TEXT REFERENCES threads(id),taskId TEXT REFERENCES tasks(id),instanceId TEXT,status TEXT,nativeRunId TEXT,pendingRequest TEXT,createdAt TEXT);
  `)
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)').run('old-thread','旧记录','fixture',p.id,null,'old-session','2020')
  db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?)').run('old-run','old-thread',null,'fixture','queued',null,null,'2020')
  db.prepare('INSERT INTO grants VALUES(?,?,?)').run(hash('old-invitation'),'legacy',p.id)
  db.prepare('INSERT INTO run_grants VALUES(?,?,?,?,?)').run('old-run',hash('old-run-token'),'old-run-token',p.id,'fixture')
  db.close()
  const legacyConnector=new DatabaseSync(join(connector,'connector.sqlite'))
  legacyConnector.exec(`CREATE TABLE bindings(thread TEXT PRIMARY KEY,instance TEXT NOT NULL,workspace TEXT NOT NULL,session TEXT NOT NULL);
    INSERT INTO bindings VALUES('old-thread','fixture','old-workspace','old-session');`)
  legacyConnector.close()
  for(let i=0;i<2;i++){
    const migrated=openDatabase(old)
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version,4)
    assert.equal(migrated.prepare('SELECT sessionId FROM threads WHERE id=?').get('old-thread').sessionId,'old-session')
    assert.equal(migrated.prepare('SELECT count(*) n FROM run_grants').get().n,0)
    assert.ok(Date.parse(migrated.prepare('SELECT expiresAt FROM grants').get().expiresAt)>Date.now())
    const result=homeApi(migrated,{method:'GET',path:'/search',body:{},dataDir:old,principal:owner,query:new URLSearchParams({q:'迁移原件'})})
    assert.equal(result.items[0].id,source.sourceId)
    migrated.close()
    const store=new Store(join(connector,'connector.sqlite'))
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,1)
    assert.equal(store.db.prepare('SELECT session FROM bindings').get().session,'old-session')
    store.db.close()
  }
  writeFileSync(join(old,'persona.md'),'测试人格')
  const backup=join(root,'backup'),restored=join(root,'restored')
  transfer(old,backup,false,{connectorDir:connector})
  assert.throws(()=>transfer(backup,old,true),/尚未存在/)
  transfer(backup,restored,true)
  assert.equal(readFileSync(join(restored,'persona.md'),'utf8'),'测试人格')
  assert.equal(readFileSync(join(restored,'attachments',a.id),'utf8'),'ABC')
  const restoredConnector=new Store(join(restored,'node-local','connector.sqlite'))
  assert.equal(restoredConnector.db.prepare('SELECT session FROM bindings').get().session,'old-session')
  restoredConnector.db.close()
  const restoredDb=openDatabase(restored)
  const hit=homeApi(restoredDb,{method:'GET',path:'/search',body:{},dataDir:restored,principal:owner,query:new URLSearchParams({q:'迁移原件'})})
  assert.equal(hit.items[0].id,source.sourceId)
  restoredDb.close()
  writeFileSync(join(backup,'attachments',a.id),'截断')
  const invalid=join(root,'invalid')
  assert.throws(()=>transfer(backup,invalid,true),/附件长度/)
  assert.equal(existsSync(invalid),false)
})
