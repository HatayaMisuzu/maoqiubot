import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initHome, homeApi, addTaskRecord } from '../server/home/index.ts';
import { startServer } from '../server/index.ts';
import { once } from 'node:events';

function setup(t) {
  const db=new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  initHome(db);
  const dataDir=mkdtempSync(join(tmpdir(),'xiaomaoqiu-home-'));
  t.after(()=>{db.close(); rmSync(dataDir,{recursive:true});});
  const owner={id:'user',owner:true,projects:[]};
  function api(method,url,body={},principal=owner) {
    const {pathname:path,searchParams:query}=new URL(url,'http://test.local');
    db.exec('BEGIN');
    try {
      const result=homeApi(db,{method,path,query,body,principal,dataDir});
      assert.notEqual(result,undefined);
      db.exec('COMMIT');
      return result;
    } catch (e) {db.exec('ROLLBACK'); throw e;}
  }
  return {db,api,project:api('POST','/projects',{name:'毕设'})};
}
test('项目交接引用同一份授权原件，个人资料在受邀端不可见',t=>{
  const {db,api,project:p}=setup(t);
  const agent={id:'B',owner:false,projects:[p.id]},outsider={id:'C',owner:false,projects:[]};
  const attachment=api('POST','/attachments',{projectId:p.id,name:'笔记.txt',data:Buffer.from('观测 #1').toString('base64')});
  const personal=api('POST','/submissions',{source:{title:'私人便笺',text:'观测'}});
  const {source,records:[requirement]}=api('POST','/submissions',{projectId:p.id,source:{title:'观察记录',platform:'笔记本',author:'导师',attachmentIds:[attachment.id]},records:[{type:'requirement',body:'按波段分组',confirmation:'user'}]});
  api('POST','/projects/'+p.id+'/records',{type:'handoff',body:'r3 已验收',refs:[requirement.id],extra:{remaining:['补录 R 波段']}},agent);
  addTaskRecord(db,p.id,'task-1','start','核对论文');
  addTaskRecord(db,p.id,'task-1','partial','已登记作者',{remaining:['核对年份']});
  const brief=api('GET','/projects/'+p.id+'/brief',{},agent);
  assert.equal(brief.requirements[0].sourceId,source.id);
  assert.deepEqual(brief.handoffs[0].refs,[requirement.id]);
  assert.deepEqual(brief.openItems.sort(),['核对年份','补录 R 波段'].sort());
  assert.equal(brief.latestWork.filter(x=>x.taskId==='task-1').length,1);
  assert.deepEqual(api('GET','/sources/'+source.id,{},agent).attachmentIds,[attachment.id]);
  assert.equal(Buffer.from(api('GET','/attachments/'+attachment.id,{},agent).data,'base64').toString(),'观测 #1');
  for(const path of ['/attachments/'+attachment.id,'/sources/'+source.id,'/projects/'+p.id+'/brief','/spaces/'+p.spaceId]){
    assert.throws(()=>api('GET',path,{},outsider),{status:403});
  }
  assert.throws(()=>api('GET','/sources/'+personal.sourceId,{},agent),{status:403});
  assert.equal(api('GET','/search?q=私人',{},agent).items.length,0);
  api('PATCH','/sources/'+personal.sourceId,{projectIds:[p.id]});
  assert.equal(api('GET','/sources/'+personal.sourceId,{},agent).submitter,'user');
});
test('修订竞争返回当前版本，遗忘屏蔽来源重提取，保留选定原件',t=>{
  const {api,project:p}=setup(t);
  const {sourceId,records:[r]}=api('POST','/submissions',{projectId:p.id,source:{title:'原话',text:'周五提交'},records:[{body:'周五提交初稿',type:'requirement',factKey:'due'}]});
  const url='/records/'+r.id;
  const edited=api('PATCH',url,{expectedRevision:1,body:'周五提交终稿'});
  const duplicate=api('POST','/projects/'+p.id+'/records',{sourceId,type:'requirement',body:'周五交终稿',factKey:'due'});
  const derived=api('POST','/projects/'+p.id+'/records',{type:'conclusion',body:'交付时间已定',refs:[duplicate.id]});
  assert.throws(()=>api('PATCH',url,{expectedRevision:1,body:'过期写入'}),e=>e.status===409 && e.current.revision===2);
  assert.equal(api('GET',url+'?history=1').history.length,2);
  assert.equal(api('GET','/search?q=初稿').items.length,0);
  api('DELETE',url,{expectedRevision:edited.revision});
  assert.throws(()=>api('GET',url),{status:404});
  assert.throws(()=>api('GET','/records/'+derived.id),{status:404});
  assert.equal(api('GET','/projects/'+p.id+'/brief').requirements.length,0);
  for(const v of [{body:'周五提交初稿'},{body:'周五交最终稿',factKey:'due'}]) assert.throws(()=>api('POST','/projects/'+p.id+'/records',{sourceId,type:'requirement',...v}),{status:409});
  assert.equal(api('GET','/sources/'+sourceId).text,'周五提交');
  const other=api('POST','/projects',{name:'独立范围'});
  api('PATCH','/sources/'+sourceId,{projectIds:[p.id,other.id]});
  assert.equal(api('POST','/projects/'+other.id+'/records',{sourceId,type:'requirement',body:'周五提交终稿',factKey:'due'}).projectId,other.id);
});
test('空间预览、局部修订、跨端页面、布局恢复与附件来源动作',t=>{
  const {api,project:p}=setup(t),base='/spaces/'+p.spaceId;
  const s=api('GET',base),pid=p.pageId,c=s.structure.collections[0],bid=s.structure.pages[0].blocks.find(b=>b.type==='collection').id;
  const {sourceId}=api('POST','/submissions',{projectId:p.id,source:{title:'原图'}});
  const ops=[
    {op:'updatePage',pageId:pid,title:'导师看板',columns:2},
    {op:'addField',collectionId:c.id,field:{id:'band',type:'select',name:'波段',options:['R','B']}},
    {op:'updateBlock',pageId:pid,blockId:bid,block:{config:{collectionId:c.id,groupBy:'band'}}},
    {op:'addBlock',pageId:pid,block:{id:'figure',type:'source-card',config:{sourceId},actions:[{id:'view',type:'openSource'}]}}
  ];
  const change={expectedRevision:1,operations:ops};
  assert.equal(api('POST',base+'/changes',{...change,mode:'preview'}).structure.pages[0].title,'导师看板');
  assert.equal(api('GET',base).structure.pages[0].title,'首页');
  const updated=api('POST',base+'/changes',{...change,mode:'apply'});
  assert.throws(()=>api('POST',base+'/changes',{...change,mode:'apply'}),{status:409});
  const agent={id:'reader',owner:false,projects:[p.id]};
  assert.equal(api('GET',base+'/pages/'+updated.pageId,{},agent).page.title,'导师看板');
  assert.equal(api('POST',base+'/actions/view',{},agent).id,sourceId);
  const url='/collections/'+c.id+'/entries';
  const e=api('POST',url,{values:{title:'观测记录',band:'R'}},agent);
  assert.equal(api('GET',url+'?blockId='+bid).groups[0].value,'R');
  api('POST',base+'/changes',{expectedRevision:2,mode:'apply',operations:[{op:'toggleModule',type:'source-card',enabled:false}]});
  assert.throws(()=>api('POST',base+'/actions/view'),{status:409});
  assert.equal(api('GET','/sources/'+sourceId).title,'原图');
  const restored=api('POST',base+'/restore',{expectedRevision:3,targetRevision:1});
  assert.equal(restored.structure.pages[0].title,'首页');
  assert.equal(api('GET',url).items[0].values.band,'R');
  assert.equal(api('GET',url).items[0].id,e.id);
});
test('字段类型改变必须显式转换已有值，失败批次不会部分应用',t=>{
  const {api,project:p}=setup(t),base='/spaces/'+p.spaceId;
  const s=api('GET',base),c=s.structure.collections[0],url='/collections/'+c.id+'/entries';
  const e=api('POST',url,{values:{title:'2'}});
  const op={op:'updateField',collectionId:c.id,fieldId:'title',field:{type:'number'}};
  const apply=(operation)=>api('POST',base+'/changes',{mode:'apply',expectedRevision:1,operations:[{op:'updatePage',pageId:p.pageId,title:'修订'},operation]});
  assert.throws(()=>apply(op),{status:409});
  assert.equal(api('GET',base).structure.pages[0].title,'首页');
  apply({...op,migration:{[e.id]:2}});
  const current=api('GET',url).items[0];
  assert.equal(current.values.title,2);
  assert.equal(current.revision,2);
  assert.throws(()=>api('PATCH',url+'/'+e.id,{expectedRevision:1,values:{title:5}}),{status:409});
});

