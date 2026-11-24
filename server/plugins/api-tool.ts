import type { DeclarativeTool,ToolDefinition } from '../../contracts/plugin.ts'
import { fail,required } from '../db/index.ts'
import { networkUrl,readHttp } from './http.ts'
import { validateSchema } from './registry.ts'

const optionsSchema=validateSchema({type:'object',additionalProperties:false,
  required:['name','description','parameters','endpoint','method'],
  properties:{
    name:{type:'string',pattern:'^[a-z][a-z0-9_]{0,31}$'},description:{type:'string',minLength:1,maxLength:400},
    parameters:{type:'object',required:['type'],properties:{type:{const:'object'}}},endpoint:{type:'string',maxLength:2000},
    method:{enum:['GET','POST','PUT','PATCH','DELETE']},privateLan:{type:'boolean'},path:{type:'string',maxLength:200},
    query:{type:'object',maxProperties:20,additionalProperties:{type:'string'}},
    body:{type:'object',maxProperties:20,additionalProperties:{type:'string'}},
    outputPath:{type:'array',maxItems:8,items:{type:'string',maxLength:80}},
    keyEnv:{type:'string',pattern:'^MAOQIU_PLUGIN_KEY_[A-Z0-9_]{1,80}$'},
    timeoutMs:{type:'integer',minimum:250,maximum:30000},maxBytes:{type:'integer',minimum:1024,maximum:1048576}
  }})
export function declarativeTool(raw:DeclarativeTool):ToolDefinition{
  if(!optionsSchema(raw))fail('声明式 API 工具配置无效：'+(optionsSchema.errors?.[0]?.instancePath??''))
  const network=raw.privateLan?'lan':'api'
  const endpoint=networkUrl(raw.endpoint,network)
  if(endpoint.search||new URL(raw.endpoint).hash)fail('固定 API 端点须省略查询参数和片段')
  const declared=raw.parameters as {properties?:Record<string,unknown>}
  const keys=Object.keys(declared.properties??{})
  const segments=raw.path?.split('/').slice(1)??[]
  const template=/^\{([a-zA-Z0-9_]+)\}$/
  const fields=segments.flatMap(segment=>template.exec(segment)?.[1]??[])
  if(raw.path&&(!raw.path.startsWith('/')||segments.some(s=>!template.test(s)&&(!/^[\w.~%-]+$/.test(s)||s.includes('%')||['.','..'].includes(s)))))
    fail('API 路径只允许固定路径段和整段参数')
  for(const name of [...fields,...Object.values(raw.query??{}),...Object.values(raw.body??{})]){
    if(!keys.includes(name))fail('API 参数映射引用未声明的字段')
  }
  if(raw.method==='GET'&&raw.body)fail('GET API 工具不能配置请求正文')
  validateSchema(raw.parameters)
  return {name:raw.name,description:raw.description,parameters:raw.parameters,network:'network.api',risk:raw.method==='GET'?'read':'confirm',
    async execute(args,ctx){
      const target=new URL(endpoint)
      if(segments.length)target.pathname=target.pathname.replace(/\/$/,'')+'/'+segments.map(segment=>{
        const field=template.exec(segment)?.[1]
        if(!field)return segment
        const value=required(String(args[field]??''),'路径参数')
        if(!/^[\p{L}\p{N}._~-]{1,160}$/u.test(value)||['.','..'].includes(value))fail('API 路径参数不是有效的单个路径段')
        return encodeURIComponent(value)
      }).join('/')
      for(const [param,field] of Object.entries(raw.query??{})){
        const v=args[field]
        if(v===undefined)continue
        if(typeof v==='object')fail('查询参数须为基本类型')
        target.searchParams.append(param,String(v))
      }
      const key=raw.keyEnv?process.env[raw.keyEnv]:undefined
      if(raw.keyEnv&&!key)fail('缺少该工具配置的密钥环境变量',409)
      const body=raw.body?JSON.stringify(Object.fromEntries(Object.entries(raw.body).map(([param,field])=>[param,args[field]]))):undefined
      const response=await readHttp(target.href,{network,signal:ctx.signal,timeoutMs:raw.timeoutMs,maxBytes:raw.maxBytes??256*1024,
        method:raw.method,body,headers:{accept:'application/json',...(key?{authorization:'Bearer '+key}:{}),...(body?{'content-type':'application/json'}:{})}})
      if(response.status<200||response.status>=300)fail('业务 API 返回 HTTP '+response.status,502)
      if(response.status===204)return {data:null,status:response.status}
      if(!/\b(?:application\/json|application\/[\w.+-]+\+json)\b/i.test(response.type))fail('业务 API 须返回 JSON 内容',502)
      let data:unknown
      try{data=JSON.parse(response.bytes.toString('utf8'))}catch{fail('业务 API 返回无效 JSON',502)}
      if(key&&JSON.stringify(data).includes(key))fail('业务 API 返回包含认证信息，已屏蔽',502)
      for(const part of raw.outputPath??[]){
        if(!data||typeof data!=='object'||!Object.hasOwn(data,part))fail('业务 API 缺少配置的结果字段',502)
        data=(data as Record<string,unknown>)[part]
      }
      return {data,status:response.status}
    }
  }
}
