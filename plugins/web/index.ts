import { createHash } from 'node:crypto'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import robots from 'robots-parser'
import type { PluginContext,ToolContext,ToolReference } from '../../contracts/plugin.ts'
import { fail } from '../../server/db/index.ts'
import { networkAgent,networkUrl,readHttp } from '../../server/plugins/http.ts'

type Config={provider?:'brave'|'searxng';endpoint?:string;keyEnv?:string;privateLan?:boolean;
  language?:string;region?:string;timeoutMs?:number;maxResults?:number}
const reference=(url:string,title:string,retrievedAt:string):ToolReference=>({
  id:'web-'+createHash('sha256').update(url).digest('hex').slice(0,16),url,title,retrievedAt})
const text=(value:unknown,max:number)=>typeof value==='string'?value.replace(/\s+/g,' ').trim().slice(0,max):''
function publicLink(value:unknown,base?:string){
  if(typeof value!=='string')return
  try{return networkUrl(new URL(value,base).href,'public').href}catch{}
}
const asString=(a:Record<string,unknown>,key:string)=>typeof a[key]==='string'?a[key] as string:undefined

export async function search(config:Config,a:Record<string,unknown>,ctx:ToolContext){
  const query=asString(a,'query')?.trim()
  if(!query||!ctx.requestText?.includes(query))fail('公开检索词须摘自当前用户消息',403)
  const provider=config.provider
  if(!provider)fail('请在网页插件设置里配置 Brave Search 或 SearXNG',409)
  const brave=provider==='brave'
  const url=brave?new URL('https://api.search.brave.com/res/v1/web/search'):
    networkUrl(config.endpoint??'',config.privateLan?'lan':'api')
  const key=brave?process.env[config.keyEnv??'MAOQIU_PLUGIN_KEY_BRAVE']:undefined
  if(brave&&!key)fail('Brave Search API 密钥未配置',409)
  const limit=Math.min(Number(a.limit??8),config.maxResults??20)
  const domains=Array.isArray(a.domains)?a.domains as string[]:[]
  url.searchParams.set('q',query+(domains.length?' ('+domains.map(d=>'site:'+d).join(' OR ')+')':''))
  const language=asString(a,'language')??config.language
  const region=asString(a,'region')??config.region
  if(brave){
    url.searchParams.set('count',String(limit))
    if(language)url.searchParams.set('search_lang',language)
    if(region)url.searchParams.set('country',region.toUpperCase())
    if(a.freshness)url.searchParams.set('freshness',String(a.freshness))
  }else{
    url.searchParams.set('format','json')
    if(language)url.searchParams.set('language',language+(region?'-'+region.toUpperCase():''))
    if(a.freshness)url.searchParams.set('time_range',({pd:'day',pw:'week',pm:'month',py:'year'} as Record<string,string>)[String(a.freshness)])
  }
  const started=Date.now()
  const res=await readHttp(url.href,{network:!brave&&config.privateLan?'lan':'api',signal:ctx.signal,
    timeoutMs:config.timeoutMs,maxBytes:768*1024,headers:{accept:'application/json',...(key?{'x-subscription-token':key}:{})}})
  if([401,403].includes(res.status))fail('搜索服务拒绝认证或未开放 JSON 搜索权限',502)
  if(res.status===402||res.status===429)fail('搜索服务报告额度不足或限流',502)
  if(res.status!==200)fail('搜索服务返回 HTTP '+res.status,502)
  let parsed:any
  try{parsed=JSON.parse(res.bytes.toString('utf8'))}catch{fail('搜索服务没有返回有效 JSON',502)}
  const values=brave?parsed.web?.results??[]:parsed.results
  if(!Array.isArray(values))fail('搜索响应缺少结果列表',502)
  const retrievedAt=new Date().toISOString()
  const results=values.flatMap(v=>{
    const url=publicLink(v?.url),title=text(v?.title,240)
    if(!url||!title)return []
    const snippet=text(brave?v.description:v.content,480)
    if(key&&[url,title,snippet].some(value=>value.includes(key)))return []
    return [{...reference(url,title,retrievedAt),snippet,provider,publicationDate:text(v.page_age??v.publishedDate,80)||undefined}]
  }).slice(0,limit)
  return {query,provider,retrievedAt,elapsedMs:Date.now()-started,results,references:results.map(({id,url,title,retrievedAt})=>({id,url,title,retrievedAt}))}
}

