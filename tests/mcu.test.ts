import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assemble } from '../src/core/assembler';
import { ATmega328P, REG } from '../src/core/mcu';
import { EXAMPLES } from '../src/examples';

function boot(id: string) {
  const ex = EXAMPLES.find((e) => e.id === id)!;
  const res = assemble(ex.source);
  expect(res.messages.filter((m) => m.severity === 'error')).toEqual([]);
  const mcu = new ATmega328P();
  mcu.load(res.flash.subarray(0, res.size));
  return { mcu, res };
}

/** Run until `cond` or the cycle limit. */
function runUntil(mcu: ATmega328P, cond: () => boolean, limit: number) {
  const start = mcu.cpu.cycles;
  while (!cond() && mcu.cpu.cycles - start < limit) mcu.step();
  return mcu.cpu.cycles - start;
}

describe('examples assemble identically to AVRA', () => {
  const files: Record<string, string> = {
    blink: '01-blink', timer0: '02-timer0-interrupt', timer1: '03-timer1-ctc', pwm: '04-pwm-fade',
    usart: '05-usart-echo', button: '06-button-int0', arithmetic: '07-arithmetic',
  };
  for (const ex of EXAMPLES) {
    it(ex.id, () => {
      const hex = readFileSync(new URL(`./fixtures/examples/${files[ex.id]}.hex`, import.meta.url), 'utf8');
      const ref = new Map<number, number>();
      for (const line of hex.split(/\r?\n/)) {
        if (!line.startsWith(':')) continue;
        const b = line.slice(1).match(/../g)!.map((h) => parseInt(h, 16));
        if (b[3] !== 0) continue;
        for (let i = 0; i < b[0]; i++) ref.set(((b[1] << 8) | b[2]) + i, b[4 + i]);
      }
      const res = assemble(ex.source);
      for (const [addr, byte] of ref) {
        const w = res.flash[addr >> 1];
        expect((addr & 1 ? w >> 8 : w & 0xff), `byte 0x${addr.toString(16)}`).toBe(byte);
      }
      expect(res.addrToLine.filter((l) => l >= 0).length * 2).toBe(ref.size);
    });
  }
});

describe('example programs behave correctly', () => {
  it('arithmetic: computes the documented results', () => {
    const { mcu, res } = boot('arithmetic');
    const doneAddr = res.symbols.find((s) => s.name === 'done')!.value;
    runUntil(mcu, () => mcu.cpu.pc === doneAddr, 10000);
    const d = mcu.cpu.data;
    expect(d[24] | (d[25] << 8)).toBe(3000);
    expect(d[18]).toBe(1);
    expect(d[0]).toBe(120);
    expect(d[0x100]).toBe(120);
    expect(mcu.cpu.sp).toBe(0x8ff);
  });

  it('arithmetic: H flag is set by 0x0F + 0x01', () => {
    const { mcu } = boot('arithmetic');
    for (let i = 0; i < 7; i++) mcu.step(); // stack setup (4) + ldi, ldi, add
    expect(mcu.cpu.data[16]).toBe(0x10);
    expect(mcu.cpu.sreg & 0x20).toBe(0x20);
  });

  it('blink: toggles PB5 every ~0.25 s', () => {
    const { mcu } = boot('blink');
    const port = mcu.ports.B;
    runUntil(mcu, () => !!(port.level & 0x20), 1000);
    const start = mcu.cpu.cycles;
    runUntil(mcu, () => !(port.level & 0x20), 10_000_000);
    const period = mcu.cpu.cycles - start;
    expect(period).toBeGreaterThan(3_900_000);
    expect(period).toBeLessThan(4_100_000);
  });

  it('timer0: overflow interrupt toggles PB5 every 30 overflows', () => {
    const { mcu } = boot('timer0');
    const port = mcu.ports.B;
    runUntil(mcu, () => !!(port.level & 0x20), 10_000_000);
    const start = mcu.cpu.cycles;
    runUntil(mcu, () => !(port.level & 0x20), 10_000_000);
    const period = mcu.cpu.cycles - start;
    expect(Math.abs(period - 30 * 256 * 1024)).toBeLessThan(100);
    expect(mcu.interruptCounts.get(16)).toBe(60);
  });

  it('timer1: CTC toggles OC1A every (TICKS+1)*1024 cycles', () => {
    const { mcu } = boot('timer1');
    const port = mcu.ports.B;
    runUntil(mcu, () => !!(port.level & 0x02), 10_000_000);
    const t1 = mcu.cpu.cycles;
    runUntil(mcu, () => !(port.level & 0x02), 10_000_000);
    expect(Math.abs(mcu.cpu.cycles - t1 - 7813 * 1024)).toBeLessThan(8);
    // The pin toggles on the match; the ISR that counts it runs right after.
    runUntil(mcu, () => false, 20);
    expect(mcu.cpu.data[20]).toBe(2);
  });

  it('pwm: OC0A duty cycle follows OCR0A', () => {
    const { mcu } = boot('pwm');
    runUntil(mcu, () => mcu.cpu.data[REG.OCR0A] >= 64, 20_000_000);
    // Measure the high time over a couple of PWM periods (256 * 64 cycles each).
    const period = 256 * 64;
    const duty = mcu.timer0.ocrA;
    runUntil(mcu, () => mcu.timer0.count === 0, period * 2);
    const port = mcu.ports.D;
    let high = 0;
    const start = mcu.cpu.cycles;
    while (mcu.cpu.cycles - start < period) {
      const c = mcu.cpu.cycles;
      const lvl = port.level & 0x40;
      mcu.step();
      if (lvl) high += mcu.cpu.cycles - c;
    }
    expect(Math.abs(high / period - (duty + 1) / 256)).toBeLessThan(0.02);
  });

  it('usart: prints the message and echoes input', () => {
    const { mcu } = boot('usart');
    let out = '';
    mcu.usart.onTransmit = (b) => (out += String.fromCharCode(b));
    runUntil(mcu, () => out.endsWith('Type something: '), 20_000_000);
    expect(out).toBe('Hello from the ATmega328P!\r\nType something: ');
    // Each byte takes 10 bits * 16 * 104 cycles = 16640 cycles at 9600 baud.
    expect(mcu.usart.bitCycles).toBe(16 * 104);
    mcu.usart.receive([...'hi'].map((c) => c.charCodeAt(0)));
    runUntil(mcu, () => out.endsWith('hi'), 1_000_000);
    expect(out.endsWith('hi')).toBe(true);
  });

  it('usart: TXD pin shows the serial frame', () => {
    const { mcu } = boot('usart');
    runUntil(mcu, () => mcu.usart.transmitting, 1000);
    const trace = mcu.traces.get('PD1')!;
    runUntil(mcu, () => !mcu.usart.transmitting, 100_000);
    // 'H' = 0x48 = 0b01001000, LSB first: start(0) 0 0 0 1 0 0 1 0 stop(1)
    const bit = 16 * 104;
    const t0 = trace.times[trace.states.indexOf(0, 1)];
    const levelAt = (t: number) => {
      let s = 1;
      for (let i = 0; i < trace.times.length && trace.times[i] <= t; i++) s = trace.states[i];
      return s;
    };
    const bits = Array.from({ length: 10 }, (_, i) => levelAt(t0 + bit * i + bit / 2));
    expect(bits).toEqual([0, 0, 0, 0, 1, 0, 0, 1, 0, 1]);
  });

  it('button: falling edge on PD2 triggers INT0 and toggles PB5', () => {
    const { mcu } = boot('button');
    runUntil(mcu, () => false, 200);
    expect(mcu.ports.D.level & 0x04).toBe(0x04); // pull-up
    expect(mcu.ports.B.level & 0x20).toBe(0);
    mcu.ports.D.setInput(2, false);
    runUntil(mcu, () => false, 50);
    expect(mcu.ports.B.level & 0x20).toBe(0x20);
    mcu.ports.D.setInput(2, null); // release: rising edge, no toggle
    runUntil(mcu, () => false, 50);
    expect(mcu.ports.B.level & 0x20).toBe(0x20);
    mcu.ports.D.setInput(2, false);
    runUntil(mcu, () => false, 50);
    expect(mcu.ports.B.level & 0x20).toBe(0);
    expect(mcu.interruptCounts.get(1)).toBe(2);
  });
});

