import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base, expect } from '@playwright/test';
import WebSocket from 'ws';
import { startServer } from '../server/index.ts';

const test = base.extend({
  workbench: async ({ page }, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'maoqiu-ux-reg-'));
    const app = startServer({ port: 0, dataDir: dir, chat: false });
    const errors = [];
    const receivedFrames = [];
    let socket;
    page.on('pageerror', error => errors.push(error.message));
    try {
      await once(app.server, 'listening');
      const baseUrl = 'http://127.0.0.1:' + app.server.address().port;
      const api = async (path, body, method = body ? 'POST' : 'GET') => {
        const response = await fetch(baseUrl + '/api/v1' + path, {
          method,
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
      socket.on('message', raw => {
        try { receivedFrames.push(JSON.parse(String(raw))); } catch {}
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
      await expect.poll(async () => (await api('/instances')).some(i => i.id === instanceId && i.online)).toBe(true);
      await use({
        api,
        app,
        baseUrl,
        dir,
        instanceId,
        socket,
        receivedFrames,
        login: () => page.goto(baseUrl + '/login?ticket=' + app.ticket)
      });
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

test('表单保存后全局 Toast 可见且嵌套 confirmDialog 不破坏底层列表弹窗', async ({ page, workbench }) => {
  const { api, login } = workbench;
  const mockModel = createServer(async (req, res) => {
    for await (const _ of req) {}
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
  mockModel.listen(0, '127.0.0.1');
  await once(mockModel, 'listening');
  try {
    await api('/chat/models', {
      action: 'save',
      name: '可删模型',
      baseUrl: 'http://127.0.0.1:' + mockModel.address().port + '/v1',
      model: 'm1',
      protocol: 'openai-compatible'
    });

    await login();
    const dialog = page.locator('#dialog');

    await page.locator('#tools').getByRole('button', { name: '设置' }).click();
    await dialog.getByRole('button', { name: '主聊人格' }).click();
    await dialog.getByLabel('当前使用默认人格').fill('我是更简洁的测试人格');
    await dialog.getByRole('button', { name: '保存人格' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('#notice')).toBeVisible();
    await expect(page.locator('#notice')).toContainText('人格将在下一轮生效。');

    await page.locator('#tools').getByRole('button', { name: '设置' }).click();
    await dialog.getByRole('button', { name: /主聊模型/ }).click();
    await expect(dialog.getByText('可删模型')).toBeVisible();
    await dialog.getByRole('button', { name: '删除配置' }).first().click();

    const confirm = page.locator('#confirm-dialog');
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: '取消' }).click();
    await expect(confirm).not.toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('可删模型')).toBeVisible();
  } finally {
    await new Promise(resolveClose => mockModel.close(resolveClose));
  }
});

test('不显示空白 completed 幽灵气泡，403 授权令牌可安全防死锁与清除', async ({ page, workbench }) => {
  const { api, baseUrl, instanceId, login, receivedFrames, socket } = workbench;
  const project = await api('/projects', { name: '防死锁与渲染项目' });
  const grant = await api('/grants', { projectId: project.id });

  const { thread } = await api('/threads', {
    instanceId,
    firstMessage: { text: '请给出简短回应' }
  });
  await expect.poll(() => receivedFrames.find(f => f.type === 'command' && f.command?.threadId === thread.id)).toBeTruthy();
  const cmd = receivedFrames.find(f => f.type === 'command' && f.command?.threadId === thread.id).command;
  const sendEvent = (seq, kind, data) => socket.send(JSON.stringify({
    type: 'event',
    event: {
      key: cmd.id + '-ev-' + seq,
      seq,
      instanceId,
      runId: cmd.runId,
      commandId: cmd.id,
      kind,
      data
    }
  }));
  sendEvent(1, 'accepted', {});
  sendEvent(2, 'message', { text: '这是实际正文字段' });
  sendEvent(3, 'completed', {});
  await expect.poll(async () => (await api('/threads/' + thread.id)).run?.status).toBe('completed');

  await login();
  await page.goto(baseUrl + '/#chat?thread=' + thread.id);
  await expect(page.locator('#content')).toContainText('这是实际正文字段');
  await expect(page.locator('#content .msg:visible')).toHaveCount(2);

  await page.locator('#session').getByRole('button', { name: '访问凭据' }).click();
  const dialog = page.locator('#dialog');
  await dialog.getByLabel('访问令牌（ownerToken）').fill(grant.token);
  await dialog.getByRole('button', { name: '连接' }).click();
  await expect(dialog).toContainText('受限项目授权');

  await dialog.getByRole('button', { name: '取消' }).click();
  await page.evaluate(token => { sessionStorage.setItem('mao-token', token); }, grant.token);
  await page.reload();
  const clearBtn = page.getByRole('button', { name: '清除本地令牌并重试' });
  await expect(clearBtn).toBeVisible();
  await clearBtn.click();
  await expect(page.locator('#content')).toContainText('这是实际正文字段');
});

test('命令面板关闭与 ARIA 完整，窄屏 390x844 顶栏标题不挤压且 Esc 收起右侧面板', async ({ page, workbench }) => {
  const { login } = workbench;
  await login();

  await page.keyboard.press('Control+k');
  const palette = page.locator('#palette');
  await expect(palette).toBeVisible();
  await expect(palette.getByRole('combobox', { name: '搜索工作台' })).toBeVisible();
  await expect(palette.getByRole('listbox', { name: '搜索结果' })).toBeVisible();
  await expect(palette.locator('[role="option"]').first()).toBeVisible();
  await palette.getByRole('button', { name: '关闭搜索' }).click();
  await expect(palette).not.toBeVisible();

  await page.locator('#cmd-btn').click();
  await expect(palette).toBeVisible();
  await page.mouse.click(2, 2);
  await expect(palette).not.toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  const headingBox = await page.locator('.topbar .heading').boundingBox();
  expect(headingBox).not.toBeNull();
  expect(headingBox.width).toBeGreaterThanOrEqual(100);

  await page.locator('#inspector-btn').click();
  await expect(page.locator('#inspector')).toBeVisible();
  await expect(page.locator('#shade')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#inspector')).toBeHidden();
  await expect(page.locator('#shade')).toBeHidden();
});

test('Home 渲染 Markdown 表格与代码，空间编辑支持返回上一步，提醒使用 datetime-local 与浏览器 Bot 监控', async ({ page, workbench }) => {
  const { api, baseUrl, login } = workbench;
  const project = await api('/projects', { name: 'Home 与空间项目' });
  await api('/submissions', {
    projectId: project.id,
    source: { title: '格式样本', text: '原始段落' },
    records: [{
      type: 'note',
      body: '| 字段 | 说明 |\n| --- | --- |\n| state | `active` |',
      confirmation: 'user'
    }]
  });

  await login();
  await page.goto(baseUrl + '/#home?project=' + project.id);
  await expect(page.locator('#content .record .md table')).toBeVisible();
  await expect(page.locator('#content .record .md code')).toContainText('active');

  await page.getByRole('button', { name: '空间设置' }).click();
  const dialog = page.locator('#dialog');
  await expect(dialog.getByRole('heading', { name: '空间设置' })).toBeVisible();
  await dialog.getByRole('button', { name: '编辑页面' }).click();
  await expect(dialog.getByRole('heading', { name: '编辑页面' })).toBeVisible();
  await dialog.getByRole('button', { name: '返回上一步' }).click();
  await expect(dialog.getByRole('heading', { name: '空间设置' })).toBeVisible();
  await dialog.locator('.dialog-foot').getByRole('button', { name: '关闭' }).click();

  await page.locator('#side').getByRole('button', { name: 'Bot 监控' }).click();
  await expect(dialog.getByRole('heading', { name: 'Bot 监控' })).toBeVisible();
  await expect(dialog).toContainText('合成工作 Bot');
  await expect(dialog).toContainText('可接任务');
  await dialog.locator('.dialog-foot').getByRole('button', { name: '关闭' }).click();

  await page.goto(baseUrl + '/#chat');
  await page.locator('#tools').getByRole('button', { name: '设置' }).click();
  await dialog.getByRole('button', { name: '事项与提醒' }).click();
  await dialog.getByRole('button', { name: '新增事项' }).click();
  await dialog.getByLabel('类型').selectOption('reminder');
  await dialog.getByLabel('内容').fill('检验 datetime-local 提醒');
  await dialog.locator('input[type="datetime-local"]').fill('2026-12-01T09:30');
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toContainText('检验 datetime-local 提醒');

  const main = await api('/threads/main');
  const daily = await api('/chat/daily?threadId=' + main.id);
  const created = daily.items.find(i => i.body === '检验 datetime-local 提醒');
  expect(created).toBeTruthy();
  expect(Date.parse(created.dueAt)).toBe(new Date('2026-12-01T09:30').getTime());
});
