import type { DatabaseSync } from 'node:sqlite'
import { fail, one, owner, required, unpack, changed } from '../db/index.ts'
import { getTask, taskView, taskCommunications, delegate, control, reconcileRun, sendInput, getThread,
  nativeSessionTarget,importNativeSession,selectModel } from '../tasks/index.ts'
import { homeApi } from '../home/index.ts'
import type { Principal } from '../home/common.ts'
import type { ChatToolDefinition } from './provider.ts'
import { readLocal, writeLocal } from './model-settings.ts'
import type { ModelConfig } from './model-settings.ts'
import { allowedRoot, localFiles } from './files.ts'
import type { ToolEntry, RegisteredTool } from '../plugins/registry.ts'
import { parseTool, toolEntry } from '../plugins/registry.ts'
import { readText } from '../plugins/files.ts'
import type { PluginHost } from '../plugins/host.ts'
import type { NativeSession } from '../../contracts/node.ts'
import { calculate,dailyAction } from './daily.ts'
import { projectWorkspaces } from '../tasks/workspaces.ts'
import { basename } from 'node:path'
import { offerMemory,saveUserMemory } from './memory.ts'

export type DesktopBridge={
  status():unknown; restart():Promise<unknown>; save(settings:unknown):unknown;
  openPath(path:string):Promise<string>; notify?(body:string):void;
}
export type ToolServices={desktop?:DesktopBridge;listSessions?(inst:any,cursor:string|null):Promise<{items:NativeSession[];nextCursor:string|null}>}

type Policy={task:boolean;memory:boolean;homeContent:boolean;homeSpace:boolean;personalInProject:boolean;readRoots:string[];writeRoots:string[];
  pluginCreator?:boolean;desktop?:boolean;memoryCandidates?:boolean}
const policyFile='chat-policy.json'
export const chatPolicy=(dir:string)=>readLocal<Policy>(dir,policyFile,{
  task:true,memory:true,homeContent:false,homeSpace:false,personalInProject:false,readRoots:[],writeRoots:[]
})
export function saveChatPolicy(dir:string,b:any){
  const p=chatPolicy(dir)
  for(const key of ['task','memory','homeContent','homeSpace','personalInProject','pluginCreator','desktop','memoryCandidates'] as const){
    if(b[key]===undefined)continue
    if(typeof b[key]!=='boolean')fail('工具授权须为布尔值')
    p[key]=b[key]
  }
  for(const key of ['readRoots','writeRoots'] as const){
    if(b[key]===undefined)continue
    if(!Array.isArray(b[key])||b[key].length>10)fail('每组最多配置十个资料目录')
    p[key]=[...new Set<string>(b[key].map((v:unknown)=>allowedRoot(required(v,'资料目录'),dir)))]
  }
  writeLocal(dir,policyFile,p)
  return p
}
export type Core={db:DatabaseSync;dir:string;thread:any;current:any;model?:Pick<ModelConfig,'shareProject'|'sharePersonal'|'shareAttachments'>;
  allowedInstances:any[];materials:any[];attachmentIds:string[];signal:AbortSignal;actor:'user'|'work_bot'|'system';
  plugins?:PluginHost;webDestinations?:Set<string>;webSources?:Map<string,{url:string;title:string;retrievedAt:string;body?:string}>}
  & ToolServices
