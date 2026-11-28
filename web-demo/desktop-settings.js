import { api, btn, displayDialog, el, form, items, notice } from './lib.js';

const desktop = () => window.maoqiuDesktop;
export const hasDesktopSettings = () => Boolean(desktop());

export async function desktopSettings(onUpdated, back) {
  if (!desktop()) {
    notice('本机执行实例设置仅在桌面端可用。', 'error');
    return;
  }
  const settings = await desktop().settings();
  const instances = items(await api('/instances'));
  const labels = el('p', 'muted', settings.lastError || (settings.connectorRunning ? '连接器进程已启动' : '连接器进程未启动'));
  labels.setAttribute('role', 'status');
  const list = el('div', 'settings-list');

  function showInstances(live) {
    list.replaceChildren(...settings.instances.map(instance => {
      const registered = live.find(i => i.id === instance.id);
      const status = registered?.online ? '在线 · 已握手' : registered?.capabilities?.error || '离线 · 等待登记';
      return el('div', 'record',
        el('div', 'record-head',
          el('strong', '', instance.name),
          el('span', 'badge ' + (registered?.online ? 'online' : ''), status)
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
    operation.disabled = true;
    if (labelNode) labelNode.textContent = '测试中…';
    try {
      const start = Date.now() - 50;
      await desktop().restartConnector();
      if (!labels.isConnected) return;
      labels.textContent = '正在等待本机实例登记…';
      const ids = settings.instances.map(i => i.id);
      for (let i = 0; i < 40; i++) {
        if (!labels.isConnected) return;
        const current = items(await api('/instances'));
        if (!labels.isConnected) return;
        const fresh = current.filter(item => ids.includes(item.id) && Date.parse(item.lastSeen) >= start);
        if (fresh.length === ids.length) {
          labels.textContent = fresh.length ? '连接测试结束，查看下方各实例状态。' : '尚未配置执行实例。';
          showInstances(fresh);
          await onUpdated?.();
          return;
        }
        if (!(await desktop().settings()).connectorRunning) break;
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      if (!labels.isConnected) return;
      const latest = await desktop().settings();
      labels.textContent = latest.lastError || '尚未收到全部本机实例的登记，请检查路径、登录状态或原生启动错误。';
      showInstances(items(await api('/instances')));
      await onUpdated?.();
    } finally {
      operation.disabled = false;
      if (labelNode) labelNode.textContent = '测试连接';
    }
  }, 'secondary', 'refresh');

  showInstances(instances);

  displayDialog('执行实例与工作区', [
    labels,
    el('small', 'muted mono', settings.file),
    !settings.editable ? el('p', 'muted', '当前从独立 JSON 文件加载配置。') : null,
    list
  ], [
    settings.editable ? btn('新增实例', () => instanceForm(settings, null, false, onUpdated, back), 'secondary', 'plus') : null,
    operation,
    btn('关闭', () => document.getElementById('dialog')?.close(), 'ghost')
  ], { wide: true, back });
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

function instanceForm(settings, instance, copy = false, onUpdated, back) {
  const nextId = instance && copy
    ? Array.from({ length: settings.instances.length + 1 }, (_, i) => instance.id + '-' + (i + 2))
      .find(id => !settings.instances.some(i => i.id === id))
    : instance?.id;
  const ui = form(copy ? '复制执行实例' : instance ? '编辑执行实例' : '新增执行实例', [
    { key: 'adapterKey', label: 'Agent', options: [{ id: 'codex', name: 'Codex' }, { id: 'dsh', name: 'DSH' }, { id: 'hermes', name: 'Hermes' }], value: instance?.adapterKey },
    { key: 'id', label: '实例 ID', value: nextId, required: true },
    { key: 'name', label: '显示名称', value: instance?.name, required: true },
    { key: 'command', label: '官方可执行程序名或完整路径', value: instance?.command, required: true },
    { key: 'workspaceRef', label: '工作区目录', value: instance?.workspaceRef || settings.workspace, required: true },
    { key: 'profileId', label: 'Profile 绑定标识', value: instance?.profileId || 'default', required: true },
    { key: 'configurationHome', label: 'Agent 配置目录', value: instance?.configuredHome, placeholder: instance?.configurationHome || '留空使用本机默认目录' },
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
  const syncCodexMode = () => { ui.controls.codexProviderMode.closest('label').hidden = ui.controls.adapterKey.value !== 'codex'; };
  ui.controls.adapterKey.addEventListener('change', syncCodexMode);
  syncCodexMode();
  if (instance) ui.body.prepend(el('p', 'muted', '使用新实例 ID 可保留原有会话绑定。'));
}
