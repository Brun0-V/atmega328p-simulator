// AVR CPU core for the ATmega328P (AVRe+ core: 16K words flash, 2K SRAM).
// Data space layout: 0x00-0x1F registers, 0x20-0x5F I/O, 0x60-0xFF extended I/O, 0x100-0x8FF SRAM.

export const FLASH_WORDS = 0x4000;
export const DATA_SIZE = 0x900;
export const RAMEND = 0x8ff;
export const SREG_ADDR = 0x5f;
export const SPL_ADDR = 0x5d;
export const SPH_ADDR = 0x5e;
export const SMCR_ADDR = 0x53;

// SREG bit numbers
export const C = 0, Z = 1, N = 2, V = 3, S = 4, H = 5, T = 6, I = 7;

/** Write hook: `mask` is the set of bits being written (0xFF normally, one bit for SBI/CBI). */
export type WriteHook = (value: number, mask: number) => void;
export type ReadHook = () => number;

export type Exec = (cpu: CPU, op: number) => number;

export interface IsaEntry {
  name: string;
  mask: number;
  match: number;
  exec: Exec;
}

export class CPU {
  readonly data = new Uint8Array(DATA_SIZE);
  readonly flash = new Uint16Array(FLASH_WORDS).fill(0xffff);
  readonly readHooks: (ReadHook | undefined)[] = new Array(0x100);
  readonly writeHooks: (WriteHook | undefined)[] = new Array(0x100);

  /** Program counter, in words. */
  pc = 0;
  cycles = 0;
  sleeping = false;
  /** Set by SEI/RETI: one more instruction runs before an interrupt is taken. */
  intInhibit = false;
  /** Set when BREAK executes or an illegal opcode is hit. */
  halted: string | null = null;
  breakHit = false;
  /** Kind of the last control instruction executed (for step over/out). */
  lastFlow: 'call' | 'ret' | null = null;

  reset(): void {
    this.data.fill(0);
    this.pc = 0;
    this.cycles = 0;
    this.sleeping = false;
    this.intInhibit = false;
    this.halted = null;
    this.breakHit = false;
    this.lastFlow = null;
    this.sp = RAMEND;
  }

  get sreg(): number {
    return this.data[SREG_ADDR];
  }
  set sreg(v: number) {
    this.data[SREG_ADDR] = v;
  }
  get sp(): number {
    return this.data[SPL_ADDR] | (this.data[SPH_ADDR] << 8);
  }
  set sp(v: number) {
    this.data[SPL_ADDR] = v & 0xff;
    this.data[SPH_ADDR] = (v >> 8) & 0xff;
  }

  readData(addr: number): number {
    if (addr < 0x100) {
      const h = this.readHooks[addr];
      if (h) return h();
    }
    return addr < DATA_SIZE ? this.data[addr] : 0;
  }

  writeData(addr: number, value: number, mask = 0xff): void {
    if (addr < 0x100) {
      const h = this.writeHooks[addr];
      if (h) {
        h(value & 0xff, mask);
        return;
      }
    }
    if (addr < DATA_SIZE) this.data[addr] = (this.data[addr] & ~mask) | (value & mask);
  }

  push(v: number): void {
    const sp = this.sp;
    this.writeData(sp, v);
    this.sp = (sp - 1) & 0xffff;
  }
  pop(): number {
    const sp = (this.sp + 1) & 0xffff;
    this.sp = sp;
    return this.readData(sp);
  }
  pushPC(pc: number): void {
    this.push(pc & 0xff);
    this.push((pc >> 8) & 0xff);
  }
  popPC(): number {
    const hi = this.pop();
    const lo = this.pop();
    return ((hi << 8) | lo) & (FLASH_WORDS - 1);
  }

  /** Execute one instruction. Returns the number of cycles used. */
  step(): number {
    const op = this.flash[this.pc];
    this.lastFlow = null;
    const cycles = EXEC_TABLE[op](this, op);
    this.cycles += cycles;
    return cycles;
  }

  /** Jump to an interrupt vector (word address). Returns cycles used. */
  interrupt(vectorAddr: number): number {
    this.pushPC(this.pc);
    this.sreg &= ~(1 << I);
    this.pc = vectorAddr;
    const cycles = this.sleeping ? 8 : 4;
    this.sleeping = false;
    this.cycles += cycles;
    return cycles;
  }
}

