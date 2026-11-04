import { disassemble } from '../core/disasm';
import { M328P_REGS } from '../core/m328pdef';
import type { ATmega328P } from '../core/mcu';
import { h, hex2, hex4, inlineEdit, parseNumber, setClass, setText } from './dom';
import type { OnEdit, Panel, RenderCtx } from './panels';

type Tab = 'program' | 'sram' | 'io';

/** Tabbed memory view: program listing, SRAM hex dump, I/O registers. */
export class MemoryPanel implements Panel {
  el: HTMLElement;
  private tab: Tab = 'program';
  private tabs = new Map<Tab, { btn: HTMLElement; body: HTMLElement }>();

  // SRAM
  private cells: HTMLElement[] = [];
  private ascii: HTMLElement[] = [];
  private sramLabels = new Map<number, string>();

  // I/O
  private ioRows: { addr: number; hex: HTMLElement; bits: HTMLElement[] }[] = [];

  // Program listing
  private listBody = h('tbody');
  private listRows = new Map<number, HTMLElement>();
  private listKey: unknown = null;
  private lastPcRow: HTMLElement | null = null;

  constructor(
    private mcu: ATmega328P,
    onEdit: OnEdit,
    private goToLine: (line: number) => void,
  ) {
    const tabBar = h('div', { class: 'tabs' });
    const bodies = h('div', { class: 'tab-bodies' });
    const add = (id: Tab, label: string, body: HTMLElement) => {
      const btn = h('button', { class: 'tab', onclick: () => this.select(id) }, label);
      tabBar.append(btn);
      bodies.append(body);
      this.tabs.set(id, { btn, body });
    };

    // Program listing
    add('program', 'Program memory', h('div', { class: 'scroll-y listing' },
      h('table', { class: 'tbl mono' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Addr'), h('th', {}, 'Opcode'), h('th', {}, 'Disassembly'), h('th', {}, 'Line'))),
        this.listBody)));

    // SRAM
    const sram = h('div', { class: 'hexdump mono' });
    const header = h('div', { class: 'hex-row hex-head' }, h('span', { class: 'hex-addr' }, ''));
    for (let i = 0; i < 16; i++) header.append(h('span', { class: 'hex-cell' }, hex2(i).slice(1)));
    sram.append(header);
    for (let row = 0x100; row < 0x900; row += 16) {
      const r = h('div', { class: 'hex-row' }, h('span', { class: 'hex-addr' }, hex4(row)));
      const asc = h('span', { class: 'hex-ascii' });
      for (let i = 0; i < 16; i++) {
        const addr = row + i;
        const c = h('span', { class: 'hex-cell' });
        c.addEventListener('click', () =>
          inlineEdit(c, '0x' + hex2(mcu.cpu.data[addr]), (t) => {
            const v = parseNumber(t);
            if (v !== null) {
              mcu.cpu.data[addr] = v & 0xff;
              onEdit();
            }
          }),
        );
        this.cells[addr - 0x100] = c;
        r.append(c);
      }
      for (let i = 0; i < 16; i++) {
        const a = h('span');
        this.ascii[row - 0x100 + i] = a;
        asc.append(a);
      }
      r.append(asc);
      sram.append(r);
    }
    add('sram', 'SRAM', h('div', { class: 'scroll-y' }, sram,
      h('div', { class: 'legend small' }, h('span', { class: 'lg sp-mark' }, 'SP'), h('span', { class: 'lg stack-mark' }, 'stack'),
        h('span', { class: 'lg changed-mark' }, 'changed'), h('span', { class: 'muted' }, 'Click a byte to edit.'))));

    // I/O registers
    const ioBody = h('tbody');
    for (const reg of M328P_REGS) {
      const hexEl = h('td', { class: 'mono editable' });
      const bits: HTMLElement[] = [];
      const tr = h('tr', {},
        h('td', { title: reg.desc || reg.name }, h('b', {}, reg.name)),
        h('td', { class: 'mono muted' }, reg.addr < 0x60 ? `0x${hex2(reg.addr - 0x20)}` : '—'),
        h('td', { class: 'mono muted' }, `0x${hex2(reg.addr)}`),
        hexEl);
      for (let b = 7; b >= 0; b--) {
        const name = reg.bits[b]?.replace(/^SREG_/, '') ?? '';
        const td = h('td', { class: 'bit', title: `${reg.name} bit ${b}${name ? ` (${name})` : ''}. Click to toggle.` }, name || String(b));
        td.addEventListener('click', () => {
          const v = mcu.cpu.data[reg.addr] ^ (1 << b);
          this.writeIo(reg.addr, v);
          onEdit();
        });
        bits[b] = td;
        tr.append(td);
      }
      hexEl.addEventListener('click', () =>
        inlineEdit(hexEl, '0x' + hex2(mcu.cpu.data[reg.addr]), (t) => {
          const v = parseNumber(t);
          if (v !== null) {
            this.writeIo(reg.addr, v & 0xff);
            onEdit();
          }
        }),
      );
      ioBody.append(tr);
      this.ioRows.push({ addr: reg.addr, hex: hexEl, bits });
    }
    add('io', 'I/O registers', h('div', { class: 'scroll-y' },
      h('p', { class: 'muted small' }, 'Edits are written like an OUT/STS instruction would (e.g. writing 1 to a flag clears it).'),
      h('table', { class: 'tbl io-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Register'), h('th', {}, 'I/O'), h('th', {}, 'Data'), h('th', {}, 'Value'),
          ...[7, 6, 5, 4, 3, 2, 1, 0].map((b) => h('th', { class: 'c' }, String(b))))),
        ioBody)));

