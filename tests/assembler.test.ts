import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assemble } from '../src/core/assembler';
import { disassemble } from '../src/core/disasm';

/** Parse an Intel HEX file into a map of byte address -> byte. */
function parseHex(text: string): Map<number, number> {
  const out = new Map<number, number>();
  let base = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(':')) continue;
    const b = line.slice(1).match(/../g)!.map((h) => parseInt(h, 16));
    const [len, hi, lo, type] = b;
    if (type === 0) for (let i = 0; i < len; i++) out.set(base + ((hi << 8) | lo) + i, b[4 + i]);
    else if (type === 2) base = ((b[4] << 8) | b[5]) << 4;
    else if (type === 4) base = ((b[4] << 8) | b[5]) << 16;
  }
  return out;
}

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('assembler matches AVRA', () => {
  it('assembles every instruction form identically to AVRA 1.4.2', () => {
    const res = assemble(fixture('all.asm'));
    expect(res.messages.filter((m) => m.severity === 'error')).toEqual([]);
    const ref = parseHex(fixture('all.hex'));
    const refWords = new Map<number, number>();
    for (const [addr, byte] of ref) {
      const w = addr >> 1;
      refWords.set(w, (refWords.get(w) ?? 0) | (byte << ((addr & 1) * 8)));
    }
    let checked = 0;
    for (const [w, v] of refWords) {
      const got = res.flash[w];
      if (got !== v) {
        const line = res.addrToLine[w];
        throw new Error(
          `word 0x${w.toString(16)} (line ${line}): got 0x${got.toString(16)} (${disassemble(got, res.flash[w + 1], w).text}), ` +
            `AVRA 0x${v.toString(16)} (${disassemble(v, refWords.get(w + 1) ?? 0, w).text})`,
        );
      }
      checked++;
    }
    expect(checked).toBe(res.addrToLine.filter((l) => l >= 0).length);
    // Every word we produced must also be in AVRA's output.
    for (let w = 0; w < res.flash.length; w++) if (res.addrToLine[w] >= 0) expect(refWords.has(w), `word 0x${w.toString(16)}`).toBe(true);
  });
});

describe('assembler errors', () => {
  const errors = (src: string) => assemble(src).messages.filter((m) => m.severity === 'error');
  it('reports unknown instructions with the line number', () => {
    expect(errors('nop\n  foo r1\n')).toEqual([{ line: 2, severity: 'error', message: "Unknown instruction or macro 'foo'" }]);
  });
  it('rejects ldi on low registers', () => {
    expect(errors('ldi r5, 1')[0].message).toMatch(/r16-r31/);
  });
  it('suggests sts for memory-mapped registers', () => {
    expect(errors('out TCCR1A, r16')[0].message).toMatch(/use sts/);
  });
  it('reports branches out of range', () => {
    const src = 'a: breq b\n.org 200\nb: nop';
    expect(errors(src)[0].message).toMatch(/too far/);
  });
  it('reports undefined symbols', () => {
    expect(errors('rjmp nowhere')[0].message).toBe("Undefined symbol 'nowhere'");
  });
  it('reports duplicate labels', () => {
    expect(errors('x: nop\nx: nop')[0].message).toMatch(/already defined/);
  });
  it('maps source lines to addresses', () => {
    const r = assemble('; comment\n  ldi r16, 1\n\n  lds r0, 0x100\nloop: rjmp loop\n');
    expect([...r.lineToAddr]).toEqual([[2, 0], [4, 1], [5, 3]]);
  });
});
