type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined>;

/** Tiny element builder: h('div', { class: 'x', onclick: fn }, 'text', child) */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined) el.append(c);
  return el;
}

export const hex2 = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
export const hex4 = (v: number) => v.toString(16).toUpperCase().padStart(4, '0');
export const bin8 = (v: number) => v.toString(2).padStart(8, '0');

/** Set text only when it changed (avoids layout work). */
export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
export function setClass(el: Element, cls: string, on: boolean): void {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}
export function setTitle(el: HTMLElement, title: string): void {
  if (el.title !== title) el.title = title;
}

export function formatTime(seconds: number): string {
  if (seconds === 0) return '0 s';
  if (seconds < 1e-3) return `${(seconds * 1e6).toFixed(3)} µs`;
  if (seconds < 1) return `${(seconds * 1e3).toFixed(3)} ms`;
  return `${seconds.toFixed(4)} s`;
}

export function formatHz(hz: number): string {
  if (hz >= 1e6) return `${+(hz / 1e6).toFixed(3)} MHz`;
  if (hz >= 1e3) return `${+(hz / 1e3).toFixed(3)} kHz`;
  return `${+hz.toFixed(3)} Hz`;
}

/** Parse a user-entered number: 0x1F, $1F, 0b101, 'A' or decimal. */
export function parseNumber(s: string): number | null {
  const t = s.trim();
  if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t.slice(2), 16);
  if (/^\$[0-9a-f]+$/i.test(t)) return parseInt(t.slice(1), 16);
  if (/^0b[01]+$/i.test(t)) return parseInt(t.slice(2), 2);
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^'.'$/.test(t)) return t.charCodeAt(1);
  if (/^[0-9a-f]+h$/i.test(t)) return parseInt(t.slice(0, -1), 16);
  return null;
}

/** Replace an element's content with an inline input to edit a value. */
export function inlineEdit(el: HTMLElement, current: string, commit: (text: string) => void): void {
  if (el.querySelector('input')) return;
  const input = h('input', { class: 'inline-edit', value: current, spellcheck: 'false' });
  const old = el.textContent;
  el.textContent = '';
  el.append(input);
  input.select();
  let done = false;
  const finish = (ok: boolean) => {
    if (done) return;
    done = true;
    const v = input.value;
    input.remove();
    el.textContent = old;
    if (ok) commit(v);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

export function panel(title: string, ...children: (Node | string)[]): HTMLElement {
  return h('section', { class: 'panel' }, h('h2', {}, title), ...children);
}
