import type { ATmega328P } from '../core/mcu';
import { formatTime, h, setClass } from './dom';
import type { Panel } from './panels';

const ALL_PINS = [
  ...Array.from({ length: 8 }, (_, i) => `PB${i}`),
  ...Array.from({ length: 7 }, (_, i) => `PC${i}`),
  ...Array.from({ length: 8 }, (_, i) => `PD${i}`),
];
const COLORS = ['#34d399', '#60a5fa', '#f472b6', '#fbbf24', '#a78bfa', '#f87171', '#2dd4bf', '#fb923c'];
const WINDOWS: [string, number][] = [
  ['100 cycles', 100], ['1k cycles', 1e3], ['10k cycles', 1e4], ['100k cycles', 1e5],
  ['1M cycles', 1e6], ['10M cycles', 1e7], ['100M cycles', 1e8], ['Whole run', 0],
];

const ROW_H = 30;
const LABEL_W = 52;
const AXIS_H = 20;

/** Waveform view of selected pins over the most recent cycles. */
export class TimingChart implements Panel {
  el: HTMLElement;
  pins: string[];
  private canvas = h('canvas', { class: 'chart-canvas' });
  private windowSel = h('select', { title: 'Time window shown' });
  private chips = new Map<string, HTMLElement>();
  private hoverX: number | null = null;
  private lastKey = '';
  private lastDraw = 0;

