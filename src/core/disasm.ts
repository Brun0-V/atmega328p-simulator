import { DECODE_TABLE, ISA, isTwoWord } from './cpu';
import { M328P_REGS } from './m328pdef';

/** Register names by data-space address. */
const DATA_NAMES = new Map(M328P_REGS.map((r) => [r.addr, r.name]));
const ioName = (ioAddr: number) => DATA_NAMES.get(ioAddr + 0x20) ?? hex(ioAddr);
const dataName = (addr: number) => DATA_NAMES.get(addr) ?? hex(addr, 4);

const BRANCH_SET = ['brcs', 'breq', 'brmi', 'brvs', 'brlt', 'brhs', 'brts', 'brie'];
const BRANCH_CLR = ['brcc', 'brne', 'brpl', 'brvc', 'brge', 'brhc', 'brtc', 'brid'];
const FLAG_NAMES = ['c', 'z', 'n', 'v', 's', 'h', 't', 'i'];

const hex = (v: number, w = 2) => '0x' + v.toString(16).padStart(w, '0');

export interface Disasm {
  text: string;
  words: number;
  /** Branch/jump/call target as a word address, if any. */
  target?: number;
}

/** Disassemble the instruction at word address `pc`. */
export function disassemble(op: number, next: number, pc: number): Disasm {
  const idx = DECODE_TABLE[op];
  if (idx < 0) return { text: op === 0xffff ? '(erased)' : `.dw ${hex(op, 4)}`, words: 1 };
  const name = ISA[idx].name;
  const d5 = (op >> 4) & 0x1f;
  const r5 = ((op >> 5) & 0x10) | (op & 0xf);
  const d4 = 16 + ((op >> 4) & 0xf);
  const k8 = ((op >> 4) & 0xf0) | (op & 0xf);
  const b = op & 7;
  const R = (n: number) => `r${n}`;
  const rel = (k: number) => {
    const t = (pc + 1 + k) & 0x3fff;
    return { t, s: `.${k >= 0 ? '+' : ''}${k * 2}` };
  };
  const words = isTwoWord(op) ? 2 : 1;
  const ptrModes: Record<number, string> = {
    0x1: 'Z+', 0x2: '-Z', 0x9: 'Y+', 0xa: '-Y', 0xc: 'X', 0xd: 'X+', 0xe: '-X',
  };

  switch (name) {
    case 'nop': case 'ijmp': case 'icall': case 'ret': case 'reti': case 'sleep':
    case 'break': case 'wdr': case 'spm':
      return { text: name, words };
    case 'movw':
      return { text: `movw ${R(((op >> 4) & 0xf) * 2)}, ${R((op & 0xf) * 2)}`, words };
    case 'muls':
      return { text: `muls ${R(d4)}, ${R(16 + (op & 0xf))}`, words };
    case 'mulsu': case 'fmul': case 'fmuls': case 'fmulsu':
      return { text: `${name} ${R(16 + ((op >> 4) & 7))}, ${R(16 + (op & 7))}`, words };
    case 'cpc': case 'sbc': case 'add': case 'cpse': case 'cp': case 'sub': case 'adc':
    case 'and': case 'eor': case 'or': case 'mov': case 'mul': {
      if (d5 === r5) {
        const alias: Record<string, string> = { add: 'lsl', adc: 'rol', and: 'tst', eor: 'clr' };
        if (alias[name]) return { text: `${alias[name]} ${R(d5)}`, words };
      }
      return { text: `${name} ${R(d5)}, ${R(r5)}`, words };
    }
    case 'cpi': case 'sbci': case 'subi': case 'ori': case 'andi':
      return { text: `${name} ${R(d4)}, ${hex(k8)}`, words };
    case 'ldi':
      return { text: `ldi ${R(d4)}, ${hex(k8)}`, words };
    case 'ldd': case 'std': {
      const q = ((op >> 8) & 0x20) | ((op >> 7) & 0x18) | (op & 7);
      const p = op & 8 ? 'Y' : 'Z';
      const loc = q ? `${p}+${q}` : p;
      const isLd = name === 'ldd';
      const mn = q ? name : isLd ? 'ld' : 'st';
      return { text: isLd ? `${mn} ${R(d5)}, ${loc}` : `${mn} ${loc}, ${R(d5)}`, words };
    }
    case 'lds':
      return { text: `lds ${R(d5)}, ${dataName(next)}`, words };
    case 'sts':
      return { text: `sts ${dataName(next)}, ${R(d5)}`, words };
    case 'ld':
      return { text: `ld ${R(d5)}, ${ptrModes[op & 0xf]}`, words };
    case 'st':
      return { text: `st ${ptrModes[op & 0xf]}, ${R(d5)}`, words };
    case 'lpm':
      if (op === 0x95c8) return { text: 'lpm', words };
      return { text: `lpm ${R(d5)}, Z${op & 1 ? '+' : ''}`, words };
    case 'pop': case 'push': case 'com': case 'neg': case 'swap': case 'inc': case 'asr':
    case 'lsr': case 'ror': case 'dec':
      return { text: `${name} ${R(d5)}`, words };
    case 'bset': case 'bclr': {
      const s = (op >> 4) & 7;
      return { text: `${name === 'bset' ? 'se' : 'cl'}${FLAG_NAMES[s]}`, words };
    }
    case 'jmp': case 'call': {
      const k = ((((op >> 3) & 0x3e) | (op & 1)) << 16) | next;
      return { text: `${name} ${hex(k * 2, 4)}`, words, target: k };
    }
    case 'adiw': case 'sbiw': {
      const d = 24 + ((op >> 3) & 6);
      const k = ((op >> 2) & 0x30) | (op & 0xf);
      return { text: `${name} ${R(d)}, ${hex(k)}`, words };
    }
    case 'cbi': case 'sbic': case 'sbi': case 'sbis':
      return { text: `${name} ${ioName((op >> 3) & 0x1f)}, ${b}`, words };
    case 'in':
      return { text: `in ${R(d5)}, ${ioName(((op >> 5) & 0x30) | (op & 0xf))}`, words };
    case 'out':
      return { text: `out ${ioName(((op >> 5) & 0x30) | (op & 0xf))}, ${R(d5)}`, words };
    case 'rjmp': case 'rcall': {
      let k = op & 0xfff;
      if (k & 0x800) k -= 0x1000;
      const { t, s } = rel(k);
      return { text: `${name} ${s}`, words, target: t };
    }
    case 'brbs': case 'brbc': {
      let k = (op >> 3) & 0x7f;
      if (k & 0x40) k -= 0x80;
      const { t, s } = rel(k);
      return { text: `${(name === 'brbs' ? BRANCH_SET : BRANCH_CLR)[b]} ${s}`, words, target: t };
    }
    case 'bld': case 'bst': case 'sbrc': case 'sbrs':
      return { text: `${name} ${R(d5)}, ${b}`, words };
  }
  return { text: name, words };
}
