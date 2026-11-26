import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'
import desktopSettings from '../desktop/connector-settings.cjs'
import { startServer } from '../server/index.ts'

test('Git worktree starts at HEAD, preserves a dirty workspace, and inherits Bot scope on registration', async t => {
  const dir=mkdtempSync(join(tmpdir(),'maoqiu-worktree-'))
  const workspace=join(dir,'repo'),target=join(dir,'isolated'),plain=join(dir,'plain')
  for(const path of [workspace,target,plain])mkdirSync(path)
  const git=(...args)=>execFileSync('git',args,{cwd:workspace,windowsHide:true,encoding:'utf8'}).trim()
  git('init','-q')
  const file=join(workspace,'work.txt')
  writeFileSync(file,'committed\n')
  git('add','work.txt')
  git('-c','user.name=Maoqiu Test','-c','user.email=test@example.invalid','commit','-qm','initial')
  const initialBranch=git('branch','--show-current'),base=git('rev-parse','HEAD')
  writeFileSync(file,'user changes\n')
  const settings={file:join(dir,'connector.json'),workspace,editable:true}
  const source={id:'source',name:'Original',adapterKey:'codex',command:'codex',profileId:'personal',args:['app-server'],workspaceRef:workspace}
  writeFileSync(settings.file,JSON.stringify({stateDir:join(dir,'node'),instances:[source,{...source,id:'plain',workspaceRef:plain}]}))
  const app=startServer({port:0,dataDir:join(dir,'server'),chat:false,desktop:{worktreeSource:i=>desktopSettings.worktreeSource(settings,i)}})
  let ws
  t.after(async()=>{ws?.terminate();await app.close();rmSync(dir,{recursive:true,force:true,maxRetries:4,retryDelay:100})})
  await once(app.server,'listening')
  const db=app.db
  await assert.rejects(desktopSettings.createWorktree(settings,db,'plain','ordinary',target),/Git 操作失败/)
  await assert.rejects(desktopSettings.createWorktree(settings,db,'source','inside',workspace),/原工作区以外/)
  const created=await desktopSettings.createWorktree(settings,db,'source','worker',target)
  assert.equal(created.baseCommit,base)
  assert.equal(created.dirty,true)
  assert.equal(readFileSync(join(created.workspaceRef,'work.txt'),'utf8').trim(),'committed')
  assert.equal(readFileSync(file,'utf8'),'user changes\n')
  assert.equal(git('branch','--show-current'),initialBranch)
  await assert.rejects(desktopSettings.createWorktree(settings,db,'source','worker',target),/实例 ID 已存在/)
  git('branch','maoqiu/collision')
  await assert.rejects(desktopSettings.createWorktree(settings,db,'source','collision',target),/Git 操作失败/)
  assert.deepEqual(JSON.parse(readFileSync(settings.file,'utf8')).instances.map(i=>i.id),['source','plain','worker'])

  const port=app.server.address().port
  db.prepare('INSERT INTO instances(id,nodeId,adapterKey,name,workspaceRef,availableActions,lastSeen,profileId) VALUES(?,?,?,?,?,?,?,?)')
    .run('source','local','codex','Original',workspace,'[]',new Date().toISOString(),'personal')
  db.prepare('INSERT INTO bot_settings(instanceId,enabled,allowDirect,allowDelegate,allowedProjects,updatedAt) VALUES(?,?,?,?,?,?)')
    .run('source',0,0,1,'[]',new Date().toISOString())
  ws=new WebSocket(`ws://127.0.0.1:${port}/api/v1/node`,{headers:{Authorization:'Bearer '+app.auth.cfg.nodes.local}})
  await once(ws,'open')
  ws.send(JSON.stringify({type:'hello',instances:[{...source,id:'worker',workspaceRef:created.workspaceRef,availableActions:[]}]}))
  for(let i=0;i<40&&!db.prepare('SELECT 1 FROM bot_settings WHERE instanceId=?').get('worker');i++)
    await new Promise(resolve=>setTimeout(resolve,25))
  const inherited=db.prepare('SELECT enabled,allowDirect,allowDelegate,allowedProjects FROM bot_settings WHERE instanceId=?').get('worker')
  assert.deepEqual({...inherited},{enabled:0,allowDirect:0,allowDelegate:1,allowedProjects:'[]'})
})