// ---------------------------------------------------------------------------
// Operand helpers

const rd5 = (op: number) => (op >> 4) & 0x1f;
const rr5 = (op: number) => ((op >> 5) & 0x10) | (op & 0x0f);
const rd4 = (op: number) => 16 + ((op >> 4) & 0x0f);
const k8 = (op: number) => ((op >> 4) & 0xf0) | (op & 0x0f);
const ioA6 = (op: number) => ((op >> 5) & 0x30) | (op & 0x0f);
const ioA5 = (op: number) => (op >> 3) & 0x1f;
const bit3 = (op: number) => op & 7;
const q6 = (op: number) => ((op >> 8) & 0x20) | ((op >> 7) & 0x18) | (op & 7);

/** Is this opcode the first word of a two-word instruction? */
export function isTwoWord(op: number): boolean {
  return (op & 0xfe0c) === 0x940c || (op & 0xfc0f) === 0x9000;
}

function nextPC(cpu: CPU): number {
  return (cpu.pc + 1) & (FLASH_WORDS - 1);
}

function skip(cpu: CPU, cond: boolean): number {
  if (!cond) {
    cpu.pc = nextPC(cpu);
    return 1;
  }
  const next = cpu.flash[(cpu.pc + 1) & (FLASH_WORDS - 1)];
  if (isTwoWord(next)) {
    cpu.pc = (cpu.pc + 3) & (FLASH_WORDS - 1);
    return 3;
  }
  cpu.pc = (cpu.pc + 2) & (FLASH_WORDS - 1);
  return 2;
}

// Flag helpers. Each returns the new SREG with the affected bits replaced.
const KEEP_ITHC = (1 << I) | (1 << T) | (1 << H) | (1 << C);

function flagsAdd(sreg: number, a: number, b: number, carry: number): [number, number] {
  const sum = a + b + carry;
  const r = sum & 0xff;
  const c = sum >> 8;
  const h = (((a & 0xf) + (b & 0xf) + carry) >> 4) & 1;
  const v = (~(a ^ b) & (a ^ r) & 0x80) >> 7;
  const n = r >> 7;
  sreg &= (1 << I) | (1 << T);
  sreg |= c | ((r === 0 ? 1 : 0) << Z) | (n << N) | (v << V) | ((n ^ v) << S) | (h << H);
  return [r, sreg];
}

/** Subtraction flags. If `keepZ` the Z flag is only cleared, never set (SBC/SBCI/CPC). */
function flagsSub(sreg: number, a: number, b: number, carry: number, keepZ: boolean): [number, number] {
  const diff = a - b - carry;
  const r = diff & 0xff;
  const c = diff < 0 ? 1 : 0;
  const h = (a & 0xf) - (b & 0xf) - carry < 0 ? 1 : 0;
  const v = ((a ^ b) & (a ^ r) & 0x80) >> 7;
  const n = r >> 7;
  let z = r === 0 ? 1 : 0;
  if (keepZ) z &= (sreg >> Z) & 1;
  sreg &= (1 << I) | (1 << T);
  sreg |= c | (z << Z) | (n << N) | (v << V) | ((n ^ v) << S) | (h << H);
  return [r, sreg];
}

/** Flags for logic ops: V=0, N, Z, S=N. */
function flagsLogic(sreg: number, r: number): number {
  const n = r >> 7;
  sreg &= KEEP_ITHC;
  return sreg | ((r === 0 ? 1 : 0) << Z) | (n << N) | (n << S);
}

/** Flags for shifts/rotates: C from shifted-out bit, V=N^C, S=N^V. */
function flagsShift(sreg: number, r: number, c: number): number {
  const n = r >> 7;
  const v = n ^ c;
  sreg &= (1 << I) | (1 << T) | (1 << H);
  return sreg | c | ((r === 0 ? 1 : 0) << Z) | (n << N) | (v << V) | ((n ^ v) << S);
}

function mulResult(cpu: CPU, product: number, fractional: boolean): number {
  product &= 0xffff;
  let c = product >> 15;
  let r = product;
  if (fractional) r = (product << 1) & 0xffff;
  else c = r >> 15;
  cpu.data[0] = r & 0xff;
  cpu.data[1] = r >> 8;
  cpu.sreg = (cpu.sreg & ~((1 << C) | (1 << Z))) | c | ((r === 0 ? 1 : 0) << Z);
  cpu.pc = nextPC(cpu);
  return 2;
}

