import { $, api, btn, confirmDialog, displayDialog, el, form, notice } from './lib.js';

const choices = [{ id: 'off', name: '关闭' }, { id: 'on', name: '开启' }];
const toggle = (key, label, enabled) => ({ key, label, options: choices, value: enabled ? 'on' : 'off' });
const features = {
  structured: '结构化决策（JSON Schema）',
  tools: '原生工具调用',
  vision: '发送图片',
  stream: '使用流式接口',
  shareProject: '发送项目资料与项目聊天历史',
  sharePersonal: '发送个人记忆与聊天历史',
  shareAttachments: '发送明确引用的资料、附件和授权目录内容',
  allowLanHttp: '允许指定局域网 IPv4 的 HTTP（明文）'
};
const permissions = {
  task: '小毛球可按本轮指令委派与控制任务',
  memory: '小毛球可按本轮指令维护记忆',
  homeContent: '小毛球可按本轮指令保存项目记录和交接',
  homeSpace: '小毛球可按本轮指令修改当前空间布局',
  personalInProject: '项目聊天可使用相关个人记忆',
  routineRouting: '允许在已授权范围内委派、续接或追加任务，免逐次确认',
  projectDirectories: '允许在可写目录下创建独立项目子目录（操作前确认）',
  pluginCreator: '允许主聊生成待审查扩展',
  desktop: '允许主聊提出桌面操作',
  memoryCandidates: '从用户原话提议长期记忆，保存前人工审阅',
  routineWrites: '免逐次确认日常写入（新增或完成待办、新增普通笔记或集合条目）'
};
const protocolOptions = [
  ['openai-compatible', 'OpenAI Chat Completions'],
  ['openai-responses', 'OpenAI Responses'],
  ['anthropic', 'Anthropic Messages'],
  ['gemini', 'Gemini GenerateContent']
].map(([id, name]) => ({ id, name }));
const flags = (fields, values) => Object.fromEntries(Object.keys(fields).map(k => [k, values[k] === 'on']));

export async function mainModels(refresh, load, back) {
  const settings = await api('/chat/models');
  const rows = settings.models.map(model => {
    const active = model.id === settings.activeId;
    const external = protocolOptions.some(p => p.id === model.protocol);
    return el('article', 'record',
      el('div', 'record-head',
        el('strong', '', model.name),
        active ? el('span', 'badge online', '当前主聊') : model.disabled ? el('span', 'badge', '已停用') : null
      ),
      el('small', 'muted', model.protocol === 'codex'
        ? '本机个人登录'
        : external
          ? [model.model, model.baseUrl, protocolOptions.find(p => p.id === model.protocol)?.name, model.hasKey ? '已配置密钥' : ''].filter(Boolean).join(' · ')
          : '插件提供的文本模型'),
      el('div', 'actions',
        !active && !model.disabled ? btn('设为主聊', async () => {
          await api('/chat/models', { action: 'select', id: model.id });
          await refresh?.();
          await mainModels(refresh, load, back);
        }, 'primary btn-xs') : null,
        external ? btn('编辑', () => edit(model, refresh, load, back), 'secondary btn-xs') : null,
        external && !model.disabled ? btn('注册为工作 Bot', async () => {
          const bot = await api('/instances/api', { modelId: model.id });
          await load?.();
          await refresh?.();
          await mainModels(refresh, load, back);
          notice('已注册工作 Bot · ' + bot.name);
        }, 'secondary btn-xs', 'bot') : null,
        external && !model.disabled ? btn('测试连接', async () => {
          const result = await api('/chat/models/test', { id: model.id });
          notice('模型已响应 · ' + result.model);
        }, 'secondary btn-xs') : null,
        external && !model.disabled ? btn('测试能力', () => form('选择模型能力', [{
          key: 'capability',
          label: '实际测试',
          options: [
            { id: 'tools', name: '工具回环' },
            { id: 'structured', name: '结构化输出' },
            { id: 'stream', name: '流式响应' },
            { id: 'vision', name: '图片请求' }
          ]
        }], '发送测试', async ({ capability }) => {
          const finding = await api('/chat/models/capability', { id: model.id, capability });
          notice((finding.ok ? '通过' : '未通过') + ' · ' + new Date(finding.testedAt).toLocaleString());
        }, { back: () => mainModels(refresh, load, back) }), 'secondary btn-xs') : null,
        external && !model.disabled ? btn('读取模型列表', async () => {
          const result = await api('/chat/models/discover', { id: model.id });
          if (!result.models.length) throw Error('服务返回的模型列表为空，可手填模型 ID。');
          form('可用模型', [
            { key: 'model', label: '选择模型 ID', options: result.models.map(id => ({ id, name: id })), required: true }
          ], '继续编辑', ({ model: selected }) => edit({ ...model, model: selected }, refresh, load, back),
          { back: () => mainModels(refresh, load, back) });
        }, 'secondary btn-xs') : null,
        external && !active ? btn(model.disabled ? '启用配置' : '停用配置', async () => {
          await api('/chat/models', { action: 'toggle', id: model.id, disabled: !model.disabled });
          await mainModels(refresh, load, back);
        }, 'ghost btn-xs') : null,
        external ? btn('删除配置', async () => {
          const ok = await confirmDialog({
            title: '删除模型配置',
            body: '删除「' + model.name + '」的本机模型配置？',
            confirmLabel: '删除配置',
            destructive: true
          });
          if (!ok) return;
          await api('/chat/models', { action: 'delete', id: model.id });
          await refresh?.();
          await mainModels(refresh, load, back);
        }, 'destructive-ghost btn-xs') : null
      )
    );
  });

  displayDialog('主聊模型', [
    el('p', 'muted', '主聊使用这里选定的模型。工作 Bot 各自使用自己的原生会话与模型。'),
    ...rows
  ], [
    btn('添加模型', () => edit({}, refresh, load, back), 'primary', 'plus'),
    btn('关闭', () => $('dialog').close(), 'ghost')
  ], { back, wide: true });
}

