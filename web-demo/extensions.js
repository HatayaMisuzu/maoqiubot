import { $, api, btn, confirmDialog, displayDialog, el, form, notice } from './lib.js';

const plug = body => api('/chat/plugins', body);

export async function extensions(back) {
  const state = await plug();
  const body = [
    state.safe ? el('p', 'muted', '安全模式已暂停外部扩展。') : null,
    state.configurationError ? el('p', 'form-err', state.configurationError) : null,
    ...state.plugins.map(p => {
      const current = p.current;
      const pending = p.pending;
      return el('article', 'record',
        el('div', 'record-head',
          el('strong', '', current?.manifest.name || pending?.manifest.name || p.id),
          el('span', 'badge ' + (p.loaded ? 'online' : ''), p.loaded ? '已加载' : p.enabled ? '等待加载' : '已停用')
        ),
        el('small', 'muted', [current?.manifest.version, current?.source, current?.projectId].filter(Boolean).join(' · ')),
        pending ? el('small', 'muted', '待审查 ' + pending.manifest.version) : null,
        p.error ? el('p', 'form-err', p.error) : null,
        p.restartRequired ? el('small', 'muted', '外部代码的进程级效果须重启工作台清理。') : null,
        ...[['工具', p.tools], ['Skill', p.skills], ['模型', p.providers], ['事件', p.events]]
          .filter(([, v]) => v.length)
          .map(([label, v]) => el('small', 'muted', label + ' · ' + v.join('、'))),
        el('div', 'actions',
          pending ? btn('审查并启用', () => review(p, 'candidate', true, back), 'primary btn-xs')
            : !p.loaded && current ? btn('审查并启用', () => review(p, 'current', true, back), 'secondary btn-xs') : null,
          current ? btn('查看包内容', () => review(p, 'current', false, back), 'ghost btn-xs') : null,
          current?.manifest.configSchema ? btn('配置', () => configure(p, back), 'secondary btn-xs') : null,
          p.testAvailable ? btn('测试连接', () => testPlugin(p, back), 'secondary btn-xs') : null,
          p.enabled ? btn('停用', async () => { await plug({ action: 'disable', id: p.id }); await extensions(back); }, 'ghost btn-xs') : null,
          p.previous ? btn('审查回滚', () => review(p, 'previous', true, back), 'ghost btn-xs') : null,
          current?.source !== 'bundled' && pending?.source !== 'bundled' ? btn('卸载', async () => {
            const ok = await confirmDialog({
              title: '卸载扩展',
              body: '卸载「' + p.id + '」的安装版本和草稿？',
              confirmLabel: '确认卸载',
              destructive: true
            });
            if (!ok) { await extensions(back); return; }
            await plug({ action: 'uninstall', id: p.id });
            await extensions(back);
          }, 'destructive-ghost btn-xs') : null
        )
      );
    })
  ];

  displayDialog('插件与 Skill', body, [
    btn('导入目录或 ZIP', () => importLocal(back), 'primary'),
    btn('导入固定 Git 提交', () => importGit(back), 'secondary'),
    btn('添加声明式 API', () => apiTool(back), 'secondary'),
    btn('关闭', () => $('dialog').close(), 'ghost')
  ], { back, wide: true });
}

function importLocal(back) {
  form('导入插件或标准 Skill', [
    { key: 'path', label: '本机目录或 ZIP 文件的绝对路径', required: true },
    { key: 'id', label: 'Pi Skill 包 ID（导入 Pi package 时填写）' },
    { key: 'projectId', label: '限定项目 ID（可留空）' }
  ], '生成待审查版本', async values => {
    await plug({ action: 'stage', ...values, projectId: values.projectId || undefined });
    await extensions(back);
  }, { back: () => extensions(back) });
}

