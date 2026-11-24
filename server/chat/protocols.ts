import { fail } from '../db/index.ts'
import type { ModelConfig } from './model-settings.ts'
import type { ChatAttachment, ChatToolDefinition, ToolCall, ToolExchange } from './provider.ts'

type Body = Record<string, unknown>
type Input = {
  system:string; user:string; images:ChatAttachment[]; tools:ChatToolDefinition[];
  exchanges:ToolExchange[]; stream:boolean; structured?:object
}
type Output = {text:string; call?:ToolCall; usage?:unknown}
const nativeTools=(tools:ChatToolDefinition[])=>tools.map(({name,description,parameters})=>({name,description,parameters}))
const json=(value:unknown)=>JSON.stringify(value??null)
const imageUrl=(image:ChatAttachment)=>'data:'+image.contentType+';base64,'+image.data

export function protocolHeaders(model:ModelConfig,key?:string){
  switch(model.protocol){
    case 'anthropic': return {'anthropic-version':'2023-06-01',...model.headers,...(key?{'x-api-key':key}:{})} as Record<string,string>
    case 'gemini': return {...model.headers,...(key?{'x-goog-api-key':key}:{})} as Record<string,string>
    default: return {...model.headers,...(key?{Authorization:'Bearer '+key}:{})} as Record<string,string>
  }
}
export function generationRequest(model:ModelConfig,i:Input):{path:string;body:Body}{
  const {system,user,images,tools,exchanges,stream,structured}=i
  const temperature=model.temperature===undefined?{}:{temperature:model.temperature}
  const request=(body:Body,path=model.chatPath)=>({body,path})
  switch(model.protocol){
    case 'openai-responses':
      return request({model:model.model,store:false,instructions:system,max_output_tokens:model.outputTokens,stream,...temperature,
        input:[{role:'user',content:[{type:'input_text',text:user},...images.map(a=>({type:'input_image',image_url:imageUrl(a),detail:'auto'}))]},
          ...exchanges.flatMap(({call,result})=>[...(call.assistant as any[]),{type:'function_call_output',call_id:call.id,output:json(result)}])],
        ...(tools.length?{parallel_tool_calls:false,tools:nativeTools(tools).map(t=>({type:'function',...t,strict:false}))}:{}),
        ...(structured?{text:{format:{type:'json_schema',name:'maoqiu_decision',schema:structured,strict:true}}}:{})})
    case 'anthropic':
      return request({model:model.model,system,max_tokens:model.outputTokens,stream,...temperature,
        messages:[{role:'user',content:[{type:'text',text:user},...images.map(a=>({type:'image',source:{type:'base64',media_type:a.contentType,data:a.data}}))]},
          ...exchanges.flatMap(({call,result})=>[{role:'assistant',content:call.assistant},
            {role:'user',content:[{type:'tool_result',tool_use_id:call.id,content:json(result)}]}])],
        ...(tools.length?{tool_choice:{type:'auto',disable_parallel_tool_use:true},
          tools:nativeTools(tools).map(({parameters,...t})=>({...t,input_schema:parameters}))}:{}),
        ...(structured?{output_config:{format:{type:'json_schema',schema:structured}}}:{})})
    case 'gemini': {
      const path=model.chatPath.replace('{model}',encodeURIComponent(model.model.replace(/^models\//,'')))+
        (stream?':streamGenerateContent?alt=sse':':generateContent')
      return request({
        systemInstruction:{parts:[{text:system}]},generationConfig:{maxOutputTokens:model.outputTokens,...temperature,
          ...(structured?{responseMimeType:'application/json',responseJsonSchema:structured}:{})},
        contents:[{role:'user',parts:[{text:user},...images.map(a=>({inlineData:{mimeType:a.contentType,data:a.data}}))]},
          ...exchanges.flatMap(({call,result})=>[{role:'model',parts:call.assistant},
            {role:'user',parts:[{functionResponse:{name:call.name,...(call.id?{id:call.id}:{}),response:{result}}}]}])],
        ...(tools.length?{tools:[{functionDeclarations:nativeTools(tools).map(({parameters,...t})=>({...t,parametersJsonSchema:parameters}))}]}:{})
      },path)
    }
    default:
      return request({model:model.model,messages:[{role:'system',content:system},
        {role:'user',content:images.length?[{type:'text',text:user},...images.map(a=>({type:'image_url',image_url:{url:imageUrl(a)}}))]:user},
        ...exchanges.flatMap(({call,result})=>[{role:'assistant',content:null,
          tool_calls:[{id:call.id,type:'function',function:{name:call.name,arguments:call.arguments}}]},
        {role:'tool',tool_call_id:call.id,content:json(result)}])],
      [model.outputLimitField??'max_completion_tokens']:model.outputTokens,stream,...temperature,
      ...(structured?{response_format:{type:'json_schema',json_schema:{name:'maoqiu_decision',strict:true,schema:structured}}}:{}),
      ...(tools.length?{tools:tools.map(tool=>({type:'function',function:tool})),parallel_tool_calls:false}:{})})
  }
}

function single<T>(calls:T[]):T|undefined{
  if(calls.length>1)fail('每个主聊步骤只接受一个工具请求',502)
  return calls[0]
}
function incomplete():never {return fail('模型回复未完整结束，请调整输出预算或检查供应商限制',502)}

export function protocolAnswer(protocol:ModelConfig['protocol'],stream:boolean,delta?:(text:string)=>void){
  let response:any, finish:string|undefined, usage:unknown, text='', id='', name='', args=''
  const blocks:any[]=[]
  const stagedArgs=new Map<number,string>()
  function frame(raw:any){
    if(raw.error||['error','response.failed','response.incomplete'].includes(raw.type))incomplete()
    if(!stream){response=raw;return}
    let chunk=''
    if(protocol==='openai-compatible'){
      const choice=raw.choices?.[0]
      finish=choice?.finish_reason??finish
      usage=raw.usage??usage
      chunk=choice?.delta?.content??''
      const tool=single<any>(choice?.delta?.tool_calls??[])
      if(tool){
        if((tool.index??0)!==0)fail('每个主聊步骤只接受一个工具请求',502)
        id=tool.id??id;name+=tool.function?.name??'';args+=tool.function?.arguments??''
      }
    }else if(protocol==='openai-responses'){
      if(raw.type==='response.output_text.delta')chunk=raw.delta??''
      if(raw.type==='response.completed')response=raw.response
    }else if(protocol==='anthropic'){
      if(raw.type==='content_block_start'){
        blocks[raw.index]=raw.content_block
        chunk=raw.content_block?.type==='text'?raw.content_block.text??'':''
      }
      if(raw.type==='content_block_delta'){
        const block=blocks[raw.index],part=raw.delta
        if(!block||!part)incomplete()
        if(part.type==='text_delta'){block.text+=part.text;chunk=part.text}
        if(part.type==='input_json_delta')stagedArgs.set(raw.index,(stagedArgs.get(raw.index)??'')+part.partial_json)
        if(part.type==='thinking_delta')block.thinking+=part.thinking
        if(part.type==='signature_delta')block.signature=part.signature
      }
      if(raw.type==='message_delta'){finish=raw.delta?.stop_reason;usage=raw.usage}
      if(raw.type==='message_stop')response={content:blocks,stop_reason:finish,usage}
    }else{
      if(raw.promptFeedback?.blockReason)incomplete()
      const candidate=raw.candidates?.[0]
      for(const part of candidate?.content?.parts??[]){
        blocks.push(part)
        if(!part.thought&&typeof part.text==='string')chunk+=part.text
      }
      finish=candidate?.finishReason??finish
      usage=raw.usageMetadata??usage
      response={candidates:[{content:{parts:blocks},finishReason:finish}],usageMetadata:usage}
    }
    if(typeof chunk==='string'&&chunk){text+=chunk;delta?.(chunk)}
  }
  function answer():Output{
    if(protocol==='openai-compatible'){
      if(!stream){
        const choice=response?.choices?.[0]
        finish=choice?.finish_reason
        usage=response?.usage
        text=choice?.message?.content??''
        const tool=single<any>(choice?.message?.tool_calls??[])
        if(tool){id=tool.id??'';name=tool.function?.name??'';args=tool.function?.arguments??''}
      }
      if(stream&&!finish||['length','content_filter'].includes(finish??'')||name&&finish!=='tool_calls')incomplete()
      return {text,usage,call:name?{id,name,arguments:args}:undefined}
    }
    if(!response)incomplete()
    if(protocol==='openai-responses'){
      if(response.status!=='completed'||!Array.isArray(response.output))incomplete()
      const output=response.output as any[]
      const tool=single(output.filter(part=>part.type==='function_call'))
      text=output.filter(part=>part.type==='message').flatMap(part=>part.content??[])
        .filter(part=>part.type==='output_text').map(part=>part.text).join('')
      if(tool&&(!tool.call_id||tool.status&&tool.status!=='completed'))incomplete()
      return {text,usage:response.usage,call:tool?{id:tool.call_id,name:tool.name,arguments:tool.arguments,assistant:output}:undefined}
    }
    if(protocol==='anthropic'){
      const {content,stop_reason,usage}=response
      if(!['end_turn','stop_sequence','tool_use'].includes(stop_reason)||!Array.isArray(content))incomplete()
      for(const [index,input] of stagedArgs){
        try{content[index].input=JSON.parse(input)}catch{incomplete()}
      }
      text=content.filter(part=>part.type==='text').map(part=>part.text).join('')
      const tool=single(content.filter(part=>part.type==='tool_use'))
      if(tool&&(!tool.id||stop_reason!=='tool_use'))incomplete()
      return {text,usage,call:tool?{id:tool.id,name:tool.name,arguments:json(tool.input),assistant:content}:undefined}
    }
    const candidate=response.candidates?.[0]
    if(candidate?.finishReason!=='STOP')incomplete()
    const parts:any[]=candidate.content?.parts??[]
    const tool=single(parts.filter(part=>part.functionCall))?.functionCall
    text=parts.filter(part=>!part.thought&&typeof part.text==='string').map(part=>part.text).join('')
    return {text,usage:response.usageMetadata,call:tool?{id:tool.id??'',name:tool.name,arguments:json(tool.args??{}),assistant:parts}:undefined}
  }
  return {frame,answer}
}