  constructor(private mcu: ATmega328P, pins: string[], window: number, private onChange: () => void) {
    this.pins = pins.filter((p) => ALL_PINS.includes(p));
    for (const [label, v] of WINDOWS) this.windowSel.append(h('option', { value: String(v) }, label));
    this.windowSel.value = String(WINDOWS.some(([, v]) => v === window) ? window : 1e5);
    this.windowSel.addEventListener('change', () => {
      this.onChange();
      this.redraw();
    });

    const picker = h('div', { class: 'pin-picker' });
    for (const port of ['B', 'C', 'D']) {
      const group = h('div', { class: 'pin-group' }, h('span', { class: 'muted small' }, port));
      for (const p of ALL_PINS.filter((x) => x[1] === port)) {
        const chip = h('button', { class: 'chip', onclick: () => this.toggle(p), title: `Show ${p} in the chart` }, p.slice(2));
        this.chips.set(p, chip);
        group.append(chip);
      }
      picker.append(group);
    }
    this.canvas.addEventListener('mousemove', (e) => {
      this.hoverX = e.offsetX;
      this.redraw();
    });
    this.canvas.addEventListener('mouseleave', () => {
      this.hoverX = null;
      this.redraw();
    });
    this.el = h(
      'section',
      { class: 'panel chart-panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Timing Chart'), picker, this.windowSel),
      h('div', { class: 'chart-wrap' }, this.canvas),
    );
    this.updateChips();
    new ResizeObserver(() => this.redraw()).observe(this.canvas);
  }

  get window(): number {
    return Number(this.windowSel.value);
  }

  setPins(pins: string[]): void {
    this.pins = pins.filter((p) => ALL_PINS.includes(p));
    this.updateChips();
    this.redraw();
  }

  private toggle(p: string): void {
    if (this.pins.includes(p)) this.pins = this.pins.filter((x) => x !== p);
    else this.pins = ALL_PINS.filter((x) => x === p || this.pins.includes(x));
    this.updateChips();
    this.onChange();
    this.redraw();
  }

  private updateChips(): void {
    for (const [p, chip] of this.chips) setClass(chip, 'on', this.pins.includes(p));
  }

  redraw(): void {
    this.lastKey = '';
    this.render();
  }

  render(): void {
    const cycles = this.mcu.cpu.cycles;
    const key = `${cycles}|${this.pins.join()}|${this.window}|${this.hoverX}|${this.canvas.clientWidth}`;
    if (key === this.lastKey) return;
    // Limit redraws to ~30 fps while running.
    const now = performance.now();
    if (this.lastKey && now - this.lastDraw < 33 && this.hoverX === null) return;
    this.lastKey = key;
    this.lastDraw = now;
    this.draw();
  }

  private draw(): void {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const cssW = c.clientWidth || 600;
    const cssH = Math.max(1, this.pins.length) * ROW_H + AXIS_H + 6;
    c.style.height = `${cssH}px`;
    if (c.width !== Math.round(cssW * dpr) || c.height !== Math.round(cssH * dpr)) {
      c.width = Math.round(cssW * dpr);
      c.height = Math.round(cssH * dpr);
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);

    const end = Math.max(1, this.mcu.cpu.cycles);
    const win = this.window || end;
    const start = Math.max(0, end - win);
    const span = Math.max(1, end - start);
    const plotW = cssW - LABEL_W - 8;
    const X = (t: number) => LABEL_W + ((t - start) / span) * plotW;

    // Grid and axis
    g.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    const step = niceStep(span / Math.max(2, plotW / 90));
    g.strokeStyle = 'rgba(255,255,255,0.06)';
    g.fillStyle = '#6b7280';
    g.lineWidth = 1;
    for (let t = Math.ceil(start / step) * step; t <= end; t += step) {
      const x = Math.round(X(t)) + 0.5;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, cssH - AXIS_H);
      g.stroke();
      g.fillText(formatCycles(t, step), x + 2, cssH - 6);
    }

    if (!this.pins.length) {
      g.fillStyle = '#6b7280';
      g.fillText('Pick pins above to show their waveforms.', LABEL_W, 20);
    }

    this.pins.forEach((pin, row) => {
      const trace = this.mcu.traces.get(pin);
      const top = row * ROW_H + 6;
      const yHi = top + 3, yLo = top + ROW_H - 9, yMid = (yHi + yLo) / 2;
      const Y = (s: number) => (s === 1 ? yHi : s === 0 ? yLo : yMid);
      const color = COLORS[row % COLORS.length];
      g.fillStyle = '#9ca3af';
      g.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      g.fillText(pin, 6, yMid + 4);
      if (!trace || !trace.times.length) return;

      const { times, states } = trace;
      // Last transition at or before the window start.
      let lo = 0, hi = times.length - 1, idx = 0;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (times[m] <= start) {
          idx = m;
          lo = m + 1;
        } else hi = m - 1;
      }
      let s = times[idx] <= start ? states[idx] : states[0];
      g.strokeStyle = color;
      g.lineWidth = 1.5;
      g.beginPath();
      let lastPx = Math.round(X(start));
      g.moveTo(lastPx, Y(s));
      let fullCol = -1;
      for (let i = idx + 1; i < times.length && times[i] <= end; i++) {
        const px = Math.round(X(times[i]));
        const ns = states[i];
        if (px === lastPx && fullCol === px) {
          s = ns;
          continue;
        }
        if (px !== lastPx) {
          g.lineTo(px, Y(s));
          lastPx = px;
        } else if (s !== ns) fullCol = px;
        g.lineTo(px, Y(ns));
        s = ns;
      }
      g.lineTo(X(end), Y(s));
      g.stroke();
      // Light fill under high levels helps reading PWM duty.
      g.globalAlpha = 0.08;
      g.fillStyle = color;
      g.fillRect(LABEL_W, yHi, plotW, yLo - yHi);
      g.globalAlpha = 1;
    });

    if (this.hoverX !== null && this.hoverX > LABEL_W) {
      const t = start + ((this.hoverX - LABEL_W) / plotW) * span;
      g.strokeStyle = 'rgba(165,180,252,0.6)';
      g.beginPath();
      g.moveTo(this.hoverX + 0.5, 0);
      g.lineTo(this.hoverX + 0.5, cssH - AXIS_H);
      g.stroke();
      const label = `${Math.round(t).toLocaleString('en-US')} cyc · ${formatTime(t / this.mcu.frequency)}`;
      g.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      const w = g.measureText(label).width + 8;
      const x = Math.min(this.hoverX + 6, cssW - w - 2);
      g.fillStyle = 'rgba(17,24,39,0.92)';
      g.fillRect(x, 2, w, 16);
      g.fillStyle = '#e5e7eb';
      g.fillText(label, x + 4, 14);
    }
  }
}

function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p;
}

/** Format a cycle count with just enough decimals to tell grid lines `step` apart. */
function formatCycles(t: number, step: number): string {
  const [unit, div] = t >= 1e6 ? ['M', 1e6] : t >= 1e3 ? ['k', 1e3] : ['', 1];
  const decimals = Math.max(0, Math.ceil(-Math.log10(step / div) - 1e-9));
  return `${(t / div).toFixed(Math.min(decimals, 6))}${unit}`;
}
