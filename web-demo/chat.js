import {
  $, api, at, banner, basenamePath, btn, confirmDialog, copyText, displayDialog,
  download, el, form, getWorkBots, icon, iconBtn, notice, phase,
  resolveActiveContext, state, upload, url
} from './lib.js';
import { renderMarkdown } from './markdown.js';
import { desktopSettings, hasDesktopSettings } from './desktop-settings.js';
import { daily, mainModels, mainPermissions, memories } from './main-settings.js';
import { extensions } from './extensions.js';

const drafts = new Map();
const uploads = new WeakMap();
const expandedMessages = new Set();
const selectedMessages = new Set();
let selectionThreadId = null;

const draftKeyFor = (instanceId, projectId) => 'new:' + JSON.stringify([instanceId || 'main', projectId || null]);
const draftKey = () => state.thread || draftKeyFor(state.instance || 'main', state.project || '');
const getDraftByKey = key => {
  if (!drafts.has(key)) drafts.set(key, { text: '', files: [], refs: [], modelId: null });
  return drafts.get(key);
};
const currentDraft = () => getDraftByKey(draftKey());

function chatTarget() {
  const thread = state.snapshot?.thread;
  if (state.view !== 'chat' || (state.thread ? thread?.id !== state.thread : !state.draft)) return null;
  const key = draftKey();
  return {
    hash: location.hash, revision: state.routeRevision, key, draft: getDraftByKey(key),
    id: thread?.id || null, instanceId: thread?.instanceId || state.instance,
    projectId: thread ? thread.projectId || null : state.project || null
  };
}

function atTarget(target) {
  return state.view === 'chat' && state.routeRevision === target.revision && location.hash === target.hash &&
    draftKey() === target.key && (!target.id || state.snapshot?.thread?.id === target.id);
}

async function uploadedId(file, projectId) {
  if (!uploads.has(file)) uploads.set(file, new Map());
  const scopes = uploads.get(file);
  if (!scopes.has(projectId)) scopes.set(projectId, { requestId: crypto.randomUUID() });
  const entry = scopes.get(projectId);
  if (!entry.id) entry.id = (await upload(file, projectId, entry.requestId)).id;
  return entry.id;
}

const instance = id => state.instances.find(i => i.id === id);
const actorLabel = actor => actor?.kind === 'user' ? '你' : actor?.id === 'main' && actor?.kind !== 'tool' ? '小毛球' :
  actor?.kind === 'tool' ? '主聊工具' : actor?.kind === 'system' ? '工作台' : instance(actor?.id)?.name || actor?.id || '工作台';
const commTypes = {
  assignment: '委派', question: '澄清问题', request: '协作请求', progress: '进度', blocked: '阻塞',
  handoff: '交接', delivery: '交付', reply: '回复', control: '转达', review: '验收', recovery: '恢复记录'
};
const commLabel = comm => actorLabel(comm.sender) + ' → ' + actorLabel(comm.recipient) +
  (commTypes[comm.type] ? ' · ' + commTypes[comm.type] : '');

const controls = (run, payload) => api('/runs/' + url(run.id) + '/commands', payload);
const finished = run => !run || ['completed', 'failed', 'blocked', 'cancelled'].includes(run.status);
const reading = snapshot => snapshot?.run?.modelSetup && !finished(snapshot.run) && snapshot.run.status !== 'uncertain';
const modelSetupStatus = {
  queued: '等待工作区执行模型读取…',
  running: '正在读取原生模型…',
  cancelling: '正在确认是否已取消模型读取…',
  completed: '原生模型读取完成。',
  cancelled: '已取消模型读取。',
  uncertain: '原生读取结果待核对。'
};
const canRead = agent => agent?.availableActions?.includes('prepare');
const keepNative = { id: '', name: '跟随原生会话' };
const modelOptions = (snapshot, agent) => snapshot?.model?.options ?? agent?.capabilities?.models ?? [];
const modelPath = id => '/threads/' + url(id) + '/model';
const previewError = snapshot => snapshot?.model?.previewError || snapshot?.run?.modelSetupError;
const referenceTypes = { message: '消息', record: '记录', source: '原件', attachment: '附件' };

function modelName(models, id, withProvider = false) {
  const label = models.find(item => item.id === id)?.label || id;
  if (id.startsWith('[')) {
    try {
      const [provider, model] = JSON.parse(id);
      if (typeof provider === 'string' && typeof model === 'string') {
        const suffix = ' · ' + provider;
        const name = label === id ? model : label.endsWith(suffix) ? label.slice(0, -suffix.length) : label;
        return withProvider ? name + suffix : name;
      }
    } catch {}
  }
  return withProvider && label !== id && models.filter(item => item.label === label).length > 1 ? label + ' · ' + id : label;
}

const choicesFor = models => [keepNative, ...models.map(m => ({ id: m.id, name: modelName(models, m.id, true) }))];
const activeForm = ui => ui.dialog.open && ui.form.parentNode === ui.dialog;

function useModelOptions(select, models) {
  const previous = select.value;
  select.replaceChildren(...choicesFor(models).map(({ id, name }) => {
    const option = el('option', '', name);
    option.value = id;
    return option;
  }));
  select.value = models.some(m => m.id === previous) ? previous : '';
  select.disabled = !models.length;
}

function modelField(ui) {
  const select = ui.controls.modelId;
  const label = select.parentElement;
  const field = el('div', 'model-field');
  const hint = el('small', 'model-hint');
  const action = el('div', 'model-actions');
  hint.id = 'model-hint';
  hint.setAttribute('aria-live', 'polite');
  select.setAttribute('aria-describedby', hint.id);
  label.before(field);
  field.append(label, hint, action);
  return { select, field, hint, action };
}

