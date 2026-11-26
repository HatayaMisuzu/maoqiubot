import {
  $, api, at, banner, btn, confirmDialog, currentTheme, displayDialog, el,
  findThreadAny, form, headers, icon, initTheme, isMac, items, localFlag,
  notice, setLocalFlag, state, toggleTheme, url
} from './lib.js';
import { createSidebar } from './sidebar.js';
import { createInspector } from './inspector.js';
import { createCommandPalette } from './command-palette.js';
import { chat } from './chat.js';
import { home } from './home.js';
import { desktopSettings, hasDesktopSettings } from './desktop-settings.js';
import { mainModels } from './main-settings.js';

initTheme();

let revision = 0;
let catalogQueue = Promise.resolve();
let observedRoute;
let cursor = 0;
let subscription;
let refreshTimer;
let retryTimer;
let connection = '正在连接';
let inspectorOpen = localFlag('mao-inspector-open', window.innerWidth > 1180) === true;

const threadOffsets = new Map();
const threadHasMore = new Map();
const loadedArchives = new Set();

function applySavedSideWidth() {
  const saved = Number(localFlag('mao-side-width', 276));
  if (Number.isFinite(saved) && saved >= 220 && saved <= 420) {
    document.documentElement.style.setProperty('--side-width', saved + 'px');
  }
}
applySavedSideWidth();

function updateThemeButton() {
  const b = $('theme-btn');
  if (!b) return;
  const dark = currentTheme() === 'dark';
  b.replaceChildren(icon(dark ? 'sun' : 'moon'));
  b.title = dark ? '切换为浅色模式' : '切换为深色模式';
  b.setAttribute('aria-label', b.title);
}

const actions = {
  load,
  refresh,
  renderChrome,
  go,
  openThread,
  openDraft,
  openWorkDraft,
  openHome,
  selectBot,
  newThread: id => chats.newThread(id),
  delegateTask: () => chats.delegate(),
  openChatSettings: () => chats.chatSettings(findThreadAny(state.thread)),
  openDesktopSettings: () => desktopSettings(onSettingsChanged),
  openMainModels: () => mainModels(refresh, load),
  openThreadMenu: thread => chats.threadMenu(thread),
  openTask: id => chats.openTask(id),
  editPersona: () => chats.editPersona(),
  resetContext: thread => chats.resetContext(thread),
  editThreadBudget: thread => chats.editThreadBudget(thread),
  replaceNative: thread => chats.replaceNative(thread),
  botSettings: agent => chats.botSettings(agent),
  findThreads,
  nativeCatalog,
  showBotArchive,
  loadArchives,
  restoreThread,
  manageDeleted,
  loadMoreThreads,
  hasMore: id => Boolean(threadHasMore.get(id)),
  loadOlder,
  createProject: () => house.createProject(),
  toggleInspector,
  isInspectorOpen: () => inspectorOpen,
  updateThemeButton,
  onSettingsChanged,
  current: id => revision === id
};

const sidebarUi = createSidebar(actions);
const inspectorUi = createInspector(actions);
const paletteUi = createCommandPalette(actions);
const chats = chat(actions);
const house = home(actions);

$('mark').append(icon('yarn'));
$('menu').append(icon('menu'));
$('cmd-btn').append(icon('search'));
$('inspector-btn').append(icon('panelRight'));
updateThemeButton();

$('menu').onclick = () => toggleMobileSidebar(true);
$('shade').onclick = () => toggleMobileSidebar(false);
$('cmd-btn').onclick = () => paletteUi.open();
$('theme-btn').onclick = () => { toggleTheme(); updateThemeButton(); };
$('inspector-btn').onclick = () => toggleInspector();

const narrow = matchMedia('(max-width: 820px)');
function toggleMobileSidebar(open) {
  const wasOpen = document.body.classList.contains('open');
  document.body.classList.toggle('open', open);
  $('side').inert = narrow.matches && !open;
  document.querySelector('main').inert = open;
  $('shade').hidden = !open;
  $('menu').setAttribute('aria-expanded', String(open));
  if (open) $('side').querySelector('button:not(:disabled)')?.focus();
  else if (wasOpen && narrow.matches) $('menu').focus();
}
narrow.addEventListener('change', () => toggleMobileSidebar(false));
toggleMobileSidebar(false);

function toggleInspector(force) {
  inspectorOpen = typeof force === 'boolean' ? force : !inspectorOpen;
  setLocalFlag('mao-inspector-open', inspectorOpen);
  inspectorUi.render();
}

