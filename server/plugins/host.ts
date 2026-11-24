import { execFile } from 'node:child_process'
import { lstatSync,mkdirSync,readFileSync,rmSync } from 'node:fs'
import { basename,isAbsolute,join } from 'node:path'
import { fileURLToPath,pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type { PluginCapability,PluginContext,PluginEvent,PluginManifest,PluginModule,PluginProvider,ToolDefinition } from '../../contracts/plugin.ts'
import type { Core } from '../chat/tools.ts'
import { readLocal,writeLocal } from '../chat/model-settings.ts'
import { fail,id,required } from '../db/index.ts'
import { declarativeTool } from './api-tool.ts'
import { fingerprint,packagePath,readText,relativePath,skillMetadata,tree,writeTree,zipTree } from './files.ts'
import { pluginManifest } from './manifest.ts'
import { toolEntry,validateSchema } from './registry.ts'
import type { RegisteredTool } from './registry.ts'
import { zipSync } from 'fflate'

type Package={folder:string;digest:string;manifest:PluginManifest;source:string;projectId?:string}
type Entry={current?:Package;pending?:Package;previous?:Package;enabled:boolean;trusted?:string;config:Record<string,unknown>}
type State={revision:number;entries:Record<string,Entry>}
type Skill=ReturnType<typeof skillMetadata>&{id:string;root:string;projectId?:string;source:string;version:string}
type Handler=(event:PluginEvent)=>void|Promise<void>
type Live={manifest:PluginManifest;tools:Map<string,RegisteredTool<Core>>;skills:Map<string,Skill>;
  providers:Map<string,PluginProvider>;handlers:Map<PluginEvent['type'],Set<Handler>>;stop?:()=>void|Promise<void>;
  test?:PluginModule['test']}
const stateFile='plugins.json'
const identifier=/^[a-z][a-z0-9-]{0,39}$/
const exportedName=/^[a-z][a-z0-9_]{0,31}$/
const uuid=/^[a-f0-9-]{36}$/
const checkSyntax=promisify(execFile)
const bundled={web:fileURLToPath(new URL('../../plugins/web/',import.meta.url))}
const network=new Set<PluginCapability>(['network.public','network.api'])

async function lifecycle<T>(work:()=>T|Promise<T>){
  let timer:ReturnType<typeof setTimeout>|undefined
  try{
    return await Promise.race([Promise.resolve().then(work),new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>reject(Error('插件生命周期超时')),5000)
    })])
  }finally{clearTimeout(timer)}
}

function explain(error:unknown){
  if((error as {status?:number}).status)return (error as Error).message
  return '扩展加载或校验失败，请检查入口文件、依赖和宿主版本'
}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)

