import {$,api,at,el,btn,items,url,state,upload,download,form} from './lib.js';
const labels={requirement:'项目要求',decision:'决定',handoff:'交接',comment:'留言',todo:'待办',start:'开始工作',result:'工作结果',progress:'进度',preference:'偏好',note:'笔记',verified:'已验证',next:'下一步'};
const options=keys=>keys.map(id=>({id,name:labels[id]||id}));
const empty=txt=>el('p','empty',txt);
function display(title,...contents){
  const dialog=$('dialog');if(dialog.open)dialog.close();dialog.replaceChildren(el('h2','',title),...contents,el('div','dialog-foot',btn('关闭',()=>dialog.close(),'secondary')));dialog.showModal();
}
function showSource(source){
  const links=el('div','actions');if(source.url){try{const target=new URL(source.url);if(['https:','http:'].includes(target.protocol)){const a=el('a','','打开原始链接');a.href=target.href;a.target='_blank';a.rel='noopener noreferrer';links.append(a)}}catch{}}
  for(const id of source.attachmentIds||[])links.append(btn('下载附件',()=>download(id),'secondary','file'));
  display(source.title||'原件',el('small','',[source.author,source.platform,at(source.createdAt)].filter(Boolean).join(' · ')),el('p','text',source.text||''),links);
}
const sourceById=async id=>showSource(await api('/sources/'+url(id)));
const recordRow=(rec,onContinue,onStartWork)=>el('div','record',
  el('small','',[labels[rec.type]||rec.type,rec.author,at(rec.createdAt)].filter(Boolean).join(' · ')),
  el('p','text',rec.body),rec.extra?.version?el('small','','版本 '+rec.extra.version):null,
  rec.evidence?el('p','text',rec.evidence):null,
  rec.sourceId?btn('查看出处',()=>sourceById(rec.sourceId),'ghost'):null,
  onContinue||onStartWork?el('div','actions',
    onContinue?btn('接续此交接',onContinue,'ghost'):null,
    onStartWork?btn('带入工作话题',onStartWork,'secondary','chat'):null):null);
