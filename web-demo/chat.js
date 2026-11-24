import {$,el,api,at,btn,iconBtn,phase,form,upload,download,notice,state,url} from './lib.js';
import {desktopSettings,hasDesktopSettings} from './desktop-settings.js';
const drafts=new Map();
const main=()=>state.snapshot?.thread?.instanceId==='main'||(!state.thread&&(!state.instance||state.instance==='main'));
const draftKey=()=>state.thread||('new:'+ (state.instance||'main'));
const currentDraft=()=>{const key=draftKey();if(!drafts.has(key))drafts.set(key,{text:'',files:[],refs:[]});return drafts.get(key)};
const instance=id=>state.instances.find(i=>i.id===id);
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
      delete draft.pendingId;
      drafts.set(threadId,draft);drafts.delete(key);
    }
  }
  function newThread(preset) {
    const contacts=state.instances.some(i=>i.id==='main')?state.instances:[{id:'main',name:'小毛球'},...state.instances];
    async function createTopic({instanceId,title,projectId,modelId}){
      return api('/threads',{instanceId,title:title||undefined,projectId:projectId||undefined,modelId:modelId||undefined});
    }
    async function showTopic(t){carryDraft(t.instanceId,t.id);await actions.load();await actions.openThread(t.id)}
    const ui=form('开始新对话',[
      {key:'instanceId',label:'联系人',options:contacts,value:preset||'main'},{key:'title',label:'话题名称'},
      {key:'projectId',label:'所属项目',options:projectOptions()},{key:'modelId',label:'首轮模型',options:[keepNative]}
    ],'创建',async values=>await showTopic(await createTopic(values)));
    const {select,field,hint,action}=modelField(ui);
    const read=btn('创建话题并读取模型',async()=>{
      const values=Object.fromEntries(Object.entries(ui.controls).map(([key,input])=>[key,input.value.trim()]));
      const locked=[ui.controls.instanceId,ui.controls.projectId,ui.controls.title,ui.save];
      locked.forEach(input=>input.disabled=true);hint.textContent='正在创建话题…';
      try{
        const thread=await createTopic(values);
        if(!activeForm(ui))return;
        try{await api(modelPath(thread.id),{prepare:true})}catch(e){notice(e.message)}
        if(activeForm(ui)){ui.dialog.close();await showTopic(thread)}
      }catch(e){hint.textContent=e.message}
      finally{locked.forEach(input=>input.disabled=false)}
    },'secondary');
    action.append(read);
    const update=()=>{
      const agent=instance(ui.controls.instanceId.value),models=modelOptions(null,agent);
      select.value='';useModelOptions(select,models);
      field.hidden=ui.controls.instanceId.value==='main';
      action.hidden=field.hidden||models.length>0||!agent?.online||!canRead(agent);
      hint.textContent=field.hidden?'':!agent?.online?'节点离线。创建的话题仍会跟随原生会话。':
        models.length?'选择的模型用于首轮。':canRead(agent)?'读取后可以在发送首条消息前选择模型。':'原生会话将决定首轮模型。';
    };
    ui.controls.instanceId.addEventListener('change',update);update();
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
  function runBox(snapshot){
    const {task,run,review,commands=[]}=snapshot;if(!task&&(!run||run.modelSetup))return null;
    const root=el('div'),actionsBox=el('div','actions');
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
    if(run&&['queued','running','waiting_input'].includes(run.status)&&assignee?.availableActions?.includes('cancel'))
      actionsBox.append(btn('停止运行',async()=>{await controls(run,{kind:'cancel'});await actions.refresh()},'secondary'));
    const status=run&&['cancelling','waiting_input','uncertain'].includes(run.status)?run.status:(task?.status||run?.status);
    const statusText=status==='completed'&&review?.status==='completed'?'验收通过':phase(status);
    const detail=[run?.status==='completed'&&statusText!=='执行结束'?'执行结束':null,snapshot.submittedArtifacts?'成果已提交':null].filter(Boolean);
    root.append(el('div','status',el('strong','',[...detail,statusText].join(' · ')),actionsBox));
    if(review)root.append(el('div','pending',el('strong','','所有者验收 · '+at(review.at)),
      ...review.checks.map(c=>el('p','text',(c.met?'已满足':'待补齐')+' · '+c.criterion+' · '+c.evidence))));
    if(status==='uncertain')root.append(el('p','muted','原生运行结果待核对。支持查询的实例会在重新连接时尝试核对。'),
      hasDesktopSettings()?btn('检查连接',desktopSettings,'secondary'):null);
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
        await controls(commandRun,{kind:'resume',commandId:cmd.id});await actions.refresh();
      },'secondary'):null;
      root.append(el('div','pending',el('strong','',phase(cmd.status)),el('p','text',original),el('div','actions',
        resume,
        btn('编辑',()=>form('编辑待发输入',[{key:'text',label:'内容',value:original,type:'textarea',required:true}],'保存',async({text})=>{await controls(commandRun,{kind:'edit',commandId:cmd.id,text});await actions.refresh()}),'ghost'),
        btn('撤回',async()=>{await controls(commandRun,{kind:'withdraw',commandId:cmd.id});await actions.refresh()},'ghost'))))}
    return root;
  }
  function drawContent(){
    const snap=state.snapshot, content=$('content'), prev=content.scrollTop, nearBottom=content.scrollHeight-content.clientHeight-prev<60;
    const isNew=content.dataset.topic!==draftKey();content.dataset.topic=draftKey();
    const t=snap?.thread,agent=instance(t?.instanceId||state.instance);
    $('heading').textContent=t?.title||agent?.name||'小毛球';
    $('subhead').textContent=[t?.projectId&&state.projects.find(p=>p.id===t.projectId)?.name,agent&&agent.id!=='main'?(agent.online?'节点在线':'节点离线'):null].filter(Boolean).join(' · ');
    const model=modelPicker(snap,agent);
    $('tools').replaceChildren(...(main()?[btn('主聊人格',editPersona,'ghost'),btn('委派任务',delegate,'secondary','task')]:model?[model]:[]));
    if(!snap?.messages?.length&&!snap?.task&&(!snap?.run||snap.run.modelSetup)){
      const seed=text=>{const n=$('input');n.value=text;n.dispatchEvent(new Event('input'));n.focus()};
      content.replaceChildren(el('div','welcome',el('h2','',main()?'今天想一起做什么？':'和'+(agent?.name||'工作 Bot')+'聊聊'),
        agent?.capabilities?.error?el('p','form-err',agent.capabilities.error):null,
        el('div','actions',btn('开始新对话',()=>newThread(agent?.id),'outline','edit'),btn('整理一个想法',()=>seed('帮我整理一个想法：'),'outline','file'),btn('写一段代码',()=>seed('帮我写一段代码：'),'outline','code'))));return;
    }
    const stream=el('div','stream'),box=runBox(snap);
    if(agent?.capabilities?.error)stream.append(el('p','form-err',agent.capabilities.error));
    if(t?.sessionId)stream.append(el('details','muted',el('summary','','原生会话'),el('code','',t.sessionId),
      el('p','muted','可接续工作台已绑定的会话。外部会话的工作目录或 profile 无法在此核验，暂不支持导入。')));
    if(box)stream.append(box);
    if(snap.nextBefore)stream.append(btn('加载更早消息',actions.loadOlder,'secondary'));
    for(const m of snap.messages||[]){
      const role=m.role==='user'?'你':m.role==='assistant'?(agent?.name||'小毛球'):({activity:'原生活动',artifact:'成果',input_required:'请求回应'}[m.kind]||'工作台');
      const article=el('article','msg '+(m.role==='user'?'user':''),el('div','msg-meta',role,el('small','',at(m.createdAt))));
      if(m.text)article.append(el('div',m.kind==='activity'?'activity text':'text',m.text));
      if(m.taskId&&m.taskId!==t?.taskId){const task=snap.linkedTasks?.[m.taskId],status=phase(task?.status||m.data?.status);
        article.append(btn('查看工作话题'+(status?' · '+status:''),()=>openTask(m.taskId),'task-card','task'))}
      if(m.refs?.length)article.append(el('div','reference-list',...m.refs.filter(ref=>ref.type!=='attachment').map(ref=>
        el('small','muted',(referenceTypes[ref.type]||'引用')+' · '+(ref.title||ref.text||ref.id).slice(0,70)))));
      for(const id of m.data?.attachmentIds||[])article.append(btn('下载附件',()=>download(id),'ghost','file'));
      if(m.text&&['message','artifact'].includes(m.kind)){
        const tools=el('div','message-tools',
          btn('引用',()=>{const d=currentDraft();if(!d.refs.some(r=>r.id===m.id))d.refs.push({type:'message',id:m.id,excerpt:m.text.slice(0,26)});$('compose').dataset.key='';drawComposer();$('input').focus()},'ghost'),
          btn('归档',()=>form('保存这段原话',[{key:'title',label:'资料标题',value:m.text.slice(0,40),required:true},{key:'projectId',label:'保存位置',options:[{id:'',name:'个人资料'},...state.projects],value:t.projectId||''}],'保存',async d=>{
            await api('/submissions',{projectId:d.projectId||undefined,source:{title:d.title,text:m.text,author:role,platform:'小毛球 Bot 工作台',attachmentIds:m.data?.attachmentIds||[]}});notice('原话已归档。')
          }),'ghost'));
        article.append(tools);
      }
      stream.append(article);
    }
    content.replaceChildren(stream);content.scrollTop=(nearBottom||isNew)?content.scrollHeight:prev;
  }
  function drawComposer(){
    const key=draftKey();if($('compose').dataset.key===key&&$('input'))return;
    $('compose').dataset.key=key;const draft=currentDraft();
    const input=el('textarea');input.id='input';input.rows=1;input.value=draft.text;input.placeholder=main()?'输入你的问题…':'补充要求或发送消息…';input.setAttribute('aria-label','消息内容');
    const files=el('div','chips'),picker=el('input');picker.type='file';picker.multiple=true;picker.hidden=true;
    const renderFiles=()=>files.replaceChildren(...draft.refs.map((r,i)=>btn('引用 · '+r.excerpt+' ×',()=>{draft.refs.splice(i,1);renderFiles()},'chip')),...draft.files.map((f,i)=>btn(f.name+' ×',()=>{draft.files.splice(i,1);renderFiles()},'chip')));
    picker.onchange=()=>{draft.files.push(...Array.from(picker.files));picker.value='';renderFiles()};
    input.oninput=()=>{draft.text=input.value;input.style.height='auto';input.style.height=Math.min(140,input.scrollHeight)+'px'};
    let busy=false;
    const send=btn('',async()=>{if(busy)return;const text=input.value.trim();if(!text){if(draft.files.length)notice('请说明希望怎样处理附件。');input.focus();return}
      busy=true;input.readOnly=true;picker.disabled=true;files.inert=true;
      try{const initialId=state.thread,projectId=state.snapshot?.thread?.projectId,id=draft.pendingId||await ensureThread();draft.pendingId=id;
        const attachmentIds=[];for(const f of draft.files){if(!f.uploadId)f.uploadId=(await upload(f,projectId)).id;attachmentIds.push(f.uploadId)}
        const refs=draft.refs.map(({type,id})=>({type,id}));
        const fingerprint=JSON.stringify([text,attachmentIds,refs]);if(draft.fingerprint!==fingerprint){draft.fingerprint=fingerprint;draft.requestId=crypto.randomUUID()}
        await api('/threads/'+url(id)+'/messages',{text,refs,attachmentIds,requestId:draft.requestId});drafts.delete(key);
        if(state.view==='chat'&&state.thread===initialId&&key===draftKey()){$('compose').dataset.key='';await actions.load();await actions.openThread(id)}
      }finally{busy=false;input.readOnly=false;picker.disabled=false;files.inert=false}
    },'primary send','send');send.title='发送';send.setAttribute('aria-label','发送');
    input.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();send.click()}};
    renderFiles();$('compose').replaceChildren(files,el('div','composer',iconBtn('添加附件',()=>picker.click(),'plus'),picker,input,send));
  }
  return {draw:()=>{drawComposer();drawContent()},newThread,
    seedReferences:(id,refs)=>drafts.set(id,{text:'',files:[],refs:[...refs]})};
};
