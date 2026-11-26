import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base, expect } from '@playwright/test';
import WebSocket from 'ws';
import { startServer } from '../server/index.ts';

const test = base.extend({
  workbench: async ({ page }, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'maoqiu-browser-'));
    const app = startServer({ port: 0, dataDir: dir, chat: false });
    const errors = [];
    const sockets = [];
    const streams = [];
    app.server.on('request', (req, res) => {
      if (req.url.startsWith('/api/v1/events?')) streams.push({ res, after: Number(new URL(req.url, 'http://localhost').searchParams.get('after')) });
    });
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
      const registerBots = async (...names) => {
        const ws = new WebSocket(baseUrl.replace('http:', 'ws:') + '/api/v1/node', {
          headers: { Authorization: 'Bearer ' + app.auth.cfg.nodes.local }
        });
        sockets.push(ws);
        await once(ws, 'open');
        const instances = names.map(value => {
          const id = typeof value === 'string' ? value : value.id;
          return {
            id, name: id, adapterKey: 'dsh', workspaceRef: join(dir, id), availableActions: ['run', 'cancel', 'answer', 'prepare'],
            models: [{ id: 'model-a', label: 'Fixture Model A' }, { id: 'model-b', label: 'Fixture Model B' }],
            ...(typeof value === 'object' ? value : {})
          };
        });
        ws.send(JSON.stringify({ type: 'hello', instances, cancelBeforeStart: true }));
        await expect.poll(async () => (await api('/instances')).filter(i => i.online).length).toBe(instances.length + 1);
        return { ws, instances };
      };
      await use({ api, app, baseUrl, registerBots, streams, login: () => page.goto(baseUrl + '/login?ticket=' + app.ticket) });
      expect(errors).toEqual([]);
    } finally {
      for (const socket of sockets) socket.terminate();
      const close = app.close();
      app.server.closeAllConnections();
      await close;
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
});

const input = page => page.getByRole('textbox', { name: '消息内容' });
const send = page => page.getByRole('button', { name: '发送', exact: true });
const threadButton = (page, name) => page.locator('#side-list').getByRole('button', { name, exact: true });
const snapshot = (api, id) => api('/threads/' + id);

async function addFile(page) {
  await page.locator('#compose input[type=file]').setInputFiles({
    name: 'sample.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic data')
  });
}

async function delayAttachment(page) {
  const started = Promise.withResolvers();
  const proceed = Promise.withResolvers();
  await page.route('**/api/v1/attachments', async route => {
    const response = await route.fetch();
    started.resolve();
    await proceed.promise;
    await route.fulfill({ response });
  }, { times: 1 });
  return { started: started.promise, resume: proceed.resolve };
}

test('附件响应延迟时固定主会话发送仍属于原会话，侧聊草稿保留', async ({ page, workbench }) => {
  const { api, login } = workbench;
  const main = await api('/threads/main');
  const side = await api('/threads', { title: '侧边测试话题' });
  await login();
  await threadButton(page, side.title).click();
  await input(page).fill('侧聊未发送草稿');
  await threadButton(page, '主会话').click();
  await input(page).fill('带有附件的主会话消息');
  await addFile(page);
  const attachment = await delayAttachment(page);
  await send(page).click();
  try {
    await attachment.started;
    await threadButton(page, side.title).click();
    await expect(input(page)).toHaveValue('侧聊未发送草稿');
  } finally {
    attachment.resume();
  }
  await expect.poll(async () => (await snapshot(api, main.id)).messages.map(m => m.text)).toContain('带有附件的主会话消息');
  expect((await snapshot(api, side.id)).messages).toEqual([]);
  await expect(page).toHaveURL(new RegExp('thread=' + side.id + '$'));
  await expect(input(page)).toHaveValue('侧聊未发送草稿');
});

test('首次发送已提交但响应中断时复用请求和附件', async ({ page, workbench }) => {
  const { api, login } = workbench;
  await login();
  await page.evaluate(() => { location.hash = '#chat?instance=main&draft=1'; });
  await expect(page.getByText(/首次发送时创建/)).toBeVisible();
  await input(page).fill('响应丢失后重试');
  await addFile(page);
  const bodies = [];
  await page.route('**/api/v1/threads', async route => {
    bodies.push(route.request().postDataJSON());
    const response = await route.fetch();
    if (bodies.length === 1) await route.abort();
    else await route.fulfill({ response });
  });
  await send(page).click();
  await expect(page.getByText(/Failed to fetch|请求失败/).first()).toBeVisible();
  await expect(input(page)).toHaveValue('响应丢失后重试');
  await send(page).click();
  await expect(input(page)).toHaveValue('');
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  const created = (await api('/threads')).filter(t => t.kind === 'side');
  expect(created).toHaveLength(1);
  expect((await snapshot(api, created[0].id)).messages.filter(m => m.role === 'user')).toHaveLength(1);
});

