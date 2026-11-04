// Uploads a program to an Arduino Uno through its bootloader (Optiboot), using the
// STK500v1 protocol, the same one avrdude uses with `-c arduino`.
//
// Safety: only the application section is written. The bootloader lives in the last
// 512 bytes of flash (byte 0x7E00 and up), and any program reaching that area is refused
// before anything is sent. Fuses and lock bits are never touched.

/** First byte address of the Optiboot bootloader on the Uno. */
export const BOOTLOADER_START = 0x7e00;
export const PAGE_SIZE = 128; // bytes per flash page on the ATmega328P

const STK_OK = 0x10;
const STK_INSYNC = 0x14;
const CRC_EOP = 0x20;
const STK_GET_SYNC = 0x30;
const STK_ENTER_PROGMODE = 0x50;
const STK_LEAVE_PROGMODE = 0x51;
const STK_LOAD_ADDRESS = 0x55;
const STK_PROG_PAGE = 0x64;
const STK_READ_PAGE = 0x74;
const STK_READ_SIGN = 0x75;

const SIG_328P = [0x1e, 0x95, 0x0f];
const SIG_328 = [0x1e, 0x95, 0x14];

/** Byte stream to the board (WebSerial in the browser, a fake bootloader in tests). */
export interface Transport {
  write(data: Uint8Array): Promise<void>;
  /** Read exactly `n` bytes, or throw on timeout. */
  read(n: number, timeoutMs: number): Promise<Uint8Array>;
  /** Discard any bytes received so far. */
  drain(): Promise<void>;
  /** Set the DTR and RTS lines (true = asserted). */
  setSignals(dtr: boolean, rts: boolean): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export class UploadError extends Error {}

export interface UploadProgress {
  phase: 'reset' | 'sync' | 'write' | 'verify' | 'done';
  done: number;
  total: number;
  message?: string;
}

/** Convert flash words (as produced by the assembler) to bytes, little-endian. */
export function wordsToBytes(words: Uint16Array, size: number): Uint8Array {
  const out = new Uint8Array(size * 2);
  for (let i = 0; i < size; i++) {
    out[i * 2] = words[i] & 0xff;
    out[i * 2 + 1] = words[i] >> 8;
  }
  return out;
}

/** Throws if the image would touch the bootloader. */
export function checkImage(image: Uint8Array): void {
  if (image.length === 0) throw new UploadError('The program is empty.');
  if (image.length > BOOTLOADER_START) {
    throw new UploadError(
      `The program is ${image.length} bytes but only ${BOOTLOADER_START} bytes are free below the bootloader ` +
        `(0x${BOOTLOADER_START.toString(16).toUpperCase()}). Nothing was uploaded.`,
    );
  }
}

export class Stk500 {
  constructor(
    private readonly t: Transport,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  private async command(bytes: number[], replyLen = 0, timeout = 500): Promise<Uint8Array> {
    await this.t.write(new Uint8Array([...bytes, CRC_EOP]));
    const head = await this.t.read(1, timeout);
    if (head[0] !== STK_INSYNC) {
      const rest = await this.quiet();
      throw new UploadError(`Bootloader out of sync (received ${hexBytes([head[0], ...rest])} instead of 14).`);
    }
    const body = replyLen ? await this.t.read(replyLen, timeout) : new Uint8Array(0);
    const tail = await this.t.read(1, timeout);
    if (tail[0] !== STK_OK) {
      const rest = await this.quiet();
      throw new UploadError(`Bootloader reported an error (received ${hexBytes([tail[0], ...rest])} instead of 10).`);
    }
    return body;
  }

  /** Read and discard bytes until the line has been quiet for a moment. Returns what was dropped. */
  private async quiet(silenceMs = 40, maxBytes = 512): Promise<number[]> {
    const dropped: number[] = [];
    while (dropped.length < maxBytes) {
      try {
        dropped.push((await this.t.read(1, silenceMs))[0]);
      } catch {
        break;
      }
    }
    return dropped;
  }

  /** Pulse DTR/RTS so the board resets into its bootloader (same timing as avrdude). */
  async reset(): Promise<void> {
    await this.t.setSignals(false, false);
    await this.t.sleep(250);
    await this.t.setSignals(true, true);
    await this.t.sleep(50);
  }

  /**
   * Get in sync with the bootloader.
   *
   * After a reset the Uno needs ~65 ms to start, then Optiboot blinks the LED for ~375 ms. During
   * the blink it can only buffer about 3 received bytes, and if it then reads a broken command it
   * gives up and starts the old program. So: wait like avrdude does, send ONE sync request at a
   * time, and give it plenty of time to answer before sending another. Noise bytes on the line
   * (often a 0x00 from the reset) are skipped while scanning for the INSYNC/OK pair.
   */
  async sync(attempts = 8, firstWaitMs = 250): Promise<void> {
    const req = new Uint8Array([STK_GET_SYNC, CRC_EOP]);
    if (firstWaitMs > 0) await this.quiet(firstWaitMs); // also drops noise from the reset
    let seen: number[] = [];
    for (let i = 0; i < attempts; i++) {
      await this.t.write(req);
      seen = [];
      let synced = false;
      try {
        // The first answer can take until the LED blinking ends (~450 ms after reset).
        const timeout = i === 0 ? 600 : 300;
        while (seen.length < 16 && !synced) {
          seen.push((await this.t.read(1, timeout))[0]);
          const n = seen.length;
          synced = n >= 2 && seen[n - 2] === STK_INSYNC && seen[n - 1] === STK_OK;
        }
      } catch {
        /* no answer yet */
      }
      if (synced) {
        await this.quiet(); // drop late replies to earlier requests
        try {
          await this.command([STK_GET_SYNC], 0, 300);
          return;
        } catch {
          /* still noisy: keep trying */
        }
      }
    }
    throw new UploadError(
      'No answer from the bootloader' + (seen.length ? ` (last bytes received: ${hexBytes(seen)})` : ', nothing was received') +
        '. Check that the right port is selected and that nothing else (like the Arduino IDE serial monitor) has it open. ' +
        'If it keeps failing, press the board\'s reset button right after clicking Upload.',
    );
  }

  /** Run a bootloader operation, re-syncing and retrying if the line glitches. */
  private async retry<T>(what: string, op: () => Promise<T>, tries = 3): Promise<T> {
    for (let i = 1; ; i++) {
      try {
        return await op();
      } catch (e) {
        if (i >= tries || !(e instanceof UploadError)) throw e;
        this.log(`${what}: ${e.message} Re-syncing and retrying…`);
        await this.quiet();
        await this.sync(5, 0);
      }
    }
  }

  async readSignature(): Promise<number[]> {
    return [...(await this.command([STK_READ_SIGN], 3))];
  }

  private async loadAddress(byteAddr: number): Promise<void> {
    const w = byteAddr >> 1; // the bootloader takes word addresses
    await this.command([STK_LOAD_ADDRESS, w & 0xff, (w >> 8) & 0xff]);
  }

  private async writePage(byteAddr: number, data: Uint8Array): Promise<void> {
    if (byteAddr + data.length > BOOTLOADER_START) throw new UploadError('Refusing to write into the bootloader area.');
    await this.loadAddress(byteAddr);
    await this.command([STK_PROG_PAGE, data.length >> 8, data.length & 0xff, 0x46 /* 'F' flash */, ...data], 0, 1000);
  }

  private async readPage(byteAddr: number, len: number): Promise<Uint8Array> {
    await this.loadAddress(byteAddr);
    return this.command([STK_READ_PAGE, len >> 8, len & 0xff, 0x46], len, 1000);
  }

  /** Full upload: reset, sync, check the chip, write, verify, start the program. */
  async upload(image: Uint8Array, onProgress: (p: UploadProgress) => void = () => {}): Promise<void> {
    checkImage(image);
    const pages = Math.ceil(image.length / PAGE_SIZE);
    const padded = new Uint8Array(pages * PAGE_SIZE).fill(0xff);
    padded.set(image);

    // If noise made Optiboot give up and start the old program, a second reset brings it back.
    for (let attempt = 1; ; attempt++) {
      onProgress({ phase: 'reset', done: 0, total: pages });
      await this.reset();
      onProgress({ phase: 'sync', done: 0, total: pages });
      try {
        await this.sync();
        break;
      } catch (e) {
        if (attempt >= 2) throw e;
        this.log(`${(e as Error).message} Resetting again…`);
      }
    }
    this.log('In sync with the bootloader.');
    const sig = await this.retry('Reading signature', () => this.readSignature());
    const sigText = sig.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    if (sameBytes(sig, SIG_328)) this.log(`Signature ${sigText}: ATmega328 (non-P). Continuing.`);
    else if (!sameBytes(sig, SIG_328P)) {
      throw new UploadError(`Unexpected chip signature ${sigText}. This uploader only supports the ATmega328P (Arduino Uno).`);
    } else this.log(`Signature ${sigText}: ATmega328P`);

    await this.retry('Entering programming mode', () => this.command([STK_ENTER_PROGMODE]));
    for (let p = 0; p < pages; p++) {
      const page = padded.subarray(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
      await this.retry(`Writing page ${p + 1}`, () => this.writePage(p * PAGE_SIZE, page));
      onProgress({ phase: 'write', done: p + 1, total: pages });
    }
    for (let p = 0; p < pages; p++) {
      const got = await this.retry(`Reading page ${p + 1}`, () => this.readPage(p * PAGE_SIZE, PAGE_SIZE));
      const want = padded.subarray(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
      for (let i = 0; i < PAGE_SIZE; i++) {
        if (got[i] !== want[i]) {
          const a = p * PAGE_SIZE + i;
          throw new UploadError(
            `Verify failed at byte 0x${a.toString(16)}: wrote 0x${want[i].toString(16)}, read 0x${got[i].toString(16)}.`,
          );
        }
      }
      onProgress({ phase: 'verify', done: p + 1, total: pages });
    }
    // Leaving programming mode makes Optiboot start the new program.
    await this.command([STK_LEAVE_PROGMODE]);
    onProgress({ phase: 'done', done: pages, total: pages });
  }
}

function hexBytes(bytes: number[]): string {
  return bytes.slice(0, 24).map((b) => b.toString(16).padStart(2, '0')).join(' ') + (bytes.length > 24 ? ' …' : '');
}

function sameBytes(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
