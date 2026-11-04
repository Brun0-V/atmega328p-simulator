// Two-pass assembler for AVRA / Atmel-style AVR assembly targeting the ATmega328P.
import { FLASH_WORDS } from './cpu';
import { AsmError, UndefinedSymbol, evaluate } from './expr';
import { M328P_EQU } from './m328pdef';

export interface AsmMessage {
  line: number; // 1-based source line
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface ListingEntry {
  addr: number; // word address
  words: number[];
  line: number;
  /** True for .db/.dw data rather than instructions. */
  data: boolean;
}

export interface SymbolInfo {
  name: string;
  value: number;
  kind: 'label' | 'data' | 'equ' | 'set' | 'def';
  line: number;
}

export interface AsmResult {
  ok: boolean;
  flash: Uint16Array;
  eeprom: Uint8Array;
  /** Number of flash words in use (highest used address + 1). */
  size: number;
  /** For every flash word: the source line that produced it, or -1. */
  addrToLine: Int32Array;
  /** First flash word address produced by each source line. */
  lineToAddr: Map<number, number>;
  listing: ListingEntry[];
  messages: AsmMessage[];
  symbols: SymbolInfo[];
}

type Seg = 'c' | 'd' | 'e';

interface Stmt {
  line: number;
  seg: Seg;
  addr: number;
  kind: 'insn' | 'db' | 'dw' | 'set';
  name: string;
  ops: string[];
}

interface Sym {
  kind: 'label' | 'data' | 'equ' | 'set';
  value?: number;
  expr?: string;
  line: number;
  resolving?: boolean;
}

const BUILTIN_DEFS: Record<string, number> = { xl: 26, xh: 27, yl: 28, yh: 29, zl: 30, zh: 31 };
const BUILTIN_EQU = new Map(Object.entries(M328P_EQU).map(([k, v]) => [k.toLowerCase(), v]));

const TWO_WORD = new Set(['jmp', 'call', 'lds', 'sts']);
const UNSUPPORTED = new Set(['eijmp', 'eicall', 'elpm', 'des', 'xch', 'las', 'lac', 'lat']);

const SREG_FLAGS = 'cznvshti'.split(''); // SREG bits 0-7
const BR_SET: Record<string, number> = { brcs: 0, brlo: 0, breq: 1, brmi: 2, brvs: 3, brlt: 4, brhs: 5, brts: 6, brie: 7 };
const BR_CLR: Record<string, number> = { brcc: 0, brsh: 0, brne: 1, brpl: 2, brvc: 3, brge: 4, brhc: 5, brtc: 6, brid: 7 };

const TWO_REG: Record<string, number> = {
  add: 0x0c00, adc: 0x1c00, sub: 0x1800, sbc: 0x0800, and: 0x2000, or: 0x2800, eor: 0x2400,
  mov: 0x2c00, cp: 0x1400, cpc: 0x0400, cpse: 0x1000, mul: 0x9c00,
};
const SAME_REG: Record<string, number> = { lsl: 0x0c00, rol: 0x1c00, tst: 0x2000, clr: 0x2400 };
const IMM: Record<string, number> = { cpi: 0x3000, sbci: 0x4000, subi: 0x5000, ori: 0x6000, andi: 0x7000, ldi: 0xe000 };
const ONE_REG: Record<string, number> = {
  com: 0x9400, neg: 0x9401, swap: 0x9402, inc: 0x9403, asr: 0x9405, lsr: 0x9406, ror: 0x9407,
  dec: 0x940a, push: 0x920f, pop: 0x900f,
};
const IMPLIED: Record<string, number> = {
  nop: 0x0000, ijmp: 0x9409, icall: 0x9509, ret: 0x9508, reti: 0x9518, sleep: 0x9588,
  break: 0x9598, wdr: 0x95a8, spm: 0x95e8,
};
const BIT_REG: Record<string, number> = { bld: 0xf800, bst: 0xfa00, sbrc: 0xfc00, sbrs: 0xfe00 };
const BIT_IO: Record<string, number> = { cbi: 0x9800, sbic: 0x9900, sbi: 0x9a00, sbis: 0x9b00 };
const MUL_LOW: Record<string, number> = { mulsu: 0x0300, fmul: 0x0308, fmuls: 0x0380, fmulsu: 0x0388 };

function isMnemonic(name: string): boolean {
  return (
    name in TWO_REG || name in SAME_REG || name in IMM || name in ONE_REG || name in IMPLIED ||
    name in BIT_REG || name in BIT_IO || name in MUL_LOW || name in BR_SET || name in BR_CLR ||
    [
      'sbr', 'cbr', 'ser', 'adiw', 'sbiw', 'muls', 'movw', 'rjmp', 'rcall', 'jmp', 'call', 'brbs', 'brbc',
      'bset', 'bclr', 'in', 'out', 'lds', 'sts', 'ld', 'ldd', 'st', 'std', 'lpm',
    ].includes(name) ||
    /^(se|cl)[cznvshti]$/.test(name)
  );
}

/** Remove ; and // comments that are not inside string or character literals. */
function stripComment(line: string): string {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '\\') i++;
      else if (ch === q) q = null;
    } else if (ch === '"') {
      q = ch;
    } else if (ch === "'" && line[i + 2] === "'" ) {
      i += 2;
    } else if (ch === "'" && line[i + 1] === '\\' && line[i + 3] === "'") {
      i += 3;
    } else if (ch === ';' || (ch === '/' && line[i + 1] === '/')) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Split operands on commas that are outside parentheses and quotes. */
