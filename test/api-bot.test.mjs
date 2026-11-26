import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { startServer } from '../server/index.ts'

test('无状态 API Bot 经 HTTP 发送真实请求，复用工作台历史及控制范围',async t=>{
  const requests=[]
  const model=createServer(async(req,res)=>{
    const chunks=[]
    for await(const chunk of req)chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks)))
    res.setHeader('Content-Type','application/json')
    res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'收到第 '+requests.length+' 轮'}}]}))
  })
  model.listen(0,'127.0.0.1')
  await once(model,'listening')
  const dir=mkdtempSync(join(tmpdir(),'maoqiu-local-bot-'))
  const app=startServer({port:0,dataDir:dir,chat:false})
  await once(app.server,'listening')
  t.after(async()=>{await app.close();await new Promise(resolve=>model.close(resolve));rmSync(dir,{recursive:true,force:true})})
  async function api(path,b,status=200){
    const res=await fetch('http://127.0.0.1:'+app.server.address().port+'/api/v1'+path,{
      method:b?'POST':'GET',headers:{Authorization:'Bearer '+app.auth.cfg.ownerToken,'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined})
    const data=await res.json()
    assert.equal(res.status,status,JSON.stringify(data))
    return data
  }
  const settings=await api('/chat/models',{action:'save',name:'本地文本',baseUrl:'http://127.0.0.1:'+model.address().port+'/v1',
    model:'fixture',protocol:'openai-compatible',sharePersonal:true})
  const modelId=settings.models.find(m=>m.name==='本地文本').id
  const bot=await api('/instances/api',{modelId})
  assert.equal((await api('/instances/api',{modelId})).id,bot.id)
  assert.equal((await api('/instances/'+bot.id+'/settings')).allowDelegate,false)
  const {thread}=await api('/threads',{instanceId:bot.id,firstMessage:{text:'记住本轮代号 青铜'}})
  const base='/threads/'+thread.id
  async function waitReply(n,path=base){
    for(let i=0;i<100;i++){
      const result=await api(path)
      if(result.messages.filter(m=>m.role==='assistant'&&m.kind==='message').length===n)return result
      await delay(20)
    }
    assert.fail('未收到预期的实际 HTTP 回复')
  }
  const initial=await waitReply(1)
  assert.equal(initial.thread.kind,'api')
  assert.equal(initial.thread.sessionId,null)
  await api(base+'/messages',{text:'请复查原代号'})
  await waitReply(2)
  assert.match(requests[1].messages[1].content,/青铜/)
  assert.match(requests[1].messages[1].content,/收到第 1 轮/)
  const second=await api('/threads',{instanceId:bot.id,firstMessage:{text:'独立的问题'}})
  assert.notEqual(second.thread.id,thread.id)
  await waitReply(1,'/threads/'+second.thread.id)
  assert.doesNotMatch(requests.at(-1).messages[1].content,/青铜/)
  await api('/instances/'+bot.id+'/settings',{enabled:false})
  await api(base+'/messages',{text:'越过停用状态'},409)
})