describe('cpu details', () => {
  const run = (src: string, steps: number) => {
    const res = assemble(src);
    expect(res.messages.filter((m) => m.severity === 'error')).toEqual([]);
    const mcu = new ATmega328P();
    mcu.load(res.flash.subarray(0, res.size));
    for (let i = 0; i < steps; i++) mcu.step();
    return mcu;
  };
  it('the instruction after SEI runs before a pending interrupt', () => {
    const src = `
      .org 0
        rjmp start
      .org OVF0addr
        rjmp isr
      start:
        ldi r16, 1
        sts TIMSK0, r16
        sbi TIFR0, TOV0     ; writing 1 clears; flag stays 0
        ldi r16, 1
        out TCCR0B, r16     ; clk/1
        ldi r17, 0
      wait: in r18, TIFR0
        sbrs r18, TOV0
        rjmp wait
        sei
        ldi r17, 0x55       ; must run before the ISR
        nop
      isr: ldi r19, 0xAA
        reti`;
    const res = assemble(src);
    const mcu = new ATmega328P();
    mcu.load(res.flash.subarray(0, res.size));
    const isr = res.symbols.find((s) => s.name === 'isr')!.value;
    runUntil(mcu, () => mcu.cpu.pc === isr, 5000);
    expect(mcu.cpu.data[17]).toBe(0x55);
  });

  it('writing PINx toggles PORTx', () => {
    const mcu = run('sbi DDRB, 0\nldi r16, 0x81\nout PINB, r16\n', 3);
    expect(mcu.cpu.data[REG.PORTB]).toBe(0x81);
    // PB0 is an output driving high; PB7 is an input with its pull-up enabled.
    expect(mcu.ports.B.level).toBe(0x81);
    expect(mcu.ports.B.floating & 0x81).toBe(0);
  });

  it('16-bit timer registers use the TEMP register', () => {
    const mcu = run('ldi r16, 0x12\nsts TCNT1H, r16\nldi r16, 0x34\nsts TCNT1L, r16\nlds r20, TCNT1L\nlds r21, TCNT1H\n', 6);
    expect(mcu.cpu.data[20]).toBe(0x34);
    expect(mcu.cpu.data[21]).toBe(0x12);
  });
});
