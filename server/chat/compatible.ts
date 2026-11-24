import { readFileSync } from 'node:fs'
import { fail } from '../db/index.ts'
import type { ModelConfig } from './model-settings.ts'
import type { ChatProvider, Generation } from './provider.ts'

const schema=JSON.parse(readFileSync(new URL('./decision.json',import.meta.url),'utf8'))
const maxOutputBytes=2*1024*1024
type Answer={text:string; name:string; args:string; finish:string|null}
type Settings={model:ModelConfig;apiKey?:string}
function readChoice(raw:any,answer:Answer,stream:boolean){
  const choice=raw?.choices?.[0]
  if(!choice)return
  const part=stream?choice.delta:choice.message
  if(choice.finish_reason)answer.finish=String(choice.finish_reason)
  if(typeof part?.content==='string')answer.text+=part.content
  for(const tool of part?.tool_calls??[]){
    if((tool.index??0)!==0||(part.tool_calls?.length??0)>1)fail('每个主聊步骤只接受一个工具请求',502)
    answer.name+=String(tool.function?.name??'')
    answer.args+=String(tool.function?.arguments??'')
  }
}
function parseJson(text:string){
  try{return JSON.parse(text)}catch{fail('模型响应格式无效',502)}
}
async function receive(res:Response,stream:boolean,delta?:Generation['delta']){
  if(!res.body)fail('模型服务没有返回响应',502)
  const reader=res.body.getReader(),decoder=new TextDecoder()
  const answer:Answer={text:'',name:'',args:'',finish:null}
  let pending='',total=0,done=false
  try{
    while(!done){
      const result=await reader.read()
      if(result.done)break
      total+=result.value.length
      if(total>maxOutputBytes)fail('模型响应超过大小限制',502)
      pending+=decoder.decode(result.value,{stream:true})
      if(!stream)continue
      let newline
      while((newline=pending.indexOf('\n'))>=0){
        const line=pending.slice(0,newline).trim();pending=pending.slice(newline+1)
        if(!line.startsWith('data:'))continue
        const data=line.slice(5).trim()
        if(data==='[DONE]'){done=true;break}
        const before=answer.text.length
        const frame=parseJson(data)
        if(frame.error)fail('模型服务中断了流式响应',502)
        readChoice(frame,answer,true)
        if(answer.text.length>before)delta?.(answer.text.slice(before))
      }
    }
    if(!stream)return parseJson(pending+decoder.decode())
    if(!answer.finish&&!done)fail('模型流式响应提前结束',502)
    return answer
  }finally{await reader.cancel().catch(()=>{})}
}
async function request(config:Settings,path:string,body:object|null,signal?:AbortSignal,delta?:Generation['delta']){
  const {model,apiKey}=config,clock=AbortSignal.timeout(model.timeoutMs)
  const combined=signal?AbortSignal.any([clock,signal]):clock
  try{
    const headers={...model.headers,...(apiKey?{Authorization:'Bearer '+apiKey}:{}),...(body?{'Content-Type':'application/json'}:{})}
    const response=await fetch(model.baseUrl+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,
      redirect:'manual',signal:combined})
    if(!response.ok){
      await response.body?.cancel()
      if(response.status>=300&&response.status<400)fail('模型端点尝试重定向，请填写最终地址',502)
      if([401,403].includes(response.status))fail('模型认证失败，请检查密钥及模型权限',502)
      if(response.status===402)fail('模型服务报告额度不足',502)
      if(response.status===429)fail('模型服务限流，请稍后重试',502)
      if(response.status===404)fail('模型或协议接口不存在，可以手填模型 ID 或核对路径',502)
      fail('模型服务拒绝请求（HTTP '+response.status+'），请检查模型 ID 和能力设置',502)
    }
    return await receive(response,!!body&&response.headers.get('content-type')?.includes('text/event-stream')===true,delta)
  }catch(e){
    if(signal?.aborted)fail('主聊已取消',409)
    if(clock.aborted)fail('模型请求超时',504)
    if((e as {status?:number}).status)throw e
    fail('无法连接配置的模型服务',502)
  }
}
export async function discoverModels(config:Settings,signal?:AbortSignal){
  const data=await request(config,config.model.modelsPath,null,signal)
  if(!Array.isArray(data?.data))fail('模型列表不可用，请手填模型 ID',502)
  return {models:data.data.filter((v:any)=>typeof v?.id==='string'&&v.id.length<=200).slice(0,250).map((v:any)=>v.id)}
}
async function generate(config:Settings,prompt:string,attachments:Parameters<ChatProvider['generate']>[1],options?:Generation){
  const {model}=config,plain=options?.plain??(!model.structured&&!model.tools)
  const divider=prompt.indexOf('\n')
  const instruction=divider<0?prompt:prompt.slice(0,divider)
  const content=divider<0?'':prompt.slice(divider+1)
  const tools=model.tools&&!plain?options?.tools??[]:[]
  const pictures=(!plain||options?.plain!==true)&&model.vision&&model.shareAttachments
    ?attachments.filter(a=>['image/png','image/jpeg','image/webp'].includes(a.contentType)&&a.data.length<8*1024*1024).slice(0,3):[]
  const response=await request(config,model.chatPath,{
    model:model.model,messages:[{role:'system',content:plain
      ?'你是小毛球。根据用户本轮请求自然交流，遵守人格和上下文。无工具权限，不声称执行了操作。'
      :instruction},{role:'user',content:pictures.length?[{type:'text',text:content},...pictures.map(a=>({type:'image_url',image_url:{url:'data:'+a.contentType+';base64,'+a.data}}))]:content}],
    [model.outputLimitField??'max_completion_tokens']:model.outputTokens,stream:options?.plain===true?false:model.stream,
    ...(!plain&&model.structured?{response_format:{type:'json_schema',json_schema:{name:'maoqiu_decision',strict:true,schema}}}:{}),
    ...(tools.length?{tools:tools.map(tool=>({type:'function',function:tool})),parallel_tool_calls:false}:{})
  },options?.signal,plain&&options?.plain!==true?options?.delta:undefined)
  const result:Answer={text:'',name:'',args:'',finish:null}
  if(typeof response?.text==='string')Object.assign(result,response)
  else readChoice(response,result,false)
  if(['length','content_filter'].includes(result.finish??''))fail('模型回复未完整结束，请调整输出预算或检查供应商限制',502)
  if(!plain&&result.name){
    if(!tools.some(t=>t.name===result.name))fail('模型请求了当前不可用的工具',502)
    return {action:'tool',tool:result.name,arguments:result.args}
  }
  if(!result.text.trim())fail('模型没有返回可用回复',502)
  return !plain&&model.structured?parseJson(result.text):{action:'reply',text:result.text}
}
export function compatibleProvider(config:Settings):ChatProvider{
  return {name:config.model.name,generate:(prompt,attachments,options)=>generate(config,prompt,attachments,options)}
}
export async function probeModel(config:Settings,signal?:AbortSignal){
  const result=await generate(config,'连接测试\nReply with OK.',[],{plain:true,signal})
  return {ok:result.action==='reply',model:config.model.model}
}
