import type { CPU } from './cpu';
import type { Port } from './gpio';

export interface OcPin {
  port: Port;
  bit: number;
}

// Interrupt flag bits shared by all timers.
const TOV = 0, OCFA = 1, OCFB = 2, ICF = 5;

type ModeKind = 'normal' | 'ctc' | 'fast' | 'pc' | 'pfc';
type TopSrc = number | 'ocra' | 'icr';

export interface TimerMode {
  kind: ModeKind;
  top: TopSrc;
  label: string;
}

const MODES8: TimerMode[] = [
  { kind: 'normal', top: 0xff, label: 'Normal' },
  { kind: 'pc', top: 0xff, label: 'PWM, phase correct (TOP=0xFF)' },
  { kind: 'ctc', top: 'ocra', label: 'CTC (TOP=OCRA)' },
  { kind: 'fast', top: 0xff, label: 'Fast PWM (TOP=0xFF)' },
  { kind: 'normal', top: 0xff, label: 'Reserved' },
  { kind: 'pc', top: 'ocra', label: 'PWM, phase correct (TOP=OCRA)' },
  { kind: 'normal', top: 0xff, label: 'Reserved' },
  { kind: 'fast', top: 'ocra', label: 'Fast PWM (TOP=OCRA)' },
];

const MODES16: TimerMode[] = [
  { kind: 'normal', top: 0xffff, label: 'Normal' },
  { kind: 'pc', top: 0xff, label: 'PWM, phase correct, 8-bit' },
  { kind: 'pc', top: 0x1ff, label: 'PWM, phase correct, 9-bit' },
  { kind: 'pc', top: 0x3ff, label: 'PWM, phase correct, 10-bit' },
  { kind: 'ctc', top: 'ocra', label: 'CTC (TOP=OCR1A)' },
  { kind: 'fast', top: 0xff, label: 'Fast PWM, 8-bit' },
  { kind: 'fast', top: 0x1ff, label: 'Fast PWM, 9-bit' },
  { kind: 'fast', top: 0x3ff, label: 'Fast PWM, 10-bit' },
  { kind: 'pfc', top: 'icr', label: 'PWM, phase & freq. correct (TOP=ICR1)' },
  { kind: 'pfc', top: 'ocra', label: 'PWM, phase & freq. correct (TOP=OCR1A)' },
  { kind: 'pc', top: 'icr', label: 'PWM, phase correct (TOP=ICR1)' },
  { kind: 'pc', top: 'ocra', label: 'PWM, phase correct (TOP=OCR1A)' },
  { kind: 'ctc', top: 'icr', label: 'CTC (TOP=ICR1)' },
  { kind: 'normal', top: 0xffff, label: 'Reserved' },
  { kind: 'fast', top: 'icr', label: 'Fast PWM (TOP=ICR1)' },
  { kind: 'fast', top: 'ocra', label: 'Fast PWM (TOP=OCR1A)' },
];

export interface TimerConfig {
  name: string;
  bits: 8 | 16;
  tccrA: number;
  tccrB: number;
  tccrC?: number;
  tcnt: number; // low byte address
  ocrA: number;
  ocrB: number;
  icr?: number;
  timsk: number;
  tifr: number;
  /** Prescaler divisor per CS value. 0 = stopped, -1 = external falling, -2 = external rising. */
  prescalers: number[];
  ocA: OcPin;
  ocB: OcPin;
}

/** Shared implementation of the 8-bit and 16-bit AVR timer/counters. */
export class Timer {
  private up = true;
  private ocrAActive = 0;
  private ocrBActive = 0;
  private skipMatch = false;
  private temp = 0; // 16-bit access TEMP register
  private ocALevel = false;
  private ocBLevel = false;
  /** Cached prescaler divisor and the cycle of the next timer clock. */
  private div = 0;
  private nextTick = 0;

