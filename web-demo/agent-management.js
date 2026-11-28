import { api, btn, confirmDialog, displayDialog, el, items, notice } from './lib.js';
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
  let [currentSettings, initial] = await Promise.all([desktop.settings(), desktop.agentManagerStatus()]);
  const status = el('p', 'muted');
  status.setAttribute('role', 'status');
  const selection = el('select', '',
    el('option', '', '本机默认配置及共享目录'));
  selection.options[0].value = '';
  const overlays = currentSettings.instances.filter(instance => instance.hasDshOverrides);
  const groups = Map.groupBy(currentSettings.instances.filter(instance => instance.configurationHome), instance => instance.adapterKey);
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

  const codexSection = el('div', 'settings-list');
  let codexControls = [];
  let lastStatus = initial;
  let dialog;
  let panel;

  function renderCodexSection() {
    const codexInstances = (currentSettings.instances || []).filter(instance => instance.adapterKey === 'codex');
    codexControls = [];
    if (!codexInstances.length) {
      codexSection.hidden = true;
      codexSection.replaceChildren();
      return;
    }
    codexSection.hidden = false;
    const cards = codexInstances.map(instance => {
      const isNative = instance.codexProviderMode === 'native';
      const localSummary = instance.codexLocal || {};
      const managerProviders = Array.isArray(instance.codexManagerProviders) ? instance.codexManagerProviders : [];
      const details = [];
      if (isNative) {
        const providerLabel = localSummary.modelProvider || 'openai';
        details.push(el('small', 'muted mono',
          '本机配置：model_provider = ' + providerLabel + (localSummary.model ? ' · 默认模型 ' + localSummary.model : '')));
      } else {
        details.push(el('small', 'muted', '当前使用官方 ChatGPT 登录（忽略本机自定义供应商配置与 API Key）。'));
        if (localSummary.modelProvider || localSummary.model) {
          details.push(el('small', 'muted mono',
            '检测到本机配置：model_provider = ' + (localSummary.modelProvider || 'openai') +
            (localSummary.model ? ' · 默认模型 ' + localSummary.model : '')));
        }
      }
      if (managerProviders.length) {
        details.push(el('small', 'muted', '外接管理供应商：' + managerProviders.map(item =>
          item.name + (item.isCurrent ? '（当前）' : '')).join('、')));
      }
      let controls = null;
      if (currentSettings.editable && desktop.setCodexProvider) {
        const modeSelect = el('select', '',
          (() => {
            const option = el('option', '', '跟随本机供应商（由外接 Agent 管理切换）');
            option.value = 'native';
            return option;
          })(),
          (() => {
            const option = el('option', '', '官方 ChatGPT 登录');
            option.value = 'official';
            return option;
          })());
        modeSelect.value = isNative ? 'native' : 'official';
        const ctrl = { select: modeSelect, apply: null, busy: false };
        const applyBtn = btn('应用供应商设置', async () => {
          const targetMode = modeSelect.value;
          const labelNode = applyBtn.lastChild;
          ctrl.busy = true;
          modeSelect.disabled = true;
          applyBtn.disabled = true;
          if (labelNode) labelNode.textContent = '应用中…';
          try {
            const start = Date.now() - 50;
            let result = await desktop.setCodexProvider({ instanceId: instance.id, codexProviderMode: targetMode });
            if (result?.requiresConfirmation) {
              const confirmed = await confirmDialog({
                title: '确认切换 Codex 供应商？',
                body: `该实例当前有 ${result.boundThreads} 个已绑定原生会话的话题。切换供应商后，这些话题将保留全部本地记录并转为「归档 / 绑定失效」，后续可使用「建立替代话题」继续工作。`,
                confirmLabel: '确认切换并重连',
                destructive: true
              });
              if (!confirmed) return;
              result = await desktop.setCodexProvider({
                instanceId: instance.id,
                codexProviderMode: targetMode,
                confirmRebind: true
              });
            }
            if (!result?.applied) return;
            if (result.view?.connectorRunning) {
              for (let i = 0; i < 20; i++) {
                if (!panel.isConnected || !dialog?.open) break;
                try {
                  const live = items(await api('/instances'));
                  const updated = live.find(item => item.id === instance.id && Date.parse(item.lastSeen) >= start);
                  if (updated) break;
                } catch {
                  break;
                }
                await new Promise(resolve => setTimeout(resolve, 300));
              }
            }
            if (!panel.isConnected || !dialog?.open) return;
            currentSettings = result.view || await desktop.settings();
            renderCodexSection();
            render(lastStatus);
            await refreshMonitor?.();
            await onUpdated?.();
            notice('Codex 供应商配置已应用并重连。');
          } catch (error) {
            notice(error?.message || '应用 Codex 供应商配置失败', 'error');
          } finally {
            ctrl.busy = false;
            if (labelNode && applyBtn.isConnected) labelNode.textContent = '应用供应商设置';
            if (modeSelect.isConnected && applyBtn.isConnected) {
              const locked = Boolean(lastStatus?.active);
              modeSelect.disabled = locked;
              applyBtn.disabled = locked;
            }
          }
        }, 'secondary', 'refresh');
        ctrl.apply = applyBtn;
        codexControls.push(ctrl);
        controls = [
          el('label', 'field', el('span', 'field-label', 'Codex 供应商模式'), modeSelect),
          el('div', 'actions', applyBtn)
        ];
      } else {
        details.push(el('small', 'muted', '当前使用独立 JSON 配置，请在原文件中调整 codexProviderMode。'));
      }
      return el('div', 'record',
        el('div', 'record-head',
          el('strong', '', instance.name || instance.id),
          el('span', 'badge' + (isNative ? ' online' : ''), isNative ? '跟随本机供应商' : '官方 ChatGPT 登录')),
        ...details,
        ...(controls || []));
    });
    codexSection.replaceChildren(
      el('h3', '', 'Codex 供应商'),
      el('small', 'muted', '可在上方「打开管理窗口」切换本机供应商，再于此处切换模式或重新同步供应商配置。'),
      ...cards
    );
  }

  function render(value) {
    lastStatus = value;
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
    for (const ctrl of codexControls) {
      const disabled = Boolean(value.active || ctrl.busy);
      ctrl.select.disabled = disabled;
      if (ctrl.apply) ctrl.apply.disabled = disabled;
    }
  }
  let wasActive = initial.active;
  const monitor = el('div', 'settings-list');
  async function refreshStatus() {
    const value = await desktop.agentManagerStatus();
    const changed = wasActive !== value.active;
    wasActive = value.active;
    if (changed && !value.active) {
      currentSettings = await desktop.settings();
      renderCodexSection();
    }
    render(value);
    if (changed) {
      await refreshMonitor?.();
      if (!value.active) await onUpdated?.();
    }
    return value;
  }
  panel = el('div', 'settings-list', el('h3', '', '外接 Agent 管理'), status,
    selection.options.length > 1 ? el('label', 'field', el('span', 'field-label', '目标配置'), selection) : null,
    shared.length ? el('ul', 'muted agent-configuration-paths', ...shared) : null,
    overlays.length ? el('p', 'muted', overlays.map(instance => instance.name).join('、') +
      ' 使用 DSH 启动补丁。请从工作话题读取最终生效的模型。') : null,
    el('div', 'actions', open));
  renderCodexSection();
  ({ dialog } = displayDialog('Agent 设置', [panel, codexSection, monitor], [
    btn('执行实例与工作区', () => desktopSettings(onUpdated, () => agentManagement(onUpdated, onBotSettings)), 'secondary', 'terminal'),
    btn('关闭', () => document.getElementById('dialog')?.close(), 'ghost')
  ], { wide: true }));
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
