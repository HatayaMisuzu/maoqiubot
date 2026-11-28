export function connectorInstanceState(view, instanceId) {
  if (view.lastError || view.connectorRegistration?.error) {
    return { state: 'failed', detail: view.lastError || view.connectorRegistration.error };
  }
  if (!view.connectorRunning) return { state: 'failed', detail: '连接器进程未运行。' };
  const instance = view.connectorRegistration?.instances?.find(item => item.id === instanceId);
  if (!view.connectorGeneration || !instance) return { state: 'pending', detail: '正在等待本次连接登记…' };
  if (instance.online === true && !instance.error && /^[a-f0-9]{64}$/.test(instance.runtimeScopeId)) {
    return { state: 'ready', detail: '在线 · 已握手' };
  }
  return { state: 'failed', detail: instance.error || '实例登记未确认有效的原生运行范围。' };
}

export async function waitForConnector(initial, instanceIds, isOpen, previousGeneration) {
  if (!initial.connectorGeneration || initial.connectorGeneration === previousGeneration) {
    return { view: initial, detail: initial.lastError || '未取得本次新连接的登记信息。' };
  }
  const deadline = Date.now() + 45_000;
  let view = initial;
  while (isOpen()) {
    if (view.connectorGeneration !== initial.connectorGeneration) {
      return { view, detail: '连接器已再次重启，请检查新的连接状态。' };
    }
    const states = instanceIds.map(id => connectorInstanceState(view, id));
    if (view.lastError || view.connectorRegistration?.error || !view.connectorRunning) {
      return { view, detail: view.lastError || view.connectorRegistration?.error || '连接器进程未运行。' };
    }
    if (states.every(item => item.state !== 'pending')) {
      return { view, ready: states.every(item => item.state === 'ready'), detail: states.find(item => item.state === 'failed')?.detail };
    }
    if (Date.now() >= deadline) return { view, detail: '等待本次连接登记超时，状态待核对。' };
    await new Promise(resolve => setTimeout(resolve, 350));
    if (isOpen()) view = await window.maoqiuDesktop.settings();
  }
}