// Sidebar width drag resizer
(() => {
  const resizer = $('side-resizer');
  if (!resizer) return;
  let dragging = false;
  resizer.addEventListener('pointerdown', e => {
    if (narrow.matches) return;
    dragging = true;
    resizer.classList.add('dragging');
    resizer.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  resizer.addEventListener('pointermove', e => {
    if (!dragging) return;
    const width = Math.max(220, Math.min(420, Math.round(e.clientX)));
    document.documentElement.style.setProperty('--side-width', width + 'px');
    setLocalFlag('mao-side-width', width);
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
  };
  resizer.addEventListener('pointerup', endDrag);
  resizer.addEventListener('pointercancel', endDrag);
  resizer.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--side-width'), 10) || 276;
    const next = Math.max(220, Math.min(420, current + (e.key === 'ArrowRight' ? 12 : -12)));
    document.documentElement.style.setProperty('--side-width', next + 'px');
    setLocalFlag('mao-side-width', next);
  });
})();

// Global keyboard shortcuts (Ctrl/Cmd+K, Ctrl/Cmd+I, Esc)
window.addEventListener('keydown', e => {
  const mod = isMac() ? e.metaKey : e.ctrlKey;
  if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    paletteUi.open();
    return;
  }
  if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'i') {
    if (state.view === 'chat') {
      e.preventDefault();
      toggleInspector();
    }
    return;
  }
  if (e.key === 'Escape' && !$('dialog').open && !$('palette').open && document.body.classList.contains('open')) {
    toggleMobileSidebar(false);
  }
});

function renderSessionFooter() {
  const dotCls = connection === '实时连接' ? 'dot live' : connection === '连接失败' || connection === '需要登录' ? 'dot error' : 'dot working';
  $('session').replaceChildren(
    el('div', 'session-status', el('i', dotCls), el('span', '', connection)),
    el('div', 'session-actions',
      ...(hasDesktopSettings() ? [btn('Agent 设置', () => desktopSettings(onSettingsChanged), 'ghost', 'sliders')] : []),
      btn('访问凭据', login, 'ghost', 'key')
    )
  );
}

function renderChrome() {
  sidebarUi.render();
  inspectorUi.render();
}

async function onSettingsChanged() {
  await load();
  renderChrome();
  await refresh();
}

function login() {
  form('连接工作台', [
    { key: 'token', label: '访问令牌', type: 'password', required: true }
  ], '连接', async ({ token }) => {
    const previous = sessionStorage.getItem('mao-token');
    sessionStorage.setItem('mao-token', token);
    try { await api('/projects'); }
    catch (e) {
      if (previous) sessionStorage.setItem('mao-token', previous);
      else sessionStorage.removeItem('mao-token');
      throw e;
    }
    await start();
  }, { compact: true });
}

function unauthorized() {
  subscription?.abort();
  ++revision;
  ++state.routeRevision;
  state.snapshot = null;
  chats.clearPreview();
  connection = '需要登录';
  renderSessionFooter();
  $('nav').replaceChildren();
  $('side-list').replaceChildren();
  $('inspector').hidden = true;
  $('stage').classList.add('inspector-closed');
  $('inspector-btn').hidden = true;
  $('status-banner').hidden = true;
  $('crumb').hidden = true;
  $('heading').textContent = '小毛球工作台';
  $('subhead').textContent = '';
  $('tools').replaceChildren();
  $('compose').replaceChildren();
  $('content').replaceChildren(el('div', 'connection-view',
    banner('连接你的', '小毛球工作台'),
    el('div', 'login-panel',
      el('p', 'muted', '使用访问令牌打开小毛球主控、工作 Bot 与毛球之家。'),
      btn('使用访问令牌', login, 'primary', 'key')
    )
  ));
}

function enqueueCatalog(update) {
  const next = catalogQueue.then(update);
  catalogQueue = next.catch(() => {});
  return next;
}

async function readThreads(instanceId, status, limit, offset = 0) {
  return items(await api('/threads?' + new URLSearchParams({ instanceId, state: status, limit, offset })));
}

async function readActivePrefix(instanceId) {
  const limit = Math.max(40, threadOffsets.get(instanceId) || 0);
  const found = [];
  while (found.length <= limit) {
    const size = Math.min(200, limit + 1 - found.length);
    const page = await readThreads(instanceId, 'active', size, found.length);
    found.push(...page);
    if (page.length < size) break;
  }
  return { rows: found.slice(0, limit), hasMore: found.length > limit };
}

const replaceAgentRows = (rows, id, next) => [...rows.filter(row => row.instanceId !== id), ...next];

async function readArchives(id) {
  const [archived, deleted] = await Promise.all([readThreads(id, 'archived', 20), readThreads(id, 'deleted', 20)]);
  state.archivedThreads = replaceAgentRows(state.archivedThreads, id, archived);
  state.deletedThreads = replaceAgentRows(state.deletedThreads, id, deleted);
}

function loadArchives(id) {
  return enqueueCatalog(async () => {
    await readArchives(id);
    loadedArchives.add(id);
  });
}

