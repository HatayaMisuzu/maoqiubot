import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { startServer } from '../server/index.ts'
import { historyRead,historySearch,mainThread,readShareMaterial } from '../server/sessions.ts'
import { openDatabase } from '../server/db/index.ts'

test('并发初始化与重开只有一个永久主聊',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'maoqiu-race-'))
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const code="import {openDatabase} from './server/db/index.ts';const d=openDatabase(process.argv[1]);console.log(d.prepare(\"SELECT id FROM threads WHERE kind='main'\").get().id);d.close()"
  const ids=await Promise.all(Array.from({length:4},async()=>{
    const p=spawn(process.execPath,['--input-type=module','-e',code,dir],{stdio:['ignore','pipe','pipe'],windowsHide:true})
    let out='',err=''
    p.stdout.on('data',chunk=>out+=chunk)
    p.stderr.on('data',chunk=>err+=chunk)
    assert.equal((await once(p,'close'))[0],0,err)
    return out.trim()
  }))
  const db=openDatabase(dir)
  try{assert.deepEqual([...new Set(ids)],[mainThread(db).id])}finally{db.close()}
})

test('HTTP 会话创建幂等、中文历史、分享延迟发送、重置与软删除边界',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'maoqiu-sessions-'))
  const app=startServer({port:0,dataDir:dir,chat:false})
  await once(app.server,'listening')
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true})})
  async function api(path,b,status=200){
    const res=await fetch('http://127.0.0.1:'+app.server.address().port+'/api/v1'+path,{method:b?'POST':'GET',
      headers:{Authorization:'Bearer '+app.auth.cfg.ownerToken,'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined})
    const data=await res.json()
    assert.equal(res.status,status,JSON.stringify(data))
    return data
  }
  const main=await api('/threads/main')
  await api('/threads/'+main.id+'/lifecycle',{action:'delete'},409)
  const draft={requestId:'first',title:'周会',firstMessage:{text:'周会决定采用蓝色图标'}}
  const {thread,receipt}=await api('/threads',draft)
  assert.equal(thread.kind,'side')
  assert.equal((await api('/threads',draft)).thread.id,thread.id)
  const source='/threads/'+thread.id
  const search=()=>historySearch(app.db,main,undefined,{query:'蓝色图标'}).items
  assert.equal(search()[0].id,receipt.messageId)
  assert.equal(historyRead(app.db,main,undefined,{threadId:thread.id}).items[0].text,draft.firstMessage.text)
  assert.throws(()=>historyRead(app.db,main,{sharePersonal:false},{threadId:thread.id}),/未获准/)
  const project=await api('/projects',{name:'私有项目'})
  const other=await api('/threads',{projectId:project.id})
  assert.throws(()=>historyRead(app.db,other,undefined,{threadId:thread.id}),/可读范围/)
  await api(source+'/share',{targetThreadId:other.id,messageIds:[receipt.messageId]},403)
  const transfer={targetThreadId:other.id,messageIds:[receipt.messageId]}
  assert.equal((await api(source+'/share',{...transfer,preview:true})).crossProject,true)
  const transferred=await api(source+'/share',{...transfer,confirmCrossProject:true})
  assert.match(readShareMaterial(app.db,dir,other.id,transferred.shareId).text,/蓝色图标/)
  const asset=await api('/attachments',{projectId:project.id,name:'decision.txt',data:'QUJD'})
  const fileSource=await api('/threads',{projectId:project.id})
  const withFile=await api('/threads/'+fileSource.id+'/messages',{text:'带有项目附件',attachmentIds:[asset.id]})
  await api('/threads/'+fileSource.id+'/share',{targetThreadId:main.id,messageIds:[withFile.messageId],preview:true},403)
  const local=await api('/threads',{projectId:project.id})
  await api('/threads/'+fileSource.id+'/share',{targetThreadId:local.id,messageIds:[withFile.messageId]})
  const fileReceipt=await api('/threads/'+local.id+'/messages',{text:'查看分享的文件',materialRefs:[]})
  const relayed=(await api('/threads/'+local.id)).messages.find(m=>m.id===fileReceipt.messageId)
  assert.deepEqual(relayed.data.attachmentIds,[asset.id])
  const share={newThread:{instanceId:'main',title:'周会后续'},messageIds:[receipt.messageId]}
  const count=()=>app.db.prepare('SELECT count(*) n FROM threads').get().n
  const before=count(),preview=await api(source+'/share',{...share,preview:true})
  assert.equal(count(),before)
  assert.equal(preview.items[0].text,draft.firstMessage.text)
  const sent=await api(source+'/share',share)
  assert.equal(app.db.prepare('SELECT count(*) n FROM chat_jobs WHERE threadId=?').get(sent.targetThreadId).n,0)
  await api(source+'/lifecycle',{action:'archive'})
  assert.equal(search().length,1)
  await api(source+'/messages',{text:'归档的会话'},409)
  await api(source+'/lifecycle',{action:'delete'})
  assert.equal(search().length,0)
  await api(source,null,410)
  assert.equal((await api(source+'/impact')).canPurge,false)
  await api(source+'/lifecycle',{action:'purge',confirm:true},409)
  await api(source+'/lifecycle',{action:'restore'})
  await api(source+'/lifecycle',{action:'reset'})
  assert.equal(search().length,0)
  assert.equal((await api(source+'/export')).messages[0].text,draft.firstMessage.text)
  await api('/chat/cancel',{messageId:receipt.messageId})
  await api(source+'/lifecycle',{action:'deleteMessage',messageId:receipt.messageId})
  await api(source+'/lifecycle',{action:'delete'})
  await api(source+'/lifecycle',{action:'purge',confirm:true})
  assert.match(readShareMaterial(app.db,dir,sent.targetThreadId,sent.shareId).text,/蓝色图标/)
  const target='/threads/'+sent.targetThreadId
  await api(target+'/messages',{text:'无效的引用',materialRefs:'x'},400)
  const received=await api(target+'/messages',{text:'现在使用周会资料',materialRefs:[]})
  const first=(await api(target)).messages.find(m=>m.id===received.messageId)
  assert.deepEqual(first.refs.map(r=>r.id),[sent.shareId])
  const again=await api(target+'/messages',{text:'下一轮'})
  assert.deepEqual((await api(target)).messages.find(m=>m.id===again.messageId).refs,[])
})
