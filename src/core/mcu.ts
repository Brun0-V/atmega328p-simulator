import { CPU, I, isTwoWord } from './cpu';
import { Port, type PortName } from './gpio';
import { Timer } from './timers';
import { Usart } from './usart';

// Data-space addresses
export const REG = {
  PINB: 0x23, DDRB: 0x24, PORTB: 0x25, PINC: 0x26, DDRC: 0x27, PORTC: 0x28, PIND: 0x29, DDRD: 0x2a, PORTD: 0x2b,
  TIFR0: 0x35, TIFR1: 0x36, TIFR2: 0x37, PCIFR: 0x3b, EIFR: 0x3c, EIMSK: 0x3d,
  TCCR0A: 0x44, TCCR0B: 0x45, TCNT0: 0x46, OCR0A: 0x47, OCR0B: 0x48,
  SMCR: 0x53, MCUCR: 0x55, SPL: 0x5d, SPH: 0x5e, SREG: 0x5f,
  PCICR: 0x68, EICRA: 0x69, PCMSK0: 0x6b, PCMSK1: 0x6c, PCMSK2: 0x6d,
  TIMSK0: 0x6e, TIMSK1: 0x6f, TIMSK2: 0x70,
  TCCR1A: 0x80, TCCR1B: 0x81, TCCR1C: 0x82, TCNT1L: 0x84, ICR1L: 0x86, OCR1AL: 0x88, OCR1BL: 0x8a,
  TCCR2A: 0xb0, TCCR2B: 0xb1, TCNT2: 0xb2, OCR2A: 0xb3, OCR2B: 0xb4,
  UCSR0A: 0xc0, UCSR0B: 0xc1, UCSR0C: 0xc2, UBRR0L: 0xc4, UBRR0H: 0xc5, UDR0: 0xc6,
} as const;

export interface InterruptSource {
  vector: number;
  name: string;
  enabled: () => boolean;
  flagged: () => boolean;
  /** Called when the interrupt is taken (clears the flag for most sources). */
  ack: () => void;
  /** Flag bit to display, if different from `flagged` (INTx in low-level mode has no flag). */
  displayFlag?: () => boolean;
}

export type StopReason = 'budget' | 'breakpoint' | 'break' | 'halted' | 'condition';

/** Records pin level changes for the timing chart. */
export class PinTrace {
  readonly times: number[] = [];
  readonly states: number[] = [];
  constructor(readonly limit = 50000) {}
  push(cycle: number, state: number): void {
    const n = this.states.length;
    if (n && this.states[n - 1] === state) return;
    if (n && this.times[n - 1] === cycle) {
      this.states[n - 1] = state;
      return;
    }
    this.times.push(cycle);
    this.states.push(state);
    if (this.times.length > this.limit) {
      const drop = this.limit >> 2;
      this.times.splice(0, drop);
      this.states.splice(0, drop);
    }
  }
  clear(): void {
    this.times.length = 0;
    this.states.length = 0;
  }
}

export class ATmega328P {
  readonly cpu = new CPU();
  readonly ports: Record<PortName, Port>;
  readonly timer0: Timer;
  readonly timer1: Timer;
  readonly timer2: Timer;
  readonly usart: Usart;
  readonly interrupts: InterruptSource[];
  readonly traces = new Map<string, PinTrace>();
  /** Oscillator frequency in Hz (used for time and baud-rate display). */
  frequency = 16_000_000;
  /** Last interrupt taken, for display. */
  lastInterrupt: { name: string; cycle: number } | null = null;
  interruptCounts = new Map<number, number>();
  private program = new Uint16Array(0);