function load({ full = true, instances = false, projects = false, main = false, threadOwners = [] } = {}) {
  return enqueueCatalog(async () => {
    const [agents, mainThread, nextProjects] = await Promise.all([
      full || instances ? api('/instances').then(items) : state.instances,
      full || main ? api('/threads/main') : state.mainThread,
      full || projects ? api('/projects').then(items) : state.projects
    ]);
    const liveIds = new Set(agents.map(agent => agent.id));
    const targets = full ? liveIds : new Set(threadOwners.filter(id => liveIds.has(id)));
    for (const id of liveIds) if (!threadOffsets.has(id)) targets.add(id);
    const pages = await Promise.all([...targets].map(async id => [id, await readActivePrefix(id)]));
    if (full && localFlag('mao-fold:main-archive', false) === true) loadedArchives.add('main');
    await Promise.all([...targets].filter(id => loadedArchives.has(id)).map(readArchives));
    state.instances = agents;
    state.mainThread = mainThread;
    state.projects = nextProjects;
    state.threads = state.threads.filter(row => liveIds.has(row.instanceId));
    for (const id of threadOffsets.keys()) {
      if (!liveIds.has(id)) { threadOffsets.delete(id); threadHasMore.delete(id); }
    }
    for (const [id, { rows, hasMore }] of pages) {
      state.threads = replaceAgentRows(state.threads, id, rows);
      threadOffsets.set(id, rows.length);
      threadHasMore.set(id, hasMore);
    }
  });
}

function findThreads(agent) {
  const currentProject = state.snapshot?.thread?.projectId || state.project;
  const agentSelect = el('select');
  for (const inst of state.instances) {
    agentSelect.append(Object.assign(el('option', '', inst.name), { value: inst.id }));
  }
  if (agent && state.instances.some(i => i.id === agent.id)) agentSelect.value = agent.id;

  const search = el('input');
  search.type = 'search';
  search.maxLength = 120;
  search.placeholder = '输入会话标题关键词…';

  const space = el('select');
  const status = el('select');
  for (const [id, name] of [['all', '所有范围'], ['', '个人范围'], ...state.projects.map(p => [p.id, p.name])]) {
    space.append(Object.assign(el('option', '', name), { value: id }));
  }
  if (state.projects.some(p => p.id === currentProject)) space.value = currentProject;
  for (const [id, name] of [['active', '进行中及近期会话'], ['archived', '已归档']]) {
    status.append(Object.assign(el('option', '', name), { value: id }));
  }

  const results = el('div', 'settings-list');
  results.setAttribute('aria-live', 'polite');
  const more = btn('加载更早会话', () => loadPage(false), 'secondary btn-sm');
  more.hidden = true;

  const filterForm = el('form', '',
    el('div', 'record',
      el('label', 'field', el('span', 'field-label', '所属 Bot'), agentSelect),
      el('label', 'field', el('span', 'field-label', '会话名称'), search),
      el('label', 'field', el('span', 'field-label', '项目范围'), space),
      el('label', 'field', el('span', 'field-label', '状态'), status),
      el('div', 'actions', Object.assign(el('button', 'primary btn-sm', '搜索'), { type: 'submit' }))
    )
  );
  filterForm.onsubmit = event => {
    event.preventDefault();
    loadPage(true).catch(error => notice(error.message, 'error'));
  };

  let query, offset = 0, searchRev = 0, seen = new Set();
  async function loadPage(reset) {
    const serial = ++searchRev;
    if (reset) {
      offset = 0;
      seen = new Set();
      query = new URLSearchParams({ instanceId: agentSelect.value, state: status.value, q: search.value, limit: '25' });
      if (space.value !== 'all') query.set('projectId', space.value);
      results.replaceChildren(el('p', 'muted', '正在搜索…'));
      more.hidden = true;
    }
    query.set('offset', String(offset));
    const page = items(await api('/threads?' + query));
    if (serial !== searchRev || !$('dialog').open || !$('dialog').contains(results)) return;
    if (reset) results.replaceChildren();
    for (const thread of page) {
      if (seen.has(thread.id)) continue;
      seen.add(thread.id);
      const project = state.projects.find(p => p.id === thread.projectId)?.name || '个人范围';
      const row = btn(thread.title || '会话', () => {
        $('dialog').close();
        return openThread(thread.id);
      }, 'settings-row', thread.taskId ? 'task' : 'chat');
      row.append(el('span', 'settings-desc', [project, at(thread.lastActivity)].filter(Boolean).join(' · ')));
      results.append(row);
    }
    if (!seen.size) results.append(el('p', 'muted', '没有符合条件的会话。'));
    offset += page.length;
    more.hidden = page.length !== 25;
  }

  agentSelect.onchange = () => loadPage(true).catch(error => notice(error.message, 'error'));
  space.onchange = () => loadPage(true).catch(error => notice(error.message, 'error'));
  status.onchange = () => loadPage(true).catch(error => notice(error.message, 'error'));

  displayDialog('搜索会话', [filterForm, results], [more, btn('关闭', () => $('dialog').close(), 'ghost')], { wide: true });
  requestAnimationFrame(() => search.focus());
  return loadPage(true);
}