    this.el = h('section', { class: 'panel memory-panel' }, h('h2', {}, 'Memory'), tabBar, bodies);
    this.select('program');
  }

  private writeIo(addr: number, v: number): void {
    // 16-bit registers: keep the high byte when writing the low byte through TEMP.
    const cpu = this.mcu.cpu;
    if ([0x84, 0x86, 0x88, 0x8a].includes(addr)) cpu.writeData(addr + 1, cpu.data[addr + 1]);
    cpu.writeData(addr, v);
  }

  select(tab: Tab): void {
    this.tab = tab;
    for (const [id, { btn, body }] of this.tabs) {
      setClass(btn, 'active', id === tab);
      body.style.display = id === tab ? '' : 'none';
    }
  }

  setDataLabels(labels: { name: string; value: number }[]): void {
    this.sramLabels.clear();
    for (const l of labels) this.sramLabels.set(l.value, l.name);
    for (let a = 0x100; a < 0x900; a++) {
      const n = this.sramLabels.get(a);
      this.cells[a - 0x100].title = `0x${hex4(a)}${n ? ` — ${n}` : ''}`;
      setClass(this.cells[a - 0x100], 'labeled', !!n);
    }
  }

  private buildListing(ctx: RenderCtx): void {
    this.listBody.textContent = '';
    this.listRows.clear();
    this.lastPcRow = null;
    const asm = ctx.asm;
    if (!asm || !asm.ok) {
      this.listBody.append(h('tr', {}, h('td', { colspan: '4', class: 'muted' }, 'Assemble a program to see its machine code.')));
      return;
    }
    const flash = this.mcu.cpu.flash;
    const labels = new Map<number, string>();
    for (const s of asm.symbols) if (s.kind === 'label') labels.set(s.value, s.name);
    for (const entry of asm.listing) {
      let a = entry.addr;
      const end = entry.addr + entry.words.length;
      const isData = entry.data;
      while (a < end) {
        const op = flash[a];
        const dis = isData ? { text: '.dw data', words: 1 } : disassemble(op, flash[a + 1], a);
        const words = Math.min(dis.words, end - a);
        const label = labels.get(a);
        if (label) {
          this.listBody.append(h('tr', { class: 'label-row' }, h('td', { colspan: '4' }, `${label}:`)));
        }
        const opcode = Array.from({ length: words }, (_, i) => hex4(flash[a + i])).join(' ');
        const tr = h('tr', {
          class: 'clickable',
          title: `Go to line ${entry.line}`,
          onclick: () => this.goToLine(entry.line),
        },
          h('td', { class: 'muted' }, hex4(a)),
          h('td', {}, opcode),
          h('td', {}, dis.text),
          h('td', { class: 'muted' }, String(entry.line)));
        this.listRows.set(a, tr);
        this.listBody.append(tr);
        a += words;
      }
    }
  }


  render(ctx: RenderCtx): void {
    const d = this.mcu.cpu.data;
    if (this.tab === 'sram') {
      const sp = this.mcu.cpu.sp;
      for (let a = 0x100; a < 0x900; a++) {
        const v = d[a];
        const c = this.cells[a - 0x100];
        setText(c, hex2(v));
        setClass(c, 'sp', a === sp);
        setClass(c, 'stack', a > sp && a <= 0x8ff);
        setClass(c, 'changed', !!ctx.prev && ctx.prev[a] !== v);
        setClass(c, 'nz', v !== 0);
        setText(this.ascii[a - 0x100], v >= 32 && v < 127 ? String.fromCharCode(v) : '.');
      }
    } else if (this.tab === 'io') {
      for (const r of this.ioRows) {
        const v = d[r.addr];
        setText(r.hex, '0x' + hex2(v));
        setClass(r.hex, 'changed', !!ctx.prev && ctx.prev[r.addr] !== v);
        for (let b = 0; b < 8; b++) setClass(r.bits[b], 'on', !!(v & (1 << b)));
      }
    } else {
      if (this.listKey !== ctx.asm) {
        this.listKey = ctx.asm;
        this.buildListing(ctx);
      }
      const row = this.listRows.get(this.mcu.cpu.pc) ?? null;
      if (row !== this.lastPcRow) {
        this.lastPcRow?.classList.remove('pc-row');
        row?.classList.add('pc-row');
        this.lastPcRow = row;
        if (row && !ctx.running) row.scrollIntoView({ block: 'nearest' });
      }
    }
  }
}
