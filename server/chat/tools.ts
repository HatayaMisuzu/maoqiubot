import type { DatabaseSync } from 'node:sqlite'
import { fail, one, owner, required, unpack, changed } from '../db/index.ts'
import { getTask, taskView, taskCommunications, delegate, control, reconcileRun, sendInput, getThread } from '../tasks/index.ts'
import { homeApi } from '../home/index.ts'
import type { Principal } from '../home/common.ts'
import type { ChatToolDefinition } from './provider.ts'
import { readLocal, writeLocal } from './model-settings.ts'
import type { ModelConfig } from './model-settings.ts'
import { allowedRoot, localFiles } from './files.ts'

type Policy={task:boolean;memory:boolean;homeContent:boolean;homeSpace:boolean;personalInProject:boolean;readRoots:string[];writeRoots:string[]}
const policyFile='chat-policy.json'
export const chatPolicy=(dir:string)=>readLocal<Policy>(dir,policyFile,{
  task:true,memory:true,homeContent:false,homeSpace:false,personalInProject:false,readRoots:[],writeRoots:[]
})
export function saveChatPolicy(dir:string,b:any){
  const p=chatPolicy(dir)
  for(const key of ['task','memory','homeContent','homeSpace','personalInProject'] as const){
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
type Core={db:DatabaseSync;dir:string;thread:any;current:any;model?:ModelConfig;allowedInstances:any[];materials:any[];attachmentIds:string[]}
type Shape='string'|'integer'|'array'|'boolean'|'object'
type Tool=ChatToolDefinition&{
  group?:keyof Pick<Policy,'task'|'memory'|'homeContent'|'homeSpace'>;
  explicit?:RegExp;project?:boolean;file?:'read'|'write';
  execute:(c:Core,a:any)=>unknown;
}
const taskIntent=/委派|派活|派给|交给|转交|安排.{0,24}(?:执行|Codex|DSH|Agent|Bot)|让.{0,40}(?:Codex|DSH|Agent|Bot)|\b(?:delegate|assign|hand off)\b/i
const memoryIntent=/(?:^|[，。！？,:：\n])\s*(?:请|帮我|麻烦你|小毛球\s*|我希望你\s*)*(?:记住|记下|保存.{0,12}(?:记忆|偏好)|把.{1,60}记住|以后.{0,16}(?:叫|称呼|用)|(?:please\s+)?(?:remember|memorize)\b)/i
const editMemory=/记忆|偏好|memory|preference/i
const writeHome=/创建|新建|建立|记录|登记|保存|修改|更新|整理|写入|归档|交接|create|save|update|archive/i
const taskChange=/补充|告诉|转告|发送|回复|继续|停止|取消|撤回|send|tell|reply|resume|cancel|stop/i
function define(name:string,description:string,shape:Record<string,Shape>,required:string[],opts:Omit<Tool,keyof ChatToolDefinition>):Tool{
  const parameters={type:'object',properties:Object.fromEntries(Object.entries(shape).map(([k,type])=>[k,{type,
    ...(type==='array'?{items:{}}:{})}])),required,additionalProperties:false}
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
  define('task_list','列出当前项目或话题的工作任务',{},[],{execute:c=>c.db.prepare(`SELECT id,goal,instanceId,status,workThreadId FROM tasks
    WHERE projectId IS ? AND (? IS NOT NULL OR originThreadId=?) ORDER BY rowid DESC LIMIT 30`).all(c.thread.projectId,c.thread.projectId,c.thread.id)}),
  define('task_progress','读取某个任务的真实运行、动作回执、最近消息与验收',{taskId:'string'},['taskId'],{execute:(c,a)=>progress(c,a.taskId)}),
  define('task_communications','读取当前任务的澄清、回复、交接和交付消息',{taskId:'string'},['taskId'],
    {execute:(c,a)=>{scopedTask(c,a.taskId);return taskCommunications(c.db,a.taskId)}}),
  define('task_delegate','创建工作任务，交给选定的可用 Bot',{instanceId:'string',goal:'string',constraints:'array',doneWhen:'array',refs:'array'},['instanceId','goal'],
    {group:'task',explicit:taskIntent,execute:(c,a)=>{
      if(!c.allowedInstances.some(i=>i.id===a.instanceId))fail('实例不在当前授权范围',403)
      const refs=(a.refs??[]).map((v:any)=>({type:v?.type,id:v?.id}))
      return delegate(c.db,c.dir,{...a,originThreadId:c.thread.id,projectId:c.thread.projectId,attachmentIds:c.attachmentIds,
        refs:[...c.materials,...refs]},c.current.id)
    }}),
  define('task_control','补充、转达、停止或检查任务。原生权限确认由用户亲自作出',{taskId:'string',action:'string',text:'string',commandId:'string',replyTo:'string'},['taskId','action'],
    {group:'task',execute:(c,a)=>{
      const task=scopedTask(c,a.taskId),{run}=taskView(c.db,task.id)
      if(!run)fail('任务没有可操作的运行')
      if(a.action==='inspect')return reconcileRun(c.db,run.id,{action:'inspect'})
      if(!taskChange.test(c.current.text))fail('本轮需要用户明确要求补充、转达或停止',403)
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
    {group:'homeContent',explicit:/(?:创建|新建|建立).{0,30}项目|create.{0,30}project/i,execute:(c,a)=>{
      if(c.thread.projectId||!a.name.trim()||!c.current.text.includes(a.name.trim()))fail('请在个人主聊明确指定新项目名称',403)
      if(one(c.db,'SELECT id FROM projects WHERE name=? LIMIT 1',a.name.trim()))fail('同名项目已存在，请先检查',409)
      return home(c,'POST','/projects',{name:a.name.trim()},{},true)
    }}),
  define('home_record_save','在当前项目保存记录、待办或交接',{type:'string',body:'string',refs:'array',sourceId:'string',remaining:'array',version:'string'},['type','body'],
    {group:'homeContent',explicit:writeHome,project:true,execute:(c,a)=>{
      if(!['note','decision','requirement','handoff','todo'].includes(a.type))fail('该记录类型需所有者直接操作')
      return home(c,'POST','/projects/'+idPath(c.thread.projectId)+'/records',{type:a.type,body:a.body,refs:a.refs,sourceId:a.sourceId,
        author:'小毛球',extra:{...trail(c),remaining:a.remaining,version:a.version}})
    }}),
  define('home_record_update','修订当前项目的一条普通记录，保留原版本',{id:'string',expectedRevision:'integer',body:'string'},['id','expectedRevision','body'],
    {group:'homeContent',explicit:/修改|更新|改成|revise|update/i,project:true,execute:(c,a)=>{
      recordForScope(c,a.id)
      return home(c,'PATCH','/records/'+idPath(a.id),{expectedRevision:a.expectedRevision,body:a.body})
    }}),
  define('home_collection_entries','查看当前项目集合条目，或按本轮指令新增、更新条目',{id:'string',action:'string',entryId:'string',
    expectedRevision:'integer',values:'object'},['id','action'],{project:true,execute:(c,a)=>{
      const {id:projectId,spaceId}=home(c,'GET','/projects/'+idPath(c.thread.projectId))
      if(!one(c.db,'SELECT 1 FROM space_collections WHERE id=? AND space_id=?',a.id,spaceId)||projectId!==c.thread.projectId)
        fail('集合不在当前项目默认空间',403)
      const path='/collections/'+idPath(a.id)+'/entries'
      if(a.action==='list'){
        const result=home(c,'GET',path)
        return {...result,items:result.items.slice(0,25)}
      }
      if(!chatPolicy(c.dir).homeContent||!writeHome.test(c.current.text))fail('当前未授权修改集合内容',403)
      if(a.action==='create')return home(c,'POST',path,{values:a.values})
      if(a.action==='update')return home(c,'PATCH',path+'/'+idPath(a.entryId),{expectedRevision:a.expectedRevision,values:a.values})
      fail('集合操作无效')
    }}),
  define('home_space_change','预览或应用当前项目的页面、集合和布局操作',{mode:'string',expectedRevision:'integer',operations:'array'},['mode','expectedRevision','operations'],
    {group:'homeSpace',explicit:writeHome,project:true,execute:(c,a)=>{
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
    {group:'memory',explicit:memoryIntent,execute:(c,a)=>{
      if(!c.current.text.includes(a.body.trim()))fail('确认的记忆须引用当前真实用户原话',403)
      const type=a.type??'preference'
      if(!['preference','note','decision','requirement'].includes(type))fail('无效记忆分类')
      if(a.factKey&&a.factKey.length>120)fail('事实键过长')
      return home(c,'POST','/records',{projectId:c.thread.projectId,type,body:a.body,factKey:a.factKey,validUntil:a.validUntil,
        confirmation:'user',extra:{memory:true,important:a.important===true,...trail(c)},author:'用户'}, {},true)
    }}),
  define('memory_update','以本轮用户明确指定的原文更新记忆，保留原修订',{id:'string',expectedRevision:'integer',body:'string'},['id','expectedRevision','body'],
    {group:'memory',explicit:/改|更新|纠正|change|update/i,execute:(c,a)=>{
      if(!editMemory.test(c.current.text)||!c.current.text.includes(a.body.trim()))fail('须明确说明要更新的记忆和新的原文',403)
      const saved=recordForScope(c,a.id)
      if(!['preference','note','decision','requirement'].includes(saved.type))fail('所选记录不属于记忆分类',403)
      return home(c,'PATCH','/records/'+idPath(a.id),{...a,confirmation:'user',extra:{...saved.extra,...trail(c)}},{},true)
    }}),
  define('memory_forget','遗忘用户明确指定的本范围记忆，保留原件',{id:'string',expectedRevision:'integer'},['id','expectedRevision'],
    {group:'memory',explicit:/忘掉|遗忘|别再记|忘记|forget/i,execute:(c,a)=>{
      const saved=recordForScope(c,a.id)
      const named=c.current.text.includes(a.id)||saved.factKey&&c.current.text.includes(saved.factKey)||c.current.text.includes(saved.body)
      if(!named||!['preference','note','decision','requirement'].includes(saved.type))fail('须明确指定记忆内容、事实键或记录 ID',403)
      return home(c,'DELETE','/records/'+idPath(a.id),{expectedRevision:a.expectedRevision},{},true)
    }}),
  define('local_files_list','列出授权资料目录内的文本文件和子目录',{root:'integer',path:'string'},['root'],
    {file:'read',execute:(c,a)=>file(c,a,'list')}),
  define('local_files_read','读取授权目录内的小型文本资料',{root:'integer',path:'string'},['root','path'],
    {file:'read',explicit:/读|查看|查找|查询|read|open|inspect/i,execute:(c,a)=>file(c,a,'read')}),
  define('local_files_write','在写入许可的目录新建资料文本，不覆盖',{root:'integer',path:'string',body:'string'},['root','path','body'],
    {file:'write',explicit:/文件|文档|file/i,execute:(c,a)=>{
      if(!writeHome.test(c.current.text)||!c.current.text.includes(a.path))fail('用户须在本轮明确指定新建文件和目标路径',403)
      return file(c,a,'write')
    }}),
  define('utility_clock','查询工作台当前时间（含 UTC 和上海时区）',{},[],{execute:()=>({
    utc:new Date().toISOString(),shanghai:new Intl.DateTimeFormat('zh-CN',{dateStyle:'short',timeStyle:'medium',timeZone:'Asia/Shanghai'}).format(new Date())
  })}),
]
function file(c:Core,a:any,operation:'list'|'read'|'write'){
  const p=chatPolicy(c.dir),root=(operation==='write'?p.writeRoots:p.readRoots)[a.root]
  if(!root)fail('没有授权该资料目录',403)
  try{return localFiles(allowedRoot(root,c.dir),a.path??'',operation,a.body)}
  catch(e){if((e as {status?:number}).status)throw e;fail('本机文件不可用、不可读取或同名文件已存在',409)}
}
function enabled(c:Core,t:Tool,policy:Policy){
  return (!t.group||policy[t.group])&&(!t.project||c.thread.projectId)&&
    (!c.model||!c.thread.projectId||c.model.shareProject||t.name==='utility_clock')&&
    (!t.file||(!c.model||c.model.shareAttachments)&&(t.file==='read'?policy.readRoots.length:policy.writeRoots.length)>0)&&
    (!c.model||c.thread.projectId||c.model.sharePersonal||Boolean(t.file)||t.name==='utility_clock')
}
export function toolsFor(c:Core){
  const p=chatPolicy(c.dir)
  return tools.filter(t=>enabled(c,t,p)).map(({name,description,parameters})=>({name,description,parameters}))
}
export function runTool(c:Core,name:string,raw:string){
  const t=tools.find(t=>t.name===name),policy=chatPolicy(c.dir)
  if(!t||!enabled(c,t,policy))fail('当前未授权该工具或资料范围',403)
  if(t.explicit&&!t.explicit.test(c.current.text))fail('当前真实用户消息没有明确要求这项操作',403)
  if(raw.length>16000)fail('工具参数过大')
  let args:any
  try{args=JSON.parse(raw)}catch{fail('工具参数不是有效 JSON')}
  if(!args||typeof args!=='object'||Array.isArray(args))fail('工具参数必须是对象')
  const schema=t.parameters as {required:string[];properties:Record<string,{type:Shape}>}
  for(const key of schema.required)if(!(key in args))fail('工具参数缺少 '+key)
  for(const [key,value] of Object.entries(args)){
    const type=schema.properties[key]?.type
    const valid=type==='array'?Array.isArray(value)&&value.length<=30:type==='integer'?Number.isSafeInteger(value):
      type==='object'?value!==null&&typeof value==='object'&&!Array.isArray(value):type===typeof value
    if(!valid||!Object.hasOwn(schema.properties,key))fail('无效工具参数 '+key)
  }
  return t.execute(c,args)
}
