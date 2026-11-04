import type { CPU } from './cpu';

export type PortName = 'B' | 'C' | 'D';
export const PIN_LOW = 0, PIN_HIGH = 1, PIN_FLOAT = 2;

export class Port {
  /** External input drive: bits in `extDriven` are driven to `extValue` from outside. */
  extDriven = 0;
  extValue = 0;
  /** Peripheral output overrides (timer OC pins, USART TXD). Only visible when the pin is an output. */
  ovMask = 0;
  ovValue = 0;
  /** Peripheral direction overrides (USART forces TXD to output). */
  ovOutput = 0;
  /** Current pin levels and floating mask. */
  level = 0;
  floating = 0;
  readonly mask: number;
  /** Called with the bits that changed level (or floating state). */
  listeners: ((changed: number, rising: number, falling: number) => void)[] = [];

  constructor(
    private readonly cpu: CPU,
    readonly name: PortName,
    readonly pinAddr: number,
    readonly ddrAddr: number,
    readonly portAddr: number,
    readonly width: number,
    private readonly pullupDisabled: () => boolean,
  ) {
    this.mask = (1 << width) - 1;
    cpu.writeHooks[pinAddr] = (v, m) => {
      // Writing 1 to PINx toggles PORTx.
      cpu.data[portAddr] ^= v & m & this.mask;
      this.update();
    };
    cpu.writeHooks[ddrAddr] = (v, m) => {
      cpu.data[ddrAddr] = ((cpu.data[ddrAddr] & ~m) | (v & m)) & this.mask;
      this.update();
    };
    cpu.writeHooks[portAddr] = (v, m) => {
      cpu.data[portAddr] = ((cpu.data[portAddr] & ~m) | (v & m)) & this.mask;
      this.update();
    };
  }

  get ddr(): number {
    return this.cpu.data[this.ddrAddr];
  }
  get port(): number {
    return this.cpu.data[this.portAddr];
  }
  /** Effective output-enable mask. */
  get outputs(): number {
    return (this.ddr | this.ovOutput) & this.mask;
  }

  reset(): void {
    this.ovMask = this.ovValue = this.ovOutput = 0;
    this.level = 0;
    this.floating = this.mask;
    this.update();
  }

  setOverride(bit: number, enabled: boolean, value: boolean): void {
    const b = 1 << bit;
    const mask = enabled ? this.ovMask | b : this.ovMask & ~b;
    const val = value ? this.ovValue | b : this.ovValue & ~b;
    if (mask !== this.ovMask || val !== this.ovValue) {
      this.ovMask = mask;
      this.ovValue = val;
      this.update();
    }
  }

  setOutputOverride(bit: number, enabled: boolean): void {
    const b = 1 << bit;
    const v = enabled ? this.ovOutput | b : this.ovOutput & ~b;
    if (v !== this.ovOutput) {
      this.ovOutput = v;
      this.update();
    }
  }

  /** Drive a pin from outside. `value` null = released (floating). */
  setInput(bit: number, value: boolean | null): void {
    const b = 1 << bit;
    if (value === null) this.extDriven &= ~b;
    else {
      this.extDriven |= b;
      this.extValue = value ? this.extValue | b : this.extValue & ~b;
    }
    this.update();
  }

  update(): void {
    const out = this.outputs;
    const outVal = (this.port & ~this.ovMask) | (this.ovValue & this.ovMask);
    const pullup = this.pullupDisabled() ? 0 : this.port & ~out;
    const inVal = (this.extDriven & this.extValue) | (~this.extDriven & pullup);
    const level = ((out & outVal) | (~out & inVal)) & this.mask;
    const floating = ~out & ~this.extDriven & ~pullup & this.mask;
    this.cpu.data[this.pinAddr] = level;
    const changed = (level ^ this.level) | (floating ^ this.floating);
    const rising = level & ~this.level;
    const falling = ~level & this.level & this.mask;
    this.level = level;
    this.floating = floating;
    if (changed) for (const l of this.listeners) l(changed, rising, falling);
  }

  /** Pin state for display/trace: low, high, or floating. */
  pinState(bit: number): number {
    if (this.floating & (1 << bit)) return PIN_FLOAT;
    return (this.level >> bit) & 1;
  }
}