  constructor() {
    const cpu = this.cpu;
    const pud = () => !!(cpu.data[REG.MCUCR] & 0x10);
    this.ports = {
      B: new Port(cpu, 'B', REG.PINB, REG.DDRB, REG.PORTB, 8, pud),
      C: new Port(cpu, 'C', REG.PINC, REG.DDRC, REG.PORTC, 7, pud),
      D: new Port(cpu, 'D', REG.PIND, REG.DDRD, REG.PORTD, 8, pud),
    };
    const { B, D } = this.ports;
    cpu.writeHooks[REG.MCUCR] = (v, m) => {
      cpu.data[REG.MCUCR] = (cpu.data[REG.MCUCR] & ~m) | (v & m);
      for (const p of Object.values(this.ports)) p.update();
    };

    this.timer0 = new Timer(cpu, {
      name: 'Timer0', bits: 8, tccrA: REG.TCCR0A, tccrB: REG.TCCR0B, tcnt: REG.TCNT0, ocrA: REG.OCR0A,
      ocrB: REG.OCR0B, timsk: REG.TIMSK0, tifr: REG.TIFR0, prescalers: [0, 1, 8, 64, 256, 1024, -1, -2],
      ocA: { port: D, bit: 6 }, ocB: { port: D, bit: 5 },
    });
    this.timer1 = new Timer(cpu, {
      name: 'Timer1', bits: 16, tccrA: REG.TCCR1A, tccrB: REG.TCCR1B, tccrC: REG.TCCR1C, tcnt: REG.TCNT1L,
      ocrA: REG.OCR1AL, ocrB: REG.OCR1BL, icr: REG.ICR1L, timsk: REG.TIMSK1, tifr: REG.TIFR1,
      prescalers: [0, 1, 8, 64, 256, 1024, -1, -2], ocA: { port: B, bit: 1 }, ocB: { port: B, bit: 2 },
    });
    this.timer2 = new Timer(cpu, {
      name: 'Timer2', bits: 8, tccrA: REG.TCCR2A, tccrB: REG.TCCR2B, tcnt: REG.TCNT2, ocrA: REG.OCR2A,
      ocrB: REG.OCR2B, timsk: REG.TIMSK2, tifr: REG.TIFR2, prescalers: [0, 1, 8, 32, 64, 128, 256, 1024],
      ocA: { port: B, bit: 3 }, ocB: { port: D, bit: 3 },
    });
    this.usart = new Usart(cpu, D);

    // Flag registers that are cleared by writing 1.
    for (const addr of [REG.EIFR, REG.PCIFR]) {
      cpu.writeHooks[addr] = (v, m) => {
        cpu.data[addr] &= ~(v & m);
      };
    }

    // Pin listeners: trace, external interrupts, pin change interrupts, timer clock and capture inputs.
    const pcmsk = { B: REG.PCMSK0, C: REG.PCMSK1, D: REG.PCMSK2 };
    const pcif = { B: 0, C: 1, D: 2 };
    for (const [name, port] of Object.entries(this.ports) as [PortName, Port][]) {
      for (let bit = 0; bit < port.width; bit++) this.traces.set(`P${name}${bit}`, new PinTrace());
      port.listeners.push((changed, rising, falling) => {
        for (let bit = 0; bit < port.width; bit++) {
          if (changed & (1 << bit)) this.traces.get(`P${name}${bit}`)!.push(cpu.cycles, port.pinState(bit));
        }
        const edges = rising | falling;
        if (edges & cpu.data[pcmsk[name]]) cpu.data[REG.PCIFR] |= 1 << pcif[name];
        if (name === 'D') {
          this.extIntEdge(0, 2, rising, falling);
          this.extIntEdge(1, 3, rising, falling);
          if (edges & (1 << 4)) this.timer0.externalEdge(!!(rising & (1 << 4)));
          if (edges & (1 << 5)) this.timer1.externalEdge(!!(rising & (1 << 5)));
        }
        if (name === 'B' && edges & 1) this.timer1.captureEdge(!!(rising & 1));
      });
    }

    const d = cpu.data;
    const bitSet = (addr: number, bit: number) => () => !!(d[addr] & (1 << bit));
    const clear = (addr: number, bit: number) => () => {
      d[addr] &= ~(1 << bit);
    };
    const intLowLevel = (n: number) => ((d[REG.EICRA] >> (n * 2)) & 3) === 0;
    const extInt = (n: number, bit: number): InterruptSource => ({
      vector: n + 1,
      name: `INT${n}`,
      enabled: bitSet(REG.EIMSK, n),
      flagged: () => (intLowLevel(n) ? !(this.ports.D.level & (1 << bit)) : !!(d[REG.EIFR] & (1 << n))),
      ack: () => {
        if (!intLowLevel(n)) d[REG.EIFR] &= ~(1 << n);
      },
      displayFlag: () => !!(d[REG.EIFR] & (1 << n)) || (intLowLevel(n) && !!(d[REG.EIMSK] & (1 << n)) && !(this.ports.D.level & (1 << bit))),
    });
    const flagSrc = (vector: number, name: string, mask: number, flag: number, bit: number, enBit = bit): InterruptSource => ({
      vector, name, enabled: bitSet(mask, enBit), flagged: bitSet(flag, bit), ack: clear(flag, bit),
    });
    this.interrupts = [
      extInt(0, 2),
      extInt(1, 3),
      flagSrc(3, 'PCINT0', REG.PCICR, REG.PCIFR, 0),
      flagSrc(4, 'PCINT1', REG.PCICR, REG.PCIFR, 1),
      flagSrc(5, 'PCINT2', REG.PCICR, REG.PCIFR, 2),
      flagSrc(7, 'TIMER2_COMPA', REG.TIMSK2, REG.TIFR2, 1),
      flagSrc(8, 'TIMER2_COMPB', REG.TIMSK2, REG.TIFR2, 2),
      flagSrc(9, 'TIMER2_OVF', REG.TIMSK2, REG.TIFR2, 0),
      flagSrc(10, 'TIMER1_CAPT', REG.TIMSK1, REG.TIFR1, 5),
      flagSrc(11, 'TIMER1_COMPA', REG.TIMSK1, REG.TIFR1, 1),
      flagSrc(12, 'TIMER1_COMPB', REG.TIMSK1, REG.TIFR1, 2),
      flagSrc(13, 'TIMER1_OVF', REG.TIMSK1, REG.TIFR1, 0),
      flagSrc(14, 'TIMER0_COMPA', REG.TIMSK0, REG.TIFR0, 1),
      flagSrc(15, 'TIMER0_COMPB', REG.TIMSK0, REG.TIFR0, 2),
      flagSrc(16, 'TIMER0_OVF', REG.TIMSK0, REG.TIFR0, 0),
      { vector: 18, name: 'USART_RX', enabled: bitSet(REG.UCSR0B, 7), flagged: bitSet(REG.UCSR0A, 7), ack: () => {} },
      { vector: 19, name: 'USART_UDRE', enabled: bitSet(REG.UCSR0B, 5), flagged: bitSet(REG.UCSR0A, 5), ack: () => {} },
      flagSrc(20, 'USART_TX', REG.UCSR0B, REG.UCSR0A, 6),
    ];

    this.reset();
  }

