import {$,el,api,at,banner,btn,iconBtn,phase,form,upload,download,notice,state,url} from './lib.js';
import {desktopSettings,hasDesktopSettings} from './desktop-settings.js';
import {daily,mainModels,mainPermissions,memories} from './main-settings.js';
import {extensions} from './extensions.js';
const drafts=new Map();
const main=()=>state.snapshot?.thread?.instanceId==='main'||(!state.thread&&(!state.instance||state.instance==='main'));
const draftKey=()=>state.thread||('new:'+ (state.instance||'main')+':'+(state.project||''));
const currentDraft=()=>{const key=draftKey();if(!drafts.has(key))drafts.set(key,{text:'',files:[],refs:[]});return drafts.get(key)};
const instance=id=>state.instances.find(i=>i.id===id);
const actorLabel=actor=>actor?.kind==='user'?'你':actor?.id==='main'&&actor?.kind!=='tool'?'小毛球':
  actor?.kind==='tool'?'主聊工具':actor?.kind==='system'?'工作台':instance(actor?.id)?.name||actor?.id||'工作台';
const commTypes={assignment:'委派',question:'澄清问题',request:'协作请求',progress:'进度',blocked:'阻塞',
  handoff:'交接',delivery:'交付',reply:'回复',control:'转达',review:'验收',recovery:'恢复记录'};
const commLabel=comm=>actorLabel(comm.sender)+' → '+actorLabel(comm.recipient)+
  (commTypes[comm.type]?' · '+commTypes[comm.type]:'');
