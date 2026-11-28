const paths = {
  folder: 'M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  folderOpen: 'M5 19h14a2 2 0 0 0 1.84-1.2l2.1-5A1 1 0 0 0 22 11H9a2 2 0 0 0-1.84 1.2L5 19zm0 0H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h8a2 2 0 0 1 2 2v2',
  clip: 'm8 13 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l9-9 M7 15l8-8',
  sliders: 'M3 7h4m4 0h10 M3 17h10m4 0h4 M11 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0 M17 17a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
  key: 'M15 3a6 6 0 1 1-3 11l-6 6H3v-3l6-6a6 6 0 0 1 6-8z M16 7h.01',
  chevron: 'm9 5 7 7-7 7',
  chevronDown: 'm6 9 6 6 6-6',
  chevronRight: 'm9 6 6 6-6 6',
  chevronLeft: 'm15 6-6 6 6 6',
  chat: 'M20 15a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3z',
  layers: 'm2 8 10-5 10 5-10 5z M3 12l9 5 9-5 M3 16l9 5 9-5',
  menu: 'M3 6h18 M3 12h18 M3 18h18',
  plus: 'M12 4v16 M4 12h16',
  close: 'm6 6 12 12 M18 6 6 18',
  edit: 'm14 4 6 6 M3 21l5-1L21 7l-4-4L4 16z',
  file: 'M5 3h9l5 5v13H5z M14 3v6h5 M8 13h8 M8 17h6',
  code: 'm7 6-5 6 5 6 M17 6l5 6-5 6 M14 4l-4 16',
  send: 'm3 10 18-7-7 18-3-8z M11 13 21 3',
  arrow: 'M4 12h16 M14 6l6 6-6 6',
  task: 'M4 5h16v14H4z M8 9h8 M8 13h5',
  yarn: 'M17 16a8.8 8.8 0 1 1 1.5-4.7c0 3.8-2.8 5.9-1.5 7.4 1.1 1.3 3.5.8 5 .8 M5 7a17 17 0 0 1 10 12 M3.5 10a14 14 0 0 1 8 9 M7 4.7a18 18 0 0 1 7 5 M11 3.2l5 3.1 M9 8c2.3-2 4.3-3 6.5-3.1 M11.4 10c2.1-1.9 4.1-3.2 6.3-3.6 M13.2 12.8c2.2-2.1 4.1-3.3 5.5-3.6 M15 15.3l3-2.4',
  search: 'M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16z m10 2-4.35-4.35',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z M12 1v2 M12 21v2 M4.22 4.22l1.42 1.42 M18.36 18.36l1.42 1.42 M1 12h2 M21 12h2 M4.22 19.78l1.42-1.42 M18.36 5.64l1.42-1.42',
  moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
  panelRight: 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M15 3v18',
  copy: 'M9 9h11v11H9z M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  check: 'M20 6 9 17l-5-5',
  bot: 'M12 4V2 M4 10a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z M9 13v2 M15 13v2 M2 13h2 M20 13h2',
  terminal: 'm4 17 6-6-6-6 M12 19h8',
  sparkles: 'm12 3-1.8 4.8L5.4 9.6l4.8 1.8L12 16.2l1.8-4.8 4.8-1.8-4.8-1.8z M5 3v4 M3 5h4 M19 17v4 M17 19h4',
  branch: 'M6 3v12 M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 9a9 9 0 0 1-9 9',
  archive: 'M3 4h18v4H3z M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8 M10 12h4',
  trash: 'M3 6h18 M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2 M19 6v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6 M10 11v6 M14 11v6',
  refresh: 'M21 12a9 9 0 1 1-2.64-6.36 M21 3v6h-6',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  globe: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M2 12h20 M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  clock: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M12 6v6l4 2',
  warning: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z M12 9v4 M12 17h.01',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6 M15 3h6v6 M10 14 21 3'
};

export const $ = id => document.getElementById(id);
export const isMac = () => navigator.userAgent.includes('Mac');

export function localFlag(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return raw;
  } catch {
    return fallback;
  }
}

export function setLocalFlag(key, value) {
  try { localStorage.setItem(key, String(value)); } catch {}
}

export function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme) {
  const mode = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = mode;
  setLocalFlag('mao-theme', mode);
  return mode;
}

export function initTheme() {
  const saved = localFlag('mao-theme', '');
  if (saved === 'dark' || saved === 'light') return applyTheme(saved);
  return applyTheme('light');
}

export function toggleTheme() {
  return applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}

export function banner(...phrases) {
  return el('div', 'garden-banner', el('h2', '', ...phrases.map(text => el('span', '', text))));
}

