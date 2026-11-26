import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import WebSocket from 'ws'
import { startServer } from '../server/index.ts'
import { openDatabase, owner, transaction } from '../server/db/index.ts'
import { initHome, homeApi, recallMemory } from '../server/home/index.ts'
import { message } from '../server/tasks/index.ts'
import { Store } from '../connector/store.ts'
import { transfer } from '../scripts/backup.ts'
import { hash } from '../server/api/auth.ts'
import { addressAllowed, checkedAddresses, readHttp } from '../server/plugins/http.ts'
import { extractHtml } from '../plugins/web/index.ts'
import { fileURLToPath } from 'node:url'

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
async function node(fixture,receiptLookup=false,workspaceRef=fixture.dir){
  const frames=[]
  const ws=new WebSocket(fixture.base().replace('http:','ws:')+'/node',{headers:{Authorization:'Bearer '+fixture.app.auth.cfg.nodes.local}})
  ws.on('message',frame=>frames.push(JSON.parse(frame)))
  await once(ws,'open')
  const send=frame=>ws.send(JSON.stringify(frame))
  send({type:'hello',nodeId:'local',receiptLookup,instances:[{id:'worker',name:'Worker',workspaceRef,adapterKey:'test',availableActions:['run','cancel']},
    {id:'worker-b',name:'Worker B',workspaceRef,adapterKey:'test',availableActions:['run','cancel']}]})
  await eventually(async()=>(await fixture.api('/instances')).find(i=>i.id==='worker'&&i.online))
  return {frames,ws,send,command:runId=>eventually(()=>frames.find(f=>f.command?.runId===runId)?.command),
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

const modelChoice=(content,finish_reason='stop')=>({choices:[{message:{content},finish_reason}]})
async function modelEndpoint(t,handler){
  const model=createServer(async(req,res)=>{
    try{
      const chunks=[]
      for await(const chunk of req)chunks.push(chunk)
      const input=chunks.length?JSON.parse(Buffer.concat(chunks)):null
      await handler(req,res,input,data=>res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(data)))
    }catch{if(!res.headersSent)res.writeHead(500).end();else res.end()}
  })
  model.listen(0,'127.0.0.1')
  await once(model,'listening')
  t.after(()=>new Promise(resolve=>{model.closeAllConnections();model.close(resolve)}))
  return 'http://127.0.0.1:'+model.address().port+'/gateway'
}
async function configure(api,baseUrl,fields={}){
  const {models}=await api('/chat/models',{action:'save',name:'独立供应方',baseUrl,model:'fixture/structured-model',
    apiKey:'fixture-key-do-not-disclose',...fields})
  const configured=models.at(-1)
  await api('/chat/models',{action:'select',id:configured.id})
  return configured
}
const inputContext=request=>JSON.parse(request.messages.at(-1).content)
async function replyTo(api,threadId,messageId,kind='message'){
  return eventually(async()=>(await api('/threads/'+threadId)).messages.find(m=>
    m.data.replyTo===messageId&&m.kind===kind&&(kind!=='message'||m.role==='assistant')))
}
async function approveTool(api,threadId,messageId,approved=true){
  return eventually(async()=>{
    const snapshot=await api('/threads/'+threadId)
    const waiting=snapshot.mainChat.pending.find(p=>p.messageId===messageId&&p.proposal)
    if(waiting)return api('/chat/approve',{messageId,approvalId:waiting.proposal.id,approved})
    if(snapshot.messages.some(m=>m.data.replyTo===messageId&&(m.role==='assistant'||m.kind==='error')))return {status:'finished'}
  })
}

const proposed=async(api,threadId,messageId)=>eventually(async()=>(await api('/threads/'+threadId))
  .mainChat.pending.find(p=>p.messageId===messageId&&p.proposal)?.proposal)

test('四种流式协议通过 HTTP 保留本轮工具身份并返回实际计算结果',async t=>{
  const name='utility_calculate',id='tool-phase3-123',args={expression:'(0.1+0.2)*7/3'}
  const requests=[]
  let interrupted=false
  const endpoint=await modelEndpoint(t,(req,res,input)=>{
    const {url,headers}=req
    const chat=url.endsWith('/chat/completions'),responses=url.endsWith('/responses'),anthropic=url.endsWith('/messages')
    requests.push({url,headers,input,chat,responses,anthropic})
    const result=chat?input.messages.at(-1).role==='tool'&&input.messages.at(-1).content:responses?input.input.at(-1).output:
      anthropic?input.messages.at(-1).content[0].type==='tool_result'&&input.messages.at(-1).content[0].content:
        input.contents.at(-1).parts[0].functionResponse?.response
    const txt='四则运算结果为 0.7'
    let frames
    if(chat){
      frames=result&&!interrupted?[{choices:[{delta:{content:txt},finish_reason:'stop'}]}]:[
        {choices:[{delta:{tool_calls:[{index:0,id,function:{name,arguments:JSON.stringify(args).slice(0,12)}}]}}]},
        ...interrupted?[]:[{choices:[{delta:{tool_calls:[{index:0,function:{arguments:JSON.stringify(args).slice(12)}}]},finish_reason:'tool_calls'}]}]]
    }else if(responses){
      frames=[{type:'response.completed',response:{status:'completed',output:result?
        [{type:'message',role:'assistant',content:[{type:'output_text',text:txt}]}]:
        [{type:'function_call',id:'fc_fixture',call_id:id,name,arguments:JSON.stringify(args),status:'completed'}]}}]
    }else if(anthropic){
      frames=[{type:'content_block_start',index:0,content_block:result?{type:'text',text:txt}:{type:'tool_use',id,name,input:{}}},
        ...result?[]:[{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(args)}}],
        {type:'message_delta',delta:{stop_reason:result?'end_turn':'tool_use'}},{type:'message_stop'}]
    }else{
      frames=[{candidates:[{content:{parts:[result?{text:txt}:{functionCall:{id,name,args},thoughtSignature:'fixture-signature'}]},finishReason:'STOP'}]}]
    }
    res.writeHead(200,{'Content-Type':'text/event-stream'})
    for(const frame of frames)res.write('data: '+JSON.stringify(frame)+'\n\n')
    res.end()
  })
  const {api}=await server(t,{chat:true})
  for(const protocol of ['openai-compatible','openai-responses','anthropic','gemini']){
    await configure(api,endpoint,{protocol,model:protocol==='gemini'?'gemini-fixture':'fixture/structured-model',tools:true,stream:true})
    const thread=await api('/threads',{title:protocol})
    const before=requests.length
    const job=await api('/threads/'+thread.id+'/messages',{text:'计算 (0.1+0.2)*7/3'})
    assert.equal((await replyTo(api,thread.id,job.messageId)).text,'四则运算结果为 0.7')
    const [first,next]=requests.slice(before)
    assert.equal(requests.length,before+2)
    const {input,headers}=next
    assert.ok(first.input.tools?.length)
    assert.equal(headers['x-api-key']??headers['x-goog-api-key']??headers.authorization?.slice(7),'fixture-key-do-not-disclose')
    if(next.chat){
      assert.equal(input.messages.at(-1).tool_call_id,id)
      assert.equal(input.messages.at(-2).tool_calls[0].id,id)
      assert.equal(input.response_format,undefined)
    }else if(next.responses){
      assert.equal(input.input.at(-1).call_id,id)
      assert.equal(input.input.at(-1).type,'function_call_output')
      assert.equal(input.input.at(-2).id,'fc_fixture')
      assert.equal(input.store,false)
    }else if(next.anthropic){
      assert.equal(input.messages.at(-1).content[0].tool_use_id,id)
      assert.equal(input.messages.at(-2).role,'assistant')
      assert.equal(headers['anthropic-version'],'2023-06-01')
    }else{
      assert.match(next.url,/streamGenerateContent\?alt=sse$/)
      assert.equal(input.contents.at(-1).parts[0].functionResponse.id,id)
      assert.equal(input.contents.at(-2).parts[0].thoughtSignature,'fixture-signature')
    }
    assert.match(JSON.stringify(input),/7\/10/)
  }
  interrupted=true
  await configure(api,endpoint,{tools:true,stream:true})
  const thread=await api('/threads',{title:'未完成的工具流'})
  const job=await api('/threads/'+thread.id+'/messages',{text:'收到完整回复后才计算'})
  await replyTo(api,thread.id,job.messageId,'error')
  assert.equal((await api('/threads/'+thread.id)).messages.some(m=>m.kind==='tool'),false)
})

