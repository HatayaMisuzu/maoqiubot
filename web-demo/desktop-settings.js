import {$,api,btn,el,form,items,notice} from './lib.js';

const desktop=()=>window.maoqiuDesktop;
export const hasDesktopSettings=()=>Boolean(desktop());

export async function desktopSettings(){
  const settings=await desktop().settings();
  const instances=items(await api('/instances'));
  const dialog=$('dialog');
  if(dialog.open)dialog.close();
  const operation=btn('测试连接',async()=>{
    const start=Date.now()-50;
    await desktop().restartConnector();
    labels.textContent='正在等待本机实例登记…';
    const ids=settings.instances.map(i=>i.id);
    for(let i=0;i<40;i++){
      const current=items(await api('/instances'));
      const fresh=current.filter(i=>ids.includes(i.id)&&Date.parse(i.lastSeen)>=start);
      if(fresh.length===ids.length){
        labels.textContent=fresh.length?'连接测试结束，查看下方各实例状态。':'尚未配置执行实例。';
        showInstances(fresh);return;
      }
      if(!(await desktop().settings()).connectorRunning)break;
      await new Promise(resolve=>setTimeout(resolve,300));
    }
    const latest=await desktop().settings();
    labels.textContent=latest.lastError||'尚未收到全部本机实例的登记，请检查路径、登录状态或原生启动错误。';
    showInstances(items(await api('/instances')));
  },'secondary');
  const labels=el('p','muted',settings.lastError||(settings.connectorRunning?'连接器进程已启动':'连接器进程未启动'));
  labels.setAttribute('role','status');
  const list=el('div');
  function showInstances(live){
    list.replaceChildren(...settings.instances.map(instance=>{
      const registered=live.find(i=>i.id===instance.id);
      const status=registered?.online?'在线 · 已握手':registered?.capabilities?.error||'离线 · 等待登记';
      return el('div','record',el('strong','',instance.name),el('p','muted',status),
        el('small','muted',[instance.id,instance.profileId,instance.workspaceRef].join(' · ')),
        instance.worktree?el('p','muted',instance.worktree.branch+' · 基准 '+instance.worktree.baseCommit.slice(0,12)):null,
        el('p','muted',instance.detectedCommand||'未检测到已配置的官方可执行文件，可手填绝对路径。'),
        settings.editable?el('div','actions',btn('编辑配置',()=>instanceForm(settings,instance),'ghost'),
          btn('复制为新实例',()=>instanceForm(settings,instance,true),'ghost'),
          desktop().createWorktree?btn('新建 Git 工作树',()=>worktreeForm(instance),'ghost'):null):null);
    }));
  }
  showInstances(instances);
  dialog.replaceChildren(el('h2','','Agent 设置'),labels,el('p','muted',settings.file),
    ...(settings.editable?[]:[el('p','muted','当前从独立 JSON 文件加载配置。')]),list,
    el('div','dialog-foot',settings.editable?btn('新增实例',()=>instanceForm(settings),'ghost'):null,
      operation,btn('关闭',()=>dialog.close(),'ghost')));
  dialog.showModal();
}

function worktreeForm(instance){
  const ui=form('新建 Git 工作树',[{key:'instanceId',label:'新实例 ID',required:true}], '选择目标父目录',async({instanceId})=>{
    const result=await desktop().createWorktree({sourceId:instance.id,instanceId});
    if(!result)return;
    await desktopSettings();
    notice('已创建 '+result.branch+'。'+(result.dirty?'源目录的未提交修改仍留在原处。':'')+'测试连接后，可在项目中绑定新实例。');
  });
  ui.form.children[0].after(el('p','muted',instance.workspaceRef+' · 从当前提交创建新分支和独立执行实例。'));
}

function instanceForm(settings,instance,copy=false){
  const nextId=instance&&copy
    ?Array.from({length:settings.instances.length+1},(_,i)=>instance.id+'-'+(i+2))
      .find(id=>!settings.instances.some(i=>i.id===id))
    :instance?.id;
  const ui=form(copy?'复制执行实例':instance?'编辑执行实例':'新增执行实例',[
    {key:'adapterKey',label:'Agent',options:[{id:'codex',name:'Codex'},{id:'dsh',name:'DSH'}],value:instance?.adapterKey},
    {key:'id',label:'实例 ID',value:nextId,required:true},
    {key:'name',label:'显示名称',value:instance?.name,required:true},
    {key:'command',label:'官方可执行程序名或完整路径',value:instance?.command,required:true},
    {key:'workspaceRef',label:'工作区目录',value:instance?.workspaceRef||settings.workspace,required:true},
    {key:'profileId',label:'Profile 绑定标识',value:instance?.profileId||'default',required:true}
  ],'保存实例',async values=>{
    await desktop().saveInstance(values);
    notice('配置已保存。点「测试连接」应用并检查。');
    await desktopSettings();
  });
  if(instance)ui.form.children[0].after(el('p','muted','使用新实例 ID 可保留原有会话绑定。'));
}