async function nativeCatalog(agent, projectId) {
  const routeRevision = state.routeRevision;
  const routeHash = location.hash;
  const allowed = agent.settings?.allowedProjects;
  const scopeOptions = Array.isArray(allowed)
    ? allowed.map(pid => state.projects.find(p => p.id === pid)).filter(Boolean).map(p => ({ id: p.id, name: '项目 · ' + p.name }))
    : [{ id: '', name: '个人范围' }, ...state.projects.map(p => ({ id: p.id, name: '项目 · ' + p.name }))];

  const currentPid = projectId ?? (state.snapshot?.thread?.projectId || state.project || '');
  const scopeSelect = el('select', '', ...scopeOptions.map(o => Object.assign(el('option', '', o.name), { value: o.id })));
  if (scopeOptions.some(o => o.id === currentPid)) scopeSelect.value = currentPid;

  const results = el('div', 'settings-list');
  const status = el('p', 'muted', '正在读取原生目录…');
  let cursorToken = null;
  let seen = new Set();
  let cursors = new Set();
  let reqRev = 0;

  const more = btn('加载更早原生会话', () => loadPage(), 'secondary btn-sm');
  more.hidden = true;

  async function loadPage(reset = false) {
    const rev = ++reqRev;
    if (reset) {
      cursorToken = null;
      seen = new Set();
      cursors = new Set();
      results.replaceChildren();
      more.hidden = true;
    }
    if (!agent.online) {
      status.textContent = '节点当前离线，恢复连接后可读取原生目录。';
      return;
    }
    if (!scopeOptions.length) {
      status.textContent = '此 Bot 暂无获准项目范围，无法读取原生目录。';
      return;
    }
    status.textContent = '正在读取原生目录…';
    const projectId = scopeSelect.value || null;
    const path = '/instances/' + url(agent.id) + '/sessions';
    const query = new URLSearchParams();
    if (projectId) query.set('projectId', projectId);
    if (cursorToken) query.set('cursor', cursorToken);

    try {
      const page = await api(path + (query.size ? '?' + query : ''));
      if (rev !== reqRev || !$('dialog').open || !$('dialog').contains(results)) return;
      for (const session of page.items) {
        if (seen.has(session.id)) continue;
        seen.add(session.id);
        results.append(el('div', 'record',
          el('div', 'record-head',
            el('strong', '', session.title || '原生会话'),
            session.active ? el('span', 'badge working', '原生端运行中') : null
          ),
          el('small', 'muted', [session.id, session.updatedAt ? at(session.updatedAt * 1000) : null].filter(Boolean).join(' · ')),
          agent.capabilities.sessionImport !== false && !session.active
            ? el('div', 'actions', btn('导入并打开', async () => {
              if (state.routeRevision !== routeRevision || location.hash !== routeHash) return;
              const dialog = $('dialog');
              const result = await api(path, {
                projectId,
                sessionId: session.id,
                title: (session.title || '导入的原生会话').slice(0, 120)
              });
              if (dialog.contains(results)) dialog.close();
              await load({ full: false, threadOwners: [agent.id] });
              if (state.routeRevision !== routeRevision || location.hash !== routeHash) return;
              sidebarUi.expandBot(agent.id);
              await openThread(result.thread.id);
              if (result.status !== 'bound') notice('导入已提交，等待原生回执。');
            }, 'primary btn-xs'))
            : null
        ));
      }
      cursorToken = page.nextCursor && !cursors.has(page.nextCursor) ? page.nextCursor : null;
      if (cursorToken) cursors.add(cursorToken);
      more.hidden = !cursorToken;
      status.textContent = seen.size
        ? (agent.capabilities.sessionImport === false ? '当前原生端未声明导入能力，仅展示目录。' : '共加载 ' + seen.size + ' 条原生会话（已绑定其他范围的会话已自动过滤）。')
        : (cursorToken ? '此页在当前范围内没有可显示的会话，可继续加载。' : '当前范围内暂无可导入的原生会话。');
    } catch (error) {
      if (rev === reqRev) status.textContent = error.message;
    }
  }

  scopeSelect.onchange = () => loadPage(true);

  displayDialog('原生会话目录 · ' + agent.name, [
    el('small', 'muted mono', [agent.adapterKey, agent.profileId, agent.workspaceRef].filter(Boolean).join(' · ')),
    scopeOptions.length ? el('label', 'field', el('span', 'field-label', '目标工作区范围'), scopeSelect) : null,
    status,
    results
  ], [
    !agent.online && hasDesktopSettings() ? btn('检查连接', () => desktopSettings(onSettingsChanged), 'secondary') : null,
    more,
    btn('关闭', () => $('dialog').close(), 'ghost')
  ], { wide: true });

  await loadPage(true);
}