function ptr(cpu: CPU, lo: number): number {
  return cpu.data[lo] | (cpu.data[lo + 1] << 8);
}
function setPtr(cpu: CPU, lo: number, v: number): void {
  cpu.data[lo] = v & 0xff;
  cpu.data[lo + 1] = (v >> 8) & 0xff;
}

const X = 26, Y = 28, Zp = 30;

/** LD/ST through a pointer. mode: 0 plain, 1 post-increment, 2 pre-decrement. */
function ldPtr(cpu: CPU, op: number, p: number, mode: number): number {
  let a = ptr(cpu, p);
  if (mode === 2) a = (a - 1) & 0xffff;
  cpu.data[rd5(op)] = cpu.readData(a);
  if (mode === 1) a = (a + 1) & 0xffff;
  if (mode) setPtr(cpu, p, a);
  cpu.pc = nextPC(cpu);
  return 2;
}
function stPtr(cpu: CPU, op: number, p: number, mode: number): number {
  let a = ptr(cpu, p);
  if (mode === 2) a = (a - 1) & 0xffff;
  // Read the source before the pointer is updated (matters for st X+, r26).
  const v = cpu.data[rd5(op)];
  cpu.writeData(a, v);
  if (mode === 1) a = (a + 1) & 0xffff;
  if (mode) setPtr(cpu, p, a);
  cpu.pc = nextPC(cpu);
  return 2;
}

function lpm(cpu: CPU, rd: number, postInc: boolean): number {
  const z = ptr(cpu, Zp);
  const w = cpu.flash[(z >> 1) & (FLASH_WORDS - 1)];
  cpu.data[rd] = z & 1 ? w >> 8 : w & 0xff;
  if (postInc) setPtr(cpu, Zp, z + 1);
  cpu.pc = nextPC(cpu);
  return 3;
}

function branch(cpu: CPU, op: number, cond: boolean): number {
  if (cond) {
    let k = (op >> 3) & 0x7f;
    if (k & 0x40) k -= 0x80;
    cpu.pc = (cpu.pc + 1 + k) & (FLASH_WORDS - 1);
    return 2;
  }
  cpu.pc = nextPC(cpu);
  return 1;
}

// Generic 2-register ALU op builder.
function alu2(fn: (cpu: CPU, a: number, b: number) => number | null): Exec {
  return (cpu, op) => {
    const d = rd5(op);
    const r = fn(cpu, cpu.data[d], cpu.data[rr5(op)]);
    if (r !== null) cpu.data[d] = r;
    cpu.pc = nextPC(cpu);
    return 1;
  };
}
// Immediate ALU op builder (Rd = r16..r31).
function aluI(fn: (cpu: CPU, a: number, k: number) => number | null): Exec {
  return (cpu, op) => {
    const d = rd4(op);
    const r = fn(cpu, cpu.data[d], k8(op));
    if (r !== null) cpu.data[d] = r;
    cpu.pc = nextPC(cpu);
    return 1;
  };
}
// Single register op builder.
function alu1(fn: (cpu: CPU, a: number) => number): Exec {
  return (cpu, op) => {
    const d = rd5(op);
    cpu.data[d] = fn(cpu, cpu.data[d]);
    cpu.pc = nextPC(cpu);
    return 1;
  };
}

function add(cpu: CPU, a: number, b: number, c: number): number {
  const [r, s] = flagsAdd(cpu.sreg, a, b, c);
  cpu.sreg = s;
  return r;
}
function sub(cpu: CPU, a: number, b: number, c: number, keepZ: boolean): number {
  const [r, s] = flagsSub(cpu.sreg, a, b, c, keepZ);
  cpu.sreg = s;
  return r;
}
const carry = (cpu: CPU) => cpu.sreg & 1;

const signed8 = (v: number) => (v & 0x80 ? v - 0x100 : v);

// ---------------------------------------------------------------------------
// Instruction table. Order matters: the first matching entry wins.