export const chat = actions => {
  let previewEvent = null;

  function preview(event) {
    if (state.view !== 'chat' || event.threadId !== state.thread) return;
    if (event.text && !state.snapshot?.mainChat?.pending?.some(job => job.messageId === event.messageId && ['queued', 'working'].includes(job.status))) return;
    if (!event.text && previewEvent?.messageId !== event.messageId) return;
    previewEvent = event.text ? event : null;
    const previewEl = $('chat-preview');
    if (!previewEl) return;
    const content = $('content');
    const following = content.scrollHeight - content.scrollTop - content.clientHeight < 60;
    previewEl.textContent = event.text;
    previewEl.hidden = !event.text;
    if (following) content.scrollTop = content.scrollHeight;
  }

  function clearPreview() {
    previewEvent = null;
    const node = $('chat-preview');
    if (node) { node.textContent = ''; node.hidden = true; }
  }

  function modelPicker(snapshot, agent) {
    if (!agent || agent.id === 'main') return null;

    // Draft mode: allow pre-selecting from known capability models, or show actionable guidance
    if (!snapshot?.thread) {
      const models = agent.capabilities?.models || [];
      const draft = currentDraft();
      if (models.length) {
        const label = draft.modelId
          ? '首轮 · ' + modelName(models, draft.modelId)
          : '选择首轮模型';
        const button = btn('', () => {
          form('选择首轮模型', [
            { key: 'modelId', label: '首轮模型', value: draft.modelId || '', options: choicesFor(models) }
          ], '确定', ({ modelId }) => {
            if (draft.sending || draft.unknownCreate) throw Error('请先处理这条待发送消息。');
            draft.modelId = modelId || null;
            draw();
          }, { description: '将在首次发送消息创建话题时应用所选模型。' });
        }, 'secondary model-tool');
        button.append(el('span', '', label));
        button.disabled = Boolean(draft.sending || draft.unknownCreate);
        return button;
      }
      const infoBtn = btn('模型 · 原生决定', () => {
        displayDialog('模型说明', [
          el('p', 'text', agent.online
            ? `${agent.name} 当前未提前提供静态模型列表。发送首条消息建立原生会话后，可在顶栏「读取会话模型」；或通过小毛球「委派任务」在发单前预读原生模型。`
            : `${agent.name} 当前处于离线状态。节点恢复连接后，可读取或切换原生会话模型。`)
        ], [
          btn('关闭', () => $('dialog').close(), 'ghost'),
          btn('通过小毛球委派', () => { $('dialog').close(); delegate(); }, 'secondary')
        ], { compact: true });
      }, 'secondary model-tool');
      return infoBtn;
    }

    const models = modelOptions(snapshot, agent);
    const { current, selected } = snapshot.model || {};
    const title = selected
      ? '下一轮 · ' + modelName(models, selected)
      : current
        ? '模型 · ' + modelName(models, current)
        : '模型 · 跟随原生';

    if (reading(snapshot)) {
      const { run } = snapshot;
      const status = el('small', 'muted', modelSetupStatus[run.status] || modelSetupStatus.running);
      status.setAttribute('role', 'status');
      const cancel = canRead(agent) && agent.online && run.status !== 'cancelling'
        ? btn('取消读取', async () => {
          await controls(run, { kind: 'cancel' });
          await actions.refresh();
        }, 'secondary btn-sm') : null;
      return el('div', 'actions', status, cancel);
    }

    if (snapshot.run?.modelSetup && snapshot.run.status === 'uncertain') {
      const status = el('small', 'muted', modelSetupStatus.uncertain);
      status.setAttribute('role', 'status');
      return status;
    }

    if (!models.length) {
      if (!snapshot.task && agent.online && canRead(agent) && finished(snapshot.run)) {
        const retry = snapshot.run?.modelSetup && snapshot.run.status !== 'completed';
        const button = btn(retry ? '重试读取模型' : '读取会话模型', async () => {
          await api(modelPath(snapshot.thread.id), { prepare: true });
          await actions.refresh();
        }, 'secondary');
        if (retry) button.title = previewError(snapshot) || '上次未能读取原生模型';
        return button;
      }
      const status = el('small', 'muted model-caption', title);
      if (!agent.online) status.title = '节点离线，恢复连接后可读取原生模型';
      return status;
    }

    const button = btn('', () => {
      const ui = form('选择下一轮模型', [
        { key: 'modelId', label: '下一轮模型', value: selected || '', options: choicesFor(models) }
      ], '保存', async ({ modelId }) => {
        await api(modelPath(snapshot.thread.id), { modelId: modelId || null });
        await actions.refresh();
      });
      const { hint } = modelField(ui);
      hint.textContent = current
        ? '原生会话当前模型 · ' + modelName(models, current, true)
        : '原生会话尚未报告当前模型。';
    }, 'secondary model-tool');
    button.append(el('span', '', title));
    button.title = selected
      ? title + (current ? '，原生会话当前模型 · ' + modelName(models, current, true) : '')
      : current
        ? '当前模型 · ' + modelName(models, current, true)
        : title;
    button.disabled = !finished(snapshot.run);
    return button;
  }

  const projectOptions = () => [{ id: '', name: '个人话题' }, ...state.projects];

  function newThread(preset) {
    const id = preset || state.instance || 'main';
    const agent = instance(id);
    if (id !== 'main' && agent?.settings && (agent.settings.enabled === false || agent.settings.allowDirect === false)) {
      notice(agent.settings.enabled === false ? '此 Bot 已停用。' : '此 Bot 当前不允许直接聊天。', 'error');
      return;
    }
    let projectId = chatTarget()?.projectId || undefined;
    if (agent?.settings?.allowedProjects) {
      if (!projectId || !agent.settings.allowedProjects.includes(projectId)) {
        if (agent.settings.allowedProjects.length === 1) {
          projectId = agent.settings.allowedProjects[0];
        } else if (agent.settings.allowedProjects.length > 1) {
          projectId = agent.settings.allowedProjects[0];
          notice('此 Bot 仅限指定项目，已切换至其获准项目。');
        } else {
          notice('此 Bot 暂无获准项目，请先在 Bot 设置中配置项目范围。', 'error');
          return;
        }
      }
    }
    actions.openDraft(id, projectId);
  }

  async function readDraftModels(threadId, stillOpen, onStatus) {
    const path = '/threads/' + url(threadId);
    let snapshot = await api(path);
    if (!modelOptions(snapshot).length && finished(snapshot.run) && stillOpen()) {
      try { await api(modelPath(threadId), { prepare: true }); }
      catch (e) {
        snapshot = await api(path);
        if (finished(snapshot.run) && !modelOptions(snapshot).length) throw e;
      }
      snapshot = await api(path);
    }
    while (stillOpen() && reading(snapshot)) {
      onStatus(snapshot);
      await new Promise(resolve => setTimeout(resolve, 500));
      if (stillOpen()) snapshot = await api(path);
    }
    if (!stillOpen()) return snapshot;
    onStatus(snapshot);
    if (snapshot.run?.modelSetup && !['completed', 'cancelled', 'uncertain'].includes(snapshot.run.status)) {
      throw Error(previewError(snapshot) || '节点未能读取原生模型，可以重试。');
    }
    return snapshot;
  }

  function draftModels(ui, originThreadId) {
    const { controls: formControls, save } = ui;
    const { select, hint, action } = modelField(ui);
    const contexts = new Map();
    const contextKey = () => JSON.stringify([formControls.instanceId.value, formControls.projectId.value]);

    function update() {
      const agent = instance(formControls.instanceId.value);
      const key = contextKey();
      const preview = contexts.get(key);
      const models = modelOptions(preview?.snapshot, agent);
      const current = preview?.snapshot?.model?.current;
      const setup = preview?.snapshot?.run?.modelSetup ? preview.snapshot.run : null;
      useModelOptions(select, models);
      save.disabled = !!preview?.reading || setup?.status === 'uncertain';
      hint.textContent = preview?.reading
        ? modelSetupStatus[setup?.status] || '正在提交模型读取…'
        : preview?.error || (
          setup?.status === 'uncertain' || setup?.status === 'cancelled' ? modelSetupStatus[setup.status] : current
            ? '原生会话当前模型 · ' + modelName(models, current, true)
            : !agent?.online
              ? '节点离线，恢复连接后可读取原生模型。'
              : models.length
                ? '选择的模型用于任务首轮。'
                : preview?.snapshot
                  ? '原生会话没有提供可选模型。'
                  : canRead(agent)
                    ? '可以先读取原生模型，再派发任务。'
                    : '原生会话将决定首轮模型。'
        );
      action.replaceChildren();
      if (preview?.reading && setup && ['queued', 'running'].includes(setup.status) && agent?.online) {
        const cancel = btn('取消读取', async () => {
          cancel.disabled = true;
          try { await controls(setup, { kind: 'cancel' }); }
          catch (e) { if (cancel.isConnected) cancel.disabled = false; throw e; }
        }, 'secondary btn-sm');
        action.append(cancel);
      }
      if (setup?.status === 'uncertain' && agent?.online) {
        action.append(btn('查询原生回执', async () => {
          await api('/runs/' + url(setup.id) + '/recovery', { action: 'inspect' });
          notice('已请求核对，查询后可重新读取状态。');
        }, 'secondary btn-sm'));
      }
      if (!models.length && agent?.online && canRead(agent) && !preview?.reading) {
        action.append(btn(preview?.error ? '重试读取会话模型' : '读取会话模型', async () => {
          const [instanceId, projectId] = JSON.parse(key);
          const entry = contexts.get(key) || {};
          contexts.set(key, entry);
          entry.reading = true;
          entry.error = '';
          update();
          try {
            const origin = await originThreadId();
            if (!activeForm(ui)) return;
            entry.thread ??= await api('/tasks/draft', { originThreadId: origin, instanceId, projectId: projectId || undefined });
            entry.snapshot = await readDraftModels(entry.thread.id, () => activeForm(ui), snapshot => {
              const changed = entry.snapshot?.run?.id !== snapshot.run?.id || entry.snapshot?.run?.status !== snapshot.run?.status;
              entry.snapshot = snapshot;
              if (changed && activeForm(ui) && key === contextKey()) update();
            });
          } catch (e) {
            entry.error = e.message;
          } finally {
            entry.reading = false;
            if (activeForm(ui) && key === contextKey()) update();
          }
        }, 'secondary btn-sm'));
      }
    }

    for (const control of [formControls.instanceId, formControls.projectId]) {
      control.addEventListener('change', () => { select.value = ''; update(); });
    }
    update();
    return () => {
      const preview = contexts.get(contextKey());
      return preview?.snapshot && !preview.reading ? preview.thread.id : undefined;
    };
  }

  function delegate() {
    const target = chatTarget();
    if (!target) return;
    const contacts = getWorkBots().filter(b => b.settings?.enabled !== false && b.settings?.allowDelegate !== false);
    if (!contacts.length) {
      notice('暂无可委派的工作 Bot，请先接入或启用工作 Bot。', 'error');
      return;
    }
    const sourceProject = target.projectId || '';
    const unsavedOrigin = !target.id && target.instanceId === 'main' ? target.draft : null;
    let origin = target.id;
    const requestId = unsavedOrigin?.originRequestId || crypto.randomUUID();
    let submission;

    async function originThreadId() {
      if (origin) return origin;
      if (unsavedOrigin?.pendingId) return unsavedOrigin.pendingId;
      if (unsavedOrigin?.origin) return unsavedOrigin.origin;
      if (unsavedOrigin?.sending || unsavedOrigin?.unknownCreate) throw Error('请先处理这条待发送消息。');
      const creating = api('/threads', { instanceId: 'main', projectId: target.projectId || undefined, requestId })
        .then(t => {
          origin = t.id;
          if (unsavedOrigin) unsavedOrigin.pendingId = t.id;
          return t.id;
        });
      if (unsavedOrigin) {
        unsavedOrigin.origin = creating;
        unsavedOrigin.originRequestId = requestId;
      }
      try { return await creating; }
      finally { if (unsavedOrigin?.origin === creating) delete unsavedOrigin.origin; }
    }

    const ui = form('委派任务', [
      { key: 'instanceId', label: '执行者', options: contacts.map(i => ({ id: i.id, name: i.name + (i.online ? '' : '（离线）') })) },
      { key: 'goal', label: '任务目标', type: 'textarea', required: true },
      { key: 'constraints', label: '约束与注意事项' },
      { key: 'doneWhen', label: '交付条件' },
      { key: 'projectId', label: '所属项目', options: projectOptions(), value: sourceProject },
      { key: 'modelId', label: '任务首轮模型', options: [keepNative] }
    ], '派发任务', async data => {
      const workThreadId = preparedThread();
      const originThreadIdValue = await originThreadId();
      const payload = {
        originThreadId: originThreadIdValue,
        workThreadId,
        instanceId: data.instanceId,
        goal: data.goal,
        projectId: data.projectId || undefined,
        modelId: data.modelId || (workThreadId ? null : undefined),
        constraints: data.constraints ? [data.constraints] : [],
        doneWhen: data.doneWhen ? [data.doneWhen] : []
      };
      const signature = JSON.stringify(payload);
      if (submission?.signature !== signature) submission = { signature, id: crypto.randomUUID() };
      await api('/tasks', { ...payload, requestId: submission.id });
      await actions.load({ full: false, threadOwners: ['main', target.instanceId, data.instanceId] });
      if (atTarget(target)) {
        if (unsavedOrigin && drafts.get(target.key) === unsavedOrigin && !unsavedOrigin.sending) {
          drafts.set(originThreadIdValue, unsavedOrigin);
          drafts.delete(target.key);
        }
        await actions.openThread(originThreadIdValue);
      } else actions.renderChrome();
    });

    if (sourceProject) ui.controls.projectId.disabled = true;
    const preparedThread = draftModels(ui, originThreadId);
  }

  async function openTask(id) {
    const revision = state.routeRevision;
    const hash = location.hash;
    const data = await api('/tasks/' + url(id));
    if (revision === state.routeRevision && hash === location.hash) await actions.openThread(data.task.workThreadId);
  }

  async function communication(taskId) {
    const { items } = await api('/tasks/' + url(taskId) + '/communication');
    displayDialog('任务通信', items.length
      ? items.map(item => el('article', 'record',
        el('div', 'record-head',
          el('strong', '', item.communication ? commLabel(item.communication) : '历史记录'),
          el('small', 'muted', at(item.createdAt))
        ),
        el('p', 'text', item.text),
        item.communication?.replyTo ? el('small', 'muted', '回复 · ' + item.communication.replyTo) : null,
        item.refs?.length ? el('small', 'muted', '资料引用 · ' + item.refs.length) : null
      ))
      : [el('p', 'muted', '还没有任务通信。')],
    [btn('关闭', () => $('dialog').close(), 'ghost')]);
  }

  async function editPersona(back) {
    const current = await api('/chat/persona');
    const ui = form('主聊人格', [
      { key: 'text', label: current.source === 'custom' ? '当前使用自定义人格' : '当前使用默认人格', type: 'textarea', value: current.text, required: true }
    ], '保存人格', async ({ text }) => {
      await api('/chat/persona', { text });
      notice('人格将在下一轮生效。');
    }, { back });
    ui.controls.text.maxLength = 4000;
    if (current.source === 'custom') {
      ui.save.before(btn('恢复默认', async () => {
        await api('/chat/persona', { reset: true });
        ui.dialog.close();
        notice('已恢复默认人格。');
      }, 'ghost'));
    }
  }

  async function botSettings(agent) {
    if (!agent || agent.id === 'main') return;
    const current = await api('/instances/' + url(agent.id) + '/settings');
    const selectedProjects = new Set(current.allowedProjects || []);
    let allProjects = current.allowedProjects == null;

    const ui = form('Bot 设置 · ' + (current.name || agent.name), [
      { key: 'name', label: '显示名称', value: current.name ?? agent.name, required: true },
      { key: 'description', label: '擅长与用途', type: 'textarea', value: current.description ?? '' },
      { key: 'enabled', label: 'Bot 状态', options: [{ id: 'true', name: '启用' }, { id: 'false', name: '停用' }], value: String(current.enabled !== false) },
      { key: 'allowDirect', label: '用户可直接聊天', options: [{ id: 'true', name: '允许' }, { id: 'false', name: '禁止' }], value: String(current.allowDirect !== false) },
      { key: 'allowDelegate', label: '小毛球可委派', options: [{ id: 'true', name: '允许' }, { id: 'false', name: '禁止' }], value: String(current.allowDelegate !== false) }
    ], '保存设置', async values => {
      await api('/instances/' + url(agent.id) + '/settings', {
        name: values.name,
        description: values.description,
        enabled: values.enabled === 'true',
        allowDirect: values.allowDirect === 'true',
        allowDelegate: values.allowDelegate === 'true',
        allowedProjects: allProjects ? null : [...selectedProjects]
      });
      await actions.load();
      actions.renderChrome();
      await actions.refresh();
      notice('Bot 设置已保存。');
    });

    if (['codex', 'dsh', 'hermes'].includes(agent.adapterKey)) {
      const usage = el('div', 'muted', '额度未知');
      usage.setAttribute('role', 'status');
      const read = agent.online && agent.capabilities?.usage ? btn('查询原生额度', async () => {
        usage.textContent = '正在查询…';
        try {
          const data = await api('/instances/' + url(agent.id) + '/usage');
          usage.textContent = data.windows.length ? 'Codex App Server · ' + at(data.fetchedAt) : '额度未知';
          for (const window of data.windows) {
            const duration = window.durationMinutes ? window.durationMinutes + ' 分钟窗口' : '窗口长度未知';
            const reset = window.resetsAt ? '，重置 ' + at(window.resetsAt * 1000) : '';
            usage.append(el('div', '', duration + ' · 已用 ' + window.usedPercent + '%' + reset));
          }
        } catch (error) {
          usage.textContent = '额度未知';
          throw error;
        }
      }, 'secondary btn-sm') : null;
      ui.body.prepend(el('div', 'record',
        el('div', 'record-head',
          el('strong', '', agent.online ? '节点在线' : '节点离线'),
          el('span', 'mono muted', agent.workspaceRef || '')
        ),
        agent.lastSeen ? el('small', 'muted', '最近节点心跳 ' + at(agent.lastSeen)) : null,
        usage,
        read
      ));
    }

    const all = el('input');
    all.type = 'checkbox';
    all.checked = allProjects;
    const choices = el('div', 'project-access');
    choices.append(el('label', 'check-field', all, el('span', '', '所有项目（遵循已有项目授权）')));
    const projectInputs = [];
    for (const project of state.projects) {
      const checkbox = el('input');
      checkbox.type = 'checkbox';
      checkbox.value = project.id;
      checkbox.checked = selectedProjects.has(project.id);
      checkbox.addEventListener('change', () => checkbox.checked ? selectedProjects.add(project.id) : selectedProjects.delete(project.id));
      projectInputs.push(checkbox);
      choices.append(el('label', 'check-field', checkbox, el('span', '', project.name)));
    }
    all.addEventListener('change', () => {
      allProjects = all.checked;
      projectInputs.forEach(input => { input.disabled = allProjects; });
    });
    if (allProjects) projectInputs.forEach(input => { input.disabled = true; });
    ui.error.before(choices);
  }

  async function resetContext(thread) {
    const ok = await confirmDialog({
      title: '重置会话上下文',
      body: '从下一条消息开始建立新上下文？历史消息原文和已保存记忆仍可查阅。',
      confirmLabel: '确认重置'
    });
    if (!ok) return;
    await api('/threads/' + url(thread.id) + '/lifecycle', { action: 'reset' });
    await actions.refresh();
    notice('已重置本会话的模型上下文。');
  }

  async function editThreadBudget(thread, back) {
    const path = '/threads/' + url(thread.id) + '/budget';
    const { toolBudget } = await api(path);
    form('会话工具预算', [
      { key: 'softLimit', label: '起始次数（留空继承全局配置）', type: 'number', value: toolBudget?.softLimit },
      { key: 'hardLimit', label: '硬上限（留空继承全局配置）', type: 'number', value: toolBudget?.hardLimit }
    ], '保存', async ({ softLimit, hardLimit }) => {
      const overrides = {};
      if (softLimit) overrides.softLimit = Number(softLimit);
      if (hardLimit) overrides.hardLimit = Number(hardLimit);
      await api(path, { toolBudget: Object.keys(overrides).length ? overrides : null });
      notice('会话工具预算已保存。');
    }, { back });
  }

  async function markNativeInvalid(thread) {
    const ui = form('标记原生绑定失效', [
      { key: 'reason', label: '失效依据（如原生客户端已删除或路径迁移）', type: 'textarea', required: true }
    ], '标记失效', async ({ reason }) => {
      await api('/threads/' + url(thread.id) + '/lifecycle', {
        action: 'markInvalid',
        sessionId: thread.sessionId,
        reason,
        confirm: true
      });
      await actions.load();
      actions.renderChrome();
      await actions.refresh();
      notice('已标记原生绑定失效并归档旧话题。');
    }, {
      submitClass: 'destructive',
      description: '标记后将保留旧聊天记录并阻止向旧原生会话继续发送；随后可一键建立替代话题接续工作。'
    });
    return ui;
  }

  async function replaceNative(thread) {
    const origin = chatTarget();
    const created = await api('/threads/' + url(thread.id) + '/lifecycle', {
      action: 'replaceNative',
      title: (thread.title || '工作话题') + ' · 接续'
    });
    await actions.load();
    if (origin && atTarget(origin)) {
      await actions.openThread(created.id);
      notice('已建立替代话题，发送首条消息时将开启新的原生会话。');
    }
  }

  async function afterDeleteNavigate(deletedThread) {
    const nextActive = state.threads.find(t => t.instanceId === deletedThread.instanceId && t.id !== deletedThread.id);
    if (nextActive) return actions.openThread(nextActive.id);

    if (deletedThread.instanceId !== 'main') {
      const agent = instance(deletedThread.instanceId);
      const canDirect = agent && agent.settings?.enabled !== false && agent.settings?.allowDirect !== false;
      const allowedProjects = agent?.settings?.allowedProjects;
      if (canDirect && (!allowedProjects || allowedProjects.length > 0)) {
        const targetProject = allowedProjects ? allowedProjects[0] : (deletedThread.projectId || undefined);
        return actions.openDraft(deletedThread.instanceId, targetProject);
      }
      if (state.mainThread) return actions.openThread(state.mainThread.id);
    }

    if (state.mainThread) return actions.openThread(state.mainThread.id);
    return actions.openDraft('main');
  }

  function threadMenu(thread) {
    const dialog = $('dialog');
    const actionsList = [];
    const permanent = thread.kind === 'main' || thread.conversationType === 'main';
    const agent = instance(thread.instanceId);
    const backHere = () => threadMenu(thread);

    if (!permanent) {
      actionsList.push(btn('重命名会话', () => form('重命名会话', [
        { key: 'title', label: '会话名称', value: thread.title || '', required: true }
      ], '保存', async ({ title }) => {
        await api('/threads/' + url(thread.id) + '/lifecycle', { action: 'rename', title });
        await actions.load();
        actions.renderChrome();
        await actions.refresh();
      }, { back: backHere }), 'settings-row', 'edit'));
    }

    if (thread.instanceId === 'main' && thread.kind === 'side' && !thread.projectId && thread.state === 'active' && state.mainThread) {
      actionsList.push(btn('设为默认主会话', async () => {
        const origin = chatTarget();
        const previousMainId = state.mainThread.id;
        const ok = await confirmDialog({
          title: '更换固定主会话',
          body: '将「' + (thread.title || '此侧聊') + '」设为新的小毛球主会话？原主会话将保留为侧边会话。',
          confirmLabel: '确认设为主会话'
        });
        if (!ok) return;
        await api('/threads/' + url(thread.id) + '/lifecycle', {
          action: 'setMain',
          previousMainId,
          confirm: true
        });
        await actions.load();
        if (origin && atTarget(origin)) {
          await actions.openThread(thread.id);
          notice('已切换固定主会话。');
        }
      }, 'settings-row', 'yarn'));
    }

    if (!permanent) {
      actionsList.push(btn(thread.state === 'archived' ? '恢复会话' : '归档会话', async () => {
        const result = await api('/threads/' + url(thread.id) + '/lifecycle', {
          action: thread.state === 'archived' ? 'restore' : 'archive'
        });
        dialog.close();
        await actions.load();
        actions.renderChrome();
        await actions.refresh();
        notice(result.scope === 'native_pending' ? '已请求原生端操作，等待回执。' : '会话状态已更新。');
      }, 'settings-row', 'archive'));
    }

    if (thread.sessionId && !thread.nativeInvalid && agent?.capabilities?.nativeActions?.includes('fork')) {
      actionsList.push(btn('从此会话创建原生分支', () => form('创建原生分支', [
        { key: 'title', label: '新会话名称', value: (thread.title || '会话') + ' · 分支', required: true }
      ], '创建分支', async ({ title }) => {
        const origin = chatTarget();
        const branch = await api('/threads/' + url(thread.id) + '/lifecycle', { action: 'fork', title });
        await actions.load();
        if (origin && atTarget(origin)) {
          await actions.openThread(branch.id);
          notice('原生分支创建请求已提交。');
        }
      }, { back: backHere }), 'settings-row', 'branch'));
    }

    if (thread.instanceId !== 'main' && thread.kind === 'native' && thread.sessionId && !thread.nativeInvalid && thread.state === 'active') {
      actionsList.push(btn('标记原生绑定失效', () => markNativeInvalid(thread), 'settings-row', 'warning'));
    }
    if (thread.instanceId !== 'main' && thread.nativeInvalid) {
      actionsList.push(btn('创建替代话题继续', () => {
        dialog.close();
        return replaceNative(thread);
      }, 'settings-row', 'branch'));
    }

    actionsList.push(btn('导出会话 JSON', async () => {
      const result = await api('/threads/' + url(thread.id) + '/export');
      const file = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
      const link = el('a');
      link.href = URL.createObjectURL(file);
      link.download = (thread.title || '会话') + '.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }, 'settings-row', 'external'));

    actionsList.push(btn('分享会话内容', () => shareThread(thread), 'settings-row', 'arrow'));

    if (thread.instanceId === 'main') {
      actionsList.push(btn('重置模型上下文', () => resetContext(thread), 'settings-row', 'refresh'));
      actionsList.push(btn('会话工具预算', () => editThreadBudget(thread, backHere), 'settings-row', 'sliders'));
    }

    if (!permanent && thread.state !== 'deleted') {
      actionsList.push(btn('移至最近删除', async () => {
        const origin = chatTarget();
        const ok = await confirmDialog({
          title: '移至最近删除',
          body: '将「' + (thread.title || '此会话') + '」移入最近删除？可随时在回收站中恢复。',
          confirmLabel: '移至最近删除',
          destructive: true
        });
        if (!ok) return;
        await api('/threads/' + url(thread.id) + '/lifecycle', { action: 'delete' });
        await actions.load();
        actions.renderChrome();
        if (origin && atTarget(origin)) {
          if (origin.id === thread.id) await afterDeleteNavigate(thread);
          notice('已移至最近删除。');
        }
      }, 'settings-row destructive-ghost', 'trash'));
    }

    displayDialog('会话操作', [el('div', 'settings-list', ...actionsList)], [
      btn('关闭', () => dialog.close(), 'ghost')
    ]);
  }

  function shareThread(thread, messageIds) {
    const targets = state.threads.filter(candidate => candidate.id !== thread.id && candidate.state === 'active');
    const agents = state.instances;
    const projectName = id => id ? state.projects.find(project => project.id === id)?.name || '其他项目' : '个人范围';

    const origin = chatTarget();
    const ui = form('分享会话', [
      {
        key: 'targetThreadId',
        label: '分享目标',
        options: [
          { id: '', name: '新建目标会话' },
          ...targets.map(target => ({
            id: target.id,
            name: (instance(target.instanceId)?.name || 'Bot') + ' · ' + (target.title || '会话') + ' · ' + projectName(target.projectId)
          }))
        ]
      },
      { key: 'instanceId', label: '新会话接收 Bot', options: agents.map(agent => ({ id: agent.id, name: agent.name })), value: agents[0]?.id || 'main' },
      { key: 'title', label: '新会话名称', value: '分享：' + (thread.title || '会话') }
    ], '预览内容', async ({ targetThreadId, instanceId, title }) => {
      const destination = targetThreadId
        ? { targetThreadId }
        : { newThread: { instanceId, title: title || '分享：' + (thread.title || '会话') } };
      const selection = messageIds?.length ? { messageIds } : {};
      const preview = await api('/threads/' + url(thread.id) + '/share', { ...destination, preview: true, ...selection });
      if (!activeForm(ui) || !origin || !atTarget(origin)) return;

      const requestId = crypto.randomUUID();
      const review = displayDialog('分享预览', [
        el('p', 'muted', preview.crossProject ? '跨项目分享 · 仅包含已授权的用户原文和附件' : '将分享 ' + (preview.items?.length || 0) + ' 条消息。'),
        ...(preview.items || []).map(item => el('article', 'record',
          el('small', 'muted', (item.role || '') + ' · ' + at(item.createdAt)),
          el('p', 'text', item.text || ''),
          item.attachments?.length ? el('small', 'muted', '附件 · ' + item.attachments.map(file => file.name).join('、')) : null
        ))
      ], [
        btn('返回', () => shareThread(thread, messageIds), 'ghost'),
        btn(preview.crossProject ? '确认跨项目分享' : '确认分享', async () => {
          if (!atTarget(origin)) return;
          await api('/threads/' + url(thread.id) + '/share', {
            ...destination,
            ...selection,
            requestId,
            ...(preview.crossProject ? { confirmCrossProject: true } : {})
          });
          if (review.dialog.contains(review.body)) review.dialog.close();
          if (atTarget(origin)) for (const id of messageIds || []) selectedMessages.delete(id);
          await actions.load();
          actions.renderChrome();
          await actions.refresh();
          if (atTarget(origin)) notice('会话内容已分享。');
        }, 'primary')
      ]);
    });
  }

  function runBox(snapshot) {
    const { task, run, review, commands = [] } = snapshot;
    if (!task && (!run || (run.modelSetup && run.status !== 'uncertain'))) return null;

    const root = el('div');
    const actionsBox = el('div', 'actions');
    if (task) actionsBox.append(btn('任务通信', () => communication(task.id), 'secondary btn-sm'));
    if (task?.brief?.coordination) {
      actionsBox.append(btn('协调设置', () => {
        const scope = task.brief.coordination;
        const modes = [{ id: 'off', name: '关闭' }, { id: 'notify', name: '仅通知' }, { id: 'assist', name: '使用项目事实答复' }];
        if (task.projectId && !scope.parentTaskId) modes.push({ id: 'handoff', name: '允许同项目转派' });
        form('任务协调', [
          { key: 'coordination', label: '协调方式', value: scope.mode, options: modes },
          ...(task.projectId && !scope.parentTaskId ? [{ key: 'targets', label: '允许转派的实例 ID，用逗号分隔', value: scope.targets.join(', ') }] : []),
          { key: 'status', label: '运行状态', value: scope.paused ? 'pause' : 'resume', options: [{ id: 'resume', name: '允许协调' }, { id: 'pause', name: '暂停协调' }] }
        ], '保存', async ({ coordination, targets, status }) => {
          await api('/tasks/' + url(task.id) + '/coordination', {
            coordination,
            handoffTargets: targets ? targets.split(',').map(id => id.trim()).filter(Boolean) : [],
            paused: status === 'pause'
          });
          await actions.refresh();
        });
      }, 'secondary btn-sm'));
    }

    const assignee = instance(snapshot.thread.instanceId);
    const criteria = task?.brief?.doneWhen;
    if (run?.status === 'completed' && Array.isArray(criteria) && criteria.length) {
      actionsBox.append(btn('核对交付', () => {
        const fields = criteria.flatMap((criterion, i) => [
          { key: 'result' + i, label: criterion, options: [{ id: '', name: '请选择核对结果' }, { id: 'yes', name: '已满足' }, { id: 'no', name: '尚缺' }], required: true },
          { key: 'detail' + i, label: '第 ' + (i + 1) + ' 项的证据或缺项', type: 'textarea', required: true }
        ]);
        form('核对交付', fields, '保存核对结果', async values => {
          const checks = criteria.map((criterion, i) => ({
            criterion,
            met: values['result' + i] === 'yes',
            evidence: values['detail' + i]
          }));
          await api('/tasks/' + url(task.id) + '/review', { runId: run.id, checks });
          await actions.refresh();
        });
      }, 'secondary btn-sm', 'task'));
    }

    if (run && !run.modelSetup && ['queued', 'running', 'waiting_input', 'uncertain'].includes(run.status) && assignee?.availableActions?.includes('cancel')) {
      actionsBox.append(btn('停止运行', async () => {
        await controls(run, { kind: 'cancel' });
        await actions.refresh();
      }, 'destructive-ghost btn-sm'));
    }

    const status = run && ['cancelling', 'waiting_input', 'uncertain'].includes(run.status) ? run.status : (task?.status || run?.status);
    const statusText = status === 'completed' && review?.status === 'completed' ? '验收通过' : phase(status);
    const detail = [run?.status === 'completed' && statusText !== '执行结束' ? '执行结束' : null, snapshot.submittedArtifacts ? '成果已提交' : null].filter(Boolean);
    const toneCls = status === 'waiting_input' || status === 'uncertain'
      ? 'tone-question'
      : ['running', 'queued', 'cancelling'].includes(status)
        ? 'tone-working'
        : ['failed', 'blocked'].includes(status)
          ? 'tone-error'
          : 'tone-success';

    const card = el('div', 'status-card ' + toneCls,
      el('div', 'status-card-head',
        el('span', 'status-card-title',
          el('i', 'dot ' + (['running', 'queued'].includes(status) ? 'working' : status === 'waiting_input' ? 'question' : status === 'completed' || status === 'verified' ? 'live' : '')),
          [...detail, statusText].join(' · ')
        ),
        actionsBox
      )
    );

    if (review) {
      card.append(el('div', 'record',
        el('strong', '', '所有者验收 · ' + at(review.at)),
        ...review.checks.map(c => el('p', 'text', (c.met ? '已满足' : '待补齐') + ' · ' + c.criterion + ' · ' + c.evidence))
      ));
    }

    if (status === 'uncertain') {
      const endpoint = '/runs/' + url(run.id) + '/recovery';
      card.append(
        el('p', 'muted', '原生运行结果待核对。放弃只解锁工作台，原生运行可能仍在执行。'),
        el('div', 'actions',
          btn('查询原生回执', async () => {
            await api(endpoint, { action: 'inspect' });
            await actions.refresh();
            notice('已请求核对，节点回执将显示在工作话题。');
          }, 'secondary btn-sm'),
          btn('放弃等待', () => form('放弃等待原运行', [
            { key: 'reason', label: '放弃原因', required: true },
            {
              key: 'confirm',
              label: '原生运行可能仍在执行',
              options: [{ id: '', name: '保留待核对' }, { id: 'yes', name: '理解风险，停止等待' }],
              required: true
            }
          ], '确认放弃', async d => {
            await api(endpoint, { action: 'abandon', acknowledge: d.confirm === 'yes', reason: d.reason });
            await actions.refresh();
          }, { submitClass: 'destructive' }), 'ghost btn-sm'),
          hasDesktopSettings() ? btn('检查连接', () => desktopSettings(actions.onSettingsChanged), 'ghost btn-sm') : null
        )
      );
    }

    const issue = commands.filter(c => c.runId === run?.id && ['failed', 'uncertain'].includes(c.status) && c.detail).at(-1);
    if (issue) card.append(el('p', 'muted', issue.detail));

    root.append(card);

    const request = run?.pendingRequest;
    if (request && run.status === 'waiting_input') {
      const options = el('div', 'actions');
      for (const opt of request.options || []) {
        const key = typeof opt === 'string' ? opt : (opt.id || opt.value || opt.optionId);
        if (!key) continue;
        options.append(btn(typeof opt === 'string' ? opt : (opt.label || opt.name || key), async () => {
          await controls(run, { kind: 'answer', nativeRequestId: request.requestId, choice: key });
          await actions.refresh();
        }, 'primary btn-sm'));
      }
      root.append(el('div', 'pending-card tone-question',
        el('div', 'status-card-title', '等待你的回应'),
        el('p', 'text', request.text || request.question || ''),
        options
      ));
    }

    for (const cmd of commands.filter(c => ['waiting', 'held'].includes(c.status))) {
      const original = cmd.payload?.inputText ?? cmd.payload?.text ?? '';
      const commandRun = { id: cmd.runId };
      const resume = cmd.status === 'held' && finished(run) ? btn('继续发送', async () => {
        const risk = run?.recovery?.action === 'abandon';
        if (risk) {
          const ok = await confirmDialog({
            title: '确认继续发送',
            body: '原生运行可能仍在后台执行，确认在当前会话继续发送挂起输入？',
            confirmLabel: '继续发送'
          });
          if (!ok) return;
        }
        await controls(commandRun, { kind: 'resume', commandId: cmd.id, acknowledge: risk });
        await actions.refresh();
      }, 'secondary btn-sm') : null;
      root.append(el('div', 'pending-card tone-working',
        el('div', 'status-card-title', phase(cmd.status)),
        el('p', 'text', original),
        el('div', 'actions',
          resume,
          btn('编辑', () => form('编辑待发输入', [
            { key: 'text', label: '内容', value: original, type: 'textarea', required: true }
          ], '保存', async ({ text }) => {
            await controls(commandRun, { kind: 'edit', commandId: cmd.id, text });
            await actions.refresh();
          }), 'ghost btn-sm'),
          btn('撤回', async () => {
            await controls(commandRun, { kind: 'withdraw', commandId: cmd.id });
            await actions.refresh();
          }, 'ghost btn-sm')
        )
      ));
    }

    return root;
  }

  function chatSettings(thread) {
    const backHere = () => chatSettings(thread);
    const entries = [
      ['主聊模型与接口', 'chat', () => mainModels(actions.refresh, actions.load, backHere), '切换大模型或注册 API Bot'],
      ['主聊工具权限', 'shield', () => mainPermissions(backHere), '目录读写与自动授权策略'],
      ['主聊人格设定', 'edit', () => editPersona(backHere), '自定义小毛球回复风格'],
      ['插件与 Skill', 'layers', () => extensions(backHere), '网页搜索、扩展与业务 API'],
      ...(thread ? [
        ['记忆候选', 'file', () => memories(tOrThreadId(thread), backHere), '审阅并保存长期记忆'],
        ['事项与提醒', 'clock', () => daily(tOrThreadId(thread), backHere), '管理待办与定时提醒']
      ] : [])
    ];

    displayDialog('对话设置', [
      el('div', 'settings-list', ...entries.map(([label, symbol, run, desc]) => {
        const b = btn('', run, 'settings-row', symbol);
        b.append(el('span', '', label), desc ? el('span', 'settings-desc', desc) : null);
        return b;
      }))
    ], [btn('关闭', () => $('dialog').close(), 'ghost')]);
  }

  function tOrThreadId(t) {
    return typeof t === 'string' ? t : t.id;
  }

  function drawBanner(t) {
    const bar = $('status-banner');
    if (!bar) return;
    if (state.view !== 'chat') {
      bar.hidden = true;
      bar.replaceChildren();
      return;
    }

    if (t && selectedMessages.size > 0) {
      bar.hidden = false;
      bar.className = 'banner-info';
      bar.replaceChildren(
        el('div', 'banner-text', icon('check'), el('span', '', '已选择 ' + selectedMessages.size + ' 条消息用于分享')),
        el('div', 'actions',
          btn('分享所选', () => shareThread(t, [...selectedMessages]), 'primary btn-sm', 'arrow'),
          btn('取消选择', () => { selectedMessages.clear(); drawContent(); }, 'ghost btn-sm')
        )
      );
      return;
    }

    if (t?.nativeInvalid) {
      bar.hidden = false;
      bar.className = 'banner-warn';
      bar.replaceChildren(
        el('div', 'banner-text', icon('warning'), el('span', '', '原生会话绑定失效：' + t.nativeInvalid)),
        el('div', 'actions',
          btn('创建替代话题继续', () => replaceNative(t), 'primary btn-sm', 'branch')
        )
      );
      return;
    }

    if (t?.state === 'archived') {
      bar.hidden = false;
      bar.className = '';
      bar.replaceChildren(
        el('div', 'banner-text', icon('archive'), el('span', '', t.nativeArchived ? '此会话在原生端与工作台均已归档' : '此会话已归档，恢复后可继续发送')),
        el('div', 'actions',
          btn('恢复会话', async () => {
            await api('/threads/' + url(t.id) + '/lifecycle', { action: 'restore' });
            await actions.load();
            actions.renderChrome();
            await actions.refresh();
            notice('会话已恢复。');
          }, 'secondary btn-sm', 'refresh')
        )
      );
      return;
    }

    bar.hidden = true;
    bar.className = '';
    bar.replaceChildren();
  }

  function drawWelcome(ctx, agent) {
    if (ctx.isMain) {
      const quick = el('div', 'quick-grid',
        btn('', () => newThread('main'), 'quick-card', ''),
        btn('', () => delegate(), 'quick-card', ''),
        btn('', () => actions.openHome(), 'quick-card', '')
      );
      quick.children[0].append(
        el('div', 'quick-card-head', icon('plus'), el('span', '', '新建侧边会话')),
        el('small', '', '围绕特定议题开启独立讨论，不混杂主会话上下文。')
      );
      quick.children[1].append(
        el('div', 'quick-card-head', icon('task'), el('span', '', '委派给工作 Bot')),
        el('small', '', '指派工作 Bot 并跟踪通信与交付。')
      );
      quick.children[2].append(
        el('div', 'quick-card-head', icon('folder'), el('span', '', '打开毛球之家')),
        el('small', '', '查看项目简报、空间资料、工作区绑定与交接记录。')
      );
      return el('div', 'chat-start',
        banner('今天想一起', '做什么？'),
        quick,
        agent?.capabilities?.error ? el('p', 'form-err', agent.capabilities.error) : null
      );
    }

    const caps = agent?.capabilities || {};
    const statusLabel = agent?.settings?.enabled === false ? '已停用' : agent?.online ? '在线 · 就绪' : '离线';
    return el('div', 'chat-start',
      el('div', 'bot-welcome-card',
        el('div', 'bot-welcome-head',
          el('div', 'bot-welcome-title',
            el('div', 'bot-welcome-icon', icon('bot')),
            el('div', '',
              el('h2', '', agent?.name || '工作 Bot'),
              el('small', 'muted', agent?.settings?.description || '发送首条消息以建立工作台话题与原生会话。')
            )
          ),
          el('span', 'badge ' + (agent?.online && agent?.settings?.enabled !== false ? 'online' : ''), statusLabel)
        ),
        el('div', 'bot-meta-grid',
          el('div', 'bot-meta-cell', el('small', '', '适配器'), el('span', 'mono', agent?.adapterKey || '未知')),
          agent?.workspaceRef ? el('div', 'bot-meta-cell', el('small', '', '工作区'), el('span', 'mono', agent.workspaceRef)) : null,
          el('div', 'bot-meta-cell', el('small', '', '原生能力'), el('span', '', [
            caps.sessionList ? '目录' : null,
            caps.nativeHistory ? '历史' : null,
            caps.usage ? '额度' : null
          ].filter(Boolean).join(' · ') || '工作台会话'))
        ),
        el('div', 'actions',
          caps.sessionList ? btn('从原生目录导入会话', () => actions.nativeCatalog(agent), 'secondary btn-sm', 'folderOpen') : null,
          btn('Bot 设置', () => botSettings(agent), 'ghost btn-sm', 'sliders'),
          !agent?.online && hasDesktopSettings() ? btn('检查节点连接', () => desktopSettings(actions.onSettingsChanged), 'secondary btn-sm', 'terminal') : null
        )
      ),
      agent?.capabilities?.error ? el('p', 'form-err', agent.capabilities.error) : null
    );
  }

  function drawContent() {
    const ctx = resolveActiveContext();
    const snap = state.snapshot;
    const content = $('content');
    const prev = content.scrollTop;
    const nearBottom = content.scrollHeight - content.clientHeight - prev < 60;
    const isNew = content.dataset.topic !== draftKey();
    content.dataset.topic = draftKey();

    const t = snap?.thread;
    const agent = instance(t?.instanceId || ctx.instanceId) || ctx.agent;
    if (selectionThreadId !== (t?.id ?? null)) {
      selectedMessages.clear();
      selectionThreadId = t?.id ?? null;
    }

    const sourceLabels = {
      identity: '固定主会话', migrated: '迁移主会话', owner_selected: '主会话',
      direct: '用户直聊', delegated: '任务委派', imported: '原生导入', local: '工作台会话'
    };
    const syncStatus = t?.nativeInvalid ? '原生绑定失效'
      : t?.nativeArchived ? '原生端已归档'
        : t?.sessionId ? (agent?.online ? (agent.capabilities?.nativeHistory ? '原生历史可读取' : '工作台缓存') : '离线缓存') : null;

    const crumb = $('crumb');
    if (crumb) {
      crumb.hidden = false;
      crumb.className = 'crumb' + (ctx.isMain ? ' main-crumb' : '');
      crumb.textContent = ctx.isMain ? '小毛球' : (agent?.name || '工作 Bot');
    }

    $('heading').textContent = t?.title || (ctx.isMain ? '新侧边会话' : '新工作话题');
    const projectObj = (t?.projectId || (!t && state.project)) ? state.projects.find(p => p.id === (t?.projectId || state.project)) : null;
    $('subhead').textContent = [
      projectObj?.name || (t ? '个人范围' : null),
      t?.source && sourceLabels[t.source],
      syncStatus,
      snap?.mainChat?.model,
      agent && agent.id !== 'main' ? (agent.online ? '节点在线' : '节点离线') : null
    ].filter(Boolean).join(' · ');

    const modelBtn = modelPicker(snap, agent);
    const toolButtons = ctx.isMain
      ? [
        btn('委派任务', delegate, 'secondary', 'task'),
        btn('设置', () => chatSettings(t), 'secondary', 'sliders')
      ]
      : (modelBtn ? [modelBtn] : []);
    if (agent && agent.id !== 'main') {
      toolButtons.push(btn('Bot 设置', () => botSettings(agent), 'secondary', 'sliders'));
    }
    if (t) {
      toolButtons.push(btn('会话操作', () => threadMenu(t), 'ghost', 'more'));
    }
    $('tools').replaceChildren(...toolButtons);

    drawBanner(t);

    if (!t?.sessionId && !snap?.messages?.length && !snap?.task && (!snap?.run || (snap.run.modelSetup && snap.run.status !== 'uncertain'))) {
      content.replaceChildren(drawWelcome(ctx, agent));
      return;
    }

    const stream = el('div', 'stream');
    const box = runBox(snap);
    if (agent?.capabilities?.error) stream.append(el('p', 'form-err', agent.capabilities.error));
    if (box) stream.append(box);
    if (snap.nextBefore) stream.append(btn('加载更早消息', actions.loadOlder, 'secondary btn-sm'));

    for (const m of snap.messages || []) {
      const comm = m.data?.communication;
      const role = comm ? actorLabel(comm.sender) : m.role === 'user' ? '你' : m.role === 'assistant' ? (agent?.name || '小毛球') : ({ activity: '原生活动', artifact: '成果', input_required: '请求回应' }[m.kind] || '工作台');
      const isSelected = selectedMessages.has(m.id);
      const article = el('article', 'msg' + (m.role === 'user' ? ' user' : '') + (isSelected ? ' selected' : ''));
      article.append(el('div', 'msg-meta', el('span', '', role), el('small', '', at(m.createdAt))));

      if (m.text) {
        if (m.kind === 'activity') {
          article.append(el('div', 'activity text', m.text));
        } else {
          article.append(renderMarkdown(m.text));
        }
      }

      if (m.data?.webReferences?.length || m.data?.webResult) {
        const web = m.data.webResult;
        const refs = m.data.webReferences ?? web.references ?? [];
        const sources = el('details', 'fold-card', el('summary', '', '网页来源 · ' + refs.length));
        if (web?.query) sources.append(el('p', 'muted', web.query + ' · ' + web.provider + ' · ' + web.elapsedMs + ' ms'));
        if (web?.body) sources.append(el('p', 'text', web.body));
        for (const item of refs) {
          try {
            const target = new URL(item.url);
            if (!['https:', 'http:'].includes(target.protocol)) continue;
            const link = el('a', '', item.title || target.hostname);
            link.href = target.href;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            sources.append(el('p', 'muted', link, ' · ' + at(item.retrievedAt)));
          } catch {}
        }
        article.append(sources);
      }

      if (m.data?.usedMemories?.length) {
        article.append(el('details', 'fold-card',
          el('summary', '', '引用记忆 · ' + m.data.usedMemories.length),
          ...m.data.usedMemories.map(memory => el('p', 'muted', (memory.projectId ? '项目' : '个人') + ' · 版本 ' + memory.revision + ' · ' + memory.id))
        ));
      }

      const check = m.data?.deliveryCheck;
      if (check) {
        article.append(el('details', 'fold-card',
          el('summary', '', '查看交付核对依据'),
          el('p', 'muted', '运行 ' + (check.runStatus || '无') + ' · ' + check.reportIds.length + ' 条交付回执'),
          ...check.files.map(f => el('p', 'muted', (f.status === 'readable' ? '可读 · ' : '待核对 · ') + f.path + (f.bytes !== undefined ? ' · ' + f.bytes + ' 字节' : ''))),
          ...check.materials.map(a => el('p', 'muted', (a.status === 'available' ? '可访问 · ' : '待核对 · ') + (a.title || a.id))),
          ...check.criteria.map(criterion => el('p', 'muted', '验收条件 · ' + criterion))
        ));
      }

      if (m.taskId && m.taskId !== t?.taskId) {
        const task = snap.linkedTasks?.[m.taskId];
        const status = phase(task?.status || m.data?.status);
        const taskBtn = btn('查看工作话题', () => openTask(m.taskId), 'task-card', 'task');
        if (status) taskBtn.append(el('span', 'badge', status));
        article.append(taskBtn);
      }

      if (m.kind === 'tool' && m.data?.workThreadId) {
        article.append(btn('打开工作话题', () => actions.openThread(m.data.workThreadId), 'task-card', 'task'));
      }

      if (m.data?.communicationId && m.data?.workThreadId && comm?.type === 'clarification_notice') {
        article.append(btn('回复工作 Bot', () => form('回复工作 Bot', [
          { key: 'text', label: '你的原话', type: 'textarea', required: true }
        ], '发送', async ({ text }) => {
          await api('/threads/' + url(m.data.workThreadId) + '/messages', { text, replyTo: m.data.communicationId });
          await actions.refresh();
        }), 'secondary btn-sm'));
      }

      if (m.refs?.length) {
        article.append(el('div', 'reference-list',
          ...m.refs.filter(ref => ref.type !== 'attachment').map(ref =>
            el('span', 'ref-pill', (referenceTypes[ref.type] || '引用') + ' · ' + (ref.title || ref.text || ref.id).slice(0, 70))
          )
        ));
      }

      for (const id of m.data?.attachmentIds || []) {
        article.append(btn('下载附件', () => download(id), 'secondary btn-xs', 'file'));
      }

      if (m.text && ['message', 'artifact'].includes(m.kind)) {
        const tools = el('div', 'message-tools',
          btn('复制', () => copyText(m.text, '消息内容已复制'), 'ghost'),
          btn('引用', () => {
            const d = currentDraft();
            if (!d.refs.some(r => r.id === m.id)) d.refs.push({ type: 'message', id: m.id, excerpt: m.text.slice(0, 26) });
            $('compose').dataset.key = '';
            drawComposer();
            $('input')?.focus();
          }, 'ghost'),
          btn(isSelected ? '取消分享选中' : '选择分享', () => {
            if (selectedMessages.has(m.id)) selectedMessages.delete(m.id);
            else selectedMessages.add(m.id);
            drawContent();
          }, 'ghost'),
          btn('归档到资料', () => form('保存这段原话', [
            { key: 'title', label: '资料标题', value: m.text.slice(0, 40), required: true },
            { key: 'projectId', label: '保存位置', options: [{ id: '', name: '个人资料' }, ...state.projects], value: t?.projectId || '' }
          ], '保存', async d => {
            await api('/submissions', {
              projectId: d.projectId || undefined,
              source: { title: d.title, text: m.text, author: role, platform: '小毛球 Bot 工作台', attachmentIds: m.data?.attachmentIds || [] }
            });
            notice('原话已归档。');
          }), 'ghost')
        );
        if (t?.instanceId === 'main' && m.kind === 'message') {
          tools.append(btn('删除', async () => {
            const ok = await confirmDialog({
              title: '删除消息',
              body: '确认删除这条消息？独立分享的副本仍保留。',
              confirmLabel: '删除消息',
              destructive: true
            });
            if (!ok) return;
            await api('/threads/' + url(t.id) + '/lifecycle', { action: 'deleteMessage', messageId: m.id });
            selectedMessages.delete(m.id);
            await actions.refresh();
          }, 'destructive-ghost'));
        }
        article.append(tools);
      }

      if (comm?.visibility === 'bot_internal' || m.kind === 'tool') {
        const detail = el('details', 'fold-card', el('summary', '', comm ? commLabel(comm) : role), article);
        detail.open = expandedMessages.has(m.id);
        detail.ontoggle = () => {
          if (detail.open) expandedMessages.add(m.id);
          else expandedMessages.delete(m.id);
        };
        stream.append(detail);
      } else {
        stream.append(article);
      }
    }

    for (const job of snap.mainChat?.pending || []) {
      if (job.proposal) {
        const resolve = async approved => {
          await api('/chat/approve', { messageId: job.messageId, approvalId: job.proposal.id, approved });
          await actions.refresh();
        };
        const { tool, arguments: args, expires } = job.proposal;
        const pluginAuthorizationRequired = tool === 'plugin_activate' ||
          tool === 'plugin_switch' && args.action === 'rollback';
        const approvePlugin = async () => {
          const state = await api('/chat/plugins');
          const plugin = state.plugins.find(item => item.id === args.id);
          const version = tool === 'plugin_switch' ? 'previous' :
            plugin?.pending?.digest === args.digest ? 'candidate' : 'current';
          const review = await api('/chat/plugins', { action: 'review', id: args.id, version });
          if (review.digest !== args.digest) throw Error('待确认版本已改变，请重新发起操作');
          const manifest = review.manifest;
          const hasCode = Boolean(manifest.entry && review.source !== 'bundled');
          const hasNetwork = manifest.capabilities.some(capability => capability.startsWith('network.'));
          const trust = el('input');
          trust.type = 'checkbox';
          const network = el('input');
          network.type = 'checkbox';
          const authorize = await new Promise(resolveAuthorization => {
            const changedFiles = review.files.map(file => el('details', 'fold-card',
              el('summary', '', file.path),
              file.before ? el('div', 'muted', el('strong', '', '之前'), el('pre', 'text', file.before)) : null,
              file.after ? el('div', '', el('strong', '', '新版本'), el('pre', 'text', file.after)) : null));
            const permissions = [
              hasCode ? el('label', 'field', trust, el('span', 'field-label', '我已审查这些文件，并授权该摘要版本在工作台宿主进程中执行代码')) : null,
              hasNetwork ? el('label', 'field', network, el('span', 'field-label', '我授权该版本使用清单声明的网络能力')) : null
            ];
            const accept = btn('确认授权并执行', () => {
              if (hasCode && !trust.checked || hasNetwork && !network.checked) {
                notice('请分别勾选需要授予的权限');
                return;
              }
              $('dialog').close();
              resolveAuthorization({ digest: review.digest, trustCode: trust.checked, allowNetwork: network.checked });
            }, 'primary');
            const reject = btn('取消', () => {
              $('dialog').close();
              resolveAuthorization(null);
            }, 'ghost');
            displayDialog('审查插件授权', [
              el('small', 'muted', manifest.name + ' · ' + manifest.version + ' · ' + review.source),
              el('p', 'text', manifest.description),
              el('p', 'muted', 'SHA-256 · ' + review.digest),
              el('p', 'muted', '声明能力 · ' + manifest.capabilities.join('、')),
              review.addedCapabilities.length ? el('p', 'muted', '相对当前版本新增 · ' + review.addedCapabilities.join('、')) : null,
              hasCode ? el('p', 'form-err', '可执行 JavaScript 会继承工作台宿主进程的本机权限。静态检查不能证明代码安全。') : null,
              hasNetwork ? el('p', 'muted', '网络能力允许插件向其实现或配置的网络服务发送请求。') : null,
              ...permissions,
              ...changedFiles
            ], [reject, accept], { wide: true });
          });
          if (!authorize) return;
          await api('/chat/approve', {
            messageId: job.messageId, approvalId: job.proposal.id, approved: true,
            pluginAuthorization: authorize
          });
          await actions.refresh();
        };
        stream.append(el('article', 'pending-card tone-question',
          el('div', 'status-card-title', '请确认操作 · ' + tool),
          el('pre', 'text', JSON.stringify(args, null, 2)),
          el('small', 'muted', '有效至 ' + at(expires)),
          el('div', 'actions', btn('确认执行', () => pluginAuthorizationRequired ? approvePlugin() : resolve(true), 'primary btn-sm'), btn('拒绝', () => resolve(false), 'ghost btn-sm'))
        ));
        continue;
      }
      if (job.status === 'budget_paused') {
        const budget = job.budget || {};
        const continueJob = async hardLimit => {
          await api('/chat/continue', { messageId: job.messageId, ...(hardLimit ? { hardLimit } : {}) });
          await actions.refresh();
        };
        const increase = async () => {
          const policy = await api('/chat/policy');
          if (budget.hardLimit >= policy.toolHardLimit) {
            await mainPermissions();
            notice('全局硬上限尚未高于本轮上限，请调整后继续。');
            return;
          }
          const ui = form('提高本轮工具上限', [
            { key: 'hardLimit', label: '新的本轮硬上限', type: 'number', value: Math.min(policy.toolHardLimit, budget.hardLimit + 10), required: true }
          ], '继续', async ({ hardLimit }) => continueJob(Number(hardLimit)));
          ui.controls.hardLimit.min = String(budget.hardLimit + 1);
          ui.controls.hardLimit.max = String(policy.toolHardLimit);
        };
        stream.append(el('div', 'pending-card tone-question',
          el('div', 'status-card-title', '本轮已暂停'),
          el('p', 'text', '工具调用 ' + budget.used + ' / ' + budget.softLimit + '，本轮硬上限 ' + budget.hardLimit + '。已完成的操作和回执已保存。'),
          el('div', 'actions', btn('继续本轮', () => continueJob(), 'primary btn-sm'), btn('调整本轮上限', increase, 'secondary btn-sm'))
        ));
        continue;
      }
      stream.append(el('div', 'pending-card tone-working',
        el('div', 'status-card-head',
          el('span', 'status-card-title', el('i', 'dot working'), job.status === 'queued' ? '主聊等待处理…' : '小毛球正在回复…'),
          btn('取消生成', async () => {
            await api('/chat/cancel', { messageId: job.messageId });
            await actions.refresh();
          }, 'ghost btn-sm')
        )
      ));
    }

    const activePreview = previewEvent?.threadId === t?.id && snap.mainChat?.pending?.some(job =>
      job.messageId === previewEvent?.messageId && ['queued', 'working'].includes(job.status));
    if (!activePreview) previewEvent = null;
    const previewNode = el('div', 'msg text', activePreview ? previewEvent.text : '');
    previewNode.id = 'chat-preview';
    previewNode.hidden = !activePreview;
    stream.append(previewNode);

    content.replaceChildren(stream);
    content.scrollTop = (nearBottom || isNew) ? content.scrollHeight : prev;
  }

  function buildScopeOptions(contact) {
    const allowed = contact?.settings?.allowedProjects;
    if (Array.isArray(allowed)) {
      return allowed
        .map(pid => state.projects.find(p => p.id === pid))
        .filter(Boolean)
        .map(p => ({ id: p.id, name: '项目 · ' + p.name }));
    }
    return [{ id: '', name: '个人范围' }, ...state.projects.map(p => ({ id: p.id, name: '项目 · ' + p.name }))];
  }

  function drawComposer() {
    const target = chatTarget();
    if (!target) {
      $('compose').replaceChildren();
      return;
    }
    const t = state.snapshot?.thread;
    const ctx = resolveActiveContext();
    const contact = instance(target.instanceId);
    const scopes = target.id ? [] : buildScopeOptions(contact);
    const key = JSON.stringify([target.key, target.revision, t?.state, t?.nativeInvalid, contact?.settings?.enabled,
      contact?.settings?.allowDirect, scopes]);
    if ($('compose').dataset.key === key && $('input')) return;

    $('compose').dataset.key = key;

    if (t?.state === 'archived') {
      $('compose').replaceChildren(el('div', 'compose-disabled',
        el('span', '', '会话已归档，恢复后可继续输入。'),
        btn('恢复会话', async () => {
          await api('/threads/' + url(t.id) + '/lifecycle', { action: 'restore' });
          await actions.load();
          actions.renderChrome();
          await actions.refresh();
        }, 'secondary btn-sm', 'refresh')
      ));
      return;
    }

    if (t?.nativeInvalid) {
      $('compose').replaceChildren(el('div', 'compose-disabled',
        el('span', '', '原生会话绑定已失效，请创建替代话题以继续工作。'),
        btn('创建替代话题', () => replaceNative(t), 'primary btn-sm', 'branch')
      ));
      return;
    }

    if (contact && contact.id !== 'main' && contact.settings && (contact.settings.enabled === false || contact.settings.allowDirect === false)) {
      $('compose').replaceChildren(el('div', 'compose-disabled',
        el('span', '', contact.settings.enabled === false ? '此 Bot 已停用，无法发送新消息。' : '此 Bot 当前不允许直接聊天。'),
        btn('打开 Bot 设置', () => botSettings(contact), 'secondary btn-sm', 'sliders')
      ));
      return;
    }

    const { draft } = target;
    let draftBar = null;
    let permitted = true;
    if (!t && state.draft) {
      const options = scopes;
      if (!options.length) {
        $('compose').replaceChildren(el('div', 'compose-disabled',
          el('span', '', '此 Bot 暂无获准项目范围，请先在 Bot 设置中授权。'),
          btn('打开 Bot 设置', () => botSettings(contact), 'secondary btn-sm', 'sliders')
        ));
        return;
      }
      const scopeSelect = el('select', '', ...options.map(o => Object.assign(el('option', '', o.name), { value: o.id })));
      scopeSelect.setAttribute('aria-label', '新话题所属范围');
      permitted = options.some(o => o.id === (target.projectId || ''));
      if (!permitted) scopeSelect.prepend(Object.assign(el('option', '', '请选择获准范围'), { value: '', disabled: true }));
      scopeSelect.selectedIndex = permitted ? options.findIndex(o => o.id === (target.projectId || '')) : 0;
      scopeSelect.onchange = () => {
        if (atTarget(target)) void actions.openDraft(target.instanceId, scopeSelect.value || undefined);
      };
      draftBar = el('div', 'draft-bar',
        el('span', '', ctx.isMain ? '新侧边会话草稿 · 首次发送时创建' : (contact?.name || '工作 Bot') + ' 新话题草稿 · 首次发送时创建'),
        el('label', 'inline', el('span', '', '范围'), scopeSelect)
      );
    }

    const input = el('textarea');
    input.id = 'input';
    input.rows = 1;
    input.value = draft.text;
    input.placeholder = ctx.isMain ? '给小毛球发消息…' : '给 ' + (contact?.name || '工作 Bot') + ' 下达指令或补充要求…';
    input.setAttribute('aria-label', '消息内容');

    const files = el('div', 'chips');
    const picker = el('input');
    picker.type = 'file';
    picker.multiple = true;
    picker.hidden = true;

    const renderFiles = () => files.replaceChildren(
      ...draft.refs.map((r, i) => btn('引用 · ' + r.excerpt + ' ×', () => { draft.refs.splice(i, 1); renderFiles(); }, 'chip')),
      ...draft.files.map((f, i) => btn(f.name + ' ×', () => { draft.files.splice(i, 1); renderFiles(); }, 'chip'))
    );

    picker.onchange = () => {
      if (atTarget(target) && !input.readOnly) draft.files.push(...Array.from(picker.files));
      picker.value = '';
      renderFiles();
    };

    function resizeInput() {
      input.style.height = 'auto';
      input.style.height = Math.min(180, input.scrollHeight) + 'px';
    }
    input.oninput = () => {
      if (!atTarget(target) || input.readOnly) return;
      draft.text = input.value;
      resizeInput();
    };
    input.onpaste = event => {
      const pasted = Array.from(event.clipboardData?.files || []);
      if (pasted.length && atTarget(target) && !input.readOnly) {
        draft.files.push(...pasted);
        renderFiles();
      }
    };

    const feedback = el('small', 'compose-feedback');
    feedback.setAttribute('role', 'status');
    const addAttachment = iconBtn('添加附件', () => picker.click(), 'clip');
    const send = btn('', async () => {
      if (!atTarget(target) || draft.sending || !permitted) return;
      const text = input.value.trim();
      if (!text && !draft.files.length) {
        input.focus();
        return;
      }
      if (!text && draft.files.length) {
        notice('请说明希望怎样处理附件。');
        input.focus();
        return;
      }
      const run = state.snapshot?.run;
      const riskId = run?.recovery?.action === 'abandon' && !run.modelSetup ? run.id : null;
      const inputFiles = [...draft.files];
      const inputRefs = [...draft.refs];
      const refs = inputRefs.map(({ type, id }) => ({ type, id }));
      const modelId = target.instanceId === 'main' ? null : target.id ? state.snapshot.model?.selected ?? null : draft.modelId;
      const signature = JSON.stringify([text, refs, modelId]);
      let attempt = draft.attempt;
      if (!attempt || attempt.signature !== signature || attempt.files.length !== inputFiles.length ||
          !attempt.files.every((file, index) => file === inputFiles[index]) || (!attempt.submitted && attempt.riskId !== riskId)) {
        attempt = { signature, files: inputFiles, riskId, requestId: crypto.randomUUID() };
        draft.attempt = attempt;
      }
      const { requestId } = attempt;
      const pendingOrigin = draft.origin;
      const originRequestId = draft.originRequestId;
      let id = target.id || draft.pendingId;
      let creating = false;
      let created = false;
      let sent = false;
      draft.sending = true;
      delete draft.error;
      updateStatus();
      try {
        if (attempt.riskId && !attempt.acknowledged) {
          const ok = await confirmDialog({
            title: '确认继续发送',
            body: '原生运行可能仍在执行，确认在「' + (t.title || '原会话') + '」继续发送？',
            confirmLabel: '确认发送'
          });
          if (!ok) return;
          attempt.acknowledged = true;
        }
        const projectId = target.projectId;
        const attachmentIds = [];
        for (const file of inputFiles) attachmentIds.push(await uploadedId(file, projectId));
        if (!id && originRequestId) {
          id = pendingOrigin ? await pendingOrigin : (await api('/threads', {
            instanceId: target.instanceId, projectId: projectId || undefined, requestId: originRequestId
          })).id;
          draft.pendingId = id;
        }
        attempt.submitted = true;
        if (!id) {
          creating = true;
          const created = await api('/threads', {
            instanceId: target.instanceId, projectId: projectId || undefined, modelId: modelId || undefined,
            firstMessage: { text, refs, attachmentIds, requestId }, requestId
          });
          id = created.thread.id;
        } else {
          await api('/threads/' + url(id) + '/messages', {
            text, refs, attachmentIds, requestId,
            ...(target.instanceId !== 'main' ? { expectedModelId: modelId } : {}),
            ...(attempt.acknowledged ? { acknowledge: true, acknowledgeRunId: attempt.riskId } : {})
          });
        }
        sent = true;
        created = !target.id;
        draft.unknownCreate = false;
        if (draft.text.trim() === text) draft.text = '';
        draft.files = draft.files.filter(file => !inputFiles.includes(file));
        draft.refs = draft.refs.filter(ref => !inputRefs.includes(ref));
        if (draft.modelId === modelId) draft.modelId = null;
        delete draft.attempt;
        if (drafts.get(target.key) === draft && !draft.text && !draft.files.length && !draft.refs.length && !draft.modelId) {
          drafts.delete(target.key);
        } else if (created) draft.pendingId = id;
      } catch (error) {
        draft.unknownCreate = creating && (!error.status || error.status >= 500);
        if (error.status && error.status < 500) attempt.submitted = false;
        draft.error = (error.message || '发送失败') + (draft.unknownCreate ? '。请重试同一条消息以确认结果。' : '');
      } finally {
        draft.sending = false;
        if (state.view === 'chat' && draftKey() === target.key && (sent || !input.isConnected)) {
          $('compose').dataset.key = '';
          draw();
        } else if (input.isConnected) updateStatus();
      }
      if (!sent) return;
      try {
        if (created) await actions.load({ full: false, threadOwners: [target.instanceId] });
        if (!atTarget(target)) return;
        if (created) await actions.openThread(id);
        else await actions.refresh();
        if (state.view === 'chat' && state.thread === id && !$('dialog').open) $('input')?.focus({ preventScroll: true });
      } catch (error) {
        if (atTarget(target)) notice('消息已发送，刷新失败：' + error.message, 'error');
      }
    }, 'primary send', 'send');
    send.title = '发送';
    send.setAttribute('aria-label', '发送');

    function updateStatus() {
      input.readOnly = draft.sending || draft.unknownCreate || !permitted;
      picker.disabled = addAttachment.disabled = input.readOnly;
      files.inert = input.readOnly;
      send.disabled = Boolean(draft.sending || !permitted);
      send.setAttribute('aria-busy', String(Boolean(draft.sending)));
      feedback.textContent = draft.sending ? '正在发送…' : draft.error || '';
      feedback.hidden = !feedback.textContent;
    }

    input.onkeydown = e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        send.click();
      }
    };
    renderFiles();

    const composerBox = el('div', 'composer',
      draftBar,
      el('div', 'composer-inner',
        files,
        input,
        feedback,
        el('div', 'composer-bar',
          addAttachment,
          picker,
          el('small', 'key-hint', 'Enter 发送 · Shift + Enter 换行'),
          send
        )
      )
    );

    composerBox.ondragover = e => { e.preventDefault(); composerBox.classList.add('drag-over'); };
    composerBox.ondragleave = () => composerBox.classList.remove('drag-over');
    composerBox.ondrop = e => {
      e.preventDefault();
      composerBox.classList.remove('drag-over');
      const dropped = Array.from(e.dataTransfer?.files || []);
      if (dropped.length && atTarget(target) && !input.readOnly) {
        draft.files.push(...dropped);
        renderFiles();
      }
    };

    $('compose').replaceChildren(composerBox);
    updateStatus();
    if (draft.text) resizeInput();
  }

  function draw() {
    drawComposer();
    drawContent();
  }

  return {
    draw,
    newThread,
    delegate,
    chatSettings,
    botSettings,
    threadMenu,
    openTask,
    editPersona,
    resetContext,
    editThreadBudget,
    replaceNative,
    markNativeInvalid,
    preview,
    clearPreview,
    seedReferences: (id, refs) => { getDraftByKey(id).refs.push(...refs); }
  };
};
