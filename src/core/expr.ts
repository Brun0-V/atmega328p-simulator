// Expression evaluator for AVRA-style assembler expressions.

export class AsmError extends Error {}
/** Thrown when an expression references a symbol that is not defined (yet). */
export class UndefinedSymbol extends AsmError {
  constructor(readonly symbol: string) {
    super(`Undefined symbol '${symbol}'`);
  }
}

type Tok =
  | { t: 'num'; v: number }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string };

const OPS = ['<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '+', '-', '*', '/', '%', '&', '|', '^', '~', '!', '(', ')', '<', '>', '?', ':', ','];

const ESCAPES: Record<string, number> = { n: 10, r: 13, t: 9, '0': 0, '\\': 92, "'": 39, '"': 34, a: 7, b: 8, f: 12, v: 11 };

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "'") {
      let v: number;
      if (src[i + 1] === '\\') {
        const e = src[i + 2];
        if (!(e in ESCAPES)) throw new AsmError(`Unknown escape '\\${e}'`);
        v = ESCAPES[e];
        i += 3;
      } else {
        v = src.charCodeAt(i + 1);
        i += 2;
      }
      if (src[i] !== "'") throw new AsmError('Unterminated character literal');
      i++;
      out.push({ t: 'num', v });
      continue;
    }
    let m = /^(0x[0-9a-f]+|\$[0-9a-f]+|0b[01]+|[0-9][0-9a-f]*h\b|[01]+b\b|\d+)/i.exec(src.slice(i));
    if (m && /[0-9$]/.test(ch)) {
      const s = m[0];
      let v: number;
      const lower = s.toLowerCase();
      if (lower.startsWith('0x')) v = parseInt(s.slice(2), 16);
      else if (s[0] === '$') v = parseInt(s.slice(1), 16);
      else if (lower.startsWith('0b')) v = parseInt(s.slice(2), 2);
      else if (lower.endsWith('h')) v = parseInt(s.slice(0, -1), 16);
      else if (lower.endsWith('b') && /^[01]+b$/i.test(s)) v = parseInt(s.slice(0, -1), 2);
      else v = parseInt(s, 10);
      out.push({ t: 'num', v });
      i += s.length;
      continue;
    }
    m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (m) {
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ t: 'op', v: op });
      i += op.length;
      continue;
    }
    throw new AsmError(`Unexpected character '${ch}' in expression`);
  }
  return out;
}

export type SymbolLookup = (name: string) => number | undefined;

const FUNCS: Record<string, (x: number) => number> = {
  low: (x) => x & 0xff,
  high: (x) => (x >> 8) & 0xff,
  byte1: (x) => x & 0xff,
  byte2: (x) => (x >> 8) & 0xff,
  byte3: (x) => (x >> 16) & 0xff,
  byte4: (x) => (x >>> 24) & 0xff,
  lwrd: (x) => x & 0xffff,
  hwrd: (x) => (x >>> 16) & 0xffff,
  page: (x) => (x >> 16) & 0x3f,
  exp2: (x) => 2 ** x,
  log2: (x) => (x > 0 ? Math.floor(Math.log2(x)) : 0),
  abs: (x) => Math.abs(x),
};

// Binary operator precedence (higher binds tighter), like C.
const BIN: Record<string, number> = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5,
  '==': 6, '!=': 6, '<': 7, '<=': 7, '>': 7, '>=': 7,
  '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10,
};

/** Evaluate an expression. `lookup` returns undefined for unknown symbols. */
export function evaluate(src: string, lookup: SymbolLookup): number {
  const toks = tokenize(src);
  if (toks.length === 0) throw new AsmError('Missing expression');
  let pos = 0;
  const peek = () => toks[pos];
  const isOp = (v: string) => peek()?.t === 'op' && peek().v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new AsmError(`Expected '${v}' in expression`);
    pos++;
  };

  const primary = (): number => {
    const t = toks[pos++];
    if (!t) throw new AsmError('Unexpected end of expression');
    if (t.t === 'num') return t.v;
    if (t.t === 'op') {
      if (t.v === '(') {
        const v = ternary();
        expect(')');
        return v;
      }
      if (t.v === '-') return -primary();
      if (t.v === '+') return primary();
      if (t.v === '~') return ~primary();
      if (t.v === '!') return primary() ? 0 : 1;
      throw new AsmError(`Unexpected '${t.v}' in expression`);
    }
    const name = t.v.toLowerCase();
    if (isOp('(')) {
      if (name === 'defined') {
        pos++;
        const id = toks[pos++];
        if (!id || id.t !== 'id') throw new AsmError('defined() needs a symbol name');
        expect(')');
        return lookup(id.v) !== undefined ? 1 : 0;
      }
      const fn = FUNCS[name];
      if (!fn) throw new AsmError(`Unknown function '${t.v}'`);
      pos++;
      const v = ternary();
      expect(')');
      return fn(v);
    }
    const v = lookup(t.v);
    if (v === undefined) throw new UndefinedSymbol(t.v);
    return v;
  };

  const binary = (minPrec: number): number => {
    let lhs = primary();
    for (;;) {
      const t = peek();
      if (!t || t.t !== 'op' || !(t.v in BIN) || BIN[t.v] < minPrec) return lhs;
      pos++;
      const rhs = binary(BIN[t.v] + 1);
      lhs = applyBin(t.v, lhs, rhs);
    }
  };

  const ternary = (): number => {
    const c = binary(1);
    if (!isOp('?')) return c;
    pos++;
    const a = ternary();
    expect(':');
    const b = ternary();
    return c ? a : b;
  };

  const v = ternary();
  if (pos < toks.length) throw new AsmError(`Unexpected '${(toks[pos] as { v: unknown }).v}' in expression`);
  return v;
}

function applyBin(op: string, a: number, b: number): number {
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': if (b === 0) throw new AsmError('Division by zero'); return Math.trunc(a / b);
    case '%': if (b === 0) throw new AsmError('Division by zero'); return a % b;
    case '<<': return a * 2 ** b;
    case '>>': return Math.floor(a / 2 ** b);
    case '&': return Number(BigInt.asIntN(64, BigInt(a) & BigInt(b)));
    case '|': return Number(BigInt.asIntN(64, BigInt(a) | BigInt(b)));
    case '^': return Number(BigInt.asIntN(64, BigInt(a) ^ BigInt(b)));
    case '<': return +(a < b);
    case '<=': return +(a <= b);
    case '>': return +(a > b);
    case '>=': return +(a >= b);
    case '==': return +(a === b);
    case '!=': return +(a !== b);
    case '&&': return +(!!a && !!b);
    case '||': return +(!!a || !!b);
  }
  throw new AsmError(`Unknown operator ${op}`);
}
