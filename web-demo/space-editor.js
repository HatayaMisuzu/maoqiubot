import { $, api, btn, el, form, items, state, url } from './lib.js';

const types = [
  { id: 'brief', name: '项目简报' }, { id: 'timeline', name: '项目时间线' }, { id: 'collection', name: '集合视图' },
  { id: 'text', name: '正文' }, { id: 'source-card', name: '资料出处' }, { id: 'reference', name: '来源引用' }
];
const fieldTypes = [
  { id: 'text', name: '文本' }, { id: 'number', name: '数值' }, { id: 'date', name: '日期' },
  { id: 'select', name: '单选' }, { id: 'attachment', name: '附件' }, { id: 'record', name: '记录引用' }
];
const title = block => block.title || types.find(t => t.id === block.type)?.name || block.type;
const optional = (options, name = '无') => [{ id: '', name }, ...options];
const columns = [1, 2, 3, 4].map(n => ({ id: String(n), name: n + ' 栏' }));
const path = (space, action) => '/spaces/' + url(space.id) + '/' + action;
const toValue = (field, raw) => raw === '' ? null : field.type === 'number' ? Number(raw) : field.type === 'attachment' ? raw.split(/\s+/) : raw;

export function spaceEditor(actions, display) {
  function preview(titleText, previewData, apply, description, back) {
    display(titleText,
      description,
      ...previewData.structure.pages.map(page => el('div', 'record',
        el('strong', '', page.title + ' · ' + page.columns + ' 栏'),
        el('small', 'muted', page.blocks.map(title).join(' / '))
      )),
      previewData.migratedEntries ? el('p', 'text', previewData.migratedEntries + ' 条现有条目将更新。') : null,
      ...((previewData.scope === 'layout' ? previewData.summary : []) || []).map(text => el('small', 'muted', text)),
      el('div', 'actions', btn('应用变更', async () => {
        const saved = await apply();
        $('dialog').close();
        await actions.openHome(state.project, saved.pageId || state.page);
      }, 'primary')),
      ...(back ? [{ back }] : [])
    );
  }

  async function change(space, operations, back) {
    const body = { expectedRevision: space.revision, operations };
    const endpoint = path(space, 'changes');
    const result = await api(endpoint, { ...body, mode: 'preview' });
    preview('预览空间变更', result, () => api(endpoint, { ...body, mode: 'apply' }), null, back);
  }

  function page(space, active, back) {
    const reopen = () => page(space, active, back);
    const ui = form(active ? '编辑页面' : '新建页面', [
      { key: 'title', label: '页面标题', value: active?.title, required: true },
      { key: 'columns', label: '分栏', options: columns, value: active?.columns }
    ], '预览', d => change(space, [{ op: active ? 'updatePage' : 'createPage', pageId: active?.id, title: d.title, columns: Number(d.columns) }], reopen), { back });
    if (!active) return;
    const index = space.structure.pages.indexOf(active);
    const configuration = el('div', 'actions', btn('管理页面块', () => blocks(space, active, reopen), 'secondary btn-sm'));
    if (index > 0) configuration.append(btn('页面前移', () => change(space, [{ op: 'movePage', pageId: active.id, index: index - 1 }], reopen), 'ghost btn-sm'));
    if (index < space.structure.pages.length - 1) configuration.append(btn('页面后移', () => change(space, [{ op: 'movePage', pageId: active.id, index: index + 1 }], reopen), 'ghost btn-sm'));
    if (space.structure.pages.length > 1) configuration.append(btn('移除页面', () => change(space, [{ op: 'removePage', pageId: active.id }], reopen), 'destructive-ghost btn-sm'));
    ui.body.prepend(configuration);
  }

  function blocks(space, pageObj, back) {
    const reopen = () => blocks(space, pageObj, back);
    const act = (op, index) => ({ op, pageId: pageObj.id, blockId: pageObj.blocks[index].id });
    display('页面块 · ' + pageObj.title,
      btn('添加块', () => block(space, pageObj, null, reopen), 'secondary btn-sm', 'plus'),
      ...pageObj.blocks.map((b, index) => el('div', 'record',
        el('strong', '', title(b)),
        el('div', 'actions',
          btn('编辑', () => block(space, pageObj, b, reopen), 'ghost btn-xs'),
          index > 0 ? btn('上移', () => change(space, [{ ...act('moveBlock', index), index: index - 1 }], reopen), 'ghost btn-xs') : null,
          index < pageObj.blocks.length - 1 ? btn('下移', () => change(space, [{ ...act('moveBlock', index), index: index + 1 }], reopen), 'ghost btn-xs') : null,
          btn('移除', () => change(space, [act('removeBlock', index)], reopen), 'destructive-ghost btn-xs')
        )
      )),
      ...(back ? [{ back }] : [])
    );
  }

  async function block(space, pageObj, existing, back) {
    const config = existing?.config || {};
    const collections = space.structure.collections;
    const params = new URLSearchParams({ kind: 'source', limit: '100' });
    if (space.projectId) params.set('projectId', space.projectId);
    else params.set('scope', 'personal');
    if (config.sourceId) params.set('ref', config.sourceId);
    const sources = items(await api('/search?' + params)).map(s => ({ id: s.id, name: s.summary.slice(0, 80) }));

    const ui = form(existing ? '编辑页面块' : '添加页面块', [
      { key: 'type', label: '块类型', options: types, value: existing?.type || 'text' },
      { key: 'title', label: '标题（可选）', value: existing?.title },
      { key: 'text', label: '正文', type: 'textarea', value: config.text },
      { key: 'sourceId', label: '来源', options: optional(sources, '请选择来源'), value: config.sourceId },
      { key: 'collectionId', label: '集合', options: optional(collections, '请选择集合'), value: config.collectionId },
      { key: 'view', label: '视图', options: [{ id: 'table', name: '表格' }, { id: 'list', name: '列表' }], value: config.view },
      { key: 'groupBy', label: '分组字段', options: [] },
      { key: 'sort', label: '排序字段', options: [] },
      { key: 'direction', label: '排序顺序', options: [{ id: 'asc', name: '升序' }, { id: 'desc', name: '降序' }], value: config.sort?.direction },
      { key: 'filter', label: '筛选字段', options: [] },
      { key: 'filterValue', label: '筛选值', value: config.filter?.value }
    ], '预览', values => {
      const b = { type: values.type, title: values.title || null, config: {}, actions: existing?.type === values.type ? existing.actions : [] };
      if (values.type === 'text') b.config = { text: values.text };
      if (['reference', 'source-card'].includes(values.type)) {
        if (!values.sourceId) throw Error('请选择来源。');
        b.config = { sourceId: values.sourceId };
      }
      if (values.type === 'collection') {
        const c = collections.find(c => c.id === values.collectionId);
        if (!c) throw Error('请选择集合。');
        const f = c.fields.find(f => f.id === values.filter);
        if (f && values.filterValue === '') throw Error('请填写筛选值。');
        b.config = {
          collectionId: c.id,
          view: values.view,
          ...(values.groupBy ? { groupBy: values.groupBy } : {}),
          ...(values.sort ? { sort: { fieldId: values.sort, direction: values.direction } } : {}),
          ...(f ? { filter: { fieldId: f.id, value: toValue(f, values.filterValue) } } : {})
        };
      }
      return change(space, [{ op: existing ? 'updateBlock' : 'addBlock', pageId: pageObj.id, blockId: existing?.id, block: b }], () => block(space, pageObj, existing, back));
    }, { back });

    const controls = ui.controls;
    const show = (keys, enabled) => keys.forEach(key => { controls[key].parentElement.hidden = !enabled; });

    function updateFields(preserve) {
      const fields = collections.find(c => c.id === controls.collectionId.value)?.fields || [];
      const previous = { groupBy: config.groupBy, sort: config.sort?.fieldId, filter: config.filter?.fieldId };
      for (const key of ['groupBy', 'sort', 'filter']) {
        const candidates = key === 'filter' ? fields.filter(f => !['record', 'attachment'].includes(f.type)) : fields;
        controls[key].replaceChildren(...optional(candidates).map(f => Object.assign(el('option', '', f.name), { value: f.id })));
        controls[key].value = preserve && candidates.some(f => f.id === previous[key]) ? previous[key] : '';
      }
    }

    function toggle() {
      const t = controls.type.value;
      const collection = t === 'collection';
      show(['text'], t === 'text');
      show(['sourceId'], ['reference', 'source-card'].includes(t));
      show(['collectionId', 'view', 'groupBy', 'sort', 'filter'], collection);
      show(['direction'], collection && !!controls.sort.value);
      show(['filterValue'], collection && !!controls.filter.value);
    }

    controls.collectionId.onchange = () => { updateFields(false); toggle(); };
    for (const control of [controls.type, controls.sort, controls.filter]) control.onchange = toggle;
    updateFields(true);
    toggle();
  }

  function collections(space, back) {
    const reopen = () => collections(space, back);
    display('管理集合',
      btn('新建集合', () => collection(space, null, reopen), 'secondary btn-sm', 'plus'),
      ...space.structure.collections.map(c => el('div', 'record',
        el('strong', '', c.name),
        el('div', 'actions',
          btn('改名', () => collection(space, c, reopen), 'ghost btn-xs'),
          btn('添加字段', () => field(space, c, null, reopen), 'ghost btn-xs')
        ),
        ...c.fields.map(f => el('div', 'inline',
          el('small', '', f.name + ' · ' + fieldTypes.find(x => x.id === f.type)?.name),
          btn('编辑字段', () => field(space, c, f, reopen), 'ghost btn-xs')
        ))
      )),
      ...(back ? [{ back }] : [])
    );
  }

  function collection(space, existing, back) {
    const reopen = () => collection(space, existing, back);
    form(existing ? '集合改名' : '新建集合', [
      { key: 'name', label: '集合名称', value: existing?.name, required: true }
    ], '预览', d => change(space, [
      existing
        ? { op: 'updateCollection', collectionId: existing.id, name: d.name }
        : { op: 'createCollection', name: d.name, fields: [{ id: 'title', type: 'text', name: '名称' }] }
    ], reopen), { back });
  }

  function field(space, c, existing, back) {
    const reopen = () => field(space, c, existing, back);
    const ui = form(existing ? '编辑集合字段' : '添加集合字段', [
      { key: 'name', label: '字段名称', value: existing?.name, required: true },
      { key: 'type', label: '字段类型', options: fieldTypes, value: existing?.type },
      { key: 'options', label: '单选选项（每行一项）', type: 'textarea', value: existing?.options?.join('\n') }
    ], '继续', async d => {
      const replacement = {
        name: d.name,
        type: d.type,
        options: d.type === 'select' ? d.options.split('\n').map(x => x.trim()).filter(Boolean) : null
      };
      if (d.type === 'select' && !replacement.options.length) throw Error('请至少填写一个选项。');
      if (!existing) return change(space, [{ op: 'addField', collectionId: c.id, field: replacement }], reopen);
      const op = { op: 'updateField', collectionId: c.id, fieldId: existing.id, field: replacement };
      const sameType = existing.type === replacement.type;
      if (sameType && (replacement.type !== 'select' || JSON.stringify(existing.options) === JSON.stringify(replacement.options))) {
        return change(space, [op], reopen);
      }
      const entries = items(await api('/collections/' + url(c.id) + '/entries'));
      const affected = entries.filter(e => e.values[existing.id] != null && (!sameType || !replacement.options.includes(e.values[existing.id])));
      if (!affected.length) return change(space, [op], reopen);
      const fields = affected.map((e, i) => ({
        key: e.id,
        label: '条目 ' + (e.values.title ?? i + 1) + ' · 原值 ' + String(e.values[existing.id]).slice(0, 80),
        type: ({ number: 'number', date: 'date' }[d.type] || 'text'),
        options: d.type === 'select' ? optional(replacement.options.map(id => ({ id, name: id })), '留空') : undefined
      }));
      const convert = form('转换 ' + affected.length + ' 个字段值', fields, '预览', values => change(space, [{
        ...op,
        migration: Object.fromEntries(Object.entries(values).map(([id, value]) => [id, toValue(replacement, value)])),
        entryRevisions: Object.fromEntries(affected.map(e => [e.id, e.revision]))
      }], reopen), { back: reopen });
      convert.body.prepend(el('p', 'muted', '留空会清除对应值。附件引用可填写一个或多个附件 ID。'));
    }, { back });
    const toggle = () => { ui.controls.options.parentElement.hidden = ui.controls.type.value !== 'select'; };
    ui.controls.type.onchange = toggle;
    toggle();
  }

  async function modules(space, back) {
    const reopen = () => modules(space, back);
    const choices = items(await api('/modules'));
    const ui = form('管理模块', [], '预览', () => {
      const operations = Array.from(list.querySelectorAll('input'), input => ({ op: 'toggleModule', type: input.value, enabled: input.checked }))
        .filter(op => op.enabled === space.structure.disabledModules.includes(op.type));
      if (!operations.length) throw Error('模块状态没有变动。');
      return change(space, operations, reopen);
    }, { back });
    const list = el('fieldset', 'handoff-files', el('legend', '', '已启用的模块'));
    for (const choice of choices) {
      const input = el('input');
      input.type = 'checkbox';
      input.value = choice.type;
      input.checked = !space.structure.disabledModules.includes(choice.type);
      list.append(el('label', '', input, choice.name));
    }
    ui.body.prepend(list);
  }

  function restore(space, back) {
    const reopen = () => restore(space, back);
    form('恢复空间', [
      { key: 'revision', label: '历史版本（当前为 ' + space.revision + '）', type: 'number', value: space.revision - 1, min: 1, max: Math.max(1, space.revision - 1), required: true },
      {
        key: 'scope',
        label: '恢复范围',
        options: [
          { id: 'layout', name: '页面布局，保留当前集合字段' },
          { id: 'structure', name: '页面布局和历史集合字段' }
        ]
      }
    ], '预览', d => previewRestore(space, { expectedRevision: space.revision, targetRevision: Number(d.revision), scope: d.scope }, reopen), { back });
  }

  async function previewRestore(space, body, back) {
    const endpoint = path(space, 'restore');
    const result = await api(endpoint, { ...body, mode: 'preview' });
    if (!result.conflicts.length) {
      preview('预览恢复', result, () => api(endpoint, { ...body, mode: 'apply' }),
        el('p', 'muted', body.scope === 'layout' ? '集合字段和条目将保留。' : '将启用历史集合字段，现有条目将保留。'), back);
      return;
    }
    const edits = result.conflicts.map((conflict, index) => {
      const c = result.structure.collections.find(c => c.id === conflict.collectionId);
      const f = c.fields.find(f => f.id === conflict.fieldId);
      return {
        f,
        conflict,
        key: String(index),
        label: c.name + ' / ' + f.name + ' · ' + conflict.entryId.slice(0, 8),
        type: ({ number: 'number', date: 'date' }[f.type] || 'text'),
        options: f.type === 'select' ? optional((f.options || []).map(id => ({ id, name: id })), '留空') : undefined
      };
    });
    const ui = form('恢复前转换 ' + edits.length + ' 个字段值', edits, '继续预览', values => {
      const migrations = {};
      const entryRevisions = {};
      for (const { key, f, conflict } of edits) {
        (migrations[conflict.entryId] ??= {})[f.id] = toValue(f, values[key]);
        entryRevisions[conflict.entryId] = conflict.entryRevision;
      }
      return previewRestore(space, { ...body, migrations, entryRevisions }, back);
    }, { back });
    ui.body.prepend(el('p', 'muted', '留空会清除对应值。完成转换后可预览并应用。'));
  }

  return { page, collections, modules, restore };
}