test('项目空间校验引用范围，撤回资料后保留布局和条目并隐藏引用',t=>{
  const {api,project:p}=setup(t),base='/spaces/'+p.spaceId;
  const reader={id:'reader',owner:false,projects:[p.id]};
  const other=api('POST','/projects',{name:'另一个项目'});
  const c=api('GET',base).structure.collections[0],url='/collections/'+c.id+'/entries';
  const data=Buffer.from('观察数据').toString('base64');
  const privateAttachment=api('POST','/attachments',{name:'私有.txt',data,endpointIds:[reader.id]});
  const attachment=api('POST','/attachments',{name:'项目.txt',data,projectId:p.id});
  const privateSource=api('POST','/submissions',{source:{title:'私人原话',endpointIds:[reader.id]}});
  const {sourceId,records:[record]}=api('POST','/submissions',{projectId:p.id,source:{title:'项目引用',attachmentIds:[attachment.id]},records:[{body:'保留结论'}]});
  const foreignRecord=api('POST','/projects/'+other.id+'/records',{body:'兄弟项目'});
  const changes=(expectedRevision,operations,principal)=>api('POST',base+'/changes',{mode:'apply',expectedRevision,operations},principal);
  const sourceCard=id=>({op:'addBlock',pageId:p.pageId,block:{id:'source-card',type:'source-card',config:{sourceId:id},actions:[{id:'view',type:'openSource'}]}});
  assert.equal(api('GET','/sources/'+privateSource.sourceId,{},reader).id,privateSource.sourceId);
  assert.throws(()=>changes(1,[sourceCard(privateSource.sourceId)]),{status:403});
  assert.throws(()=>changes(1,[sourceCard(privateSource.sourceId)],reader),{status:403});
  changes(1,[sourceCard(sourceId),
    {op:'addField',collectionId:c.id,field:{id:'attachment',type:'attachment',name:'附件'}},
    {op:'addField',collectionId:c.id,field:{id:'record',type:'record',name:'记录'}}]);
  assert.throws(()=>api('POST',url,{values:{attachment:privateAttachment.id}}),{status:403});
  assert.throws(()=>api('POST',url,{values:{attachment:privateAttachment.id}},reader),{status:403});
  assert.throws(()=>api('POST',url,{values:{record:foreignRecord.id}}),{status:403});
  const e=api('POST',url,{values:{title:'观测',attachment:[attachment.id],record:record.id}},reader);
  assert.equal(api('POST',base+'/actions/view',{},reader).attachmentIds[0],attachment.id);

  api('PATCH','/attachments/'+attachment.id,{endpointIds:[reader.id]});
  assert.deepEqual(api('POST',base+'/actions/view',{},reader).attachmentIds,[]);
  api('PATCH','/sources/'+sourceId,{projectIds:[]});
  assert.throws(()=>api('POST',base+'/actions/view',{},reader),{status:403});
  const readPage=()=>api('GET',base+'/pages/'+p.pageId,{},reader).page;
  const block=readPage().blocks.find(b=>b.id==='source-card');
  assert.equal(block.config.sourceId,undefined);
  assert.deepEqual(block.actions,[]);
  assert.equal(api('GET','/records/'+record.id,{},reader).sourceId,null);
  assert.equal(api('GET','/projects/'+p.id+'/brief',{},reader).records[0].body,'保留结论');
  assert.equal(api('GET','/search?sourceId='+sourceId,{},reader).items.length,0);

  api('DELETE','/records/'+record.id,{expectedRevision:1});
  const values=api('GET',url,{},reader).items[0].values;
  assert.deepEqual(values,{title:'观测',attachment:[]});
  assert.throws(()=>api('PATCH',url+'/'+e.id,{expectedRevision:0,values:{title:'旧版本'}},reader),e=>e.status===409 && JSON.stringify(e.current.values)===JSON.stringify(values));
  changes(2,[{op:'updatePage',pageId:p.pageId,title:'继续编辑'}],reader);
  api('POST',base+'/restore',{expectedRevision:3,targetRevision:1},reader);
  assert.deepEqual(api('GET',url,{},reader).items[0].values,values);
  api('POST',base+'/restore',{expectedRevision:4,targetRevision:2},reader);
  assert.equal(readPage().blocks.find(b=>b.id==='source-card').config.sourceId,undefined);
  api('PATCH','/attachments/'+attachment.id,{projectIds:[p.id]});
  api('PATCH','/sources/'+sourceId,{projectIds:[p.id]});
  assert.equal(readPage().blocks.find(b=>b.id==='source-card').config.sourceId,sourceId);
  assert.deepEqual(api('GET',url,{},reader).items[0].values.attachment,[attachment.id]);
});