function splitOperands(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let q: string | null = null;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      cur += ch;
      if (ch === '\\') cur += s[++i] ?? '';
      else if (ch === q) q = null;
      continue;
    }
    if (ch === '"') { q = ch; cur += ch; continue; }
    if (ch === "'") {
      // character literal: copy 'x' or '\x'
      const len = s[i + 1] === '\\' ? 4 : 3;
      cur += s.slice(i, i + len);
      i += len - 1;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== '' || out.length) out.push(cur.trim());
  return out;
}

function parseString(s: string): number[] | null {
  if (!(s.startsWith('"') && s.endsWith('"') && s.length >= 2)) return null;
  const out: number[] = [];
  const body = s.slice(1, -1);
  const esc: Record<string, number> = { n: 10, r: 13, t: 9, '0': 0, '\\': 92, '"': 34, "'": 39 };
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && i + 1 < body.length) {
      const e = body[++i];
      out.push(esc[e] ?? e.charCodeAt(0));
    } else {
      out.push(body.charCodeAt(i) & 0xff);
    }
  }
  return out;
}

interface CondFrame {
  active: boolean; // this branch is being assembled
  taken: boolean; // some branch of this .if has been taken
  parentActive: boolean;
}

export function assemble(source: string): AsmResult {
  const messages: AsmMessage[] = [];
  const syms = new Map<string, Sym>();
  const defs = new Map<string, { reg: number; line: number }>();
  const defines = new Map<string, string>();
  const macros = new Map<string, { body: { text: string; line: number }[]; line: number }>();
  const stmts: Stmt[] = [];
  const loc: Record<Seg, number> = { c: 0, d: 0x100, e: 0 };
  let seg: Seg = 'c';
  let curLine = 0;
  let currentPC = 0;

  const err = (line: number, message: string) => messages.push({ line, severity: 'error', message });
  const warn = (line: number, message: string) => messages.push({ line, severity: 'warning', message });

  const lookup = (name: string): number | undefined => {
    const key = name.toLowerCase();
    if (key === 'pc') return currentPC;
    const s = syms.get(key);
    if (s) {
      if (s.value !== undefined) return s.value;
      if (s.kind === 'equ' && s.expr !== undefined) {
        if (s.resolving) throw new AsmError(`Circular definition of '${name}'`);
        s.resolving = true;
        try {
          s.value = evaluate(s.expr, lookup);
        } finally {
          s.resolving = false;
        }
        return s.value;
      }
      return undefined;
    }
    if (defs.has(key)) throw new AsmError(`'${name}' is a register (.def), not a number`);
    return BUILTIN_EQU.get(key);
  };

  const ev = (s: string) => evaluate(s, lookup);

  const define = (name: string, sym: Sym) => {
    const key = name.toLowerCase();
    const old = syms.get(key);
    if (old && !(old.kind === 'set' && sym.kind === 'set')) {
      throw new AsmError(`'${name}' is already defined on line ${old.line}`);
    }
    if (defs.has(key)) throw new AsmError(`'${name}' is already defined as a register`);
    if (isMnemonic(key)) throw new AsmError(`'${name}' is an instruction name and can't be used as a symbol`);
    syms.set(key, sym);
  };

  const applyDefines = (text: string) => {
    if (defines.size === 0) return text;
    return text.replace(/[A-Za-z_]\w*/g, (w) => defines.get(w.toLowerCase()) ?? w);
  };

  // ----- Pass 1 -----
  const cond: CondFrame[] = [];
  const active = () => cond.length === 0 || cond[cond.length - 1].active;
  let recording: { name: string; body: { text: string; line: number }[]; line: number } | null = null;
  let exited = false;

  const rawLines = source.replace(/\r\n?/g, '\n').split('\n');
  // Strip /* block comments */ while keeping line numbers.
  let inBlock = false;
  const lines = rawLines.map((l) => {
    let out = '';
    let i = 0;
    while (i < l.length) {
      if (inBlock) {
        const e = l.indexOf('*/', i);
        if (e < 0) { i = l.length; break; }
        inBlock = false;
        i = e + 2;
      } else {
        const sc = stripComment(l.slice(i));
        const b = sc.indexOf('/*');
        if (b < 0) { out += sc; break; }
        out += sc.slice(0, b);
        inBlock = true;
        i += b + 2;
      }
    }
    return out;
  });

  const processLine = (text: string, line: number, depth: number) => {
    curLine = line;
    let rest = text.trim();
    if (!rest || exited) return;

    if (recording) {
      if (/^\.(endm|endmacro)\b/i.test(rest)) {
        macros.set(recording.name, { body: recording.body, line: recording.line });
        recording = null;
      } else {
        recording.body.push({ text: rest, line });
      }
      return;
    }

    // Conditional directives are processed even in inactive regions.
    const cm = /^[.#](if|ifdef|ifndef|elif|elseif|else|endif)\b\s*(.*)$/i.exec(rest);
    if (cm) {
      const d = cm[1].toLowerCase();
      const arg = cm[2].trim();
      const symDefined = (n: string) =>
        syms.has(n.toLowerCase()) || defs.has(n.toLowerCase()) || defines.has(n.toLowerCase()) ||
        BUILTIN_EQU.has(n.toLowerCase());
      if (d === 'if' || d === 'ifdef' || d === 'ifndef') {
        const parent = active();
        let c = false;
        if (parent) {
          if (d === 'if') c = !!ev(applyDefines(arg));
          else c = symDefined(arg) === (d === 'ifdef');
        }
        cond.push({ active: parent && c, taken: c, parentActive: parent });
      } else if (d === 'elif' || d === 'elseif') {
        const f = cond[cond.length - 1];
        if (!f) throw new AsmError(`.${d} without .if`);
        if (f.taken || !f.parentActive) f.active = false;
        else {
          f.active = !!ev(applyDefines(arg));
          f.taken = f.active;
        }
      } else if (d === 'else') {
        const f = cond[cond.length - 1];
        if (!f) throw new AsmError('.else without .if');
        f.active = f.parentActive && !f.taken;
        f.taken = true;
      } else {
        if (!cond.pop()) throw new AsmError('.endif without .if');
      }
      return;
    }
    if (!active()) return;

    if (rest.startsWith('#')) {
      const m = /^#\s*(\w+)\s*(.*)$/.exec(rest);
      const d = m?.[1].toLowerCase();
      if (d === 'define') {
        const dm = /^([A-Za-z_]\w*)\s*(.*)$/.exec(m![2]);
        if (!dm) throw new AsmError('Bad #define');
        defines.set(dm[1].toLowerCase(), applyDefines(dm[2].trim()) || '1');
        return;
      }
      if (d === 'undef') {
        defines.delete(m![2].trim().toLowerCase());
        return;
      }
      if (d === 'include') {
        rest = '.include ' + m![2];
      } else if (d === 'pragma' || d === 'message' || d === 'warning') {
        return;
      } else if (d === 'error') {
        throw new AsmError(m![2] || '#error');
      } else {
        throw new AsmError(`Unknown preprocessor directive '#${m?.[1]}'`);
      }
    }

    rest = applyDefines(rest);

    // Label
    const lm = /^([A-Za-z_]\w*)\s*:(?!=)/.exec(rest);
    if (lm) {
      const name = lm[1];
      if (seg === 'c') define(name, { kind: 'label', value: loc.c, line });
      else define(name, { kind: 'data', value: loc[seg], line });
      rest = rest.slice(lm[0].length).trim();
      if (!rest) return;
    }

    if (rest.startsWith('.')) {
      const m = /^\.(\w+)\s*(.*)$/.exec(rest);
      if (!m) throw new AsmError(`Bad directive '${rest}'`);
      const d = m[1].toLowerCase();
      const arg = m[2].trim();
      switch (d) {
        case 'equ':
        case 'set': {
          const em = /^([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(arg);
          if (!em) throw new AsmError(`Expected '.${d} NAME = value'`);
          let value: number | undefined;
          try {
            value = ev(em[2]);
          } catch (e) {
            if (!(e instanceof UndefinedSymbol)) throw e;
          }
          define(em[1], { kind: d, value, expr: em[2], line });
          if (d === 'set') stmts.push({ line, seg, addr: loc[seg], kind: 'set', name: em[1], ops: [em[2]] });
          return;
        }
        case 'def': {
          const dm = /^([A-Za-z_]\w*)\s*=\s*(\w+)$/.exec(arg);
          if (!dm) throw new AsmError("Expected '.def NAME = rN'");
          const reg = parseReg(dm[2]);
          const key = dm[1].toLowerCase();
          if (/^r\d+$/.test(key)) throw new AsmError(`Can't redefine register name '${dm[1]}'`);
          if (syms.has(key)) throw new AsmError(`'${dm[1]}' is already defined as a symbol`);
          defs.set(key, { reg, line });
          return;
        }
        case 'undef':
          defs.delete(arg.toLowerCase());
          return;
        case 'cseg': seg = 'c'; return;
        case 'dseg': seg = 'd'; return;
        case 'eseg': seg = 'e'; return;
        case 'org': {
          currentPC = loc[seg];
          const v = ev(arg);
          if (v < 0) throw new AsmError('.org address must not be negative');
          loc[seg] = v;
          return;
        }
        case 'byte': {
          if (seg === 'c') throw new AsmError('.byte is only allowed in .dseg or .eseg');
          const n = arg ? ev(arg) : 1;
          loc[seg] += n;
          return;
        }
        case 'db':
        case 'dw': {
          const ops = splitOperands(arg);
          if (ops.length === 0) throw new AsmError(`.${d} needs at least one value`);
          if (seg === 'd') throw new AsmError(`.${d} is not allowed in .dseg (use .byte to reserve RAM)`);
          stmts.push({ line, seg, addr: loc[seg], kind: d, name: d, ops });
          let bytes = 0;
          for (const o of ops) bytes += d === 'db' ? parseString(o)?.length ?? 1 : 2;
          if (seg === 'c') loc.c += Math.ceil(bytes / 2);
          else loc.e += bytes;
          return;
        }
        case 'macro': {
          const name = arg.split(/\s+/)[0]?.toLowerCase();
          if (!name) throw new AsmError('.macro needs a name');
          if (isMnemonic(name)) throw new AsmError(`'${name}' is an instruction name`);
          recording = { name, body: [], line };
          return;
        }
        case 'endm':
        case 'endmacro':
          throw new AsmError(`.${d} without .macro`);
        case 'include': {
          const file = arg.replace(/^["<]|[">]$/g, '').toLowerCase();
          if (file !== 'm328pdef.inc') {
            throw new AsmError(`Can't include '${arg}': only "m328Pdef.inc" is available (its names are built in).`);
          }
          return;
        }
        case 'device':
          if (arg && !/^atmega328p?$/i.test(arg)) warn(line, `This simulator only models the ATmega328P (got ${arg})`);
          return;
        case 'list': case 'nolist': case 'listmac': case 'listfile': case 'csegsize': case 'overlap': case 'nooverlap':
          return;
        case 'exit':
          exited = true;
          return;
        case 'message':
          messages.push({ line, severity: 'info', message: arg.replace(/^"|"$/g, '') });
          return;
        case 'warning':
          warn(line, arg.replace(/^"|"$/g, ''));
          return;
        case 'error':
          throw new AsmError(arg.replace(/^"|"$/g, ''));
        default:
          throw new AsmError(`Unknown directive '.${m[1]}'`);
      }
    }

    // Instruction or macro call
    const im = /^([A-Za-z_]\w*)\s*(.*)$/.exec(rest);
    if (!im) throw new AsmError(`Can't parse '${rest}'`);
    const name = im[1].toLowerCase();
    const macro = macros.get(name);
    if (macro) {
      if (depth > 16) throw new AsmError('Macro nesting too deep');
      const args = splitOperands(im[2]);
      for (const bl of macro.body) {
        const expanded = bl.text.replace(/@([0-9])/g, (_, n) => args[+n] ?? '');
        processLine(expanded, line, depth + 1);
      }
      return;
    }
    if (UNSUPPORTED.has(name)) throw new AsmError(`'${name}' is not available on the ATmega328P`);
    if (!isMnemonic(name)) throw new AsmError(`Unknown instruction or macro '${im[1]}'`);
    if (seg !== 'c') throw new AsmError('Instructions must be in the code segment (.cseg)');
    stmts.push({ line, seg, addr: loc.c, kind: 'insn', name, ops: im[2].trim() ? splitOperands(im[2]) : [] });
    loc.c += TWO_WORD.has(name) ? 2 : 1;
  };

  function parseReg(s: string): number {
    const t = s.trim();
    const m = /^r(\d{1,2})$/i.exec(t);
    if (m) {
      const n = +m[1];
      if (n > 31) throw new AsmError(`No such register '${t}'`);
      return n;
    }
    const d = defs.get(t.toLowerCase());
    if (d) return d.reg;
    const b = BUILTIN_DEFS[t.toLowerCase()];
    if (b !== undefined) return b;
    throw new AsmError(`Expected a register (r0-r31), got '${t}'`);
  }

  for (let i = 0; i < lines.length; i++) {
    try {
      processLine(lines[i], i + 1, 0);
    } catch (e) {
      if (e instanceof AsmError) err(curLine || i + 1, e.message);
      else throw e;
    }
    if (exited) break;
  }
  if (recording) err((recording as { line: number }).line, '.macro without .endm');
  if (cond.length) err(lines.length, 'Missing .endif');

  // ----- Pass 2 -----
  const flash = new Uint16Array(FLASH_WORDS).fill(0xffff);
  const used = new Uint8Array(FLASH_WORDS);
  const eeprom = new Uint8Array(1024).fill(0xff);
  const addrToLine = new Int32Array(FLASH_WORDS).fill(-1);
  const lineToAddr = new Map<number, number>();
  const listing: ListingEntry[] = [];
  let size = 0;

  const emit = (addr: number, words: number[], line: number, data = false) => {
    for (let i = 0; i < words.length; i++) {
      const a = addr + i;
      if (a >= FLASH_WORDS) throw new AsmError(`Program does not fit in flash (address 0x${(a * 2).toString(16)})`);
      if (used[a]) throw new AsmError(`Code overlaps earlier code at word 0x${a.toString(16)} (line ${addrToLine[a]})`);
      used[a] = 1;
      flash[a] = words[i] & 0xffff;
      addrToLine[a] = line;
    }
    if (!lineToAddr.has(line)) lineToAddr.set(line, addr);
    listing.push({ addr, words, line, data });
    size = Math.max(size, addr + words.length);
  };

  const range = (v: number, lo: number, hi: number, what: string) => {
    if (v < lo || v > hi) throw new AsmError(`${what} ${v} out of range (${lo}..${hi})`);
    return v;
  };

  for (const st of stmts) {
    curLine = st.line;
    currentPC = st.addr;
    try {
      if (st.kind === 'set') {
        syms.get(st.name.toLowerCase())!.value = ev(st.ops[0]);
      } else if (st.kind === 'db' || st.kind === 'dw') {
        const bytes: number[] = [];
        for (const o of st.ops) {
          const str = st.kind === 'db' ? parseString(o) : null;
          if (str) bytes.push(...str);
          else {
            const v = ev(o);
            if (st.kind === 'db') {
              range(v, -128, 255, 'Byte value');
              bytes.push(v & 0xff);
            } else {
              range(v, -32768, 65535, 'Word value');
              bytes.push(v & 0xff, (v >> 8) & 0xff);
            }
          }
        }
        if (st.seg === 'e') {
          bytes.forEach((b, i) => {
            if (st.addr + i < eeprom.length) eeprom[st.addr + i] = b;
            else throw new AsmError('EEPROM data beyond 1024 bytes');
          });
        } else {
          if (bytes.length & 1) {
            bytes.push(0);
            warn(st.line, 'Odd number of bytes in .db: a zero byte was added to fill the word');
          }
          const words: number[] = [];
          for (let i = 0; i < bytes.length; i += 2) words.push(bytes[i] | (bytes[i + 1] << 8));
          emit(st.addr, words, st.line, true);
        }
      } else {
        emit(st.addr, encode(st.name, st.ops, st.addr), st.line);
      }
    } catch (e) {
      if (e instanceof AsmError) err(st.line, e.message);
      else throw e;
    }
  }

  function encode(name: string, ops: string[], pc: number): number[] {
    const need = (n: number) => {
      if (ops.length !== n) {
        throw new AsmError(`'${name}' takes ${n === 0 ? 'no' : n} operand${n === 1 ? '' : 's'}, got ${ops.length}`);
      }
    };
    /** Register, also accepting the "r25:r24" pair form (returns the low register). */
    const regPair = (s: string) => {
      const m = /^(\w+)\s*:\s*(\w+)$/.exec(s.trim());
      if (m) {
        const hi = parseReg(m[1]), lo = parseReg(m[2]);
        if (hi !== lo + 1) throw new AsmError(`'${s}' is not a register pair`);
        return lo;
      }
      return parseReg(s);
    };
    const hiReg = (s: string) => {
      const r = parseReg(s);
      if (r < 16) throw new AsmError(`'${name}' needs a register r16-r31, got r${r}`);
      return r;
    };
    const imm8 = (s: string) => range(ev(s), -128, 255, 'Constant') & 0xff;
    const bit = (s: string) => range(ev(s), 0, 7, 'Bit number');
    const rel = (s: string, bits: number) => {
      const target = ev(s);
      const k = target - (pc + 1);
      const lim = 1 << (bits - 1);
      if (k < -lim || k >= lim) {
        throw new AsmError(`Branch target is too far away (${k} words; '${name}' reaches ${-lim}..${lim - 1})`);
      }
      return k & ((1 << bits) - 1);
    };
    const twoReg = (base: number, d: number, r: number) =>
      base | ((r & 0x10) << 5) | ((d & 0x1f) << 4) | (r & 0x0f);
    const immOp = (base: number, d: number, k: number) => base | ((k & 0xf0) << 4) | ((d - 16) << 4) | (k & 0x0f);

    if (name in TWO_REG) {
      need(2);
      return [twoReg(TWO_REG[name], parseReg(ops[0]), parseReg(ops[1]))];
    }
    if (name in SAME_REG) {
      need(1);
      const d = parseReg(ops[0]);
      return [twoReg(SAME_REG[name], d, d)];
    }
    if (name in IMM) {
      need(2);
      return [immOp(IMM[name], hiReg(ops[0]), imm8(ops[1]))];
    }
    if (name in ONE_REG) {
      need(1);
      return [ONE_REG[name] | (parseReg(ops[0]) << 4)];
    }
    if (name in IMPLIED) {
      need(0);
      return [IMPLIED[name]];
    }
    if (name in BIT_REG) {
      need(2);
      return [BIT_REG[name] | (parseReg(ops[0]) << 4) | bit(ops[1])];
    }
    if (name in BIT_IO) {
      need(2);
      const a = ev(ops[0]);
      if (a < 0 || a > 31) {
        throw new AsmError(`'${name}' can only reach I/O addresses 0-31 (got 0x${a.toString(16)}). Use in/out or lds/sts instead.`);
      }
      return [BIT_IO[name] | (a << 3) | bit(ops[1])];
    }
    if (name in MUL_LOW) {
      need(2);
      const d = parseReg(ops[0]), r = parseReg(ops[1]);
      if (d < 16 || d > 23 || r < 16 || r > 23) throw new AsmError(`'${name}' needs registers r16-r23`);
      return [MUL_LOW[name] | ((d - 16) << 4) | (r - 16)];
    }
    if (name in BR_SET || name in BR_CLR) {
      need(1);
      const s = name in BR_SET ? BR_SET[name] : BR_CLR[name];
      return [(name in BR_SET ? 0xf000 : 0xf400) | (rel(ops[0], 7) << 3) | s];
    }
    const flagOp = /^(se|cl)([cznvshti])$/.exec(name);
    if (flagOp) {
      need(0);
      const s = SREG_FLAGS.indexOf(flagOp[2]);
      return [(flagOp[1] === 'se' ? 0x9408 : 0x9488) | (s << 4)];
    }
    switch (name) {
      case 'sbr':
        need(2);
        return [immOp(0x6000, hiReg(ops[0]), imm8(ops[1]))];
      case 'cbr':
        need(2);
        return [immOp(0x7000, hiReg(ops[0]), ~imm8(ops[1]) & 0xff)];
      case 'ser':
        need(1);
        return [immOp(0xe000, hiReg(ops[0]), 0xff)];
      case 'adiw':
      case 'sbiw': {
        need(2);
        const d = regPair(ops[0]);
        if (![24, 26, 28, 30].includes(d)) throw new AsmError(`'${name}' only works on r24, r26 (X), r28 (Y), r30 (Z)`);
        const k = range(ev(ops[1]), 0, 63, 'Constant');
        return [(name === 'adiw' ? 0x9600 : 0x9700) | ((k & 0x30) << 2) | (((d - 24) >> 1) << 4) | (k & 0xf)];
      }
      case 'muls': {
        need(2);
        return [0x0200 | ((hiReg(ops[0]) - 16) << 4) | (hiReg(ops[1]) - 16)];
      }
      case 'movw': {
        need(2);
        const d = regPair(ops[0]), r = regPair(ops[1]);
        if (d & 1 || r & 1) throw new AsmError("'movw' needs even-numbered registers");
        return [0x0100 | ((d >> 1) << 4) | (r >> 1)];
      }
      case 'rjmp':
      case 'rcall':
        need(1);
        return [(name === 'rjmp' ? 0xc000 : 0xd000) | rel(ops[0], 12)];
      case 'jmp':
      case 'call': {
        need(1);
        const k = range(ev(ops[0]), 0, FLASH_WORDS - 1, 'Address');
        const base = name === 'jmp' ? 0x940c : 0x940e;
        return [base | ((k >> 16) & 1) | (((k >> 17) & 0x1f) << 4), k & 0xffff];
      }
      case 'brbs':
      case 'brbc': {
        need(2);
        const s = bit(ops[0]);
        return [(name === 'brbs' ? 0xf000 : 0xf400) | (rel(ops[1], 7) << 3) | s];
      }
      case 'bset':
      case 'bclr':
        need(1);
        return [(name === 'bset' ? 0x9408 : 0x9488) | (bit(ops[0]) << 4)];
      case 'in':
      case 'out': {
        need(2);
        const [rs, as] = name === 'in' ? [ops[0], ops[1]] : [ops[1], ops[0]];
        const r = parseReg(rs);
        const a = ev(as);
        if (a < 0 || a > 63) {
          throw new AsmError(
            `'${name}' can only reach I/O addresses 0-63 (got 0x${a.toString(16)}). ` +
              `This is a memory-mapped register; use ${name === 'in' ? 'lds' : 'sts'} instead.`,
          );
        }
        return [(name === 'in' ? 0xb000 : 0xb800) | ((a & 0x30) << 5) | (r << 4) | (a & 0xf)];
      }
      case 'lds': {
        need(2);
        return [0x9000 | (parseReg(ops[0]) << 4), range(ev(ops[1]), 0, 0xffff, 'Address')];
      }
      case 'sts': {
        need(2);
        return [0x9200 | (parseReg(ops[1]) << 4), range(ev(ops[0]), 0, 0xffff, 'Address')];
      }
      case 'ld':
      case 'st':
      case 'ldd':
      case 'std': {
        need(2);
        const isLoad = name[0] === 'l';
        const [rs, ps] = isLoad ? [ops[0], ops[1]] : [ops[1], ops[0]];
        const r = parseReg(rs);
        const p = ps.replace(/\s+/g, '');
        const store = isLoad ? 0 : 0x0200;
        const disp = /^([YZ])\+(.+)$/i.exec(p);
        if (disp && !/^[YZ]\+$/i.test(p)) {
          const q = range(ev(disp[2]), 0, 63, 'Displacement');
          const base = disp[1].toUpperCase() === 'Y' ? 8 : 0;
          return [0x8000 | store | ((q & 0x20) << 8) | ((q & 0x18) << 7) | (r << 4) | base | (q & 7)];
        }
        if (name === 'ldd' || name === 'std') throw new AsmError(`'${name}' needs Y+q or Z+q, got '${ps}'`);
        const modes: Record<string, number> = {
          'Z': 0x8000, 'Z+': 0x9001, '-Z': 0x9002, 'Y': 0x8008, 'Y+': 0x9009, '-Y': 0x900a,
          'X': 0x900c, 'X+': 0x900d, '-X': 0x900e,
        };
        const base = modes[p.toUpperCase()];
        if (base === undefined) throw new AsmError(`Expected X, X+, -X, Y, Y+, -Y, Z, Z+ or -Z, got '${ps}'`);
        return [base | store | (r << 4)];
      }
      case 'lpm': {
        if (ops.length === 0) return [0x95c8];
        need(2);
        const r = parseReg(ops[0]);
        const p = ops[1].replace(/\s+/g, '').toUpperCase();
        if (p === 'Z') return [0x9004 | (r << 4)];
        if (p === 'Z+') return [0x9005 | (r << 4)];
        throw new AsmError(`'lpm' needs Z or Z+, got '${ops[1]}'`);
      }
    }
    throw new AsmError(`Unknown instruction '${name}'`);
  }

  const symbols: SymbolInfo[] = [];
  for (const [name, s] of syms) {
    let value = s.value;
    if (value === undefined && s.kind === 'equ') {
      try {
        value = lookup(name);
      } catch {
        /* reported where it was used */
      }
    }
    if (value !== undefined) symbols.push({ name, value, kind: s.kind, line: s.line });
  }
  for (const [name, d] of defs) symbols.push({ name, value: d.reg, kind: 'def', line: d.line });

  messages.sort((a, b) => a.line - b.line);
  return {
    ok: !messages.some((m) => m.severity === 'error'),
    flash,
    eeprom,
    size,
    addrToLine,
    lineToAddr,
    listing,
    messages,
    symbols,
  };
}
