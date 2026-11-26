import {$,api,at,banner,btn,el,form,headers,icon,iconBtn,items,notice,state,url} from './lib.js';
import {chat} from './chat.js';
import {home} from './home.js';
import {desktopSettings,hasDesktopSettings} from './desktop-settings.js';
let revision=0, catalogRevision=0, cursor=0, subscription, refreshTimer, retryTimer, connection='正在连接';
const threadOffsets=new Map(),threadHasMore=new Map();
const actions={load,openThread,openDraft,openWorkDraft,openHome,refresh,loadOlder,current:id=>revision===id};
const chats=chat(actions),house=home(actions);
$('mark').append(icon('yarn'));$('menu').append(icon('menu'));$('menu').onclick=()=>sidebar(true);$('shade').onclick=()=>sidebar(false);
$('menu').setAttribute('aria-label','打开导航菜单');
const narrow=matchMedia('(max-width: 760px)');
function sidebar(open){
  const wasOpen=document.body.classList.contains('open');
  document.body.classList.toggle('open',open);
  $('side').inert=narrow.matches&&!open;
  document.querySelector('main').inert=open;
  $('shade').hidden=!open;
  $('menu').setAttribute('aria-expanded',String(open));
  if(open)$('side').querySelector('button:not(:disabled)')?.focus();
  else if(wasOpen&&narrow.matches)$('menu').focus();
}
narrow.addEventListener('change',()=>sidebar(false));
window.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('dialog').open&&document.body.classList.contains('open'))sidebar(false)});
sidebar(false);
function session(){
  $('session').replaceChildren(el('small','',el('i','dot '+(connection==='实时连接'?'live':'')),connection),
    el('div','session-actions',...(hasDesktopSettings()?[btn('Agent 设置',desktopSettings,'ghost','sliders')]:[]),btn('访问凭据',login,'ghost','key')));
}
function login(){
  form('连接工作台',[{key:'token',label:'访问令牌',type:'password',required:true}],'连接',async({token})=>{
    const previous=sessionStorage.getItem('mao-token');sessionStorage.setItem('mao-token',token);
    try{await api('/projects')}catch(e){if(previous)sessionStorage.setItem('mao-token',previous);else sessionStorage.removeItem('mao-token');throw e}
    await start();
  });
}
function unauthorized(){
  subscription?.abort();connection='需要登录';session();$('nav').replaceChildren();$('side-list').replaceChildren();
  $('heading').textContent='小毛球';$('tools').replaceChildren();$('subhead').textContent='';$('compose').replaceChildren();
  $('content').replaceChildren(el('div','connection-view',banner('连接你的工作台'),
    el('div','login-panel',el('p','muted','使用访问令牌打开你的对话与项目。'),btn('使用访问令牌',login,'primary','key'))));
}
function row(title,fn,active,symbol,online){
  const b=btn('',fn,'row-btn'+(active?' active':''),symbol);b.append(el('span','title',title));b.title=title;
  if(active)b.setAttribute('aria-current','page');
  if(online!=null){const d=el('i','dot '+(online?'live':''));d.title=online?'在线':'离线';b.append(d)}return b;
}
function side(){
  $('nav').replaceChildren(btn('对话',()=>go('#chat'),'chat'===state.view?'active':'','chat'),btn('项目',()=>openHome(),'home'===state.view?'active':'','folder'));
  $('nav').querySelector('.active')?.setAttribute('aria-current','page');
  const list=$('side-list');list.replaceChildren();
  if(state.view==='home'){list.append(el('div','group-title','项目目录',iconBtn('建立项目',house.createProject,'plus')));
    for(const p of state.projects)list.append(row(p.name,()=>openHome(p.id),p.id===state.project,'layers'));return}
  list.append(el('div','group-title','联系人'));
  const all=state.instances.some(i=>i.id==='main')?state.instances:[{id:'main',name:'小毛球'},...state.instances];
  for(const i of all){
    const selected=state.thread?state.threads.find(t=>t.id===state.thread)||
      (state.snapshot?.thread?.id===state.thread?state.snapshot.thread:null):null;
    const active=selected?selected.instanceId===i.id:(state.instance||'main')===i.id;
    list.append(row(i.name,()=>i.id==='main'&&state.mainThread?openThread(state.mainThread.id):go('#chat?instance='+url(i.id)),active,'chat',i.id==='main'?true:i.online));
    if(i.id==='main'&&state.mainThread)list.append(row('主会话',()=>openThread(state.mainThread.id),state.thread===state.mainThread.id,'chat'));
    if(!active)continue;
    if(i.id==='main'){
      list.append(el('div','group-title side-group',el('span','','侧边会话'),iconBtn('新建侧聊',()=>chats.newThread('main'),'plus')));
      for(const t of state.threads.filter(t=>t.instanceId==='main'&&(t.kind==='side'||t.conversationType==='side')))
        list.append(row(t.title||'侧边会话',()=>openThread(t.id),state.thread===t.id,'chat'));
    }else{
      list.append(el('div','group-title side-group',el('span','','最近会话'),iconBtn('新建会话',()=>chats.newThread(i.id),'plus')));
      for(const t of state.threads.filter(t=>t.instanceId===i.id))list.append(row(t.title||'新会话',()=>openThread(t.id),state.thread===t.id,t.taskId?'task':'chat'));
    }
    const archived=state.archivedThreads.filter(thread=>thread.instanceId===i.id);
    if(archived.length){
      list.append(el('div','group-title side-group','已归档'));
      for(const thread of archived)list.append(row('恢复 · '+(thread.title||'会话'),()=>restoreThread(thread),'','file'));
    }
    const deleted=state.deletedThreads.filter(thread=>thread.instanceId===i.id);
    if(deleted.length){
      list.append(el('div','group-title side-group','最近删除'));
      for(const thread of deleted)list.append(row('最近删除 · '+(thread.title||'会话'),()=>manageDeleted(thread),'','file'));
    }
    if(threadHasMore.get(i.id))list.append(btn('加载更早会话',()=>loadMoreThreads(i.id),'ghost'));
    list.append(btn('搜索会话',()=>findThreads(i),'ghost'));
    if(i.capabilities?.sessionList)list.append(btn('查看原生目录',()=>nativeCatalog(i),'ghost'));
  }
}
async function load(){
  const serial=++catalogRevision;
  const [instances,mainThread,projects]=await Promise.all([api('/instances'),api('/threads/main'),api('/projects')]);
  const agents=items(instances);
  const pages=await Promise.all(agents.flatMap(agent=>['active','archived','deleted'].map(status=>api('/threads?'+new URLSearchParams({
    instanceId:agent.id,state:status,limit:status==='active'?'40':'20',offset:'0'
  })))));
  if(serial!==catalogRevision)return;
  state.instances=agents;state.mainThread=mainThread;state.projects=items(projects);
  state.threads=[];state.archivedThreads=[];state.deletedThreads=[];
  state.instances.forEach((agent,index)=>{
    const active=items(pages[index*3]),archived=items(pages[index*3+1]),deleted=items(pages[index*3+2]);
    state.threads.push(...active);state.archivedThreads.push(...archived);state.deletedThreads.push(...deleted);
    threadOffsets.set(agent.id,active.length);threadHasMore.set(agent.id,active.length===40);
  });
}
function findThreads(agent){
  const dialog=$('dialog');
  const currentProject=state.snapshot?.thread?.projectId||state.project;
  const search=el('input');search.type='search';search.maxLength=120;
  const space=el('select'),status=el('select');
  for(const [id,name] of [['all','所有范围'],['','个人范围'],...state.projects.map(p=>[p.id,p.name])]){
    const option=el('option','',name);option.value=id;space.append(option);
  }
  if(state.projects.some(p=>p.id===currentProject))space.value=currentProject;
  for(const [id,name] of [['active','进行中及近期会话'],['archived','已归档']]){
    const option=el('option','',name);option.value=id;status.append(option);
  }
  const results=el('div');results.setAttribute('aria-live','polite');
  const more=btn('加载更早会话',()=>loadPage(false),'secondary');more.hidden=true;
  const controls=el('form','',el('label','field','会话名称',search),el('label','field','项目范围',space),el('label','field','状态',status));
  const submit=el('button','primary','搜索');submit.type='submit';controls.append(submit);
  controls.onsubmit=event=>{event.preventDefault();loadPage(true).catch(error=>notice(error.message))};
  let query,offset=0,revision=0,seen=new Set();
  async function loadPage(reset){
    const serial=++revision;
    if(reset){
      offset=0;seen=new Set();
      query=new URLSearchParams({instanceId:agent.id,state:status.value,q:search.value,limit:'25'});
      if(space.value!=='all')query.set('projectId',space.value);
      results.replaceChildren(el('p','muted','正在搜索…'));
      more.hidden=true;
    }
    query.set('offset',String(offset));
    const page=items(await api('/threads?'+query));
    if(serial!==revision||!dialog.open||!dialog.contains(results))return;
    if(reset)results.replaceChildren();
    for(const thread of page){
      if(seen.has(thread.id))continue;
      seen.add(thread.id);
      const project=state.projects.find(p=>p.id===thread.projectId)?.name||'个人范围';
      const row=btn(thread.title||'会话',()=>{dialog.close();return openThread(thread.id)},'settings-row','chat');
      results.append(el('div','record',row,el('small','muted',[project,at(thread.lastActivity)].filter(Boolean).join(' · '))));
    }
    if(!seen.size)results.append(el('p','muted','没有符合条件的会话。'));
    offset+=page.length;more.hidden=page.length!==25;
  }
  dialog.replaceChildren(el('h2','','搜索 '+agent.name+' 的会话'),controls,results,
    el('div','dialog-foot',more,btn('关闭',()=>dialog.close(),'ghost')));
  dialog.showModal();search.focus();return loadPage(true);
}
async function nativeCatalog(agent){
  const dialog=$('dialog'),results=el('div'),status=el('p','muted','正在读取原生目录…');
  const projectId=state.snapshot?.thread?.projectId||state.project||null;
  const path='/instances/'+url(agent.id)+'/sessions';
  const project=state.projects.find(p=>p.id===projectId)?.name||'个人范围';
  const seen=new Set(),cursors=new Set();
  let cursor=null;
  const more=btn('加载更早原生会话',()=>loadPage(),'secondary');more.hidden=true;
  async function loadPage(){
    const query=new URLSearchParams();
    if(projectId)query.set('projectId',projectId);
    if(cursor)query.set('cursor',cursor);
    try{
      const page=await api(path+(query.size?'?'+query:''));
      if(!dialog.open||!dialog.contains(results))return;
      for(const session of page.items){
        if(seen.has(session.id))continue;
        seen.add(session.id);
        results.append(el('div','record',el('strong','',session.title||'原生会话'),
          el('p','muted',[session.active?'原生端运行中':null,session.updatedAt&&at(session.updatedAt*1000)].filter(Boolean).join(' · ')),
          agent.capabilities.sessionImport!==false&&!session.active?btn('导入',async()=>{
            const result=await api(path,{projectId,sessionId:session.id,title:(session.title||'导入的原生会话').slice(0,120)});
            if(!dialog.contains(results))return;
            dialog.close();await load();await openThread(result.thread.id);
            if(result.status!=='bound')notice('导入已提交，等待原生回执。');
          },'secondary'):null));
      }
      cursor=page.nextCursor&&!cursors.has(page.nextCursor)?page.nextCursor:null;
      if(cursor)cursors.add(cursor);
      more.hidden=!cursor;
      status.textContent=seen.size?(agent.capabilities.sessionImport===false?'当前原生端未声明导入能力。':''):
        (cursor?'此页在当前范围内没有可显示的会话，可继续加载。':'当前范围暂无可显示的原生会话。');
    }catch(error){status.textContent=error.message;throw error}
  }
  dialog.replaceChildren(el('h2','','原生会话目录'),el('p','muted',agent.name+' · '+project+' · '+agent.profileId),status,results,
    el('div','dialog-foot',more,btn('关闭',()=>dialog.close(),'ghost')));
  dialog.showModal();await loadPage();
}
async function restoreThread(thread){
  await api('/threads/'+url(thread.id)+'/lifecycle',{action:'restore'});await load();side();notice('会话已恢复。');
}
async function manageDeleted(thread){
  const impact=await api('/threads/'+url(thread.id)+'/impact'),dialog=$('dialog');
  const agent=state.instances.find(item=>item.id===thread.instanceId);
  const summary=el('div','impact-summary',
    el('p','muted','关联任务 '+impact.tasks.length+' 条 · 运行 '+impact.runs.length+' 项 · 待处理命令 '+impact.jobs.length+' 项'),
    el('p','muted','分享 '+impact.shares+' 项 · 挂起输入 '+impact.held+' 项'));
  dialog.replaceChildren(el('h2','','最近删除'),el('p','text',thread.title||'此会话'),summary,
    el('p','muted',impact.scope),
    el('p','muted',impact.canPurge?'可永久清理此会话的工作台缓存。':'仍有关联运行或待核对操作，暂时不能永久清理。'),
    el('div','dialog-foot',btn('关闭',()=>dialog.close(),'secondary'),
      btn('恢复会话',async()=>{await api('/threads/'+url(thread.id)+'/lifecycle',{action:'restore'});dialog.close();await load();side()},'secondary'),
      thread.sessionId&&!thread.nativeInvalid&&agent?.capabilities?.nativeActions?.includes('delete')?btn('删除原生会话',async()=>{
        if(!confirm('确认在 '+agent.name+' 原生端永久删除会话 '+thread.sessionId+'？这会影响原生客户端中的该会话。'))return;
        const result=await api('/threads/'+url(thread.id)+'/lifecycle',{action:'deleteNative',confirm:true,sessionId:thread.sessionId});
        dialog.close();await load();side();notice(result.scope==='native_pending'?'原生删除请求已提交，等待回执。':'原生会话已删除。');
      },'secondary'):null,
      btn('永久清理',async()=>{
        if(!confirm('永久清理“'+(thread.title||'此会话')+'”及其工作台缓存？此操作无法恢复。'))return;
        await api('/threads/'+url(thread.id)+'/lifecycle',{action:'purge',confirm:true});dialog.close();await load();side();
      },'secondary')));
  dialog.querySelector('.dialog-foot button:last-child').disabled=!impact.canPurge;
  dialog.showModal();
}
async function loadMoreThreads(instanceId){
  const serial=catalogRevision,offset=threadOffsets.get(instanceId)||0;
  const page=await api('/threads?'+new URLSearchParams({instanceId,state:'active',limit:'40',offset:String(offset)}));
  if(serial!==catalogRevision||threadOffsets.get(instanceId)!==offset)return;
  const existing=new Set(state.threads.map(thread=>thread.id));
  state.threads.push(...items(page).filter(thread=>!existing.has(thread.id)));
  threadOffsets.set(instanceId,offset+items(page).length);threadHasMore.set(instanceId,items(page).length===40);side();
}
function route(){
  const [view,params]=(location.hash.slice(1)||'chat').split('?'),q=new URLSearchParams(params);
  state.view=view==='home'?'home':'chat';state.thread=q.get('thread');state.instance=q.get('instance')||'main';state.draft=q.get('draft')==='1';state.project=q.get('project');state.page=q.get('page');
}
async function refresh(){
  const serial=++revision;
  if(state.view==='home'){await house.draw(serial);return}
  const previousId=state.thread;
  if(!state.thread&&!state.draft&&(state.instance||'main')==='main'&&state.mainThread){
    state.thread=state.mainThread.id;
    const target='#chat?thread='+url(state.thread);
    if(location.hash!==target)history.replaceState(null,'',target);
  }
  if(!state.thread&&!state.draft&&state.instance!=='main'){
    const last=localStorage.getItem('mao-last-thread:'+state.instance);
    const recent=state.threads.find(thread=>thread.instanceId===state.instance&&thread.id===last)||
      state.threads.find(thread=>thread.instanceId===state.instance);
    if(recent){state.thread=recent.id;const target='#chat?thread='+url(recent.id);if(location.hash!==target)history.replaceState(null,'',target)}
    else{state.draft=true;const target='#chat?instance='+url(state.instance)+'&draft=1';if(location.hash!==target)history.replaceState(null,'',target)}
  }
  const id=state.thread;
  const snap=id?await api('/threads/'+url(id)+'?messageLimit=60'):null;
  if(snap){
    const previous=state.snapshot;
    const overlap=previous?.olderLoaded&&previous.thread.id===id&&previous.thread.contextRevision===snap.thread.contextRevision?
      previous.messages.findIndex(m=>m.id===snap.messages[0]?.id):-1;
    if(overlap>=0){
      snap.olderLoaded=true;snap.nextBefore=previous.nextBefore;
      snap.messages=[...previous.messages.slice(0,overlap),...snap.messages];
    }
    await linkTasks(snap);
  }
  if(serial!==revision)return;
  if(snap?.thread?.instanceId!=='main'&&snap?.thread?.state==='active')
    localStorage.setItem('mao-last-thread:'+snap.thread.instanceId,snap.thread.id);
  if(state.thread!==previousId)side();
  state.snapshot=snap;chats.draw();
}
async function linkTasks(snap){
  const linked=[...new Set(snap.messages.filter(m=>m.kind==='task_card').map(m=>m.taskId).filter(Boolean))];
  snap.linkedTasks=Object.fromEntries(await Promise.all(linked.map(async key=>{
    const {task,review}=await api('/tasks/'+url(key));
    return [key,{...task,status:review?.status==='completed'&&task.status==='completed'?'verified':task.status}];
  })));
}
async function loadOlder(){
  const previous=state.snapshot,id=previous?.thread.id,before=previous?.nextBefore;
  if(!id||!before)return;
  const page=await api('/threads/'+url(id)+'/messages?'+new URLSearchParams({before,limit:'60'}));
  const current=state.snapshot;
  if(state.view!=='chat'||state.thread!==id||current?.nextBefore!==before)return;
  const snap={...current,olderLoaded:true,nextBefore:page.nextBefore,messages:[...page.messages,...current.messages]};
  await linkTasks(snap);
  if(state.snapshot!==current||state.thread!==id)return;
  const content=$('content'),height=content.scrollHeight,top=content.scrollTop;
  state.snapshot=snap;chats.draw();
  content.scrollTop=top+content.scrollHeight-height;
}
async function navigate(){
  sidebar(false);route();side();const routeKey=location.hash;
  if($('content').dataset.route!==routeKey){
    $('content').dataset.route=routeKey;
    $('heading').textContent=state.view==='home'?'毛球之家':'小毛球';
    $('subhead').textContent='';
    $('tools').replaceChildren();$('compose').replaceChildren();
    $('content').replaceChildren(el('p','page muted','正在打开…'));
  }
  try{await refresh()}catch(e){
    if(location.hash!==routeKey)return;
    if(e.status===401)return unauthorized();
    $('compose').replaceChildren();$('tools').replaceChildren();$('content').replaceChildren(el('div','page',el('p','form-err',e.message),btn('重试',navigate,'secondary')));
  }
}
async function go(hash){if(location.hash!==hash)history.pushState(null,'',hash);await navigate()}
function openThread(id){return go('#chat?thread='+url(id))}
function openDraft(id,projectId){return go('#chat?instance='+url(id)+(projectId?'&project='+url(projectId):'')+'&draft=1')}
async function openWorkDraft(id,refs){
  chats.seedReferences(id,refs);
  await load();
  await openThread(id);
  requestAnimationFrame(()=>$('input')?.focus());
}
function openHome(id,page){return go('#home'+(id?'?project='+url(id)+(page?'&page='+url(page):''):''))}
window.addEventListener('hashchange',navigate);
let refreshLists=false;
function scheduleRefresh(lists){
  refreshLists||=lists;
  if(refreshTimer)return;
  refreshTimer=setTimeout(async()=>{refreshTimer=null;
    const listsChanged=refreshLists;refreshLists=false;
    try{if(listsChanged){await load();side()}await refresh()}catch(e){if(e.status===401)unauthorized();else notice(e.message)}
  },180);
}
async function subscribe(){
  subscription?.abort();clearTimeout(retryTimer);const controller=new AbortController();subscription=controller;
  try{
    const response=await fetch('/api/v1/events?after='+cursor,{headers:{...headers(),Accept:'text/event-stream'},signal:controller.signal});
    if(response.status===401){unauthorized();return}if(!response.ok)throw Error('订阅失败');
    connection='实时连接';session();const reader=response.body.pipeThrough(new TextDecoderStream()).getReader();let buffer='';
    while(true){
      const {value,done}=await reader.read();if(done)break;buffer+=value;
      let match;while((match=/\r?\n\r?\n/.exec(buffer))){
        const frame=buffer.slice(0,match.index);buffer=buffer.slice(match.index+match[0].length);
        const lines=frame.split(/\r?\n/);const data=lines.filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');
        if(!data)continue;const event=JSON.parse(data),id=Number(event.cursor||lines.find(x=>x.startsWith('id:'))?.slice(3));
        if(event.kind==='chat_delta'){chats.preview(event);continue}
        if(Number.isSafeInteger(id)&&id>cursor)cursor=id;
        const listsChanged=['presence','thread','instance'].includes(event.kind)||event.kind==='home'&&event.path==='/projects';
        if(listsChanged ||
          (state.view==='home' && (event.kind==='home'||event.taskId)) ||
          (state.view==='chat' && event.threadId===state.thread) ||
          event.taskId && state.snapshot?.linkedTasks?.[event.taskId])scheduleRefresh(listsChanged);
      }
    }
  }catch(e){if(controller.signal.aborted)return}
  if(controller.signal.aborted)return;connection='正在重连';session();retryTimer=setTimeout(subscribe,2200);
}
async function start(){
  try{cursor=(await api('/events/latest')).cursor;await load();await navigate();subscribe()}
  catch(e){if(e.status===401)return unauthorized();connection='连接失败';session();$('content').replaceChildren(el('div','page',el('p','form-err',e.message),btn('重新连接',start,'secondary')))}
}
session();start();
