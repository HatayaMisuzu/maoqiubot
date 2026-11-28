import MarkdownIt from '/vendor/markdown-it.mjs';
import { copyText, el, icon } from './lib.js';

const parser = new MarkdownIt({ html: false, breaks: true });
parser.validateLink = raw => {
  try {
    const target = new URL(raw);
    return ['http:', 'https:'].includes(target.protocol) && !target.username && !target.password;
  } catch {
    return false;
  }
};
parser.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};
parser.renderer.rules.image = (tokens, index, options, env, renderer) =>
  parser.utils.escapeHtml(renderer.renderInlineAsText(tokens[index].children, options, env));

function decorateCode(code) {
  const pre = code.parentElement;
  const copyBtn = el('button', 'ghost btn-xs', icon('copy'), el('span', '', '复制'));
  copyBtn.type = 'button';
  copyBtn.onclick = async () => {
    await copyText(code.textContent, '代码已复制');
    if (!copyBtn.isConnected) return;
    copyBtn.replaceChildren(icon('check'), el('span', '', '已复制'));
    setTimeout(() => {
      if (copyBtn.isConnected) copyBtn.replaceChildren(icon('copy'), el('span', '', '复制'));
    }, 1500);
  };
  const language = [...code.classList].find(name => name.startsWith('language-'))?.slice(9) || 'text';
  const head = el('div', 'code-block-head', el('span', '', language), copyBtn);
  const block = el('div', 'code-block', head);
  pre.classList.add('scroll-sleek');
  pre.replaceWith(block);
  block.append(pre);
}

function decorateTask(item) {
  const first = [...item.childNodes].find(node => node.nodeType !== Node.TEXT_NODE || node.textContent.trim());
  const text = first?.nodeName === 'P' ? first.firstChild : first;
  if (text?.nodeType !== Node.TEXT_NODE) return;
  const marker = /^\s*\[([ xX])\][ \t]+/.exec(text.data);
  if (!marker) return;
  const checkbox = el('input', 'md-task');
  checkbox.type = 'checkbox';
  checkbox.disabled = true;
  checkbox.checked = marker[1] !== ' ';
  checkbox.setAttribute('aria-label', checkbox.checked ? '已完成' : '未完成');
  text.deleteData(0, marker[0].length);
  text.before(checkbox);
  item.classList.add('md-task-item');
}

export function renderMarkdown(text) {
  const root = el('div', 'md');
  if (!text) return root;
  // The parser escapes source HTML and only emits validated HTTP(S) anchors. Images are rendered as text.
  root.innerHTML = parser.render(String(text));
  root.querySelectorAll('pre > code').forEach(decorateCode);
  root.querySelectorAll('table').forEach(table => {
    const wrap = el('div', 'table-scroll scroll-sleek');
    table.replaceWith(wrap);
    wrap.append(table);
  });
  root.querySelectorAll('li').forEach(decorateTask);
  return root;
}