export function el(tag, cls = '', ...children) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  for (const child of children.flat()) if (child != null && child !== false) n.append(child);
  return n;
}

export function icon(key) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const path = document.createElementNS(ns, 'path');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true'
  })) svg.setAttribute(k, v);
  path.setAttribute('d', paths[key] || paths.chat);
  svg.append(path);
  return svg;
}

export function btn(label, fn, cls = '', symbol = '') {
  const n = el('button', cls, ...(symbol ? [icon(symbol)] : []), label);
  n.type = 'button';
  n.onclick = async event => {
    if (n.disabled) return;
    n.disabled = true;
    try { await fn(event); }
    catch (e) { notice(e?.message || '操作失败', 'error'); }
    finally { n.disabled = false; }
  };
  return n;
}

export function iconBtn(label, fn, symbol, extraCls = '') {
  const b = btn('', fn, 'icon-btn' + (extraCls ? ' ' + extraCls : ''), symbol);
  b.title = label;
  b.setAttribute('aria-label', label);
  return b;
}

let noticeTimer;
export function notice(msg, tone = 'info') {
  const dialog = $('dialog');
  const confirm = $('confirm-dialog');
  const isError = tone === 'error';
  if (dialog?.open && !confirm?.open) {
    let n = dialog.querySelector('.dialog-notice');
    if (!n) {
      n = el('p', 'dialog-notice');
      n.setAttribute('role', 'status');
      const head = dialog.querySelector('.dialog-head') || dialog.querySelector('h2');
      if (head) head.after(n);
      else dialog.prepend(n);
    }
    n.className = 'dialog-notice' + (isError ? ' error' : '');
    n.textContent = msg;
    n.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { if (n.isConnected) n.hidden = true; }, 6000);
    return;
  }
  const n = $('notice');
  if (!n) return;
  n.className = isError ? 'error' : '';
  n.textContent = msg;
  n.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { n.hidden = true; }, 5000);
}

export async function copyText(text, label = '已复制到剪贴板') {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    notice(label);
  } catch {
    notice('无法访问剪贴板，请手动复制。', 'error');
  }
}

export function headers() {
  const token = sessionStorage.getItem('mao-token');
  return token ? { Authorization: 'Bearer ' + token } : {};
}

