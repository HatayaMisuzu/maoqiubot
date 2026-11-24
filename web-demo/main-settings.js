import {$,api,btn,el,form,notice} from './lib.js';

const choices=[{id:'off',name:'关闭'},{id:'on',name:'开启'}];
const toggle=(key,label,enabled)=>({key,label,options:choices,value:enabled?'on':'off'});
const features={
  structured:'结构化决策（JSON Schema）',tools:'原生工具调用',vision:'发送图片',stream:'使用流式接口',
  shareProject:'发送项目资料与项目聊天历史',sharePersonal:'发送个人记忆与聊天历史',
  shareAttachments:'发送明确引用的资料、附件和授权目录内容',allowLanHttp:'允许指定局域网 IPv4 的 HTTP（明文）'
};
const permissions={
  task:'小毛球可按本轮指令委派与控制任务',memory:'小毛球可按本轮指令维护记忆',
  homeContent:'小毛球可按本轮指令保存项目记录和交接',homeSpace:'小毛球可按本轮指令修改当前空间布局',
  personalInProject:'项目聊天可使用相关个人记忆',
  pluginCreator:'允许主聊生成待审查扩展',
  desktop:'允许主聊提出桌面操作',
  memoryCandidates:'从用户原话提议长期记忆，保存前人工审阅'
};
const protocolOptions=[
  ['openai-compatible','OpenAI Chat Completions'],['openai-responses','OpenAI Responses'],
  ['anthropic','Anthropic Messages'],['gemini','Gemini GenerateContent']
].map(([id,name])=>({id,name}));
const flags=(fields,values)=>Object.fromEntries(Object.keys(fields).map(k=>[k,values[k]==='on']));

export async function mainModels(refresh){
  const settings=await api('/chat/models'),dialog=$('dialog');
  const footer=el('div','dialog-foot',
    btn('添加模型',()=>edit({},refresh),'primary'),btn('关闭',()=>dialog.close(),'secondary'));
  const rows=settings.models.map(model=>{
    const active=model.id===settings.activeId;
    const external=protocolOptions.some(p=>p.id===model.protocol);
    return el('article','record',
      el('strong','',model.name+(active?' · 当前使用':model.disabled?' · 已停用':'')),
      el('p','muted',model.protocol==='codex'?'本机个人登录':external?
        [model.model,model.baseUrl,protocolOptions.find(p=>p.id===model.protocol)?.name,model.hasKey?'已配置密钥':''].filter(Boolean).join(' · '):'插件提供的文本模型'),
      el('div','actions',
        !active&&!model.disabled?btn('设为主聊',async()=>{
          await api('/chat/models',{action:'select',id:model.id});await refresh();await mainModels(refresh);
        },'secondary'):null,
        external?btn('编辑',()=>edit(model,refresh),'secondary'):null,
        external&&!model.disabled?btn('测试连接',async()=>{
          const result=await api('/chat/models/test',{id:model.id});
          notice('模型已响应 · '+result.model);
        },'secondary'):null,
        external&&!model.disabled?btn('测试能力',()=>form('选择模型能力',[{
          key:'capability',label:'实际测试',options:[{id:'tools',name:'工具回环'},{id:'structured',name:'结构化输出'},
            {id:'stream',name:'流式响应'},{id:'vision',name:'图片请求'}]
        }],'发送测试',async ({capability})=>{
          const finding=await api('/chat/models/capability',{id:model.id,capability});
          notice((finding.ok?'通过':'未通过')+' · '+new Date(finding.testedAt).toLocaleString());
        }),'secondary'):null,
        external&&!model.disabled?btn('读取模型列表',async()=>{
          const result=await api('/chat/models/discover',{id:model.id});
          if(!result.models.length)throw Error('服务返回的模型列表为空，可手填模型 ID。');
          form('可用模型',[{key:'model',label:'选择模型 ID',options:result.models.map(id=>({id,name:id})),required:true}],
            '继续编辑',({model:selected})=>edit({...model,model:selected},refresh));
        },'secondary'):null,
        external&&!active?btn(model.disabled?'启用配置':'停用配置',async()=>{
          await api('/chat/models',{action:'toggle',id:model.id,disabled:!model.disabled});await mainModels(refresh);
        },'ghost'):null,
        external?btn('删除配置',async()=>{
          if(!confirm('删除「'+model.name+'」的本机模型配置？'))return;
          await api('/chat/models',{action:'delete',id:model.id});await refresh();await mainModels(refresh);
        },'ghost'):null));
  });
  if(dialog.open)dialog.close();
  dialog.replaceChildren(el('section','',el('h2','','主聊模型'),
    el('p','muted','主聊使用这里选定的模型。工作 Bot 各自使用自己的原生会话与模型。'),...rows,footer));
  dialog.showModal();
}

