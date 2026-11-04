import { FLAG_NAMES_UPPER } from './constants';
import { bin8, formatHz, formatTime, h, hex2, hex4, inlineEdit, parseNumber, setClass, setText, setTitle } from './dom';
import type { AsmResult } from '../core/assembler';
import { disassemble } from '../core/disasm';
import { PIN_FLOAT, type Port, type PortName } from '../core/gpio';
import type { ATmega328P } from '../core/mcu';
import { REG } from '../core/mcu';
import type { Timer } from '../core/timers';

export interface RenderCtx {
  mcu: ATmega328P;
  asm: AsmResult | null;
  /** Data memory before the last step, for highlighting changes (null while running). */
  prev: Uint8Array | null;
  prevPc: number | null;
  running: boolean;
}

export interface Panel {
  el: HTMLElement;
  render(ctx: RenderCtx): void;
}

/** Called after the user edits machine state, so the app can re-render. */
export type OnEdit = () => void;

// ---------------------------------------------------------------------------

export class CpuPanel implements Panel {
  el: HTMLElement;
  private pc = h('span', { class: 'mono big editable', title: 'Program counter (word address). Click to change.' });
  private pcByte = h('span', { class: 'muted mono' });
  private next = h('span', { class: 'mono next-insn' });
  private sp = h('span', { class: 'mono editable', title: 'Stack pointer. Click to change.' });
  private cycles = h('span', { class: 'mono' });
  private time = h('span', { class: 'mono' });
  private state = h('span', { class: 'mono' });
  private lastInt = h('span', { class: 'mono muted' });
  private flags: HTMLButtonElement[] = [];
  private sregHex = h('span', { class: 'mono muted' });

  constructor(private mcu: ATmega328P, onEdit: OnEdit) {
    const cpu = mcu.cpu;
    this.pc.addEventListener('click', () =>
      inlineEdit(this.pc, '0x' + hex4(cpu.pc), (t) => {
        const v = parseNumber(t);
        if (v !== null) {
          cpu.pc = v & 0x3fff;
          cpu.halted = null;
          onEdit();
        }
      }),
    );
    this.sp.addEventListener('click', () =>
      inlineEdit(this.sp, '0x' + hex4(cpu.sp), (t) => {
        const v = parseNumber(t);
        if (v !== null) {
          cpu.sp = v & 0xffff;
          onEdit();
        }
      }),
    );
    const flagRow = h('div', { class: 'flags' });
    const descr: Record<string, string> = {
      I: 'Global Interrupt Enable', T: 'Bit Copy Storage', H: 'Half Carry', S: 'Sign (N xor V)',
      V: 'Two’s complement overflow', N: 'Negative', Z: 'Zero', C: 'Carry',
    };
    for (let bit = 7; bit >= 0; bit--) {
      const name = FLAG_NAMES_UPPER[bit];
      const b = h('button', {
        class: 'flag',
        title: `${name}: ${descr[name]} (SREG bit ${bit}). Click to toggle.`,
        onclick: () => {
          cpu.sreg ^= 1 << bit;
          onEdit();
        },
      }, name);
      this.flags[bit] = b;
      flagRow.append(b);
    }
    this.el = h(
      'section',
      { class: 'panel cpu-panel' },
      h('h2', {}, 'CPU'),
      h(
        'div',
        { class: 'kv-grid' },
        h('label', {}, 'PC'), h('div', {}, this.pc, ' ', this.pcByte),
        h('label', {}, 'Next'), h('div', {}, this.next),
        h('label', {}, 'SP'), h('div', {}, this.sp),
        h('label', {}, 'Cycles'), h('div', {}, this.cycles),
        h('label', {}, 'Time'), h('div', {}, this.time),
        h('label', {}, 'State'), h('div', {}, this.state, ' ', this.lastInt),
      ),
      h('div', { class: 'sreg-row' }, h('label', {}, 'SREG'), flagRow, this.sregHex),
    );
  }

