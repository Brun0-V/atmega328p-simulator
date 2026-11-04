import { describe, expect, it } from 'vitest';
import { assemble } from '../src/core/assembler';
import { EXAMPLES } from '../src/examples';
import { BOOTLOADER_START, Stk500, UploadError, checkImage, wordsToBytes, type Transport } from '../src/upload/stk500';

/**
 * Simulated Optiboot on an ATmega328P, speaking STK500v1, with realistic timing (virtual clock):
 * ~65 ms start-up after reset (bytes lost), then a ~375 ms LED blink during which only 3 received
 * bytes are buffered (more are dropped), then it listens. A broken command or 1 s without data
 * makes it start the old program.
 */
class FakeOptiboot implements Transport {
  static STARTUP_MS = 65;
  static LISTEN_MS = 65 + 375;
  now = 0;
  private resetAt = -1e9;
  private hold: number[] = [];
  private lastRx = 0;
  flash = new Uint8Array(0x8000).fill(0xff);
  inBootloader = false;
  started = false;
  bootWriteAttempts = 0;
  signature = [0x1e, 0x95, 0x0f];
  private rx: number[] = [];
  private tx: number[] = [];
  private addr = 0; // byte address
  private dtr = false;
  /** Bytes of noise the running sketch prints before reset. */
  noise = [0x48, 0x69, 0x0a];
  /** Inject a glitch byte before the reply to the Nth command after reset (1-based). */
  glitchBeforeReply = new Map<number, number[]>();
  /** Bytes the board's TX glitches out right after a reset (arrive after the host drained). */
  resetGlitch: number[] = [];
  /** Real Optiboot behavior: a bad command byte makes it exit to the old program. */
  exitOnGarbage = true;
  private commandCount = 0;
  private pendingResetGlitch: number[] = [];

  constructor() {
    for (let i = BOOTLOADER_START; i < 0x8000; i++) this.flash[i] = 0xb0; // recognizable bootloader bytes
    this.tx.push(...this.noise);
  }

  async setSignals(dtr: boolean): Promise<void> {
    if (dtr && !this.dtr) {
      // DTR asserted: the board resets into the bootloader.
      this.inBootloader = true;
      this.started = false;
      this.rx = [];
      this.hold = [];
      this.resetAt = this.now;
      this.lastRx = this.now;
      this.commandCount = 0;
      this.pendingResetGlitch = [...this.resetGlitch];
    }
    this.dtr = dtr;
  }
  private advance(ms: number): void {
    this.now += ms;
    const t = this.now - this.resetAt;
    if (this.inBootloader && t >= FakeOptiboot.LISTEN_MS && this.hold.length) {
      this.rx.push(...this.hold.splice(0));
      this.lastRx = this.now;
      this.process();
    }
    if (this.inBootloader && t >= FakeOptiboot.LISTEN_MS && this.now - Math.max(this.lastRx, this.resetAt + FakeOptiboot.LISTEN_MS) > 1000) {
      this.inBootloader = false; // watchdog timeout: start the old program
    }
  }
  async sleep(ms: number): Promise<void> {
    this.advance(ms);
  }
  async drain(): Promise<void> {
    this.tx = [];
  }
  async read(n: number, timeoutMs: number): Promise<Uint8Array> {
    this.advance(1);
    if (this.tx.length < n) this.advance(timeoutMs);
    if (this.tx.length < n) throw new UploadError('Timed out waiting for the board.');
    return new Uint8Array(this.tx.splice(0, n));
  }
  async write(data: Uint8Array): Promise<void> {
    if (this.pendingResetGlitch.length) this.tx.push(...this.pendingResetGlitch.splice(0));
    this.advance(Math.ceil(data.length / 11)); // ~11 bytes per ms at 115200 baud
    if (!this.inBootloader) return; // the sketch ignores us
    const t = this.now - this.resetAt;
    if (t < FakeOptiboot.STARTUP_MS) return; // chip still starting: bytes are lost
    if (t < FakeOptiboot.LISTEN_MS) {
      // LED blink: the UART buffers 3 bytes, the rest overrun and are lost.
      for (const b of data) if (this.hold.length < 3) this.hold.push(b);
      return;
    }
    this.rx.push(...data);
    this.lastRx = this.now;
    this.process();
  }

