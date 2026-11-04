import type { CPU } from './cpu';
import type { Port } from './gpio';

const UCSR0A = 0xc0, UCSR0B = 0xc1, UCSR0C = 0xc2, UBRR0L = 0xc4, UBRR0H = 0xc5, UDR0 = 0xc6;
// UCSR0A bits
const RXC = 7, TXC = 6, UDRE = 5, U2X = 1;
// UCSR0B bits
const RXEN = 4, TXEN = 3;

/** USART0 in asynchronous mode. TX timing follows the baud rate and drives PD1. */
export class Usart {
  onTransmit: (byte: number) => void = () => {};

  private txBusy = false;
  private txShift = 0;
  private txBufFull = false;
  private txBuf = 0;
  private txElapsed = 0;
  private txBits: number[] = [];

  /** Bytes typed by the user, waiting to be received. */
  readonly rxQueue: number[] = [];
  private rxFifo: number[] = [];
  private rxElapsed = 0;
  private rxBusy = false;

  constructor(
    private readonly cpu: CPU,
    private readonly portD: Port,
  ) {
    const d = cpu.data;
    cpu.writeHooks[UCSR0A] = (v, m) => {
      // TXC is cleared by writing 1; U2X and MPCM are writable; the rest is read-only.
      if (v & m & (1 << TXC)) d[UCSR0A] &= ~(1 << TXC);
      const writable = 0x03 & m;
      d[UCSR0A] = (d[UCSR0A] & ~writable) | (v & writable);
    };
    cpu.writeHooks[UCSR0B] = (v, m) => {
      d[UCSR0B] = (d[UCSR0B] & ~m) | (v & m);
      this.updatePins();
    };
    cpu.writeHooks[UCSR0C] = (v, m) => {
      d[UCSR0C] = (d[UCSR0C] & ~m) | (v & m);
    };
    cpu.writeHooks[UBRR0H] = (v, m) => {
      d[UBRR0H] = ((d[UBRR0H] & ~m) | (v & m)) & 0x0f;
    };
    cpu.writeHooks[UDR0] = (v) => this.writeData(v);
    cpu.readHooks[UDR0] = () => this.readData();
  }

  reset(): void {
    const d = this.cpu.data;
    d[UCSR0A] = 1 << UDRE;
    d[UCSR0C] = 0x06;
    this.txBusy = this.txBufFull = this.rxBusy = false;
    this.txElapsed = this.rxElapsed = 0;
    this.rxFifo = [];
    this.rxQueue.length = 0;
    this.updatePins();
  }

  get ubrr(): number {
    return this.cpu.data[UBRR0L] | ((this.cpu.data[UBRR0H] & 0x0f) << 8);
  }
  get doubleSpeed(): boolean {
    return !!(this.cpu.data[UCSR0A] & (1 << U2X));
  }
  get txEnabled(): boolean {
    return !!(this.cpu.data[UCSR0B] & (1 << TXEN));
  }
  get rxEnabled(): boolean {
    return !!(this.cpu.data[UCSR0B] & (1 << RXEN));
  }
  /** CPU cycles per bit. */
  get bitCycles(): number {
    return (this.ubrr + 1) * (this.doubleSpeed ? 8 : 16);
  }
  baud(fcpu: number): number {
    return fcpu / this.bitCycles;
  }
  get dataBits(): number {
    const c = this.cpu.data[UCSR0C];
    const ucsz = ((c >> 1) & 3) | (this.cpu.data[UCSR0B] & 4);
    return [5, 6, 7, 8, 8, 8, 8, 9][ucsz];
  }
  get parity(): 'none' | 'even' | 'odd' {
    const upm = (this.cpu.data[UCSR0C] >> 4) & 3;
    return upm === 2 ? 'even' : upm === 3 ? 'odd' : 'none';
  }
  get stopBits(): number {
    return this.cpu.data[UCSR0C] & 8 ? 2 : 1;
  }
  get frameBits(): number {
    return 1 + this.dataBits + (this.parity === 'none' ? 0 : 1) + this.stopBits;
  }
  get transmitting(): boolean {
    return this.txBusy;
  }
  get rxPending(): number {
    return this.rxFifo.length + this.rxQueue.length;
  }

  private updatePins(): void {
    // TXEN overrides PD1 as output (idle high); RXEN makes PD0 an input.
    const tx = this.txEnabled;
    this.portD.setOutputOverride(1, tx);
    this.portD.setOverride(1, tx, !this.txBusy || this.txLevel());
    this.portD.setOverride(0, false, false);
  }

  private txLevel(): boolean {
    const bit = Math.floor(this.txElapsed / this.bitCycles);
    return bit < this.txBits.length ? !!this.txBits[bit] : true;
  }

  private buildFrame(byte: number): number[] {
    const bits = [0];
    let ones = 0;
    for (let i = 0; i < Math.min(this.dataBits, 8); i++) {
      const b = (byte >> i) & 1;
      ones += b;
      bits.push(b);
    }
    if (this.dataBits === 9) {
      const b = (this.cpu.data[UCSR0B] & 1);
      ones += b;
      bits.push(b);
    }
    if (this.parity !== 'none') bits.push(this.parity === 'even' ? ones & 1 : (ones & 1) ^ 1);
    for (let i = 0; i < this.stopBits; i++) bits.push(1);
    return bits;
  }

  private startTx(byte: number): void {
    this.txBusy = true;
    this.txShift = byte;
    this.txElapsed = 0;
    this.txBits = this.buildFrame(byte);
    this.updatePins();
  }

  private writeData(v: number): void {
    const d = this.cpu.data;
    if (!this.txEnabled) return;
    if (!this.txBusy) {
      this.startTx(v);
    } else {
      this.txBuf = v;
      this.txBufFull = true;
      d[UCSR0A] &= ~(1 << UDRE);
    }
  }

  private readData(): number {
    const d = this.cpu.data;
    const v = this.rxFifo.length ? this.rxFifo.shift()! : d[UDR0];
    d[UDR0] = this.rxFifo.length ? this.rxFifo[0] : v;
    if (!this.rxFifo.length) d[UCSR0A] &= ~(1 << RXC);
    return v;
  }

  /** Queue bytes to be received on RXD. */
  receive(bytes: number[]): void {
    this.rxQueue.push(...bytes);
  }

  advance(cycles: number): void {
    if (!this.txBusy && !this.rxBusy && this.rxQueue.length === 0) return;
    const d = this.cpu.data;
    if (this.txBusy) {
      const before = this.txLevel();
      this.txElapsed += cycles;
      const frame = this.txBits.length * this.bitCycles;
      if (this.txElapsed >= frame) {
        this.onTransmit(this.txShift);
        if (this.txBufFull) {
          this.txBufFull = false;
          d[UCSR0A] |= 1 << UDRE;
          this.startTx(this.txBuf);
        } else {
          this.txBusy = false;
          d[UCSR0A] |= 1 << TXC;
          this.updatePins();
        }
      } else if (this.txLevel() !== before) {
        this.updatePins();
      }
    }

    if (this.rxEnabled) {
      if (!this.rxBusy && this.rxQueue.length && this.rxFifo.length < 2) {
        this.rxBusy = true;
        this.rxElapsed = 0;
      }
      if (this.rxBusy) {
        this.rxElapsed += cycles;
        if (this.rxElapsed >= this.frameBits * this.bitCycles) {
          this.rxBusy = false;
          const b = this.rxQueue.shift()!;
          this.rxFifo.push(b);
          d[UDR0] = this.rxFifo[0];
          d[UCSR0A] |= 1 << RXC;
        }
      }
    }
  }
}
