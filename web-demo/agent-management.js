import { btn, displayDialog, el, notice } from './lib.js';
import { desktopSettings } from './desktop-settings.js';
import { mountAgentMonitor } from './agent-monitor.js';

export async function agentManagement(onUpdated, onBotSettings) {
  const desktop = window.maoqiuDesktop;
  if (!desktop?.agentManagerStatus) {
    const monitor = el('div', 'settings-list');
    displayDialog('Bot 监控', [
      el('p', 'muted', '当前为浏览器模式；本机进程启停、Worktree 与外接 Agent 配置窗口仅桌面端可用。'),
      monitor
    ], [
      btn('关闭', () => document.getElementById('dialog')?.close(), 'ghost')
    ], { wide: true });
    mountAgentMonitor(monitor, { onBotSettings });
    return;
  }
  const [settings, initial] = await Promise.all([desktop.settings(), desktop.agentManagerStatus()]);
  const status = el('p', 'muted');
  status.setAttribute('role', 'status');
  const selection = el('select', '',
    el('option', '', '本机默认配置及共享目录'));
  selection.options[0].value = '';
  const overlays = settings.instances.filter(instance => instance.hasDshOverrides);
  const groups = Map.groupBy(settings.instances.filter(instance => instance.configurationHome), instance => instance.adapterKey);
  const shared = [];
  for (const [adapter, instances] of groups) {
    const homes = Map.groupBy(instances, instance => instance.configurationHome);
    if (homes.size === 1) {
      shared.push(el('li', '', adapter + ' · ' + instances[0].configurationHome));
      continue;
    }
    for (const [home, occupants] of homes) {
      const option = el('option', '', occupants.map(instance => instance.name).join('、') + ' · ' + home);
      option.value = occupants[0].id;
      selection.append(option);
    }
  }
  const open = btn('打开管理窗口', async () => {
    await desktop.openAgentManager(selection.value || undefined);
    await refreshStatus();
  }, 'primary', 'sliders');
  function render(value) {
    selection.disabled = value.active;
    if (value.instanceId && Array.from(selection.options).some(opt => opt.value === value.instanceId)) {
      selection.value = value.instanceId;
    }
    open.hidden = !value.available;
    open.lastChild.textContent = value.active ? '切到管理窗口' : '打开管理窗口';
    status.textContent = value.error || (value.active
      ? '管理窗口已打开。本机连接器会在管理窗口关闭后恢复。'
      : value.available
        ? '设置会写入本机 Agent 使用的目录。打开管理窗口时会暂停空闲的本机连接器。'
        : '当前桌面包缺少内置管理组件（源码运行请先执行 npm run build:agent-manager）。');
  }
  let wasActive = initial.active;
  const monitor = el('div', 'settings-list');
  async function refreshStatus() {
    const value = await desktop.agentManagerStatus();
    render(value);
    const changed = wasActive !== value.active;
    wasActive = value.active;
    if (changed) {
      await refreshMonitor?.();
      if (!value.active) await onUpdated?.();
    }
    return value;
  }
  const panel = el('div', 'settings-list', el('h3', '', '外接 Agent 管理'), status,
    selection.options.length > 1 ? el('label', 'field', el('span', 'field-label', '目标配置'), selection) : null,
    shared.length ? el('ul', 'muted agent-configuration-paths', ...shared) : null,
    overlays.length ? el('p', 'muted', overlays.map(instance => instance.name).join('、') +
      ' 使用 DSH 启动补丁。请从工作话题读取最终生效的模型。') : null,
    el('div', 'actions', open));
  const { dialog } = displayDialog('Agent 设置', [panel, monitor], [
    btn('执行实例与工作区', () => desktopSettings(onUpdated, () => agentManagement(onUpdated, onBotSettings)), 'secondary', 'terminal'),
    btn('关闭', () => document.getElementById('dialog')?.close(), 'ghost')
  ], { wide: true });
  render(initial);
  const refreshMonitor = mountAgentMonitor(monitor, { onBotSettings });
  async function poll() {
    if (!dialog.open || !panel.isConnected) return;
    try { await refreshStatus(); }
    catch (error) { notice(error.message, 'error'); return; }
    if (dialog.open && panel.isConnected) setTimeout(poll, 1500);
  }
  setTimeout(poll, 1500);
}