function edit(model, refresh, load, back) {
  const fields = [
    { key: 'name', label: '显示名', value: model.name, required: true },
    { key: 'protocol', label: '接口协议', options: protocolOptions, value: model.protocol ?? 'openai-compatible', required: true },
    { key: 'baseUrl', label: 'API Base URL', type: 'url', value: model.baseUrl, placeholder: 'https://example.com/v1', required: true },
    { key: 'model', label: '模型 ID', value: model.model, required: true },
    { key: 'apiKey', label: 'API 密钥（留空保留现有密钥）', type: 'password' },
    { key: 'keyEnv', label: '密钥环境变量（可选）', value: model.keyEnv, placeholder: 'MAOQIU_MODEL_KEY_…' },
    toggle('clearKey', '清除已保存密钥', false),
    ...Object.entries(features).map(([key, label]) => toggle(key, label, model[key])),
    { key: 'inputChars', label: '上下文字符预算', type: 'number', value: model.inputChars ?? 24000, required: true },
    { key: 'outputTokens', label: '输出令牌预算', type: 'number', value: model.outputTokens ?? 1600, required: true },
    { key: 'outputLimitField', label: '输出预算接口字段', options: ['max_completion_tokens', 'max_tokens'].map(id => ({ id, name: id })), value: model.outputLimitField ?? 'max_completion_tokens' },
    { key: 'timeoutMs', label: '模型响应超时（毫秒）', type: 'number', value: model.timeoutMs ?? 60000, required: true },
    { key: 'chatPath', label: '对话接口路径（留空使用所选协议默认值）', value: model.chatPath },
    { key: 'modelsPath', label: '模型列表路径', value: model.modelsPath, placeholder: '/models' },
    { key: 'temperature', label: '可选温度（0 到 1，模型须支持）', value: model.temperature, placeholder: '使用模型默认值' },
    { key: 'headers', label: '兼容请求头（可选 JSON）', type: 'textarea', value: JSON.stringify(model.headers ?? {}, null, 2) }
  ];
  form(model.id ? '编辑主聊模型' : '添加主聊模型', fields, '保存', async values => {
    let headers;
    try { headers = JSON.parse(values.headers || '{}'); }
    catch { throw Error('兼容请求头须为 JSON 对象。'); }
    await api('/chat/models', {
      action: 'save',
      id: model.id,
      name: values.name,
      model: values.model,
      baseUrl: values.baseUrl,
      protocol: values.protocol,
      apiKey: values.apiKey || undefined,
      keyEnv: values.keyEnv,
      clearKey: values.clearKey === 'on',
      ...flags(features, values),
      inputChars: Number(values.inputChars),
      outputTokens: Number(values.outputTokens),
      timeoutMs: Number(values.timeoutMs),
      outputLimitField: values.outputLimitField,
      chatPath: values.chatPath || undefined,
      modelsPath: values.modelsPath || undefined,
      temperature: values.temperature === '' ? undefined : Number(values.temperature),
      headers
    });
    await refresh?.();
    await mainModels(refresh, load, back);
  }, { back: () => mainModels(refresh, load, back) });
}