  render(ctx: RenderCtx): void {
    const { cpu } = this.mcu;
    setText(this.pc, '0x' + hex4(cpu.pc));
    setText(this.pcByte, `(byte 0x${hex4(cpu.pc * 2)})`);
    const dis = disassemble(cpu.flash[cpu.pc], cpu.flash[(cpu.pc + 1) & 0x3fff], cpu.pc);
    setText(this.next, dis.text);
    setText(this.sp, '0x' + hex4(cpu.sp));
    setClass(this.sp, 'changed', !!ctx.prev && (ctx.prev[0x5d] !== cpu.data[0x5d] || ctx.prev[0x5e] !== cpu.data[0x5e]));
    setText(this.cycles, cpu.cycles.toLocaleString('en-US'));
    setText(this.time, formatTime(this.mcu.time));
    const st = cpu.halted ? 'halted' : cpu.sleeping ? 'sleeping' : ctx.running ? 'running' : 'ready';
    setText(this.state, st);
    setClass(this.state, 'warn', st === 'sleeping');
    setClass(this.state, 'err', st === 'halted');
    const li = this.mcu.lastInterrupt;
    setText(this.lastInt, li ? `last IRQ: ${li.name} @ ${li.cycle.toLocaleString('en-US')}` : '');
    const s = cpu.sreg;
    for (let bit = 0; bit < 8; bit++) {
      setClass(this.flags[bit], 'on', !!(s & (1 << bit)));
      setClass(this.flags[bit], 'changed', !!ctx.prev && !!((ctx.prev[0x5f] ^ s) & (1 << bit)));
    }
    setText(this.sregHex, `0x${hex2(s)}`);
  }
}

// ---------------------------------------------------------------------------

export class RegistersPanel implements Panel {
  el: HTMLElement;
  private cells: { hex: HTMLElement; dec: HTMLElement; box: HTMLElement }[] = [];
  private ptrs: { el: HTMLElement; lo: number }[] = [];

  constructor(private mcu: ATmega328P, onEdit: OnEdit) {
    const grid = h('div', { class: 'reg-grid' });
    for (let i = 0; i < 32; i++) {
      const hex = h('span', { class: 'mono reg-hex' });
      const dec = h('span', { class: 'reg-dec' });
      const alias = i >= 26 ? ['XL', 'XH', 'YL', 'YH', 'ZL', 'ZH'][i - 26] : '';
      const box = h(
        'div',
        { class: 'reg', title: `R${i}${alias ? ` (${alias})` : ''}. Click to edit (hex 0x.., decimal, 0b.., 'c').` },
        h('span', { class: 'reg-name' }, `R${i}`),
        hex,
        dec,
      );
      box.addEventListener('click', () =>
        inlineEdit(hex, '0x' + hex2(mcu.cpu.data[i]), (t) => {
          const v = parseNumber(t);
          if (v !== null) {
            mcu.cpu.data[i] = v & 0xff;
            onEdit();
          }
        }),
      );
      this.cells.push({ hex, dec, box });
      grid.append(box);
    }
    const ptrRow = h('div', { class: 'ptr-row' });
    for (const [name, lo] of [['X', 26], ['Y', 28], ['Z', 30]] as const) {
      const el = h('span', { class: 'mono' });
      this.ptrs.push({ el, lo });
      ptrRow.append(h('div', { class: 'ptr' }, h('label', {}, name), el));
    }
    this.el = h('section', { class: 'panel' }, h('h2', {}, 'Registers'), grid, ptrRow);
  }

  render(ctx: RenderCtx): void {
    const d = this.mcu.cpu.data;
    for (let i = 0; i < 32; i++) {
      const c = this.cells[i];
      const v = d[i];
      setText(c.hex, hex2(v));
      setText(c.dec, String(v));
      setClass(c.box, 'changed', !!ctx.prev && ctx.prev[i] !== v);
      setClass(c.box, 'zero', v === 0);
    }
    for (const p of this.ptrs) {
      const v = d[p.lo] | (d[p.lo + 1] << 8);
      setText(p.el, '0x' + hex4(v));
    }
  }
}

// ---------------------------------------------------------------------------