export const ISA: IsaEntry[] = [
  { name: 'nop', mask: 0xffff, match: 0x0000, exec: (cpu) => { cpu.pc = nextPC(cpu); return 1; } },
  {
    name: 'movw', mask: 0xff00, match: 0x0100,
    exec: (cpu, op) => {
      const d = ((op >> 4) & 0xf) * 2, r = (op & 0xf) * 2;
      cpu.data[d] = cpu.data[r];
      cpu.data[d + 1] = cpu.data[r + 1];
      cpu.pc = nextPC(cpu);
      return 1;
    },
  },
  {
    name: 'muls', mask: 0xff00, match: 0x0200,
    exec: (cpu, op) => mulResult(cpu, signed8(cpu.data[rd4(op)]) * signed8(cpu.data[16 + (op & 0xf)]), false),
  },
  {
    name: 'mulsu', mask: 0xff88, match: 0x0300,
    exec: (cpu, op) => mulResult(cpu, signed8(cpu.data[16 + ((op >> 4) & 7)]) * cpu.data[16 + (op & 7)], false),
  },
  {
    name: 'fmul', mask: 0xff88, match: 0x0308,
    exec: (cpu, op) => mulResult(cpu, cpu.data[16 + ((op >> 4) & 7)] * cpu.data[16 + (op & 7)], true),
  },
  {
    name: 'fmuls', mask: 0xff88, match: 0x0380,
    exec: (cpu, op) => mulResult(cpu, signed8(cpu.data[16 + ((op >> 4) & 7)]) * signed8(cpu.data[16 + (op & 7)]), true),
  },
  {
    name: 'fmulsu', mask: 0xff88, match: 0x0388,
    exec: (cpu, op) => mulResult(cpu, signed8(cpu.data[16 + ((op >> 4) & 7)]) * cpu.data[16 + (op & 7)], true),
  },
  { name: 'cpc', mask: 0xfc00, match: 0x0400, exec: alu2((cpu, a, b) => (sub(cpu, a, b, carry(cpu), true), null)) },
  { name: 'sbc', mask: 0xfc00, match: 0x0800, exec: alu2((cpu, a, b) => sub(cpu, a, b, carry(cpu), true)) },
  { name: 'add', mask: 0xfc00, match: 0x0c00, exec: alu2((cpu, a, b) => add(cpu, a, b, 0)) },
  { name: 'cpse', mask: 0xfc00, match: 0x1000, exec: (cpu, op) => skip(cpu, cpu.data[rd5(op)] === cpu.data[rr5(op)]) },
  { name: 'cp', mask: 0xfc00, match: 0x1400, exec: alu2((cpu, a, b) => (sub(cpu, a, b, 0, false), null)) },
  { name: 'sub', mask: 0xfc00, match: 0x1800, exec: alu2((cpu, a, b) => sub(cpu, a, b, 0, false)) },
  { name: 'adc', mask: 0xfc00, match: 0x1c00, exec: alu2((cpu, a, b) => add(cpu, a, b, carry(cpu))) },
  { name: 'and', mask: 0xfc00, match: 0x2000, exec: alu2((cpu, a, b) => { const r = a & b; cpu.sreg = flagsLogic(cpu.sreg, r); return r; }) },
  { name: 'eor', mask: 0xfc00, match: 0x2400, exec: alu2((cpu, a, b) => { const r = a ^ b; cpu.sreg = flagsLogic(cpu.sreg, r); return r; }) },
  { name: 'or', mask: 0xfc00, match: 0x2800, exec: alu2((cpu, a, b) => { const r = a | b; cpu.sreg = flagsLogic(cpu.sreg, r); return r; }) },
  { name: 'mov', mask: 0xfc00, match: 0x2c00, exec: alu2((_cpu, _a, b) => b) },
  { name: 'cpi', mask: 0xf000, match: 0x3000, exec: aluI((cpu, a, k) => (sub(cpu, a, k, 0, false), null)) },
  { name: 'sbci', mask: 0xf000, match: 0x4000, exec: aluI((cpu, a, k) => sub(cpu, a, k, carry(cpu), true)) },
  { name: 'subi', mask: 0xf000, match: 0x5000, exec: aluI((cpu, a, k) => sub(cpu, a, k, 0, false)) },
  { name: 'ori', mask: 0xf000, match: 0x6000, exec: aluI((cpu, a, k) => { const r = a | k; cpu.sreg = flagsLogic(cpu.sreg, r); return r; }) },
  { name: 'andi', mask: 0xf000, match: 0x7000, exec: aluI((cpu, a, k) => { const r = a & k; cpu.sreg = flagsLogic(cpu.sreg, r); return r; }) },
  {
    name: 'ldd', mask: 0xd200, match: 0x8000,
    exec: (cpu, op) => {
      const base = op & 8 ? Y : Zp;
      cpu.data[rd5(op)] = cpu.readData((ptr(cpu, base) + q6(op)) & 0xffff);
      cpu.pc = nextPC(cpu);
      return 2;
    },
  },
  {
    name: 'std', mask: 0xd200, match: 0x8200,
    exec: (cpu, op) => {
      const base = op & 8 ? Y : Zp;
      cpu.writeData((ptr(cpu, base) + q6(op)) & 0xffff, cpu.data[rd5(op)]);
      cpu.pc = nextPC(cpu);
      return 2;
    },
  },
  {
    name: 'lds', mask: 0xfe0f, match: 0x9000,
    exec: (cpu, op) => {
      const k = cpu.flash[(cpu.pc + 1) & (FLASH_WORDS - 1)];
      cpu.data[rd5(op)] = cpu.readData(k);
      cpu.pc = (cpu.pc + 2) & (FLASH_WORDS - 1);
      return 2;
    },
  },
  { name: 'ld', mask: 0xfe0f, match: 0x9001, exec: (cpu, op) => ldPtr(cpu, op, Zp, 1) },
  { name: 'ld', mask: 0xfe0f, match: 0x9002, exec: (cpu, op) => ldPtr(cpu, op, Zp, 2) },
  { name: 'lpm', mask: 0xfe0f, match: 0x9004, exec: (cpu, op) => lpm(cpu, rd5(op), false) },
  { name: 'lpm', mask: 0xfe0f, match: 0x9005, exec: (cpu, op) => lpm(cpu, rd5(op), true) },
  { name: 'ld', mask: 0xfe0f, match: 0x9009, exec: (cpu, op) => ldPtr(cpu, op, Y, 1) },
  { name: 'ld', mask: 0xfe0f, match: 0x900a, exec: (cpu, op) => ldPtr(cpu, op, Y, 2) },
  { name: 'ld', mask: 0xfe0f, match: 0x900c, exec: (cpu, op) => ldPtr(cpu, op, X, 0) },
  { name: 'ld', mask: 0xfe0f, match: 0x900d, exec: (cpu, op) => ldPtr(cpu, op, X, 1) },
  { name: 'ld', mask: 0xfe0f, match: 0x900e, exec: (cpu, op) => ldPtr(cpu, op, X, 2) },
  {
    name: 'pop', mask: 0xfe0f, match: 0x900f,
    exec: (cpu, op) => { cpu.data[rd5(op)] = cpu.pop(); cpu.pc = nextPC(cpu); return 2; },
  },
  {
    name: 'sts', mask: 0xfe0f, match: 0x9200,
    exec: (cpu, op) => {
      const k = cpu.flash[(cpu.pc + 1) & (FLASH_WORDS - 1)];
      cpu.writeData(k, cpu.data[rd5(op)]);
      cpu.pc = (cpu.pc + 2) & (FLASH_WORDS - 1);
      return 2;
    },
  },
  { name: 'st', mask: 0xfe0f, match: 0x9201, exec: (cpu, op) => stPtr(cpu, op, Zp, 1) },
  { name: 'st', mask: 0xfe0f, match: 0x9202, exec: (cpu, op) => stPtr(cpu, op, Zp, 2) },
  { name: 'st', mask: 0xfe0f, match: 0x9209, exec: (cpu, op) => stPtr(cpu, op, Y, 1) },
  { name: 'st', mask: 0xfe0f, match: 0x920a, exec: (cpu, op) => stPtr(cpu, op, Y, 2) },
  { name: 'st', mask: 0xfe0f, match: 0x920c, exec: (cpu, op) => stPtr(cpu, op, X, 0) },
  { name: 'st', mask: 0xfe0f, match: 0x920d, exec: (cpu, op) => stPtr(cpu, op, X, 1) },
  { name: 'st', mask: 0xfe0f, match: 0x920e, exec: (cpu, op) => stPtr(cpu, op, X, 2) },
  {
    name: 'push', mask: 0xfe0f, match: 0x920f,
    exec: (cpu, op) => { cpu.push(cpu.data[rd5(op)]); cpu.pc = nextPC(cpu); return 2; },
  },
  {
    name: 'com', mask: 0xfe0f, match: 0x9400,
    exec: alu1((cpu, a) => {
      const r = ~a & 0xff;
      cpu.sreg = flagsLogic(cpu.sreg & ~1, r) | 1;
      return r;
    }),
  },
  {
    name: 'neg', mask: 0xfe0f, match: 0x9401,
    exec: alu1((cpu, a) => sub(cpu, 0, a, 0, false)),
  },
  { name: 'swap', mask: 0xfe0f, match: 0x9402, exec: alu1((_cpu, a) => ((a << 4) | (a >> 4)) & 0xff) },
  {
    name: 'inc', mask: 0xfe0f, match: 0x9403,
    exec: alu1((cpu, a) => {
      const r = (a + 1) & 0xff;
      const n = r >> 7, v = r === 0x80 ? 1 : 0;
      cpu.sreg = (cpu.sreg & ((1 << I) | (1 << T) | (1 << H) | (1 << C))) |
        ((r === 0 ? 1 : 0) << Z) | (n << N) | (v << V) | ((n ^ v) << S);
      return r;
    }),
  },
  { name: 'asr', mask: 0xfe0f, match: 0x9405, exec: alu1((cpu, a) => { const r = (a >> 1) | (a & 0x80); cpu.sreg = flagsShift(cpu.sreg, r, a & 1); return r; }) },
  { name: 'lsr', mask: 0xfe0f, match: 0x9406, exec: alu1((cpu, a) => { const r = a >> 1; cpu.sreg = flagsShift(cpu.sreg, r, a & 1); return r; }) },
  { name: 'ror', mask: 0xfe0f, match: 0x9407, exec: alu1((cpu, a) => { const r = (a >> 1) | (carry(cpu) << 7); cpu.sreg = flagsShift(cpu.sreg, r, a & 1); return r; }) },
  {
    name: 'dec', mask: 0xfe0f, match: 0x940a,
    exec: alu1((cpu, a) => {
      const r = (a - 1) & 0xff;
      const n = r >> 7, v = r === 0x7f ? 1 : 0;
      cpu.sreg = (cpu.sreg & ((1 << I) | (1 << T) | (1 << H) | (1 << C))) |
        ((r === 0 ? 1 : 0) << Z) | (n << N) | (v << V) | ((n ^ v) << S);
      return r;
    }),
  },
  {
    name: 'bset', mask: 0xff8f, match: 0x9408,
    exec: (cpu, op) => {
      const s = (op >> 4) & 7;
      if (s === I && !(cpu.sreg & (1 << I))) cpu.intInhibit = true;
      cpu.sreg |= 1 << s;
      cpu.pc = nextPC(cpu);
      return 1;
    },
  },
  {
    name: 'bclr', mask: 0xff8f, match: 0x9488,
    exec: (cpu, op) => { cpu.sreg &= ~(1 << ((op >> 4) & 7)); cpu.pc = nextPC(cpu); return 1; },
  },
  { name: 'ijmp', mask: 0xffff, match: 0x9409, exec: (cpu) => { cpu.pc = ptr(cpu, Zp) & (FLASH_WORDS - 1); return 2; } },
  {
    name: 'icall', mask: 0xffff, match: 0x9509,
    exec: (cpu) => {
      cpu.pushPC(cpu.pc + 1);
      cpu.pc = ptr(cpu, Zp) & (FLASH_WORDS - 1);
      cpu.lastFlow = 'call';
      return 3;
    },
  },
  { name: 'ret', mask: 0xffff, match: 0x9508, exec: (cpu) => { cpu.pc = cpu.popPC(); cpu.lastFlow = 'ret'; return 4; } },
  {
    name: 'reti', mask: 0xffff, match: 0x9518,
    exec: (cpu) => {
      cpu.pc = cpu.popPC();
      cpu.sreg |= 1 << I;
      cpu.intInhibit = true;
      cpu.lastFlow = 'ret';
      return 4;
    },
  },
  {
    name: 'sleep', mask: 0xffff, match: 0x9588,
    exec: (cpu) => {
      if (cpu.data[SMCR_ADDR] & 1) cpu.sleeping = true;
      cpu.pc = nextPC(cpu);
      return 1;
    },
  },
  { name: 'break', mask: 0xffff, match: 0x9598, exec: (cpu) => { cpu.breakHit = true; cpu.pc = nextPC(cpu); return 1; } },
  { name: 'wdr', mask: 0xffff, match: 0x95a8, exec: (cpu) => { cpu.pc = nextPC(cpu); return 1; } },
  { name: 'lpm', mask: 0xffff, match: 0x95c8, exec: (cpu) => lpm(cpu, 0, false) },
  // Self-programming is not simulated; SPM behaves like a NOP.
  { name: 'spm', mask: 0xffff, match: 0x95e8, exec: (cpu) => { cpu.pc = nextPC(cpu); return 1; } },
  {
    name: 'jmp', mask: 0xfe0e, match: 0x940c,
    exec: (cpu, op) => {
      const k = (((op >> 3) & 0x3e) | (op & 1)) << 16 | cpu.flash[(cpu.pc + 1) & (FLASH_WORDS - 1)];
      cpu.pc = k & (FLASH_WORDS - 1);
      return 3;
    },
  },
  {
    name: 'call', mask: 0xfe0e, match: 0x940e,
    exec: (cpu, op) => {
      const k = (((op >> 3) & 0x3e) | (op & 1)) << 16 | cpu.flash[(cpu.pc + 1) & (FLASH_WORDS - 1)];
      cpu.pushPC(cpu.pc + 2);
      cpu.pc = k & (FLASH_WORDS - 1);
      cpu.lastFlow = 'call';
      return 4;
    },
  },
  {
    name: 'adiw', mask: 0xff00, match: 0x9600,
    exec: (cpu, op) => {
      const d = 24 + ((op >> 3) & 6);
      const k = ((op >> 2) & 0x30) | (op & 0xf);
      const w = ptr(cpu, d);
      const r = (w + k) & 0xffff;
      setPtr(cpu, d, r);
      const rdh7 = w >> 15, r15 = r >> 15;
      const v = ~rdh7 & r15 & 1, c = ~r15 & rdh7 & 1;
      cpu.sreg = (cpu.sreg & ((1 << I) | (1 << T) | (1 << H))) |
        c | ((r === 0 ? 1 : 0) << Z) | (r15 << N) | (v << V) | ((r15 ^ v) << S);
      cpu.pc = nextPC(cpu);
      return 2;
    },
  },
  {
    name: 'sbiw', mask: 0xff00, match: 0x9700,
    exec: (cpu, op) => {
      const d = 24 + ((op >> 3) & 6);
      const k = ((op >> 2) & 0x30) | (op & 0xf);
      const w = ptr(cpu, d);
      const r = (w - k) & 0xffff;
      setPtr(cpu, d, r);
      const rdh7 = w >> 15, r15 = r >> 15;
      const v = rdh7 & ~r15 & 1, c = r15 & ~rdh7 & 1;
      cpu.sreg = (cpu.sreg & ((1 << I) | (1 << T) | (1 << H))) |
        c | ((r === 0 ? 1 : 0) << Z) | (r15 << N) | (v << V) | ((r15 ^ v) << S);
      cpu.pc = nextPC(cpu);
      return 2;
    },
  },
  {
    name: 'cbi', mask: 0xff00, match: 0x9800,
    exec: (cpu, op) => { cpu.writeData(0x20 + ioA5(op), 0, 1 << bit3(op)); cpu.pc = nextPC(cpu); return 2; },
  },
  { name: 'sbic', mask: 0xff00, match: 0x9900, exec: (cpu, op) => skip(cpu, !(cpu.readData(0x20 + ioA5(op)) & (1 << bit3(op)))) },
  {
    name: 'sbi', mask: 0xff00, match: 0x9a00,
    exec: (cpu, op) => { cpu.writeData(0x20 + ioA5(op), 0xff, 1 << bit3(op)); cpu.pc = nextPC(cpu); return 2; },
  },
  { name: 'sbis', mask: 0xff00, match: 0x9b00, exec: (cpu, op) => skip(cpu, !!(cpu.readData(0x20 + ioA5(op)) & (1 << bit3(op)))) },
  {
    name: 'mul', mask: 0xfc00, match: 0x9c00,
    exec: (cpu, op) => mulResult(cpu, cpu.data[rd5(op)] * cpu.data[rr5(op)], false),
  },
  {
    name: 'in', mask: 0xf800, match: 0xb000,
    exec: (cpu, op) => { cpu.data[rd5(op)] = cpu.readData(0x20 + ioA6(op)); cpu.pc = nextPC(cpu); return 1; },
  },
  {
    name: 'out', mask: 0xf800, match: 0xb800,
    exec: (cpu, op) => { cpu.writeData(0x20 + ioA6(op), cpu.data[rd5(op)]); cpu.pc = nextPC(cpu); return 1; },
  },
  {
    name: 'rjmp', mask: 0xf000, match: 0xc000,
    exec: (cpu, op) => {
      let k = op & 0xfff;
      if (k & 0x800) k -= 0x1000;
      cpu.pc = (cpu.pc + 1 + k) & (FLASH_WORDS - 1);
      return 2;
    },
  },
  {
    name: 'rcall', mask: 0xf000, match: 0xd000,
    exec: (cpu, op) => {
      let k = op & 0xfff;
      if (k & 0x800) k -= 0x1000;
      cpu.pushPC(cpu.pc + 1);
      cpu.pc = (cpu.pc + 1 + k) & (FLASH_WORDS - 1);
      cpu.lastFlow = 'call';
      return 3;
    },
  },
  {
    name: 'ldi', mask: 0xf000, match: 0xe000,
    exec: (cpu, op) => { cpu.data[rd4(op)] = k8(op); cpu.pc = nextPC(cpu); return 1; },
  },
  { name: 'brbs', mask: 0xfc00, match: 0xf000, exec: (cpu, op) => branch(cpu, op, !!(cpu.sreg & (1 << bit3(op)))) },
  { name: 'brbc', mask: 0xfc00, match: 0xf400, exec: (cpu, op) => branch(cpu, op, !(cpu.sreg & (1 << bit3(op)))) },
  {
    name: 'bld', mask: 0xfe08, match: 0xf800,
    exec: (cpu, op) => {
      const d = rd5(op), b = 1 << bit3(op);
      cpu.data[d] = cpu.sreg & (1 << T) ? cpu.data[d] | b : cpu.data[d] & ~b;
      cpu.pc = nextPC(cpu);
      return 1;
    },
  },
  {
    name: 'bst', mask: 0xfe08, match: 0xfa00,
    exec: (cpu, op) => {
      const set = cpu.data[rd5(op)] & (1 << bit3(op));
      cpu.sreg = set ? cpu.sreg | (1 << T) : cpu.sreg & ~(1 << T);
      cpu.pc = nextPC(cpu);
      return 1;
    },
  },
  { name: 'sbrc', mask: 0xfe08, match: 0xfc00, exec: (cpu, op) => skip(cpu, !(cpu.data[rd5(op)] & (1 << bit3(op)))) },
  { name: 'sbrs', mask: 0xfe08, match: 0xfe00, exec: (cpu, op) => skip(cpu, !!(cpu.data[rd5(op)] & (1 << bit3(op)))) },
];

const illegal: Exec = (cpu, op) => {
  cpu.halted =
    op === 0xffff
      ? `Reached erased flash (0xFFFF) at word 0x${cpu.pc.toString(16).padStart(4, '0')}. Did the program run past its end?`
      : `Illegal opcode 0x${op.toString(16).padStart(4, '0')} at word 0x${cpu.pc.toString(16).padStart(4, '0')}`;
  return 0;
};

/** Index into ISA for every possible opcode, or -1 if undefined. */
export const DECODE_TABLE = new Int16Array(0x10000).fill(-1);
const EXEC_TABLE: Exec[] = new Array(0x10000);
for (let op = 0; op < 0x10000; op++) {
  const idx = ISA.findIndex((e) => (op & e.mask) === e.match);
  DECODE_TABLE[op] = idx;
  EXEC_TABLE[op] = idx >= 0 ? ISA[idx].exec : illegal;
}