export async function memories(threadId, back) {
  const path = '/chat/memory-candidates';
  const result = await api(path + '?threadId=' + encodeURIComponent(threadId));
  displayDialog('记忆候选', result.items.length
    ? result.items.map(item => el('article', 'record',
      el('strong', '', item.body),
      el('small', 'muted', item.factKey || item.recordType),
      el('details', 'fold-card', el('summary', '', '用户原话'), el('p', 'text', item.original)),
      el('div', 'actions',
        btn('核对并保存', () => form('保存长期记忆', [
          { key: 'body', label: '内容', type: 'textarea', value: item.body, required: true },
          { key: 'factKey', label: '事实键', value: item.factKey }
        ], '确认保存', async values => {
          await api(path, { threadId, id: item.id, action: 'accept', ...values });
          await memories(threadId, back);
        }, { back: () => memories(threadId, back) }), 'primary btn-xs'),
        btn('忽略', async () => {
          await api(path, { threadId, id: item.id, action: 'reject' });
          await memories(threadId, back);
        }, 'ghost btn-xs')
      )
    ))
    : [el('p', 'muted', '暂无待核对的记忆候选。')],
  [btn('关闭', () => $('dialog').close(), 'ghost')],
  { back });
}

function toDatetimeLocal(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 16);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function withLocalTimezone(value) {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(raw)) return raw;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const pad = n => String(n).padStart(2, '0');
  return `${raw.length === 16 ? raw + ':00' : raw}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export async function daily(threadId, back) {
  const path = '/chat/daily';
  const result = await api(path + '?threadId=' + encodeURIComponent(threadId));
  const editItem = (item = {}) => form(item.id ? '修改事项' : '添加事项或提醒', [
    ...(!item.id ? [{ key: 'kind', label: '类型', options: [{ id: 'todo', name: '待办' }, { id: 'reminder', name: '提醒' }] }] : []),
    { key: 'body', label: '内容', value: item.body, required: true },
    { key: 'dueAt', label: '到期时间', type: 'datetime-local', value: toDatetimeLocal(item.dueAt) }
  ], '保存', async values => {
    await api(path, {
      ...values, threadId, action: item.id ? 'update' : 'create',
      id: item.id, expectedRevision: item.revision, dueAt: withLocalTimezone(values.dueAt)
    });
    await daily(threadId, back);
  }, { back: () => daily(threadId, back) });

  displayDialog('事项与提醒', [
    el('p', 'muted', '提醒由运行中的工作台或托盘触发。重启时补记到期提醒。'),
    ...(result.items.length ? result.items.map(item => {
      const set = async action => {
        await api(path, { threadId, id: item.id, action, expectedRevision: item.revision });
        await daily(threadId, back);
      };
      return el('article', 'record',
        el('strong', '', item.body),
        el('small', 'muted', [
          item.kind === 'reminder' ? '提醒' : '待办',
          ({ open: '待处理', done: '已完成', fired: '已通知', cancelled: '已取消' }[item.state] || item.state),
          item.dueAt ? new Date(item.dueAt).toLocaleString() : ''
        ].filter(Boolean).join(' · ')),
        el('div', 'actions',
          btn('修改', () => editItem(item), 'secondary btn-xs'),
          item.state === 'open' ? btn(item.kind === 'todo' ? '完成' : '取消提醒', () => set(item.kind === 'todo' ? 'complete' : 'cancel'), 'secondary btn-xs') : null,
          btn('删除', async () => {
            const ok = await confirmDialog({
              title: '删除记录',
              body: '确认删除「' + item.body + '」？',
              confirmLabel: '删除',
              destructive: true
            });
            if (ok) await set('delete');
          }, 'destructive-ghost btn-xs')
        )
      );
    }) : [el('p', 'muted', '暂无事项或提醒。')])
  ], [
    btn('新增事项', () => editItem(), 'primary', 'plus'),
    btn('关闭', () => $('dialog').close(), 'ghost')
  ], { back });
}

export async function mainPermissions(back) {
  const policy = await api('/chat/policy');
  form('主聊工具权限', [
    ...Object.entries(permissions).map(([key, label]) => toggle(key, label, policy[key])),
    { key: 'toolBudget', label: '本轮起始工具预算', type: 'number', value: policy.toolBudget ?? 10, required: true },
    { key: 'toolHardLimit', label: '本轮工具硬上限', type: 'number', value: policy.toolHardLimit ?? 100, required: true },
    { key: 'readRoots', label: '可读取的资料目录（每行一个绝对路径）', type: 'textarea', value: policy.readRoots.join('\n') },
    { key: 'writeRoots', label: '可新建文本的目录（每行一个绝对路径）', type: 'textarea', value: policy.writeRoots.join('\n') }
  ], '保存', async values => {
    const roots = key => values[key].split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    await api('/chat/policy', {
      ...flags(permissions, values),
      toolBudget: Number(values.toolBudget),
      toolHardLimit: Number(values.toolHardLimit),
      readRoots: roots('readRoots'),
      writeRoots: roots('writeRoots')
    });
    notice('主聊工具权限已保存。');
  }, { back });
}
