import {$,api,btn,el,form,notice} from './lib.js';

const choices=[{id:'off',name:'关闭'},{id:'on',name:'开启'}];
const toggle=(key,label,enabled)=>({key,label,options:choices,value:enabled?'on':'off'});
const features={
  structured:'结构化决策（JSON Schema）',tools:'原生工具调用',vision:'发送图片',stream:'使用流式接口',
  shareProject:'发送项目资料与项目聊天历史',sharePersonal:'发送个人记忆与聊天历史',
  shareAttachments:'发送明确引用的资料、附件和授权目录内容'
};
const permissions={
  task:'小毛球可按本轮指令委派与控制任务',memory:'小毛球可按本轮指令维护记忆',
  homeContent:'小毛球可按本轮指令保存项目记录和交接',homeSpace:'小毛球可按本轮指令修改当前空间布局',
  personalInProject:'项目聊天可使用相关个人记忆'
};
const flags=(fields,values)=>Object.fromEntries(Object.keys(fields).map(k=>[k,values[k]==='on']));

export async function mainModels(refresh){
  const settings=await api('/chat/models'),dialog=$('dialog');
  const footer=el('div','dialog-foot',
    btn('添加模型',()=>edit({},refresh),'primary'),btn('关闭',()=>dialog.close(),'secondary'));
  const rows=settings.models.map(model=>{
    const active=model.id===settings.activeId;
    return el('article','record',
      el('strong','',model.name+(active?' · 当前使用':model.disabled?' · 已停用':'')),
      el('p','muted',model.protocol==='codex'?'本机个人登录':model.model+' · '+model.baseUrl+(model.hasKey?' · 已配置密钥':'')),
      el('div','actions',
        !active&&!model.disabled?btn('设为主聊',async()=>{
          await api('/chat/models',{action:'select',id:model.id});await refresh();await mainModels(refresh);
        },'secondary'):null,
        model.protocol!=='codex'?btn('编辑',()=>edit(model,refresh),'secondary'):null,
        model.protocol!=='codex'&&!model.disabled?btn('测试连接',async()=>{
          const result=await api('/chat/models/test',{id:model.id});
          notice('模型已响应 · '+result.model);
        },'secondary'):null,
        model.protocol!=='codex'&&!model.disabled?btn('读取模型列表',async()=>{
          const result=await api('/chat/models/discover',{id:model.id});
          if(!result.models.length)throw Error('服务返回的模型列表为空，可手填模型 ID。');
          form('可用模型',[{key:'model',label:'选择模型 ID',options:result.models.map(id=>({id,name:id})),required:true}],
            '继续编辑',({model:selected})=>edit({...model,model:selected},refresh));
        },'secondary'):null,
        model.protocol!=='codex'&&!active?btn(model.disabled?'启用配置':'停用配置',async()=>{
          await api('/chat/models',{action:'toggle',id:model.id,disabled:!model.disabled});await mainModels(refresh);
        },'ghost'):null,
        model.protocol!=='codex'?btn('删除配置',async()=>{
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
    {key:'chatPath',label:'对话接口路径',value:model.chatPath??'/chat/completions',required:true},
    {key:'modelsPath',label:'模型列表路径',value:model.modelsPath??'/models',required:true},
    {key:'headers',label:'兼容请求头（可选 JSON）',type:'textarea',value:JSON.stringify(model.headers??{},null,2)}
  ];
  form(model.id?'编辑主聊模型':'添加主聊模型',fields,'保存',async values=>{
    let headers;
    try{headers=JSON.parse(values.headers||'{}')}catch{throw Error('兼容请求头须为 JSON 对象。')}
    await api('/chat/models',{action:'save',id:model.id,name:values.name,model:values.model,baseUrl:values.baseUrl,
      apiKey:values.apiKey||undefined,keyEnv:values.keyEnv,clearKey:values.clearKey==='on',...flags(features,values),
      inputChars:Number(values.inputChars),outputTokens:Number(values.outputTokens),timeoutMs:Number(values.timeoutMs),outputLimitField:values.outputLimitField,
      chatPath:values.chatPath,modelsPath:values.modelsPath,headers});
    await refresh();await mainModels(refresh);
  });
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
