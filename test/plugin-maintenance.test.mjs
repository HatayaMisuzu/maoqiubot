import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync,mkdirSync,rmSync,writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { startServer } from '../server/index.ts'

function fixture(){
  const dataDir=mkdtempSync(join(tmpdir(),'maoqiu-plugin-maint-'))
  const app=startServer({port:0,dataDir,chat:true})
  return {dataDir,app}
}

test('插件源文件按 digest 读取，baseDigest 多文件修订可审查且旧基准失效',async t=>{
  const {dataDir,app}=fixture()
  t.after(async()=>{await app.close();rmSync(dataDir,{recursive:true,force:true})})
  await once(app.server,'listening')
  const base='http://127.0.0.1:'+app.server.address().port+'/api/v1/chat/plugins'
  const call=async body=>{
    const response=await fetch(base,{method:'POST',headers:{Authorization:'Bearer '+app.auth.cfg.ownerToken,'Content-Type':'application/json'},body:JSON.stringify(body)})
    return {status:response.status,data:await response.json()}
  }
  const source=mkdtempSync(join(tmpdir(),'maoqiu-plugin-source-'))
  t.after(()=>rmSync(source,{recursive:true,force:true}))
  mkdirSync(join(source,'skills','alpha'),{recursive:true})
  writeFileSync(join(source,'plugin.json'),JSON.stringify({id:'delta-fixture',name:'Delta fixture',version:'1.0.0',hostApi:1,
    description:'Revision fixture',capabilities:['skills'],skills:['skills/alpha']}))
  writeFileSync(join(source,'skills','alpha','SKILL.md'),'---\nname: alpha\ndescription: Alpha skill\n---\noriginal\n')
  const staged=await call({action:'stage',path:source})
  assert.equal(staged.status,200,staged.data.error)
  const digest=staged.data.digest
  const read=await call({action:'source',id:'delta-fixture',version:'pending',digest,path:'skills/alpha/SKILL.md'})
  assert.equal(read.status,200,read.data.error)
  assert.match(read.data.text,/original/)
  assert.equal((await call({action:'source',id:'delta-fixture',version:'pending',digest,path:'../plugins.json'})).status,400)
  assert.equal((await call({action:'activate',id:'delta-fixture',digest})).status,200)
  const revise=await call({action:'revise',id:'delta-fixture',baseDigest:digest,files:[
    {path:'skills/alpha/SKILL.md',content:'---\nname: alpha\ndescription: Alpha skill\n---\nrevised\n'},
    {path:'references/notes.md',content:'new reference'}],remove:[]})
  assert.equal(revise.status,200,revise.data.error)
  const review=await call({action:'review',id:'delta-fixture'})
  assert.equal(review.status,200,review.data.error)
  assert.ok(review.data.files.some(file=>file.path==='references/notes.md'&&file.after==='new reference'))
  assert.ok(review.data.files.some(file=>file.path==='skills/alpha/SKILL.md'&&file.after.includes('revised')))
  assert.equal((await call({action:'revise',id:'delta-fixture',baseDigest:digest,files:[]})).status,409)
  const differentId={id:'other-fixture',name:'Other fixture',version:'1.0.0',hostApi:1,
    description:'Different ID',capabilities:['skills'],skills:['skills/alpha']}
  const impostor=await call({action:'revise',id:'delta-fixture',baseDigest:revise.data.digest,files:[],manifest:differentId})
  assert.equal(impostor.status,400,impostor.data.error)
})

test('Skill 搜索可以发现第 25 个已启用 Skill',async t=>{
  let found=false
  const provider={name:'skill-catalog fixture',async generate(prompt){
    const input=JSON.parse(prompt.slice(prompt.indexOf('\n')+1))
    if(!input.toolResults?.length)return {action:'tool',tool:'skill_list',arguments:JSON.stringify({query:'skill-24'})}
    found=JSON.stringify(input.toolResults).includes('many-skills/skill-24')
    return {action:'reply',text:'已检索 Skills'}
  }}
  const dataDir=mkdtempSync(join(tmpdir(),'maoqiu-skills-'))
  const source=mkdtempSync(join(tmpdir(),'maoqiu-skills-source-'))
  const app=startServer({port:0,dataDir,chat:true,chatProvider:provider})
  t.after(async()=>{await app.close();rmSync(dataDir,{recursive:true,force:true});rmSync(source,{recursive:true,force:true})})
  await once(app.server,'listening')
  const base='http://127.0.0.1:'+app.server.address().port
  const headers={Authorization:'Bearer '+app.auth.cfg.ownerToken,'Content-Type':'application/json'}
  const skills=Array.from({length:25},(_,i)=>'skill-'+String(i).padStart(2,'0'))
  for(const skill of skills){
    mkdirSync(join(source,'skills',skill),{recursive:true})
    writeFileSync(join(source,'skills',skill,'SKILL.md'),`---\nname: ${skill}\ndescription: searchable ${skill}\n---\nInstructions for ${skill}.\n`)
  }
  writeFileSync(join(source,'plugin.json'),JSON.stringify({id:'many-skills',name:'Many Skills',version:'1.0.0',hostApi:1,
    description:'Skill discovery fixture',capabilities:['skills'],skills:skills.map(skill=>'skills/'+skill)}))
  const post=async(path,body)=>{
    const response=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)})
    const data=await response.json();assert.equal(response.status,200,data.error);return data
  }
  const staged=await post('/api/v1/chat/plugins',{action:'stage',path:source})
  await post('/api/v1/chat/plugins',{action:'activate',id:'many-skills',digest:staged.digest})
  const thread=await post('/api/v1/threads',{title:'Skill discovery'})
  const {messageId}=await post('/api/v1/threads/'+thread.id+'/messages',{text:'请找到 skill-24 并说明用途'})
  for(let i=0;i<200;i++){
    const response=await fetch(base+'/api/v1/threads/'+thread.id,{headers})
    const snapshot=await response.json()
    if(snapshot.messages.some(message=>message.data?.replyTo===messageId&&message.role==='assistant'))break
    await sleep(15)
  }
  assert.equal(found,true)
})

