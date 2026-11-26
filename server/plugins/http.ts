import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { LookupFunction, Socket } from 'node:net'
import { request as http } from 'node:http'
import { request as https } from 'node:https'
import { connect as tls } from 'node:tls'
import ipaddr from 'ipaddr.js'
import { fail } from '../db/index.ts'

type Address={address:string;family:number}
type Network='public'|'api'|'lan'
type Options={
  network:Network; signal:AbortSignal; timeoutMs?:number; maxBytes?:number; redirects?:number;
  method?:string; headers?:Record<string,string>; body?:string;
  proxy?:'direct'|'environment';
  proxyUrl?:string;
  beforeRedirect?:(url:URL,signal:AbortSignal)=>Promise<void>
}
export const networkAgent='MaoqiuBot/1.0'

function parsedAddress(address:string){
  if(address.includes('%'))fail('禁止使用带作用域的网络地址',403)
  try{return ipaddr.process(address)}catch{fail('网络地址无效',403)}
}
export function addressAllowed(address:string,network:Network){
  const ip=parsedAddress(address),range=ip.range()
  if(network==='lan')return ['private','uniqueLocal'].includes(range)
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
  return validateAddresses(await resolveAddresses(url,resolve),network)
}
async function resolveAddresses(url:URL,resolve:typeof lookup=lookup){
  const host=url.hostname.replace(/^\[|\]$/g,'')
  return ipaddr.isValid(host)?[{address:host,family:host.includes(':')?6:4}]:await resolve(host,{all:true,verbatim:true})
}
function validateAddresses(addresses:Address[],network:Network){
  if(!addresses.length)fail('目标的 DNS 没有可访问的地址',403)
  if(network==='lan'&&addresses.some(a=>!addressAllowed(a.address,network)))
    fail('此局域网配置仅允许私网地址，目标不可访问。公网 API 请关闭局域网选项并改用 HTTPS。',403)
  if(addresses.some(a=>!addressAllowed(a.address,network)))fail('目标的 DNS 或 IP 包含不可访问的地址',403)
  return addresses
}
const port=(url:URL)=>url.port||(url.protocol==='https:'?'443':'80')
const env=(key:string)=>process.env[key.toLowerCase()]||process.env[key]
function configuredProxy(url:URL,explicit?:string){
  const host=url.hostname.toLowerCase().replace(/\.$/,'')
  if(env('NO_PROXY')?.split(/[\s,]+/).some(entry=>{
    if(entry==='*')return true
    const [,name='',entryPort]=/^((?:\[[^\]]+\]|[^:]+))(?::(\d+))?$/.exec(entry.toLowerCase())??[]
    if(!name||entryPort&&entryPort!==port(url))return false
    const suffix=name.replace(/^\*/,'').replace(/\.$/,'')
    return host===suffix||suffix.startsWith('.')&&(host===suffix.slice(1)||host.endsWith(suffix))
  }))return
  const value=explicit||(url.protocol==='https:'?env('HTTPS_PROXY'):env('HTTP_PROXY'))||env('ALL_PROXY')
  if(!value)return
  const proxy=URL.parse(value.includes('://')?value:'http://'+value)
  if(!proxy||!['http:','https:'].includes(proxy.protocol)||!proxy.hostname||proxy.pathname!=='/'||proxy.search||proxy.hash||
    explicit&&(proxy.username||proxy.password))
    fail('网页代理须使用 HTTP 或 HTTPS CONNECT 地址',502)
  return proxy
}
function tunnel(url:URL,address:Address,proxy:URL,signal:AbortSignal){
  return new Promise<Socket>((resolve,reject)=>{
    const target=(address.family===6?'['+address.address+']':address.address)+':'+port(url)
    const headers:Record<string,string>={host:target}
    if(proxy.username||proxy.password){
      const credentials=decodeURIComponent(proxy.username)+':'+decodeURIComponent(proxy.password)
      headers['proxy-authorization']='Basic '+Buffer.from(credentials).toString('base64')
    }
    const request=(proxy.protocol==='https:'?https:http)({hostname:proxy.hostname.replace(/^\[|\]$/g,''),
      port:port(proxy),method:'CONNECT',path:target,agent:false,headers,signal})
    request.once('error',reject)
    request.once('connect',(response,socket,head)=>{
      if(response.statusCode!==200||signal.aborted){
        socket.destroy()
        reject(Object.assign(Error('网页代理未建立 CONNECT 隧道（HTTP '+response.statusCode+'）'),{status:502}))
        return
      }
      if(head.length)socket.unshift(head)
      const host=url.hostname.replace(/^\[|\]$/g,'')
      resolve(url.protocol==='https:'?tls({socket,host,servername:isIP(host)?undefined:host}):socket)
    })
    request.end()
  })
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
async function once(url:URL,addresses:Address[],options:Options,signal:AbortSignal,proxy?:URL){
  const socket=proxy?await tunnel(url,addresses.find(a=>a.family===4)??addresses[0],proxy,signal):undefined
  try{return await new Promise<{status:number;location?:string;type:string;bytes:Buffer}>((resolve,reject)=>{
    const transport=url.protocol==='https:'?https:http
    const req=transport(url,{method:options.method??'GET',signal,
      ...(socket?{createConnection:()=>socket}:{agent:false,lookup:pinnedLookup(addresses)}),
      headers:{'user-agent':networkAgent,'accept-encoding':'identity',...(socket?{host:url.host}:{}),...options.headers}},res=>{
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
  })}finally{socket?.destroy()}
}
async function proxyAddresses(url:URL,options:Options,signal:AbortSignal,proxy?:URL){
  const addresses=await abortable(resolveAddresses(url),signal)
  const fakeIp=({address}:Address)=>{
    const bytes=ipaddr.process(address).toByteArray()
    return bytes.length===4&&bytes[0]===198&&(bytes[1]===18||bytes[1]===19)
  }
  if(!proxy||!addresses.some(fakeIp)||!addresses.every(a=>fakeIp(a)||addressAllowed(a.address,options.network)))
    return validateAddresses(addresses,options.network)
  const host=url.hostname.replace(/\.$/,'')
  if(!host.includes('.')||isIP(host))return validateAddresses(addresses,options.network)
  // Fake-IP DNS answers are not routable destinations. Resolve them over the tunnel, then pin a public IP.
  const dns=new URL('https://1.1.1.1/dns-query')
  dns.searchParams.set('name',host)
  const answers=await Promise.all([['A',1,4],['AAAA',28,6]].map(async ([name,type,family])=>{
    const query=new URL(dns)
    query.searchParams.set('type',String(name))
    const result=await once(query,[{address:'1.1.1.1',family:4}],{network:'api',signal,maxBytes:32768,
      headers:{accept:'application/dns-json'}},signal,proxy)
    if(result.status!==200)fail('网页代理的公网 DNS 核对失败',502)
    const body=JSON.parse(result.bytes.toString('utf8')) as {Status?:number;Answer?:{type:number;data:string}[]}
    if(body.Status!==0)fail('网页代理的公网 DNS 未返回有效答案',502)
    return (Array.isArray(body.Answer)?body.Answer:[]).filter(a=>a.type===type)
      .map(a=>({address:String(a.data),family:Number(family)}))
  }))
  return validateAddresses(answers.flat(),options.network)
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
      const proxy=options.network!=='lan'&&options.proxy==='environment'?configuredProxy(url,options.proxyUrl):undefined
      const addresses=await proxyAddresses(url,options,signal,proxy)
      const result=await once(url,addresses,options,signal,proxy)
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