test('首次发送固定原 Bot、工作区与模型，切到毛球之家及另一草稿后不抢焦点', async ({ page, workbench }) => {
  const { api, registerBots, login } = workbench;
  const { ws, instances } = await registerBots('Bot-A', 'Bot-B');
  const projects = await Promise.all(['项目甲', '项目乙'].map(name => api('/projects', { name })));
  for (const [index, project] of projects.entries()) {
    const { id, workspaceRef } = instances[index];
    await api('/projects/' + project.id + '/workspaces', { instanceId: id, workspaceRef });
  }
  const commands = [];
  ws.on('message', raw => {
    const frame = JSON.parse(raw);
    if (frame.type !== 'command') return;
    const command = frame.command;
    if (commands.some(received => received.id === command.id)) return;
    commands.push(command);
    const sessionId = 'fixture-' + command.instanceId;
    for (const [index, [kind, data]] of [
      ['accepted', { sessionId, nativeRunId: 'turn-a' }],
      ['message', { text: '合成原生答复', sessionId }],
      ['completed', { sessionId }]
    ].entries()) ws.send(JSON.stringify({ type: 'event', event: {
      key: command.id + ':' + index, commandId: command.id, seq: index + 1, kind, runId: command.runId,
      threadId: command.threadId, instanceId: command.instanceId, taskId: command.taskId, data
    } }));
  });
  const draftRoute = (id, projectId) => '#chat?instance=' + id + '&project=' + projectId + '&draft=1';
  const a = draftRoute('Bot-A', projects[0].id);
  const b = draftRoute('Bot-B', projects[1].id);
  await login();
  await page.evaluate(hash => { location.hash = hash; }, a);
  await page.getByRole('button', { name: '选择首轮模型' }).click();
  await page.getByLabel('首轮模型').selectOption('model-b');
  await page.getByRole('button', { name: '确定', exact: true }).click();
  await input(page).fill('原生首轮仅发送到 Bot-A');
  await addFile(page);
  const gate = await delayAttachment(page);
  await send(page).click();
  try {
    await gate.started;
    await expect(send(page)).toBeDisabled();
    await input(page).press('Enter');
    await page.getByRole('button', { name: '毛球之家', exact: true }).click();
    await expect(page.locator('#heading')).toHaveText('项目与空间目录');
    await page.evaluate(hash => { location.hash = hash; }, b);
    await expect(page.getByLabel('新话题所属范围')).toHaveValue(projects[1].id);
    await input(page).fill('另一个 Bot 的草稿');
  } finally {
    gate.resume();
  }
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({ instanceId: 'Bot-A', payload: { modelId: 'model-b' } });
  const [thread] = await api('/threads?instanceId=Bot-A');
  expect(thread.projectId).toBe(projects[0].id);
  await expect.poll(async () => (await snapshot(api, thread.id)).thread.sessionId).toBe('fixture-Bot-A');
  expect(await api('/threads?instanceId=Bot-B')).toHaveLength(0);
  await expect(page).toHaveURL(baseUrl => baseUrl.hash === b);
  await expect(input(page)).toHaveValue('另一个 Bot 的草稿');
});

test('项目范围切换保留原附件，且不会带入另一项目草稿', async ({ page, workbench }) => {
  const { api, login } = workbench;
  const a = await api('/projects', { name: '项目甲' });
  const b = await api('/projects', { name: '项目乙' });
  await login();
  await page.evaluate(id => { location.hash = '#chat?instance=main&project=' + id + '&draft=1'; }, a.id);
  await expect(page.getByLabel('新话题所属范围')).toHaveValue(a.id);
  await input(page).fill('甲项目草稿');
  await addFile(page);
  await page.getByLabel('新话题所属范围').selectOption(b.id);
  await expect(input(page)).toHaveValue('');
  await expect(page.getByRole('button', { name: 'sample.txt ×' })).toHaveCount(0);
  await input(page).fill('乙项目消息');
  await send(page).click();
  await expect(input(page)).toHaveValue('');
  const [thread] = await api('/threads?projectId=' + b.id);
  const [message] = (await snapshot(api, thread.id)).messages;
  expect(message.data.attachmentIds).toEqual([]);
  await page.evaluate(id => { location.hash = '#chat?instance=main&project=' + id + '&draft=1'; }, a.id);
  await expect(page.getByLabel('新话题所属范围')).toHaveValue(a.id);
  await expect(input(page)).toHaveValue('甲项目草稿');
  await expect(page.getByRole('button', { name: 'sample.txt ×' })).toBeVisible();
});

