import {
  $, basenamePath, btn, el, findThreadAny, getMainBot, getWorkBots,
  icon, iconBtn, localFlag, resolveActiveContext, setLocalFlag, state
} from './lib.js';
import { hasDesktopSettings } from './desktop-settings.js';

const foldKeyMainSides = 'mao-fold:main-sides';
const foldKeyMainArchive = 'mao-fold:main-archive';
const foldKeyBot = id => 'mao-fold:bot:' + id;

function projectTag(projectId) {
  if (!projectId) return '';
  return state.projects.find(p => p.id === projectId)?.name || '';
}

function adapterLabel(bot) {
  if (bot.adapterKey === 'codex') return 'Codex';
  if (bot.adapterKey === 'dsh') return 'DSH';
  if (bot.adapterKey === 'model-api') return 'API';
  return bot.adapterKey || 'Bot';
}

function threadRow(thread, currentId, actions, options = {}) {
  const isCurrent = currentId === thread.id;
  const wrap = el('div', 'row-wrap');
  if (isCurrent) wrap.dataset.current = 'true';

  const symbol = options.symbol || (thread.taskId ? 'task' : thread.kind === 'side' ? 'chat' : 'chat');
  const title = thread.title || (thread.instanceId === 'main' ? '侧边会话' : '新会话');
  const b = btn('', () => actions.openThread(thread.id), 'row-btn', symbol);
  b.append(el('span', 'title', title));
  b.title = title;
  if (isCurrent) b.setAttribute('aria-current', 'page');

  const tag = options.tag ?? projectTag(thread.projectId);
  if (tag) b.append(el('span', 'row-tag', tag));
  wrap.append(b);

  if (options.menu !== false && actions.openThreadMenu) {
    const more = iconBtn('会话操作', e => {
      e?.stopPropagation?.();
      actions.openThreadMenu(thread);
    }, 'more', 'row-more');
    wrap.append(more);
  }
  return wrap;
}

function draftRow(label, current) {
  const wrap = el('div', 'row-wrap');
  if (current) wrap.dataset.current = 'true';
  const b = el('button', 'row-btn', icon('edit'), el('span', 'title', label), el('span', 'row-tag', '草稿'));
  b.type = 'button';
  b.disabled = true;
  wrap.append(b);
  return wrap;
}