test('项目接手简报展示验收证据和剩余条件',t=>{
  const {api,db,project:p}=setup(t);
  const endpoint={id:'接手端',owner:false,projects:[p.id]};
  addTaskRecord(db,p.id,'task-1','result','上次版本',{runId:'run-0',version:'r2',artifacts:[{id:'earlier'}]});
  addTaskRecord(db,p.id,'task-1','result','待核验',{runId:'run-1',version:'r3',artifacts:[{id:'figure'}],
    status:'awaiting_review',doneWhen:['包含原始数据','补录 B 波段']});
  const brief=()=>api('GET','/projects/'+p.id+'/brief',{},endpoint);
  assert.deepEqual(brief().pendingVerification[0].criteria,['包含原始数据','补录 B 波段']);
  addTaskRecord(db,p.id,'task-1','result','已审阅',{runId:'run-1',status:'partial',doneWhen:['包含原始数据','补录 B 波段'],
    verificationSource:'user',
    verified:[{criterion:'包含原始数据',met:true,evidence:'图 1'},'R 波段同步'],remaining:['补录 B 波段'],nextSteps:['取 B 波段原件']});
  const handoff=brief();
  assert.deepEqual(handoff.verified.map(r=>[r.body,r.evidence]),[['包含原始数据','图 1'],['R 波段同步',undefined]]);
  assert.deepEqual(handoff.pendingVerification[0].criteria,['补录 B 波段']);
  assert.deepEqual(handoff.openItems,['补录 B 波段']);
  assert.deepEqual(handoff.nextSteps.map(r=>r.body),['取 B 波段原件']);
  assert.equal(handoff.verified[0].id,handoff.latestWork[0].id);
  assert.equal(handoff.latestWork[0].extra.version,'r3');
  assert.deepEqual(handoff.latestWork[0].extra.artifacts,[{id:'figure'}]);
  addTaskRecord(db,p.id,'task-1','result','下一轮待核验',{runId:'run-2',status:'awaiting_review'});
  assert.equal(brief().latestWork[0].extra.artifacts,undefined);
});