const PIN_INFO: Record<string, { arduino?: string; alt: string }> = {
  PB0: { arduino: 'D8', alt: 'ICP1 / CLKO / PCINT0' }, PB1: { arduino: 'D9', alt: 'OC1A / PCINT1' },
  PB2: { arduino: 'D10', alt: 'OC1B / SS / PCINT2' }, PB3: { arduino: 'D11', alt: 'OC2A / MOSI / PCINT3' },
  PB4: { arduino: 'D12', alt: 'MISO / PCINT4' }, PB5: { arduino: 'D13 (LED)', alt: 'SCK / PCINT5' },
  PB6: { alt: 'XTAL1 / PCINT6' }, PB7: { alt: 'XTAL2 / PCINT7' },
  PC0: { arduino: 'A0', alt: 'ADC0 / PCINT8' }, PC1: { arduino: 'A1', alt: 'ADC1 / PCINT9' },
  PC2: { arduino: 'A2', alt: 'ADC2 / PCINT10' }, PC3: { arduino: 'A3', alt: 'ADC3 / PCINT11' },
  PC4: { arduino: 'A4', alt: 'ADC4 / SDA / PCINT12' }, PC5: { arduino: 'A5', alt: 'ADC5 / SCL / PCINT13' },
  PC6: { alt: 'RESET / PCINT14' },
  PD0: { arduino: 'D0', alt: 'RXD / PCINT16' }, PD1: { arduino: 'D1', alt: 'TXD / PCINT17' },
  PD2: { arduino: 'D2', alt: 'INT0 / PCINT18' }, PD3: { arduino: 'D3', alt: 'INT1 / OC2B / PCINT19' },
  PD4: { arduino: 'D4', alt: 'T0 / XCK / PCINT20' }, PD5: { arduino: 'D5', alt: 'T1 / OC0B / PCINT21' },
  PD6: { arduino: 'D6', alt: 'OC0A / AIN0 / PCINT22' }, PD7: { arduino: 'D7', alt: 'AIN1 / PCINT23' },
};

export class PortsPanel implements Panel {
  el: HTMLElement;
  private rows: {
    port: Port;
    pins: { chip: HTMLElement; tag: HTMLElement }[];
    ddr: HTMLElement;
    out: HTMLElement;
    pin: HTMLElement;
  }[] = [];

  constructor(private mcu: ATmega328P, onEdit: OnEdit) {
    const body = h('div', { class: 'ports' });
    for (const name of ['B', 'C', 'D'] as PortName[]) {
      const port = mcu.ports[name];
      const pinsEl = h('div', { class: 'pins' });
      const pins: { chip: HTMLElement; tag: HTMLElement }[] = [];
      for (let bit = 7; bit >= 0; bit--) {
        if (bit >= port.width) {
          pinsEl.append(h('div', { class: 'pin pin-none' }));
          continue;
        }
        const tag = h('span', { class: 'pin-tag' });
        const chip = h('div', { class: 'pin' }, h('span', { class: 'pin-name' }, `P${name}${bit}`), tag);
        chip.addEventListener('click', (e) => {
          if (e.shiftKey) port.setInput(bit, null);
          else this.clickPin(port, bit);
          onEdit();
        });
        chip.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          port.setInput(bit, null);
          onEdit();
        });
        pins[bit] = { chip, tag };
        pinsEl.append(chip);
      }
      const ddr = h('span', { class: 'mono' });
      const out = h('span', { class: 'mono' });
      const pin = h('span', { class: 'mono' });
      body.append(
        h(
          'div',
          { class: 'port' },
          h('div', { class: 'port-head' }, h('b', {}, `PORT${name}`),
            h('span', { class: 'muted' }, 'DDR '), ddr,
            h('span', { class: 'muted' }, 'PORT '), out,
            h('span', { class: 'muted' }, 'PIN '), pin),
          pinsEl,
        ),
      );
      this.rows.push({ port, pins, ddr, out, pin });
    }
    const legend = h(
      'div',
      { class: 'legend' },
      h('span', { class: 'lg out-hi' }, 'Out 1'),
      h('span', { class: 'lg out-lo' }, 'Out 0'),
      h('span', { class: 'lg in-hi' }, 'In 1'),
      h('span', { class: 'lg in-lo' }, 'In 0'),
      h('span', { class: 'lg in-z' }, 'Floating'),
      h('span', { class: 'muted small' }, 'Click an input pin to drive it, right-click to release.'),
    );
    this.el = h('section', { class: 'panel' }, h('h2', {}, 'I/O Ports'), body, legend);
  }

  private clickPin(port: Port, bit: number): void {
    const b = 1 << bit;
    if (port.outputs & b) return; // outputs are driven by the MCU
    if (port.extDriven & b) port.setInput(bit, !(port.extValue & b));
    else port.setInput(bit, !(port.level & b)); // drive opposite of the current (pull-up/floating) level
  }

  render(ctx: RenderCtx): void {
    const d = this.mcu.cpu.data;
    const u = this.mcu.usart;
    for (const { port, pins, ddr, out, pin } of this.rows) {
      setText(ddr, bin8(port.ddr));
      setText(out, bin8(port.port));
      setText(pin, bin8(d[port.pinAddr]));
      setClass(pin, 'changed', !!ctx.prev && ctx.prev[port.pinAddr] !== d[port.pinAddr]);
      for (let bit = 0; bit < port.width; bit++) {
        const { chip, tag } = pins[bit];
        const b = 1 << bit;
        const isOut = !!(port.outputs & b);
        const state = port.pinState(bit);
        let cls = 'pin ';
        if (isOut) cls += state ? 'out-hi' : 'out-lo';
        else if (state === PIN_FLOAT) cls += 'in-z';
        else cls += state ? 'in-hi' : 'in-lo';
        if (!isOut && port.extDriven & b) cls += ' driven';
        if (chip.className !== cls) chip.className = cls;

        const pname = `P${port.name}${bit}`;
        let label = '';
        if (port.ovMask & b) label = this.ocName(pname);
        if (port.name === 'D' && bit === 1 && u.txEnabled) label = 'TXD';
        if (port.name === 'D' && bit === 0 && u.rxEnabled) label = 'RXD';
        if (!label && !isOut && port.port & b && !(port.extDriven & b)) label = 'pull-up';
        setText(tag, label);
        const info = PIN_INFO[pname];
        const how = isOut
          ? 'Output (set DDR bit = 1)'
          : port.extDriven & b
            ? `Input driven ${port.extValue & b ? 'high' : 'low'} by you`
            : state === PIN_FLOAT
              ? 'Input, floating (reads 0)'
              : 'Input with pull-up (reads 1)';
        setTitle(chip, `${pname}${info?.arduino ? ` — Arduino ${info.arduino}` : ''}\n${info?.alt ?? ''}\n${how}` +
          (isOut ? '' : '\nClick: drive the pin. Right-click: release.'));
      }
    }
  }

  private ocName(pin: string): string {
    return { PD6: 'OC0A', PD5: 'OC0B', PB1: 'OC1A', PB2: 'OC1B', PB3: 'OC2A', PD3: 'OC2B' }[pin] ?? 'alt';
  }
}

