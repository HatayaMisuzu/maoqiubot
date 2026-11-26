import { $, api, at, btn, confirmDialog, displayDialog, download, el, form, icon, items, notice, state, upload, url } from './lib.js';
import { spaceEditor } from './space-editor.js';

const labels = {
  requirement: '项目要求', decision: '决定', handoff: '交接', comment: '留言', todo: '待办',
  start: '开始工作', result: '工作结果', progress: '进度', preference: '偏好',
  note: '笔记', verified: '已验证', next: '下一步'
};
const options = keys => keys.map(id => ({ id, name: labels[id] || id }));
const empty = txt => el('p', 'empty', txt);

function display(title, ...contents) {
  displayDialog(title, contents.filter(Boolean), [
    btn('关闭', () => $('dialog').close(), 'ghost')
  ]);
}

function showSource(source) {
  const links = el('div', 'actions');
  if (source.url) {
    try {
      const target = new URL(source.url);
      if (['https:', 'http:'].includes(target.protocol)) {
        const a = el('a', '', '打开原始链接');
        a.href = target.href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        links.append(a);
      }
    } catch {}
  }
  for (const id of source.attachmentIds || []) {
    links.append(
      btn('下载附件', () => download(id), 'secondary btn-xs', 'file'),
      btn('附件权限', async () => editSharing(await api('/attachments/' + url(id) + '?meta=1'), 'attachments', () => showSource(source)), 'ghost btn-xs')
    );
  }
  links.append(btn('调整分享范围', () => editSharing(source, 'sources', showSource), 'ghost btn-xs'));
  display(source.title || '原件',
    el('small', '', [source.author, source.platform, at(source.createdAt)].filter(Boolean).join(' · ')),
    el('p', 'text', source.text || ''),
    links
  );
}

function editSharing(asset, area, onSave) {
  const ui = form(area === 'sources' ? '资料分享范围' : '附件分享范围 · ' + asset.name, [], '保存范围', async () => {
    const projectIds = Array.from(checks.querySelectorAll('input:checked'), input => input.value);
    const saved = await api('/' + area + '/' + url(asset.id), { projectIds, endpointIds: asset.endpointIds || [] }, 'PATCH');
    onSave(saved);
  });
  const checks = el('fieldset', 'handoff-files', el('legend', '', '可读取原件的项目'));
  for (const p of state.projects) {
    const input = el('input');
    input.type = 'checkbox';
    input.value = p.id;
    input.checked = asset.projectIds.includes(p.id);
    checks.append(el('label', '', input, p.name));
  }
  ui.body.prepend(checks);
}

const sourceById = async id => showSource(await api('/sources/' + url(id)));
const recordRow = (rec, onContinue, onStartWork) => el('div', 'record',
  el('small', 'muted', [labels[rec.type] || rec.type, rec.author, at(rec.createdAt)].filter(Boolean).join(' · ')),
  el('p', 'text', rec.body),
  rec.extra?.version ? el('small', 'muted', '版本 ' + rec.extra.version) : null,
  rec.evidence ? el('p', 'text', rec.evidence) : null,
  rec.sourceId ? btn('查看出处', () => sourceById(rec.sourceId), 'ghost btn-xs') : null,
  onContinue || onStartWork ? el('div', 'actions',
    onContinue ? btn('接续此交接', onContinue, 'ghost btn-xs') : null,
    onStartWork ? btn('带入工作话题', onStartWork, 'secondary btn-xs', 'chat') : null
  ) : null
);