test('委派表单异步创建来源话题时仍绑定原项目', async ({ page, workbench }) => {
  const { api, registerBots, login } = workbench;
  const { instances: [bot] } = await registerBots('Bot-A');
  const a = await api('/projects', { name: '委派来源项目' });
  const b = await api('/projects', { name: '当前页面项目' });
  await api('/projects/' + a.id + '/workspaces', { instanceId: bot.id, workspaceRef: bot.workspaceRef });
  const draftRoute = id => '#chat?instance=main&project=' + id + '&draft=1';
  await login();
  await page.evaluate(hash => { location.hash = hash; }, draftRoute(a.id));
  await expect(page.getByLabel('新话题所属范围')).toHaveValue(a.id);
  await page.locator('#tools').getByRole('button', { name: '委派任务' }).click();
  await page.getByLabel('任务目标').fill('来源项目固定样例');
  await expect(page.getByRole('combobox', { name: '所属项目', exact: true })).toHaveValue(a.id);
  const started = Promise.withResolvers();
  const proceed = Promise.withResolvers();
  await page.route('**/api/v1/threads', async route => {
    const response = await route.fetch();
    started.resolve();
    await proceed.promise;
    await route.fulfill({ response });
  }, { times: 1 });
  await page.getByRole('button', { name: '派发任务' }).click();
  try {
    await started.promise;
    await page.evaluate(hash => { location.hash = hash; }, draftRoute(b.id));
  } finally { proceed.resolve(); }
  await expect(page.getByRole('dialog', { name: '工作台操作' })).toBeHidden();
  await expect(page).toHaveURL(url => url.hash === draftRoute(b.id));
  const [origin] = await api('/threads?instanceId=main&projectId=' + a.id);
  const card = (await snapshot(api, origin.id)).messages.find(item => item.kind === 'task_card');
  expect(card.text).toBe('来源项目固定样例');
  const { task } = await api('/tasks/' + card.taskId);
  expect(task).toMatchObject({ originThreadId: origin.id, instanceId: bot.id, projectId: a.id });
  expect(await api('/threads?instanceId=main&projectId=' + b.id)).toHaveLength(0);
});

test('恢复确认弹窗期间切换会话，确认仍只用于原话题和原运行', async ({ page, workbench }) => {
  const { api, registerBots, login } = workbench;
  const { ws, instances: [bot] } = await registerBots('Bot-A');
  const commands = [];
  ws.on('message', raw => {
    const frame = JSON.parse(raw);
    if (frame.type === 'command' && !commands.some(command => command.id === frame.command.id)) commands.push(frame.command);
  });
  const { thread, receipt } = await api('/threads', {
    instanceId: bot.id, title: '原生恢复样例', firstMessage: { text: '待核对旧运行' }
  });
  const side = await api('/threads', { title: '不接收原生确认' });
  await expect.poll(() => commands.length).toBe(1);
  ws.send(JSON.stringify({ type: 'receipt', commandId: commands[0].id, status: 'uncertain' }));
  await expect.poll(async () => (await snapshot(api, thread.id)).run?.status).toBe('uncertain');
  await api('/runs/' + receipt.runId + '/recovery', { action: 'abandon', acknowledge: true, reason: '合成待核对状态' });
  await login();
  await page.evaluate(id => { location.hash = '#chat?thread=' + id; }, thread.id);
  await expect(page.locator('#heading')).toHaveText(thread.title);
  await input(page).fill('确认后只发送给原 Bot');
  let confirmed;
  await page.route('**/api/v1/threads/' + thread.id + '/messages', route => {
    confirmed = route.request().postDataJSON();
    return route.continue();
  });
  await send(page).click();
  const dialog = page.getByRole('dialog', { name: '工作台操作' });
  await expect(dialog).toContainText('原生恢复样例');
  await page.evaluate(id => { location.hash = '#chat?thread=' + id; }, side.id);
  await expect(page.locator('#heading')).toHaveText(side.title);
  await dialog.getByRole('button', { name: '确认发送' }).click();
  await expect.poll(async () => (await snapshot(api, thread.id)).messages.map(message => message.text)).toContain('确认后只发送给原 Bot');
  expect(confirmed).toMatchObject({ acknowledge: true, acknowledgeRunId: receipt.runId });
  expect((await snapshot(api, side.id)).messages).toEqual([]);
  await expect(page).toHaveURL(url => url.hash.endsWith(side.id));
});

