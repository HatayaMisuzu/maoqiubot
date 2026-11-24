import {$,api,btn,el,form,headers,icon,iconBtn,items,notice,state,url} from './lib.js';
import {chat} from './chat.js';
import {home} from './home.js';
import {desktopSettings,hasDesktopSettings} from './desktop-settings.js';
let revision=0, cursor=0, subscription, refreshTimer, retryTimer, connection='正在连接';
const actions={load,openThread,openWorkDraft,openHome,refresh,loadOlder,current:id=>revision===id};
const chats=chat(actions),house=home(actions);
$('mark').append(icon('yarn'));$('menu').append(icon('menu'));$('menu').onclick=()=>sidebar(true);$('shade').onclick=()=>sidebar(false);
function sidebar(open){document.body.classList.toggle('open',open);$('shade').hidden=!open;$('menu').setAttribute('aria-expanded',String(open))}
function session(){
  $('session').replaceChildren(el('small','',el('i','dot '+(connection==='实时连接'?'live':'')),connection),
    ...(hasDesktopSettings()?[btn('Agent 设置',desktopSettings,'ghost')]:[]),btn('访问凭据',login,'ghost'));
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
  $('content').replaceChildren(el('div','welcome',el('h2','','连接你的工作台'),el('div','actions',btn('使用访问令牌',login,'outline','chat'))));
}
function row(title,fn,active,symbol,online){
  const b=btn('',fn,'row-btn'+(active?' active':''),symbol);b.append(el('span','title',title));b.title=title;
  if(online!=null){const d=el('i','dot '+(online?'live':''));d.title=online?'在线':'离线';b.append(d)}return b;
}
function side(){
  $('nav').replaceChildren(btn('对话',()=>go('#chat'),'chat'===state.view?'active':'','chat'),btn('项目',()=>openHome(),'home'===state.view?'active':'','layers'));
  const list=$('side-list');list.replaceChildren();
  if(state.view==='home'){list.append(el('div','group-title','项目目录',iconBtn('建立项目',house.createProject,'plus')));
    for(const p of state.projects)list.append(row(p.name,()=>openHome(p.id),p.id===state.project,'layers'));return}
  if(state.instances.some(i=>i.id!=='main')){list.append(el('div','group-title','联系人'));
    const all=state.instances.some(i=>i.id==='main')?state.instances:[{id:'main',name:'小毛球'},...state.instances];
    all.forEach(i=>list.append(row(i.name,()=>go('#chat?instance='+url(i.id)),!state.thread&&(state.instance||'main')===i.id,'chat',i.online)))}
  list.append(el('div','group-title','最近对话',iconBtn('开始新对话',()=>chats.newThread(),'plus')));
  for(const t of state.threads)list.append(row(t.title,()=>openThread(t.id),state.thread===t.id,t.taskId?'task':'chat'));
}
async function load(){
  const [instances,threads,projects]=await Promise.all([api('/instances'),api('/threads'),api('/projects')]);
  state.instances=items(instances);state.threads=items(threads);state.projects=items(projects);
}
function route(){
  const [view,params]=(location.hash.slice(1)||'chat').split('?'),q=new URLSearchParams(params);
  state.view=view==='home'?'home':'chat';state.thread=q.get('thread');state.instance=q.get('instance')||'main';state.project=q.get('project');state.page=q.get('page');
}
async function refresh(){
  const serial=++revision;
  if(state.view==='home'){await house.draw(serial);return}
  const id=state.thread;
  const snap=id?await api('/threads/'+url(id)+'?messageLimit=60'):null;
  if(snap){
    const previous=state.snapshot;
    const overlap=previous?.olderLoaded&&previous.thread.id===id?previous.messages.findIndex(m=>m.id===snap.messages[0]?.id):-1;
    if(overlap>=0){
      snap.olderLoaded=true;snap.nextBefore=previous.nextBefore;
      snap.messages=[...previous.messages.slice(0,overlap),...snap.messages];
    }
    await linkTasks(snap);
  }
  if(serial!==revision)return;
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
  try{await refresh()}catch(e){
    if(location.hash!==routeKey)return;
    if(e.status===401)return unauthorized();
    $('compose').replaceChildren();$('tools').replaceChildren();$('content').replaceChildren(el('div','page',el('p','form-err',e.message),btn('重试',navigate,'secondary')));
  }
}
async function go(hash){if(location.hash!==hash)history.pushState(null,'',hash);await navigate()}
function openThread(id){return go('#chat?thread='+url(id))}
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
        const listsChanged=['presence','thread'].includes(event.kind)||event.kind==='home'&&event.path==='/projects';
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