function edit(model,refresh){
  const fields=[
    {key:'name',label:'显示名',value:model.name,required:true},
    {key:'protocol',label:'接口协议',options:protocolOptions,value:model.protocol??'openai-compatible',required:true},
    {key:'baseUrl',label:'API Base URL',type:'url',value:model.baseUrl,placeholder:'https://example.com/v1',required:true},
    {key:'model',label:'模型 ID',value:model.model,required:true},
    {key:'apiKey',label:'API 密钥（留空保留现有密钥）',type:'password'},
    {key:'keyEnv',label:'密钥环境变量（可选）',value:model.keyEnv,placeholder:'MAOQIU_MODEL_KEY_…'},
    toggle('clearKey','清除已保存密钥',false),
    ...Object.entries(features).map(([key,label])=>toggle(key,label,model[key])),
    {key:'inputChars',label:'上下文字符预算',type:'number',value:model.inputChars??24000,required:true},
    {key:'outputTokens',label:'输出令牌预算',type:'number',value:model.outputTokens??1600,required:true},
    {key:'outputLimitField',label:'输出预算接口字段',options:['max_completion_tokens','max_tokens'].map(id=>({id,name:id})),value:model.outputLimitField??'max_completion_tokens'},
    {key:'timeoutMs',label:'模型响应超时（毫秒）',type:'number',value:model.timeoutMs??60000,required:true},
    {key:'chatPath',label:'对话接口路径（留空使用所选协议默认值）',value:model.chatPath},
    {key:'modelsPath',label:'模型列表路径',value:model.modelsPath,placeholder:'/models'},
    {key:'temperature',label:'可选温度（0 到 1，模型须支持）',value:model.temperature,placeholder:'使用模型默认值'},
    {key:'headers',label:'兼容请求头（可选 JSON）',type:'textarea',value:JSON.stringify(model.headers??{},null,2)}
  ];
  form(model.id?'编辑主聊模型':'添加主聊模型',fields,'保存',async values=>{
    let headers;
    try{headers=JSON.parse(values.headers||'{}')}catch{throw Error('兼容请求头须为 JSON 对象。')}
    await api('/chat/models',{action:'save',id:model.id,name:values.name,model:values.model,baseUrl:values.baseUrl,protocol:values.protocol,
      apiKey:values.apiKey||undefined,keyEnv:values.keyEnv,clearKey:values.clearKey==='on',...flags(features,values),
      inputChars:Number(values.inputChars),outputTokens:Number(values.outputTokens),timeoutMs:Number(values.timeoutMs),outputLimitField:values.outputLimitField,
      chatPath:values.chatPath||undefined,modelsPath:values.modelsPath||undefined,
      temperature:values.temperature===''?undefined:Number(values.temperature),headers});
    await refresh();await mainModels(refresh);
  });
}

function showList(title,body,buttons=[]){
  const dialog=$('dialog');
  if(dialog.open)dialog.close();
  dialog.replaceChildren(el('section','',el('h2','',title),...body,el('div','dialog-foot',...buttons,btn('关闭',()=>dialog.close(),'ghost'))));
  dialog.showModal();
}
export async function memories(threadId){
  const path='/chat/memory-candidates';
  const result=await api(path+'?threadId='+encodeURIComponent(threadId));
  showList('记忆候选',result.items.length?result.items.map(item=>el('article','record',
    el('strong','',item.body),el('p','muted',item.factKey||item.recordType),
    el('details','muted',el('summary','','用户原话'),el('p','text',item.original)),el('div','actions',
      btn('核对并保存',()=>form('保存长期记忆',[
        {key:'body',label:'内容',type:'textarea',value:item.body,required:true},
        {key:'factKey',label:'事实键',value:item.factKey}
      ],'确认保存',async values=>{await api(path,{threadId,id:item.id,action:'accept',...values});await memories(threadId)}),'primary'),
      btn('忽略',async()=>{await api(path,{threadId,id:item.id,action:'reject'});await memories(threadId)},'ghost'))))
    :[el('p','muted','暂无待核对的候选。')]);
}

export async function daily(threadId){
  const path='/chat/daily',result=await api(path+'?threadId='+encodeURIComponent(threadId));
  const editItem=(item={})=>form(item.id?'修改事项':'添加事项或提醒',[
    ...(!item.id?[{key:'kind',label:'类型',options:[{id:'todo',name:'待办'},{id:'reminder',name:'提醒'}]}]:[]),
    {key:'body',label:'内容',value:item.body,required:true},
    {key:'dueAt',label:'到期时间（含时区）',value:item.dueAt,placeholder:'2026-12-01T09:00:00+08:00'}
  ],'保存',async values=>{
    await api(path,{...values,threadId,action:item.id?'update':'create',id:item.id,expectedRevision:item.revision,dueAt:values.dueAt||undefined});await daily(threadId);
  });
  showList('事项和提醒',[el('p','muted','提醒由运行中的工作台或托盘触发。重启时补记到期提醒。'),
    ...result.items.map(item=>{
      const set=async action=>{
        await api(path,{threadId,id:item.id,action,expectedRevision:item.revision});await daily(threadId);
      };
      return el('article','record',el('strong','',item.body),el('p','muted',[
        item.kind==='reminder'?'提醒':'待办',({open:'待处理',done:'已完成',fired:'已通知',cancelled:'已取消'}[item.state]||item.state),
        item.dueAt?new Date(item.dueAt).toLocaleString():''].filter(Boolean).join(' · ')),
      el('div','actions',btn('修改',()=>editItem(item),'secondary'),
        item.state==='open'?btn(item.kind==='todo'?'完成':'取消提醒',()=>set(item.kind==='todo'?'complete':'cancel'),'secondary'):null,
        btn('删除',()=>confirm('删除这项记录？')&&set('delete'),'ghost')));
    })],[btn('新增事项',()=>editItem(),'primary')]);
}

export async function mainPermissions(){
  const policy=await api('/chat/policy');
  form('主聊工具权限',[
    ...Object.entries(permissions).map(([key,label])=>toggle(key,label,policy[key])),
    {key:'readRoots',label:'可读取的资料目录（每行一个绝对路径）',type:'textarea',value:policy.readRoots.join('\n')},
    {key:'writeRoots',label:'可新建文本的目录（每行一个绝对路径）',type:'textarea',value:policy.writeRoots.join('\n')}
  ],'保存',async values=>{
    const roots=key=>values[key].split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
    await api('/chat/policy',{...flags(permissions,values),readRoots:roots('readRoots'),writeRoots:roots('writeRoots')});
    notice('主聊工具权限已保存。');
  });
}
