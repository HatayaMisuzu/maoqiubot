import { copyText, el, icon } from './lib.js';

function appendInline(container, text) {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|~~[^~\n]+~~|\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\))/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) container.append(document.createTextNode(text.slice(last, match.index)));
    const token = match[0];
    if (token.startsWith('`')) {
      container.append(el('code', '', token.slice(1, -1)));
    } else if (token.startsWith('**')) {
      container.append(el('strong', '', token.slice(2, -2)));
    } else if (token.startsWith('~~')) {
      container.append(el('del', '', token.slice(2, -2)));
    } else if (token.startsWith('*')) {
      container.append(el('em', '', token.slice(1, -1)));
    } else if (token.startsWith('[')) {
      const sep = token.indexOf('](');
      const label = token.slice(1, sep);
      const rawUrl = token.slice(sep + 2, -1);
      try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          const a = el('a', '', label);
          a.href = parsed.href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          container.append(a);
        } else {
          container.append(document.createTextNode(token));
        }
      } catch {
        container.append(document.createTextNode(token));
      }
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) container.append(document.createTextNode(text.slice(last)));
}

function makeCodeBlock(lang, codeText) {
  const copyBtn = el('button', 'ghost btn-xs', icon('copy'), el('span', '', '复制'));
  copyBtn.type = 'button';
  copyBtn.onclick = async () => {
    await copyText(codeText, '代码已复制');
    copyBtn.replaceChildren(icon('check'), el('span', '', '已复制'));
    setTimeout(() => {
      if (copyBtn.isConnected) copyBtn.replaceChildren(icon('copy'), el('span', '', '复制'));
    }, 1500);
  };
  const head = el('div', 'code-block-head', el('span', '', lang || 'text'), copyBtn);
  const pre = el('pre', 'scroll-sleek', el('code', '', codeText));
  return el('div', 'code-block', head, pre);
}

export function renderMarkdown(text) {
  const root = el('div', 'md');
  if (!text) return root;
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = line.match(/^```([\w.+-]*)\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length && /^```\s*$/.test(lines[i])) i++;
      root.append(makeCodeBlock(lang, codeLines.join('\n')));
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const tag = 'h' + heading[1].length;
      const node = el(tag);
      appendInline(node, heading[2]);
      root.append(node);
      i++;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) {
      root.append(el('hr'));
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      const bq = el('blockquote');
      appendInline(bq, quoteLines.join('\n'));
      root.append(bq);
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const ul = el('ul');
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const li = el('li');
        appendInline(li, lines[i].replace(/^\s*[-*]\s+/, ''));
        ul.append(li);
        i++;
      }
      root.append(ul);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const ol = el('ol');
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const li = el('li');
        appendInline(li, lines[i].replace(/^\s*\d+\.\s+/, ''));
        ol.append(li);
        i++;
      }
      root.append(ol);
      continue;
    }

    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i]) &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^\s*(?:-{3,}|\*{3,})\s*$/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    const p = el('p');
    appendInline(p, paraLines.join('\n'));
    root.append(p);
  }

  return root;
}
