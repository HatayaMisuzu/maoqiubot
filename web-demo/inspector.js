import {
  $, api, at, btn, copyText, el, icon, iconBtn,
  phase, resolveActiveContext, state, url
} from './lib.js';
import { desktopSettings, hasDesktopSettings } from './desktop-settings.js';
import { daily, mainModels, mainPermissions, memories } from './main-settings.js';
import { extensions } from './extensions.js';

export function createInspector(actions) {
  const usageCache = new Map();
  const nativeHistory = new Map();
  const nativeHistoryLoading = new Set();

  function kvRow(key, valueNode) {
    return el('div', 'kv-row',
      el('span', 'kv-key', key),
      el('div', 'kv-val', valueNode)
    );
  }

  function renderUsageSection(agent) {
    if (!agent?.capabilities?.usage && agent?.adapterKey !== 'codex') return null;
    const cached = usageCache.get(agent.id);
    const section = el('section', 'inspector-section');

    const refreshBtn = btn(cached ? '刷新额度' : '查询额度', async () => {
      const data = await api('/instances/' + url(agent.id) + '/usage');
      usageCache.set(agent.id, data);
      render();
    }, 'secondary btn-xs', 'refresh');
    refreshBtn.disabled = !agent.online || !agent.capabilities?.usage;

    section.append(
      el('div', 'inspector-section-title',
        el('span', '', '原生额度'),
        refreshBtn
      )
    );

    if (!agent.online) {
      section.append(el('p', 'muted', '节点离线，恢复连接后可按需查询额度。'));
    } else if (!agent.capabilities?.usage) {
      section.append(el('p', 'muted', '此实例未报告原生额度接口。'));
    } else if (!cached) {
      section.append(el('p', 'muted', '点击「查询额度」从原生端读取当前窗口用量。'));
    } else if (!cached.windows?.length) {
      section.append(el('p', 'muted', '额度未知' + (cached.fetchedAt ? ' · ' + at(cached.fetchedAt) : '')));
    } else {
      section.append(el('small', 'muted', 'Codex App Server · ' + at(cached.fetchedAt)));
      for (const w of cached.windows) {
        const pct = Math.max(0, Math.min(100, Number(w.usedPercent) || 0));
        const fillCls = pct >= 90 ? 'usage-fill high' : pct >= 70 ? 'usage-fill warn' : 'usage-fill';
        const label = w.durationMinutes ? w.durationMinutes + ' 分钟窗口' : '用量窗口';
        const reset = w.resetsAt ? '重置 ' + at(w.resetsAt * 1000) : '';
        section.append(el('div', 'usage-row',
          el('div', 'usage-meta',
            el('span', '', label),
            el('span', '', pct + '%' + (reset ? ' · ' + reset : ''))
          ),
          el('div', 'usage-track', Object.assign(el('div', fillCls), { style: `width:${pct}%` }))
        ));
      }
    }
    return section;
  }

  function renderNativeHistorySection(thread, agent) {
    if (!thread?.sessionId && !agent?.capabilities?.nativeHistory) return null;
    const section = el('section', 'inspector-section');
    const historyKey = thread?.sessionId && !thread.nativeInvalid ? thread.id + ':' + thread.sessionId : null;
    const cached = historyKey ? nativeHistory.get(historyKey) : null;
    const loading = historyKey ? nativeHistoryLoading.has(historyKey) : false;

    const loadHistory = async before => {
      if (!historyKey || nativeHistoryLoading.has(historyKey)) return;
      nativeHistoryLoading.add(historyKey);
      render();
      const query = new URLSearchParams();
      if (before) query.set('before', before);
      try {
        const page = await api('/threads/' + url(thread.id) + '/native' + (query.size ? '?' + query : ''));
        const prev = nativeHistory.get(historyKey);
        const seen = new Set();
        const combined = [...page.items, ...(before && prev ? prev.items : [])].filter(item => {
          const k = JSON.stringify([item.turnId, item.id]);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        const cursors = new Set(before && prev ? prev.cursors : []);
        if (before) cursors.add(before);
        nativeHistory.set(historyKey, {
          items: combined,
          nextBefore: cursors.has(page.nextBefore) ? null : page.nextBefore,
          cursors,
          fetchedAt: page.fetchedAt || new Date().toISOString()
        });
      } finally {
        nativeHistoryLoading.delete(historyKey);
        render();
      }
    };

    const canRead = Boolean(historyKey && agent?.online && agent?.capabilities?.nativeHistory);
    const readBtn = canRead ? btn(loading ? '读取中…' : cached ? '刷新' : '读取原生历史', () => loadHistory(), 'secondary btn-xs', 'refresh') : null;
    if (readBtn && loading) readBtn.disabled = true;

    section.append(
      el('div', 'inspector-section-title',
        el('span', '', '原生会话与历史'),
        readBtn
      )
    );

    if (thread?.sessionId) {
      section.append(
        el('div', 'kv-list',
          kvRow('原生 ID', el('span', 'kv-val',
            el('code', '', thread.sessionId),
            iconBtn('复制原生会话 ID', () => copyText(thread.sessionId, '已复制原生会话 ID'), 'copy')
          )),
          kvRow('绑定状态', el('span', 'badge ' + (thread.nativeInvalid ? 'error' : thread.nativeArchived ? 'question' : 'online'),
            thread.nativeInvalid ? '绑定失效' : thread.nativeArchived ? '原生已归档' : '已绑定'))
        )
      );
      if (thread.nativeInvalid) {
        section.append(
          el('p', 'muted', thread.nativeInvalid),
          btn('创建替代话题继续', () => actions.replaceNative(thread), 'secondary btn-sm', 'branch')
        );
        return section;
      }
    } else {
      section.append(el('p', 'muted', '发送首条消息后，将自动创建并绑定原生会话。'));
      return section;
    }

    if (cached) {
      section.append(el('small', 'muted', (agent?.online ? '原生端读取' : '离线缓存') + ' · ' + at(cached.fetchedAt) + ' · ' + cached.items.length + ' 条'));
      if (cached.items.length) {
        const list = el('div', 'native-history-list scroll-sleek');
        for (const item of cached.items) {
          list.append(el('article', 'native-message ' + (item.role === 'user' ? 'user' : ''),
            el('small', 'muted', item.role === 'user' ? '原生用户' : '原生 Agent'),
            el('p', 'text', item.text)
          ));
        }
        section.append(list);
      } else {
        section.append(el('p', 'muted', '原生端暂无可展示的文本消息。'));
      }
      if (cached.nextBefore && agent?.online) {
        section.append(btn('加载更早原生消息', () => loadHistory(cached.nextBefore), 'ghost btn-xs'));
      }
    } else if (agent?.capabilities?.nativeHistory) {
      section.append(el('p', 'muted', agent.online ? '可按需从原生客户端读取文本记录，不占用主对话流。' : '节点离线，恢复连接后可读取原生历史。'));
    } else {
      section.append(el('p', 'muted', '此实例不提供只读原生历史接口，工作台将保留已接收消息缓存。'));
    }

    return section;
  }

  function renderMainInspector(ctx, snap) {
    const t = snap?.thread || ctx.thread;
    const pid = t ? t.projectId : state.project;
    const project = pid ? state.projects.find(p => p.id === pid) : null;
    const typeLabel = ctx.isMainThread ? '固定主会话' : t ? '侧边会话' : '新侧聊草稿';
    const refreshView = () => actions.refresh();

    const sessionCard = el('section', 'inspector-section',
      el('div', 'inspector-section-title',
        el('span', '', '主控会话'),
        el('span', 'badge brand', typeLabel)
      ),
      el('div', 'kv-list',
        kvRow('所属范围', project
          ? btn(project.name, () => actions.openHome(project.id), 'ghost btn-xs', 'folder')
          : el('span', '', '个人范围')),
        kvRow('当前模型', btn(snap?.mainChat?.model || '配置主聊模型', () => mainModels(refreshView, actions.load), 'ghost btn-xs', 'sliders'))
      ),
      t ? el('div', 'actions',
        btn('重置上下文', () => actions.resetContext(t), 'ghost btn-xs', 'refresh'),
        btn('工具预算', () => actions.editThreadBudget(t), 'ghost btn-xs', 'sliders')
      ) : null
    );

    const linked = Object.values(snap?.linkedTasks || {});
    const tasksCard = el('section', 'inspector-section',
      el('div', 'inspector-section-title',
        el('span', '', '关联委派任务'),
        el('span', 'badge', String(linked.length))
      ),
      ...(linked.length ? linked.map(task => {
        const assignee = state.instances.find(i => i.id === task.instanceId)?.name || task.instanceId;
        return el('div', 'record',
          el('div', 'record-head',
            el('strong', '', assignee),
            el('span', 'badge ' + (task.status === 'verified' || task.status === 'completed' ? 'online' : task.status === 'waiting_input' ? 'question' : 'working'), phase(task.status))
          ),
          el('p', 'muted', (task.goal || '').slice(0, 90)),
          btn('打开工作话题', () => actions.openTask(task.id), 'secondary btn-xs', 'task')
        );
      }) : [el('p', 'muted', '本会话暂无委派任务。可使用顶栏「委派任务」指派给工作 Bot。')])
    );

    const toolsCard = el('section', 'inspector-section',
      el('div', 'inspector-section-title', el('span', '', '主控能力与记忆')),
      el('div', 'settings-list',
        t ? btn('记忆候选', () => memories(t.id), 'settings-row', 'file') : null,
        t ? btn('事项与提醒', () => daily(t.id), 'settings-row', 'clock') : null,
        btn('主聊工具权限', () => mainPermissions(), 'settings-row', 'shield'),
        btn('主聊人格设定', () => actions.editPersona(), 'settings-row', 'edit'),
        btn('插件与 Skill', () => extensions(), 'settings-row', 'layers')
      )
    );

    return [sessionCard, tasksCard, toolsCard];
  }

  function renderWorkBotInspector(ctx, snap) {
    const t = snap?.thread || ctx.thread;
    const agent = ctx.agent;
    const pid = t ? t.projectId : state.project;
    const project = pid ? state.projects.find(p => p.id === pid) : null;
    const caps = agent?.capabilities || {};
    const capBadges = [
      caps.sessionList ? '原生目录' : null,
      caps.sessionImport ? '会话导入' : null,
      caps.nativeHistory ? '原生历史' : null,
      caps.nativeActions?.includes('fork') ? '原生分支' : null,
      caps.usage ? '额度查询' : null
    ].filter(Boolean);

    const infoCard = el('section', 'inspector-section',
      el('div', 'inspector-section-title',
        el('span', '', '执行实例'),
        el('span', 'badge ' + (agent?.settings?.enabled === false ? 'error' : agent?.online ? 'online' : ''),
          agent?.settings?.enabled === false ? '已停用' : agent?.online ? '在线' : '离线')
      ),
      el('div', 'kv-list',
        kvRow('适配器', el('span', 'mono', agent?.adapterKey || '未知')),
        agent?.profileId ? kvRow('Profile', el('span', 'mono', agent.profileId)) : null,
        agent?.workspaceRef ? kvRow('工作区', el('span', 'kv-val',
          el('code', '', agent.workspaceRef),
          iconBtn('复制工作区路径', () => copyText(agent.workspaceRef, '已复制工作区路径'), 'copy')
        )) : null,
        kvRow('当前范围', project
          ? btn(project.name, () => actions.openHome(project.id), 'ghost btn-xs', 'folder')
          : el('span', '', '个人范围')),
        agent?.lastSeen ? kvRow('最近心跳', el('span', 'muted', at(agent.lastSeen))) : null,
        agent?.settings ? kvRow('策略', el('span', 'muted',
          (agent.settings.allowDirect === false ? '禁直聊' : '可直聊') + ' · ' +
          (agent.settings.allowDelegate === false ? '禁委派' : '可委派')
        )) : null
      ),
      capBadges.length ? el('div', 'chips', ...capBadges.map(label => el('span', 'badge', label))) : null,
      agent?.settings?.description ? el('p', 'muted', agent.settings.description) : null,
      el('div', 'actions',
        agent ? btn('Bot 设置', () => actions.botSettings(agent), 'secondary btn-xs', 'sliders') : null,
        caps.sessionList ? btn('原生目录', () => actions.nativeCatalog(agent), 'secondary btn-xs', 'folderOpen') : null,
        hasDesktopSettings() ? btn('Agent 设置', () => desktopSettings(actions.onSettingsChanged), 'ghost btn-xs', 'terminal') : null
      )
    );

    const taskCard = snap?.task ? el('section', 'inspector-section',
      el('div', 'inspector-section-title',
        el('span', '', '任务与交付'),
        el('span', 'badge info', phase(snap.task.status))
      ),
      el('p', 'text', snap.task.goal || ''),
      snap.task.brief?.doneWhen?.length
        ? el('div', 'kv-list',
            ...snap.task.brief.doneWhen.map((c, idx) => kvRow('条件 ' + (idx + 1), el('span', '', c)))
          )
        : null,
      snap.task.brief?.coordination
        ? kvRow('协调模式', el('span', '', snap.task.brief.coordination.mode + (snap.task.brief.coordination.paused ? '（已暂停）' : '')))
        : null
    ) : null;

    return [
      infoCard,
      renderUsageSection(agent),
      renderNativeHistorySection(t, agent),
      taskCard
    ].filter(Boolean);
  }

  function render() {
    const panel = $('inspector');
    const stage = $('stage');
    const toggleBtn = $('inspector-btn');
    if (!panel || !stage) return;

    const showToggle = state.view === 'chat';
    if (toggleBtn) toggleBtn.hidden = !showToggle;

    const open = showToggle && actions.isInspectorOpen();
    panel.hidden = !open;
    stage.classList.toggle('inspector-closed', !open);
    if (toggleBtn) {
      toggleBtn.classList.toggle('active', open);
      toggleBtn.setAttribute('aria-expanded', String(open));
    }
    if (!open) {
      panel.replaceChildren();
      return;
    }

    const ctx = resolveActiveContext();
    const snap = state.snapshot?.thread?.id === ctx.threadId ? state.snapshot : null;
    const body = ctx.isMain ? renderMainInspector(ctx, snap) : renderWorkBotInspector(ctx, snap);

    panel.replaceChildren(
      el('div', 'inspector-head',
        el('span', '', '上下文与状态'),
        iconBtn('收起面板', () => actions.toggleInspector(false), 'close')
      ),
      ...body
    );
  }

  return { render };
}