function importGit(back) {
  form('导入固定 GitHub 提交', [
    { key: 'github', label: '仓库 owner/repo', required: true },
    { key: 'commit', label: '完整的 Git commit ID', required: true }
  ], '下载待审查版本', async values => {
    await plug({ action: 'stage', ...values });
    await extensions(back);
  }, { back: () => extensions(back) });
}

function apiTool(back) {
  const manifest = {
    id: 'my-api', name: '业务查询', version: '1.0.0', hostApi: 1, description: '查询业务数据。',
    capabilities: ['tools', 'network.api'],
    httpTools: [{
      name: 'lookup', description: '按标识查询业务记录。', endpoint: 'https://example.org/api',
      path: '/items/{id}', method: 'GET',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }
    }]
  };
  form('添加或更新声明式 API 扩展', [
    { key: 'manifest', label: '插件清单 JSON', type: 'textarea', value: JSON.stringify(manifest, null, 2), required: true },
    { key: 'projectId', label: '限定项目 ID（可留空）' }
  ], '生成待审查版本', async values => {
    await plug({ action: 'stageManifest', manifest: JSON.parse(values.manifest), projectId: values.projectId || undefined });
    await extensions(back);
  }, { back: () => extensions(back) });
}

async function review(p, version, canActivate = true, back) {
  const data = await plug({ action: 'review', id: p.id, version });
  const mode = version === 'previous' ? 'rollback' : 'activate';
  const manifest = data.manifest;
  const hasCode = Boolean(manifest.entry && data.source !== 'bundled');
  const hasNetwork = manifest.capabilities.some(cap => cap.startsWith('network.'));

  const files = data.files.map(file => el('details', 'fold-card',
    el('summary', '', file.path),
    file.before ? el('div', 'muted', el('strong', '', '之前'), el('pre', 'text', file.before)) : null,
    file.after ? el('div', '', el('strong', '', '当前'), el('pre', 'text', file.after)) : null,
    btn('读取完整文本', async () => {
      const result = await plug({ action: 'source', id: p.id, version, digest: data.digest, path: file.path });
      displayDialog(file.path, [el('pre', 'text', result.text)], [
        btn('返回审查', () => review(p, version, canActivate, back), 'secondary')
      ], { back: () => review(p, version, canActivate, back), wide: true });
    }, 'ghost btn-xs')
  ));

  displayDialog('审查 ' + manifest.name, [
    el('small', 'muted', manifest.version + ' · ' + data.source),
    el('p', '', manifest.description),
    el('small', 'muted', '能力 · ' + manifest.capabilities.join('、')),
    data.addedCapabilities.length ? el('small', 'muted', '新增能力 · ' + data.addedCapabilities.join('、')) : null,
    hasCode ? el('p', 'form-err', '这是本机可执行代码。启用后代码具有与工作台进程相同的权限。') : null,
    hasNetwork ? el('p', 'muted', '此版本可以把查询、URL 或已配置的业务参数发送到网络服务。') : null,
    ...files
  ], [
    canActivate ? btn(mode === 'rollback' ? '确认回滚' : '确认启用', async () => {
      const action = mode === 'rollback' ? '回滚' : '启用';
      const ok = await confirmDialog({
        title: action + '扩展',
        body: action + ' ' + manifest.name + ' ' + manifest.version +
          (hasCode ? '，授予本机代码执行权限' : '') +
          (hasNetwork ? '，允许清单声明的网络能力' : '') + '？',
        confirmLabel: '确认' + action,
        destructive: hasCode
      });
      if (!ok) { await review(p, version, canActivate, back); return; }
      await plug({ action: mode, id: p.id, digest: data.digest, trustCode: hasCode, allowNetwork: hasNetwork });
      await extensions(back);
    }, 'primary') : null,
    version !== 'previous' ? btn('静态验证', async () => {
      const result = await plug({ action: 'validate', id: p.id });
      notice('通过 ' + result.checks.join('、') + '。本次为静态检查。');
    }, 'secondary') : null,
    btn('导出 ZIP', async () => {
      const result = await plug({ action: 'export', id: p.id, version });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([Uint8Array.from(atob(result.data), s => s.charCodeAt(0))], { type: 'application/zip' }));
      link.download = result.filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }, 'ghost'),
    btn('返回列表', () => extensions(back), 'ghost')
  ], { back: () => extensions(back), wide: true });
}