  constructor(
    private readonly cpu: CPU,
    readonly cfg: TimerConfig,
  ) {
    const d = cpu.data;
    const wh = cpu.writeHooks;
    const rh = cpu.readHooks;
    const store = (addr: number) => (v: number, m: number) => {
      d[addr] = (d[addr] & ~m) | (v & m);
    };

    wh[cfg.tccrA] = (v, m) => {
      store(cfg.tccrA)(v, m);
      this.updateOutputs();
    };
    wh[cfg.tccrB] = (v, m) => {
      const val = (d[cfg.tccrB] & ~m) | (v & m);
      if (cfg.bits === 8) {
        // FOCnA/FOCnB are strobes and always read as zero.
        d[cfg.tccrB] = val & 0x3f;
        if (val & 0x80) this.forceCompare('A');
        if (val & 0x40) this.forceCompare('B');
      } else {
        d[cfg.tccrB] = val;
      }
      this.updateClock();
      this.updateOutputs();
    };
    if (cfg.tccrC !== undefined) {
      const c = cfg.tccrC;
      wh[c] = (v, m) => {
        const val = v & m;
        if (val & 0x80) this.forceCompare('A');
        if (val & 0x40) this.forceCompare('B');
        d[c] = 0;
      };
    }
    wh[cfg.tifr] = (v, m) => {
      // Interrupt flags are cleared by writing 1.
      d[cfg.tifr] &= ~(v & m);
    };

    if (cfg.bits === 8) {
      wh[cfg.tcnt] = (v, m) => {
        store(cfg.tcnt)(v, m);
        this.skipMatch = true;
      };
      wh[cfg.ocrA] = (v, m) => {
        store(cfg.ocrA)(v, m);
        if (!this.buffered) this.ocrAActive = d[cfg.ocrA];
      };
      wh[cfg.ocrB] = (v, m) => {
        store(cfg.ocrB)(v, m);
        if (!this.buffered) this.ocrBActive = d[cfg.ocrB];
      };
    } else {
      const reg16 = (lo: number, onWrite: () => void) => {
        wh[lo + 1] = (v) => {
          this.temp = v;
        };
        wh[lo] = (v) => {
          d[lo] = v;
          d[lo + 1] = this.temp;
          onWrite();
        };
        rh[lo] = () => {
          this.temp = d[lo + 1];
          return d[lo];
        };
        rh[lo + 1] = () => this.temp;
      };
      reg16(cfg.tcnt, () => {
        this.skipMatch = true;
      });
      reg16(cfg.ocrA, () => {
        if (!this.buffered) this.ocrAActive = this.read16(cfg.ocrA);
      });
      reg16(cfg.ocrB, () => {
        if (!this.buffered) this.ocrBActive = this.read16(cfg.ocrB);
      });
      reg16(cfg.icr!, () => {});
    }
  }

  reset(): void {
    this.up = true;
    this.ocrAActive = this.ocrBActive = 0;
    this.skipMatch = false;
    this.temp = 0;
    this.ocALevel = this.ocBLevel = false;
    this.updateClock();
    this.updateOutputs();
  }

  /** Re-read the clock select bits. The prescaler counts CPU cycles from reset. */
  private updateClock(): void {
    this.div = this.prescaler;
    if (this.div > 0) this.nextTick = (Math.floor(this.cpu.cycles / this.div) + 1) * this.div;
  }

  private read16(lo: number): number {
    return this.cpu.data[lo] | (this.cpu.data[lo + 1] << 8);
  }

  get count(): number {
    return this.cfg.bits === 8 ? this.cpu.data[this.cfg.tcnt] : this.read16(this.cfg.tcnt);
  }
  private set count(v: number) {
    const d = this.cpu.data;
    d[this.cfg.tcnt] = v & 0xff;
    if (this.cfg.bits === 16) d[this.cfg.tcnt + 1] = (v >> 8) & 0xff;
  }

  get wgm(): number {
    const a = this.cpu.data[this.cfg.tccrA], b = this.cpu.data[this.cfg.tccrB];
    return this.cfg.bits === 8 ? (a & 3) | ((b >> 1) & 4) : (a & 3) | ((b >> 1) & 0xc);
  }
  get mode(): TimerMode {
    return (this.cfg.bits === 8 ? MODES8 : MODES16)[this.wgm];
  }
  get cs(): number {
    return this.cpu.data[this.cfg.tccrB] & 7;
  }
  get prescaler(): number {
    return this.cfg.prescalers[this.cs];
  }
  get comA(): number {
    return this.cpu.data[this.cfg.tccrA] >> 6;
  }
  get comB(): number {
    return (this.cpu.data[this.cfg.tccrA] >> 4) & 3;
  }
  /** OCR registers are double-buffered in PWM modes. */
  private get buffered(): boolean {
    const k = this.mode.kind;
    return k === 'fast' || k === 'pc' || k === 'pfc';
  }
  get top(): number {
    const t = this.mode.top;
    if (t === 'ocra') return this.mode.kind === 'ctc' ? this.ocrAValue : this.ocrAActive;
    if (t === 'icr') return this.read16(this.cfg.icr!);
    return t;
  }
  private get ocrAValue(): number {
    return this.cfg.bits === 8 ? this.cpu.data[this.cfg.ocrA] : this.read16(this.cfg.ocrA);
  }
  private get ocrBValue(): number {
    return this.cfg.bits === 8 ? this.cpu.data[this.cfg.ocrB] : this.read16(this.cfg.ocrB);
  }
  get ocrA(): number {
    return this.ocrAActive;
  }
  get ocrB(): number {
    return this.ocrBActive;
  }
  get countingUp(): boolean {
    return this.up;
  }
  get max(): number {
    return this.cfg.bits === 8 ? 0xff : 0xffff;
  }

  /** Advance the timer up to CPU cycle `to` using the internal prescaler. */
  advance(to: number): void {
    if (this.div <= 0) return;
    while (this.nextTick <= to) {
      this.tick();
      this.nextTick += this.div;
    }
  }

  /** External clock input edge (T0/T1 pins). */
  externalEdge(rising: boolean): void {
    const n = this.prescaler;
    if ((n === -1 && !rising) || (n === -2 && rising)) this.tick();
  }

