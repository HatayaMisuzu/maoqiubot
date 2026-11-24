import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fail, id, required } from '../db/index.ts'

export const protocols=['openai-compatible','openai-responses','anthropic','gemini'] as const
export type ModelProtocol=typeof protocols[number]
const defaultPaths:Record<ModelProtocol,string>={
  'openai-compatible':'/chat/completions','openai-responses':'/responses',anthropic:'/messages',gemini:'/models/{model}'
}
export type ModelConfig={
  id:string; name:string; protocol:ModelProtocol; baseUrl:string; model:string;
  chatPath:string; modelsPath:string; headers:Record<string,string>; keyEnv?:string;
  inputChars:number; outputTokens:number; timeoutMs:number; outputLimitField?:'max_completion_tokens'|'max_tokens';
  structured:boolean; tools:boolean; vision:boolean; stream:boolean; disabled?:boolean;
  allowLanHttp?:boolean; temperature?:number;
  shareProject:boolean; sharePersonal:boolean; shareAttachments:boolean;
}
type Settings={activeId:string; models:ModelConfig[]}
type SavedKey=string|{value:string;baseUrl:string;protocol:ModelProtocol}
export function readLocal<T>(dir:string,name:string,fallback:T):T{
  try{return JSON.parse(readFileSync(join(dir,name),'utf8')) as T}
  catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw Error('本机主聊配置无法读取');return fallback}
}
export function writeLocal(dir:string,name:string,data:unknown){
  const path=join(dir,name),temp=join(dir,'.chat-'+id())
  try{writeFileSync(temp,JSON.stringify(data,null,2),{mode:0o600,flag:'wx'});renameSync(temp,path)}
  finally{rmSync(temp,{force:true})}
}
const configFile='chat-models.json', keyFile='chat-model-keys.json'
const settings=(dir:string)=>readLocal<Settings>(dir,configFile,{activeId:'codex',models:[]})
const keys=(dir:string)=>readLocal<Record<string,SavedKey>>(dir,keyFile,{})
function credential(saved:SavedKey|undefined,model:ModelConfig){
  if(typeof saved==='string')return saved
  return saved?.baseUrl===model.baseUrl&&saved.protocol===model.protocol?saved.value:undefined
}
const headerNames=new Set(['http-referer','x-title','openai-organization','openai-project','anthropic-version','anthropic-beta'])
function bounded(value:unknown,name:string,min:number,max:number,fallback:number){
  if(value==null)return fallback
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)fail(name+' 须为 '+min+' 到 '+max+' 的整数')
  return value
}
function pathSuffix(value:unknown,fallback:string,templated=false){
  if(value==null)return fallback
  if(typeof value!=='string'||!/^\/[\w/-]+$/.test(templated?value.replace('{model}','model'):value)||value.includes('//')||value.length>120)fail('接口路径须为本站路径')
  return value
}
function normalized(b:any,key:string):ModelConfig{
  const name=required(b.name,'显示名'),model=required(b.model,'模型 ID')
  if(name.length>80||model.length>200)fail('显示名或模型 ID 过长')
  const protocol:ModelProtocol=b.protocol??'openai-compatible'
  if(!protocols.includes(protocol))fail('不支持该主聊模型协议')
  if(protocol==='gemini'&&!/^(?:models\/)?[\w.-]+$/.test(model))fail('Gemini 模型 ID 无效')
  const base=URL.parse(required(b.baseUrl,'Base URL'))
  const local=base&&['localhost','127.0.0.1','[::1]'].includes(base.hostname)
  const lan=base&&/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)\d+(?:\.\d+){0,2}$/.test(base.hostname)
  if(!base||(base.protocol!=='https:'&&!(base.protocol==='http:'&&(local||lan&&b.allowLanHttp===true)))||base.username||base.password||base.search||base.hash)
    fail('端点须为 HTTPS 或本机 HTTP，地址中不能包含认证信息、查询参数或片段')
  const keyEnv=b.keyEnv||undefined
  if(keyEnv&&(typeof keyEnv!=='string'||!/^MAOQIU_MODEL_KEY_[A-Z0-9_]{1,80}$/.test(keyEnv)))fail('密钥环境变量须使用 MAOQIU_MODEL_KEY_ 前缀')
  if(b.outputLimitField!=null&&!['max_completion_tokens','max_tokens'].includes(b.outputLimitField))fail('不支持此输出预算字段')
  const headers:Record<string,string>={}
  if(b.headers!==undefined){
    if(!b.headers||typeof b.headers!=='object'||Array.isArray(b.headers))fail('兼容请求头格式无效')
    for(const [name,value] of Object.entries(b.headers)){
      if(!headerNames.has(name.toLowerCase())||typeof value!=='string'||value.length>256||!/^[\x20-\x7e]+$/.test(value))fail('不支持该自定义请求头')
      headers[name.toLowerCase()]=value
    }
  }
  if(b.temperature!=null&&(typeof b.temperature!=='number'||!Number.isFinite(b.temperature)||b.temperature<0||b.temperature>1))
    fail('温度须在 0 与 1 之间')
  return {id:key,name,protocol,baseUrl:base.href.replace(/\/$/,''),model,allowLanHttp:b.allowLanHttp===true,temperature:b.temperature??undefined,
    chatPath:pathSuffix(b.chatPath,defaultPaths[protocol],protocol==='gemini'),modelsPath:pathSuffix(b.modelsPath,'/models'),headers,keyEnv,
    inputChars:bounded(b.inputChars,'上下文字符预算',4000,120000,24000),
    outputTokens:bounded(b.outputTokens,'输出令牌预算',64,16384,1600),timeoutMs:bounded(b.timeoutMs,'模型超时毫秒数',250,180000,60000),
    outputLimitField:b.outputLimitField??'max_completion_tokens',
    structured:b.structured===true,tools:b.tools===true,vision:b.vision===true,stream:b.stream===true,
    shareProject:b.shareProject===true,sharePersonal:b.sharePersonal===true,shareAttachments:b.shareAttachments===true}
}
export function modelSettings(dir:string,plugins:{id:string;name:string}[]=[]){
  const data=settings(dir),privateKeys=keys(dir)
  return {activeId:data.activeId,models:[
    {id:'codex',name:'本机 Codex',protocol:'codex',structured:true,tools:false,vision:true,stream:false},
    ...data.models.map(m=>({...m,hasKey:!!(credential(privateKeys[m.id],m)||m.keyEnv&&process.env[m.keyEnv])})),
    ...plugins.map(({id,name})=>({id,name,protocol:'plugin',structured:false,tools:false,vision:false,stream:false}))]}
}
export function updateModelSettings(dir:string,b:any,plugins:{id:string;name:string}[]=[]){
  const data=settings(dir),privateKeys=keys(dir)
  for(const model of data.models){
    const previous=privateKeys[model.id]
    if(typeof previous==='string')privateKeys[model.id]={value:previous,baseUrl:model.baseUrl,protocol:model.protocol}
  }
  if(b.action==='select'){
    if(b.id!=='codex'&&!data.models.some(m=>m.id===b.id&&!m.disabled)&&!plugins.some(p=>p.id===b.id))fail('主聊模型配置不存在或已停用',404)
    data.activeId=b.id
  }else if(b.action==='toggle'){
    const model=data.models.find(m=>m.id===b.id)
    if(!model)fail('主聊模型配置不存在',404)
    if(typeof b.disabled!=='boolean')fail('请指定是否停用主聊模型')
    if(b.disabled&&data.activeId===b.id)fail('请先选择其他主聊模型',409)
    model.disabled=b.disabled
  }else if(b.action==='delete'){
    if(!data.models.some(m=>m.id===b.id))fail('主聊模型配置不存在',404)
    data.models=data.models.filter(m=>m.id!==b.id)
    delete privateKeys[b.id]
    if(data.activeId===b.id)data.activeId='codex'
  }else if(b.action==='save'){
    const previous=b.id&&data.models.find(m=>m.id===b.id)
    if(b.id&&!previous)fail('主聊模型配置不存在',404)
    if(!previous&&data.models.length>=25)fail('主聊最多保存 25 组模型配置')
    const m=normalized(b,previous?.id??id())
    if(previous?.disabled)m.disabled=true
    if(b.apiKey!==undefined&&(typeof b.apiKey!=='string'||b.apiKey.length>4096||/[^\x21-\x7e]/.test(b.apiKey)))fail('密钥格式无效')
    const destinationChanged=previous&&(previous.baseUrl!==m.baseUrl||previous.protocol!==m.protocol)
    if(destinationChanged&&previous.keyEnv===m.keyEnv)delete m.keyEnv
    if(b.clearKey===true||m.keyEnv)delete privateKeys[m.id]
    else if(b.apiKey)privateKeys[m.id]={value:b.apiKey,baseUrl:m.baseUrl,protocol:m.protocol}
    if(destinationChanged&&!b.apiKey&&!m.keyEnv)delete privateKeys[m.id]
    data.models=[...data.models.filter(p=>p.id!==m.id),m]
  }else fail('未知模型设置操作')
  writeLocal(dir,keyFile,privateKeys)
  writeLocal(dir,configFile,data)
  return modelSettings(dir,plugins)
}
export function selectedModel(dir:string,providerId?:string){
  const cfg=settings(dir),key=providerId??cfg.activeId
  if(key==='codex')return null
  const model=cfg.models.find(m=>m.id===key)
  if(!model||model.disabled)fail('主聊模型配置不存在或已停用',404)
  const apiKey=model.keyEnv?process.env[model.keyEnv]:credential(keys(dir)[key],model)
  if(model.keyEnv&&!apiKey)fail('主聊模型缺少配置的密钥环境变量',409)
  return {model,apiKey}
}