export function createSidebar(actions) {
  function expandBot(botId) {
    setLocalFlag(foldKeyBot(botId), true);
  }

  function renderHomeNav(list) {
    const overviewWrap = el('div', 'row-wrap');
    if (!state.project) overviewWrap.dataset.current = 'true';
    const overviewBtn = btn('', () => actions.openHome(), 'row-btn', 'layers');
    overviewBtn.append(el('span', 'title', '毛球之家总览'));
    if (!state.project) overviewBtn.setAttribute('aria-current', 'page');
    overviewWrap.append(overviewBtn);

    const personalWrap = el('div', 'row-wrap');
    if (state.project === 'personal') personalWrap.dataset.current = 'true';
    const personalBtn = btn('', () => actions.openHome('personal'), 'row-btn', 'sparkles');
    personalBtn.append(el('span', 'title', '个人空间'));
    if (state.project === 'personal') personalBtn.setAttribute('aria-current', 'page');
    personalWrap.append(personalBtn);

    list.append(
      el('div', 'side-section',
        el('div', 'side-section-header', el('span', 'side-section-title', '空间入口')),
        overviewWrap,
        personalWrap
      ),
      el('hr', 'side-divider'),
      el('div', 'side-section',
        el('div', 'side-section-header',
          el('span', 'side-section-title', '项目目录', el('span', 'side-section-count', String(state.projects.length))),
          el('div', 'side-section-tools', iconBtn('建立项目', () => actions.createProject(), 'plus'))
        ),
        ...(state.projects.length
          ? state.projects.map(p => {
            const wrap = el('div', 'row-wrap');
            if (p.id === state.project) wrap.dataset.current = 'true';
            const b = btn('', () => actions.openHome(p.id), 'row-btn', 'folder');
            b.append(el('span', 'title', p.name));
            b.title = p.name;
            if (p.id === state.project) b.setAttribute('aria-current', 'page');
            wrap.append(b);
            return wrap;
          })
          : [el('div', 'tree-empty', el('span', '', '暂无项目'), btn('新建', () => actions.createProject(), 'ghost btn-xs'))])
      )
    );
  }

  function renderMainBotSection(ctx) {
    const mainBot = getMainBot();
    const mainId = state.mainThread?.id || null;
    const sidesOpen = localFlag(foldKeyMainSides, true) !== false;
    const archiveOpen = localFlag(foldKeyMainArchive, false) === true;

    let sideThreads = state.threads.filter(t => t.instanceId === 'main' && t.id !== mainId);
    if (ctx.isMain && ctx.thread && ctx.thread.id !== mainId && !sideThreads.some(t => t.id === ctx.thread.id) && ctx.thread.state === 'active') {
      sideThreads = [ctx.thread, ...sideThreads];
    }

    const mainRow = btn('', () => {
      if (mainId) return actions.openThread(mainId);
      return actions.go('#chat?instance=main');
    }, 'main-thread-row');
    mainRow.dataset.current = String(ctx.isMainThread);
    if (ctx.isMainThread) mainRow.setAttribute('aria-current', 'page');
    mainRow.append(
      el('span', 'main-avatar', icon('yarn')),
      el('span', 'row-title', '主会话'),
      el('i', 'dot live')
    );

    const sideFoldBtn = el('button', 'fold-toggle',
      icon(sidesOpen ? 'chevronDown' : 'chevronRight'),
      el('span', '', '侧边会话'),
      el('span', 'side-section-count', String(sideThreads.length))
    );
    sideFoldBtn.type = 'button';
    sideFoldBtn.setAttribute('aria-expanded', String(sidesOpen));
    sideFoldBtn.onclick = () => {
      setLocalFlag(foldKeyMainSides, !sidesOpen);
      render();
    };

    const sideTree = el('div', 'tree-list');
    if (ctx.isMain && ctx.isDraft) {
      sideTree.append(draftRow('新侧边会话', true));
    }
    if (ctx.isMain && ctx.thread && ctx.thread.id !== mainId && ctx.thread.state !== 'active') {
      sideTree.append(threadRow(ctx.thread, ctx.threadId, actions, {
        tag: ctx.thread.state === 'archived' ? '已归档' : '已删除'
      }));
    }
    for (const t of sideThreads) {
      sideTree.append(threadRow(t, ctx.threadId, actions));
    }
    if (!sideThreads.length && !(ctx.isMain && ctx.isDraft)) {
      sideTree.append(el('div', 'tree-empty',
        el('span', '', '暂无侧边会话'),
        btn('新建', () => actions.newThread('main'), 'ghost btn-xs')
      ));
    }
    if (actions.hasMore('main')) {
      sideTree.append(btn('加载更早侧聊', () => actions.loadMoreThreads('main'), 'ghost btn-xs'));
    }

    const mainArchived = state.archivedThreads.filter(t => t.instanceId === 'main');
    const mainDeleted = state.deletedThreads.filter(t => t.instanceId === 'main');
    let archiveBlock = null;
    if (mainArchived.length || mainDeleted.length) {
      const archToggle = el('button', 'fold-toggle',
        icon(archiveOpen ? 'chevronDown' : 'chevronRight'),
        el('span', '', '归档与回收站'),
        el('span', 'side-section-count', String(mainArchived.length + mainDeleted.length))
      );
      archToggle.type = 'button';
      archToggle.setAttribute('aria-expanded', String(archiveOpen));
      archToggle.onclick = () => {
        setLocalFlag(foldKeyMainArchive, !archiveOpen);
        render();
      };
      const archTree = el('div', 'tree-list');
      if (archiveOpen) {
        for (const t of mainArchived) {
          const wrap = el('div', 'row-wrap');
          const openB = btn('', () => actions.openThread(t.id), 'row-btn', 'archive');
          openB.append(el('span', 'title', t.title || '归档侧聊'), el('span', 'row-tag', '已归档'));
          const resB = iconBtn('恢复会话', () => actions.restoreThread(t), 'refresh', 'row-more');
          wrap.append(openB, resB);
          archTree.append(wrap);
        }
        for (const t of mainDeleted) {
          const wrap = el('div', 'row-wrap');
          const delB = btn('', () => actions.manageDeleted(t), 'row-btn', 'trash');
          delB.append(el('span', 'title', t.title || '已删除侧聊'), el('span', 'row-tag', '回收站'));
          wrap.append(delB);
          archTree.append(wrap);
        }
      }
      archiveBlock = el('div', '', el('div', 'fold-header', archToggle), archiveOpen ? archTree : null);
    }

    const card = el('div', 'main-bot-card',
      mainRow,
      el('div', 'fold-header', sideFoldBtn, iconBtn('新建侧聊', () => actions.newThread('main'), 'plus')),
      sidesOpen ? sideTree : null,
      archiveBlock
    );

    return el('section', 'side-section main-bot-section',
      el('div', 'side-section-header',
        el('span', 'side-section-title', (mainBot.name || '小毛球') + ' · 主控'),
        el('div', 'side-section-tools',
          iconBtn('新建侧边会话', () => actions.newThread('main'), 'plus'),
          iconBtn('搜索小毛球会话', () => actions.findThreads(mainBot), 'search'),
          iconBtn('对话设置', () => actions.openChatSettings(), 'sliders')
        )
      ),
      card
    );
  }

  function renderWorkBotsSection(ctx) {
    const bots = getWorkBots();
    const onlineCount = bots.filter(b => b.online && b.settings?.enabled !== false).length;
    const listWrap = el('div', 'work-bots-list');

    if (!bots.length) {
      listWrap.append(el('div', 'bot-empty-card',
        el('p', '', '尚未接入工作 Bot（如 Codex / DSH / API Bot）。接入后将在这里独立展示并可查看原生目录。'),
        hasDesktopSettings()
          ? btn('打开 Agent 设置', () => actions.openDesktopSettings(), 'secondary btn-sm', 'sliders')
          : btn('配置 API 工作 Bot', () => actions.openMainModels(), 'secondary btn-sm', 'bot')
      ));
    }

    for (const bot of bots) {
      const isActiveBot = !ctx.isMain && ctx.instanceId === bot.id;
      const disabled = bot.settings?.enabled === false;
      const savedFold = localFlag(foldKeyBot(bot.id), null);
      const isExpanded = savedFold === null ? isActiveBot : savedFold === true;

      let activeThreads = state.threads.filter(t => t.instanceId === bot.id);
      if (isActiveBot && ctx.thread && ctx.thread.state === 'active' && !activeThreads.some(t => t.id === ctx.thread.id)) {
        activeThreads = [ctx.thread, ...activeThreads];
      }
      const archived = state.archivedThreads.filter(t => t.instanceId === bot.id);
      const deleted = state.deletedThreads.filter(t => t.instanceId === bot.id);

      const card = el('div', 'bot-card');
      card.dataset.botId = bot.id;
      if (isActiveBot) card.dataset.activeBot = 'true';
      if (disabled) card.dataset.disabled = 'true';

      const foldBtn = el('button', 'bot-fold-btn', icon(isExpanded ? 'chevronDown' : 'chevronRight'));
      foldBtn.type = 'button';
      foldBtn.title = isExpanded ? '收起会话' : '展开会话';
      foldBtn.setAttribute('aria-expanded', String(isExpanded));
      foldBtn.onclick = e => {
        e.stopPropagation();
        setLocalFlag(foldKeyBot(bot.id), !isExpanded);
        render();
      };

      const dotCls = disabled ? 'dot' : bot.online ? 'dot live' : 'dot';
      const subText = bot.adapterKey === 'model-api'
        ? (disabled ? '已停用 · 独立 API' : '独立 API Bot')
        : [basenamePath(bot.workspaceRef) || bot.id, disabled ? '已停用' : bot.online ? '在线' : '离线'].filter(Boolean).join(' · ');

      const mainBtn = btn('', () => {
        expandBot(bot.id);
        actions.selectBot(bot.id);
      }, 'bot-main-btn');
      mainBtn.append(
        el('i', dotCls),
        el('div', 'bot-info',
          el('div', 'bot-title-line',
            el('span', 'bot-name', bot.name || bot.id),
            el('span', 'bot-adapter-pill', adapterLabel(bot))
          ),
          el('span', 'bot-sub-line', subText)
        )
      );
      mainBtn.title = `${bot.name} (${adapterLabel(bot)}) · ${bot.workspaceRef || '独立模型'}`;

      const headTools = el('div', 'bot-head-tools',
        iconBtn('新建话题', e => {
          e?.stopPropagation?.();
          expandBot(bot.id);
          actions.newThread(bot.id);
        }, 'plus'),
        bot.capabilities?.sessionList ? iconBtn('原生目录', e => {
          e?.stopPropagation?.();
          actions.nativeCatalog(bot);
        }, 'folderOpen') : null,
        iconBtn('Bot 设置', e => {
          e?.stopPropagation?.();
          actions.botSettings(bot);
        }, 'sliders')
      );

      card.append(el('div', 'bot-head', foldBtn, mainBtn, headTools));

      if (isExpanded) {
        const tree = el('div', 'tree-list');
        if (isActiveBot && ctx.isDraft) {
          tree.append(draftRow('新话题草稿', true));
        }
        if (isActiveBot && ctx.thread && ctx.thread.state !== 'active') {
          tree.append(threadRow(ctx.thread, ctx.threadId, actions, {
            tag: ctx.thread.state === 'archived' ? '已归档' : '已删除'
          }));
        }
        for (const t of activeThreads) {
          tree.append(threadRow(t, ctx.threadId, actions));
        }
        if (!activeThreads.length && !(isActiveBot && ctx.isDraft)) {
          const emptyActions = el('div', 'actions',
            btn('新话题', () => actions.newThread(bot.id), 'ghost btn-xs'),
            bot.capabilities?.sessionList ? btn('导入原生', () => actions.nativeCatalog(bot), 'ghost btn-xs') : null
          );
          tree.append(el('div', 'tree-empty', el('span', '', '暂无话题'), emptyActions));
        }
        if (actions.hasMore(bot.id)) {
          tree.append(btn('加载更早会话', () => actions.loadMoreThreads(bot.id), 'ghost btn-xs'));
        }

        const footerActions = el('div', 'bot-footer-actions',
          btn('搜索', () => actions.findThreads(bot), 'ghost', 'search'),
          bot.capabilities?.sessionList ? btn('原生目录', () => actions.nativeCatalog(bot), 'ghost', 'folderOpen') : null,
          archived.length ? btn('归档 (' + archived.length + ')', () => actions.showBotArchive(bot, 'archived'), 'ghost', 'archive') : null,
          deleted.length ? btn('回收站 (' + deleted.length + ')', () => actions.showBotArchive(bot, 'deleted'), 'ghost', 'trash') : null
        );

        card.append(el('div', 'bot-tree', tree, footerActions));
      }

      listWrap.append(card);
    }

    return el('section', 'side-section work-bots-section',
      el('div', 'side-section-header',
        el('span', 'side-section-title', '工作 Bot', el('span', 'side-section-count', onlineCount + '/' + bots.length)),
        el('div', 'side-section-tools',
          hasDesktopSettings() ? iconBtn('Agent 设置', () => actions.openDesktopSettings(), 'sliders') : null
        )
      ),
      listWrap
    );
  }

  function render() {
    const nav = $('nav');
    const chatBtn = btn('对话工作台', () => actions.go('#chat'), state.view === 'chat' ? 'active' : '', 'chat');
    const homeBtn = btn('毛球之家', () => actions.openHome(), state.view === 'home' ? 'active' : '', 'folder');
    if (state.view === 'chat') chatBtn.setAttribute('aria-current', 'page');
    else homeBtn.setAttribute('aria-current', 'page');
    nav.replaceChildren(chatBtn, homeBtn);

    const list = $('side-list');
    list.replaceChildren();
    if (state.view === 'home') {
      renderHomeNav(list);
      return;
    }

    const ctx = resolveActiveContext();
    list.append(
      renderMainBotSection(ctx),
      el('hr', 'side-divider'),
      renderWorkBotsSection(ctx)
    );
  }

  return { render, expandBot };
}
