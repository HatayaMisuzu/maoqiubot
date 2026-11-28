import { api, at, btn, el, url } from './lib.js';

const adapters = { codex: 'Codex', dsh: 'DSH', hermes: 'Hermes', 'model-api': 'API 工作 Bot' };
const sources = { api_response: 'API 供应商回执', codex_turn: 'Codex App Server 轮次回执', dsh_session: 'DSH 原生会话日志' };
const failures = { failed: '失败', blocked: '受阻', uncertain: '待核对' };
const number = new Intl.NumberFormat('zh-CN');

function showInstance(instance, readQuota, onBotSettings) {
  const quotaText = instance.adapterKey === 'codex'
    ? (instance.usageAvailable ? '' : '额度未知')
    : instance.adapterKey === 'model-api'
      ? ''
      : '额度见原生客户端';
  const quota = el('div', 'muted', quotaText);
  quota.setAttribute('role', 'status');
  const quotaButton = instance.usageAvailable && readQuota ? btn('查询原生额度', async () => {
    quota.textContent = '正在查询…';
    try {
      const data = await readQuota(instance.id);
      quota.textContent = data.windows.length ? 'Codex App Server · ' + at(data.fetchedAt) : '额度未知';
      for (const window of data.windows) {
        const interval = window.durationMinutes ? `${window.durationMinutes} 分钟窗口` : '窗口长度未知';
        const resets = window.resetsAt ? ' · 重置于 ' + at(window.resetsAt * 1000) : '';
        quota.append(el('div', '', `${interval} · 已用 ${window.usedPercent}%${resets}`));
      }
    } catch (error) {
      quota.textContent = error?.message ? '额度读取失败：' + error.message : '额度未知';
    }
  }, 'secondary btn-xs') : null;
  const status = !instance.settings.enabled ? '已停用' : instance.canRun ? '可接任务' : instance.online ? '在线' : '离线';
  const metadata = [adapters[instance.adapterKey] || instance.adapterKey, instance.model, instance.version, instance.workspaceRef].filter(Boolean);
  return el('div', 'record',
    el('div', 'record-head', el('strong', '', instance.name || instance.id), el('span', 'badge' + (instance.canRun ? ' online' : ''), status)),
    el('small', 'muted mono', metadata.join(' · ')),
    el('small', 'muted', [`${instance.activeRuns} 项进行中`, `${instance.uncertainRuns} 项待核对`,
      instance.lastSeen ? '心跳 ' + at(instance.lastSeen) : null].filter(Boolean).join(' · ')),
    instance.issue === 'api_configuration' ? el('small', 'muted', '绑定的模型配置不可用，请检查模型是否启用及凭据是否就绪。') : null,
    instance.issue === 'native_connection' ? el('small', 'muted', '连接握手失败，可在 Agent 设置查看连接诊断。') : null,
    instance.lastFailure ? el('small', 'muted', `最近异常运行 ${failures[instance.lastFailure.status]} · 开始于 ${at(instance.lastFailure.startedAt)}`) : null,
    quota,
    el('div', 'actions', quotaButton, onBotSettings ? btn('Bot 设置', () => onBotSettings(instance), 'ghost btn-xs') : null)
  );
}

function showUsage(row, names) {
  function summarize(value, coverage) {
    if (value === null) return '未知';
    const partial = coverage < row.reportedRuns ? `（${coverage}/${row.reportedRuns} 次有数据）` : '';
    return number.format(value) + partial;
  }
  return el('div', 'record',
    el('div', 'record-head', el('strong', '', row.model || '模型未知'), el('span', 'muted', row.day)),
    el('small', 'muted', `${names.get(row.instanceId) || row.instanceId} · ${sources[row.source]} · ${row.reportedRuns} 次有用量回执`),
    el('small', 'muted', `输入 ${summarize(row.inputTokens, row.inputCoverage)} · 输出 ${summarize(row.outputTokens, row.outputCoverage)} · 总计 ${summarize(row.totalTokens, row.totalCoverage)} token`)
  );
}

export function mountAgentMonitor(container, { onBotSettings } = {}) {
  const desktop = window.maoqiuDesktop;
  const fetchMonitor = desktop?.agentMonitor
    ? days => desktop.agentMonitor({ days })
    : days => api('/agent-monitor?days=' + encodeURIComponent(days));
  const fetchQuota = desktop?.agentQuota
    ? id => desktop.agentQuota(id)
    : id => api('/instances/' + url(id) + '/usage');
  const status = el('small', 'muted');
  status.setAttribute('role', 'status');
  const instanceList = el('div', 'settings-list');
  const usageList = el('div', 'settings-list');
  const range = el('select', '', ...[7, 30, 90].map(days => {
    const option = el('option', '', `最近 ${days} 天`);
    option.value = String(days);
    return option;
  }));
  range.value = '30';
  range.setAttribute('aria-label', '用量统计日期范围');
  let generation = 0;

  async function load() {
    const request = ++generation;
    status.textContent = '正在读取…';
    try {
      const data = await fetchMonitor(Number(range.value));
      if (request !== generation) return;
      instanceList.replaceChildren(...(data.instances.length ? data.instances.map(instance =>
        showInstance(instance, fetchQuota, onBotSettings)) : [el('p', 'muted', '暂无已登记的本机工作 Bot。')]));
      status.textContent = '更新于 ' + at(data.fetchedAt);
      const names = new Map(data.instances.map(instance => [instance.id, instance.name]));
      if (!data.usage.length) {
        usageList.replaceChildren(el('p', 'muted', '这段时间暂无可核对的工作 Bot 用量。'));
        return;
      }
      let visible = 30;
      function showRows() {
        usageList.replaceChildren(...data.usage.slice(0, visible).map(row => showUsage(row, names)));
        if (visible < data.usage.length) {
          usageList.append(btn('显示更多', () => { visible += 30; showRows(); }, 'ghost btn-xs'));
        } else if (data.usageTruncated) {
          usageList.append(el('small', 'muted', '当前显示最新 1,000 组用量。缩短日期范围可查看更集中的记录。'));
        }
      }
      showRows();
    } catch (error) {
      if (request === generation) {
        status.textContent = '工作 Bot 监控读取失败' + (error?.message ? '：' + error.message : '，请刷新重试。');
      }
    }
  }

  range.addEventListener('change', () => void load());
  container.append(el('div', 'record-head', el('h3', '', '本机工作 Bot'), btn('刷新', load, 'ghost btn-xs', 'refresh')),
    status, instanceList, el('div', 'record-head', el('h3', '', '工作 Bot 用量'), range),
    el('small', 'muted', 'DSH 用量按已绑定的本机原生会话索引统计（跨进程未绑定会话除外）。全应用与原生明细见外接 Agent 管理。'), usageList);
  void load();
  return load;
}
