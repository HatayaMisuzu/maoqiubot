import { btn, confirmDialog, displayDialog, el, icon, notice } from './lib.js';
import { desktopSettings } from './desktop-settings.js';
import { mountAgentMonitor } from './agent-monitor.js';
import { waitForConnector } from './connector-connection.js';

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
  const codexMessages = new Map();
  let codexControls = [];
  let codexBusy = false;
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
      const currentMode = isNative ? 'native' : 'official';
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
      const progress = el('small', 'muted', codexMessages.get(instance.id) || (instance.codexIdentityChanged
        ? '检测到本机账号或供应商变化，应用前需核对原生绑定。' : ''));
      progress.setAttribute('role', 'status');
      progress.hidden = !progress.textContent;
      const report = message => {
        codexMessages.set(instance.id, message);
        progress.textContent = message;
        progress.hidden = !message;
      };
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
        modeSelect.value = currentMode;
        const canApply = () => modeSelect.value !== currentMode || instance.codexIdentityChanged;
        const isOpen = () => panel.isConnected && dialog.open;
        const applyBtn = el('button', 'secondary', icon('refresh'), '应用供应商设置');
        applyBtn.type = 'button';
        applyBtn.onclick = async () => {
          if (codexBusy || lastStatus.active || !canApply()) return;
          const labelNode = applyBtn.lastChild;
          const payload = { instanceId: instance.id, codexProviderMode: modeSelect.value };
          const previousGeneration = currentSettings.connectorGeneration;
          codexBusy = true;
          render(lastStatus);
          if (labelNode) labelNode.textContent = '应用中…';
          let saved = false;
          const retry = '可使用「执行实例与工作区 → 测试连接」重试。';
          try {
            let result = await desktop.setCodexProvider(payload);
            if (!isOpen()) return;
            if (result?.requiresConfirmation) {
              const confirmed = await confirmDialog({
                title: '确认切换 Codex 供应商？',
                body: `该实例当前有 ${result.boundThreads} 个已绑定原生会话的话题。切换会保留本地记录和原绑定，归档活跃话题并标记原绑定失效。已清除但未解绑的记录也会保留，可用「建立替代话题」继续工作。`,
                confirmLabel: '确认切换并重连',
                destructive: true
              });
              if (!confirmed || !isOpen()) return;
              result = await desktop.setCodexProvider({ ...payload, confirmationToken: result.confirmationToken });
            }
            if (!isOpen()) return;
            if (result?.noChange) {
              report('当前供应商设置无变更。');
              if (result.view) currentSettings = result.view;
              renderCodexSection();
              return;
            }
            if (!result?.applied) {
              report('供应商设置未应用，请重新核对配置。');
              return;
            }
            saved = true;
            report('供应商配置已保存，正在等待本次连接登记…');
            currentSettings = result.view ?? await desktop.settings();
            renderCodexSection();
            render(lastStatus);
            const outcome = await waitForConnector(currentSettings, [instance.id], isOpen, previousGeneration);
            if (!outcome || !isOpen()) return;
            currentSettings = outcome.view;
            report(outcome.ready ? 'Codex 本次连接已确认可用。模型调用仍取决于模型配置和额度。' :
              '供应商配置已保存。' + outcome.detail + retry);
            renderCodexSection();
            void Promise.allSettled([Promise.resolve().then(refreshMonitor), Promise.resolve().then(onUpdated)]);
          } catch (error) {
            if (!isOpen()) return;
            report(saved ? '供应商配置已保存，无法确认本次连接。' + retry :
              error?.message || '应用 Codex 供应商配置失败。');
            if (saved) renderCodexSection();
          } finally {
            codexBusy = false;
            if (labelNode && applyBtn.isConnected) labelNode.textContent = '应用供应商设置';
            if (isOpen()) render(lastStatus);
          }
        };
        modeSelect.addEventListener('change', () => render(lastStatus));
        codexControls.push({ select: modeSelect, apply: applyBtn, canApply });
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
          el('span', 'badge', isNative ? '跟随本机供应商' : '官方 ChatGPT 登录')),
        ...details,
        progress,
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
    open.disabled = codexBusy;
    open.lastChild.textContent = value.active ? '切到管理窗口' : '打开管理窗口';
    status.textContent = value.error || (value.active
      ? '管理窗口已打开。本机连接器会在管理窗口关闭后恢复。'
      : value.available
        ? '设置会写入本机 Agent 使用的目录。打开管理窗口时会暂停空闲的本机连接器。'
        : '当前桌面包缺少内置管理组件（源码运行请先执行 npm run build:agent-manager）。');
    for (const ctrl of codexControls) {
      const disabled = Boolean(value.active || codexBusy);
      ctrl.select.disabled = disabled;
      ctrl.apply.disabled = disabled || !ctrl.canApply();
    }
  }
  let wasActive = initial.active;
  const monitor = el('div', 'settings-list');
  async function refreshStatus() {
    const value = await desktop.agentManagerStatus();
    const changed = wasActive !== value.active;
    wasActive = value.active;
    const nativeInstances = currentSettings.instances.filter(instance => instance.codexProviderMode === 'native');
    if (!value.active && !codexBusy && (changed || nativeInstances.length)) {
      const next = await desktop.settings();
      const identityChanged = nativeInstances.some(instance =>
        instance.codexIdentityChanged !== next.instances.find(item => item.id === instance.id)?.codexIdentityChanged);
      const generationChanged = currentSettings.connectorGeneration !== next.connectorGeneration;
      currentSettings = next;
      if (changed || identityChanged || generationChanged) {
        codexMessages.clear();
        renderCodexSection();
      }
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