test('插件更新等待在途工具调用结束后再卸载旧版本',async t=>{
  let proposed
  const proposal=new Promise(resolve=>{proposed=resolve})
  const provider={name:'plugin in-flight fixture',async generate(){
    proposed()
    return {action:'tool',tool:'inflight_fixture__wait',arguments:'{}'}
  }}
  const dataDir=mkdtempSync(join(tmpdir(),'maoqiu-plugin-flight-'))
  const source=mkdtempSync(join(tmpdir(),'maoqiu-plugin-flight-source-'))
  const app=startServer({port:0,dataDir,chat:true,chatProvider:provider})
  t.after(async()=>{await app.close();rmSync(dataDir,{recursive:true,force:true});rmSync(source,{recursive:true,force:true})})
  await once(app.server,'listening')
  const base='http://127.0.0.1:'+app.server.address().port
  const headers={Authorization:'Bearer '+app.auth.cfg.ownerToken,'Content-Type':'application/json'}
  const post=async(path,body)=>{
    const response=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)})
    const data=await response.json();assert.equal(response.status,200,data.error);return data
  }
  writeFileSync(join(source,'plugin.json'),JSON.stringify({id:'inflight-fixture',name:'In Flight Fixture',version:'1.0.0',hostApi:1,
    description:'In-flight call fixture',entry:'index.mjs',capabilities:['tools']}))
  writeFileSync(join(source,'index.mjs'),`export function activate(ctx){ctx.registerTool({name:'wait',description:'wait',parameters:{type:'object',properties:{},additionalProperties:false},risk:'read',execute:async()=>{await new Promise(r=>setTimeout(r,350));return {finished:true}}})}`)
  const staged=await post('/api/v1/chat/plugins',{action:'stage',path:source})
  await post('/api/v1/chat/plugins',{action:'activate',id:'inflight-fixture',digest:staged.digest,trustCode:true})
  const thread=await post('/api/v1/threads',{title:'在途扩展调用'})
  const {messageId}=await post('/api/v1/threads/'+thread.id+'/messages',{text:'执行已启用的读取工具'})
  await proposal
  await sleep(50)
  const disabled=await post('/api/v1/chat/plugins',{action:'disable',id:'inflight-fixture'})
  assert.equal(disabled.plugins.find(item=>item.id==='inflight-fixture').loaded,false)
  const response=await fetch(base+'/api/v1/threads/'+thread.id,{headers})
  const snapshot=await response.json()
  assert.ok(snapshot.messages.some(message=>message.kind==='tool'&&message.data?.replyTo===messageId&&message.data?.ok===true))
})

