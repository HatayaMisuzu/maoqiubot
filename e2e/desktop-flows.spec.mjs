import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base, expect } from '@playwright/test';
import WebSocket from 'ws';
import { startServer } from '../server/index.ts';

const test = base.extend({
  workbench: async ({ page }, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'maoqiu-desktop-flows-'));
    const app = startServer({ port: 0, dataDir: dir, chat: false });
    const errors = [];
    let socket;
    page.on('pageerror', error => errors.push(error.message));
    try {
      await once(app.server, 'listening');
      const baseUrl = 'http://127.0.0.1:' + app.server.address().port;
      const api = async (path, body) => {
        const response = await fetch(baseUrl + '/api/v1' + path, {
          method: body ? 'POST' : 'GET',
          headers: { Authorization: 'Bearer ' + app.auth.cfg.ownerToken, 'Content-Type': 'application/json' },
          body: body && JSON.stringify({ requestId: crypto.randomUUID(), ...body })
        });
        const value = await response.json();
        expect(response.ok, JSON.stringify(value)).toBe(true);
        return value;
      };
      const instanceId = 'fixture-bot';
      socket = new WebSocket('ws://127.0.0.1:' + app.server.address().port + '/api/v1/node', {
        headers: { Authorization: 'Bearer ' + app.auth.cfg.nodes.local }
      });
      await once(socket, 'open');
      socket.send(JSON.stringify({ type: 'hello', nodeId: 'local', instances: [{
        id: instanceId,
        name: '合成工作 Bot',
        adapterKey: 'dsh',
        workspaceRef: dir,
        availableActions: ['run', 'cancel', 'answer'],
        models: [{ id: 'fixture-model', label: 'Fixture Model' }]
      }] }));
      await expect.poll(async () => (await api('/instances')).some(instance => instance.id === instanceId && instance.online)).toBe(true);
      await use({ api, app, baseUrl, instanceId, login: () => page.goto(baseUrl + '/login?ticket=' + app.ticket) });
      expect(errors).toEqual([]);
    } finally {
      if (socket && socket.readyState < WebSocket.CLOSING) {
        socket.close();
        await once(socket, 'close');
      }
      const close = app.close();
      app.server.closeAllConnections();
      await close;
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
});

test('任务卡打开对应工作话题', async ({ page, workbench }) => {
  const { api, instanceId, login } = workbench;
  const main = await api('/threads/main');
  const task = await api('/tasks', {
    originThreadId: main.id,
    instanceId,
    goal: '合成任务导航检查'
  });

  await login();
  const taskCard = page.getByRole('button', { name: /查看工作话题/ });
  await expect(taskCard).toBeVisible();
  await taskCard.click();
  await expect(page).toHaveURL(new RegExp('thread=' + task.workThreadId + '$'));
  await expect(page.locator('#content')).toContainText('合成任务导航检查');
  expect((await api('/threads/' + task.workThreadId)).thread.taskId).toBe(task.taskId);
});

test('从侧聊归档并从归档目录恢复', async ({ page, workbench }) => {
  const { api, login } = workbench;
  const side = await api('/threads', { title: '归档往返样例' });

  await login();
  await page.getByRole('button', { name: '归档往返样例', exact: true }).click();
  await page.locator('#tools').getByRole('button', { name: '会话操作', exact: true }).click();
  await page.getByRole('button', { name: '归档会话', exact: true }).click();
  await expect.poll(async () => (await api('/threads/' + side.id)).thread.state).toBe('archived');

  const archive = page.locator('#side-list').getByRole('button', { name: '归档与回收站' });
  await archive.click();
  await page.locator('#side-list button[title="恢复会话"]').click();
  await expect.poll(async () => (await api('/threads/' + side.id)).thread.state).toBe('active');
  await expect(page.getByText('会话已恢复。')).toBeVisible();
});