async function showBotArchive(agent, mode = 'archived') {
  const title = agent.name + ' · ' + (mode === 'archived' ? '已归档会话' : '最近删除');
  const pending = el('p', 'muted', '正在读取会话目录…');
  const ui = displayDialog(title, [pending]);
  const [, purged] = await Promise.all([
    loadArchives(agent.id),
    mode === 'deleted' && agent.id !== 'main' ? api('/threads?' + new URLSearchParams({ instanceId: agent.id, state: 'purged' })).then(items) : []
  ]);
  if (!ui.dialog.open || !ui.dialog.contains(pending)) return;
  const list = (mode === 'archived' ? state.archivedThreads : state.deletedThreads)
    .filter(t => t.instanceId === agent.id);

  ui.body.replaceChildren(...(list.length
    ? list.map(thread => el('div', 'record',
      el('div', 'record-head',
        el('strong', '', thread.title || '会话'),
        el('small', 'muted', at(thread.lastActivity))
      ),
      el('div', 'actions',
        mode === 'archived' ? btn('查看会话', () => { $('dialog').close(); return openThread(thread.id); }, 'secondary btn-xs') : null,
        mode === 'archived'
          ? btn('恢复', async () => { await restoreThread(thread); showBotArchive(agent, mode); }, 'primary btn-xs')
          : btn('管理与清理', () => manageDeleted(thread), 'secondary btn-xs')
      )
    ))
    : [el('p', 'muted', mode === 'archived' ? '暂无已归档会话。' : '回收站为空。')]),
  ...(purged.length ? [el('h3', '', '已清理缓存的原生会话'), ...purged.map(thread => el('div', 'record',
    el('div', 'record-head', el('strong', '', thread.title || '原生会话'),
      el('small', 'muted', thread.projectId ? state.projects.find(project => project.id === thread.projectId)?.name || '项目' : '个人范围')),
    btn('管理工作台绑定', () => manageNativeRelease(thread, agent), 'secondary btn-xs')
  ))] : []));
}

async function manageNativeRelease(thread, agent) {
  const candidate = thread.sessionId;
  const routeRevision = state.routeRevision;
  const hash = location.hash;
  const onRoute = () => routeRevision === state.routeRevision && hash === location.hash;
  const currentAgent = state.instances.find(item => item.id === agent.id) || agent;
  const loading = el('p', 'muted', '正在查询原生绑定状态…');
  const ui = displayDialog('管理原生绑定 · ' + agent.name, [loading]);
  const { nativeRelease } = await api('/threads/' + url(thread.id) + '/impact');
  if (!onRoute() || !ui.dialog.open || !ui.dialog.contains(loading)) return;
  const info = el('p', 'muted', '解除绑定后，可按原账号和项目从原生目录重新导入。本地已清理的缓存无法恢复，重新导入可能显示原生历史。');
  const back = btn('返回回收站', () => showBotArchive(agent, 'deleted'), 'ghost');
  const catalog = btn('查看原生目录', () => nativeCatalog(currentAgent, thread.projectId || ''), 'secondary');
  if (nativeRelease?.status === 'completed') {
    displayDialog('管理原生绑定 · ' + agent.name, [el('p', 'text', '节点已确认解除工作台绑定。'), info], [back, catalog]);
    return;
  }
  if (nativeRelease && !['failed', 'blocked', 'cancelled'].includes(nativeRelease.status)) {
    const uncertain = nativeRelease.status === 'uncertain';
    displayDialog('管理原生绑定 · ' + agent.name, [
      el('p', 'text', uncertain ? '解除结果待核对。' : '等待节点确认解除绑定。'), info
    ], [back, btn('核对解绑回执', async () => {
      await api('/runs/' + url(nativeRelease.runId) + '/recovery', { action: 'inspect' });
      if (onRoute()) await manageNativeRelease(thread, agent);
    }, 'secondary')]);
    return;
  }
  const release = btn('解除工作台绑定', async () => {
    const ok = await confirmDialog({
      title: '解除原生会话的工作台绑定',
      body: '解除「' + (thread.title || '原生会话') + '」与工作台的绑定？原生客户端中的会话和历史仍保留。',
      confirmLabel: '确认解除绑定'
    });
    if (!onRoute()) return;
    try {
      if (ok) await api('/threads/' + url(thread.id) + '/lifecycle', { action: 'releaseNative', confirm: true, sessionId: candidate });
    } finally {
      if (onRoute() && !$('dialog').open) await manageNativeRelease(thread, agent);
    }
  }, 'primary');
  const unavailable = currentAgent.capabilities?.nativeBindingRelease !== true ? '请先升级工作 Bot 连接器，再解除此绑定。'
    : !currentAgent.online ? '节点离线。请在连接恢复后解除此绑定。' : null;
  release.disabled = Boolean(unavailable);
  displayDialog('管理原生绑定 · ' + agent.name, [info, el('small', 'muted mono', candidate),
    nativeRelease ? el('p', 'muted', '上次解除未完成。') : null,
    unavailable ? el('p', 'form-err', unavailable) : null], [
    back, release
  ]);
}