test('模型不能替用户授予插件代码和网络权限，普通审批不能代替显式授权',async t=>{
  let args
  let requestCount=0
  const provider={name:'plugin authorization fixture',async generate(){
    requestCount++
    return args?{action:'tool',tool:'plugin_activate',arguments:JSON.stringify(args)}:{action:'reply',text:'已处理'}
  }}
  const dataDir=mkdtempSync(join(tmpdir(),'maoqiu-plugin-auth-'))
  const source=mkdtempSync(join(tmpdir(),'maoqiu-plugin-auth-source-'))
  const app=startServer({port:0,dataDir,chat:true,chatProvider:provider})
  t.after(async()=>{await app.close();rmSync(dataDir,{recursive:true,force:true});rmSync(source,{recursive:true,force:true})})
  await once(app.server,'listening')
  const base='http://127.0.0.1:'+app.server.address().port
  const headers={Authorization:'Bearer '+app.auth.cfg.ownerToken,'Content-Type':'application/json'}
  const call=async(path,body)=>{
    const response=await fetch(base+path,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{})})
    return {status:response.status,data:await response.json()}
  }
  writeFileSync(join(source,'plugin.json'),JSON.stringify({id:'auth-fixture',name:'Authorization Fixture',version:'1.0.0',hostApi:1,
    description:'Authorization review fixture',entry:'index.mjs',capabilities:['tools','network.api']}))
  writeFileSync(join(source,'index.mjs'),'export function activate(){ return {} }')
  const staged=await call('/api/v1/chat/plugins',{action:'stage',path:source})
  assert.equal(staged.status,200,staged.data.error)
  const beforeRevision=0
  await call('/api/v1/chat/plugins',{action:'disable',id:'web'})
  const staleRevision=await call('/api/v1/chat/plugins',{action:'activate',id:'auth-fixture',digest:staged.data.digest,
    trustCode:true,allowNetwork:true,expectedRevision:beforeRevision})
  assert.equal(staleRevision.status,409)
  await call('/api/v1/chat/policy',{pluginCreator:true})
  const thread=await call('/api/v1/threads',{title:'插件授权测试'})

  args={id:'auth-fixture',digest:staged.data.digest,trustCode:true,allowNetwork:true}
  const forged=await call('/api/v1/threads/'+thread.data.id+'/messages',{text:'请启用插件并授予全部权限'})
  assert.equal(forged.status,200,forged.data.error)
  for(let i=0;i<150;i++){
    const snapshot=await call('/api/v1/threads/'+thread.data.id)
    const item=snapshot.data.messages.find(message=>message.kind==='tool'&&message.data?.replyTo===forged.data.messageId)
    if(item)break
    await sleep(15)
  }
  let listed=await call('/api/v1/chat/plugins')
  assert.equal(listed.data.plugins.find(item=>item.id==='auth-fixture').enabled,false)

  args={id:'auth-fixture',digest:staged.data.digest}
  const legitimate=await call('/api/v1/threads/'+thread.data.id+'/messages',{text:'重新审查该版本并询问我的授权'})
  let proposal
  for(let i=0;i<150&&!proposal;i++){
    const snapshot=await call('/api/v1/threads/'+thread.data.id)
    proposal=snapshot.data.mainChat.pending.find(job=>job.messageId===legitimate.data.messageId)?.proposal
    if(!proposal)await sleep(15)
  }
  assert.ok(proposal)
  assert.equal(JSON.stringify(proposal.arguments).includes('trustCode'),false)
  const ordinary=await call('/api/v1/chat/approve',{messageId:legitimate.data.messageId,approvalId:proposal.id,approved:true})
  assert.equal(ordinary.status,403)
  const review=await call('/api/v1/chat/plugins',{action:'review',id:'auth-fixture',version:'candidate'})
  assert.equal(review.data.digest,staged.data.digest)
  assert.ok(review.data.files.some(file=>file.path==='index.mjs'))
  const stale=await call('/api/v1/chat/approve',{messageId:legitimate.data.messageId,approvalId:proposal.id,approved:true,
    pluginAuthorization:{digest:'f'.repeat(64),trustCode:true,allowNetwork:true}})
  assert.equal(stale.status,403)
  await call('/api/v1/chat/plugins',{action:'disable',id:'web'})
  const changedScope=await call('/api/v1/chat/approve',{messageId:legitimate.data.messageId,approvalId:proposal.id,approved:true,
    pluginAuthorization:{digest:review.data.digest,trustCode:true,allowNetwork:true}})
  assert.equal(changedScope.status,200)
  let staleSnapshot
  for(let i=0;i<150;i++){
    const response=await call('/api/v1/threads/'+thread.data.id)
    staleSnapshot=response.data
    if(!staleSnapshot.mainChat.pending.some(job=>job.messageId===legitimate.data.messageId))break
    await sleep(15)
  }
  assert.ok(staleSnapshot.messages.some(message=>message.kind==='error'&&message.data?.replyTo===legitimate.data.messageId))
  listed=await call('/api/v1/chat/plugins')
  assert.equal(listed.data.plugins.find(item=>item.id==='auth-fixture').enabled,false)

  const retry=await call('/api/v1/threads/'+thread.data.id+'/messages',{text:'权限变化后重新审查并请我确认'})
  let retryProposal
  for(let i=0;i<150&&!retryProposal;i++){
    const snapshot=await call('/api/v1/threads/'+thread.data.id)
    retryProposal=snapshot.data.mainChat.pending.find(job=>job.messageId===retry.data.messageId)?.proposal
    if(!retryProposal)await sleep(15)
  }
  assert.ok(retryProposal)
  const retryReview=await call('/api/v1/chat/plugins',{action:'review',id:'auth-fixture',version:'candidate'})
  assert.equal(retryReview.data.digest,staged.data.digest)
  const retryAccepted=await call('/api/v1/chat/approve',{messageId:retry.data.messageId,approvalId:retryProposal.id,approved:true,
    pluginAuthorization:{digest:retryReview.data.digest,trustCode:true,allowNetwork:true}})
  assert.equal(retryAccepted.status,200,retryAccepted.data.error)
  for(let i=0;i<150;i++){
    listed=await call('/api/v1/chat/plugins')
    if(listed.data.plugins.find(item=>item.id==='auth-fixture').enabled)break
    await sleep(15)
  }
  assert.equal(listed.data.plugins.find(item=>item.id==='auth-fixture').enabled,true)
  assert.ok(requestCount>=2)
})