  private extIntEdge(n: number, bit: number, rising: number, falling: number): void {
    const b = 1 << bit;
    if (!((rising | falling) & b)) return;
    const isc = (this.cpu.data[REG.EICRA] >> (n * 2)) & 3;
    const hit = isc === 1 || (isc === 2 && falling & b) || (isc === 3 && rising & b);
    if (hit) this.cpu.data[REG.EIFR] |= 1 << n;
  }

  /** Load a program into flash (persists across resets). */
  load(program: Uint16Array): void {
    this.program = program.slice();
    this.reset();
  }

  reset(): void {
    const cpu = this.cpu;
    cpu.reset();
    cpu.flash.fill(0xffff);
    cpu.flash.set(this.program.subarray(0, cpu.flash.length));
    for (const t of this.traces.values()) t.clear();
    for (const p of Object.values(this.ports)) p.reset();
    this.timer0.reset();
    this.timer1.reset();
    this.timer2.reset();
    this.usart.reset();
    this.lastInterrupt = null;
    this.interruptCounts.clear();
    // Record initial pin states so traces start at cycle 0.
    for (const [name, port] of Object.entries(this.ports)) {
      for (let bit = 0; bit < port.width; bit++) this.traces.get(`P${name}${bit}`)!.push(0, port.pinState(bit));
    }
  }

