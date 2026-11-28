import { btn, displayDialog, el, form, notice } from './lib.js';
import { connectorInstanceState, waitForConnector } from './connector-connection.js';

const desktop = () => window.maoqiuDesktop;
export const hasDesktopSettings = () => Boolean(desktop());

export async function desktopSettings(onUpdated, back) {
  if (!desktop()) {
    notice('本机执行实例设置仅在桌面端可用。', 'error');
    return;
  }
  let settings = await desktop().settings();
  const labels = el('p', 'muted', settings.lastError || (settings.connectorRunning ? '连接器进程已启动' : '连接器进程未启动'));
  labels.setAttribute('role', 'status');
  const list = el('div', 'settings-list');

  const isOpen = () => labels.isConnected && document.getElementById('dialog')?.open;
  function showInstances(view) {
    list.replaceChildren(...settings.instances.map(instance => {
      const status = connectorInstanceState(view, instance.id);
      return el('div', 'record',
        el('div', 'record-head',
          el('strong', '', instance.name),
          el('span', 'badge ' + (status.state === 'ready' ? 'online' : ''), status.detail)
        ),
        el('small', 'muted mono', [instance.id, instance.adapterKey, instance.profileId, instance.workspaceRef].join(' · ')),
        instance.configurationHome ? el('small', 'muted mono', '配置目录 ' + instance.configurationHome) : null,
        instance.adapterKey === 'codex' ? el('small', 'muted', instance.codexProviderMode === 'native' ? '跟随本机 Codex 供应商' : '使用 Codex 官方登录') : null,
        instance.hasDshOverrides ? el('small', 'muted', '此实例含 DSH 覆盖配置，会话模型列表反映最终生效的配置。') : null,
        instance.worktree ? el('small', 'muted mono', 'Worktree: ' + instance.worktree.branch + ' · 基准 ' + instance.worktree.baseCommit.slice(0, 12)) : null,
        el('small', 'muted', instance.detectedCommand || '未检测到已配置的官方可执行文件，可手填绝对路径。'),
        settings.editable ? el('div', 'actions',
          btn('编辑配置', () => instanceForm(settings, instance, false, onUpdated, back), 'ghost btn-xs'),
          btn('复制为新实例', () => instanceForm(settings, instance, true, onUpdated, back), 'ghost btn-xs'),
          desktop().createWorktree ? btn('新建 Git 工作树', () => worktreeForm(instance, onUpdated, back), 'ghost btn-xs', 'branch') : null
        ) : null
      );
    }));
  }

  const operation = btn('测试连接', async () => {
    const labelNode = operation.lastChild;
    const previousGeneration = settings.connectorGeneration;
    if (labelNode) labelNode.textContent = '测试中…';
    labels.textContent = '正在启动连接器…';
    try {
      const started = await desktop().restartConnector();
      if (!isOpen()) return;
      settings = started;
      showInstances(settings);
      labels.textContent = '正在等待本次连接登记…';
      const ids = settings.instances.map(i => i.id);
      const outcome = await waitForConnector(started, ids, isOpen, previousGeneration);
      if (!outcome || !isOpen()) return;
      settings = outcome.view;
      showInstances(settings);
      labels.textContent = outcome.ready ? (ids.length ?
        '本次实例登记已确认。模型调用仍取决于模型配置和额度。' : '尚未配置执行实例。') : outcome.detail;
      void Promise.resolve().then(onUpdated).catch(() => {});
    } catch (error) {
      if (isOpen()) labels.textContent = error?.message || '无法确认本次连接。';
    } finally {
      if (labelNode) labelNode.textContent = '测试连接';
    }
  }, 'secondary', 'refresh');

  showInstances(settings);
  const hermes = desktop().discoverHermes ? hermesDiscovery(() => settings, onUpdated, back) : null;

  displayDialog('执行实例与工作区', [
    labels,
    el('small', 'muted mono', settings.file),
    !settings.editable ? el('p', 'muted', '当前从独立 JSON 文件加载配置。') : null,
    list,
    hermes
  ], [
    settings.editable ? btn('新增实例', () => instanceForm(settings, null, false, onUpdated, back), 'secondary', 'plus') : null,
    operation,
    btn('关闭', () => document.getElementById('dialog')?.close(), 'ghost')
  ], { wide: true, back });
}