export const home = actions=>{
  function createProject(){form('建立项目',[{key:'name',label:'项目名称',required:true},{key:'binding',label:'工作区或资料目录（可选）'}],'创建',async d=>{const p=await api('/projects',{name:d.name,binding:d.binding||undefined});await actions.load();await actions.openHome(p.id)})}
  async function bindWorkspace(projectId) {
    const current=items(await api('/projects/'+url(projectId)+'/workspaces'));
    const options=state.instances.filter(i=>i.id!=='main').map(i=>({id:i.id,name:[i.name,i.profileId,i.workspaceRef,current.some(r=>r.instanceId===i.id)?'已绑定':''].filter(Boolean).join(' · ')}));
    if(!options.length){notice('暂无可新增的工作 Bot 工作区。');return}
    form('绑定执行工作区',[{key:'instanceId',label:'执行实例与工作区',options,required:true},{key:'access',label:'项目资料授权',options:[{id:'explicit',name:'仅提供本轮显式发送的内容'},{id:'project',name:'允许此 Agent 在运行中读写本项目资料，模型可能接收内容'}]}],'保存',async({instanceId,access})=>{
      const instance=state.instances.find(i=>i.id===instanceId);
      await api('/projects/'+url(projectId)+'/workspaces',{instanceId,workspaceRef:instance.workspaceRef,allowAgentAccess:access==='project'});
      await actions.refresh();
    });
  }
  function newRecord(projectId,path,previous){
    const {controls}=form(previous?'接续交接':'写项目记录',[
      {key:'type',label:'记录类型',options:path||previous?options(['handoff']):options(['handoff','requirement','comment','decision','todo','verified','next']),value:'handoff'},
      {key:'body',label:'内容',type:'textarea',required:true},
      {key:'version',label:'成果版本（可选）',value:previous?.extra?.version},
      {key:'remaining',label:'未完成事项（每行一项）',type:'textarea',value:Array.isArray(previous?.extra?.remaining)?previous.extra.remaining.join('\n'):''}
    ],'保存',async({type,body,version,remaining})=>{
      const extra=type==='handoff'?{...(version?{version}:{}),remaining:remaining.split('\n').map(item=>item.trim()).filter(Boolean)}:{};
      await api(path||'/projects/'+url(projectId)+'/records',{type,body,extra,confirmation:'user',...(previous?{refs:[previous.id]}:{})});
      await actions.refresh();
    });
    const showHandoffFields=()=>{for(const key of ['version','remaining'])controls[key].parentElement.hidden=controls.type.value!=='handoff'};
    controls.type.addEventListener('change',showHandoffFields);showHandoffFields();
  }
  async function startHandoff(projectId,handoff){
    const query=new URLSearchParams({projectId});
    const [workspaces,results]=await Promise.all([api('/projects/'+url(projectId)+'/workspaces'),api('/search?'+query)]);
    if(state.view!=='home'||state.project!==projectId)return;
    const contacts=items(workspaces).map(w=>{
      const online=state.instances.find(i=>i.id===w.instanceId)?.online;
      return {id:w.instanceId,name:[w.name,w.profileId,w.workspaceRef,online?'':'离线'].filter(Boolean).join(' · ')};
    });
    if(!contacts.length){notice('请先为这个项目绑定执行工作区。');return}
    const sources=items(results).filter(result=>result.kind==='source');
    const excerpt=handoff.body.replace(/\s+/g,' ').slice(0,48);
    const attachments=el('fieldset','handoff-files'),attachmentStatus=el('small','muted');
    attachments.hidden=true;attachmentStatus.hidden=true;attachmentStatus.setAttribute('role','status');
    let submission;
    const ui=form('带入工作话题',[
      {key:'instanceId',label:'接手的执行实例与工作区',options:contacts,required:true},
      {key:'sourceId',label:'项目原件（可选）',options:[{id:'',name:'请选择'},...sources.map(s=>({id:s.id,name:(s.id===handoff.sourceId?'交接出处 · ':'')+s.summary.slice(0,80)}))]}
    ],'创建工作话题',async({instanceId,sourceId})=>{
      const refs=[{type:'record',id:handoff.id,excerpt:'交接 · '+excerpt}];
      if(sourceId){
        const source=sources.find(s=>s.id===sourceId);
        refs.push({type:'source',id:sourceId,excerpt:'原件 · '+source.summary.slice(0,48)});
        for(const checked of attachments.querySelectorAll('input:checked'))refs.push({type:'attachment',id:checked.value,excerpt:'附件 · '+checked.dataset.name});
      }
      if(submission?.instanceId!==instanceId)submission={instanceId,requestId:crypto.randomUUID()};
      const thread=await api('/threads',{instanceId,projectId,title:'接续 · '+excerpt,requestId:submission.requestId});
      await actions.openWorkDraft(thread.id,refs);
    });
    const sourceInput=ui.controls.sourceId;
    ui.form.children[0].after(el('p','text','交接 · '+excerpt));
    sourceInput.parentElement.after(attachments,attachmentStatus);
    sourceInput.addEventListener('change',async()=>{
      const sourceId=sourceInput.value;
      attachments.replaceChildren();attachments.hidden=true;
      attachmentStatus.hidden=!sourceId;attachmentStatus.textContent=sourceId?'正在读取原件附件…':'';
      if(!sourceId)return;
      try {
        const source=await api('/sources/'+url(sourceId)+'?'+query);
        const files=await Promise.all((source.attachmentIds||[]).map(id=>api('/attachments/'+url(id)+'?meta=1')));
        if(sourceInput.value!==sourceId)return;
        attachments.replaceChildren(el('legend','','选取附件'),...files.map(file=>{
          const input=el('input');input.type='checkbox';input.value=file.id;input.dataset.name=file.name;
          return el('label','',input,file.name);
        }));
        attachments.hidden=!files.length;attachmentStatus.hidden=true;
      }catch(e){
        if(sourceInput.value===sourceId)attachmentStatus.textContent=e.message;
      }
    });
  }
  function addSource(projectId){
    form('保存资料',[{key:'title',label:'标题',required:true},{key:'text',label:'正文或署名摘要',type:'textarea'},{key:'author',label:'原作者'},{key:'platform',label:'来源平台'},{key:'url',label:'来源链接',type:'url'},{key:'file',label:'原件附件',type:'file'}],'归档',async d=>{
      const attachmentIds=d.file?[(await upload(d.file,projectId)).id]:[];
      await api('/submissions',{projectId:projectId||undefined,source:{title:d.title,text:d.text,author:d.author||undefined,platform:d.platform||undefined,url:d.url||undefined,attachmentIds}});await actions.refresh();
    });
  }
  function search(projectId){
    form('检索资料',[{key:'q',label:'关键词',required:false}],'查找',async d=>{
      const q=new URLSearchParams({q:d.q});if(projectId)q.set('projectId',projectId);
      const found=items(await api('/search?'+q));display('检索结果',...(found.length?found.map(r=>el('div','record',el('p','text',r.summary),r.sourceId?btn('查看原件',()=>sourceById(r.sourceId),'ghost'):null)): [empty('没有匹配资料。')]));
    });
  }
  function entryForm(c,path){
    const fields=c.fields.map(f=>({key:f.id,label:f.name+(f.type==='record'?'（记录 ID）':''),type:({number:'number',date:'date',attachment:'file'}[f.type]||'text'),options:f.type==='select'&&f.options?[{id:'',name:'请选择'},...f.options.map(id=>({id,name:id}))]:undefined}));
    form('添加'+c.name,fields,'保存',async raw=>{const values={};for(const field of c.fields){const val=raw[field.id];if(!val)continue;
      values[field.id]=field.type==='number'?Number(val):field.type==='attachment'?(await upload(val,state.project==='personal'?null:state.project)).id:val}
      if(!Object.keys(values).length)throw new Error('请至少填写一项内容。');
      await api(path,{values});await actions.refresh();
    });
  }
  function entriesTable(c,entries,view){
    const cell=(f,e)=>{const value=e.values[f.id];if(f.type==='attachment'&&value)return el('div','actions',...(Array.isArray(value)?value:[value]).map(id=>btn('下载附件',()=>download(id),'ghost')));
      if(f.type==='record'&&value)return btn('打开记录',async()=>display('记录',recordRow(await api('/records/'+url(value)))),'ghost');
      return value==null?'—':String(value)};
    if(!entries.length)return empty('还没有条目。');
    if(view==='list')return el('div','',...entries.map(e=>el('article','record',...c.fields.map(f=>el('p','',el('small','',f.name+'　'),cell(f,e))))));
    return el('div','table-scroll',el('table','',el('thead','',el('tr','',...c.fields.map(f=>el('th','',f.name)))),el('tbody','',...entries.map(e=>el('tr','',...c.fields.map(f=>el('td','',cell(f,e))))))));
  }
  async function section(block,space,brief,timeline){
    const config=block.config||{},section=el('section','',el('h3','',block.title||({brief:'当前要求',timeline:'最近进度',collection:'资料',text:'正文','source-card':'资料出处',reference:'来源引用'}[block.type]||block.type)));
    const disabled=space.structure.disabledModules?.includes(block.type);
    if(block.type==='brief'){
      const rs=[...(brief?.requirements||[]),...(brief?.decisions||[]),...(brief?.openItems||[]).map(body=>({type:'todo',body})),...(brief?.pendingVerification||[]).map(r=>({type:'待核验',body:r.criteria.join('、')}))];
      section.append(...(rs.length?rs.map(r=>recordRow(r)):[empty('尚未记录要求。')]));
      if(brief?.verified?.length)section.append(el('h4','','已验证'),...brief.verified.map(r=>recordRow(r)));
      if(brief?.nextSteps?.length)section.append(el('h4','','下一步'),...brief.nextSteps.map(r=>recordRow(r)));
    }
    if(block.type==='timeline')section.append(...(timeline.length?timeline.map(r=>r.type==='handoff'
      ?recordRow(r,()=>newRecord(space.projectId,null,r),()=>startHandoff(space.projectId,r))
      :recordRow(r)):[empty('项目进度与交接会显示在这里。')]));
    if(block.type==='text')section.append(el('p','text',config.text||''));
    if(config.sourceId){if(block.type==='source-card'&&!disabled){const s=await api('/sources/'+url(config.sourceId));section.append(el('strong','',s.title),el('p','text',s.text?.slice(0,200)||''))}
      section.append(btn('查看出处',()=>sourceById(config.sourceId),'ghost','file'))}
    if(block.type==='collection'){
      const c=space.structure.collections.find(c=>c.id===config.collectionId);if(!c)return section;
      const route='/collections/'+url(c.id)+'/entries',data=await api(route+'?blockId='+url(block.id));
      section.append(btn('添加条目',()=>entryForm(c,route),'secondary','plus'));
      if(data.groups?.length)for(const g of data.groups)section.append(el('h4','',g.value||'未分组'),entriesTable(c,g.items,config.view));
      else section.append(entriesTable(c,items(data),config.view));
    }
    if(!disabled)for(const a of block.actions||[]){const route='/spaces/'+url(space.id)+'/actions/'+url(a.id),params=a.params||{};
      section.append(btn(a.label,async()=>{
        if(a.type==='openSource')showSource(await api(route,{}));
        if(a.type==='writeHandoff')newRecord(space.projectId,route);
        if(a.type==='addEntry'){const c=space.structure.collections.find(x=>x.id===(params.collectionId||config.collectionId));if(c)entryForm(c,route)}
      },'ghost'))}
    return section;
  }
  function editPage(space,page){
    form('编辑页面',[{key:'title',label:'页面标题',value:page.title,required:true},{key:'columns',label:'分栏',options:[1,2,3,4].map(n=>({id:String(n),name:n+' 栏'})),value:page.columns},{key:'note',label:'追加文本块（可选）',type:'textarea'}],'保存',async d=>{
      const operations=[{op:'updatePage',pageId:page.id,title:d.title,columns:Number(d.columns)}];
      if(d.note)operations.push({op:'addBlock',pageId:page.id,block:{type:'text',config:{text:d.note}}});
      await api('/spaces/'+url(space.id)+'/changes',{mode:'apply',expectedRevision:space.revision,operations});await actions.refresh();
    });
  }
  async function draw(serial){
    const pid=state.project,personal=pid==='personal',project=personal?{spaceId:'personal',name:'个人空间'}:state.projects.find(p=>p.id===pid);
    $('compose').replaceChildren();$('compose').dataset.key='';
    if(!pid){$('heading').textContent='毛球之家';$('subhead').textContent='';$('tools').replaceChildren(btn('建立项目',createProject,'secondary','plus'));
      const rows=state.projects.map(p=>btn(p.name,()=>actions.openHome(p.id),'project-link','layers'));
      $('content').replaceChildren(el('div','page',el('h2','','项目目录'),...(rows.length?rows:[empty('建立第一个项目后，可以在这里保存资料和交接。')]),el('div','actions',btn('个人空间',()=>actions.openHome('personal'),'secondary','layers'),btn('检索资料',()=>search(null),'secondary','file'),btn('保存个人资料',()=>addSource(null),'secondary'))));return}
    if(!project)throw new Error('找不到此项目。');
    const [space,brief,timeline,workspaces]=await Promise.all([api('/spaces/'+url(project.spaceId)),personal?null:api('/projects/'+url(pid)+'/brief'),personal?[]:api('/projects/'+url(pid)+'/timeline'),personal?null:api('/projects/'+url(pid)+'/workspaces')]);
    const page=space.structure.pages.find(p=>p.id===state.page)||space.structure.pages[0];
    const blocks=await Promise.all(page.blocks.map(b=>section(b,space,brief,items(timeline))));
    if(!actions.current(serial))return;
    $('heading').textContent=project.name;
    $('subhead').textContent=personal?'':items(workspaces).map(i=>i.name+' · '+i.workspaceRef).join(' / ');
    $('tools').replaceChildren(btn('检索资料',()=>search(personal?null:pid),'secondary','file'),...(!personal?[btn('绑定工作区',()=>bindWorkspace(pid),'secondary')]:[]));
    const pages=el('nav','pages',...space.structure.pages.map(p=>btn(p.title,()=>actions.openHome(pid,p.id),page.id===p.id?'active secondary':'ghost')));
    const grid=el('div','blocks',...blocks);grid.style.setProperty('--columns',page.columns||1);
    const useTheme=space.structure.theme;const holder=el('div','page',pages,el('div','actions',personal?null:btn('写记录',()=>newRecord(pid),'secondary','edit'),btn('保存资料',()=>addSource(personal?null:pid),'secondary','file'),btn('编辑页面',()=>editPage(space,page),'ghost'),space.revision>1?btn('恢复布局',()=>form('恢复空间布局',[{key:'revision',label:'历史版本（当前为 '+space.revision+'）',type:'number',value:space.revision-1,required:true}],'恢复',async d=>{await api('/spaces/'+url(space.id)+'/restore',{expectedRevision:space.revision,targetRevision:Number(d.revision)});await actions.refresh()}),'ghost'):null),grid);
    if(/^#[0-9a-f]{6}$/i.test(useTheme))grid.style.borderTop='3px solid '+useTheme;
    if(space.structure.cover)holder.prepend(el('p','muted',space.structure.cover));
    $('content').replaceChildren(holder);
  }
  return {draw,createProject};
};
