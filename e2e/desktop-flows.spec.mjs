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