// ---------------------------------------------------------------------------

const CS_LABELS: Record<string, string[]> = {
  Timer0: ['stopped', 'clk/1', 'clk/8', 'clk/64', 'clk/256', 'clk/1024', 'T0 ↓', 'T0 ↑'],
  Timer1: ['stopped', 'clk/1', 'clk/8', 'clk/64', 'clk/256', 'clk/1024', 'T1 ↓', 'T1 ↑'],
  Timer2: ['stopped', 'clk/1', 'clk/8', 'clk/32', 'clk/64', 'clk/128', 'clk/256', 'clk/1024'],
};
const COM_LABEL = ['disconnected', 'toggle on match', 'clear on match (non-inverting)', 'set on match (inverting)'];
const MODE_SHORT: Record<string, string> = { normal: 'Normal', ctc: 'CTC', fast: 'Fast PWM', pc: 'Phase PWM', pfc: 'P&F PWM' };

/** Compact table: one row per timer. Details are in tooltips. */
export class TimersPanel implements Panel {
  el: HTMLElement;
  private rows: {
    t: Timer;
    tr: HTMLElement;
    count: HTMLElement;
    bar: HTMLElement;
    top: HTMLElement;
    ocrA: HTMLElement;
    ocrB: HTMLElement;
    mode: HTMLElement;
    clock: HTMLElement;
    flags: HTMLElement;
  }[] = [];

  constructor(private mcu: ATmega328P) {
    const tbody = h('tbody');
    for (const t of [mcu.timer0, mcu.timer1, mcu.timer2]) {
      const td = (cls = 'mono') => h('td', { class: cls });
      const r = {
        t, tr: h('tr'), count: h('span', { class: 'mono' }), bar: h('div', { class: 'bar-fill' }),
        top: td(), ocrA: td(), ocrB: td(), mode: td(''), clock: td(''), flags: td('tflags'),
      };
      r.tr.append(
        h('td', {}, h('b', {}, `T${t.cfg.name.slice(-1)}`), h('span', { class: 'muted small' }, ` ${t.cfg.bits}b`)),
        h('td', { class: 'count-cell' }, r.count, h('div', { class: 'bar' }, r.bar)),
        r.top, r.ocrA, r.ocrB, r.mode, r.clock, r.flags,
      );
      tbody.append(r.tr);
      this.rows.push(r);
    }
    this.el = h('section', { class: 'panel' }, h('h2', {}, 'Timers'),
      h('table', { class: 'tbl timers-tbl' },
        h('thead', {}, h('tr', {}, ...['', 'TCNT', 'TOP', 'OCR A', 'OCR B', 'Mode', 'Clock', 'Flags'].map((x) => h('th', {}, x)))),
        tbody));
  }