  get time(): number {
    return this.cpu.cycles / this.frequency;
  }

  /** The interrupt that would be taken now, if any. */
  pendingInterrupt(): InterruptSource | null {
    if (!this.anyInterruptPossible()) return null;
    for (const src of this.interrupts) if (src.enabled() && src.flagged()) return src;
    return null;
  }

  /** Cheap check over the flag/enable registers so the full scan only runs when needed. */
  private anyInterruptPossible(): boolean {
    const d = this.cpu.data;
    // INT0/INT1 in low-level mode have no flag; treat them as possibly pending.
    const lowLevelMask = ((d[REG.EICRA] & 3) === 0 ? 1 : 0) | ((d[REG.EICRA] & 0xc) === 0 ? 2 : 0);
    const lowLevel = d[REG.EIMSK] & lowLevelMask;
    return !!(
      (d[REG.TIFR0] & d[REG.TIMSK0]) |
      (d[REG.TIFR1] & d[REG.TIMSK1]) |
      (d[REG.TIFR2] & d[REG.TIMSK2]) |
      (d[REG.EIFR] & d[REG.EIMSK]) |
      lowLevel |
      (d[REG.PCIFR] & d[REG.PCICR]) |
      (d[REG.UCSR0A] & d[REG.UCSR0B] & 0xe0)
    );
  }

  private advancePeripherals(from: number, to: number): void {
    this.timer0.advance(to);
    this.timer1.advance(to);
    this.timer2.advance(to);
    this.usart.advance(to - from);
  }

  private serviceInterrupts(): boolean {
    const cpu = this.cpu;
    if (cpu.intInhibit) {
      cpu.intInhibit = false;
      return false;
    }
    if (!(cpu.sreg & (1 << I))) return false;
    const src = this.pendingInterrupt();
    if (!src) return false;
    src.ack();
    const from = cpu.cycles;
    cpu.interrupt(src.vector * 2);
    this.advancePeripherals(from, cpu.cycles);
    this.lastInterrupt = { name: src.name, cycle: cpu.cycles };
    this.interruptCounts.set(src.vector, (this.interruptCounts.get(src.vector) ?? 0) + 1);
    return true;
  }

  /**
   * Execute one instruction (or one idle cycle while sleeping), then let peripherals run
   * and take a pending interrupt. Returns false if the CPU is halted.
   */
  step(): boolean {
    const cpu = this.cpu;
    if (cpu.halted) return false;
    const from = cpu.cycles;
    if (cpu.sleeping) {
      cpu.cycles++;
    } else {
      cpu.step();
      if (cpu.halted) return false;
    }
    this.advancePeripherals(from, cpu.cycles);
    this.serviceInterrupts();
    return true;
  }

  /**
   * Run until `cycleBudget` cycles have elapsed or something stops execution.
   * Breakpoints (word addresses) are checked before each instruction, except the first one.
   */
  run(cycleBudget: number, breakpoints?: Set<number>, until?: () => boolean): StopReason {
    const cpu = this.cpu;
    const end = cpu.cycles + cycleBudget;
    let first = true;
    const bp = breakpoints && breakpoints.size ? breakpoints : null;
    while (cpu.cycles < end) {
      if (!first && bp && !cpu.sleeping && bp.has(cpu.pc)) return 'breakpoint';
      first = false;
      if (!this.step()) return 'halted';
      if (cpu.breakHit) {
        cpu.breakHit = false;
        return 'break';
      }
      if (until && until()) return 'condition';
    }
    return 'budget';
  }

  /** Size in words of the instruction at the current PC. */
  instructionWords(pc = this.cpu.pc): number {
    return isTwoWord(this.cpu.flash[pc]) ? 2 : 1;
  }
}