export function pluginHost(dir:string){
  const root=join(dir,'plugins','packages'),safe=process.env.MAOQIU_SAFE_PLUGINS==='1'
  mkdirSync(root,{recursive:true,mode:0o700})
  let state:State, configurationError:string|undefined
  try{
    state=readLocal<State>(dir,stateFile,{revision:0,entries:{}})
    if(!object(state.entries)||!Number.isSafeInteger(state.revision)||Object.values(state.entries).some(item=>!object(item)||!object(item.config)))
      throw Error('invalid state')
  }
  catch{state={revision:0,entries:{}};configurationError='插件安装配置无法读取，已跳过加载'}
  const active=new Map<string,Live>(),errors=new Map<string,string>(),restart=new Set<string>()
  const builtin=new Map<string,Package>()
  for(const [name,path] of Object.entries(bundled)){
    try{
      const manifest=pluginManifest(path)
      builtin.set(name,{folder:name,digest:fingerprint(tree(path)),source:'bundled',manifest})
    }catch(error){errors.set(name,explain(error))}
  }
  const registeredTools=new Map<string,RegisteredTool<Core>>()
  const packageRoot=(pkg:Package)=>{
    if(pkg.source==='bundled'&&Object.hasOwn(bundled,pkg.folder))return bundled[pkg.folder as keyof typeof bundled]
    if(!uuid.test(pkg.folder))fail('插件安装目录无效')
    return packagePath(root,pkg.folder)
  }
  function snapshot(){
    registeredTools.clear()
    for(const item of active.values())for(const [name,tool] of item.tools)registeredTools.set(name,tool)
  }
  function save(name:string,value:Entry|undefined,changed=false){
    if(configurationError)fail(configurationError,409)
    const entries={...state.entries}
    if(value)entries[name]=value;else delete entries[name]
    const next={entries,revision:state.revision+(changed?1:0)}
    writeLocal(dir,stateFile,next)
    state=next
  }
  function entry(name:string):Entry{
    const saved=Object.hasOwn(state.entries,name)?state.entries[name]:undefined
    const current=builtin.get(name)
    if(!saved)return {current,enabled:false,config:{}}
    return saved.current?.source==='bundled'?{...saved,current}:saved
  }
  function verifyPackage(pkg:Package){
    const path=packageRoot(pkg)
    if(fingerprint(tree(path))!==pkg.digest)fail('包内容已经改变，请重新导入并审查',409)
    return {path,manifest:pluginManifest(path)}
  }
  async function prepare(pkg:Package,item:Entry):Promise<Live>{
    const {path,manifest}=verifyPackage(pkg)
    if(pkg.source!=='bundled'&&safe)fail('安全模式暂停外部扩展',409)
    if(manifest.entry&&pkg.source!=='bundled'&&item.trusted!==pkg.digest)fail('此版本的本机代码需要所有者信任',403)
    for(const dependency of manifest.requires??[]){
      if(!active.has(dependency))fail('缺少已启用的插件依赖：'+dependency,409)
      if(dependsOn(dependency,manifest.id))fail('插件依赖形成循环',409)
    }
    if(manifest.configSchema&&!validateSchema(manifest.configSchema)(item.config))fail('插件配置不符合清单')
    const live:Live={manifest,tools:new Map(),skills:new Map(),providers:new Map(),handlers:new Map()}
    const namespace=manifest.id.replaceAll('-','_')+'__'
    const permitted=(cap:PluginCapability)=>{
      if(!manifest.capabilities.includes(cap))fail('插件未声明能力：'+cap,403)
    }
    let accepting=true
    const add=<T>(map:Map<string,T>,name:string,value:T)=>{
      if(!accepting||map.has(name))fail('插件注册重复名称或已退出激活阶段')
      map.set(name,value)
      return ()=>{map.delete(name);if(active.get(manifest.id)===live)snapshot()}
    }
    const context:PluginContext={
      config:Object.freeze(structuredClone(item.config)),
      dataDir:join(dir,'plugins','data',manifest.id),
      registerTool(tool:ToolDefinition){
        permitted('tools')
        if(!exportedName.test(tool.name)||!['read','confirm'].includes(tool.risk))fail('插件工具名称或风险级别无效')
        if(tool.network){if(!network.has(tool.network))fail('插件工具网络能力无效');permitted(tool.network)}
        const name=namespace+tool.name
        if(name.length>64||registeredTools.has(name)&&!active.get(manifest.id)?.tools.has(name))fail('插件工具名称过长或冲突')
        return add(live.tools,name,toolEntry<Core>({name,description:tool.description,parameters:tool.parameters,async:true,
          confirm:tool.risk==='confirm',allowed:c=>c.actor==='user'&&(!pkg.projectId||pkg.projectId===c.thread.projectId)&&
            (!c.model||tool.network==='network.public'||(c.thread.projectId?c.model.shareProject:c.model.sharePersonal)),
          execute:(c,args)=>tool.execute(args,{actor:c.actor,threadId:c.thread.id,messageId:c.current.id,projectId:c.thread.projectId,
            signal:c.signal,maxResultBytes:7500,requestText:c.current.text,authorizedDestinations:[...(c.webDestinations??[])]})}))
      },
      registerProvider(provider){
        permitted('providers')
        if(pkg.projectId||!exportedName.test(provider.id)||typeof provider.generate!=='function')fail('插件模型提供方配置无效')
        const name='plugin:'+namespace+provider.id
        return add(live.providers,name,{...provider,id:name})
      },
      registerSkill({path:rel}){
        permitted('skills')
        const root=packagePath(path,rel)
        const meta=skillMetadata(readText(root,'SKILL.md',128000),rel)
        const name=manifest.id+'/'+meta.name
        return add(live.skills,name,{...meta,id:name,root,projectId:pkg.projectId,source:pkg.source,version:manifest.version})
      },
      on(type,handler){
        permitted('events')
        if(!accepting||!['tool.finished','task.communication','task.delivery'].includes(type))fail('该事件不可订阅')
        const handlers=live.handlers.get(type)??new Set<Handler>()
        handlers.add(handler);live.handlers.set(type,handlers)
        return ()=>{handlers.delete(handler)}
      }
    }
    try{
      for(const rel of manifest.skills??[])context.registerSkill({path:rel})
      for(const tool of manifest.httpTools??[])context.registerTool(declarativeTool(tool))
      if(manifest.entry){
        mkdirSync(context.dataDir,{recursive:true,mode:0o700})
        const mod=await lifecycle(()=>import(pathToFileURL(packagePath(path,manifest.entry!)).href)) as PluginModule
        if(typeof mod.activate!=='function')fail('插件代码缺少 activate()')
        live.stop=mod.deactivate
        live.test=mod.test
        await lifecycle(()=>mod.activate(context))
      }
      return live
    }catch(e){
      if(manifest.entry&&pkg.source!=='bundled')restart.add(manifest.id)
      try{await lifecycle(()=>live.stop?.())}catch{}
      throw e
    }
    finally{accepting=false}
  }
  function dependsOn(name:string,target:string,seen=new Set<string>()):boolean{
    if(name===target)return true
    if(seen.has(name))return false
    seen.add(name)
    return (active.get(name)?.manifest.requires??[]).some(d=>dependsOn(d,target,seen))
  }
  async function replace(name:string,item:Entry,live?:Live){
    const old=active.get(name)
    try{save(name,item,true)}catch(e){try{await lifecycle(()=>live?.stop?.())}catch{}throw e}
    if(live)active.set(name,live);else active.delete(name)
    snapshot()
    if(old){
      if(item.current?.source!=='bundled'&&old.manifest.entry)restart.add(name)
      try{await lifecycle(()=>old.stop?.())}catch{restart.add(name)}
    }
    errors.delete(name)
  }
  const ready=(async()=>{
    const queued=new Map(Object.keys(state.entries).filter(name=>entry(name).enabled).map(name=>[name,entry(name)]))
    while(queued.size){
      const selected=[...queued].find(([,item])=>!item.current?.manifest.requires?.some(dep=>queued.has(dep)))
      if(!selected){for(const name of queued.keys())errors.set(name,'插件依赖形成循环');break}
      const [name,item]=selected
      queued.delete(name)
      if(!item.current)continue
      const pkg=item.current.source==='bundled'?builtin.get(name):item.current
      if(!pkg){errors.set(name,'随应用安装的插件缺失');continue}
      try{active.set(name,await prepare(pkg,item));snapshot()}
      catch(e){errors.set(name,explain(e))}
    }
  })()
  let tail:Promise<unknown>=ready
  function exclusive<T>(fn:()=>Promise<T>|T){
    const result=tail.then(fn)
    tail=result.catch(()=>{})
    return result
  }
  const stage=(files:Map<string,Buffer>,source:string,projectId?:string)=>{
    const folder=id(),path=join(root,folder)
    try{
      writeTree(path,files)
      const manifest=pluginManifest(path)
      if(builtin.has(manifest.id))fail('此插件 ID 由随应用安装的插件保留')
      if(!Object.hasOwn(state.entries,manifest.id)&&Object.keys(state.entries).length>=60)fail('最多管理 60 个外部插件')
      const pkg={folder,digest:fingerprint(tree(path)),manifest,source,projectId}
      const previous=entry(manifest.id)
      save(manifest.id,{...previous,pending:pkg})
      clean(previous.pending)
      return {id:manifest.id,digest:pkg.digest,version:manifest.version}
    }catch(e){rmSync(path,{recursive:true,force:true});throw e}
  }
  function clean(pkg?:Package){
    if(pkg&&pkg.source!=='bundled'&&uuid.test(pkg.folder)){
      try{rmSync(join(root,pkg.folder),{recursive:true,force:true})}catch{}
    }
  }
  function list(){
    const ids=new Set([...builtin.keys(),...Object.keys(state.entries),...errors.keys()])
    return {safe,configurationError,plugins:[...ids].map(name=>{
      const item=entry(name),live=active.get(name)
      const summarize=(pkg?:Package)=>pkg&&({manifest:pkg.manifest,source:pkg.source,digest:pkg.digest,projectId:pkg.projectId})
      return {id:name,enabled:item.enabled,loaded:Boolean(live),error:errors.get(name),restartRequired:restart.has(name),
        config:item.config,current:summarize(item.current),pending:summarize(item.pending),previous:summarize(item.previous),
        tools:[...(live?.tools.keys()??[])],skills:[...(live?.skills.keys()??[])],providers:[...(live?.providers.keys()??[])],
        events:[...(live?.handlers.keys()??[])],testAvailable:typeof live?.test==='function'}
    })}
  }
  async function manage(body:any,signal:AbortSignal){
    return exclusive(async()=>{
      signal.throwIfAborted()
      if(body.action==='stage'){
        if(body.github){
          const repo=required(body.github,'GitHub 仓库'),commit=required(body.commit,'Git commit')
          if(!/^[\w.-]+\/[\w.-]+$/.test(repo)||!/^([a-f0-9]{40})$/i.test(commit))fail('请输入 GitHub owner/repo 和完整 commit ID')
          const url='https://codeload.github.com/'+repo+'/zip/'+commit
          const response=await fetch(url,{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])})
            .catch(()=>fail('无法连接 GitHub 固定提交的下载服务',502))
          if(response.status!==200||!response.body){
            await response.body?.cancel()
            fail('无法取得指定的 GitHub commit（HTTP '+response.status+'）',502)
          }
          const reader=response.body.getReader(),chunks:Uint8Array[]=[]
          let size=0
          try{
            for(;;){
              const data=await reader.read()
              if(data.done)break
              size+=data.value.length
              if(size>8*1024*1024)fail('插件压缩包超过 8 MiB')
              chunks.push(data.value)
            }
          }finally{await reader.cancel().catch(()=>{})}
          return stage(zipTree(Buffer.concat(chunks)),repo+'@'+commit,body.projectId)
        }
        const path=required(body.path,'本机源路径')
        if(!isAbsolute(path)||path.startsWith('\\\\')||/^\/\//.test(path))fail('请输入本机绝对路径')
        if(lstatSync(path).isSymbolicLink())fail('导入路径不能是链接')
        const stat=lstatSync(path)
        let files:Map<string,Buffer>
        if(stat.isFile()&&/\.zip$/i.test(path)&&stat.size<=8*1024*1024)files=zipTree(readFileSync(path))
        else if(stat.isDirectory())files=tree(path)
        else fail('请选择插件目录或 8 MiB 以内的 ZIP 文件')
        if(!files.has('plugin.json')){
          if(!stat.isDirectory())fail('Skill 导入请选择含 SKILL.md 的目录')
          if(files.has('SKILL.md')){
            const name=basename(path),meta=skillMetadata(files.get('SKILL.md')!.toString('utf8'),name)
            files=new Map([...files].map(([file,bytes])=>[name+'/'+file,bytes]))
            files.set('plugin.json',Buffer.from(JSON.stringify({id:name,name,version:'1.0.0',hostApi:1,
              description:meta.description.slice(0,400),capabilities:['skills'],skills:[name]})))
          }else{
            const pi=JSON.parse(files.get('package.json')?.toString('utf8')??'null')
            if(!Array.isArray(pi?.pi?.skills)||!pi.pi.skills.length)fail('找不到插件清单或 Pi 标准 Skill 声明')
            const skills:string[]=pi.pi.skills.flatMap((item:string)=>{
              const rel=relativePath(item.replace(/^\.\//,'').replace(/\/$/,''))
              return [...files.keys()].filter(file=>file===rel+'/SKILL.md'||file.startsWith(rel+'/')&&file.endsWith('/SKILL.md'))
                .map(file=>file.slice(0,-'/SKILL.md'.length))
            })
            const name=required(body.id,'Skill 包 ID')
            if(!skills.length)fail('没有找到 Pi 声明的 Skill 目录')
            files=new Map([...files].filter(([file])=>skills.some(skill=>file.startsWith(skill+'/'))))
            files.set('plugin.json',Buffer.from(JSON.stringify({id:name,name,version:'1.0.0',hostApi:1,
              description:'从 Pi 包导入的标准 Skill',capabilities:['skills'],skills:[...new Set(skills)]})))
          }
        }
        return stage(files,'local:'+basename(path),body.projectId)
      }
      if(body.action==='stageManifest'){
        if(!object(body.manifest)||body.manifest.entry)fail('声明式编辑只接受无代码插件清单')
        return stage(new Map([['plugin.json',Buffer.from(JSON.stringify(body.manifest,null,2))]]),'local:declarative',body.projectId)
      }
      const name=required(body.id,'插件 ID')
      if(!identifier.test(name))fail('插件 ID 无效')
      const item=entry(name)
      switch(body.action){
        case 'review': return review(item,body.version)
        case 'test':{
          const plugin=active.get(name)
          if(!plugin?.test||!object(body.input))fail('此插件没有可用的连接测试',409)
          return plugin.test(Object.freeze(structuredClone(item.config)),body.input,signal)
        }
        case 'source':{
          const pkg=packageVersion(item,body.version)
          if(!pkg||body.digest!==pkg.digest)fail('包内容已经改变，请重新审查',409)
          return {text:readText(verifyPackage(pkg).path,required(body.path,'源文件'),256000)}
        }
        case 'export':{
          const pkg=packageVersion(item,body.version)
          if(!pkg)fail('插件未找到',404)
          return {filename:name+'-'+pkg.manifest.version+'.zip',
            data:Buffer.from(zipSync(Object.fromEntries(tree(verifyPackage(pkg).path)))).toString('base64')}
        }
        case 'validate': return validate(item.pending??item.current)
        case 'activate':{
          const pkg=item.pending??item.current
          if(!pkg||body.digest!==pkg.digest)fail('插件版本已改变，请重新审查',409)
          if(pkg.manifest.entry&&pkg.source!=='bundled'&&body.trustCode!==true&&item.trusted!==pkg.digest)
            fail('启用本机代码须确认该版本的执行权限',403)
          if(pkg.manifest.capabilities.some(cap=>network.has(cap))&&body.allowNetwork!==true)
            fail('请确认此版本的网络能力',403)
          const next={...item,current:pkg,previous:item.pending?item.current:item.previous,pending:undefined,
            enabled:true,trusted:pkg.source!=='bundled'&&pkg.manifest.entry?pkg.digest:undefined}
          try{await replace(name,next,await prepare(pkg,next))}catch(e){errors.set(name,explain(e));fail(explain(e),409)}
          if(item.pending)clean(item.previous)
          break
        }
        case 'rollback':{
          const pkg=item.previous
          if(!pkg||body.digest!==pkg.digest)fail('请选择并审查要回滚的版本',409)
          if(pkg.manifest.entry&&body.trustCode!==true)fail('回滚代码版本须重新确认运行权限',403)
          if(pkg.manifest.capabilities.some(cap=>network.has(cap))&&body.allowNetwork!==true)fail('请确认此版本的网络能力',403)
          const next={...item,current:pkg,previous:item.current,enabled:true,trusted:pkg.manifest.entry?pkg.digest:undefined}
          await replace(name,next,await prepare(pkg,next));break
        }
        case 'configure':{
          if(!item.current||!object(body.config))fail('插件配置须为对象')
          const next={...item,config:structuredClone(body.config)}
          if(item.current.manifest.configSchema&&!validateSchema(item.current.manifest.configSchema)(next.config))fail('插件配置不符合清单')
          const networkConfig=item.current.manifest.capabilities.some(cap=>network.has(cap))&&
            JSON.stringify(item.config)!==JSON.stringify(next.config)
          if(item.enabled&&networkConfig&&body.allowNetwork!==true)fail('请确认更新后的网络配置',403)
          if(item.enabled&&item.current.manifest.entry&&item.current.source!=='bundled'){
            await replace(name,next)
            restart.add(name)
          }else if(item.enabled)await replace(name,next,await prepare(item.current,next));else save(name,next)
          break
        }
        case 'disable':
        case 'uninstall':{
          if([...active.keys()].some(other=>other!==name&&dependsOn(other,name)))fail('请先停用依赖此插件的扩展',409)
          if(body.action==='uninstall'&&builtin.has(name))fail('随应用安装的插件可停用',409)
          await replace(name,{...item,enabled:false})
          if(body.action==='uninstall'){save(name,undefined);clean(item.current);clean(item.pending);clean(item.previous)}
          break
        }
        default:fail('插件操作无效')
      }
      return list()
    })
  }
  function packageVersion(item:Entry,version:unknown){
    return version==='previous'?item.previous:version==='current'?item.current:item.pending??item.current
  }
  function review(item:Entry,version?:unknown){
    const pending=packageVersion(item,version)
    if(!pending)fail('插件未找到',404)
    const after=tree(verifyPackage(pending).path)
    const before=item.current&&item.current!==pending?tree(verifyPackage(item.current).path):new Map<string,Buffer>()
    const files=[...new Set([...before.keys(),...after.keys()])].filter(name=>!before.get(name)?.equals(after.get(name)??Buffer.alloc(0))||!after.has(name))
      .map(name=>({path:name,before:preview(before.get(name)),after:preview(after.get(name))}))
    return {digest:pending.digest,manifest:pending.manifest,source:pending.source,
      addedCapabilities:pending.manifest.capabilities.filter(c=>!item.current?.manifest.capabilities.includes(c)),files}
  }
  function preview(bytes?:Buffer){
    return !bytes?null:bytes.includes(0)?'(二进制 '+bytes.length+' 字节)':bytes.subarray(0,12000).toString('utf8')
  }
  async function validate(pkg?:Package){
    if(!pkg)fail('插件未找到',404)
    const {path,manifest}=verifyPackage(pkg)
    const files=[...tree(path).keys()]
    for(const file of files.filter(f=>/\.(?:[cm]?js|ts)$/.test(f))){
      try{
        await checkSyntax(process.execPath,['--check',packagePath(path,file)],{
          timeout:5000,windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}})
      }catch{fail('语法检查失败：'+file)}
    }
    for(const skill of manifest.skills??[])skillMetadata(readText(packagePath(path,skill),'SKILL.md',128000),skill)
    return {id:manifest.id,digest:pkg.digest,files,checks:['plugin.json','JSON Schema','JavaScript / TypeScript 语法','SKILL.md'],executed:false}
  }
  return {ready,manage,list,tools:registeredTools,
    stageDraft(files:Map<string,Buffer>,signal:AbortSignal,projectId?:string){
      return exclusive(()=>{signal.throwIfAborted();return stage(files,'creator',projectId)})
    },
    validateDraft(name:string,projectId:string|null){
      const pkg=entry(name).pending
      if(!pkg||pkg.source!=='creator'||(pkg.projectId??null)!==projectId)fail('当前范围内没有该草稿',404)
      return validate(pkg)
    },
    get revision(){return state.revision},
    provider(key:string){for(const plugin of active.values()){const match=plugin.providers.get(key);if(match)return match}},
    providers(){return [...active.values()].flatMap(plugin=>[...plugin.providers.values()])},
    skills(projectId?:string|null){
      return [...active.values()].flatMap(plugin=>[...plugin.skills.values()]).filter(skill=>!skill.projectId||skill.projectId===projectId)
    },
    publish(event:PluginEvent){
      for(const plugin of active.values())for(const fn of plugin.handlers.get(event.type)??[]){
        void Promise.resolve().then(()=>fn(Object.freeze({...event}))).catch(()=>errors.set(plugin.manifest.id,'插件事件处理失败'))
      }
    }
  }
}
export type PluginHost=ReturnType<typeof pluginHost>
