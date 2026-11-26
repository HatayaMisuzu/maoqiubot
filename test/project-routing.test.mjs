import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync,mkdirSync,rmSync,readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase,transaction } from '../server/db/index.ts'
import { mainThread } from '../server/sessions.ts'
import { saveChatPolicy,toolCall } from '../server/chat/tools.ts'
import { message } from '../server/tasks/index.ts'
import { saveBotSettings } from '../server/tasks/bots.ts'

test('从永久主聊发现已有仓库、映射项目并委派，保持资料和执行权限',t=>{
  const temp=mkdtempSync(join(tmpdir(),'maoqiu-routing-')),dir=join(temp,'db'),root=join(temp,'repos'),work=join(root,'芳草')
  mkdirSync(work,{recursive:true})
  const db=openDatabase(dir)
  t.after(()=>{db.close();rmSync(temp,{recursive:true,force:true})})
  const thread=mainThread(db)
  const current={id:message(db,thread.id,'user','message','继续芳草项目'),text:'继续芳草项目'}
  db.prepare("INSERT INTO instances(id,name,nodeId,adapterKey,workspaceRef,availableActions,online) VALUES('worker','默认名称','local','codex',?,'[\"run\"]',1)").run(work)
  saveBotSettings(db,'worker',{name:'审查员',description:'检查工程测试'})
  saveChatPolicy(dir,{task:true,homeContent:true,readRoots:[root],writeRoots:[root],routineRouting:true})
  const ctx={db,dir,thread,current,actor:'user',allowedInstances:[],materials:[],attachmentIds:[],signal:new AbortController().signal}
  const call=(name,args,core=ctx)=>toolCall(core,name,JSON.stringify(args))
  const exec=(name,args,core=ctx)=>transaction(db,()=>call(name,args,core).execute())
  const args={name:'芳草开发',directory:'芳草',root:0}
  const project=exec('home_project_directory',args)
  assert.equal(project.directoryCreated,false)
  assert.equal(exec('home_project_directory',args).projectId,project.projectId)
  assert.deepEqual(project.registeredInstances,['worker'])
  assert.throws(()=>exec('home_project_directory',{...args,name:'其他',directory:'../逃逸'}),/目录名/)
  assert.throws(()=>exec('home_project_directory',{...args,name:'其他',directory:'其他',createDirectory:true}),/未授权/)
  exec('home_workspace_register',{projectId:project.projectId,instanceId:'worker',workspaceRef:work})
  assert.equal(db.prepare('SELECT allowAgentAccess FROM project_workspaces').get().allowAgentAccess,0)
  assert.equal(exec('home_project_find',{query:'芳草'})[0].id,project.projectId)
  const bots=exec('bot_list',{projectId:project.projectId})
  assert.equal(bots[0].name,'审查员')
  assert.equal(bots[0].description,'检查工程测试')
  const dispatch={instanceId:'worker',projectId:project.projectId,goal:'核对测试',routeReason:'已登记工作区与项目一致'}
  assert.equal(call('task_delegate',dispatch).confirm,false)
  const routing=exec('task_delegate',dispatch)
  assert.deepEqual({...db.prepare('SELECT originThreadId,projectId FROM tasks WHERE id=?').get(routing.taskId)},
    {originThreadId:thread.id,projectId:project.projectId})
  assert.deepEqual(readdirSync(root),['芳草'])
  assert.throws(()=>call('task_delegate',dispatch,{...ctx,model:{sharePersonal:true,shareProject:false,shareAttachments:true}}),/未获准/)
  saveChatPolicy(dir,{projectDirectories:true})
  const created=exec('home_project_directory',{name:'全新项目',directory:'独立软件',root:0,createDirectory:true})
  assert.equal(created.directoryCreated,true)
  assert.deepEqual(created.registeredInstances,[])
})