test('原生模型准备排队期间显示等待并仅取消对应准备运行', async ({ page, workbench }) => {
  const { api, registerBots, login } = workbench;
  const { ws, instances: [bot] } = await registerBots({ id: 'Bot-A', models: [] });
  const commands = new Map();
  ws.on('message', raw => {
    const { command } = JSON.parse(raw);
    if (command && !commands.has(command.kind)) commands.set(command.kind, command);
  });
  const thread = await api('/threads', { instanceId: bot.id, title: '模型排队样例' });
  await login();
  await page.evaluate(id => { location.hash = '#chat?thread=' + id; }, thread.id);
  await page.getByRole('button', { name: '读取会话模型', exact: true }).click();
  await expect(page.getByText('等待工作区执行模型读取…')).toBeVisible();
  await expect.poll(() => commands.get('prepare')?.threadId).toBe(thread.id);
  await page.getByRole('button', { name: '取消读取', exact: true }).click();
  await expect.poll(() => commands.get('cancel')?.runId).toBe(commands.get('prepare').runId);
  const { id, runId, threadId, instanceId } = commands.get('prepare');
  ws.send(JSON.stringify({ type: 'event', event: {
    key: id + ':1', commandId: id, seq: 1, kind: 'cancelled', runId, threadId, instanceId,
    data: { summary: '合成队列项已取消' }
  } }));
  await expect.poll(async () => (await snapshot(api, thread.id)).run?.status).toBe('cancelled');
  await expect(page.getByRole('button', { name: '重试读取模型', exact: true })).toBeVisible();
});

test('多 Bot 的会话事件仅刷新对应列表，SSE 重连补齐持久消息', async ({ page, workbench }) => {
  const { api, registerBots, streams, login } = workbench;
  await registerBots('Bot-A', 'Bot-B', 'Bot-C');
  const main = await api('/threads/main');
  const calls = [];
  page.on('request', request => {
    if (request.method() === 'GET' && request.url().includes('/api/v1/')) calls.push(new URL(request.url()));
  });
  await login();
  await expect.poll(() => streams.length).toBe(1);
  const bootPages = calls.filter(u => u.pathname === '/api/v1/threads');
  expect(bootPages).toHaveLength(4);
  expect(bootPages.every(u => u.searchParams.get('state') === 'active')).toBe(true);
  calls.length = 0;
  await api('/threads', { title: '局部刷新样例' });
  await expect(threadButton(page, '局部刷新样例')).toBeVisible();
  const threadPages = calls.filter(u => u.pathname === '/api/v1/threads');
  expect(threadPages.map(u => u.searchParams.get('instanceId'))).toEqual(['main']);
  expect(calls).toHaveLength(1);

  await input(page).fill('重连期间的本地草稿');
  const receipt = await api('/threads/' + main.id + '/messages', { text: '重连前的持久消息' });
  await expect(page.locator('#content')).toContainText('重连前的持久消息');
  const stream = streams[0].res;
  stream.write('data: ' + JSON.stringify({ kind: 'chat_delta', threadId: main.id, messageId: receipt.messageId, text: '暂存预览' }) + '\n\n');
  await expect(page.locator('#chat-preview')).toHaveText('暂存预览');
  stream.end();
  await expect(page.locator('#chat-preview')).toBeHidden();
  await api('/chat/cancel', { messageId: receipt.messageId });
  await api('/threads/' + main.id + '/messages', { text: '断线期间的持久消息' });
  await expect(page.locator('#content')).toContainText('断线期间的持久消息', { timeout: 10000 });
  expect(streams[1].after).toBeGreaterThan(streams[0].after);
  streams[1].res.write('data: ' + JSON.stringify({ kind: 'chat_delta', threadId: main.id, messageId: receipt.messageId, text: '旧内容' }) + '\n\n');
  await expect(page.locator('#chat-preview')).toBeHidden();
  await expect(input(page)).toHaveValue('重连期间的本地草稿');
});

test('重新打开的消息支持带属性围栏、表格与嵌套任务列表', async ({ page, workbench }) => {
  const { api, login } = workbench;
  const text = [
    '````python title="example.py"', 'print("hello")', '```', '````', '',
    '| 名称 | 状态 |', '| --- | --- |', '| **工作台** | *正常* |', '',
    '- [x] 已完成', '  - [ ] 待复核', '', '> 引用 `片段`', '',
    '<strong>原始 HTML</strong>', '', '![图片](https://example.com/image.png)', '',
    '[本地文件](file:///C:/example.txt)', '', '[公开文档](https://example.com/docs)', '',
    '```text highlight=1', '未闭合围栏', '长'.repeat(10_000)
  ].join('\r\n');
  const { thread } = await api('/threads', { title: 'Markdown 样例', firstMessage: { text } });
  await login();
  await threadButton(page, thread.title).click();
  const md = page.locator('.msg.user .md');
  await expect(md.locator('.code-block').first()).toContainText('print("hello")');
  await expect(md.locator('.code-block').last()).toContainText('未闭合围栏');
  await expect(md.getByRole('table')).toContainText('工作台');
  await expect(md.locator('li li input')).toBeDisabled();
  await expect(md.locator('blockquote code')).toHaveText('片段');
  await expect(md).toContainText('<strong>原始 HTML</strong>');
  await expect(md.locator('img')).toHaveCount(0);
  await expect(md.getByRole('link')).toHaveCount(1);
  await expect(md.getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer');
});