async function checkRobots(url:URL,signal:AbortSignal){
  const robotUrl=new URL('/robots.txt',url)
  const result=await readHttp(robotUrl.href,{network:'public',signal,maxBytes:512*1024,redirects:3,timeoutMs:4000})
  if([404,410].includes(result.status))return
  if(result.status!==200)fail('无法核对网站的 robots.txt 访问规则',403)
  if(robots(robotUrl.href,result.bytes.toString('utf8')).isAllowed(url.href,networkAgent)===false)
    fail('该网站的 robots.txt 不允许抓取此页面',403)
}
export function extractHtml(html:string,url:string){
  const {document}=parseHTML(html)
  const title=text(document.title,240)
  const publicationDate=document.querySelector('meta[property="article:published_time"],meta[name="date"]')?.getAttribute('content')
  const article=new Readability(document as unknown as Document).parse()
  if(!article?.textContent?.trim())fail('网页没有可提取正文，可能需要登录或运行 JavaScript',502)
  const links=[...parseHTML(article.content??'').document.querySelectorAll('a[href]')].flatMap(node=>{
    const href=publicLink(node.getAttribute('href'),url)
    return href?[{url:href,title:text(node.textContent,160)||href}]:[]
  }).slice(0,16)
  return {title:text(article.title,240)||title||new URL(url).hostname,
    body:article.textContent.replace(/\s+/g,' ').trim(),author:text(article.byline,160)||undefined,
    publicationDate:text(article.publishedTime??publicationDate,80)||undefined,links}
}
export async function readPage(config:Config,value:string,maxChars:number,ctx:ToolContext,explicit=false){
  const url=networkUrl(value,'public')
  if(!explicit&&!ctx.authorizedDestinations.includes(url.href)&&!ctx.requestText?.includes(value))fail('只读取当前用户提供或本轮检索找到的网页',403)
  const started=Date.now()
  const signal=AbortSignal.any([ctx.signal,AbortSignal.timeout(config.timeoutMs??12000)])
  await checkRobots(url,signal)
  const res=await readHttp(url.href,{network:'public',signal,redirects:4,maxBytes:2*1024*1024,
    beforeRedirect:checkRobots,headers:{accept:'text/html,text/plain,application/json;q=0.8'}})
  if(res.status!==200)fail('网页返回 HTTP '+res.status,502)
  const mime=res.type.split(';')[0].trim().toLowerCase()
  if(!['text/html','application/xhtml+xml','text/plain','application/json'].includes(mime))fail('读取工具仅支持公开的 HTML、纯文本和 JSON',415)
  const charset=/charset\s*=\s*["']?([\w-]+)/i.exec(res.type)?.[1]??'utf-8'
  let raw:string
  try{raw=new TextDecoder(charset).decode(res.bytes)}catch{fail('不支持网页声明的文本编码',415)}
  const extracted=mime.includes('html')?extractHtml(raw,res.url):{title:new URL(res.url).pathname,body:raw.trim(),links:[]}
  if(!extracted.body)fail('网页没有正文',502)
  const retrievedAt=new Date().toISOString(),ref=reference(res.url,extracted.title,retrievedAt)
  return {...ref,...extracted,body:extracted.body.slice(0,maxChars),truncated:extracted.body.length>maxChars,status:res.status,
    elapsedMs:Date.now()-started,references:[ref]}
}
export function activate(ctx:PluginContext){
  const config=ctx.config as Config
  const schema=(properties:object,required:string[])=>({type:'object',properties,required,additionalProperties:false})
  const url={type:'string',minLength:8,maxLength:3000}
  const maxChars={type:'integer',minimum:400,maximum:10000}
  ctx.registerTool({name:'search',description:'搜索公开网页，query 从用户当前原话摘取。返回链接和摘要。',
    risk:'read',network:'network.public',parameters:schema({query:{type:'string',minLength:2,maxLength:400},
      limit:{type:'integer',minimum:1,maximum:20},language:{type:'string',pattern:'^[a-zA-Z-]{2,16}$'},
      region:{type:'string',pattern:'^[a-zA-Z]{2}$'},freshness:{enum:['pd','pw','pm','py']},
      domains:{type:'array',maxItems:5,items:{type:'string',pattern:'^[a-zA-Z0-9.-]{3,80}$'}}},['query']),
    execute:(args,context)=>search(config,args,context)})
  ctx.registerTool({name:'read',description:'读取用户给出的公开 URL 或本轮检索找到的链接，提取正文和引用。',
    risk:'read',network:'network.public',parameters:schema({url,maxChars},['url']),
    execute:(a,c)=>readPage(config,String(a.url),Number(a.maxChars??5000),c)})
  ctx.registerTool({name:'read_many',description:'读取至多三个本轮已经授权的公开网页，各自返回结果。',
    risk:'read',network:'network.public',parameters:schema({urls:{type:'array',minItems:1,maxItems:3,items:url},maxChars},['urls']),
    async execute(a,c){
      const results=await Promise.all((a.urls as string[]).map(async url=>{
        try{return await readPage(config,url,Math.min(Number(a.maxChars??1500),3000),c)}
        catch(e){return {url,error:(e as Error).message}}
      }))
      return {results,references:results.flatMap(v=>'references' in v?v.references:[])}
    }})
}
export async function test(config:Config,input:Record<string,unknown>,signal:AbortSignal){
  const value=asString(input,'value')?.trim()
  if(!value||value.length>3000)fail('请填写测试搜索词或网页 URL')
  const ctx:ToolContext={actor:'user',threadId:'',messageId:'',projectId:null,signal,maxResultBytes:4000,
    requestText:value,authorizedDestinations:[]}
  if(input.kind==='read'){
    const result=await readPage(config,value,800,ctx,true)
    return {ok:true,title:result.title,url:result.url,status:result.status,body:result.body}
  }
  if(input.kind!=='search'||value.length>400)fail('测试搜索词最多 400 个字符')
  const result=await search(config,{query:value,limit:3},ctx)
  return {ok:true,provider:result.provider,results:result.results,elapsedMs:result.elapsedMs}
}
