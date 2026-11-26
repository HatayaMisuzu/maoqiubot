import { $, at, el, getMainBot, getWorkBots, icon, isMac, state, toggleTheme } from './lib.js';
import { hasDesktopSettings } from './desktop-settings.js';

export function createCommandPalette(actions) {
  const dialog = $('palette');
  let selectedIndex = 0;
  let visibleEntries = [];

  function buildEntries(query) {
    const q = query.trim().toLowerCase();
    const groups = [];
    const mainBot = getMainBot();
    const projectMap = new Map(state.projects.map(p => [p.id, p.name]));

    const mainItems = [];
    if (state.mainThread) {
      mainItems.push({
        label: '小毛球 · 主会话',
        meta: '固定主控',
        symbol: 'yarn',
        keywords: '主会话 小毛球 main',
        run: () => actions.openThread(state.mainThread.id)
      });
    }
    mainItems.push({
      label: '新建侧边会话',
      meta: '小毛球',
      symbol: 'plus',
      keywords: '新建 侧聊 侧边会话 new side',
      run: () => actions.newThread('main')
    });
    mainItems.push({
      label: '委派任务给工作 Bot',
      meta: '小毛球',
      symbol: 'task',
      keywords: '委派 任务 delegate task',
      run: () => actions.delegateTask()
    });
    for (const t of state.threads.filter(t => t.instanceId === 'main' && t.id !== state.mainThread?.id)) {
      mainItems.push({
        label: t.title || '侧边会话',
        meta: projectMap.get(t.projectId) || '侧边会话',
        symbol: 'chat',
        keywords: (t.title || '') + ' ' + (projectMap.get(t.projectId) || '') + ' 侧聊',
        run: () => actions.openThread(t.id)
      });
    }
    groups.push({ title: mainBot.name || '小毛球 · 主控', items: mainItems });

    const botItems = [];
    for (const bot of getWorkBots()) {
      botItems.push({
        label: '切换到 ' + bot.name,
        meta: [bot.adapterKey, bot.online ? '在线' : '离线'].join(' · '),
        symbol: 'bot',
        keywords: bot.name + ' ' + bot.id + ' ' + bot.adapterKey + ' ' + (bot.workspaceRef || ''),
        run: () => actions.selectBot(bot.id)
      });
      if (bot.capabilities?.sessionList) {
        botItems.push({
          label: bot.name + ' · 查看原生目录',
          meta: '原生导入',
          symbol: 'folderOpen',
          keywords: bot.name + ' 原生目录 导入 native catalog',
          run: () => actions.nativeCatalog(bot)
        });
      }
      for (const t of state.threads.filter(t => t.instanceId === bot.id)) {
        botItems.push({
          label: t.title || '工作话题',
          meta: bot.name + (projectMap.get(t.projectId) ? ' · ' + projectMap.get(t.projectId) : ''),
          symbol: t.taskId ? 'task' : 'chat',
          keywords: (t.title || '') + ' ' + bot.name + ' ' + (projectMap.get(t.projectId) || ''),
          run: () => actions.openThread(t.id)
        });
      }
    }
    if (botItems.length) groups.push({ title: '工作 Bot 与会话', items: botItems });

    const homeItems = [
      {
        label: '毛球之家总览',
        meta: '项目目录',
        symbol: 'folder',
        keywords: '毛球之家 项目 总览 home',
        run: () => actions.openHome()
      },
      {
        label: '个人空间',
        meta: '收藏与记忆',
        symbol: 'sparkles',
        keywords: '个人空间 记忆 原件 personal',
        run: () => actions.openHome('personal')
      },
      ...state.projects.map(p => ({
        label: p.name,
        meta: '项目空间',
        symbol: 'layers',
        keywords: p.name + ' 项目 space',
        run: () => actions.openHome(p.id)
      }))
    ];
    groups.push({ title: '毛球之家', items: homeItems });

    const actionItems = [
      {
        label: '切换浅色 / 深色主题',
        meta: '外观',
        symbol: 'sun',
        keywords: '主题 浅色 深色 夜间 theme dark light',
        run: () => {
          toggleTheme();
          actions.updateThemeButton();
        }
      },
      {
        label: '展开 / 收起右侧上下文面板',
        meta: isMac() ? '⌘I' : 'Ctrl+I',
        symbol: 'panelRight',
        keywords: '面板 检查器 右侧 inspector',
        run: () => actions.toggleInspector()
      },
      {
        label: '对话与主聊设置',
        meta: '模型 / 权限 / 人格 / 插件',
        symbol: 'sliders',
        keywords: '设置 模型 权限 人格 插件 settings',
        run: () => actions.openChatSettings()
      }
    ];
    if (hasDesktopSettings()) {
      actionItems.push({
        label: 'Agent 设置（原生连接器 / Worktree）',
        meta: '桌面配置',
        symbol: 'terminal',
        keywords: 'agent codex dsh worktree 连接器',
        run: () => actions.openDesktopSettings()
      });
    }
    groups.push({ title: '工作台命令', items: actionItems });

    if (!q) return groups;
    return groups
      .map(g => ({
        title: g.title,
        items: g.items.filter(item =>
          (item.label + ' ' + item.meta + ' ' + (item.keywords || '')).toLowerCase().includes(q)
        )
      }))
      .filter(g => g.items.length > 0);
  }

  function renderResults(input, listBox) {
    const groups = buildEntries(input.value);
    visibleEntries = [];
    listBox.replaceChildren();

    for (const group of groups) {
      listBox.append(el('div', 'palette-group', group.title));
      for (const item of group.items) {
        const index = visibleEntries.length;
        visibleEntries.push(item);
        const row = el('button', 'palette-item',
          icon(item.symbol),
          el('span', 'title', item.label),
          item.meta ? el('span', 'palette-meta', item.meta) : null
        );
        row.type = 'button';
        row.dataset.index = String(index);
        row.onclick = () => {
          dialog.close();
          item.run();
        };
        row.onmouseenter = () => {
          selectedIndex = index;
          syncSelection(listBox);
        };
        listBox.append(row);
      }
    }

    if (!visibleEntries.length) {
      listBox.append(el('p', 'empty', '没有匹配的会话、Bot 或命令。'));
      selectedIndex = 0;
      return;
    }
    if (selectedIndex >= visibleEntries.length) selectedIndex = 0;
    syncSelection(listBox);
  }

  function syncSelection(listBox) {
    const buttons = listBox.querySelectorAll('.palette-item');
    buttons.forEach(b => {
      const active = Number(b.dataset.index) === selectedIndex;
      b.dataset.selected = String(active);
      if (active) b.scrollIntoView({ block: 'nearest' });
    });
  }

  function open() {
    if (dialog.open) dialog.close();
    selectedIndex = 0;

    const searchInput = el('input', 'palette-input');
    searchInput.type = 'text';
    searchInput.placeholder = '搜索主会话、侧聊、Codex / DSH、项目或命令…';
    searchInput.setAttribute('aria-label', '搜索工作台');

    const listBox = el('div', 'palette-list scroll-sleek');
    const foot = el('div', 'palette-foot',
      el('span', '', el('span', 'kbd', '↑↓'), ' 选择 · ', el('span', 'kbd', 'Enter'), ' 打开'),
      el('span', '', el('span', 'kbd', 'Esc'), ' 关闭')
    );

    searchInput.oninput = () => {
      selectedIndex = 0;
      renderResults(searchInput, listBox);
    };

    searchInput.onkeydown = e => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (visibleEntries.length) {
          selectedIndex = (selectedIndex + 1) % visibleEntries.length;
          syncSelection(listBox);
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (visibleEntries.length) {
          selectedIndex = (selectedIndex - 1 + visibleEntries.length) % visibleEntries.length;
          syncSelection(listBox);
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const chosen = visibleEntries[selectedIndex];
        if (chosen) {
          dialog.close();
          chosen.run();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        dialog.close();
      }
    };

    dialog.replaceChildren(
      el('div', 'palette-input-wrap', icon('search'), searchInput),
      listBox,
      foot
    );
    renderResults(searchInput, listBox);
    dialog.showModal();
    requestAnimationFrame(() => searchInput.focus());
  }

  return { open };
}