async function restoreThread(thread) {
  await api('/threads/' + url(thread.id) + '/lifecycle', { action: 'restore' });
  await load();
  renderChrome();
  if (state.thread === thread.id) await refresh();
  notice('会话已恢复。');
}

async function manageDeleted(thread) {
  const routeRevision = state.routeRevision;
  const hash = location.hash;
  const impact = await api('/threads/' + url(thread.id) + '/impact');
  if (routeRevision !== state.routeRevision || hash !== location.hash) return;
  const agent = state.instances.find(item => item.id === thread.instanceId);
  const summary = el('div', 'impact-summary',
    el('small', 'muted', '关联任务 ' + impact.tasks.length + ' 条 · 运行 ' + impact.runs.length + ' 项 · 待处理命令 ' + impact.jobs.length + ' 项'),
    el('small', 'muted', '分享 ' + impact.shares + ' 项 · 挂起输入 ' + impact.held + ' 项')
  );
  const purgeBtn = btn('永久清理', async () => {
    const ok = await confirmDialog({
      title: '永久清理工作台缓存',
      body: '永久清理「' + (thread.title || '此会话') + '」的本地缓存？本地内容无法恢复。原生历史可能仍存在，解除绑定并重新导入时可能再次显示。',
      confirmLabel: '确认永久清理',
      destructive: true
    });
    if (!ok) { await manageDeleted(thread); return; }
    const purged = await api('/threads/' + url(thread.id) + '/lifecycle', { action: 'purge', confirm: true });
    await load();
    renderChrome();
    if (routeRevision === state.routeRevision && hash === location.hash) {
      if (purged.sessionId && agent) await manageNativeRelease(purged, agent);
      else notice('已永久清理该会话缓存。');
    }
  }, 'destructive');
  purgeBtn.disabled = !impact.canPurge;

  displayDialog('最近删除 · ' + (thread.title || '会话'), [
    summary,
    el('p', 'muted', impact.scope),
    el('p', impact.canPurge ? 'muted' : 'form-err', impact.canPurge ? '可永久清理此会话的工作台缓存。' : '仍有关联运行或待核对操作，暂时不能永久清理。')
  ], [
    btn('恢复会话', async () => {
      await api('/threads/' + url(thread.id) + '/lifecycle', { action: 'restore' });
      $('dialog').close();
      await load();
      renderChrome();
      notice('会话已恢复。');
    }, 'secondary'),
    thread.sessionId && !thread.nativeInvalid && agent?.capabilities?.nativeActions?.includes('delete')
      ? btn('删除原生会话', async () => {
        const ok = await confirmDialog({
          title: '永久删除原生会话',
          body: '确认在 ' + agent.name + ' 原生端永久删除会话 ' + thread.sessionId + '？这会同时影响原生客户端中的该会话。',
          confirmLabel: '删除原生会话',
          destructive: true
        });
        if (!ok) { await manageDeleted(thread); return; }
        const result = await api('/threads/' + url(thread.id) + '/lifecycle', {
          action: 'deleteNative', confirm: true, sessionId: thread.sessionId
        });
        await load();
        renderChrome();
        notice(result.scope === 'native_pending' ? '原生删除请求已提交，等待回执。' : '原生会话已删除。');
      }, 'destructive-ghost')
      : null,
    purgeBtn,
    btn('关闭', () => $('dialog').close(), 'ghost')
  ]);
}

function loadMoreThreads(instanceId) {
  return enqueueCatalog(async () => {
    const offset = threadOffsets.get(instanceId) || 0;
    const page = await readThreads(instanceId, 'active', 41, offset);
    const existing = new Set(state.threads.map(thread => thread.id));
    state.threads.push(...page.slice(0, 40).filter(thread => !existing.has(thread.id)));
    threadOffsets.set(instanceId, offset + Math.min(40, page.length));
    threadHasMore.set(instanceId, page.length > 40);
    renderChrome();
  });
}

function route() {
  const [view, params] = (location.hash.slice(1) || 'chat').split('?');
  const q = new URLSearchParams(params);
  state.view = view === 'home' ? 'home' : 'chat';
  state.thread = q.get('thread');
  state.instance = q.get('instance') || 'main';
  state.draft = q.get('draft') === '1';
  state.project = q.get('project');
  state.page = q.get('page');
}

async function linkTasks(snap) {
  const linked = [...new Set(snap.messages.filter(m => m.kind === 'task_card').map(m => m.taskId).filter(Boolean))];
  snap.linkedTasks = Object.fromEntries(await Promise.all(linked.map(async key => {
    const { task, review } = await api('/tasks/' + url(key));
    return [key, { ...task, status: review?.status === 'completed' && task.status === 'completed' ? 'verified' : task.status }];
  })));
}