test('撤销外部模型授权中止在途请求，危险操作须使用有效的所有者确认',async t=>{
  let arrived=false,closed=false
  const endpoint=await modelEndpoint(t,(_req,res)=>{
    arrived=true
    res.once('close',()=>{closed=true})
  })
  const {api}=await server(t,{chat:true})
  const model=await configure(api,endpoint,{sharePersonal:true})
  const thread=await api('/threads',{title:'在途撤销'})
  const job=await api('/threads/'+thread.id+'/messages',{text:'外部模型正在处理'})
  await eventually(()=>arrived)
  await api('/chat/models',{action:'select',id:'codex'})
  await eventually(()=>closed)
  assert.match((await replyTo(api,thread.id,job.messageId,'error')).text,/授权发生变化/)
  assert.ok(model.id)

  const fixture=await server(t,{chat:true,chatProvider:{
    generate:async()=>({action:'tool',tool:'utility_daily',arguments:JSON.stringify({action:'create',kind:'todo',body:'核对边界'})})
  }})
  const origin=await fixture.api('/threads',{title:'等待批准'})
  const first=await fixture.api('/threads/'+origin.id+'/messages',{text:'只问能否创建，不要做'})
  const proposal=await proposed(fixture.api,origin.id,first.messageId)
  const path='/chat/daily?threadId='+origin.id
  assert.equal((await fixture.api(path)).items.length,0)
  await fixture.api('/chat/approve',{messageId:first.messageId,approvalId:'wrong',approved:true},{status:409})
  const request={messageId:first.messageId,approvalId:proposal.id,approved:true}
  await fixture.api('/chat/approve',request,{token:'not-an-owner',status:401})
  await fixture.api('/chat/approve',{...request,approved:false})
  assert.equal((await fixture.api(path)).items.length,0)
})

