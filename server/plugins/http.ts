import { lookup } from 'node:dns/promises'
import type { LookupFunction } from 'node:net'
import { request as http } from 'node:http'
import { request as https } from 'node:https'
import ipaddr from 'ipaddr.js'
import { fail } from '../db/index.ts'

type Address={address:string;family:number}
type Network='public'|'api'|'lan'
type Options={
  network:Network; signal:AbortSignal; timeoutMs?:number; maxBytes?:number; redirects?:number;
  method?:string; headers?:Record<string,string>; body?:string;
  beforeRedirect?:(url:URL,signal:AbortSignal)=>Promise<void>
}
export const networkAgent='MaoqiuBot/1.0'

function parsedAddress(address:string){
  if(address.includes('%'))fail('禁止使用带作用域的网络地址',403)
  try{return ipaddr.process(address)}catch{fail('网络地址无效',403)}
}
export function addressAllowed(address:string,network:Network){
  const ip=parsedAddress(address),range=ip.range()
  if(network==='lan'&&['private','uniqueLocal'].includes(range))return true
  if(range!=='unicast')return false
  return ip.kind()==='ipv4'||(ip.toByteArray()[0]&0xe0)===0x20
}
export function networkUrl(value:string,network:Network){
  const url=URL.parse(value)
  if(!url||!['http:','https:'].includes(url.protocol)||url.username||url.password||url.href.length>3000)
    fail('只支持不含认证信息的 HTTP(S) URL')
  const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase().replace(/\.$/,'')
  if(!host||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.internal')||host.endsWith('.local')&&network!=='lan'||
    host==='metadata'||host==='instance-data'||network==='public'&&url.port||network==='api'&&url.protocol!=='https:')
    fail('目标地址超出此网络能力的授权范围',403)
  url.hash=''
  return url
}
export async function checkedAddresses(url:URL,network:Network,resolve:typeof lookup=lookup){
  const host=url.hostname.replace(/^\[|\]$/g,'')
  const addresses:Address[]=ipaddr.isValid(host)?[{address:host,family:host.includes(':')?6:4}]:
    await resolve(host,{all:true,verbatim:true})
  if(!addresses.length||addresses.some(a=>!addressAllowed(a.address,network)))fail('目标的 DNS 或 IP 包含不可访问的地址',403)
  return addresses
}
function pinnedLookup(addresses:Address[]):LookupFunction{
  return (_host,options,callback)=>{
    if(options.all){
      callback(null,addresses)
      return
    }
    const entry=addresses.find(address=>!options.family||address.family===options.family)??addresses[0]
    callback(null,entry.address,entry.family)
  }
}
function once(url:URL,addresses:Address[],options:Options,signal:AbortSignal){
  return new Promise<{status:number;location?:string;type:string;bytes:Buffer}>((resolve,reject)=>{
    const transport=url.protocol==='https:'?https:http
    const req=transport(url,{method:options.method??'GET',agent:false,lookup:pinnedLookup(addresses),signal,
      headers:{'user-agent':networkAgent,'accept-encoding':'identity',...options.headers}},res=>{
      const status=res.statusCode??502
      const location=res.headers.location,type=res.headers['content-type']??''
      if(status>=300&&status<400){
        resolve({status,location,type,bytes:Buffer.alloc(0)});res.destroy();return
      }
      // Request an identity encoding and reject it if the remote ignores that preference.
      const limit=options.maxBytes??2*1024*1024
      if(res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'||Number(res.headers['content-length'])>limit){
        reject(Object.assign(Error('响应编码不受支持或大小超过限制'),{status:502}));res.destroy();return
      }
      let size=0
      const chunks:Buffer[]=[]
      res.on('data',(chunk:Buffer)=>{
        size+=chunk.length
        if(size>limit){
          reject(Object.assign(Error('响应大小超过限制'),{status:502}));res.destroy();return
        }
        chunks.push(chunk)
      })
      res.once('end',()=>resolve({status,location,type,bytes:Buffer.concat(chunks)}))
      res.once('error',reject)
    })
    req.once('error',reject)
    req.end(options.body)
  })
}
function abortable<T>(promise:Promise<T>,signal:AbortSignal){
  return new Promise<T>((resolve,reject)=>{
    if(signal.aborted){promise.catch(()=>{});reject(signal.reason);return}
    const abort=()=>reject(signal.reason)
    signal.addEventListener('abort',abort,{once:true})
    promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort))
  })
}
let inFlight=0
export async function readHttp(value:string,options:Options){
  if(inFlight>=8)fail('网络工具达到并发上限，请稍后重试',429)
  const clock=AbortSignal.timeout(options.timeoutMs??9000)
  const signal=AbortSignal.any([clock,options.signal])
  inFlight++
  try{
    let url=networkUrl(value,options.network)
    for(let hop=0;;hop++){
      signal.throwIfAborted()
      const addresses=await abortable(checkedAddresses(url,options.network),signal)
      const result=await once(url,addresses,options,signal)
      if(![301,302,303,307,308].includes(result.status)||!result.location)return {...result,url:url.href}
      if(hop>=(options.redirects??0)||options.method&&options.method!=='GET'||options.headers?.authorization)
        fail('网络目标尝试重定向，请核对地址',502)
      url=networkUrl(new URL(result.location,url).href,options.network)
      await options.beforeRedirect?.(url,signal)
    }
  }catch(e){
    if(options.signal.aborted)throw options.signal.reason
    if(clock.aborted)fail('网络请求超时',504)
    if((e as {status?:number}).status)throw e
    fail('无法连接目标服务器',502)
  }finally{inFlight--}
}