export async function api(path, body, method = body ? 'POST' : 'GET') {
  const response = await fetch('/api/v1' + path, {
    method,
    headers: { ...headers(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify({ requestId: crypto.randomUUID(), ...body }) : undefined
  });
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) {
    throw Object.assign(
      new Error(data.error?.message || data.message || (typeof data.error === 'string' ? data.error : '请求失败 ' + response.status)),
      { status: response.status, current: data.current }
    );
  }
  return data;
}

export const items = data => Array.isArray(data) ? data : (data?.items ?? []);
export const url = value => encodeURIComponent(value);
export const at = ts => {
  if (!ts) return '';
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
export const basenamePath = p => {
  if (!p || typeof p !== 'string') return '';
  const cleaned = p.replace(/[\\/]+$/, '');
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cleaned;
};

export const phase = value => ({
  queued: '待送达', running: '运行中', waiting_input: '等待回应', cancelling: '正在停止',
  blocked: '受阻', awaiting_review: '待验收', partial: '部分交付', completed: '执行结束',
  verified: '验收通过', cancelled: '已停止', failed: '失败', uncertain: '送达待核对',
  waiting: '下一轮待发', held: '已挂起', sent: '已发送', received: '已接收', done: '已处理'
}[value] ?? value ?? '');

export function displayDialog(title, nodes = [], footerButtons = [], opts = {}) {
  const dialog = $('dialog');
  dialog._removeCancelGuard?.();
  if (dialog.open) dialog.close();
  dialog.className = opts.wide ? 'dialog-wide' : opts.compact ? 'dialog-compact' : '';
  const backBtn = typeof opts.back === 'function' ? iconBtn('返回上一步', opts.back, 'chevronLeft') : null;
  const closeX = iconBtn('关闭', () => dialog.close(), 'close');
  const head = el('div', 'dialog-head', backBtn, el('h2', '', title), closeX);
  const body = el('div', 'dialog-body scroll-sleek', ...nodes.filter(Boolean));
  const foot = el('div', 'dialog-foot', ...footerButtons.filter(Boolean));
  if (!footerButtons.length) foot.append(btn('关闭', () => dialog.close(), 'ghost'));
  const shell = el('div', 'dialog-shell', head, body, foot);
  dialog.replaceChildren(shell);
  dialog.showModal();
  const focusTarget = foot.querySelector('button.primary, button.destructive') || closeX;
  requestAnimationFrame(() => focusTarget?.focus());
  return { dialog, head, body, foot };
}

export function form(title, fields, submit, onSave, opts = {}) {
  const dialog = $('dialog');
  dialog._removeCancelGuard?.();
  if (dialog.open) dialog.close();
  dialog.className = opts.wide ? 'dialog-wide' : opts.compact ? 'dialog-compact' : '';
  const backBtn = typeof opts.back === 'function' ? iconBtn('返回上一步', opts.back, 'chevronLeft') : null;
  const closeX = iconBtn('关闭', () => dialog.close(), 'close');
  const head = el('div', 'dialog-head', backBtn, el('h2', '', title), closeX);
  const body = el('div', 'dialog-body scroll-sleek');
  if (opts.description) body.append(el('p', 'muted', opts.description));

  const controls = {};
  for (const field of fields) {
    const input = el(field.options ? 'select' : field.type === 'textarea' ? 'textarea' : 'input');
    if (input.tagName === 'INPUT') input.type = field.type || 'text';
    if (field.min != null) input.min = String(field.min);
    if (field.max != null) input.max = String(field.max);
    if (field.step != null) input.step = String(field.step);
    if (field.options) {
      for (const option of field.options) {
        const o = el('option', '', option.name);
        o.value = option.id;
        input.append(o);
      }
    }
    if (field.value != null) input.value = field.value;
    input.required = !!field.required;
    input.placeholder = field.placeholder || '';
    input.autocomplete = field.type === 'password' ? 'current-password' : 'off';
    controls[field.key] = input;
    body.append(el('label', 'field', el('span', 'field-label', field.label), input));
  }

  const error = el('div', 'form-err');
  error.setAttribute('role', 'alert');
  body.append(error);

  const save = el('button', opts.submitClass || 'primary', submit);
  save.type = 'submit';
  const cancel = btn(opts.cancelLabel || '取消', () => dialog.close(), 'ghost');
  const foot = el('div', 'dialog-foot', cancel, save);

  const f = el('form', '', head, body, foot);
  dialog.replaceChildren(f);

  const snapshot = () => JSON.stringify(
    Object.entries(controls).map(([k, v]) => [k, v.type === 'file' ? Array.from(v.files || []).map(x => x.name).join(',') : v.value])
  );
  const initialSnapshot = snapshot();
  const hasLongInput = fields.some(field => field.type === 'textarea') || fields.length >= 3;
  const onCancel = event => {
    if (!hasLongInput || f.parentNode !== dialog || $('confirm-dialog')?.open) return;
    if (snapshot() === initialSnapshot) return;
    event.preventDefault();
    void confirmDialog({
      title: '放弃未保存的修改？',
      body: '当前表单有尚未保存的内容，确认关闭并丢弃修改？',
      confirmLabel: '放弃修改',
      destructive: true
    }).then(ok => {
      if (ok && dialog.open && f.parentNode === dialog) {
        dialog._removeCancelGuard?.();
        dialog.close();
      }
    });
  };
  const removeCancelGuard = () => {
    dialog.removeEventListener('cancel', onCancel);
    if (dialog._removeCancelGuard === removeCancelGuard) delete dialog._removeCancelGuard;
  };
  dialog._removeCancelGuard = removeCancelGuard;
  dialog.addEventListener('cancel', onCancel);
  dialog.addEventListener('close', removeCancelGuard, { once: true });

  f.onsubmit = async event => {
    event.preventDefault();
    if (save.disabled) return;
    save.disabled = true;
    error.textContent = '';
    const staleNotice = dialog.querySelector('.dialog-notice');
    if (staleNotice) staleNotice.hidden = true;
    try {
      const values = Object.fromEntries(
        Object.entries(controls).map(([k, v]) => [k, v.type === 'file' ? v.files[0] : v.value.trim()])
      );
      await onSave(values);
      const pendingNotice = f.parentNode === dialog ? dialog.querySelector('.dialog-notice:not([hidden])') : null;
      const promoted = pendingNotice ? { msg: pendingNotice.textContent, tone: pendingNotice.classList.contains('error') ? 'error' : 'info' } : null;
      if (dialog.open && f.parentNode === dialog) {
        removeCancelGuard();
        dialog.close();
      }
      if (promoted?.msg) notice(promoted.msg, promoted.tone);
    } catch (e) {
      error.textContent = e?.message || '提交失败';
    } finally {
      save.disabled = false;
    }
  };

  dialog.showModal();
  const firstControl = Object.values(controls).find(c => !c.disabled && c.type !== 'hidden');
  requestAnimationFrame(() => (firstControl || save).focus());
  return { dialog, form: f, head, body, foot, controls, save, error };
}

export function confirmDialog({
  title = '确认操作',
  body = '',
  details = null,
  confirmLabel = '确认',
  cancelLabel = '取消',
  destructive = false
} = {}) {
  return new Promise(resolve => {
    const host = ($('dialog')?.open && $('confirm-dialog')) ? $('confirm-dialog') : $('dialog');
    if (host.open) host.close();
    host.className = 'dialog-compact';
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      host.removeEventListener('close', onClose);
      if (host.open && host.contains(shell)) host.close();
      resolve(result);
    };
    const onClose = () => { if (!host.open || !host.contains(shell)) finish(false); };

    const head = el('div', 'dialog-head',
      destructive ? icon('warning') : null,
      el('h2', '', title),
      iconBtn('关闭', () => finish(false), 'close'));
    const bodyBox = el('div', 'dialog-body scroll-sleek',
      body ? el('p', 'text', body) : null,
      details);
    const confirmBtn = el('button', destructive ? 'destructive' : 'primary', confirmLabel);
    confirmBtn.type = 'button';
    confirmBtn.onclick = () => finish(true);
    const cancelBtn = el('button', 'ghost', cancelLabel);
    cancelBtn.type = 'button';
    cancelBtn.onclick = () => finish(false);

    const shell = el('div', 'dialog-shell', head, bodyBox, el('div', 'dialog-foot', cancelBtn, confirmBtn));
    host.addEventListener('close', onClose);
    host.replaceChildren(shell);
    host.showModal();
    requestAnimationFrame(() => confirmBtn.focus());
  });
}

export async function upload(file, projectId, requestId) {
  if (file.size > 16 * 1024 * 1024) throw Error('单个附件不能超过 16 MiB');
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('无法读取附件'));
    reader.readAsDataURL(file);
  });
  return api('/attachments', {
    name: file.name,
    contentType: file.type || 'application/octet-stream',
    data,
    ...(projectId ? { projectId } : {}),
    ...(requestId ? { requestId } : {})
  });
}