  render(): void {
    const d = this.mcu.cpu.data;
    for (const r of this.rows) {
      const t = r.t;
      const w = t.cfg.bits === 8 ? 2 : 4;
      const hx = (v: number) => v.toString(16).toUpperCase().padStart(w, '0');
      const n = t.cfg.name.slice(-1);
      setClass(r.tr, 'stopped', t.cs === 0);
      const top = t.top;
      setText(r.count, hx(t.count));
      setTitle(r.count, `TCNT${n} = ${t.count}`);
      r.bar.style.width = `${top ? Math.min(100, (t.count / top) * 100) : 0}%`;
      setText(r.top, hx(top));
      const oc = (ch: 'A' | 'B', el: HTMLElement, v: number, com: number) => {
        setText(el, hx(v) + (t.ocConnected(ch) ? ` → OC${n}${ch}` : ''));
        setClass(el, 'oc-on', t.ocConnected(ch));
        setTitle(el, `OCR${n}${ch} = ${v}\nOutput OC${n}${ch}: ${COM_LABEL[com]}`);
      };
      oc('A', r.ocrA, t.ocrA, t.comA);
      oc('B', r.ocrB, t.ocrB, t.comB);
      setText(r.mode, MODE_SHORT[t.mode.kind]);
      let modeTip = `WGM ${t.wgm}: ${t.mode.label}`;
      if (t.cfg.icr !== undefined) modeTip += `\nICR1 = ${d[t.cfg.icr] | (d[t.cfg.icr + 1] << 8)}`;
      const div = t.prescaler;
      if (div > 0) {
        const steps = t.mode.kind === 'pc' || t.mode.kind === 'pfc' ? 2 * top : top + 1;
        modeTip += `\nPeriod: ${formatHz(this.mcu.frequency / div / Math.max(1, steps))}`;
      }
      setTitle(r.mode, modeTip);
      setText(r.clock, CS_LABELS[t.cfg.name][t.cs]);
      const tifr = d[t.cfg.tifr], timsk = d[t.cfg.timsk];
      const names: [number, string][] = [[0, 'OV'], [1, 'A'], [2, 'B']];
      if (t.cfg.bits === 16) names.push([5, 'IC']);
      const html = names
        .map(([bit, nm]) => {
          const f = (tifr >> bit) & 1, e = (timsk >> bit) & 1;
          return `<span class="tflag${f ? ' set' : ''}${e ? ' en' : ''}" title="${nm} flag ${f ? 'set' : 'clear'}, interrupt ${e ? 'enabled' : 'disabled'}">${nm}</span>`;
        })
        .join('');
      if (r.flags.innerHTML !== html) r.flags.innerHTML = html;
    }
  }
}

// ---------------------------------------------------------------------------

/** Interrupt sources. Only enabled or already-taken ones are listed unless "all" is on. */
export class InterruptsPanel implements Panel {
  el: HTMLElement;
  private rows: { tr: HTMLElement; en: HTMLElement; fl: HTMLElement; cnt: HTMLElement }[] = [];
  private gie = h('span', { class: 'mono' });
  private empty = h('div', { class: 'muted small empty' }, 'No interrupts enabled.');
  private showAll = false;
  private allBtn: HTMLButtonElement;