function hermesDiscovery(settings, onUpdated, back) {
  const results = el('div', 'settings-list');
  const message = el('p', 'muted');
  message.setAttribute('role', 'status');
  const scan = btn('重新扫描 Hermes', async () => {
    message.textContent = '正在查找 Hermes 启动器…';
    const discovery = await desktop().discoverHermes();
    if (!message.isConnected || !document.getElementById('dialog')?.open) return;
    message.textContent = discovery.candidates.length ? (discovery.editable ? '' : '独立 JSON 配置由原文件管理。') : '未找到 Hermes 启动器。';
    results.replaceChildren(...discovery.candidates.map(candidate => {
      const state = el('small', 'muted', candidate.found ? '已找到启动器，等待 ACP 验证。' : '未找到配置的启动器。');
      state.setAttribute('role', 'status');
      const probe = candidate.found && desktop().probeHermes ? btn('测试 ACP 握手', async () => {
        state.textContent = '正在等待 ACP 握手…';
        try {
          const result = await desktop().probeHermes(candidate);
          state.textContent = result.detail;
        } catch (error) {
          state.textContent = error?.message || 'ACP 握手失败。';
        }
      }, 'ghost btn-xs') : null;
      const add = discovery.editable && candidate.found && !candidate.instanceId ? btn('添加为新实例', () => {
        const current = settings();
        const id = Array.from({ length: current.instances.length + 1 }, (_, i) => i ? 'hermes-local-' + (i + 1) : 'hermes-local')
          .find(value => !current.instances.some(instance => instance.id.toLowerCase() === value));
        instanceForm(current, null, false, onUpdated, back, {
          adapterKey: 'hermes', id, name: 'Hermes', command: candidate.command, profileId: candidate.profileId,
          configuredHome: candidate.configurationHome
        });
      }, 'ghost btn-xs') : null;
      return el('div', 'record', el('strong', '', candidate.name || 'Hermes'), el('small', 'muted mono', candidate.command),
        el('small', 'muted mono', candidate.profileId + ' · ' + candidate.configurationHome), state,
        probe || add ? el('div', 'actions', probe, add) : null);
    }));
  }, 'secondary', 'refresh');
  return el('div', 'settings-list', el('h3', '', 'Hermes 启动器'), el('div', 'actions', scan), message, results);
}

function worktreeForm(instance, onUpdated, back) {
  const ui = form('新建 Git 工作树', [
    { key: 'instanceId', label: '新实例 ID', required: true }
  ], '选择目标父目录', async ({ instanceId }) => {
    const result = await desktop().createWorktree({ sourceId: instance.id, instanceId });
    if (!result) return;
    await onUpdated?.();
    await desktopSettings(onUpdated, back);
    notice('已创建 ' + result.branch + '。' + (result.dirty ? '源目录的未提交修改仍留在原处。' : '') + '测试连接后，可在项目中绑定新实例。');
  }, { back: () => desktopSettings(onUpdated, back) });
  ui.body.prepend(el('p', 'muted', instance.workspaceRef + ' · 从当前提交创建新分支和独立执行实例。'));
}

function instanceForm(settings, instance, copy = false, onUpdated, back, draft) {
  const initial = instance ?? draft;
  const nextId = instance && copy
    ? Array.from({ length: settings.instances.length + 1 }, (_, i) => instance.id + '-' + (i + 2))
      .find(id => !settings.instances.some(i => i.id === id))
    : initial?.id;
  const ui = form(copy ? '复制执行实例' : instance ? '编辑执行实例' : '新增执行实例', [
    { key: 'adapterKey', label: 'Agent', options: [{ id: 'codex', name: 'Codex' }, { id: 'dsh', name: 'DSH' }, { id: 'hermes', name: 'Hermes' }], value: initial?.adapterKey },
    { key: 'id', label: '实例 ID', value: nextId, required: true },
    { key: 'name', label: '显示名称', value: initial?.name, required: true },
    { key: 'command', label: '官方可执行程序名或完整路径', value: initial?.command, required: true },
    { key: 'workspaceRef', label: '工作区目录', value: initial?.workspaceRef || settings.workspace, required: true },
    { key: 'profileId', label: 'Profile 绑定标识', value: initial?.profileId || 'default', required: true },
    { key: 'configurationHome', label: 'Agent 配置目录', value: initial?.configuredHome, placeholder: initial?.configurationHome || '留空使用本机默认目录' },
    { key: 'codexProviderMode', label: 'Codex 供应商模式', options: [
      { id: 'official', name: '官方 ChatGPT 登录' },
      { id: 'native', name: '跟随本机供应商' }
    ], value: instance?.codexProviderMode ?? 'official' }
  ], '保存实例', async values => {
    await desktop().saveInstance({ ...values,
      ...(copy && instance?.adapterKey === values.adapterKey ? { sourceId: instance.id } : {}) });
    await onUpdated?.();
    await desktopSettings(onUpdated, back);
    notice('配置已保存。点「测试连接」应用并检查。');
  }, { back: () => desktopSettings(onUpdated, back) });
  const editingExistingCodex = Boolean(instance && !copy && instance.adapterKey === 'codex');
  const codexField = ui.controls.codexProviderMode.closest('label');
  const codexHint = editingExistingCodex
    ? el('small', 'muted', '切换已有 Codex 实例的供应商模式，请返回「Agent 设置 → Codex 供应商」应用并重连。')
    : null;
  if (codexHint) codexField.after(codexHint);
  const syncCodexMode = () => {
    const isCodex = ui.controls.adapterKey.value === 'codex';
    codexField.hidden = !isCodex;
    if (codexHint) codexHint.hidden = !isCodex;
    ui.controls.codexProviderMode.disabled = editingExistingCodex;
  };
  ui.controls.adapterKey.addEventListener('change', syncCodexMode);
  syncCodexMode();
  if (instance) ui.body.prepend(el('p', 'muted', '使用新实例 ID 可保留原有会话绑定。'));
}
