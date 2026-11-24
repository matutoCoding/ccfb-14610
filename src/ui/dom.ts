// 极简 DOM 构建辅助
type Child = Node | string | null | undefined | false;
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | EventListener | object | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'class') {
      el.className = String(v);
    } else if (k === 'style' && typeof v === 'object') {
      Object.assign(el.style, v);
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function fmt(n: number, digits = 1): string {
  if (!isFinite(n)) return '—';
  return n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

let toastTimer: number | undefined;
export function toast(msg: string, bad = false): void {
  let el = document.querySelector<HTMLDivElement>('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.toggle('bad', bad);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el?.remove(), 3200);
}