test('Bot 设置可停用工作 Bot 并反映到聊天入口', async ({ page, workbench }) => {
  const { api, instanceId, login } = workbench;
  await login();
  const bot = page.locator('#side-list .bot-main-btn');
  await expect(bot).toContainText('合成工作 Bot');
  await page.locator('#side-list').getByRole('button', { name: 'Bot 设置' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Bot 状态').selectOption('false');
  await dialog.getByRole('button', { name: '保存设置' }).click();
  await expect.poll(async () => (await api('/instances')).find(instance => instance.id === instanceId).settings.enabled).toBe(false);

  await bot.click();
  await expect(page.locator('#compose')).toContainText('此 Bot 已停用');
});

test('桌面 Agent 设置关联本机 Bot 配置和监控', async ({ page, workbench }) => {
  await page.addInitScript(() => {
    const opened = [];
    window.openedAgentHomes = opened;
    window.maoqiuDesktop = {
      settings: async () => ({ instances: [
        { id: 'dsh-default', name: '默认 DSH', adapterKey: 'dsh', configurationHome: 'C:/native/dsh' },
        { id: 'dsh-lab', name: '实验 DSH', adapterKey: 'dsh', configurationHome: 'E:/agents/dsh-lab' }
      ] }),
      agentManagerStatus: async () => ({ available: true, active: opened.length > 0 }),
      openAgentManager: async instanceId => { opened.push(instanceId); },
      agentMonitor: async () => ({
        fetchedAt: new Date().toISOString(), usage: [],
        instances: [{
          id: 'dsh-default', name: '默认 DSH', adapterKey: 'dsh', canRun: true, online: true,
          settings: { enabled: true }, activeRuns: 0, uncertainRuns: 0
        }]
      })
    };
  });
  await workbench.login();
  await page.locator('#session').getByRole('button', { name: 'Agent 设置', exact: true }).click();
  const settings = page.getByRole('dialog');
  await expect(settings.getByText('可接任务', { exact: true })).toBeVisible();
  await settings.getByLabel('目标配置').selectOption('dsh-lab');
  await settings.getByRole('button', { name: '打开管理窗口' }).click();
  await expect(settings.getByText('管理窗口已打开。', { exact: false })).toBeVisible();
  await expect(settings.getByLabel('目标配置')).toBeDisabled();
  expect(await page.evaluate(() => window.openedAgentHomes)).toEqual(['dsh-lab']);
});

test('桌面 Agent 设置可在顶层面板切换 Codex 供应商模式并处理绑定确认', async ({ page, workbench }) => {
  await page.addInitScript(() => {
    let mode = 'official';
    const calls = [];
    window.codexSwitchCalls = calls;
    const currentSettings = () => ({
      editable: true,
      connectorRunning: true,
      connectorGeneration: mode === 'official' ? 'old' : 'current',
      connectorRegistration: { instances: [{ id: 'codex-local', online: true, runtimeScopeId: 'a'.repeat(64) }] },
      instances: [{
        id: 'codex-local',
        name: 'Codex',
        adapterKey: 'codex',
        configurationHome: 'C:/Users/fixture/.codex',
        codexProviderMode: mode,
        codexLocal: { modelProvider: 'custom', model: 'gpt-6.1-sol' },
        codexManagerProviders: [
          { id: 'default', name: 'default', category: 'custom', isCurrent: true },
          { id: 'codex-official', name: 'OpenAI Official', category: 'official', isCurrent: false }
        ]
      }]
    });
    window.maoqiuDesktop = {
      settings: async () => currentSettings(),
      agentManagerStatus: async () => ({ available: true, active: false }),
      setCodexProvider: async payload => {
        calls.push(payload);
        if (!payload.confirmationToken) {
          return { applied: false, requiresConfirmation: true, boundThreads: 2, confirmationToken: 'fixture-confirmation' };
        }
        mode = payload.codexProviderMode;
        return {
          applied: true,
          requiresConfirmation: false,
          boundThreads: 2,
          view: currentSettings()
        };
      },
      agentMonitor: async () => ({ fetchedAt: new Date().toISOString(), usage: [], instances: [] })
    };
  });
  await workbench.login();
  await page.locator('#session').getByRole('button', { name: 'Agent 设置', exact: true }).click();
  const settings = page.getByRole('dialog');
  await expect(settings.getByRole('heading', { name: 'Codex 供应商' })).toBeVisible();
  await expect(settings).toContainText('model_provider = custom · 默认模型 gpt-6.1-sol');
  await expect(settings).toContainText('外接管理供应商：default（当前）、OpenAI Official');
  await expect(settings.getByRole('button', { name: '应用供应商设置' })).toBeDisabled();
  await settings.getByLabel('Codex 供应商模式').selectOption('native');
  await settings.getByRole('button', { name: '应用供应商设置' }).click();

  const confirm = page.locator('#confirm-dialog');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('2 个已绑定原生会话的话题');
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(settings.locator('.badge', { hasText: '官方 ChatGPT 登录' })).toBeVisible();
  await settings.getByRole('button', { name: '应用供应商设置' }).click();
  await confirm.getByRole('button', { name: '确认切换并重连' }).click();

  await expect(settings.locator('.badge', { hasText: '跟随本机供应商' })).toBeVisible();
  await expect(settings).toContainText('Codex 本次连接已确认可用。');
  await expect(settings.getByRole('button', { name: '应用供应商设置' })).toBeDisabled();
  expect(await page.evaluate(() => window.codexSwitchCalls)).toEqual([
    { instanceId: 'codex-local', codexProviderMode: 'native' },
    { instanceId: 'codex-local', codexProviderMode: 'native' },
    { instanceId: 'codex-local', codexProviderMode: 'native', confirmationToken: 'fixture-confirmation' }
  ]);
});

async function codexConnectionBridge(page, result) {
  await page.addInitScript(result => {
    let mode = 'official';
    let generation = 'old';
    let attempts = 0;
    window.registrationState = 'ready';
    window.registrationReads = 0;
    const settings = () => {
      const state = window.registrationState;
      return {
        file: 'C:/fixture/connector.json', editable: true, connectorRunning: state !== 'exit', connectorGeneration: generation,
        ...(state === 'exit' ? { lastError: '连接器已退出（代码 1）。' } : {}),
        connectorRegistration: {
          ...(state === 'rejected' ? { error: '工作台拒绝了本次实例登记。' } : {}),
          instances: state === 'ready' ? [{ id: 'codex-local', online: true, runtimeScopeId: 'c'.repeat(64) }] :
            state === 'offline' ? [{ id: 'codex-local', online: false, error: '原生 Agent 未完成握手。' }] :
              state === 'no-scope' ? [{ id: 'codex-local', online: true }] : []
        },
        instances: [{ id: 'codex-local', name: 'Codex', adapterKey: 'codex', codexProviderMode: mode }]
      };
    };
    window.maoqiuDesktop = {
      settings: async () => { window.registrationReads++; return settings(); },
      agentManagerStatus: async () => ({ available: true, active: false }),
      setCodexProvider: async payload => {
        mode = payload.codexProviderMode;
        if (result !== 'stale-generation') {
          generation = 'applied-' + (++attempts);
          window.registrationState = result;
        }
        return { applied: true, view: settings() };
      },
      restartConnector: async () => {
        generation = 'retried';
        window.registrationState = 'ready';
        return settings();
      },
      agentMonitor: async () => ({ fetchedAt: new Date().toISOString(), usage: [], instances: [] })
    };
  }, result);
}

async function applyCodexNative(page, workbench, result) {
  await codexConnectionBridge(page, result);
  await workbench.login();
  await page.locator('#session').getByRole('button', { name: 'Agent 设置', exact: true }).click();
  const settings = page.getByRole('dialog');
  await settings.getByLabel('Codex 供应商模式').selectOption('native');
  await settings.getByRole('button', { name: '应用供应商设置' }).click();
  return settings;
}

for (const [result, failure] of [
  ['exit', '连接器已退出（代码 1）。'],
  ['rejected', '工作台拒绝了本次实例登记。'],
  ['offline', '原生 Agent 未完成握手。'],
  ['no-scope', '实例登记未确认有效的原生运行范围。'],
  ['stale-generation', '未取得本次新连接的登记信息。']
]) {
  test(`Codex ${result} 保留已保存状态并可测试重连`, async ({ page, workbench }) => {
    const settings = await applyCodexNative(page, workbench, result);
    await expect(settings).toContainText('供应商配置已保存。' + failure);
    await expect(settings.getByText(/连接已确认可用|已应用并重连/)).toHaveCount(0);
    await settings.getByRole('button', { name: '执行实例与工作区' }).click();
    await settings.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(settings).toContainText('本次实例登记已确认。');
    await expect(settings).toContainText('在线 · 已握手');
  });
}

test('Codex 等待本代握手，旧心跳不代替成功登记', async ({ page, workbench }) => {
  await page.clock.install();
  await page.route('**/api/v1/instances', async route => {
    const upstream = await route.fetch();
    const [fixture] = await upstream.json();
    await route.fulfill({ response: upstream, json: [fixture, {
      ...fixture, id: 'codex-local', name: 'Codex', adapterKey: 'codex', lastSeen: new Date().toISOString(), online: true
    }] });
  });
  const settings = await applyCodexNative(page, workbench, 'pending');
  await expect(settings).toContainText('正在等待本次连接登记');
  await page.clock.fastForward(46_000);
  await expect(settings).toContainText('等待本次连接登记超时，状态待核对。');
  await expect(settings.getByText(/连接已确认可用|已应用并重连/)).toHaveCount(0);
});

test('Codex 慢连接只在登记后成功，关闭设置会停止等待', async ({ page, workbench }) => {
  const settings = await applyCodexNative(page, workbench, 'pending');
  await expect(settings).toContainText('正在等待本次连接登记');
  await page.evaluate(() => { window.registrationState = 'ready'; });
  await expect(settings).toContainText('Codex 本次连接已确认可用。');
  await settings.getByLabel('Codex 供应商模式').selectOption('official');
  await settings.getByRole('button', { name: '应用供应商设置' }).click();
  await expect(settings).toContainText('正在等待本次连接登记');
  await settings.locator('.dialog-foot').getByRole('button', { name: '关闭' }).click();
  const reads = await page.evaluate(() => window.registrationReads);
  await page.clock.install();
  await page.clock.fastForward(50_000);
  expect(await page.evaluate(() => window.registrationReads)).toBe(reads);
  await expect(page.locator('#notice')).toBeHidden();
});

test('Hermes 重新扫描区分启动器与握手，可预填新实例但需手动保存', async ({ page, workbench }) => {
  await page.addInitScript(() => {
    let attempts = 0;
    window.savedHermes = [];
    const candidate = { command: 'C:/Hermes with spaces/hermes.exe', configurationHome: 'C:/Hermes profile', profileId: 'default', found: true };
    window.maoqiuDesktop = {
      settings: async () => ({ file: 'C:/fixture/connector.json', workspace: 'C:/workspace', editable: true, instances: [] }),
      agentManagerStatus: async () => ({ available: false, active: false }),
      discoverHermes: async () => ({ editable: true, candidates: attempts++ ? [candidate] : [] }),
      probeHermes: async () => ({ status: 'failed', detail: 'ACP 握手失败，请核对 Hermes 安装。' }),
      saveInstance: async value => { window.savedHermes.push(value); },
      agentMonitor: async () => ({ fetchedAt: new Date().toISOString(), usage: [], instances: [] })
    };
  });
  await workbench.login();
  await page.locator('#session').getByRole('button', { name: 'Agent 设置', exact: true }).click();
  const settings = page.getByRole('dialog');
  await settings.getByRole('button', { name: '执行实例与工作区' }).click();
  const scan = settings.getByRole('button', { name: '重新扫描 Hermes' });
  await scan.click();
  await expect(settings).toContainText('未找到 Hermes 启动器。');
  await scan.click();
  await expect(settings).toContainText('已找到启动器，等待 ACP 验证。');
  await settings.getByRole('button', { name: '测试 ACP 握手' }).click();
  await expect(settings).toContainText('ACP 握手失败，请核对 Hermes 安装。');
  await expect(settings.getByText('在线 · 已握手')).toHaveCount(0);
  await settings.getByRole('button', { name: '添加为新实例' }).click();
  await expect(settings.getByLabel('官方可执行程序名或完整路径')).toHaveValue('C:/Hermes with spaces/hermes.exe');
  await expect(settings.getByLabel('Agent 配置目录')).toHaveValue('C:/Hermes profile');
  expect(await page.evaluate(() => window.savedHermes)).toEqual([]);
  await settings.getByRole('button', { name: '保存实例' }).click();
  await expect.poll(async () => (await page.evaluate(() => window.savedHermes)).length).toBe(1);
});