  private process(): void {
    for (;;) {
      const r = this.rx;
      if (!r.length) return;
      const need = this.commandLength(r);
      if (need === null || r.length < need) return;
      const cmd = r.splice(0, need);
      if (cmd[cmd.length - 1] !== 0x20) {
        if (this.exitOnGarbage) {
          this.inBootloader = false; // watchdog reset -> old program
          return;
        }
        this.tx.push(0x15); // STK_NOSYNC
        continue;
      }
      this.commandCount++;
      const glitch = this.glitchBeforeReply.get(this.commandCount);
      if (glitch) this.tx.push(...glitch);
      this.tx.push(0x14);
      switch (cmd[0]) {
        case 0x30: case 0x50: break;
        case 0x51: this.inBootloader = false; this.started = true; break;
        case 0x75: this.tx.push(...this.signature); break;
        case 0x55: this.addr = (cmd[1] | (cmd[2] << 8)) * 2; break;
        case 0x64: {
          const len = (cmd[1] << 8) | cmd[2];
          for (let i = 0; i < len; i++) {
            const a = this.addr + i;
            // Optiboot can't write its own section (lock bits); count any attempt.
            if (a >= BOOTLOADER_START) this.bootWriteAttempts++;
            else this.flash[a] = cmd[4 + i];
          }
          break;
        }
        case 0x74: {
          const len = (cmd[1] << 8) | cmd[2];
          this.tx.push(...this.flash.subarray(this.addr, this.addr + len));
          break;
        }
      }
      this.tx.push(0x10);
    }
  }

  private commandLength(r: number[]): number | null {
    switch (r[0]) {
      case 0x30: case 0x50: case 0x51: case 0x75: return 2;
      case 0x55: return 4;
      case 0x74: return 5;
      case 0x64: return r.length < 3 ? null : 5 + ((r[1] << 8) | r[2]);
      default: return 2;
    }
  }
}

function build(id: string): Uint8Array {
  const res = assemble(EXAMPLES.find((e) => e.id === id)!.source);
  expect(res.ok).toBe(true);
  return wordsToBytes(res.flash, res.size);
}

describe('STK500 upload to Optiboot', () => {
  it('uploads, verifies and starts an example without touching the bootloader', async () => {
    const board = new FakeOptiboot();
    const image = build('usart');
    const phases: string[] = [];
    await new Stk500(board).upload(image, (p) => phases.push(p.phase));
    expect([...board.flash.subarray(0, image.length)]).toEqual([...image]);
    expect(board.flash.subarray(BOOTLOADER_START).every((b) => b === 0xb0)).toBe(true);
    expect(board.bootWriteAttempts).toBe(0);
    expect(board.started).toBe(true);
    expect(phases[0]).toBe('reset');
    expect(phases.at(-1)).toBe('done');
  });

  it('refuses a program that would reach the bootloader, before sending anything', async () => {
    const board = new FakeOptiboot();
    const res = assemble(`.org 0x3F00\n  nop\n`); // word 0x3F00 = byte 0x7E00
    expect(res.ok).toBe(true);
    const image = wordsToBytes(res.flash, res.size);
    await expect(new Stk500(board).upload(image)).rejects.toThrow(/bootloader/);
    expect(board.inBootloader).toBe(false); // never even reset
    expect(() => checkImage(new Uint8Array(BOOTLOADER_START))).not.toThrow();
    expect(() => checkImage(new Uint8Array(BOOTLOADER_START + 1))).toThrow(UploadError);
  });

  it('rejects a chip that is not an ATmega328', async () => {
    const board = new FakeOptiboot();
    board.signature = [0x1e, 0x98, 0x01]; // ATmega2560
    await expect(new Stk500(board).upload(build('blink'))).rejects.toThrow(/Unexpected chip signature/);
    expect(board.flash.subarray(0, 16).every((b) => b === 0xff)).toBe(true);
  });

  it('reports a clear error when the board never answers', async () => {
    const board = new FakeOptiboot();
    board.setSignals = async () => {}; // reset line not connected
    await expect(new Stk500(board).upload(build('blink'))).rejects.toThrow(/No answer from the bootloader/);
  });

  it('recovers from a stray 0x00 before a reply (seen on a real Uno)', async () => {
    const board = new FakeOptiboot();
    // Command 1-3 are the sync requests; 4 is the confirming sync; 5 is READ_SIGN.
    board.glitchBeforeReply.set(5, [0x00]);
    const log: string[] = [];
    const image = build('blink');
    await new Stk500(board, (m) => log.push(m)).upload(image);
    expect([...board.flash.subarray(0, image.length)]).toEqual([...image]);
    expect(log.some((l) => l.includes('Re-syncing'))).toBe(true);
  });

  it('ignores noise on the line right after reset', async () => {
    const board = new FakeOptiboot();
    board.resetGlitch = [0x00, 0xf8, 0x00];
    const image = build('timer1');
    await new Stk500(board).upload(image);
    expect([...board.flash.subarray(0, image.length)]).toEqual([...image]);
  });

  it('resets again if the bootloader quit to the old program', async () => {
    const board = new FakeOptiboot();
    const realWrite = board.write.bind(board);
    let first = true;
    board.write = async (data) => {
      if (first && board.inBootloader) {
        first = false;
        return realWrite(new Uint8Array([0x00, 0x00])); // garbage: Optiboot exits
      }
      return realWrite(data);
    };
    const image = build('blink');
    await new Stk500(board).upload(image);
    expect([...board.flash.subarray(0, image.length)]).toEqual([...image]);
    expect(board.started).toBe(true);
  });
});