export async function download(id) {
  const response = await fetch('/api/v1/attachments/' + url(id) + '?download=1', { headers: headers() });
  if (!response.ok) throw Error('无法下载附件（' + response.status + '）');
  const encoded = response.headers.get('Content-Disposition')?.split("filename*=UTF-8''")[1];
  const a = el('a');
  a.href = URL.createObjectURL(await response.blob());
  a.download = encoded ? decodeURIComponent(encoded) : '附件';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const state = {
  threads: [],
  archivedThreads: [],
  deletedThreads: [],
  instances: [],
  projects: [],
  view: 'chat',
  thread: null,
  instance: 'main',
  draft: false,
  project: null,
  page: null,
  routeRevision: 0,
  mainThread: null,
  snapshot: null,
  connection: '正在连接'
};

export function getMainBot(s = state) {
  return s.instances.find(i => i.id === 'main') || { id: 'main', name: '小毛球', online: true };
}

export function getWorkBots(s = state) {
  return s.instances.filter(i => i.id !== 'main');
}

export function nativeBindingUnverified(thread, agent) {
  return agent?.adapterKey === 'codex' && thread?.kind === 'native' && Boolean(thread.sessionId) && !thread.nativeRuntimeScopeId;
}

export function findThreadAny(threadId, s = state) {
  if (!threadId) return null;
  if (s.mainThread?.id === threadId) return s.mainThread;
  if (s.snapshot?.thread?.id === threadId) return s.snapshot.thread;
  return s.threads.find(t => t.id === threadId)
    || s.archivedThreads.find(t => t.id === threadId)
    || s.deletedThreads.find(t => t.id === threadId)
    || null;
}

export function resolveActiveContext(s = state) {
  const thread = s.thread ? findThreadAny(s.thread, s) : null;
  const instanceId = thread?.instanceId || s.instance || 'main';
  const agent = instanceId === 'main' ? getMainBot(s) : s.instances.find(i => i.id === instanceId) || null;
  const isMain = instanceId === 'main';
  const isMainThread = Boolean(isMain && thread && s.mainThread?.id === thread.id);
  const isSideThread = Boolean(isMain && (!thread || !isMainThread));
  const isDraft = Boolean(!thread && s.draft);
  return { instanceId, threadId: thread?.id || s.thread || null, thread, agent, isMain, isMainThread, isSideThread, isDraft };
}