type Shape='string'|'integer'|'array'|'boolean'|'object'
type Tool=ToolEntry<Core>&{
  group?:keyof Pick<Policy,'task'|'memory'|'homeContent'|'homeSpace'|'desktop'>;
  project?:boolean;file?:'read'|'write';
  public?:boolean; creator?:boolean;
}
function define(name:string,description:string,shape:Record<string,Shape>,required:string[],opts:Omit<Tool,keyof ChatToolDefinition>):Tool{
  const parameters={type:'object',properties:Object.fromEntries(Object.entries(shape).map(([k,type])=>[k,{type,
    ...(type==='array'?{items:{},maxItems:30}:{})}])),required,additionalProperties:false}
  return {name,description,parameters,...opts}
}
function home(c:Core,method:string,path:string,body:object={},query:Record<string,string>={},asOwner=false){
  const project=c.thread.projectId
  const principal:Principal=asOwner||!project?owner:{id:'main',owner:false,projects:[project]}
  const result=homeApi(c.db,{method,path,body,dataDir:c.dir,principal,query:new URLSearchParams(query)})
  if(result===undefined)fail('资料工具接口不存在',404)
  if(method!=='GET'&&(!('mode' in body)||body.mode!=='preview'))changed(c.db,'home',{path,projectId:project})
  return result
}
const trail=(c:Core)=>({threadId:c.thread.id,messageId:c.current.id})
function scopedTask(c:Core,id:string){
  const task=getTask(c.db,id)
  if(task.projectId!==c.thread.projectId||!task.projectId&&task.originThreadId!==c.thread.id)fail('任务不在当前话题或项目范围内',403)
  return task
}
function progress(c:Core,id:string){
  const task=scopedTask(c,id),{run,commands,review}=taskView(c.db,task.id)
  const updates=c.db.prepare(`SELECT id,kind,text,createdAt FROM messages WHERE threadId=? AND role<>'user' AND text<>''
    AND (? IS NULL OR json_extract(data,'$.runId')=? OR kind='review') ORDER BY rowid DESC LIMIT 8`)
    .all(task.workThreadId,run?.id??null,run?.id??null).map(v=>({...v,text:String(v.text).slice(0,500)}))
  return {task:{id:task.id,goal:task.goal,status:task.status,workThreadId:task.workThreadId,instanceId:task.instanceId},
    run,commands:commands.slice(-12).map(({id,kind,status,detail}:any)=>({id,kind,status,detail})),updates,review}
}
function recordForScope(c:Core,id:string,asOwner=false){
  const record=home(c,'GET','/records/'+encodeURIComponent(id),{}, {},asOwner)
  if(record.projectId!==c.thread.projectId)fail('记录不在当前范围内',403)
  return record
}
const scopeQuery=(c:Core):Record<string,string>=>c.thread.projectId?{projectId:c.thread.projectId}:{scope:'personal'}
const idPath=(v:unknown)=>encodeURIComponent(required(v,'标识'))
const tools=[
  define('bot_list','查看本话题可用工作 Bot 的当前在线和能力',{},[],{execute:c=>c.allowedInstances}),
  define('bot_get','查看一个已注册工作 Bot 的能力、工作区与连接状态',{instanceId:'string'},['instanceId'],{execute:(c,a)=>{
    if(!c.allowedInstances.some(i=>i.id===a.instanceId))fail('实例不在当前授权范围',403)
    return unpack(one(c.db,'SELECT id,nodeId,name,adapterKey,workspaceRef,profileId,availableActions,lastSeen,online,capabilities FROM instances WHERE id=?',a.instanceId),['availableActions','capabilities'])
  }}),
  define('bot_sessions','列出当前实例在工作台已绑定的原生会话与可打开的工作话题',{instanceId:'string'},['instanceId'],{execute:(c,a)=>{
    if(!c.allowedInstances.some(i=>i.id===a.instanceId))fail('实例不在当前授权范围',403)
    return c.db.prepare(`SELECT id AS threadId,title,sessionId,taskId,createdAt FROM threads
      WHERE instanceId=? AND projectId IS ? AND sessionId IS NOT NULL ORDER BY rowid DESC LIMIT 25`).all(a.instanceId,c.thread.projectId)
  }}),
  define('bot_native_catalog','读取当前工作区实际提供的 Codex 原生会话目录',{instanceId:'string',cursor:'string'},['instanceId'],{
    async:true,execute:(c,a)=>{
      botAllowed(c,a.instanceId)
      if(!c.listSessions)fail('原生连接器不可用',409)
      return c.listSessions(nativeSessionTarget(c.db,a.instanceId,c.thread.projectId),a.cursor??null)
    }}),
  define('bot_native_import','导入核对过的 Codex 原生会话以便后续续接',{instanceId:'string',sessionId:'string',title:'string'},['instanceId','sessionId'],{
    group:'task',confirm:true,execute:(c,a)=>{
      botAllowed(c,a.instanceId)
      const result=importNativeSession(c.db,c.dir,a.instanceId,{...a,projectId:c.thread.projectId})
      if(result.thread.projectId!==c.thread.projectId)fail('原生会话已绑定其他范围',403)
      return result
    }}),
  define('bot_thread_model','选择当前工作话题下一轮使用的原生模型',{threadId:'string',modelId:'string'},['threadId','modelId'],{
    group:'task',confirm:true,execute:(c,a)=>selectModel(c.db,workThread(c,a.threadId),a.modelId)}),
  define('bot_workspaces','查看、绑定或解除当前项目的执行工作区及资料授权',{
    action:'string',instanceId:'string',workspaceRef:'string',allowAgentAccess:'boolean',agentPermission:'string'},['action'],{
      group:'task',project:true,confirm:a=>a.action!=='list',execute:(c,a)=>{
        const method=({list:'GET',bind:'POST',unbind:'DELETE'} as Record<string,string>)[a.action]
        if(!['GET','POST','DELETE'].includes(method))fail('工作区操作无效')
        return projectWorkspaces(c.db,c.thread.projectId,method,a)
      }}),
  define('bot_desktop_status','查看桌面管理的连接器及工作 Bot 配置',{},[],{
    group:'desktop',allowed:c=>!c.thread.projectId,execute:c=>desktop(c).status()}),
  define('bot_desktop_save','在桌面保存经过校验的 Codex 或 DSH 实例配置',{settings:'object'},['settings'],{
    group:'desktop',allowed:c=>!c.thread.projectId,confirm:true,execute:(c,a)=>desktop(c).save(a.settings)}),
  define('bot_desktop_reconnect','重启本机连接器以载入设置。存在在途运行时由桌面服务拒绝。',{},[],{
    group:'desktop',allowed:c=>!c.thread.projectId,confirm:true,async:true,execute:c=>desktop(c).restart()}),
  define('bot_open_topic','查找当前范围内可打开的工作话题',{threadId:'string'},['threadId'],{
    execute:(c,a)=>{const thread=workThread(c,a.threadId);return {workThreadId:thread.id,title:thread.title}}
  }),
  define('task_list','列出当前项目或话题的工作任务',{},[],{execute:c=>c.db.prepare(`SELECT id,goal,instanceId,status,workThreadId FROM tasks
    WHERE projectId IS ? AND (? IS NOT NULL OR originThreadId=?) ORDER BY rowid DESC LIMIT 30`).all(c.thread.projectId,c.thread.projectId,c.thread.id)}),
  define('task_progress','读取某个任务的真实运行、动作回执、最近消息与验收',{taskId:'string'},['taskId'],{execute:(c,a)=>progress(c,a.taskId)}),
  define('task_communications','读取当前任务的澄清、回复、交接和交付消息',{taskId:'string'},['taskId'],
    {execute:(c,a)=>{scopedTask(c,a.taskId);return taskCommunications(c.db,a.taskId)}}),
  define('task_delegate','创建工作任务。协调策略默认为 notify；仅用户明确要求时选择 assist 或 handoff，后者须指定 handoffTargets。',
    {instanceId:'string',goal:'string',constraints:'array',doneWhen:'array',refs:'array',coordination:'string',handoffTargets:'array'},['instanceId','goal'],
    {group:'task',confirm:true,execute:(c,a)=>{
      if(!c.allowedInstances.some(i=>i.id===a.instanceId))fail('实例不在当前授权范围',403)
      const refs=(a.refs??[]).map((v:any)=>({type:v?.type,id:v?.id}))
      return delegate(c.db,c.dir,{...a,originThreadId:c.thread.id,projectId:c.thread.projectId,attachmentIds:c.attachmentIds,
        refs:[...c.materials,...refs]},c.current.id)
    }}),
  define('task_control','补充、转达、停止或检查任务。原生权限确认由用户亲自作出',{taskId:'string',action:'string',text:'string',commandId:'string',replyTo:'string'},['taskId','action'],
    {group:'task',confirm:a=>a.action!=='inspect',execute:(c,a)=>{
      const task=scopedTask(c,a.taskId),{run}=taskView(c.db,task.id)
      if(!run)fail('任务没有可操作的运行')
      if(a.action==='inspect')return reconcileRun(c.db,run.id,{action:'inspect'})
      if(a.action==='message'){
        return sendInput(c.db,c.dir,getThread(c.db,task.workThreadId),{text:a.text,replyTo:a.replyTo,refs:c.materials,attachmentIds:c.attachmentIds},c.current.id)
      }
      if(!['steer','cancel','resume'].includes(a.action))fail('需要所有者直接操作该项运行控制',403)
      return control(c.db,c.dir,run.id,{kind:a.action,text:a.text,commandId:a.commandId,refs:c.materials,attachmentIds:c.attachmentIds},c.current.id)
    }}),
  define('home_search','按关键词查当前范围的来源、笔记、交接和记录',{query:'string',kind:'string'},['query'],
    {execute:(c,a)=>{
      if(c.model&&!c.model.shareAttachments&&a.kind==='source')fail('此模型未获授权读取原件资料',403)
      const kind=c.model&&!c.model.shareAttachments?'record':a.kind
      return home(c,'GET','/search',{}, {...scopeQuery(c),q:a.query,limit:'20',...(kind?{kind}:{})})
    }}),
  define('home_get','读取当前项目简报、记录、已授权来源、附件元数据或空间',{kind:'string',id:'string'},['kind'],
    {execute:(c,a)=>{
      const project=c.thread.projectId
      if(a.kind==='record')return recordForScope(c,a.id)
      if(a.kind==='brief'&&project){
        const {project:meta,requirements,decisions,latestWork,openItems,pendingVerification}=home(c,'GET','/projects/'+idPath(project)+'/brief')
        return {project:meta,requirements:requirements.slice(0,12),decisions:decisions.slice(0,12),latestWork:latestWork.slice(0,12),openItems,pendingVerification}
      }
      if(a.kind==='space'&&project){
        const p=home(c,'GET','/projects/'+idPath(project))
        if(a.id&&a.id!==p.spaceId)fail('只能读取当前项目的空间',403)
        return home(c,'GET','/spaces/'+idPath(p.spaceId))
      }
      if(['source','attachment'].includes(a.kind)){
        if(c.model&&!c.model.shareAttachments)fail('此模型未获授权读取原件资料',403)
        const original=home(c,'GET','/'+a.kind+'s/'+idPath(a.id),{},project?{projectId:project,meta:'1'}:{meta:'1'})
        if(!project&&(original.projectIds?.length||original.endpointIds?.length))fail('资料不在个人范围内',403)
        return a.kind==='source'?{...original,text:original.text.slice(0,9000),localRef:undefined}:original
      }
      fail('资料类型或范围不支持')
    }}),
  define('home_project_create','使用用户本轮明确指定的名称创建项目及默认空间',{name:'string'},['name'],
    {group:'homeContent',confirm:true,execute:(c,a)=>{
      if(c.thread.projectId||!a.name.trim()||!c.current.text.includes(a.name.trim()))fail('请在个人主聊明确指定新项目名称',403)
      if(one(c.db,'SELECT id FROM projects WHERE name=? LIMIT 1',a.name.trim()))fail('同名项目已存在，请先检查',409)
      return home(c,'POST','/projects',{name:a.name.trim()},{},true)
    }}),
  define('home_record_save','在当前项目保存记录、待办或交接',{type:'string',body:'string',refs:'array',sourceId:'string',remaining:'array',version:'string'},['type','body'],
    {group:'homeContent',confirm:true,project:true,execute:(c,a)=>{
      if(!['note','decision','requirement','handoff','todo'].includes(a.type))fail('该记录类型需所有者直接操作')
      return home(c,'POST','/projects/'+idPath(c.thread.projectId)+'/records',{type:a.type,body:a.body,refs:a.refs,sourceId:a.sourceId,
        author:'小毛球',extra:{...trail(c),remaining:a.remaining,version:a.version}})
    }}),
  define('home_record_update','修订当前项目的一条普通记录，保留原版本',{id:'string',expectedRevision:'integer',body:'string'},['id','expectedRevision','body'],
    {group:'homeContent',confirm:true,project:true,execute:(c,a)=>{
      recordForScope(c,a.id)
      return home(c,'PATCH','/records/'+idPath(a.id),{expectedRevision:a.expectedRevision,body:a.body})
    }}),
  define('home_collection_entries','查看当前项目集合条目，或按本轮指令新增、更新条目',{id:'string',action:'string',entryId:'string',
    expectedRevision:'integer',values:'object'},['id','action'],{project:true,confirm:a=>a.action!=='list',execute:(c,a)=>{
      const {id:projectId,spaceId}=home(c,'GET','/projects/'+idPath(c.thread.projectId))
      if(!one(c.db,'SELECT 1 FROM space_collections WHERE id=? AND space_id=?',a.id,spaceId)||projectId!==c.thread.projectId)
        fail('集合不在当前项目默认空间',403)
      const path='/collections/'+idPath(a.id)+'/entries'
      if(a.action==='list'){
        const result=home(c,'GET',path)
        return {...result,items:result.items.slice(0,25)}
      }
      if(!chatPolicy(c.dir).homeContent)fail('当前未授权修改集合内容',403)
      if(a.action==='create')return home(c,'POST',path,{values:a.values})
      if(a.action==='update')return home(c,'PATCH',path+'/'+idPath(a.entryId),{expectedRevision:a.expectedRevision,values:a.values})
      fail('集合操作无效')
    }}),
  define('home_space_change','预览或应用当前项目的页面、集合和布局操作',{mode:'string',expectedRevision:'integer',operations:'array'},['mode','expectedRevision','operations'],
    {group:'homeSpace',confirm:a=>a.mode==='apply',project:true,execute:(c,a)=>{
      if(!['preview','apply'].includes(a.mode)||!a.operations.length||a.operations.length>12)fail('空间操作数量或模式无效')
      const benign=['setSpace','createPage','updatePage','movePage','addBlock','updateBlock','moveBlock','createCollection','updateCollection','addField','toggleModule']
      if(a.operations.some((op:any)=>!benign.includes(op?.op)))fail('删除、恢复、字段转换等操作请通过空间编辑器核对后执行',403)
      const p=home(c,'GET','/projects/'+idPath(c.thread.projectId))
      const endpoint='/spaces/'+idPath(p.spaceId)+'/changes'
      const preview=home(c,'POST',endpoint,{...a,mode:'preview'})
      return a.mode==='apply'?home(c,'POST',endpoint,a):preview
    }}),
  define('memory_search','查找当前项目或个人范围内的记忆',{query:'string'},['query'],{execute:(c,a)=>
    home(c,'GET','/search',{}, {...scopeQuery(c),q:a.query,kind:'record',limit:'20'})}),
  define('memory_get','读取一条当前范围的记忆及修订',{id:'string'},['id'],{execute:(c,a)=>{
    recordForScope(c,a.id)
    return home(c,'GET','/records/'+idPath(a.id),{},{history:'1'})
  }}),
  define('memory_save','保存用户明确要求记住的原话。body 必须是当前用户话语中的原文片段',{body:'string',factKey:'string',type:'string',important:'boolean',validUntil:'string'},['body'],
    {group:'memory',confirm:true,execute:(c,a)=>{
      if(!a.body.trim()||!c.current.text.includes(a.body.trim()))fail('确认的记忆须引用当前真实用户原话',403)
      const type=a.type??'preference'
      if(!['preference','note','decision','requirement'].includes(type))fail('无效记忆分类')
      return saveUserMemory(c.db,c.dir,c.thread,{...a,type,messageId:c.current.id})
    }}),
  define('memory_offer','仅当用户本轮表达稳定信息且允许记忆候选时提议保存，候选仍需人工审阅。',
    {body:'string',factKey:'string',type:'string',important:'boolean'},['body'],{
      group:'memory',allowed:c=>chatPolicy(c.dir).memoryCandidates===true&&c.actor==='user',
      execute:(c,a)=>offerMemory(c.db,c.thread,c.current,a)??{status:'skipped'}}),
  define('memory_update','以本轮用户明确指定的原文更新记忆，保留原修订',{id:'string',expectedRevision:'integer',body:'string'},['id','expectedRevision','body'],
    {group:'memory',confirm:true,execute:(c,a)=>{
      if(!a.body.trim()||!c.current.text.includes(a.body.trim()))fail('须明确说明要更新的记忆和新的原文',403)
      const saved=recordForScope(c,a.id)
      if(!['preference','note','decision','requirement'].includes(saved.type))fail('所选记录不属于记忆分类',403)
      return home(c,'PATCH','/records/'+idPath(a.id),{...a,confirmation:'user',extra:{...saved.extra,...trail(c)}},{},true)
    }}),
  define('memory_forget','遗忘用户明确指定的本范围记忆，保留原件',{id:'string',expectedRevision:'integer'},['id','expectedRevision'],
    {group:'memory',confirm:true,execute:(c,a)=>{
      const saved=recordForScope(c,a.id)
      if(!['preference','note','decision','requirement'].includes(saved.type))fail('所选记录不属于记忆分类',403)
      return home(c,'DELETE','/records/'+idPath(a.id),{expectedRevision:a.expectedRevision},{},true)
    }}),
  define('local_files_list','列出授权资料目录内的文本文件和子目录',{root:'integer',path:'string'},['root'],
    {file:'read',execute:(c,a)=>file(c,a,'list')}),
  define('local_files_read','读取授权目录内的小型文本资料',{root:'integer',path:'string'},['root','path'],
    {file:'read',execute:(c,a)=>file(c,a,'read')}),
  define('local_files_write','在写入许可的目录新建资料文本，不覆盖',{root:'integer',path:'string',body:'string'},['root','path','body'],
    {file:'write',confirm:true,execute:(c,a)=>file(c,a,'write')}),
  define('local_files_open','在桌面打开已授权的文件夹或普通文本',{root:'integer',path:'string'},['root'],{
    file:'read',group:'desktop',confirm:true,async:true,execute:async(c,a)=>{
      const d=desktop(c),found=file(c,a,'open')
      const error=await d.openPath(found.localPath!)
      if(error)fail('桌面系统无法打开目标文件',409)
      return {opened:true,path:a.path??''}
    }}),
  define('local_files_archive','把已授权文本归档成毛球之家附件和来源',{root:'integer',path:'string'},['root','path'],{
    file:'read',group:'homeContent',confirm:true,execute:(c,a)=>{
      const found=file(c,a,'archive'),name=basename(a.path)
      const attached=home(c,'POST','/attachments',{name,projectId:c.thread.projectId??undefined,contentType:'text/plain',
        data:Buffer.from(found.text!,'utf8').toString('base64')},{},true)
      const archived=home(c,'POST','/submissions',{projectId:c.thread.projectId??undefined,source:{title:name,text:found.text,
        author:'小毛球',platform:'本机附件',attachmentIds:[attached.id]}},{},true)
      return {id:attached.id,sourceId:archived.sourceId,size:attached.size}
    }}),
  define('utility_clock','查询工作台当前时间（含 UTC 和上海时区）',{},[],{execute:()=>({
    utc:new Date().toISOString(),shanghai:new Intl.DateTimeFormat('zh-CN',{dateStyle:'short',timeStyle:'medium',timeZone:'Asia/Shanghai'}).format(new Date())
  }),public:true}),
  define('utility_calculate','精确计算四则运算和括号内小数，返回小数及精确分数',{expression:'string'},['expression'],{
    public:true,execute:(_c,a)=>calculate(a.expression)}),
  define('utility_daily','查询、创建、修改或处理当前范围的待办和提醒。dueAt 使用含时区的 ISO 时间。',
    {action:'string',id:'string',kind:'string',body:'string',dueAt:'string',expectedRevision:'integer'},['action'],{
      confirm:a=>a.action!=='list',execute:(c,a)=>dailyAction(c.db,c.thread,a)}),
  define('skill_list','查找已启用的标准 Skill 及用途',{query:'string'},[],{public:true,execute:(c,a)=>{
    const q=String(a.query??'').toLowerCase()
    return c.plugins?.skills(c.thread.projectId).filter(s=>
      (!s.projectId||!c.model||c.model.shareProject)&&(!q||(s.name+' '+s.description).toLowerCase().includes(q)))
      .slice(0,30).map(({root,projectId,...meta})=>meta)??[]
  }}),
  define('skill_read','按 ID 读取 Skill 正文或 references/、assets/ 中的文本',{id:'string',path:'string'},['id'],{
    allowed:c=>c.actor==='user',execute:(c,a)=>{
      const skill=c.plugins?.skills(c.thread.projectId).find(s=>s.id===a.id)
      if(!skill)fail('当前范围内没有该 Skill',404)
      const path=a.path??'SKILL.md'
      if(path!=='SKILL.md'&&!/^(references|assets)\//.test(path))fail('只能读取 Skill 正文、参考和文本资源',403)
      return {id:skill.id,version:skill.version,instructions:readText(skill.root,path,128000).slice(0,10000),trust:'external-data'}
    }}),
  define('plugin_list','查看当前扩展状态、版本和已注册能力',{},[],{creator:true,execute:c=>
    c.plugins?.list().plugins.filter(p=>[p.current,p.pending].some(pkg=>pkg&&(!pkg.projectId||pkg.projectId===c.thread.projectId)))
      .map(({id,loaded,tools,skills,providers,current,pending,error})=>({id,loaded,tools,skills,providers,error,
        version:current?.manifest.version,draftVersion:pending?.manifest.version}))??[]}),
  define('plugin_scaffold','创建或更新待审查插件草稿。优先声明式清单或标准 Skill。代码草稿使用 index.mjs 的 activate(ctx)。',
    {manifest:'object',source:'string',skillName:'string',skillText:'string'},['manifest'],{
      creator:true,confirm:true,async:true,execute:(c,a)=>{
        if(!c.plugins)fail('插件管理不可用',409)
        const files=new Map<string,Buffer>(),manifest={...a.manifest}
        if(a.source){manifest.entry='index.mjs';files.set('index.mjs',Buffer.from(a.source))}
        if(a.skillName||a.skillText){
          if(!a.skillName||!a.skillText||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(a.skillName))fail('须提供合规的 Skill 名称及正文')
          manifest.skills=['skills/'+a.skillName]
          files.set(manifest.skills[0]+'/SKILL.md',Buffer.from(a.skillText))
        }
        files.set('plugin.json',Buffer.from(JSON.stringify(manifest,null,2)))
        return c.plugins.stageDraft(files,c.signal,c.thread.projectId??undefined)
      }}),
  define('plugin_validate','静态检查草稿的清单、Schema、代码语法和 Skill。执行测试需审查后在授权环境进行。',
    {id:'string'},['id'],{creator:true,async:true,execute:(c,a)=>c.plugins?.validateDraft(a.id,c.thread.projectId)}),
  define('web_archive','把本轮实际读取的网页正文和来源归档至当前项目或个人资料',{id:'string'},['id'],{
    group:'homeContent',allowed:c=>c.plugins?.tools.has('web__read')===true,confirm:true,execute:(c,a)=>{
      const source=c.webSources?.get(a.id)
      if(!source?.body)fail('只可归档本轮实际读取的网页',403)
      return home(c,'POST','/submissions',{projectId:c.thread.projectId??undefined,
        source:{title:source.title,text:source.body,url:source.url,platform:'公开网页'},
        records:[{type:'note',body:source.title,author:'网页资料',confirmation:'unconfirmed',
          extra:{url:source.url,retrievedAt:source.retrievedAt,sourceType:'web'}}]}, {},true)
    }}),
]
function desktop(c:Core){
  if(!c.desktop)fail('此工作台没有桌面宿主',409)
  return c.desktop
}
function botAllowed(c:Core,id:string){
  if(!c.allowedInstances.some(i=>i.id===id))fail('实例不在当前授权范围',403)
}
function workThread(c:Core,id:string){
  const thread=getThread(c.db,id)
  if(thread.instanceId==='main'||thread.projectId!==c.thread.projectId)fail('工作话题不在当前范围',403)
  botAllowed(c,thread.instanceId)
  return thread
}
function file(c:Core,a:any,operation:'list'|'read'|'write'|'open'|'archive'){
  const p=chatPolicy(c.dir),root=(operation==='write'?p.writeRoots:p.readRoots)[a.root]
  if(!root)fail('没有授权该资料目录',403)
  try{return localFiles(allowedRoot(root,c.dir),a.path??'',operation,a.body)}
  catch(e){if((e as {status?:number}).status)throw e;fail('本机文件不可用、不可读取或同名文件已存在',409)}
}
function enabled(c:Core,t:Tool,policy:Policy){
  return (!t.group||policy[t.group])&&(!t.project||c.thread.projectId)&&(!t.creator||policy.pluginCreator&&c.actor==='user')&&
    (!c.model||!c.thread.projectId||c.model.shareProject||t.public)&&
    (!t.file||(!c.model||c.model.shareAttachments)&&(t.file==='read'?policy.readRoots.length:policy.writeRoots.length)>0)&&
    (!c.model||c.thread.projectId||c.model.sharePersonal||Boolean(t.file)||t.public)&&t.allowed?.(c)!==false
}
const builtin=new Map(tools.map(tool=>[tool.name,toolEntry({...tool,allowed:(c:Core)=>enabled(c,tool,chatPolicy(c.dir))})]))
const available=(c:Core,entry:RegisteredTool<Core>)=>entry.allowed?.(c)!==false
export function toolsFor(c:Core){
  return [...builtin.values(),...(c.plugins?.tools.values()??[])].filter(t=>available(c,t))
    .map(({name,description,parameters})=>({name,description,parameters}))
}
export function toolCall(c:Core,name:string,raw:string){
  const entry=builtin.get(name)??c.plugins?.tools.get(name)
  if(!entry||!available(c,entry))fail('当前未授权该工具或资料范围',403)
  const args=parseTool(entry,raw)
  const confirm=typeof entry.confirm==='function'?entry.confirm(args):entry.confirm===true
  if(confirm&&c.actor!=='user')fail('这项操作须由真实用户发起并确认',403)
  return {confirm,async:entry.async===true,execute:()=>entry.execute(c,args)}
}