test('两次批准及服务重启保留原生调用回执，日常授权仅放行允许的写入',async t=>{
  const results=[]
  const future=new Date(Date.now()+3600000).toISOString()
  const endpoint=await modelEndpoint(t,(_req,_res,input,json)=>{
    const ctx=JSON.parse(input.messages.find(m=>m.role==='user').content)
    const tools=input.messages.filter(m=>m.role==='tool').map(m=>[m.tool_call_id,JSON.parse(m.content).result])
    results.push(tools)
    const call=(id,name,args)=>json({choices:[{finish_reason:'tool_calls',message:{
      tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]})
    if(ctx.currentUserRequest==='请新建普通待办'){
      if(!tools.length)call('routine','utility_daily',{action:'create',kind:'todo',body:'例行检查'})
      else json(modelChoice(tools[0][1].body))
    }else if(ctx.currentUserRequest==='请删除原来的待办'){
      call('delete','utility_daily',{action:'delete',id:'must-confirm'})
    }else if(!tools.length)call('math','utility_calculate',{expression:'17*3'})
    else if(tools.length===1)call('todo','utility_daily',{action:'create',kind:'todo',body:'按计算结果执行'})
    else if(tools.length===2)call('reminder','utility_daily',{action:'create',kind:'reminder',body:'提醒复查',dueAt:future})
    else json(modelChoice('核对结果 '+tools[0][1].value+'，'+tools[1][1].body+'，'+tools[2][1].body))
  })
  const f=await server(t,{chat:true}),{api}=f
  await configure(api,endpoint,{tools:true,sharePersonal:true})
  const thread=await api('/threads',{title:'批准续跑'})
  const ask=text=>api('/threads/'+thread.id+'/messages',{text})
  const first=await ask('先计算再建待办和提醒')
  const approve=proposal=>api('/chat/approve',{messageId:first.messageId,approvalId:proposal.id,approved:true})
  const todo=await proposed(api,thread.id,first.messageId)
  assert.equal(todo.arguments.kind,'todo')
  await f.reopen()
  await approve(todo)
  const reminder=await proposed(api,thread.id,first.messageId)
  assert.equal(reminder.arguments.kind,'reminder')
  await approve(reminder)
  assert.match((await replyTo(api,thread.id,first.messageId)).text,/51.*按计算结果执行.*提醒复查/)
  assert.deepEqual(results.map(messages=>messages.map(([id])=>id)),[[],['math'],['math','todo'],['math','todo','reminder']])
  const receipts=(await api('/threads/'+thread.id)).messages.filter(m=>m.kind==='tool'&&m.data.replyTo===first.messageId)
  assert.deepEqual(receipts.map(m=>[m.data.tool,m.data.step]),[['utility_calculate',1],['utility_daily',2],['utility_daily',3]])
  assert.equal((await api('/chat/daily?threadId='+thread.id)).items.length,2)
  await api('/chat/policy',{routineWrites:true})
  const routine=await ask('请新建普通待办')
  assert.equal((await replyTo(api,thread.id,routine.messageId)).text,'例行检查')
  const deleting=await ask('请删除原来的待办')
  assert.equal((await proposed(api,thread.id,deleting.messageId)).arguments.action,'delete')
})

test('自然主聊创建代码草稿，所有者审查后激活、更新、回退并调用 Pi 包装工具',async t=>{
  const manifest=version=>({id:'creator-test',name:'换算扩展',description:'可用性测试',version,hostApi:1,capabilities:['tools']})
  const entry=n=>n===3?'export function activate(){throw new Error("fixture")}':
    'export function activate(ctx){ctx.registerTool({name:"format",description:"格式化样值",risk:"read",parameters:{type:"object"},execute(){return {value:'+n+'}}})}'
  const provider={async generate(prompt){
    const ctx=JSON.parse(prompt.slice(prompt.indexOf('\n{')+1))
    const reply=text=>({action:'reply',text})
    const tool=(name,args)=>({action:'tool',tool:name,arguments:JSON.stringify(args)})
    if(ctx.toolResults?.length)return reply(JSON.stringify(ctx.toolResults[0]))
    const version=Number(ctx.currentUserRequest.at(-1))
    if(ctx.currentUserRequest.startsWith('帮我创建')){
      return tool('plugin_scaffold',{manifest:manifest(version+'.0.0'),source:entry(version)})
    }
    if(ctx.currentUserRequest.startsWith('Pi'))return tool('pi_unit_conversion__meters_to_cm',{meters:9})
    return ctx.availableTools.some(t=>t.name==='creator_test__format')?tool('creator_test__format',{}):reply('扩展工具不可用')
  }}
  const f=await server(t,{chat:true,chatProvider:provider}),{api}=f
  const plugins=(action,id,fields={})=>api('/chat/plugins',{action,id,...fields})
  await api('/chat/policy',{pluginCreator:true})
  const thread=await api('/threads',{title:'自然扩展能力'})
  const ask=async(text,confirm=false)=>{
    const {messageId}=await api('/threads/'+thread.id+'/messages',{text})
    if(confirm){
      const proposal=await proposed(api,thread.id,messageId)
      assert.equal(proposal.tool,'plugin_scaffold')
      await api('/chat/approve',{messageId,approvalId:proposal.id,approved:true})
    }
    return replyTo(api,thread.id,messageId)
  }
  for(const n of [1,2,3]){
    assert.match((await ask('帮我创建换算扩展版本 '+n,true)).text,/"ok":true/)
    const draft=(await api('/chat/plugins')).plugins.find(p=>p.id==='creator-test')
    assert.equal(draft.current?.manifest.version,n===1?undefined:(n-1)+'.0.0')
    assert.equal(draft.pending.source,'creator')
    const proof=await plugins('validate','creator-test')
    assert.equal(proof.executed,false)
    const review=await plugins('review','creator-test')
    assert.ok(JSON.stringify(review).includes('index.mjs'))
    await api('/chat/plugins',{action:'activate',id:'creator-test',digest:proof.digest},{status:403})
    if(n===3){
      await api('/chat/plugins',{action:'activate',id:'creator-test',digest:proof.digest,trustCode:true},{status:409})
      const preserved=(await api('/chat/plugins')).plugins.find(p=>p.id==='creator-test')
      assert.equal(preserved.current.manifest.version,'2.0.0')
      assert.equal(preserved.loaded,true)
      assert.equal(preserved.pending.digest,proof.digest)
    }else await plugins('activate','creator-test',{digest:proof.digest,trustCode:true})
    assert.match((await ask('用扩展测试')).text,new RegExp('"value":'+Math.min(n,2)))
  }
  const prior=(await api('/chat/plugins')).plugins.find(p=>p.id==='creator-test').previous
  await plugins('rollback','creator-test',{digest:prior.digest,trustCode:true})
  assert.match((await ask('用扩展测试')).text,/"value":1/)
  await plugins('disable','creator-test')
  assert.equal((await ask('用扩展测试')).text,'扩展工具不可用')
  const pi=await plugins('stage',undefined,{path:fileURLToPath(new URL('../plugins/examples/pi-unit-conversion/',import.meta.url))})
  await plugins('activate',pi.id,{digest:pi.digest,trustCode:true})
  assert.match((await ask('Pi 工具把 9 米换成厘米')).text,/900/)
  const archive=await plugins('export',pi.id)
  assert.ok(Buffer.from(archive.data,'base64').length>160)
  process.env.MAOQIU_SAFE_PLUGINS='1'
  try{await f.reopen()}finally{delete process.env.MAOQIU_SAFE_PLUGINS}
  assert.equal((await api('/chat/plugins')).plugins.find(p=>p.id===pi.id).loaded,false)
})

test('网页读取限制公开地址与重定向，声明式业务 API 和 SearXNG 在 LAN 内实际往返',async t=>{
  for(const ip of ['127.0.0.1','0.0.0.0','169.254.169.254','198.18.0.1','::1','::ffff:10.1.2.3','fe80::1']){
    assert.equal(addressAllowed(ip,'public'),false,ip)
  }
  const publicUrl=new URL('https://example.org/')
  await assert.rejects(checkedAddresses(publicUrl,'public',async()=>[
    {address:'8.8.8.8',family:4},{address:'10.0.0.2',family:4}]),/不可访问/)
  const article=extractHtml('<html><head><title>验收文章</title></head><body><nav>菜单内容</nav><article><p>'+
    '独立正文内容 '.repeat(100)+'</p><p><a href="/more">后续资料</a><a href="javascript:alert(1)">坏链接</a></p>'+
    '<script>SHOULD_NOT_APPEAR</script></article></body></html>','https://example.org/article')
  assert.equal(article.title,'验收文章')
  assert.match(article.body,/独立正文内容/)
  assert.doesNotMatch(article.body,/菜单内容|SHOULD_NOT_APPEAR/)
  assert.deepEqual(article.links.map(link=>link.url),['https://example.org/more'])

  const local=Object.values(networkInterfaces()).flat().find(n=>n?.family==='IPv4'&&!n.internal&&addressAllowed(n.address,'lan'))
  assert.ok(local,'测试需使用真实非 loopback 接口')
  const requests=[]
  const networkServer=createServer(async(req,res)=>{
    const parts=[]
    for await(const part of req)parts.push(part)
    const url=new URL(req.url,'http://'+req.headers.host)
    requests.push({url,method:req.method,auth:req.headers.authorization,body:Buffer.concat(parts).toString()})
    if(url.pathname==='/oversized'){res.writeHead(200,{'Content-Length':4096}).end('x'.repeat(4096));return}
    if(url.pathname==='/bad-redirect'){res.writeHead(302,{Location:'http://127.0.0.1/secret'}).end();return}
    const data=url.pathname==='/search'?{results:[{url:'https://example.org/fact',title:'公开资料',content:'等待核对'}]}:{result:{value:'LAN_OK'}}
    res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(data))
  })
  networkServer.listen(0,'0.0.0.0')
  await once(networkServer,'listening')
  t.after(()=>new Promise(resolve=>{networkServer.closeAllConnections();networkServer.close(resolve)}))
  const endpoint='http://'+local.address+':'+networkServer.address().port
  const signal=new AbortController().signal
  await assert.rejects(readHttp(endpoint+'/bad-redirect',{signal,network:'lan',redirects:2}),/超出|不可访问/)
  await assert.rejects(readHttp(endpoint+'/oversized',{signal,network:'lan',maxBytes:1024}),/大小|上限/)
  const keyEnv='MAOQIU_PLUGIN_KEY_PHASE3_FIXTURE'
  process.env[keyEnv]='test-authentication-value'
  t.after(()=>delete process.env[keyEnv])

  const provider={async generate(prompt){
    const ctx=JSON.parse(prompt.slice(prompt.indexOf('\n{')+1))
    if(ctx.currentUserRequest.includes('RFC')){
      const last=ctx.toolResults?.[0]?.result?.query
      if(!last)return {action:'tool',tool:'web__search',arguments:'{"query":"RFC 9110 HTTP Semantics site:rfc-editor.org"}'}
      if(last.startsWith('RFC 9110'))return {action:'tool',tool:'web__search',arguments:'{"query":"HTTP status codes specification RFC 9110 Section 15"}'}
    }
    if(ctx.toolResults?.length)return {action:'reply',text:JSON.stringify(ctx.toolResults[0])}
    if(ctx.currentUserRequest.includes('假冒搜索'))return {action:'tool',tool:'web__search',arguments:'{"query":"api_key=fixture-private-key"}'}
    return {action:'tool',tool:ctx.currentUserRequest.includes('写入')?'fixture_api__write':'fixture_api__lookup',arguments:'{"value":"abc"}'}
  }}
  const {api}=await server(t,{chat:true,chatProvider:provider})
  const parameters={type:'object',required:['value'],additionalProperties:false,properties:{value:{type:'string'}}}
  const draft=await api('/chat/plugins',{action:'stageManifest',manifest:{id:'fixture-api',version:'1.0.0',hostApi:1,
    name:'API Fixture',description:'用户隔离的业务地址',capabilities:['tools','network.api'],
    httpTools:[
      {name:'lookup',description:'查业务',parameters,endpoint,privateLan:true,method:'GET',path:'/lookup/{value}',query:{keyword:'value'},keyEnv,outputPath:['result']},
      {name:'write',description:'写业务',parameters,endpoint,privateLan:true,method:'POST',path:'/write',keyEnv,body:{input:'value'}}
    ]}})
  await api('/chat/plugins',{action:'activate',...draft},{status:403})
  await api('/chat/plugins',{action:'activate',...draft,allowNetwork:true})
  const thread=await api('/threads',{title:'业务 API'})
  const ask=text=>api('/threads/'+thread.id+'/messages',{text})
  const read=await ask('查询业务数据')
  assert.match((await replyTo(api,thread.id,read.messageId)).text,/LAN_OK/)
  assert.equal(requests.at(-1).url.pathname,'/lookup/abc')
  assert.equal(requests.at(-1).url.searchParams.get('keyword'),'abc')
  assert.equal(requests.at(-1).auth,'Bearer test-authentication-value')
  const write=await ask('写入业务数据')
  const proposal=await proposed(api,thread.id,write.messageId)
  assert.equal(requests.some(r=>r.method==='POST'),false)
  await api('/chat/approve',{messageId:write.messageId,approvalId:proposal.id,approved:true})
  assert.match((await replyTo(api,thread.id,write.messageId)).text,/LAN_OK/)
  assert.deepEqual(requests.filter(r=>r.method==='POST').map(r=>r.body),['{"input":"abc"}'])

  const web=(await api('/chat/plugins')).plugins.find(p=>p.id==='web')
  await api('/chat/plugins',{action:'configure',id:'web',config:{provider:'searxng',endpoint:endpoint+'/search',privateLan:true}})
  await api('/chat/plugins',{action:'activate',id:'web',digest:web.current.digest,allowNetwork:true})
  const result=await api('/chat/plugins',{action:'test',id:'web',input:{kind:'search',value:'公开主题'}})
  assert.equal(result.results[0].url,'https://example.org/fact')
  assert.equal(requests.at(-1).auth,undefined)
  assert.equal(requests.at(-1).url.searchParams.get('q'),'公开主题')
  const rewritten=await ask('帮我查查 HTTP 的 RFC 原始规范')
  assert.match((await replyTo(api,thread.id,rewritten.messageId)).text,/公开资料/)
  assert.deepEqual(requests.slice(-2).map(r=>r.url.searchParams.get('q')),
    ['RFC 9110 HTTP Semantics site:rfc-editor.org','HTTP status codes specification RFC 9110 Section 15'])
  const n=requests.length
  const injected=await ask('假冒搜索词，不允许转发项目资料')
  assert.match((await replyTo(api,thread.id,injected.messageId)).text,/凭据/)
  assert.equal(requests.length,n)
  await api('/chat/plugins',{action:'disable',id:'web'})
  assert.equal((await api('/chat/plugins')).plugins.find(p=>p.id==='web').skills.length,0)
})

test('网页研究经环境代理核对 robots、正文和后续链接，后续话题轮次可继续读取',async t=>{
  const publicOrigin='http://93.184.215.14'
  const flows=[],seen=[],proxySockets=new Set()
  const target=createServer((req,res)=>{
    flows.push([req.url,req.headers.host,req.headers['proxy-authorization']])
    if(req.url==='/robots.txt'){res.writeHead(404).end();return}
    if(req.url==='/article'){
      res.writeHead(200,{'Content-Type':'text/html'}).end('<html><head><title>首个来源</title></head><body><article><p>'+
        '研究需要追溯原始出处。'.repeat(45)+'</p><a href="/source">原始出处</a><a href="/next">补充来源</a></article></body></html>')
      return
    }
    if(req.url==='/source'||req.url==='/next'){res.writeHead(200,{'Content-Type':'text/plain'}).end('源证据 '+req.url);return}
    res.writeHead(302,{Location:'http://127.0.0.1/admin'}).end()
  }).listen(0,'127.0.0.1')
  await once(target,'listening')
  t.after(()=>new Promise(resolve=>{target.closeAllConnections();target.close(resolve)}))
  const proxy=createServer().listen(0,'127.0.0.1')
  proxy.on('connect',(req,socket,head)=>{
    const upstream=connect(target.address().port,'127.0.0.1')
    seen.push([req.url,req.headers['proxy-authorization']])
    proxySockets.add(socket)
    socket.once('close',()=>{proxySockets.delete(socket);upstream.destroy()})
    upstream.once('error',()=>socket.destroy())
    upstream.once('connect',()=>{
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if(head.length)upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
  })
  await once(proxy,'listening')
  t.after(()=>new Promise(resolve=>{for(const socket of proxySockets)socket.destroy();proxy.close(resolve)}))
  const prior=Object.fromEntries(['HTTP_PROXY','NO_PROXY'].map(key=>[key,process.env[key]]))
  process.env.HTTP_PROXY='http://proxy-user:proxy-pass@127.0.0.1:'+proxy.address().port
  delete process.env.NO_PROXY
  t.after(()=>{for(const [key,value] of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value}})
  const tool=(name,args)=>({action:'tool',tool:name,arguments:JSON.stringify(args)})
  const {api}=await server(t,{chat:true,chatProvider:{async generate(prompt){
    const ctx=JSON.parse(prompt.slice(prompt.indexOf('\n{')+1))
    const last=ctx.toolResults?.[0]
    if(last?.result?.links?.length)return tool('web__read',{url:last.result.links[0].url})
    if(last)return {action:'reply',text:last.result?.body??last.error}
    return tool('web__read',{url:ctx.currentUserRequest.startsWith('继续')?ctx.recentWeb.find(link=>link.title==='补充来源').url:publicOrigin+'/article'})
  }}})
  const web=(await api('/chat/plugins')).plugins.find(p=>p.id==='web')
  await api('/chat/plugins',{action:'activate',id:'web',digest:web.current.digest,allowNetwork:true})
  const thread=await api('/threads',{title:'公开网页研究'})
  const ask=text=>api('/threads/'+thread.id+'/messages',{text})
  const first=await ask('打开 '+publicOrigin+'/article 并追溯原始出处')
  assert.match((await replyTo(api,thread.id,first.messageId)).text,/源证据 \/source/)
  const next=await ask('继续核对刚刚页面中的补充来源')
  assert.match((await replyTo(api,thread.id,next.messageId)).text,/源证据 \/next/)
  const redirect=await api('/chat/plugins',{action:'test',id:'web',input:{kind:'read',value:publicOrigin+'/redirect'}},{status:403})
  assert.match(redirect.error,/授权范围|不可访问/)
  assert.ok(flows.every(([path])=>path!=='/admin'))
  assert.ok(seen.length>=6)
  assert.ok(seen.every(([host,auth])=>host==='93.184.215.14:80'&&auth==='Basic '+Buffer.from('proxy-user:proxy-pass').toString('base64')))
  assert.deepEqual([...new Set(flows.map(([,host])=>host))],['93.184.215.14'])
  assert.ok(flows.every(([, ,auth])=>auth===undefined))
})

test('非项目通信令牌只能报告本运行，重要消息幂等入队且暂停时不接管',async t=>{
  const f=await server(t,{chat:true}),{api,app}=f,n=await node(f,true)
  t.after(()=>n.ws.terminate())
  const thread=await api('/threads',{title:'无项目协作'})
  const task=await api('/tasks',{instanceId:'worker',originThreadId:thread.id,goal:'只回报工作',coordination:'notify'})
  const run=(await api('/tasks/'+task.taskId)).run
  const command=await n.command(run.id)
  const token=command.payload.communicationAccess.token
  assert.equal(command.payload.homeAccess,undefined)
  await n.receipt(command,'received')
  const path='/runs/'+run.id+'/communication'
  const body={kind:'question',text:'是否有现成模板？',requestId:'non-project-question',sender:{kind:'user',id:'owner'}}
  const count=()=>app.db.prepare("SELECT count(*) AS n FROM chat_jobs WHERE kind='coordination'").get().n
  await api('/projects',null,{token,status:403})
  await api('/runs/a-different-run/communication',body,{token,status:403})
  await api(path,{kind:'progress',text:'已开始',requestId:'non-project-progress'},{token})
  assert.equal(count(),0)
  const report=await api(path,body,{token})
  assert.deepEqual(await api(path,body,{token}),report)
  assert.equal(count(),1)
  const notice=await eventually(async()=>(await api('/threads/'+thread.id)).messages.find(m=>m.data.communicationId))
  assert.equal(notice.data.communication.sender.kind,'main_bot')
  const original=(await api('/threads/'+task.workThreadId)).messages.find(m=>m.kind==='communication'&&m.text===body.text)
  assert.equal(original.data.communication.sender.kind,'work_bot')
  await api('/tasks/'+task.taskId+'/coordination',{paused:true})
  await api(path,{...body,requestId:'paused-question'},{token})
  assert.equal(count(),1)
})

test('项目协调引用确认事实、限定交接目标并自动通知交付',async t=>{
  const workspace=mkdtempSync(join(tmpdir(),'maoqiu-delivery-'))
  t.after(()=>rmSync(workspace,{recursive:true,force:true}))
  writeFileSync(join(workspace,'readme.md'),'用于交付的公开版本说明')
  const contexts=[]
  const f=await server(t,{chat:true,chatProvider:{async generate(prompt){
    const ctx=JSON.parse(prompt.slice(prompt.indexOf('\n{')+1))
    contexts.push(ctx)
    if(ctx.currentUserRequest?.startsWith('核对交付和维护状态')){
      if(!ctx.toolResults.length)return {action:'tool',tool:'maintenance_status',arguments:'{}'}
      if(ctx.toolResults.length===1)return {action:'tool',tool:'task_check_delivery',
        arguments:JSON.stringify({taskId:ctx.currentUserRequest.split(' ')[1],includeExcerpt:true})}
      return {action:'reply',text:JSON.stringify(ctx.toolResults)}
    }
    if(ctx.type==='question'&&!ctx.toolResults.length)return {action:'tool',tool:'task_coordination_status',arguments:JSON.stringify({taskId:ctx.taskId})}
    if(ctx.type==='question')return {action:'tool',tool:'reply_fact',arguments:JSON.stringify({recordIds:[ctx.facts[0].id]})}
    if(ctx.type==='delivery')return {action:'tool',tool:'request_evidence',arguments:'{}'}
    if(ctx.type==='handoff')return {action:'tool',tool:'handoff',arguments:JSON.stringify({instanceId:ctx.requestTarget})}
    return {action:'reply',text:'请由用户选择方案'}
  }}}),{api}=f,n=await node(f,true,workspace)
  t.after(()=>n.ws.terminate())
  await api('/chat/persona',{text:'用清晰中文汇报协调进度'})
  await api('/chat/policy',{readRoots:[workspace]})
  const p=await api('/projects',{name:'有限协调范围'})
  for(const instanceId of ['worker','worker-b'])await api('/projects/'+p.id+'/workspaces',{instanceId,workspaceRef:workspace,allowAgentAccess:true})
  const fact=await api('/records',{projectId:p.id,type:'requirement',body:'交付目录为 release-notes',confirmation:'user'})
  const origin=await api('/threads',{projectId:p.id})
  const assignment=await api('/tasks',{originThreadId:origin.id,instanceId:'worker',goal:'整理交付说明',
    coordination:'handoff',handoffTargets:['worker-b']})
  const work=await api('/tasks/'+assignment.taskId)
  const first=await n.command(work.run.id)
  const path='/runs/'+first.runId+'/communication'
  const token=first.payload.communicationAccess.token
  await n.receipt(first,'received')
  const question=await api(path,{kind:'question',text:'交付目录是什么？',requestId:'facts-request'},{token})
  const follow=await eventually(async()=>(await api('/threads/'+work.task.workThreadId)).commands.find(c=>c.status==='waiting'&&c.payload.text?.includes('release-notes')))
  assert.equal(follow.payload.communication.sender.kind,'main_bot')
  assert.match(follow.payload.text,new RegExp(fact.id))
  assert.equal(follow.payload.communication.replyTo,question.id)
  assert.equal(contexts[0].persona,'用清晰中文汇报协调进度')
  assert.ok(contexts[0].availableTools.some(t=>t.name==='task_check_delivery'))
  assert.ok(!contexts[0].availableTools.some(t=>t.name==='task_delegate'))
  assert.equal(contexts[1].toolResults[0].result.scope.mode,'handoff')
  await api(path,{kind:'handoff',text:'目录已确认，可由第二个 Bot 接续',recipientInstanceId:'worker-b',
    requestId:'auto-handoff',version:'v1',remaining:['写交付说明']},{token})
  const child=await eventually(()=>n.frames.find(frame=>frame.command?.instanceId==='worker-b')?.command)
  assert.equal(child.payload.communication.sender.kind,'main_bot')
  assert.equal(child.payload.communication.projectId,p.id)
  const childTask=(await api('/tasks/'+child.taskId)).task
  assert.equal(childTask.brief.coordination.parentTaskId,assignment.taskId)
  assert.equal(childTask.brief.coordination.mode,'notify')
  await n.receipt(child,'received')
  await api('/runs/'+child.runId+'/communication',{kind:'delivery',text:'交付说明已写',requestId:'auto-delivery',
    version:'r7',completed:['说明'],paths:['readme.md','../not-authorized.md'],checks:['Bot 自查']},{token:child.payload.communicationAccess.token})
  const delivery=await eventually(async()=>(await api('/threads/'+origin.id)).messages.find(m=>m.text.includes('版本 r7')))
  assert.match(delivery.text,/readme.md|Bot 自查/)
  assert.match(delivery.text,/待核对/)
  assert.deepEqual(delivery.data.deliveryCheck.files.map(({path,status})=>[path,status]),
    [['readme.md','readable'],['../not-authorized.md','unverified']])
  assert.equal((await api('/tasks/'+child.taskId)).review,null)
  const inspection=await api('/threads/'+origin.id+'/messages',{text:'核对交付和维护状态 '+child.taskId})
  const [checked,maintenance]=JSON.parse((await replyTo(api,origin.id,inspection.messageId)).text)
  assert.equal(checked.result.files[0].excerpt,'用于交付的公开版本说明')
  assert.deepEqual(maintenance.result.offlineBots,[])
  await api(path,{kind:'delivery',text:'缺可访问附件',requestId:'missing-evidence',paths:['missing.md']},{token})
  const evidenceRequest=await eventually(async()=>(await api('/threads/'+work.task.workThreadId)).commands
    .find(c=>c.payload.text?.includes('请补充当前交付的可核对证据')))
  assert.equal(evidenceRequest.payload.communication.sender.kind,'main_bot')
  await n.event(first,'completed',{text:'交付给下一位 Bot'})
  const sent=await eventually(()=>n.frames.find(frame=>frame.command?.id===follow.id)?.command)
  assert.notEqual(sent.runId,first.runId)
  assert.equal(sent.payload.communication.replyTo,question.id)
  await n.receipt(sent,'received')
  assert.equal((await api('/threads/'+work.task.workThreadId)).commands.find(c=>c.id===follow.id).status,'received')
})

test('记忆候选核对、跨范围隔离、事项到期补记与恢复保留草稿',async t=>{
  const f=await server(t,{chat:true,chatProvider:{async generate(prompt){
    const ctx=JSON.parse(prompt.slice(prompt.indexOf('\n{')+1))
    return {action:'reply',text:'已记录候选',memoryCandidate:{body:ctx.currentUserRequest,type:'preference',factKey:' Ｍarkdown　偏好 '}}
  }}}),{api}=f
  await api('/chat/policy',{memoryCandidates:true})
  const personal=await api('/threads',{title:'隔离的记忆'})
  const project=await api('/projects',{name:'隔离项目'})
  const scoped=await api('/threads',{projectId:project.id})
  for(const [original,outcome] of [['长期使用 Markdown','accept'],['临时使用纯文本','reject']]){
    const job=await api('/threads/'+personal.id+'/messages',{text:original})
    await replyTo(api,personal.id,job.messageId)
    const list='/chat/memory-candidates?threadId='
    const [candidate]=(await api(list+personal.id)).items
    assert.equal(candidate.original,original)
    assert.deepEqual((await api(list+scoped.id)).items,[])
    const review=await api('/chat/memory-candidates',{action:outcome,id:candidate.id,threadId:personal.id})
    if(outcome==='accept'){
      const record=await api('/records/'+review.recordId)
      assert.equal(record.factKey,'markdown 偏好')
      assert.equal(record.confirmation,'user')
    }else assert.equal(review.status,'rejected')
  }
  const due=await api('/chat/daily',{action:'create',threadId:personal.id,kind:'reminder',body:'检查迁移',
    dueAt:new Date(Date.now()+1200).toISOString()})
  f.app.db.prepare('UPDATE daily_items SET dueAt=? WHERE id=?').run(new Date(Date.now()-1000).toISOString(),due.id)
  const packagePath=fileURLToPath(new URL('../plugins/examples/pi-unit-conversion/',import.meta.url))
  const draft=await api('/chat/plugins',{action:'stage',path:packagePath})
  await api('/chat/plugins',{action:'activate',id:draft.id,digest:draft.digest,trustCode:true})
  await f.reopen()
  const get=async()=>(await api('/threads/'+personal.id)).messages.filter(m=>m.data.reminderId===due.id)
  await eventually(async()=>(await get()).length===1)
  await f.reopen()
  assert.equal((await get()).length,1)
  const staging=mkdtempSync(join(tmpdir(),'maoqiu-phase3-backup-'))
  t.after(()=>rmSync(staging,{recursive:true,force:true}))
  const backup=join(staging,'backup'),restored=join(staging,'restored')
  transfer(f.dir,backup,false,{includeAccess:false})
  transfer(backup,restored,true)
  const restoredDb=openDatabase(restored)
  try{assert.equal(restoredDb.prepare('SELECT state FROM daily_items WHERE id=?').get(due.id).state,'fired')}
  finally{restoredDb.close()}
  const state=JSON.parse(readFileSync(join(restored,'plugins.json'),'utf8'))
  const extension=state.entries[draft.id]
  assert.equal(extension.enabled,false)
  assert.equal(extension.trusted,undefined)
  assert.ok(existsSync(join(restored,'plugins','packages',extension.current.folder,'index.mjs')))
})

test('外部主聊支持模型发现、受控认证、流式事件、切换、超时和取消',async t=>{
  const calls=[]
  let slowClosed=false
  const endpoint=await modelEndpoint(t,async(req,res,input,json)=>{
    calls.push({url:req.url,input,auth:req.headers.authorization})
    if(req.headers.authorization!=='Bearer fixture-key-do-not-disclose'){res.writeHead(401).end('fixture-private-provider-error');return}
    if(req.url==='/gateway/catalog'){json({data:[{id:'fixture/tool-free'},{id:'fixture/another'}]});return}
    if(req.url!=='/gateway/conversation'){res.writeHead(404).end();return}
    if(input.messages.at(-1).content==='Reply with OK.'){json(modelChoice('OK'));return}
    const context=inputContext(input)
    if(context.currentUserRequest==='超时' || context.currentUserRequest==='取消'){
      res.once('close',()=>{slowClosed=true})
      return
    }
    if(context.currentUserRequest==='无效响应'){json(modelChoice('not valid structured JSON'));return}
    if(input.stream){
      res.writeHead(200,{'Content-Type':'text/event-stream'})
      res.write('data: '+JSON.stringify({choices:[{delta:{content:'流式'},finish_reason:null}]})+'\n\n')
      await sleep(105)
      res.end('data: '+JSON.stringify({choices:[{delta:{content:'回复'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n')
      return
    }
    json(modelChoice('第二个模型回复'))
  })
  const f=await server(t,{chat:true}),{api}=f
  const opts={chatPath:'/conversation',modelsPath:'/catalog',model:'fixture/tool-free',outputLimitField:'max_tokens',sharePersonal:true,timeoutMs:500}
  const first=await configure(api,endpoint,{...opts,stream:true})
  assert.equal(first.hasKey,true)
  assert.doesNotMatch(JSON.stringify(await api('/chat/models')),/fixture-key-do-not-disclose/)
  await api('/chat/models',null,{token:'invalid',status:401})
  const project=await api('/projects',{name:'授权隔离'})
  const invite=await api('/grants',{projectId:project.id})
  await api('/chat/models',null,{token:invite.token,status:403})
  assert.deepEqual((await api('/chat/models/discover',{id:first.id})).models,['fixture/tool-free','fixture/another'])
  assert.equal((await api('/chat/models/test',{id:first.id})).ok,true)
  await api('/chat/persona',{text:'以小毛球身份使用简洁的工作语言'})
  const thread=await api('/threads',{title:'测试外部主聊'})
  const streamAbort=new AbortController()
  t.after(()=>streamAbort.abort())
  const events=await fetch(f.base()+'/events',{headers:{Authorization:'Bearer '+f.app.auth.cfg.ownerToken},
    signal:AbortSignal.any([streamAbort.signal,AbortSignal.timeout(3500)])})
  const reader=events.body.pipeThrough(new TextDecoderStream()).getReader()
  const firstMessage=await api('/threads/'+thread.id+'/messages',{text:'普通聊天'})
  let frames=''
  while(!frames.includes('流式'))frames+=(await reader.read()).value
  assert.match(frames,/"kind":"chat_delta"/)
  await reader.cancel()
  assert.equal((await replyTo(api,thread.id,firstMessage.messageId)).text,'流式回复')
  const second=await configure(api,endpoint,{...opts,name:'另一组配置',model:'fixture/another'})
  const secondMessage=await api('/threads/'+thread.id+'/messages',{text:'延续上一个话题'})
  const secondReply=await replyTo(api,thread.id,secondMessage.messageId)
  assert.equal(secondReply.data.model,second.name)
  const secondCall=calls.find(call=>call.input?.model==='fixture/another')
  const secondContext=inputContext(secondCall.input)
  assert.equal(secondCall.input.max_tokens,1600)
  assert.match(secondContext.persona,/简洁/)
  assert.ok(secondContext.recent.some(m=>m.text==='流式回复'))
  assert.equal(secondCall.input.tools,undefined)
  assert.doesNotMatch(JSON.stringify(secondCall.input),/fixture-key-do-not-disclose/)
  const timeout=await api('/threads/'+thread.id+'/messages',{text:'超时'})
  assert.match((await replyTo(api,thread.id,timeout.messageId,'error')).text,/超时/)
  slowClosed=false
  const stopped=await api('/threads/'+thread.id+'/messages',{text:'取消'})
  await eventually(()=>calls.some(call=>call.input?.model==='fixture/another'&&inputContext(call.input).currentUserRequest==='取消'))
  assert.equal((await api('/chat/cancel',{messageId:stopped.messageId})).status,'cancelled')
  await eventually(()=>slowClosed)
  assert.equal((await api('/threads/'+thread.id)).mainChat.pending.length,0)
  assert.equal(f.app.db.prepare("SELECT count(*) n FROM tasks").get().n,0)
  const broken=await configure(api,endpoint,{...opts,name:'结构错误',structured:true})
  const bad=await api('/threads/'+thread.id+'/messages',{text:'无效响应'})
  assert.match((await replyTo(api,thread.id,bad.messageId,'error')).text,/响应格式/)
  const wrong=await configure(api,endpoint,{...opts,name:'无效密钥',apiKey:'invalid'})
  const error=await api('/chat/models/test',{id:wrong.id},{status:502})
  assert.match(error.error,/认证失败/)
  assert.doesNotMatch(error.error,/fixture-private-provider-error/)
  await api('/chat/models',{action:'delete',id:wrong.id})
  assert.equal((await api('/chat/models')).activeId,'codex')
  assert.ok((await api('/chat/models')).models.some(model=>model.id===broken.id))
  await api('/chat/models',{action:'toggle',id:broken.id,disabled:true})
  await api('/chat/models',{action:'select',id:broken.id},{status:404})
  await api('/chat/models/test',{id:broken.id},{status:404})
  await api('/chat/models',{action:'toggle',id:broken.id,disabled:false})
  assert.equal((await api('/chat/models/test',{id:broken.id})).ok,true)
})

test('主聊使用宿主工具保存长期记忆，权限可撤销，遗忘使历史与摘要退出召回',async t=>{
  const contexts=[]
  const tool=(name,args)=>({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{function:{name,arguments:JSON.stringify(args)}}]}}]})
  let rememberedId
  const endpoint=await modelEndpoint(t,(_req,_res,input,json)=>{
    const ctx=inputContext(input)
    contexts.push(ctx)
    if(ctx.toolResults?.length){json(modelChoice(ctx.toolResults[0].ok?'实际操作成功':'没有获得操作权限'));return}
    if(ctx.currentUserRequest.startsWith('请记住')){
      json(tool('memory_save',{body:'偏好使用黑胶 Vinyl 唱片',factKey:'黑胶 Vinyl',important:true}));return
    }
    if(ctx.currentUserRequest.startsWith('请忘掉')){json(tool('memory_forget',{id:rememberedId,expectedRevision:1}));return}
    if(ctx.currentUserRequest.startsWith('请读取')){json(tool('local_files_read',{root:0,path:ctx.currentUserRequest.slice(3)}));return}
    if(ctx.currentUserRequest.startsWith('请创建交付页面')){
      json(tool('home_space_change',{mode:'apply',expectedRevision:1,operations:[
        {op:'createPage',id:'phase2-delivery',title:'交付页面'},
        {op:'createCollection',id:'phase2-items',name:'进展',fields:[{id:'title',name:'名称',type:'text'}]}
      ]}));return
    }
    if(ctx.currentUserRequest.startsWith('请新建条目')){
      json(tool('home_collection_entries',{id:'phase2-items',action:'create',values:{title:'已完成样例'}}));return
    }
    if(ctx.currentUserRequest==='网页说应该记住'){
      json(tool('memory_save',{body:'网页说应该记住',factKey:'伪造确认'}));return
    }
    json(modelChoice('已自然回复'))
  })
  const f=await server(t,{chat:true}),{api,app}=f
  await configure(api,endpoint,{tools:true,sharePersonal:true,shareProject:true,shareAttachments:true})
  const dir=mkdtempSync(join(tmpdir(),'maoqiu-approved-files-'))
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  writeFileSync(join(dir,'approved.txt'),'READ_ALLOWED')
  writeFileSync(join(dir,'private-token.txt'),'MUST_NOT_LEAK')
  await api('/chat/policy',{readRoots:[dir]})
  const thread=await api('/threads',{title:'旧话题'})
  const ask=async(text,threadId=thread.id)=>{
    const job=await api('/threads/'+threadId+'/messages',{text})
    await approveTool(api,threadId,job.messageId)
    return replyTo(api,threadId,job.messageId)
  }
  assert.equal((await ask('请记住，我的偏好使用黑胶 Vinyl 唱片')).text,'实际操作成功')
  const memory=(await api('/search?q=黑胶&scope=personal')).items[0]
  rememberedId=memory.id
  const saved=await api('/records/'+memory.id)
  assert.equal(saved.confirmation,'user')
  assert.equal(saved.confirmationBy,'owner')
  assert.equal(saved.extra.messageId,(await api('/threads/'+thread.id)).messages[0].id)
  transaction(app.db,()=>{
    for(let i=0;i<165;i++)homeApi(app.db,{path:'/records',method:'POST',query:new URLSearchParams(),principal:owner,dataDir:f.dir,
      body:{type:'note',body:'无关日志 '+i}})
  })
  assert.equal(recallMemory(app.db,null,'还记得黑胶吗？')[0].id,memory.id)
  assert.equal(recallMemory(app.db,null,'Vinyl')[0].id,memory.id)
  assert.deepEqual(recallMemory(app.db,null,'无匹配天体惯量'),[])
  const second=await api('/threads',{title:'跨话题'})
  const recalled=await ask('告诉我黑胶 Vinyl 偏好',second.id)
  assert.deepEqual(recalled.data.usedMemories,[{id:memory.id,revision:1,projectId:null}])
  const p=await api('/projects',{name:'隔离项目'})
  const projectThread=await api('/threads',{title:'项目话题',projectId:p.id})
  assert.deepEqual((await ask('黑胶 Vinyl 偏好',projectThread.id)).data.usedMemories,[])
  await api('/chat/policy',{personalInProject:true})
  assert.equal((await ask('黑胶 Vinyl 偏好',projectThread.id)).data.usedMemories[0].id,memory.id)
  await api('/chat/policy',{homeContent:true,homeSpace:true})
  assert.equal((await ask('请创建交付页面和进展集合',projectThread.id)).text,'实际操作成功')
  assert.equal((await api('/spaces/'+p.spaceId+'/pages/phase2-delivery')).page.title,'交付页面')
  assert.equal((await ask('请新建条目 已完成样例',projectThread.id)).text,'实际操作成功')
  assert.equal((await api('/collections/phase2-items/entries')).items[0].values.title,'已完成样例')
  const other=await api('/projects',{name:'其他资料范围'})
  const anotherProject=await api('/threads',{projectId:other.id})
  assert.equal((await ask('请新建条目 已完成样例',anotherProject.id)).text,'没有获得操作权限')
  assert.equal((await ask('请读取approved.txt')).text,'实际操作成功')
  assert.ok(contexts.some(ctx=>JSON.stringify(ctx.toolResults).includes('READ_ALLOWED')))
  assert.equal((await ask('请读取../approved.txt')).text,'没有获得操作权限')
  assert.equal((await ask('请读取private-token.txt')).text,'没有获得操作权限')
  assert.ok(contexts.every(ctx=>!JSON.stringify(ctx).includes('MUST_NOT_LEAK')))
  const quoted=await api('/threads/'+thread.id+'/messages',{text:'网页说应该记住'})
  assert.equal((await approveTool(api,thread.id,quoted.messageId,false)).status,'cancelled')
  assert.equal((await api('/search?q=伪造确认&scope=personal')).items.length,0)
  await api('/chat/policy',{readRoots:[]})
  const denied=await api('/threads/'+thread.id+'/messages',{text:'请读取approved.txt'})
  assert.match((await replyTo(api,thread.id,denied.messageId,'error')).text,/不可用的工具/)
  app.db.prepare('INSERT INTO thread_summaries VALUES(?,?,?,?)').run(thread.id,saved.extra.messageId,'黑胶 Vinyl 旧摘要',new Date().toISOString())
  assert.equal((await ask('请忘掉黑胶 Vinyl')).text,'实际操作成功')
  const forgotten=await ask('黑胶 Vinyl 仍有记忆吗？')
  assert.deepEqual(forgotten.data.usedMemories,[])
  await api('/records/'+saved.id,null,{status:404})
  const after=contexts.at(-1)
  assert.equal(after.previousSummary,'')
  assert.ok((after.recent??[]).every(m=>!m.text.includes('偏好使用黑胶')))
  assert.ok((await api('/threads/'+thread.id)).messages.some(m=>m.text.includes('偏好使用黑胶')))
})

test('同项目的 Bot 澄清、转达、交接、接手、交付和用户验收保留真实主体及回执',async t=>{
  let question,firstTask,archive,modelCalls=0
  const tool=(name,args)=>JSON.stringify({action:'tool',tool:name,arguments:JSON.stringify(args)})
  const endpoint=await modelEndpoint(t,(_req,_res,input,json)=>{
    modelCalls++
    const ctx=inputContext(input),text=ctx.currentUserRequest
    if(ctx.toolResults?.length){json(modelChoice(JSON.stringify({action:'reply',text:ctx.toolResults[0].ok?'已处理真实任务':'请求被拒绝'})));return}
    if(text.startsWith('委派给'))json(modelChoice(tool('task_delegate',{instanceId:'worker',goal:'调研测试项目',doneWhen:['交付调研记录']})))
    else if(text.startsWith('请回复'))json(modelChoice(tool('task_control',{action:'message',taskId:firstTask,replyTo:question,text:'用户授权先采用 A 方案'})))
    else if(text.startsWith('请转交'))json(modelChoice(tool('task_delegate',{instanceId:'worker-b',goal:'接手实现',doneWhen:['提交实现说明'],refs:[{type:'record',id:archive}]})))
    else json(modelChoice(tool('task_communications',{taskId:firstTask})))
  })
  const f=await server(t,{chat:true}),{api}=f,n=await node(f,true)
  t.after(()=>n.ws.terminate())
  await configure(api,endpoint,{structured:true,shareProject:true,sharePersonal:false})
  const p=await api('/projects',{name:'两位 Bot 接手'})
  for(const instanceId of ['worker','worker-b'])await api('/projects/'+p.id+'/workspaces',{instanceId,workspaceRef:f.dir,allowAgentAccess:true})
  const scope=await api('/threads',{title:'项目协同',projectId:p.id})
  const ask=async text=>{
    const current=await api('/threads/'+scope.id+'/messages',{text})
    await approveTool(api,scope.id,current.messageId)
    const reply=await replyTo(api,scope.id,current.messageId)
    assert.equal(reply.text,'已处理真实任务')
    return current.messageId
  }
  const assignment=await ask('委派给 Worker 做调研并列出依据')
  const card=(await api('/threads/'+scope.id)).messages.find(m=>m.kind==='task_card')
  firstTask=card.taskId
  const task=await api('/tasks/'+firstTask)
  const command=await n.command(task.run.id)
  assert.equal(command.payload.communication.sender.kind,'main_bot')
  assert.equal(command.payload.communication.sourceMessageId,assignment)
  assert.equal(command.payload.communication.recipient.id,'worker')
  assert.equal(command.payload.homeAccess.permission,'read')
  const token=command.payload.homeAccess.token,report='/runs/'+command.runId+'/communication'
  await n.receipt(command,'received')
  await n.event(command,'accepted',{sessionId:'native-worker-first',nativeRunId:'native-turn-a'})
  const q={kind:'question',text:'应采用 A 还是 B？',requestId:'question-1',actor:{kind:'user',id:'owner'}}
  const snapshotCallCount=modelCalls
  const qResult=await api(report,q,{token})
  question=qResult.id
  assert.deepEqual(await api(report,q,{token}),qResult)
  assert.equal(qResult.sender.kind,'work_bot')
  assert.equal(qResult.sender.id,'worker')
  await api(report,{...q,requestId:'broadcast',recipientInstanceId:'unrelated-node'},{token,status:403})
  assert.equal(modelCalls,snapshotCallCount)
  const sourceMessage=await ask('请回复 Worker，采用 A 方案')
  let work=await api('/threads/'+task.task.workThreadId)
  const answer=work.messages.find(m=>m.data.communication?.replyTo===question)
  assert.equal(answer.data.communication.sender.kind,'main_bot')
  assert.equal(answer.data.communication.sourceMessageId,sourceMessage)
  assert.equal(work.commands.find(c=>c.id!==command.id).status,'waiting')
  await n.event(command,'completed',{text:'已完成初次调研'})
  work=await api('/threads/'+task.task.workThreadId)
  const held=work.commands.find(c=>c.status==='held')
  assert.ok(held)
  const continued=await api('/runs/'+command.runId+'/commands',{kind:'resume',commandId:held.id})
  const response=await n.command(continued.runId)
  assert.equal(response.payload.communication.replyTo,question)
  assert.equal(response.payload.sessionId,'native-worker-first')
  const responseToken=response.payload.homeAccess.token
  await n.receipt(response,'received')
  await n.event(response,'accepted',{sessionId:'native-worker-first',nativeRunId:'native-turn-b'})
  const handoff=await api('/runs/'+response.runId+'/communication',{kind:'handoff',text:'A 方案调研，交给 Worker B 接手',
    requestId:'handoff-1',recipientInstanceId:'worker-b',version:'r1',remaining:['实现 A'],checks:['只完成方案核对']},{token:responseToken})
  archive=handoff.recordId
  assert.equal((await api('/records/'+archive)).extra.verificationSource,'agent')
  assert.equal((await api('/tasks/'+firstTask+'/communication')).items.find(item=>item.id===handoff.id).recipientRequest,'worker-b')
  await n.event(response,'completed',{text:'调研与交接已提交'})
  await api('/runs/'+response.runId+'/communication',{kind:'progress',text:'迟到重复',requestId:'late-message'},{token:responseToken,status:401})
  await ask('请转交给 Worker B 执行 A 方案')
  const next=(await api('/threads/'+scope.id)).messages.filter(m=>m.kind==='task_card').at(-1)
  const nextTask=await api('/tasks/'+next.taskId)
  const nextCommand=await n.command(nextTask.run.id)
  assert.equal(nextCommand.instanceId,'worker-b')
  assert.equal(nextCommand.projectId,p.id)
  assert.match(nextCommand.payload.text,/A 方案调研/)
  assert.equal(nextCommand.payload.materials[0].id,archive)
  await n.receipt(nextCommand,'received')
  await n.event(nextCommand,'accepted',{sessionId:'native-worker-second',nativeRunId:'native-turn-c'})
  const delivery=await api('/runs/'+nextCommand.runId+'/communication',{kind:'delivery',text:'已提交 A 的实现说明',
    requestId:'delivery-1',version:'r2',completed:['实现说明'],paths:['handoff.md'],checks:['自查排版']},{token:nextCommand.payload.homeAccess.token})
  assert.equal((await api('/records/'+delivery.recordId)).extra.paths[0],'handoff.md')
  assert.equal((await api('/tasks/'+next.taskId)).review,null)
  await n.event(nextCommand,'completed',{text:'完成后续交付'})
  const reviewed=await api('/tasks/'+next.taskId+'/review',{runId:nextCommand.runId,checks:[{criterion:'提交实现说明',met:true,evidence:'用户已核对交付记录'}]})
  assert.equal(reviewed.status,'completed')
  assert.equal((await api('/tasks/'+next.taskId)).review.by,'owner')
})

test('工作台用节点实际能力列出原生会话，导入有持久回执且可继续同一个原生话题',async t=>{
  const f=await server(t),{api}=f
  const frames=[]
  const socket=new WebSocket(f.base().replace('http:','ws:')+'/node',{headers:{Authorization:'Bearer '+f.app.auth.cfg.nodes.local}})
  t.after(()=>socket.terminate())
  socket.on('message',raw=>{
    const frame=JSON.parse(raw)
    frames.push(frame)
    if(frame.type==='list_sessions')socket.send(JSON.stringify({type:'sessions',id:frame.id,
      items:[{id:'existing-native',title:'现有原生会话',updatedAt:150,active:false,path:'private-path'}],nextCursor:'native-page-2'}))
  })
  await once(socket,'open')
  socket.send(JSON.stringify({type:'hello',receiptLookup:true,instances:[
    {id:'codex-catalog',name:'Codex',workspaceRef:f.dir,adapterKey:'codex',profileId:'native-profile',
      availableActions:['run','prepare'],history:true,sessionList:true},
    {id:'dsh-no-catalog',name:'DSH',workspaceRef:f.dir,adapterKey:'dsh',availableActions:['run','prepare']}
  ]}))
  await eventually(async()=>(await api('/instances')).find(i=>i.id==='codex-catalog'&&i.online))
  const p=await api('/projects',{name:'原生导入'})
  const shared=await api('/grants',{projectId:p.id})
  const endpoint='/instances/codex-catalog/sessions'
  await api(endpoint,null,{token:shared.token,status:403})
  await api(endpoint+'?projectId='+p.id,null,{status:409})
  await api('/instances/dsh-no-catalog/sessions',null,{status:409})
  await api('/projects/'+p.id+'/workspaces',{instanceId:'codex-catalog',workspaceRef:f.dir})
  const listed=await api(endpoint+'?projectId='+p.id+'&cursor=opaque')
  assert.deepEqual(listed.items,[{id:'existing-native',title:'现有原生会话',updatedAt:150,active:false}])
  const outbound=frames.find(f=>f.type==='list_sessions')
  assert.equal(outbound.profileId,'native-profile')
  assert.equal(outbound.workspaceRef,f.dir)
  assert.equal(outbound.cursor,'opaque')
  const data={sessionId:listed.items[0].id,title:listed.items[0].title,projectId:p.id}
  const first=await api(endpoint,data)
  assert.equal((await api(endpoint,data)).thread.id,first.thread.id)
  const command=await eventually(()=>frames.find(f=>f.command?.runId===first.runId)?.command)
  assert.equal(command.kind,'prepare')
  assert.equal(command.payload.importSessionId,'existing-native')
  async function event(seq,kind,data){
    const key='native-import-'+seq
    socket.send(JSON.stringify({type:'event',event:{seq,key,kind,data,instanceId:command.instanceId,runId:command.runId,commandId:command.id}}))
    await eventually(()=>frames.some(f=>f.type==='ack'&&f.key===key))
  }
  await event(1,'model_state',{sessionId:'existing-native',current:'native-model'})
  await event(2,'completed',{sessionId:'existing-native'})
  assert.equal((await api(endpoint,data)).status,'bound')
  const snapshot=await api('/threads/'+first.thread.id)
  assert.equal(snapshot.run.status,'completed')
  assert.equal(snapshot.thread.sessionId,'existing-native')
  const followup=await api('/threads/'+first.thread.id+'/messages',{text:'继续现有原生会话'})
  const next=await eventually(()=>frames.find(f=>f.command?.runId===followup.runId)?.command)
  assert.equal(next.payload.sessionId,'existing-native')
  assert.equal(next.payload.communication.sender.kind,'user')
})

test('活动中备份恢复进入待核对，停机检查与附件摘要阻止错误恢复',async t=>{
  const f=await server(t),{api,dir}=f
  const archive=mkdtempSync(join(tmpdir(),'maoqiu-backup-case-'))
  t.after(()=>rmSync(archive,{recursive:true,force:true}))
  const p=await api('/projects',{name:'备份检查'})
  const attached=await api('/attachments',{projectId:p.id,name:'source.txt',data:Buffer.from('ORIGINAL').toString('base64')})
  const n=await node(f,true)
  t.after(()=>n.ws.terminate())
  await api('/projects/'+p.id+'/workspaces',{instanceId:'worker',workspaceRef:dir,allowAgentAccess:true})
  const origin=await api('/threads',{projectId:p.id})
  const task=await api('/tasks',{originThreadId:origin.id,instanceId:'worker',goal:'活动中的工作',attachmentIds:[attached.id]})
  const command=await n.command(task.runId)
  await n.receipt(command,'received')
  await n.event(command,'accepted',{sessionId:'backup-native',nativeRunId:'active-native-turn'})
  assert.throws(()=>transfer(dir,join(archive,'offline'),false,{offline:true}),/仍有待处理/)
  await configure(api,'http://127.0.0.1:1/v1')
  const online=join(archive,'online')
  assert.equal(transfer(dir,online,false,{includeAccess:false}).needsReview,1)
  assert.equal(existsSync(join(online,'access.local.json')),false)
  assert.equal(existsSync(join(online,'chat-model-keys.json')),false)
  const restored=join(archive,'restored')
  assert.equal(transfer(online,restored,true).needsReview,1)
  const db=openDatabase(restored)
  try{
    assert.equal(db.prepare('SELECT status FROM runs WHERE id=?').get(task.runId).status,'uncertain')
    assert.equal(db.prepare('SELECT status FROM commands WHERE id=?').get(command.id).status,'uncertain')
    assert.equal(db.prepare('SELECT count(*) n FROM run_grants').get().n,0)
  }finally{db.close()}
  writeFileSync(join(online,'attachments',attached.id),'MODIFIED')
  const corrupt=join(archive,'corrupt')
  assert.throws(()=>transfer(online,corrupt,true),/附件内容不符/)
  assert.equal(existsSync(corrupt),false)
  assert.equal(readFileSync(join(dir,'attachments',attached.id),'utf8'),'ORIGINAL')
})

test('重连先查回执，撤权后不重发旧正文，放弃不把迟到事件算作新结果',async t=>{
  const f=await server(t),{api}=f
  let n=await node(f,true)
  const project=await api('/projects',{name:'重发检查'})
  const workspaces='/projects/'+project.id+'/workspaces'
  await api(workspaces,{instanceId:'worker',workspaceRef:f.dir,allowAgentAccess:true})
  const source=await api('/submissions',{projectId:project.id,source:{title:'需要撤回',text:'原件仅在项目内'}})
  const thread=await api('/threads',{projectId:project.id,instanceId:'worker'})
  const path='/threads/'+thread.id
  const pending=await api(path+'/messages',{text:'读取指定资料',refs:[{id:source.sourceId,type:'source'}]})
  const sent=await n.command(pending.runId)
  await api(path+'/messages',{text:'继续整理'})
  n.ws.close();await once(n.ws,'close')
  await api('/sources/'+source.sourceId,{projectIds:[]},{method:'PATCH'})
  n=await node(f,true)
  await eventually(()=>n.frames.some(frame=>frame.type==='inspect_command'&&frame.commandId===sent.id))
  n.send({type:'receipt_missing',commandId:sent.id})
  await eventually(async()=>(await api(path)).run.status==='uncertain')
  assert.equal(n.frames.some(frame=>frame.command?.id===sent.id),false)
  await api('/projects/'+project.id+'/brief',null,{token:sent.payload.homeAccess.token,status:401})
  const recovery='/runs/'+pending.runId+'/recovery'
  await api(recovery,{action:'inspect'})
  await api(recovery,{action:'abandon',reason:'核对后放弃'},{status:400})
  const abandoned=await api(recovery,{action:'abandon',acknowledge:true,reason:'核对后放弃'})
  assert.deepEqual(await api(recovery,{action:'abandon',acknowledge:true,reason:'重复提交'}),abandoned)
  const held=(await api(path)).commands.find(command=>command.status==='held')
  const controls='/runs/'+pending.runId+'/commands'
  await api(controls,{kind:'resume',commandId:held.id},{status:409})
  const continued=await api(controls,{kind:'resume',commandId:held.id,acknowledge:true})
  const fresh=await n.command(continued.runId)
  await n.event(sent,'completed',{text:'迟到的旧完成'})
  assert.ok((await api(path)).messages.some(m=>m.kind==='late_evidence'))
  assert.equal((await api(path)).run.id,fresh.runId)
  assert.equal((await api(path)).run.status,'queued')
  n.ws.close();await once(n.ws,'close')
  n=await node(f,true)
  await eventually(()=>n.frames.some(frame=>frame.type==='inspect_command'&&frame.commandId===fresh.id))
  n.send({type:'receipt_missing',commandId:fresh.id})
  assert.deepEqual(await n.command(fresh.runId),fresh)
  await n.receipt(fresh,'received')
  n.ws.close();await once(n.ws,'close')
  n=await node(f,true)
  await eventually(()=>n.frames.some(frame=>frame.type==='inspect_command'&&frame.commandId===fresh.id))
  await n.receipt(fresh,'received')
  assert.equal(n.frames.some(frame=>frame.command?.id===fresh.id),false)
  await n.event(fresh,'completed',{text:'新运行完成'})
  assert.equal((await api(path)).run.status,'completed')
  const accepted=await api(path+'/messages',{text:'已有原生回执的运行'})
  const known=await n.command(accepted.runId)
  await n.event(known,'accepted',{sessionId:'known-native-session',nativeRunId:'known-native-turn'})
  n.ws.close();await once(n.ws,'close')
  n=await node(f,true)
  await eventually(()=>n.frames.some(frame=>frame.type==='inspect_command'&&frame.commandId===known.id))
  n.send({type:'receipt_missing',commandId:known.id})
  await eventually(async()=>(await api(path)).run.status==='uncertain')
  assert.equal(n.frames.some(frame=>frame.command?.id===known.id),false)
})

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
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version,7)
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