async function refresh() {
  const serial = ++revision;
  if (state.view === 'home') {
    await house.draw(serial);
    if (serial === revision) renderChrome();
    return;
  }

  if (!state.thread && !state.draft && (state.instance || 'main') === 'main' && state.mainThread) {
    state.thread = state.mainThread.id;
    const target = '#chat?thread=' + url(state.thread);
    if (location.hash !== target) history.replaceState(null, '', target);
  }
  if (!state.thread && !state.draft && state.instance !== 'main') {
    const last = localStorage.getItem('mao-last-thread:' + state.instance);
    const recent = state.threads.find(thread => thread.instanceId === state.instance && thread.id === last) ||
      state.threads.find(thread => thread.instanceId === state.instance);
    if (recent) {
      state.thread = recent.id;
      const target = '#chat?thread=' + url(recent.id);
      if (location.hash !== target) history.replaceState(null, '', target);
    } else {
      state.draft = true;
      const target = '#chat?instance=' + url(state.instance) + '&draft=1';
      if (location.hash !== target) history.replaceState(null, '', target);
    }
  }

  observedRoute = location.hash;
  const id = state.thread;
  const snap = id ? await api('/threads/' + url(id) + '?messageLimit=60') : null;
  if (snap) {
    await linkTasks(snap);
  }
  if (serial !== revision || location.hash !== observedRoute) return;
  const previous = state.snapshot;
  if (snap && previous?.olderLoaded && previous.thread.id === id && previous.thread.contextRevision === snap.thread.contextRevision) {
    const positions = new Map(previous.messages.map((message, index) => [message.id, index]));
    const overlap = snap.messages.findIndex(message => positions.has(message.id));
    if (overlap >= 0) {
      const recentIds = new Set(snap.messages.map(message => message.id));
      snap.olderLoaded = true;
      snap.nextBefore = previous.nextBefore;
      snap.messages = [...previous.messages.slice(0, positions.get(snap.messages[overlap].id)).filter(message => !recentIds.has(message.id)), ...snap.messages];
      snap.linkedTasks = { ...previous.linkedTasks, ...snap.linkedTasks };
    }
  }
  if (snap?.thread?.instanceId !== 'main' && snap?.thread?.state === 'active') {
    localStorage.setItem('mao-last-thread:' + snap.thread.instanceId, snap.thread.id);
    sidebarUi.expandBot(snap.thread.instanceId);
  }
  state.snapshot = snap;
  chats.draw();
  renderChrome();
}

async function loadOlder() {
  const previous = state.snapshot;
  const id = previous?.thread.id;
  const before = previous?.nextBefore;
  if (!id || !before) return;
  const page = await api('/threads/' + url(id) + '/messages?' + new URLSearchParams({ before, limit: '60' }));
  const older = { messages: page.messages };
  await linkTasks(older);
  const current = state.snapshot;
  if (state.view !== 'chat' || state.thread !== id || current?.nextBefore !== before ||
      current.thread.contextRevision !== previous.thread.contextRevision) return;
  const currentIds = new Set(current.messages.map(message => message.id));
  const snap = { ...current, olderLoaded: true, nextBefore: page.nextBefore,
    messages: [...page.messages.filter(message => !currentIds.has(message.id)), ...current.messages],
    linkedTasks: { ...older.linkedTasks, ...current.linkedTasks } };
  const content = $('content');
  const height = content.scrollHeight;
  const top = content.scrollTop;
  state.snapshot = snap;
  chats.draw();
  content.scrollTop = top + content.scrollHeight - height;
}

async function navigate() {
  toggleMobileSidebar(false);
  const changed = location.hash !== observedRoute;
  route();
  if (changed) {
    state.routeRevision++;
    ++revision;
    state.snapshot = null;
    chats.clearPreview();
    observedRoute = location.hash;
  }
  if (state.thread) {
    const found = findThreadAny(state.thread);
    if (found && found.instanceId !== 'main') sidebarUi.expandBot(found.instanceId);
  } else if (state.instance && state.instance !== 'main') {
    sidebarUi.expandBot(state.instance);
  }

  const prevView = $('content').dataset.view;
  const routeRevision = state.routeRevision;
  if (changed || prevView !== state.view || !$('content').children.length) {
    $('content').dataset.view = state.view;
    $('heading').textContent = state.view === 'home' ? '毛球之家' : '小毛球';
    $('subhead').textContent = '';
    $('tools').replaceChildren();
    $('compose').replaceChildren();
    $('content').replaceChildren(el('p', 'page muted', '正在打开…'));
  }
  renderChrome();

  try {
    await refresh();
  } catch (e) {
    if (routeRevision !== state.routeRevision || location.hash !== observedRoute) return;
    if (e.status === 401) return unauthorized();
    $('compose').replaceChildren();
    $('tools').replaceChildren();
    $('content').replaceChildren(el('div', 'page',
      el('p', 'form-err', e.message),
      btn('重试', navigate, 'secondary')
    ));
  }
}

async function go(hash) {
  if (location.hash !== hash) history.pushState(null, '', hash);
  await navigate();
}