export const home = actions => {
  const editor = spaceEditor(actions, display);

  function createProject() {
    form('建立项目', [
      { key: 'name', label: '项目名称', required: true },
      { key: 'binding', label: '资料目录备注（可选）' },
      { key: 'templateSpaceId', label: '复用空间布局', options: [{ id: '', name: '默认布局' }, ...state.projects.map(p => ({ id: p.spaceId, name: p.name }))] }
    ], '创建', async d => {
      const p = await api('/projects', { name: d.name, binding: d.binding || undefined, templateSpaceId: d.templateSpaceId || undefined });
      await actions.load();
      await actions.openHome(p.id);
    });
  }

  async function bindWorkspace(projectId) {
    const current = items(await api('/projects/' + url(projectId) + '/workspaces'));
    const opts = state.instances.filter(i => i.id !== 'main').map(i => ({
      id: i.id,
      name: [i.name, i.profileId, i.workspaceRef, current.some(r => r.instanceId === i.id) ? '已绑定' : ''].filter(Boolean).join(' · ')
    }));
    if (!opts.length) {
      notice('暂无可新增的工作 Bot 工作区。');
      return;
    }
    const ui = form('绑定执行工作区', [
      { key: 'instanceId', label: '执行实例与工作区', options: opts, required: true },
      {
        key: 'access',
        label: '运行期间的项目资料权限',
        options: [
          { id: 'explicit', name: '仅提供明确选中的材料' },
          { id: 'read', name: '读取项目资料' },
          { id: 'append', name: '读取和追加资料或交接' },
          { id: 'manage', name: '读取、追加和编辑项目内容' }
        ]
      }
    ], '保存', async ({ instanceId, access }) => {
      const inst = state.instances.find(i => i.id === instanceId);
      await api('/projects/' + url(projectId) + '/workspaces', {
        instanceId,
        workspaceRef: inst.workspaceRef,
        allowAgentAccess: access !== 'explicit',
        agentPermission: access === 'explicit' ? 'read' : access
      });
      await actions.refresh();
    });
    const unbind = btn('解除绑定', async () => {
      const instanceId = ui.controls.instanceId.value;
      await api('/projects/' + url(projectId) + '/workspaces', { instanceId }, 'DELETE');
      ui.dialog.close();
      await actions.refresh();
    }, 'destructive-ghost');
    ui.save.before(unbind);
    const showAccess = () => {
      const binding = current.find(row => row.instanceId === ui.controls.instanceId.value);
      ui.controls.access.value = binding?.allowAgentAccess ? binding.agentPermission : 'explicit';
      unbind.hidden = !binding;
    };
    ui.controls.instanceId.addEventListener('change', showAccess);
    showAccess();
  }

  function newRecord(projectId, path, previous) {
    const { controls } = form(previous ? '接续交接' : '写项目记录', [
      {
        key: 'type',
        label: '记录类型',
        options: path || previous
          ? options(['handoff'])
          : projectId
            ? options(['handoff', 'requirement', 'comment', 'decision', 'preference', 'note', 'todo', 'verified', 'next'])
            : options(['note', 'preference', 'decision', 'todo']),
        value: projectId ? 'handoff' : 'note'
      },
      { key: 'body', label: '内容', type: 'textarea', required: true },
      { key: 'version', label: '成果版本（可选）', value: previous?.extra?.version },
      { key: 'remaining', label: '未完成事项（每行一项）', type: 'textarea', value: Array.isArray(previous?.extra?.remaining) ? previous.extra.remaining.join('\n') : '' }
    ], '保存', async ({ type, body, version, remaining }) => {
      const extra = type === 'handoff'
        ? { ...(version ? { version } : {}), remaining: remaining.split('\n').map(item => item.trim()).filter(Boolean) }
        : {};
      await api(path || (projectId ? '/projects/' + url(projectId) + '/records' : '/records'), {
        type, body, extra, confirmation: 'user', ...(previous ? { refs: [previous.id] } : {})
      });
      await actions.refresh();
    });
    const showHandoffFields = () => {
      for (const key of ['version', 'remaining']) controls[key].parentElement.hidden = controls.type.value !== 'handoff';
    };
    controls.type.addEventListener('change', showHandoffFields);
    showHandoffFields();
  }

  async function startHandoff(projectId, handoff) {
    const query = new URLSearchParams({ projectId });
    const searchQuery = new URLSearchParams({ projectId, kind: 'source', limit: '100', ...(handoff.sourceId ? { ref: handoff.sourceId } : {}) });
    const [workspaces, results] = await Promise.all([api('/projects/' + url(projectId) + '/workspaces'), api('/search?' + searchQuery)]);
    if (state.view !== 'home' || state.project !== projectId) return;
    const contacts = items(workspaces).map(w => {
      const online = state.instances.find(i => i.id === w.instanceId)?.online;
      return { id: w.instanceId, name: [w.name, w.profileId, w.workspaceRef, online ? '' : '离线'].filter(Boolean).join(' · ') };
    });
    if (!contacts.length) {
      notice('请先为这个项目绑定执行工作区。');
      return;
    }
    const sources = items(results).filter(result => result.kind === 'source');
    const excerpt = handoff.body.replace(/\s+/g, ' ').slice(0, 48);
    const attachments = el('fieldset', 'handoff-files');
    const attachmentStatus = el('small', 'muted');
    attachments.hidden = true;
    attachmentStatus.hidden = true;
    attachmentStatus.setAttribute('role', 'status');
    let submission;

    const ui = form('带入工作话题', [
      { key: 'instanceId', label: '接手的执行实例与工作区', options: contacts, required: true },
      { key: 'sourceId', label: '项目原件（可选）', options: [{ id: '', name: '请选择' }, ...sources.map(s => ({ id: s.id, name: (s.id === handoff.sourceId ? '交接出处 · ' : '') + s.summary.slice(0, 80) }))] }
    ], '创建工作话题', async ({ instanceId, sourceId }) => {
      const refs = [{ type: 'record', id: handoff.id, excerpt: '交接 · ' + excerpt }];
      if (sourceId) {
        const source = sources.find(s => s.id === sourceId);
        refs.push({ type: 'source', id: sourceId, excerpt: '原件 · ' + source.summary.slice(0, 48) });
        for (const checked of attachments.querySelectorAll('input:checked')) {
          refs.push({ type: 'attachment', id: checked.value, excerpt: '附件 · ' + checked.dataset.name });
        }
      }
      if (submission?.instanceId !== instanceId) submission = { instanceId, requestId: crypto.randomUUID() };
      const thread = await api('/threads', { instanceId, projectId, title: '接续 · ' + excerpt, requestId: submission.requestId });
      await actions.openWorkDraft(thread.id, refs);
    });

    const sourceInput = ui.controls.sourceId;
    ui.body.prepend(el('p', 'text', '交接 · ' + excerpt));
    sourceInput.parentElement.after(attachments, attachmentStatus);
    sourceInput.addEventListener('change', async () => {
      const sourceId = sourceInput.value;
      attachments.replaceChildren();
      attachments.hidden = true;
      attachmentStatus.hidden = !sourceId;
      attachmentStatus.textContent = sourceId ? '正在读取原件附件…' : '';
      if (!sourceId) return;
      try {
        const source = await api('/sources/' + url(sourceId) + '?' + query);
        const files = await Promise.all((source.attachmentIds || []).map(id => api('/attachments/' + url(id) + '?meta=1')));
        if (sourceInput.value !== sourceId) return;
        attachments.replaceChildren(el('legend', '', '选取附件'), ...files.map(file => {
          const input = el('input');
          input.type = 'checkbox';
          input.value = file.id;
          input.dataset.name = file.name;
          return el('label', '', input, file.name);
        }));
        attachments.hidden = !files.length;
        attachmentStatus.hidden = true;
      } catch (e) {
        if (sourceInput.value === sourceId) attachmentStatus.textContent = e.message;
      }
    });
  }

  function addSource(projectId) {
    form('保存资料', [
      { key: 'title', label: '标题', required: true },
      { key: 'text', label: '正文或署名摘要', type: 'textarea' },
      { key: 'author', label: '原作者' },
      { key: 'platform', label: '来源平台' },
      { key: 'url', label: '来源链接', type: 'url' },
      { key: 'file', label: '原件附件', type: 'file' }
    ], '归档', async d => {
      const attachmentIds = d.file ? [(await upload(d.file, projectId)).id] : [];
      await api('/submissions', {
        projectId: projectId || undefined,
        source: { title: d.title, text: d.text, author: d.author || undefined, platform: d.platform || undefined, url: d.url || undefined, attachmentIds }
      });
      await actions.refresh();
    });
  }

  function search(projectId, personal = false) {
    form('检索资料', [
      { key: 'q', label: '关键词' },
      { key: 'kind', label: '资料类型', options: [{ id: '', name: '全部' }, { id: 'record', name: '记录' }, { id: 'source', name: '原始来源' }] },
      { key: 'platform', label: '来源平台（可选）' }
    ], '查找', async d => {
      const q = new URLSearchParams({ q: d.q, limit: '30' });
      if (projectId) q.set('projectId', projectId);
      if (personal) q.set('scope', 'personal');
      for (const key of ['kind', 'platform']) if (d[key]) q.set(key, d[key]);
      const results = el('div');
      const more = btn('加载更多', () => fetchPage(cursor), 'secondary');
      let cursor;
      async function fetchPage(next) {
        if (next) q.set('cursor', next);
        const page = await api('/search?' + q);
        results.append(...(page.items.length ? page.items.map(r => el('div', 'record',
          el('p', 'text', r.summary),
          btn(r.kind === 'record' ? '查看记录' : '查看原件', () => r.kind === 'record' ? openRecord(r.id) : sourceById(r.id), 'ghost btn-xs')
        )) : [empty('没有匹配资料。')]));
        cursor = page.nextCursor;
        more.hidden = !cursor;
      }
      await fetchPage();
      displayDialog('检索结果', [results], [
        btn('返回检索', () => search(projectId, personal), 'ghost'),
        more,
        btn('关闭', () => $('dialog').close(), 'ghost')
      ]);
    });
  }

  async function openRecord(id) {
    const endpoint = '/records/' + url(id);
    const rec = await api(endpoint);
    const edit = () => form('编辑记录', [
      { key: 'body', label: '内容', type: 'textarea', value: rec.body, required: true },
      {
        key: 'confirmation',
        label: '确认性质',
        options: [
          { id: 'user', name: '由所有者确认' }, { id: 'unconfirmed', name: '待确认' },
          { id: 'inferred', name: '推测' }, { id: 'confirmed', name: '已确认' }, { id: 'observed', name: '观察记录' }
        ],
        value: rec.confirmation
      }
    ], '保存', async values => {
      await api(endpoint, { ...values, expectedRevision: rec.revision }, 'PATCH');
      await actions.refresh();
    });

    const sharing = () => form('派生知识共享', [{
      key: 'mode',
      label: '项目中的可见性',
      options: [
        { id: 'source', name: '随资料访问权限共享' },
        { id: 'independent', name: '确认该版本可作为独立项目知识' },
        { id: 'hidden', name: '停止共享正文与修订' }
      ],
      value: rec.shareDerived === false ? 'hidden' : rec.independentKnowledge ? 'independent' : 'source'
    }], '保存', async ({ mode }) => {
      await api(endpoint, {
        expectedRevision: rec.revision,
        shareDerived: mode !== 'hidden',
        independentKnowledge: mode === 'independent',
        ...(mode === 'independent' ? { confirmation: 'user' } : {})
      }, 'PATCH');
      await actions.refresh();
      await openRecord(id);
    });

    const history = async () => {
      const { history: revisions } = await api(endpoint + '?history=1');
      display('修订历史', ...revisions.map(revision => el('article', 'record',
        el('strong', '', '版本 ' + revision.revision + ' · ' + at(revision.createdAt)),
        el('p', 'text', revision.body)
      )));
    };

    const forget = async () => {
      const ok = await confirmDialog({
        title: '忘记记录',
        body: '该记录将退出检索和后续聊天召回。原件及已经送达的消息会保留。',
        confirmLabel: '确认忘记',
        destructive: true
      });
      if (!ok) { await openRecord(id); return; }
      await api(endpoint, { expectedRevision: rec.revision }, 'DELETE');
      await actions.refresh();
    };

    display(labels[rec.type] || '记录', recordRow(rec), el('div', 'actions',
      btn('修订历史', history, 'ghost btn-xs'),
      rec.projectId ? btn('派生知识共享', sharing, 'secondary btn-xs') : null,
      rec.submitter === 'server' ? null : btn('编辑记录', edit, 'secondary btn-xs'),
      rec.submitter === 'server' ? null : btn('忘记记录', forget, 'destructive-ghost btn-xs')
    ));
  }

  function entryForm(c, path, entry) {
    const fields = c.fields.map(f => ({
      key: f.id,
      label: f.name + (f.type === 'record' ? '（记录 ID）' : ''),
      type: ({ number: 'number', date: 'date', attachment: 'file' }[f.type] || 'text'),
      value: f.type === 'attachment' ? undefined : entry?.values[f.id],
      options: f.type === 'select' && f.options ? [{ id: '', name: '请选择' }, ...f.options.map(id => ({ id, name: id }))] : undefined
    }));
    form((entry ? '编辑' : '添加') + c.name, fields, '保存', async raw => {
      const values = {};
      for (const field of c.fields) {
        const val = raw[field.id];
        if (!val) {
          if (entry && field.type !== 'attachment' && entry.values[field.id] != null) values[field.id] = null;
          continue;
        }
        values[field.id] = field.type === 'number'
          ? Number(val)
          : field.type === 'attachment'
            ? (await upload(val, state.project === 'personal' ? null : state.project)).id
            : val;
      }
      if (!Object.keys(values).length) throw new Error('请至少填写一项内容。');
      if (entry) await api(path + '/' + url(entry.id), { values, expectedRevision: entry.revision }, 'PATCH');
      else await api(path, { values });
      await actions.refresh();
    });
  }

  function entriesTable(c, entries, view, route) {
    const cell = (f, e) => {
      const value = e.values[f.id];
      if (f.type === 'attachment' && value) {
        return el('div', 'actions', ...(Array.isArray(value) ? value : [value]).map(id => btn('下载附件', () => download(id), 'ghost btn-xs')));
      }
      if (f.type === 'record' && value) {
        return btn('打开记录', async () => display('记录', recordRow(await api('/records/' + url(value)))), 'ghost btn-xs');
      }
      return value == null ? '—' : String(value);
    };
    if (!entries.length) return empty('还没有条目。');
    const edit = e => btn('编辑条目', () => entryForm(c, route, e), 'ghost btn-xs');
    if (view === 'list') {
      return el('div', '', ...entries.map(e => el('article', 'record',
        ...c.fields.map(f => el('p', '', el('small', '', f.name + '　'), cell(f, e))),
        edit(e)
      )));
    }
    return el('div', 'table-scroll', el('table', '',
      el('thead', '', el('tr', '', ...c.fields.map(f => el('th', '', f.name)), el('th', '', '操作'))),
      el('tbody', '', ...entries.map(e => el('tr', '', ...c.fields.map(f => el('td', '', cell(f, e))), el('td', '', edit(e)))))
    ));
  }

  async function section(block, space, brief, timeline) {
    const config = block.config || {};
    const sectionEl = el('section', '', el('h3', '', block.title || ({
      brief: '当前要求', timeline: '最近进度', collection: '资料', text: '正文', 'source-card': '资料出处', reference: '来源引用'
    }[block.type] || block.type)));
    const disabled = space.structure.disabledModules?.includes(block.type);
    if (disabled && block.type !== 'source-card') return el('section', '', el('small', 'muted', (block.title || block.type) + '已停用'));

    if (block.type === 'brief') {
      const rs = [
        ...(brief?.requirements || []),
        ...(brief?.decisions || []),
        ...(brief?.openItems || []).map(body => ({ type: 'todo', body })),
        ...(brief?.pendingVerification || []).map(r => ({ type: '待核验', body: r.criteria.join('、') }))
      ];
      sectionEl.append(...(rs.length ? rs.map(r => recordRow(r)) : [empty('尚未记录要求。')]));
      if (brief?.verified?.length) sectionEl.append(el('h4', '', '已验证'), ...brief.verified.map(r => recordRow(r)));
      if (brief?.claimedVerification?.length) sectionEl.append(el('h4', '', '提交方自报 · 待核验'), ...brief.claimedVerification.map(r => recordRow(r)));
      if (brief?.nextSteps?.length) sectionEl.append(el('h4', '', '下一步'), ...brief.nextSteps.map(r => recordRow(r)));
    }

    if (block.type === 'timeline') {
      sectionEl.append(...(timeline.length ? timeline.map(r => r.type === 'handoff'
        ? recordRow(r, () => newRecord(space.projectId, null, r), () => startHandoff(space.projectId, r))
        : el('div', '', recordRow(r), btn('查看记录', () => openRecord(r.id), 'ghost btn-xs'))
      ) : [empty('项目进度与交接会显示在这里。')]));
    }

    if (block.type === 'text') sectionEl.append(el('p', 'text', config.text || ''));
    if (config.sourceId) {
      if (block.type === 'source-card' && !disabled) {
        const s = await api('/sources/' + url(config.sourceId));
        sectionEl.append(el('strong', '', s.title), el('p', 'text', s.text?.slice(0, 200) || ''));
      }
      sectionEl.append(btn('查看出处', () => sourceById(config.sourceId), 'ghost btn-xs', 'file'));
    }

    if (block.type === 'collection') {
      const c = space.structure.collections.find(c => c.id === config.collectionId);
      if (!c) return sectionEl;
      const route = '/collections/' + url(c.id) + '/entries';
      const data = await api(route + '?blockId=' + url(block.id));
      sectionEl.append(btn('添加条目', () => entryForm(c, route), 'secondary btn-xs', 'plus'));
      if (data.groups?.length) {
        for (const g of data.groups) sectionEl.append(el('h4', '', g.value || '未分组'), entriesTable(c, g.items, config.view, route));
      } else {
        sectionEl.append(entriesTable(c, items(data), config.view, route));
      }
    }

    if (!disabled) {
      for (const a of block.actions || []) {
        const route = '/spaces/' + url(space.id) + '/actions/' + url(a.id);
        const params = a.params || {};
        sectionEl.append(btn(a.label, async () => {
          if (a.type === 'openSource') showSource(await api(route, {}));
          if (a.type === 'writeHandoff') newRecord(space.projectId, route);
          if (a.type === 'addEntry') {
            const c = space.structure.collections.find(x => x.id === (params.collectionId || config.collectionId));
            if (c) entryForm(c, route);
          }
        }, 'ghost btn-xs'));
      }
    }
    return sectionEl;
  }

  async function draw(serial) {
    const pid = state.project;
    const personal = pid === 'personal';
    const project = personal ? { spaceId: 'personal', name: '个人空间' } : state.projects.find(p => p.id === pid);
    $('compose').replaceChildren();
    $('compose').dataset.key = '';
    const statusBanner = $('status-banner');
    if (statusBanner) { statusBanner.hidden = true; statusBanner.replaceChildren(); }
    const crumb = $('crumb');

    if (!pid) {
      if (crumb) { crumb.hidden = false; crumb.className = 'crumb'; crumb.textContent = '毛球之家'; }
      $('heading').textContent = '项目与空间目录';
      $('subhead').textContent = '';
      $('tools').replaceChildren(
        btn('检索资料', () => search(null), 'secondary', 'search'),
        btn('建立项目', createProject, 'primary', 'plus')
      );
      const rows = state.projects.map(p => {
        const row = btn('', () => actions.openHome(p.id), 'project-link');
        row.append(el('span', 'folder-tile', icon('folder')), el('strong', '', p.name), icon('chevron'));
        return row;
      });
      $('content').replaceChildren(el('div', 'page directory',
        el('div', 'personal-shelf',
          el('div', '', el('h2', '', '个人空间'), el('p', 'muted', '收藏原件，整理跨项目个人资料与记忆。')),
          el('div', 'actions',
            btn('打开个人空间', () => actions.openHome('personal'), 'primary', 'arrow'),
            btn('保存个人资料', () => addSource(null), 'secondary', 'file')
          )
        ),
        el('h2', '', '项目目录'),
        el('div', 'project-list', ...(rows.length ? rows : [empty('建立第一个项目后，可以在这里保存资料和交接。')]))
      ));
      return;
    }

    if (!project) throw new Error('找不到此项目。');
    const [space, brief, timeline, workspaces] = await Promise.all([
      api('/spaces/' + url(project.spaceId)),
      personal ? null : api('/projects/' + url(pid) + '/brief'),
      personal ? [] : api('/projects/' + url(pid) + '/timeline'),
      personal ? null : api('/projects/' + url(pid) + '/workspaces')
    ]);
    const page = space.structure.pages.find(p => p.id === state.page) || space.structure.pages[0];
    const blocks = await Promise.all(page.blocks.map(b => section(b, space, brief, items(timeline))));
    if (!actions.current(serial)) return;

    if (crumb) { crumb.hidden = false; crumb.className = 'crumb'; crumb.textContent = '毛球之家'; }
    $('heading').textContent = project.name;
    const workspaceList = items(workspaces);
    $('subhead').textContent = personal ? '个人资料空间' : workspaceList.map(i => i.name + ' · ' + i.workspaceRef).join(' / ');
    $('tools').replaceChildren(
      btn('检索资料', () => search(personal ? null : pid, personal), 'secondary', 'search'),
      ...(!personal ? [btn('绑定工作区', () => bindWorkspace(pid), 'secondary')] : [])
    );

    const pages = el('nav', 'pages', ...space.structure.pages.map(p => btn(p.title, () => actions.openHome(pid, p.id), page.id === p.id ? 'active' : 'ghost')));
    pages.setAttribute('aria-label', '空间页面');
    pages.querySelector('.active')?.setAttribute('aria-current', 'page');

    const grid = el('div', 'blocks', ...blocks);
    grid.style.setProperty('--columns', page.columns || 1);

    const manage = () => display('空间设置', el('div', 'settings-list',
      btn('编辑页面', () => editor.page(space, page), 'settings-row', 'edit'),
      btn('新建页面', () => editor.page(space), 'settings-row', 'plus'),
      btn('管理集合', () => editor.collections(space), 'settings-row', 'folder'),
      btn('管理模块', () => editor.modules(space), 'settings-row', 'layers'),
      space.revision > 1 ? btn('恢复布局', () => editor.restore(space), 'settings-row', 'task') : null
    ));

    let projectChatBar = null;
    if (!personal) {
      const chatButtons = [
        btn('和小毛球聊此项目', () => actions.openDraft('main', pid), 'secondary btn-sm', 'yarn')
      ];
      for (const w of workspaceList) {
        const inst = state.instances.find(i => i.id === w.instanceId);
        const allowed = inst && inst.settings?.enabled !== false && inst.settings?.allowDirect !== false &&
          (!inst.settings?.allowedProjects || inst.settings.allowedProjects.includes(pid));
        if (allowed) {
          chatButtons.push(btn(inst.name + ' · 新建项目话题', () => actions.openDraft(inst.id, pid), 'secondary btn-sm', 'bot'));
        }
      }
      if (!workspaceList.length) {
        chatButtons.push(btn('绑定工作区以开启工作 Bot 对话', () => bindWorkspace(pid), 'ghost btn-sm', 'sliders'));
      }
      projectChatBar = el('div', 'project-chat-bar',
        el('span', 'project-chat-bar-title', '项目对话与执行'),
        el('div', 'actions', ...chatButtons)
      );
    }

    const useTheme = space.structure.theme;
    const holder = el('div', 'page',
      pages,
      projectChatBar,
      el('div', 'space-actions actions',
        btn('写记录', () => newRecord(personal ? null : pid), 'primary btn-sm', 'edit'),
        btn('保存资料', () => addSource(personal ? null : pid), 'secondary btn-sm', 'file'),
        btn('空间设置', manage, 'ghost btn-sm', 'sliders')
      ),
      grid
    );
    if (/^#[0-9a-f]{6}$/i.test(useTheme)) grid.style.borderTop = '3px solid ' + useTheme;
    if (space.structure.cover) holder.prepend(el('p', 'muted', space.structure.cover));
    $('content').replaceChildren(holder);
  }

  return { draw, createProject };
};