  constructor(private mcu: ATmega328P) {
    const tbody = h('tbody');
    for (const src of mcu.interrupts) {
      const en = h('td', { class: 'c' });
      const fl = h('td', { class: 'c' });
      const cnt = h('td', { class: 'mono r' });
      const tr = h('tr', {}, h('td', { class: 'mono muted' }, `0x${hex4(src.vector * 2)}`), h('td', {}, src.name), en, fl, cnt);
      tbody.append(tr);
      this.rows.push({ tr, en, fl, cnt });
    }
    this.allBtn = h('button', { class: 'btn small ghost-link', onclick: () => {
      this.showAll = !this.showAll;
      this.render();
    } }, 'Show all');
    this.el = h(
      'section',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Interrupts'), h('span', { class: 'muted small' }, 'I flag:'), this.gie, this.allBtn),
      h('table', { class: 'tbl ints-tbl' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Vector'), h('th', {}, 'Source'), h('th', { class: 'c' }, 'En'), h('th', { class: 'c' }, 'Flag'), h('th', { class: 'r' }, 'Taken'))),
        tbody),
      this.empty,
    );
  }

  render(): void {
    const pending = this.mcu.pendingInterrupt();
    const gie = !!(this.mcu.cpu.sreg & 0x80);
    setText(this.gie, gie ? 'on' : 'off');
    setClass(this.gie, 'ok', gie);
    setText(this.allBtn, this.showAll ? 'Show active' : 'Show all');
    let shown = 0;
    this.mcu.interrupts.forEach((src, i) => {
      const r = this.rows[i];
      const en = src.enabled(), fl = src.displayFlag ? src.displayFlag() : src.flagged();
      const taken = this.mcu.interruptCounts.get(src.vector) ?? 0;
      const visible = this.showAll || en || taken > 0;
      r.tr.style.display = visible ? '' : 'none';
      if (!visible) return;
      shown++;
      setText(r.en, en ? '●' : '·');
      setText(r.fl, fl ? '●' : '·');
      setClass(r.en, 'on', en);
      setClass(r.fl, 'on', fl);
      setText(r.cnt, String(taken));
      setClass(r.tr, 'pending', pending === src);
      setClass(r.tr, 'active', en);
    });
    this.empty.style.display = shown ? 'none' : '';
  }
}

// ---------------------------------------------------------------------------

export class UsartPanel implements Panel {
  el: HTMLElement;
  private status = h('div', { class: 'usart-status small' });
  private output = h('pre', { class: 'console', tabindex: '0' });
  private input = h('input', { class: 'console-input', placeholder: 'Type and press Enter to send to RXD…', spellcheck: 'false' });
  private ending = h('select', { title: 'Line ending added when you press Enter' },
    h('option', { value: '' }, 'No line ending'),
    h('option', { value: '\n' }, 'LF'),
    h('option', { value: '\r' }, 'CR'),
    h('option', { value: '\r\n' }, 'CR+LF'));
  private text = '';
  private dirty = false;

  constructor(private mcu: ATmega328P) {
    mcu.usart.onTransmit = (b) => this.append(b);
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter') return;
      const s = this.input.value + this.ending.value;
      this.mcu.usart.receive([...new TextEncoder().encode(s)]);
      this.input.value = '';
    });
    const clear = h('button', { class: 'btn small', onclick: () => this.clear() }, 'Clear');
    this.el = h(
      'section',
      { class: 'panel usart-panel' },
      h('h2', {}, 'USART0 Serial Console'),
      this.status,
      this.output,
      h('div', { class: 'console-row' }, this.input, this.ending, clear),
    );
  }

  private append(b: number): void {
    if (b === 13) return; // treat CR LF as LF
    this.text += b === 10 || b === 9 || (b >= 32 && b < 127) ? String.fromCharCode(b) : `\\x${hex2(b)}`;
    if (this.text.length > 20000) this.text = this.text.slice(-15000);
    this.dirty = true;
  }

  clear(): void {
    this.text = '';
    this.dirty = true;
  }

  render(): void {
    const u = this.mcu.usart;
    const d = this.mcu.cpu.data;
    const a = d[REG.UCSR0A];
    const frame = `${u.dataBits}${u.parity[0].toUpperCase()}${u.stopBits}`;
    const st = `TX ${u.txEnabled ? 'on' : 'off'} · RX ${u.rxEnabled ? 'on' : 'off'} · ${Math.round(u.baud(this.mcu.frequency))} baud (UBRR=${u.ubrr}${u.doubleSpeed ? ', U2X' : ''}) · ${frame}` +
      ` · flags: ${a & 0x80 ? 'RXC ' : ''}${a & 0x40 ? 'TXC ' : ''}${a & 0x20 ? 'UDRE' : ''}` +
      (u.rxPending ? ` · ${u.rxPending} byte(s) waiting to be received` : '');
    setText(this.status, st);
    if (this.dirty) {
      this.dirty = false;
      const atBottom = this.output.scrollTop + this.output.clientHeight >= this.output.scrollHeight - 4;
      this.output.textContent = this.text;
      if (atBottom) this.output.scrollTop = this.output.scrollHeight;
    }
  }
}