function configure(p, back) {
  const web = p.id === 'web';
  const fields = web ? [
    { key: 'provider', label: '搜索服务', options: [{ id: '', name: '仅网页读取' }, { id: 'brave', name: 'Brave Search' }, { id: 'searxng', name: 'SearXNG' }], value: p.config.provider || '' },
    { key: 'endpoint', label: 'SearXNG JSON 搜索端点', value: p.config.endpoint, placeholder: 'https://example.org/search' },
    { key: 'keyEnv', label: 'Brave 密钥的环境变量名', value: p.config.keyEnv, placeholder: 'MAOQIU_PLUGIN_KEY_BRAVE' },
    { key: 'privateLan', label: '允许连接指定局域网 SearXNG', options: [{ id: 'off', name: '关闭' }, { id: 'on', name: '开启（HTTP 为明文）' }], value: p.config.privateLan ? 'on' : 'off' },
    { key: 'proxy', label: '公开网页代理', options: [{ id: 'environment', name: '使用代理设置或环境变量' }, { id: 'direct', name: '始终直连' }], value: p.config.proxy || 'environment' },
    { key: 'proxyUrl', label: 'HTTP CONNECT 代理地址（可选）', value: p.config.proxyUrl, placeholder: 'http://127.0.0.1:7890' },
    { key: 'language', label: '默认语言', value: p.config.language },
    { key: 'region', label: '默认地区', value: p.config.region },
    { key: 'maxResults', label: '结果数上限', type: 'number', value: p.config.maxResults },
    { key: 'timeoutMs', label: '超时（毫秒）', type: 'number', value: p.config.timeoutMs }
  ] : [{ key: 'json', label: '配置 JSON（密钥填写环境变量引用）', type: 'textarea', value: JSON.stringify(p.config, null, 2) }];

  form('配置 ' + p.id, fields, '保存', async values => {
    const config = web
      ? Object.fromEntries(Object.entries(values).filter(([key, v]) => v && key !== 'privateLan')
        .map(([key, v]) => [key, ['maxResults', 'timeoutMs'].includes(key) ? Number(v) : v]))
      : JSON.parse(values.json || '{}');
    if (web && values.privateLan === 'on') {
      const ok = await confirmDialog({
        title: '确认局域网访问',
        body: '允许此插件访问填写的局域网搜索端点？',
        confirmLabel: '允许'
      });
      if (!ok) { configure(p, back); return; }
      config.privateLan = true;
    }
    const network = p.enabled && p.current.manifest.capabilities.some(cap => cap.startsWith('network.'));
    if (network) {
      const ok = await confirmDialog({
        title: '确认网络配置',
        body: '应用此插件的网络配置？',
        confirmLabel: '确认应用'
      });
      if (!ok) { configure(p, back); return; }
    }
    await plug({ action: 'configure', id: p.id, config, allowNetwork: network });
    await extensions(back);
  }, { back: () => extensions(back) });
}

function testPlugin(p, back) {
  form('测试 ' + p.id, [
    { key: 'kind', label: '测试内容', options: [{ id: 'search', name: '搜索' }, { id: 'read', name: '读取网页' }], value: 'read' },
    { key: 'value', label: '公开搜索词或网页 URL', required: true }
  ], '发送测试请求', async input => {
    const result = await plug({ action: 'test', id: p.id, input });
    displayDialog('测试结果', [el('pre', 'text', JSON.stringify(result, null, 2))], [
      btn('返回插件列表', () => extensions(back), 'secondary')
    ], { back: () => extensions(back), wide: true });
  }, { back: () => extensions(back) });
}