function selectBot(botId) {
  if (botId === 'main') {
    if (state.mainThread) return openThread(state.mainThread.id);
    return go('#chat?instance=main');
  }
  sidebarUi.expandBot(botId);
  const last = localStorage.getItem('mao-last-thread:' + botId);
  const recent = state.threads.find(t => t.instanceId === botId && t.id === last)
    || state.threads.find(t => t.instanceId === botId);
  if (recent) return openThread(recent.id);
  const bot = state.instances.find(i => i.id === botId);
  const allowed = bot?.settings?.allowedProjects;
  const projectId = Array.isArray(allowed) ? (allowed[0] || undefined) : undefined;
  return openDraft(botId, projectId);
}

function openThread(id) { return go('#chat?thread=' + url(id)); }
function openDraft(id, projectId) { return go('#chat?instance=' + url(id) + (projectId ? '&project=' + url(projectId) : '') + '&draft=1'); }

async function openWorkDraft(id, refs) {
  const routeRevision = state.routeRevision;
  const hash = location.hash;
  chats.seedReferences(id, refs);
  await load();
  if (routeRevision !== state.routeRevision || hash !== location.hash) return;
  await openThread(id);
  requestAnimationFrame(() => { if (state.thread === id) $('input')?.focus(); });
}

function openHome(id, page) {
  return go('#home' + (id ? '?project=' + url(id) + (page ? '&page=' + url(page) : '') : ''));
}

window.addEventListener('hashchange', navigate);

let pendingUpdates = [];
let refreshing = false;
function scheduleRefresh(event) {
  pendingUpdates.push(event);
  if (!refreshTimer && !refreshing) refreshTimer = setTimeout(flushRefresh, 180);
}

async function flushRefresh() {
  refreshTimer = null;
  refreshing = true;
  const updates = pendingUpdates;
  pendingUpdates = [];
  try {
    const owners = new Set();
    let full = false;
    let instances = false;
    let projects = false;
    let main = false;
    for (const event of updates) {
      if (event.kind === 'reconnected') full = true;
      if (event.kind === 'presence' || event.kind === 'instance') instances = true;
      if (event.kind === 'home' && /^\/projects(?:\/[^/]+)?$/.test(event.path)) projects = true;
      if (event.kind === 'thread') {
        const owner = event.instanceId || findThreadAny(event.threadId)?.instanceId;
        if (owner) owners.add(owner);
        else full = true;
        if (event.action === 'setMain') main = true;
      }
    }
    if (full || instances || projects || main || owners.size) {
      await load({ full, instances, projects, main, threadOwners: [...owners] });
      renderChrome();
    }
    const redraw = full || instances || projects || main || updates.some(event =>
      (state.view === 'home' && (event.kind === 'home' || event.taskId)) ||
      (state.view === 'chat' && event.threadId === state.thread) ||
      (event.taskId && state.snapshot?.linkedTasks?.[event.taskId]));
    if (redraw) await refresh();
  } catch (e) {
    if (e.status === 401) unauthorized();
    else if (e.status === 410 && state.view === 'chat') await navigate();
    else notice(e.message, 'error');
  } finally {
    refreshing = false;
    if (pendingUpdates.length) refreshTimer = setTimeout(flushRefresh, 180);
  }
}

async function subscribe() {
  subscription?.abort();
  clearTimeout(retryTimer);
  const controller = new AbortController();
  subscription = controller;
  const reconnecting = connection === '正在重连';
  try {
    const response = await fetch('/api/v1/events?after=' + cursor, {
      headers: { ...headers(), Accept: 'text/event-stream' },
      signal: controller.signal
    });
    if (response.status === 401) { unauthorized(); return; }
    if (!response.ok) throw Error('订阅失败');
    connection = '实时连接';
    renderSessionFooter();
    if (reconnecting) scheduleRefresh({ kind: 'reconnected' });
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const lines = frame.split(/\r?\n/);
        const data = lines.filter(x => x.startsWith('data:')).map(x => x.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const event = JSON.parse(data);
        const id = Number(event.cursor || lines.find(x => x.startsWith('id:'))?.slice(3));
        if (event.kind === 'chat_delta') { chats.preview(event); continue; }
        if (Number.isSafeInteger(id) && id > cursor) cursor = id;
        scheduleRefresh(event);
      }
    }
  } catch {
    if (controller.signal.aborted) return;
  }
  if (controller.signal.aborted) return;
  connection = '正在重连';
  chats.clearPreview();
  renderSessionFooter();
  retryTimer = setTimeout(subscribe, 2200);
}

async function start() {
  try {
    cursor = (await api('/events/latest')).cursor;
    await load();
    await navigate();
    subscribe();
  } catch (e) {
    if (e.status === 401) return unauthorized();
    connection = '连接失败';
    renderSessionFooter();
    $('content').replaceChildren(el('div', 'page',
      el('p', 'form-err', e.message),
      btn('重新连接', start, 'secondary')
    ));
  }
}

renderSessionFooter();
start();