  /** Input capture event (Timer1 ICP1 pin). */
  captureEdge(rising: boolean): void {
    if (this.cfg.icr === undefined) return;
    const ices = (this.cpu.data[this.cfg.tccrB] >> 6) & 1;
    if (rising !== !!ices) return;
    if (this.mode.top === 'icr') return; // ICR1 is used as TOP, capture disabled
    const v = this.count;
    this.cpu.data[this.cfg.icr] = v & 0xff;
    this.cpu.data[this.cfg.icr + 1] = v >> 8;
    this.cpu.data[this.cfg.tifr] |= 1 << ICF;
  }

  private setFlag(bit: number): void {
    this.cpu.data[this.cfg.tifr] |= 1 << bit;
  }

  private loadBuffers(): void {
    this.ocrAActive = this.ocrAValue;
    this.ocrBActive = this.ocrBValue;
  }

  tick(): void {
    const mode = this.mode;
    const top = this.top;
    let t = this.count;
    let wasUp = true;
    let atBottom = false;

    if (mode.kind === 'pc' || mode.kind === 'pfc') {
      wasUp = this.up;
      if (this.up) {
        t++;
        if (t >= top) {
          t = top;
          this.up = false;
          if (mode.kind === 'pc') this.loadBuffers();
          if (mode.top === 'icr') this.setFlag(ICF);
        }
      } else {
        t--;
        if (t <= 0) {
          t = 0;
          this.up = true;
          this.setFlag(TOV);
          if (mode.kind === 'pfc') this.loadBuffers();
        }
      }
    } else {
      this.up = true;
      if (t === top) {
        t = 0;
        atBottom = true;
        if (mode.kind === 'fast') {
          this.setFlag(TOV);
          this.loadBuffers();
          if (mode.top === 'icr') this.setFlag(ICF);
        } else if (top === this.max) {
          this.setFlag(TOV);
        }
        if (mode.kind === 'ctc' && mode.top === 'icr') this.setFlag(ICF);
      } else {
        t = (t + 1) & this.max;
        if (t === 0) {
          atBottom = true;
          this.setFlag(TOV);
        }
      }
    }
    this.count = t;

    if (mode.kind === 'fast' && atBottom) this.fastPwmBottom();

    if (this.skipMatch) {
      this.skipMatch = false;
      return;
    }
    if (t === this.ocrAActive) this.compareMatch('A', wasUp, top);
    if (t === this.ocrBActive) this.compareMatch('B', wasUp, top);
  }

  private compareMatch(ch: 'A' | 'B', countingUp: boolean, top: number): void {
    const mode = this.mode;
    this.setFlag(ch === 'A' ? OCFA : OCFB);
    const com = ch === 'A' ? this.comA : this.comB;
    if (com === 0) return;
    const cur = ch === 'A' ? this.ocALevel : this.ocBLevel;
    let next = cur;
    if (mode.kind === 'normal' || mode.kind === 'ctc') {
      next = com === 1 ? !cur : com === 3;
    } else if (com === 1) {
      if (ch === 'A' && mode.top === 'ocra') next = !cur;
      else return;
    } else if (mode.kind === 'fast') {
      // At TOP the output is not cleared/set, so OCR=TOP gives a constant level.
      if ((ch === 'A' ? this.ocrAActive : this.ocrBActive) === top) return;
      next = com === 3;
    } else {
      // Phase correct: COM=2 clears when up-counting, sets when down-counting.
      next = (com === 2) !== countingUp;
    }
    this.setOc(ch, next);
  }

  /** Fast PWM: non-inverting outputs are set at BOTTOM, inverting ones cleared. */
  private fastPwmBottom(): void {
    if (this.comA >= 2) this.setOc('A', this.comA === 2);
    if (this.comB >= 2) this.setOc('B', this.comB === 2);
  }

  private forceCompare(ch: 'A' | 'B'): void {
    const k = this.mode.kind;
    if (k !== 'normal' && k !== 'ctc') return;
    const com = ch === 'A' ? this.comA : this.comB;
    if (com === 0) return;
    const cur = ch === 'A' ? this.ocALevel : this.ocBLevel;
    this.setOc(ch, com === 1 ? !cur : com === 3);
  }

  private setOc(ch: 'A' | 'B', level: boolean): void {
    if (ch === 'A') this.ocALevel = level;
    else this.ocBLevel = level;
    this.updateOutputs();
  }

  /** Whether the compare output is connected to the pin for channel A/B. */
  ocConnected(ch: 'A' | 'B'): boolean {
    const com = ch === 'A' ? this.comA : this.comB;
    if (com === 0) return false;
    if (com === 1 && this.mode.kind !== 'normal' && this.mode.kind !== 'ctc') {
      return ch === 'A' && this.mode.top === 'ocra';
    }
    return true;
  }

  private updateOutputs(): void {
    const { ocA, ocB } = this.cfg;
    ocA.port.setOverride(ocA.bit, this.ocConnected('A'), this.ocALevel);
    ocB.port.setOverride(ocB.bit, this.ocConnected('B'), this.ocBLevel);
  }
}