test('公共 HTTP 链路：两端用邀请令牌接手，重试不重复写档，访问范围变更即时生效',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'xiaomaoqiu-home-http-'));
  const app=startServer({dataDir:dir,port:0,host:'127.0.0.1',chat:false});
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true});});
  await once(app.server,'listening');
  const base='http://127.0.0.1:'+app.server.address().port+'/api/v1';
  async function request(path,method='GET',data,token=app.auth.cfg.ownerToken,expected=200) {
    const res=await fetch(base+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});
    const json=await res.json();
    assert.equal(res.status,expected,json.error);
    return json;
  }
  const post=(path,body,token,code)=>request(path,'POST',body,token,code);
  const p=await post('/projects',{name:'毕业项目',requestId:'new-project'});
  const other=await post('/projects',{name:'其他项目'});
  const a=await post('/grants',{projectId:p.id}), b=await post('/grants',{projectId:p.id}), c=await post('/grants',{projectId:other.id});
  const data={projectId:p.id,requestId:'A-note',source:{title:'观测笔记',text:'波段 R',localRef:{nodeId:'A',workspaceRef:'observations',path:'r/band.fit'}},records:[{type:'requirement',body:'逐一核对波段'}]};
  const first=await post('/submissions',data,a.token);
  assert.deepEqual(await post('/submissions',data,a.token),first);
  await post('/submissions',{...data,source:{title:'冲突'}},a.token,409);
  const priorHandoff=await post('/projects/'+p.id+'/records',{type:'handoff',body:'r3 已核对 R 波段',refs:[first.records[0].id],extra:{version:'r3',remaining:['核对 B 波段']}},a.token);
  const brief=await request('/projects/'+p.id+'/brief','GET',null,b.token);
  assert.deepEqual(brief.openItems,['核对 B 波段']);
  assert.equal(brief.requirements.length,1);
  assert.equal((await request('/sources/'+first.sourceId,'GET',null,b.token)).localRef.path,'r/band.fit');
  for(const path of ['/sources/'+first.sourceId,'/records/'+first.records[0].id,'/spaces/'+p.spaceId]){
    await request(path,'GET',null,c.token,403);
  }
  const spacePath='/spaces/'+p.spaceId;
  const initial=await request(spacePath,'GET',null,b.token);
  const generated=await post(spacePath+'/changes',{expectedRevision:initial.revision,mode:'preview',operations:[{op:'createPage',page:{title:'临时页'}}]},a.token);
  assert.equal(generated.structure.pages.find(page=>page.id===generated.pageId).title,'临时页');
  const newPage={expectedRevision:initial.revision,operations:[{op:'createPage',page:{id:'handoffs',title:'交接页'}}]};
  const preview=await post(spacePath+'/changes',{...newPage,mode:'preview'},a.token);
  assert.equal(preview.pageId,'handoffs');
  await request(spacePath+'/pages/'+preview.pageId,'GET',null,b.token,404);
  const applied=await post(spacePath+'/changes',{...newPage,mode:'apply'},a.token);
  assert.equal((await request(spacePath+'/pages/'+applied.pageId,'GET',null,b.token)).page.title,'交接页');

  const home=initial.structure.pages[0], collectionBlock=home.blocks.find(block=>block.type==='collection');
  const moved=await post(spacePath+'/changes',{expectedRevision:applied.revision,mode:'apply',operations:[
    {op:'bindAction',pageId:home.id,blockId:collectionBlock.id,action:{id:'record-handoff',type:'writeHandoff'}},
    {op:'moveBlock',pageId:home.id,toPageId:applied.pageId,blockId:collectionBlock.id}
  ]},a.token);
  assert.equal(moved.pageId,'handoffs');
  const handoffSpace=await request(spacePath+'/pages/'+moved.pageId,'GET',null,b.token);
  assert.equal(handoffSpace.page.blocks[0].actions[0].id,'record-handoff');
  const handoffPath=spacePath+'/actions/record-handoff';
  const nextHandoff={body:'r4 已核对 B 波段',refs:[priorHandoff.id],sourceId:first.sourceId,confirmation:'user',extra:{version:'r4',remaining:['交付报告']},requestId:'B-handoff'};
  await post(handoffPath,nextHandoff,c.token,403);
  const record=await post(handoffPath,nextHandoff,b.token);
  assert.deepEqual(await post(handoffPath,nextHandoff,b.token),record);
  assert.equal(record.type,'handoff');
  assert.equal(record.sourceId,first.sourceId);
  assert.equal(record.confirmation,'user');
  assert.deepEqual(record.refs,[priorHandoff.id]);
  assert.equal(record.extra.version,'r4');
  const entryPath='/collections/'+collectionBlock.config.collectionId+'/entries';
  const entry=await post(entryPath,{values:{title:'B 端观测条目'}},b.token);
  await post(spacePath+'/restore',{expectedRevision:moved.revision,targetRevision:initial.revision},a.token);
  await request(spacePath+'/pages/'+moved.pageId,'GET',null,b.token,404);
  assert.equal((await request(entryPath,'GET',null,b.token)).items[0].id,entry.id);
  assert.deepEqual((await request('/projects/'+p.id+'/brief','GET',null,b.token)).openItems,['交付报告']);
  await request('/sources/'+first.sourceId,'PATCH',{projectIds:[other.id]},a.token,403);
  await request('/sources/'+first.sourceId,'PATCH',{projectIds:[p.id,other.id]});
  assert.deepEqual((await request('/sources/'+first.sourceId,'GET',null,c.token)).projectIds,[other.id]);
  assert.equal((await request('/search?q=逐一','GET',null,c.token)).items.length,0);
  await request('/sources/'+first.sourceId,'PATCH',{projectIds:[p.id]});
  await request('/sources/'+first.sourceId,'GET',null,c.token,403);
  assert.equal((await request('/search?q=观测','GET',null,c.token)).items.length,0);
  await post('/tasks',{},b.token,403);
});