const expandedMessages=new Set();
const selectedMessages=new Set();
let selectionThreadId=null;
const nativeHistory=new Map();
const nativeHistoryLoading=new Set();
const controls=(run,payload)=>api('/runs/'+url(run.id)+'/commands',payload);
const finished=run=>!run||['completed','failed','blocked','cancelled'].includes(run.status);
const reading=snapshot=>snapshot?.run?.modelSetup&&!finished(snapshot.run);
const canRead=agent=>agent?.availableActions?.includes('prepare');
const keepNative={id:'',name:'跟随原生会话'};
const modelOptions=(snapshot,agent)=>snapshot?.model?.options??agent?.capabilities?.models??[];
const modelPath=id=>'/threads/'+url(id)+'/model';
const previewError=snapshot=>snapshot?.model?.previewError||snapshot?.run?.modelSetupError;
const referenceTypes={message:'消息',record:'记录',source:'原件',attachment:'附件'};
function modelName(models,id,withProvider=false){
  const label=models.find(item=>item.id===id)?.label||id;
  if(id.startsWith('[')){
    try{
      const [provider,model]=JSON.parse(id);
      if(typeof provider==='string'&&typeof model==='string'){
        const suffix=' · '+provider;
        const name=label===id?model:label.endsWith(suffix)?label.slice(0,-suffix.length):label;
        return withProvider?name+suffix:name;
      }
    }catch{}
  }
  return withProvider&&label!==id&&models.filter(item=>item.label===label).length>1?label+' · '+id:label;
}
const choicesFor=models=>[keepNative,...models.map(m=>({id:m.id,name:modelName(models,m.id,true)}))];
const activeForm=ui=>ui.dialog.open&&ui.form.parentNode===ui.dialog;
function useModelOptions(select,models){
  const previous=select.value;
  select.replaceChildren(...choicesFor(models).map(({id,name})=>{
    const option=el('option','',name);option.value=id;return option;
  }));
  select.value=models.some(m=>m.id===previous)?previous:'';
  select.disabled=!models.length;
}
function modelField(ui){
  const select=ui.controls.modelId,label=select.parentElement,field=el('div','model-field');
  const hint=el('small','model-hint'),action=el('div','model-actions');
  hint.id='model-hint';hint.setAttribute('aria-live','polite');
  select.setAttribute('aria-describedby',hint.id);
  label.before(field);field.append(label,hint,action);
  return {select,field,hint,action};
}
export const chat = actions=>{
  let previewEvent=null;
  function preview(event){
    if(state.view!=='chat'||event.threadId!==state.thread)return;
    previewEvent=event.text?event:null;
    const preview=$('chat-preview');
    if(!preview)return;
    const content=$('content'),following=content.scrollHeight-content.scrollTop-content.clientHeight<60;
    preview.textContent=event.text;preview.hidden=!event.text;
    if(following)content.scrollTop=content.scrollHeight;
  }
  function modelPicker(snapshot,agent){
    if(!agent||agent.id==='main')return null;
    if(!snapshot?.thread)return btn('选择模型',()=>newThread(agent.id),'secondary');
    const models=modelOptions(snapshot,agent);
    const {current,selected}=snapshot.model||{};
    const title=selected?'下一轮 · '+modelName(models,selected):current?'当前模型 · '+modelName(models,current):'模型 · 跟随原生会话';
    if(reading(snapshot)){
      const status=el('small','muted','正在读取原生模型…');status.setAttribute('role','status');return status;
    }
    if(!models.length){
      if(!snapshot.task&&agent.online&&canRead(agent)&&finished(snapshot.run)){
        const retry=snapshot.run?.modelSetup&&snapshot.run.status!=='completed';
        const button=btn(retry?'重试读取会话模型':'读取会话模型',async()=>{
          await api(modelPath(snapshot.thread.id),{prepare:true});await actions.refresh();
        },'secondary');
        if(retry)button.title=previewError(snapshot)||'上次未能读取原生模型';
        return button;
      }
      const status=el('small','muted model-caption',title);
      if(!agent.online)status.title='节点离线，恢复连接后可读取原生模型';
      return status;
    }
    const button=btn('',()=>{
      const ui=form('选择下一轮模型',[{key:'modelId',label:'下一轮模型',value:selected||'',options:choicesFor(models)}],'保存',async({modelId})=>{
        await api(modelPath(snapshot.thread.id),{modelId:modelId||null});await actions.refresh();
      });
      const {hint}=modelField(ui);
      hint.textContent=current?'原生会话当前模型 · '+modelName(models,current,true):'原生会话尚未报告当前模型。';
    },'secondary model-tool');
    button.append(el('span','',title));
    button.title=selected?title+(current?'，原生会话当前模型 · '+modelName(models,current,true):''):current?'当前模型 · '+modelName(models,current,true):title;
    button.disabled=!finished(snapshot.run);
    return button;
  }
  const projectOptions=()=>[{id:'',name:'个人话题'},...state.projects];
  function carryDraft(contactId,threadId){
    const key='new:'+contactId,draft=drafts.get(key);
    if(!state.thread&&(state.instance||'main')===contactId&&draft&&(!draft.pendingId||draft.pendingId===threadId)){
      delete draft.pendingId;drafts.set(threadId,draft);drafts.delete(key);
    }
  }
  function newThread(preset) {
    const id=preset||state.instance||'main',agent=instance(id);
    if(id!=='main'&&agent?.settings&&(agent.settings.enabled===false||agent.settings.allowDirect===false)){
      notice(agent.settings.enabled===false?'此 Bot 已停用。':'此 Bot 当前不允许直接聊天。');return;
    }
    const projectId=state.snapshot?.thread?.projectId||state.project||undefined;
    if(agent?.settings?.allowedProjects&&(!projectId||!agent.settings.allowedProjects.includes(projectId))){
      notice('此 Bot 仅允许用于指定项目，请从获准项目的话题开始。');return;
    }
    actions.openDraft(id,projectId);
  }
  async function readDraftModels(threadId,stillOpen){
    const path='/threads/'+url(threadId);
    let snapshot=await api(path);
    if(!modelOptions(snapshot).length&&!reading(snapshot)&&stillOpen()){
      try{await api(modelPath(threadId),{prepare:true})}
      catch(e){snapshot=await api(path);if(!reading(snapshot)&&!modelOptions(snapshot).length)throw e}
      snapshot=await api(path);
    }
    const deadline=Date.now()+45000;
    while(stillOpen()&&reading(snapshot)&&Date.now()<deadline){
      await new Promise(resolve=>setTimeout(resolve,300));
      if(stillOpen())snapshot=await api(path);
    }
    if(!stillOpen())return snapshot;
    if(reading(snapshot))throw Error('读取原生模型超时，可以稍后重试。');
    if(finished(snapshot.run)&&snapshot.run?.modelSetup&&snapshot.run.status!=='completed')
      throw Error(previewError(snapshot)||'节点未能读取原生模型，可以重试。');
    return snapshot;
  }
  function draftModels(ui,originThreadId){
    const {controls,save}=ui,{select,hint,action}=modelField(ui),contexts=new Map();
    const contextKey=()=>JSON.stringify([controls.instanceId.value,controls.projectId.value]);
    function update(){
      const agent=instance(controls.instanceId.value),key=contextKey(),preview=contexts.get(key);
      const models=modelOptions(preview?.snapshot,agent),current=preview?.snapshot?.model?.current;
      useModelOptions(select,models);
      save.disabled=!!preview?.reading;
      hint.textContent=preview?.reading?'正在读取原生模型…':preview?.error||(
        current?'原生会话当前模型 · '+modelName(models,current,true):
          !agent?.online?'节点离线，恢复连接后可读取原生模型。':
            models.length?'选择的模型用于任务首轮。':preview?.snapshot?'原生会话没有提供可选模型。':
              canRead(agent)?'可以先读取原生模型，再派发任务。':'原生会话将决定首轮模型。');
      action.replaceChildren();
      if(!models.length&&agent?.online&&canRead(agent)&&!preview?.reading)
        action.append(btn(preview?.error?'重试读取会话模型':'读取会话模型',async()=>{
          const [instanceId,projectId]=JSON.parse(key);
          const entry=contexts.get(key)||{};contexts.set(key,entry);
          entry.reading=true;entry.error='';update();
          try{
            const origin=await originThreadId();
            if(!activeForm(ui))return;
            entry.thread??=await api('/tasks/draft',{originThreadId:origin,instanceId,projectId:projectId||undefined});
            entry.snapshot=await readDraftModels(entry.thread.id,()=>activeForm(ui));
          }catch(e){entry.error=e.message}
          finally{entry.reading=false;if(activeForm(ui)&&key===contextKey())update()}
        },'secondary'));
    }
    for(const control of [controls.instanceId,controls.projectId])control.addEventListener('change',()=>{select.value='';update()});
    update();
    return ()=>{
      const preview=contexts.get(contextKey());
      return preview?.snapshot&&!preview.reading?preview.thread.id:undefined;
    };
  }
  async function ensureThread(){
    if(state.thread)return state.thread;
    const t=await api('/threads',{instanceId:state.instance||'main'});return t.id;
  }
  function delegate(){
    const contacts=state.instances.filter(i=>i.id!=='main');
    if(!contacts.length){notice('尚未接入工作 Bot，请先启动节点连接程序。');return}
    const sourceProject=state.snapshot?.thread?.projectId,unsavedOrigin=state.thread?null:currentDraft();
    let origin=state.thread||unsavedOrigin?.pendingId,submission;
    async function originThreadId(){
      if(!origin)origin=api('/threads',{instanceId:'main'}).then(t=>{
        if(unsavedOrigin)unsavedOrigin.pendingId=t.id;
        return t.id;
      }).catch(e=>{origin=null;throw e});
      return origin;
    }
    const ui=form('委派任务',[
      {key:'instanceId',label:'执行者',options:contacts.map(i=>({...i,name:i.name+(i.online?'':'（离线）')}))},
      {key:'goal',label:'任务目标',type:'textarea',required:true},{key:'constraints',label:'约束与注意事项'},
      {key:'doneWhen',label:'交付条件'},{key:'projectId',label:'所属项目',options:projectOptions(),value:sourceProject},
      {key:'modelId',label:'任务首轮模型',options:[keepNative]}
    ],'派发任务',async data=>{
      const workThreadId=preparedThread(),originThreadIdValue=await originThreadId();
      const payload={
        originThreadId:originThreadIdValue,workThreadId,instanceId:data.instanceId,goal:data.goal,
        projectId:data.projectId||undefined,modelId:data.modelId||(workThreadId?null:undefined),
        constraints:data.constraints?[data.constraints]:[],doneWhen:data.doneWhen?[data.doneWhen]:[]
      };
      const signature=JSON.stringify(payload);
      if(submission?.signature!==signature)submission={signature,id:crypto.randomUUID()};
      await api('/tasks',{...payload,requestId:submission.id});
      carryDraft('main',originThreadIdValue);await actions.load();await actions.openThread(originThreadIdValue);
    });
    if(sourceProject)ui.controls.projectId.disabled=true;
    const preparedThread=draftModels(ui,originThreadId);
  }
  async function openTask(id){
    const data=await api('/tasks/'+url(id));await actions.openThread(data.task.workThreadId);
  }
  async function communication(taskId){
    const {items}=await api('/tasks/'+url(taskId)+'/communication');
    const dialog=$('dialog');if(dialog.open)dialog.close();
    dialog.replaceChildren(el('h2','','任务通信'),...(items.length?items.map(item=>el('article','record',
      el('strong','',item.communication?commLabel(item.communication):'历史记录'),
      el('small','muted',at(item.createdAt)),el('p','text',item.text),
      item.communication?.replyTo?el('small','muted','回复 · '+item.communication.replyTo):null,
      item.refs?.length?el('small','muted','资料引用 · '+item.refs.length):null
    )):[el('p','muted','还没有任务通信。')]),el('div','dialog-foot',btn('关闭',()=>dialog.close(),'secondary')));
    dialog.showModal();
  }
  async function editPersona(){
    const current=await api('/chat/persona');
    const ui=form('主聊人格',[{key:'text',label:current.source==='custom'?'当前使用自定义人格':'当前使用默认人格',
      type:'textarea',value:current.text,required:true}],'保存人格',async({text})=>{
      await api('/chat/persona',{text});notice('人格将在下一轮生效。');
    });
    ui.controls.text.maxLength=4000;
    if(current.source==='custom')ui.save.before(btn('恢复默认',async()=>{
      await api('/chat/persona',{reset:true});ui.dialog.close();notice('已恢复默认人格。');
    },'secondary'));
  }
  async function botSettings(agent){
    if(!agent||agent.id==='main')return;
    const current=await api('/instances/'+url(agent.id)+'/settings');
    const selectedProjects=new Set(current.allowedProjects||[]);let allProjects=current.allowedProjects==null;
    const ui=form('Bot 设置',[
      {key:'name',label:'显示名称',value:current.name??agent.name,required:true},
      {key:'description',label:'擅长与用途',type:'textarea',value:current.description??''},
      {key:'enabled',label:'Bot 状态',options:[{id:'true',name:'启用'},{id:'false',name:'停用'}],value:String(current.enabled!==false)},
      {key:'allowDirect',label:'用户可直接聊天',options:[{id:'true',name:'允许'},{id:'false',name:'禁止'}],value:String(current.allowDirect!==false)},
      {key:'allowDelegate',label:'小毛球可委派',options:[{id:'true',name:'允许'},{id:'false',name:'禁止'}],value:String(current.allowDelegate!==false)}
    ],'保存设置',async values=>{
      await api('/instances/'+url(agent.id)+'/settings',{
        name:values.name,description:values.description,enabled:values.enabled==='true',
        allowDirect:values.allowDirect==='true',allowDelegate:values.allowDelegate==='true',
        allowedProjects:allProjects?null:[...selectedProjects]
      });await actions.load();actions.refresh();notice('Bot 设置已保存。');
    });
    if(['codex','dsh'].includes(agent.adapterKey)){
      const usage=el('div','muted','额度未知');usage.setAttribute('role','status');
      const read=agent.online&&agent.capabilities?.usage?btn('查询原生额度',async()=>{
        usage.textContent='正在查询…';
        try{
          const data=await api('/instances/'+url(agent.id)+'/usage');
          usage.textContent=data.windows.length?'Codex App Server · '+at(data.fetchedAt):'额度未知';
          for(const window of data.windows){
            const duration=window.durationMinutes?window.durationMinutes+' 分钟窗口':'窗口长度未知';
            const reset=window.resetsAt?'，重置 '+at(window.resetsAt*1000):'';
            usage.append(el('div','',duration+' · 已用 '+window.usedPercent+'%'+reset));
          }
        }catch(error){usage.textContent='额度未知';throw error}
      },'secondary'):null;
      ui.form.children[0].after(el('div','record',el('p','muted',(agent.online?'节点在线':'节点离线')+
        (agent.lastSeen?' · 最近节点心跳 '+at(agent.lastSeen):'')),usage,read));
    }
    const all=el('input');all.type='checkbox';all.checked=allProjects;
    const choices=el('div','project-access');
    choices.append(el('label','check-field',all,el('span','','所有项目（遵循已有项目授权）')));
    const projectInputs=[];
    for(const project of state.projects){
      const checkbox=el('input');checkbox.type='checkbox';checkbox.value=project.id;checkbox.checked=selectedProjects.has(project.id);
      checkbox.addEventListener('change',()=>checkbox.checked?selectedProjects.add(project.id):selectedProjects.delete(project.id));
      projectInputs.push(checkbox);choices.append(el('label','check-field',checkbox,el('span','',project.name)));
    }
    all.addEventListener('change',()=>{allProjects=all.checked;projectInputs.forEach(input=>{input.disabled=allProjects})});
    if(allProjects)projectInputs.forEach(input=>{input.disabled=true});
    ui.form.querySelector('.form-err').before(choices);
  }
  function threadMenu(thread){
    const dialog=$('dialog');
    const actionsList=[];
    const permanent=thread.kind==='main'||thread.conversationType==='main';
    if(!permanent)actionsList.push(btn('重命名',()=>form('重命名会话',[
      {key:'title',label:'会话名称',value:thread.title||'',required:true}
    ],'保存',async({title})=>{await api('/threads/'+url(thread.id)+'/lifecycle',{action:'rename',title});await actions.load();await actions.refresh();}), 'settings-row','edit'));
    if(!permanent)actionsList.push(btn(thread.state==='archived'?'恢复会话':'归档会话',async()=>{
      const result=await api('/threads/'+url(thread.id)+'/lifecycle',{action:thread.state==='archived'?'restore':'archive'});
      dialog.close();await actions.load();await actions.refresh();
      notice(result.scope==='native_pending'?'已请求原生端操作，等待回执。':result.scope==='workbench'?'会话状态已更新。':'操作已完成。');
    },'settings-row','file'));
    const agent=instance(thread.instanceId);
    if(thread.sessionId&&agent?.capabilities?.nativeActions?.includes('fork'))actionsList.push(btn('从此会话分支',()=>form('创建原生分支',[
      {key:'title',label:'新会话名称',value:(thread.title||'会话')+' · 分支',required:true}
    ],'创建分支',async({title})=>{
      const branch=await api('/threads/'+url(thread.id)+'/lifecycle',{action:'fork',title});dialog.close();
      await actions.load();await actions.openThread(branch.id);notice('原生分支创建请求已提交。');
    }),'settings-row','arrow'));
    actionsList.push(btn('导出会话',async()=>{
      const result=await api('/threads/'+url(thread.id)+'/export');
      const file=new Blob([JSON.stringify(result,null,2)],{type:'application/json'}),link=el('a');
      link.href=URL.createObjectURL(file);link.download=(thread.title||'会话')+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);
    },'settings-row','arrow'));
    actionsList.push(btn('分享会话',()=>shareThread(thread),'settings-row','arrow'));
    if(thread.instanceId==='main')actionsList.push(btn('重置上下文',async()=>{
      if(!confirm('从下一条消息开始建立新上下文？聊天原文和已保存记忆仍可查阅。'))return;
      await api('/threads/'+url(thread.id)+'/lifecycle',{action:'reset'});dialog.close();
      await actions.refresh();notice('已重置本会话的模型上下文。');
    },'settings-row','sliders'));
    if(thread.instanceId==='main')actionsList.push(btn('会话工具预算',async()=>{
      const path='/threads/'+url(thread.id)+'/budget';
      const {toolBudget}=await api(path);
      form('会话工具预算',[
        {key:'softLimit',label:'起始次数（留空继承）',type:'number',value:toolBudget?.softLimit},
        {key:'hardLimit',label:'硬上限（留空继承）',type:'number',value:toolBudget?.hardLimit}
      ],'保存',async({softLimit,hardLimit})=>{
        const overrides={};
        if(softLimit)overrides.softLimit=Number(softLimit);
        if(hardLimit)overrides.hardLimit=Number(hardLimit);
        await api(path,{toolBudget:Object.keys(overrides).length?overrides:null});notice('会话工具预算已保存。');
      });
    },'settings-row','edit'));
    if(!permanent)actionsList.push(btn('删除会话',async()=>{
      await api('/threads/'+url(thread.id)+'/lifecycle',{action:'delete'});dialog.close();await actions.load();await actions.openDraft(thread.instanceId);
    },'settings-row','close'));
    dialog.replaceChildren(el('h2','','会话操作'),el('div','settings-list',...actionsList),
      el('div','dialog-foot',btn('关闭',()=>dialog.close(),'secondary')));dialog.showModal();
  }
  function shareThread(thread,messageIds){
    const targets=state.threads.filter(candidate=>candidate.id!==thread.id&&candidate.state==='active');
    const agents=state.instances;
    const projectName=id=>id?state.projects.find(project=>project.id===id)?.name||'其他项目':'个人范围';
    form('分享会话',[
      {key:'targetThreadId',label:'目标',options:[{id:'',name:'新建目标会话'},...targets.map(target=>({id:target.id,
        name:(instance(target.instanceId)?.name||'Bot')+' · '+(target.title||'会话')+' · '+projectName(target.projectId)}))]},
      {key:'instanceId',label:'新会话联系人',options:agents.map(agent=>({id:agent.id,name:agent.name})),value:agents[0]?.id||'main'},
      {key:'title',label:'新会话名称',value:'分享：'+(thread.title||'会话')}
    ],'预览内容',async({targetThreadId,instanceId,title})=>{
      const destination=targetThreadId?{targetThreadId}:{newThread:{instanceId,title:title||'分享：'+(thread.title||'会话')}};
      const selection=messageIds?.length?{messageIds}:{};
      const preview=await api('/threads/'+url(thread.id)+'/share',{...destination,preview:true,...selection});
      const dialog=$('dialog');dialog.replaceChildren(el('h2','','分享预览'),
        el('p','muted',preview.crossProject?'跨项目分享 · 仅包含已授权的用户原文和附件':'将分享 '+(preview.items?.length||0)+' 条消息。'),
        ...(preview.items||[]).map(item=>el('article','record',el('small','muted',(item.role||'')+' · '+at(item.createdAt)),el('p','text',item.text||''),
          item.attachments?.length?el('small','muted','附件 · '+item.attachments.map(file=>file.name).join('、')):null)),
        el('div','dialog-foot',btn('返回',()=>shareThread(thread,messageIds),'secondary'),btn(preview.crossProject?'确认跨项目分享':'分享',async()=>{
          await api('/threads/'+url(thread.id)+'/share',{...destination,...selection,...(preview.crossProject?{confirmCrossProject:true}:{})});dialog.close();
          for(const id of messageIds||[])selectedMessages.delete(id);
          await actions.load();await actions.refresh();notice('会话内容已分享。');
        },'primary')));dialog.showModal();
    });
  }
  function runBox(snapshot){
    const {task,run,review,commands=[]}=snapshot;if(!task&&(!run||run.modelSetup&&run.status!=='uncertain'))return null;
    const root=el('div'),actionsBox=el('div','actions');
    if(task)actionsBox.append(btn('任务通信',()=>communication(task.id),'secondary'));
    if(task?.brief?.coordination)actionsBox.append(btn('协调设置',()=>{
      const scope=task.brief.coordination;
      const modes=[{id:'off',name:'关闭'},{id:'notify',name:'仅通知'},{id:'assist',name:'使用项目事实答复'}];
      if(task.projectId&&!scope.parentTaskId)modes.push({id:'handoff',name:'允许同项目转派'});
      form('任务协调',[
        {key:'coordination',label:'协调方式',value:scope.mode,options:modes},
        ...(task.projectId&&!scope.parentTaskId?[{key:'targets',label:'允许转派的实例 ID，用逗号分隔',value:scope.targets.join(', ')}]:[]),
        {key:'status',label:'运行状态',value:scope.paused?'pause':'resume',options:[{id:'resume',name:'允许协调'},{id:'pause',name:'暂停协调'}]},
      ],'保存',async({coordination,targets,status})=>{
        await api('/tasks/'+url(task.id)+'/coordination',{coordination,handoffTargets:targets?targets.split(',').map(id=>id.trim()).filter(Boolean):[],paused:status==='pause'});
        await actions.refresh();
      });
    },'secondary'));
    const assignee=instance(snapshot.thread.instanceId);
    const criteria=task?.brief?.doneWhen;
    if(run?.status==='completed'&&Array.isArray(criteria)&&criteria.length){
      actionsBox.append(btn('核对交付',()=>{
        const fields=criteria.flatMap((criterion,i)=>[
          {key:'result'+i,label:criterion,options:[{id:'',name:'请选择核对结果'},{id:'yes',name:'已满足'},{id:'no',name:'尚缺'}],required:true},
          {key:'detail'+i,label:'第 '+(i+1)+' 项的证据或缺项',type:'textarea',required:true}]);
        form('核对交付',fields,'保存核对结果',async values=>{
          const checks=criteria.map((criterion,i)=>({criterion,met:values['result'+i]==='yes',evidence:values['detail'+i]}));
          await api('/tasks/'+url(task.id)+'/review',{runId:run.id,checks});await actions.refresh();
        });
      },'secondary','task'));
    }
    if(run&&!run.modelSetup&&['queued','running','waiting_input','uncertain'].includes(run.status)&&assignee?.availableActions?.includes('cancel'))
      actionsBox.append(btn('停止运行',async()=>{await controls(run,{kind:'cancel'});await actions.refresh()},'secondary'));
    const status=run&&['cancelling','waiting_input','uncertain'].includes(run.status)?run.status:(task?.status||run?.status);
    const statusText=status==='completed'&&review?.status==='completed'?'验收通过':phase(status);
    const detail=[run?.status==='completed'&&statusText!=='执行结束'?'执行结束':null,snapshot.submittedArtifacts?'成果已提交':null].filter(Boolean);
    root.append(el('div','status',el('strong','',[...detail,statusText].join(' · ')),actionsBox));
    if(review)root.append(el('div','pending',el('strong','','所有者验收 · '+at(review.at)),
      ...review.checks.map(c=>el('p','text',(c.met?'已满足':'待补齐')+' · '+c.criterion+' · '+c.evidence))));
    if(status==='uncertain'){
      const endpoint='/runs/'+url(run.id)+'/recovery';
      root.append(el('p','muted','原生运行结果待核对。放弃只解锁工作台，原生运行可能仍在执行。'),
        el('div','actions',
          btn('查询原生回执',async()=>{
            await api(endpoint,{action:'inspect'});await actions.refresh();notice('已请求核对，节点回执将显示在工作话题。');
          },'secondary'),
          btn('放弃等待',()=>form('放弃等待原运行',[
            {key:'reason',label:'放弃原因',required:true},{key:'confirm',label:'原生运行可能仍在执行',
              options:[{id:'',name:'保留待核对'},{id:'yes',name:'理解风险，停止等待'}],required:true}
          ],'保存',async d=>{
            await api(endpoint,{action:'abandon',acknowledge:d.confirm==='yes',reason:d.reason});await actions.refresh();
          }),'secondary'),
          hasDesktopSettings()?btn('检查连接',desktopSettings,'secondary'):null));
    }
    const issue=commands.filter(c=>c.runId===run?.id&&['failed','uncertain'].includes(c.status)&&c.detail).at(-1);
    if(issue)root.append(el('p','muted',issue.detail));
    const request=run?.pendingRequest;
    if(request&&run.status==='waiting_input'){
      const options=el('div','actions');for(const opt of request.options||[]){const key=typeof opt==='string'?opt:(opt.id||opt.value||opt.optionId);if(!key)continue;
        options.append(btn(typeof opt==='string'?opt:(opt.label||opt.name||key),async()=>{await controls(run,{kind:'answer',nativeRequestId:request.requestId,choice:key});await actions.refresh()},'secondary'))}
      root.append(el('div','pending',el('strong','','等待你的回应'),el('p','text',request.text||request.question||''),options));
    }
    for(const cmd of commands.filter(c=>['waiting','held'].includes(c.status))){const original=cmd.payload?.inputText??cmd.payload?.text??'';
      const commandRun={id:cmd.runId};
      const resume=cmd.status==='held'&&finished(run)?btn('继续发送',async()=>{
        const risk=run?.recovery?.action==='abandon';
        if(risk && !confirm('原生运行可能仍在执行。确认在当前会话继续？'))return;
        await controls(commandRun,{kind:'resume',commandId:cmd.id,acknowledge:risk});await actions.refresh();
      },'secondary'):null;
      root.append(el('div','pending',el('strong','',phase(cmd.status)),el('p','text',original),el('div','actions',
        resume,
        btn('编辑',()=>form('编辑待发输入',[{key:'text',label:'内容',value:original,type:'textarea',required:true}],'保存',async({text})=>{await controls(commandRun,{kind:'edit',commandId:cmd.id,text});await actions.refresh()}),'ghost'),
        btn('撤回',async()=>{await controls(commandRun,{kind:'withdraw',commandId:cmd.id});await actions.refresh()},'ghost'))))}
    return root;
  }
  function chatSettings(thread){
    const dialog=$('dialog');
    const entries=[
      ['主聊模型','chat',()=>mainModels(actions.refresh)],
      ['主聊权限','key',mainPermissions],
      ['主聊人格','edit',editPersona],
      ['插件与 Skill','layers',extensions],
      ...(thread?[['记忆候选','file',()=>memories(thread.id)],['事项提醒','task',()=>daily(thread.id)]]:[])
    ];
    dialog.replaceChildren(el('h2','','对话设置'),el('div','settings-list',
      ...entries.map(([label,symbol,run])=>btn(label,run,'settings-row',symbol))),
      el('div','dialog-foot',btn('关闭',()=>dialog.close(),'secondary')));
    dialog.showModal();
  }
  function drawContent(){
    const snap=state.snapshot, content=$('content'), prev=content.scrollTop, nearBottom=content.scrollHeight-content.clientHeight-prev<60;
    const isNew=content.dataset.topic!==draftKey();content.dataset.topic=draftKey();
    const t=snap?.thread,agent=instance(t?.instanceId||state.instance);
    if(selectionThreadId!==t?.id){selectedMessages.clear();selectionThreadId=t?.id??null}
    const sourceLabels={identity:'固定主会话',migrated:'迁移主会话',direct:'用户直聊',delegated:'任务委派',imported:'原生导入',local:'工作台会话'};
    const syncStatus=t?.nativeInvalid?'原生绑定失效':t?.nativeArchived?'原生端已归档':
      t?.sessionId?agent?.online?(agent.capabilities?.nativeHistory?'原生历史可读取':'工作台缓存'):'离线缓存':null;
    $('heading').textContent=t?.title||agent?.name||'小毛球';
    $('subhead').textContent=[t?.projectId&&state.projects.find(p=>p.id===t.projectId)?.name,
      t?.source&&sourceLabels[t.source],syncStatus,snap?.mainChat?.model,
      agent&&agent.id!=='main'?(agent.online?'节点在线':'节点离线'):null].filter(Boolean).join(' · ');
    const model=modelPicker(snap,agent);
    const toolButtons=main()?[btn('委派任务',delegate,'secondary','task'),btn('设置',()=>chatSettings(t),'secondary','sliders')]:model?[model]:[];
    if(agent&&agent.id!=='main')toolButtons.push(btn('Bot 设置',()=>botSettings(agent),'secondary','sliders'));
    if(t&&selectedMessages.size)toolButtons.push(btn('分享已选 · '+selectedMessages.size,()=>shareThread(t,[...selectedMessages]),'secondary','arrow'));
    if(t)toolButtons.push(btn('会话',()=>threadMenu(t),'secondary','edit'));
    $('tools').replaceChildren(...toolButtons);
    if(!t?.sessionId&&!snap?.messages?.length&&!snap?.task&&(!snap?.run||snap.run.modelSetup&&snap.run.status!=='uncertain')){
      const greeting=main()?banner('今天想一起','做什么？'):banner('和'+(agent?.name||'工作 Bot')+'聊聊');
      content.replaceChildren(el('div','chat-start',greeting,
        agent?.capabilities?.error?el('p','form-err',agent.capabilities.error):null));return;
    }
    const stream=el('div','stream'),box=runBox(snap);
    if(agent?.capabilities?.error)stream.append(el('p','form-err',agent.capabilities.error));
    if(t?.sessionId)stream.append(el('details','muted',el('summary','','原生会话'),el('code','',t.sessionId),
      el('p','muted',agent?.capabilities?.sessionList?'后续消息会在该原生会话继续。历史可在原客户端查看。':
        '可接续工作台已绑定的会话。该实例未提供可核验的外部会话目录。')));
    const historyKey=t?.sessionId&&!t.nativeInvalid?t.id+':'+t.sessionId:null;
    const cached=historyKey?nativeHistory.get(historyKey):null;
    if(historyKey&&(cached||agent?.capabilities?.nativeHistory)){
      const details=el('details','native-history',el('summary','',
        '原生端可见历史'+(cached?' · '+cached.items.length:'')));
      details.open=!isNew&&Boolean(content.querySelector('.native-history')?.open);
      if(cached)details.append(el('p','muted',(agent?.online?'原生端读取':'离线缓存')+' · '+at(cached.fetchedAt)));
      if(cached?.items?.length)for(const item of cached.items)
        details.append(el('article','native-message '+(item.role==='user'?'user':''),el('small','muted',item.role==='user'?'原生用户':'原生 Agent'),el('p','text',item.text)));
      const loadHistory=async before=>{
        if(nativeHistoryLoading.has(historyKey))return;
        nativeHistoryLoading.add(historyKey);
        const query=new URLSearchParams();if(before)query.set('before',before);
        try{
          const page=await api('/threads/'+url(t.id)+'/native'+(query.size?'?'+query:''));
          const seen=new Set(),items=[...page.items,...(before?cached.items:[])].filter(item=>{
            const key=JSON.stringify([item.turnId,item.id]);
            if(seen.has(key))return false;
            seen.add(key);return true;
          });
          const cursors=new Set(before?cached.cursors:[]);
          if(before)cursors.add(before);
          nativeHistory.set(historyKey,{items,nextBefore:cursors.has(page.nextBefore)?null:page.nextBefore,cursors,
            fetchedAt:page.fetchedAt||new Date().toISOString()});
        }finally{
          nativeHistoryLoading.delete(historyKey);
          if(state.view==='chat'&&state.thread===t.id)drawContent();
        }
      };
      if(agent?.online&&agent.capabilities?.nativeHistory){
        details.append(btn(cached?'刷新原生历史':'读取原生端历史',()=>loadHistory(),'secondary'));
        if(cached?.nextBefore)details.append(btn('加载更早原生消息',()=>loadHistory(cached.nextBefore),'secondary'));
      }
      stream.append(details);
    }
    if(box)stream.append(box);
    if(snap.nextBefore)stream.append(btn('加载更早消息',actions.loadOlder,'secondary'));
    for(const m of snap.messages||[]){
      const comm=m.data?.communication;
      const role=comm?actorLabel(comm.sender):m.role==='user'?'你':m.role==='assistant'?(agent?.name||'小毛球'):({activity:'原生活动',artifact:'成果',input_required:'请求回应'}[m.kind]||'工作台');
      const article=el('article','msg '+(m.role==='user'?'user':''),el('div','msg-meta',role,el('small','',at(m.createdAt))));
      if(m.text)article.append(el('div',m.kind==='activity'?'activity text':'text',m.text));
      if(m.data?.webReferences?.length||m.data?.webResult){
        const web=m.data.webResult,refs=m.data.webReferences??web.references??[];
        const sources=el('details','muted',el('summary','','网页来源 · '+refs.length));
        if(web?.query)sources.append(el('p','muted',web.query+' · '+web.provider+' · '+web.elapsedMs+' ms'));
        if(web?.body)sources.append(el('p','text',web.body));
        for(const item of refs){
          try{
            const target=new URL(item.url);
            if(!['https:','http:'].includes(target.protocol))continue;
            const link=el('a','',item.title||target.hostname);link.href=target.href;link.target='_blank';link.rel='noopener noreferrer';
            sources.append(el('p','muted',link,' · '+at(item.retrievedAt)));
          }catch{}
        }
        article.append(sources);
      }
      if(m.data?.usedMemories?.length)article.append(el('details','muted',el('summary','','引用记忆 · '+m.data.usedMemories.length),
        ...m.data.usedMemories.map(memory=>el('p','muted',(memory.projectId?'项目':'个人')+' · 版本 '+memory.revision+' · '+memory.id))));
      const check=m.data?.deliveryCheck;
      if(check)article.append(el('details','muted',el('summary','','查看交付核对依据'),
        el('p','muted','运行 '+(check.runStatus||'无')+' · '+check.reportIds.length+' 条交付回执'),
        ...check.files.map(f=>el('p','muted',(f.status==='readable'?'可读 · ':'待核对 · ')+f.path+
          (f.bytes!==undefined?' · '+f.bytes+' 字节':''))),
        ...check.materials.map(a=>el('p','muted',(a.status==='available'?'可访问 · ':'待核对 · ')+(a.title||a.id))),
        ...check.criteria.map(criterion=>el('p','muted','验收条件 · '+criterion))));
      if(m.taskId&&m.taskId!==t?.taskId){const task=snap.linkedTasks?.[m.taskId],status=phase(task?.status||m.data?.status);
        article.append(btn('查看工作话题'+(status?' · '+status:''),()=>openTask(m.taskId),'task-card','task'))}
      if(m.kind==='tool'&&m.data.workThreadId)article.append(btn('打开工作话题',()=>actions.openThread(m.data.workThreadId),'task-card','task'));
      if(m.data?.communicationId&&m.data?.workThreadId&&comm?.type==='clarification_notice'){
        article.append(btn('回复工作 Bot',()=>form('回复工作 Bot',[{key:'text',label:'你的原话',type:'textarea',required:true}],
          '发送',async ({text})=>{await api('/threads/'+url(m.data.workThreadId)+'/messages',{text,replyTo:m.data.communicationId});await actions.refresh()}),'secondary'));
      }
      if(m.refs?.length)article.append(el('div','reference-list',...m.refs.filter(ref=>ref.type!=='attachment').map(ref=>
        el('small','muted',(referenceTypes[ref.type]||'引用')+' · '+(ref.title||ref.text||ref.id).slice(0,70)))));
      for(const id of m.data?.attachmentIds||[])article.append(btn('下载附件',()=>download(id),'ghost','file'));
      if(m.text&&['message','artifact'].includes(m.kind)){
        const tools=el('div','message-tools',
          btn('引用',()=>{const d=currentDraft();if(!d.refs.some(r=>r.id===m.id))d.refs.push({type:'message',id:m.id,excerpt:m.text.slice(0,26)});$('compose').dataset.key='';drawComposer();$('input').focus()},'ghost'),
          btn(selectedMessages.has(m.id)?'取消分享选中':'选择分享',()=>{
            if(selectedMessages.has(m.id))selectedMessages.delete(m.id);else selectedMessages.add(m.id);
            drawContent();
          },'ghost'),
          btn('归档',()=>form('保存这段原话',[{key:'title',label:'资料标题',value:m.text.slice(0,40),required:true},{key:'projectId',label:'保存位置',options:[{id:'',name:'个人资料'},...state.projects],value:t.projectId||''}],'保存',async d=>{
            await api('/submissions',{projectId:d.projectId||undefined,source:{title:d.title,text:m.text,author:role,platform:'小毛球 Bot 工作台',attachmentIds:m.data?.attachmentIds||[]}});notice('原话已归档。')
          }),'ghost'));
        if(t.instanceId==='main'&&m.kind==='message')tools.append(btn('删除消息',async()=>{
          if(!confirm('删除此条消息？独立分享的副本仍保留。'))return;
          await api('/threads/'+url(t.id)+'/lifecycle',{action:'deleteMessage',messageId:m.id});
          selectedMessages.delete(m.id);await actions.refresh();
        },'ghost'));
        article.append(tools);
      }
      if(comm?.visibility==='bot_internal'||m.kind==='tool'){
        const detail=el('details','msg',el('summary','',comm?commLabel(comm):role),article);
        detail.open=expandedMessages.has(m.id);
        detail.ontoggle=()=>{if(detail.open)expandedMessages.add(m.id);else expandedMessages.delete(m.id)};
        stream.append(detail);
      }else stream.append(article);
    }
    for(const job of snap.mainChat?.pending||[]){
      if(job.proposal){
        const resolve=async approved=>{await api('/chat/approve',{messageId:job.messageId,approvalId:job.proposal.id,approved});await actions.refresh()};
        const {tool,arguments:args,expires}=job.proposal;
        stream.append(el('article','msg',el('strong','','请确认 · '+tool),
          el('pre','text',JSON.stringify(args,null,2)),el('small','muted','有效至 '+at(expires)),
          el('div','actions',btn('确认执行',()=>resolve(true),'primary'),btn('拒绝',()=>resolve(false),'ghost'))));
        continue;
      }
      if(job.status==='budget_paused'){
        const budget=job.budget||{};
        const continueJob=async hardLimit=>{
          await api('/chat/continue',{messageId:job.messageId,...(hardLimit?{hardLimit}: {})});await actions.refresh();
        };
        const increase=async()=>{
          const policy=await api('/chat/policy');
          if(budget.hardLimit>=policy.toolHardLimit){
            await mainPermissions();notice('全局硬上限尚未高于本轮上限，请调整后继续。');return;
          }
          const ui=form('提高本轮工具上限',[{key:'hardLimit',label:'新的本轮硬上限',type:'number',
            value:Math.min(policy.toolHardLimit,budget.hardLimit+10),required:true}],'继续',async({hardLimit})=>continueJob(Number(hardLimit)));
          ui.controls.hardLimit.min=String(budget.hardLimit+1);ui.controls.hardLimit.max=String(policy.toolHardLimit);
        };
        stream.append(el('div','pending',el('strong','','本轮已暂停'),
          el('p','text','工具调用 '+budget.used+' / '+budget.softLimit+'，本轮硬上限 '+budget.hardLimit+'。已完成的操作和回执已保存。'),
          el('div','actions',btn('继续本轮',()=>continueJob(),'secondary'),btn('调整本轮上限',increase,'ghost'))));
        continue;
      }
      stream.append(el('div','pending',el('span','',job.status==='queued'?'主聊等待处理':'主聊正在回复'),
        btn('取消生成',async()=>{await api('/chat/cancel',{messageId:job.messageId});await actions.refresh()},'ghost')));
    }
    const activePreview=previewEvent?.threadId===t?.id&&snap.mainChat?.pending?.some(job=>job.messageId===previewEvent?.messageId);
    const preview=el('div','msg text',activePreview?previewEvent.text:'');preview.id='chat-preview';preview.hidden=!activePreview;
    stream.append(preview);
    content.replaceChildren(stream);content.scrollTop=(nearBottom||isNew)?content.scrollHeight:prev;
  }
  function drawComposer(){
    const key=draftKey();if($('compose').dataset.key===key&&$('input'))return;
    const contact=instance(state.snapshot?.thread?.instanceId||state.instance);
    if(contact?.id!=='main'&&contact?.settings&&(contact.settings.enabled===false||contact.settings.allowDirect===false)){
      $('compose').dataset.key=key;$('compose').replaceChildren(el('p','muted',contact.settings.enabled===false?'此 Bot 已停用，无法发送新消息。':'此 Bot 当前不允许直接聊天。'));return;
    }
    $('compose').dataset.key=key;const draft=currentDraft();
    const input=el('textarea');input.id='input';input.rows=1;input.value=draft.text;input.placeholder=main()?'输入你的问题…':'补充要求或发送消息…';input.setAttribute('aria-label','消息内容');
    const files=el('div','chips'),picker=el('input');picker.type='file';picker.multiple=true;picker.hidden=true;
    const renderFiles=()=>files.replaceChildren(...draft.refs.map((r,i)=>btn('引用 · '+r.excerpt+' ×',()=>{draft.refs.splice(i,1);renderFiles()},'chip')),...draft.files.map((f,i)=>btn(f.name+' ×',()=>{draft.files.splice(i,1);renderFiles()},'chip')));
    picker.onchange=()=>{draft.files.push(...Array.from(picker.files));picker.value='';renderFiles()};
    function resizeInput(){input.style.height='auto';input.style.height=Math.min(140,input.scrollHeight)+'px'}
    input.oninput=()=>{draft.text=input.value;resizeInput()};
    let busy=false;
    const send=btn('',async()=>{if(busy)return;const text=input.value.trim();if(!text){if(draft.files.length)notice('请说明希望怎样处理附件。');input.focus();return}
      const risk=state.snapshot?.run?.recovery?.action==='abandon'&&!state.snapshot.run.modelSetup;
      if(risk && !confirm('原生运行可能仍在执行。确认在当前会话发送？'))return;
      busy=true;input.readOnly=true;picker.disabled=true;files.inert=true;
      try{const initialId=state.thread,projectId=state.snapshot?.thread?.projectId;
        const attachmentIds=[];for(const f of draft.files){if(!f.uploadId)f.uploadId=(await upload(f,projectId)).id;attachmentIds.push(f.uploadId)}
        const refs=draft.refs.map(({type,id})=>({type,id}));
        const fingerprint=JSON.stringify([text,attachmentIds,refs]);if(draft.fingerprint!==fingerprint){draft.fingerprint=fingerprint;draft.requestId=crypto.randomUUID()}
        let id=initialId;
        if(!id&&state.draft){
          const created=await api('/threads',{instanceId:state.instance||'main',projectId:state.project||undefined,
            kind:(state.instance||'main')==='main'?'side':'native',
            firstMessage:{text,refs,attachmentIds,requestId:draft.requestId},requestId:draft.requestId});
          id=created.thread.id;
        }else{
          id=draft.pendingId||await ensureThread();draft.pendingId=id;
          await api('/threads/'+url(id)+'/messages',{text,refs,attachmentIds,requestId:draft.requestId,acknowledge:risk||undefined});
        }
        drafts.delete(key);
        if(state.view==='chat'&&state.thread===initialId&&key===draftKey()){
          await actions.load();
          if(state.view==='chat'&&state.thread===initialId&&key===draftKey()){
            $('compose').dataset.key='';await actions.openThread(id);
            if(state.thread===id&&!$('dialog').open)$('input')?.focus({preventScroll:true});
          }
        }
      }finally{busy=false;input.readOnly=false;picker.disabled=false;files.inert=false}
    },'primary send','send');send.title='发送';send.setAttribute('aria-label','发送');
    input.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();send.click()}};
    renderFiles();
    $('compose').replaceChildren(el('div','composer',files,input,el('div','composer-bar',
      iconBtn('添加附件',()=>picker.click(),'clip'),picker,el('small','key-hint','Shift + Enter 换行'),send)));
    if(draft.text)resizeInput();
  }
  return {draw:()=>{drawComposer();drawContent()},newThread,preview,
    seedReferences:(id,refs)=>drafts.set(id,{text:'',files:[],refs:[...refs]})};
};
