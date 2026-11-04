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
      throw new UploadError(`Bootloader out of sync (got 0x${head[0].toString(16)} instead of 0x14).`);
    }
    const body = replyLen ? await this.t.read(replyLen, timeout) : new Uint8Array(0);
    const tail = await this.t.read(1, timeout);
    if (tail[0] !== STK_OK) throw new UploadError(`Bootloader reported an error (0x${tail[0].toString(16)}).`);
    return body;
  }

  /** Pulse DTR/RTS so the board resets into its bootloader. */
  async reset(): Promise<void> {
    await this.t.setSignals(false, false);
    await this.t.sleep(250);
    await this.t.setSignals(true, true);
    await this.t.sleep(50);
    await this.t.drain();
  }

  async sync(attempts = 10): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        await this.t.drain();
        await this.command([STK_GET_SYNC], 0, 200);
        return;
      } catch {
        await this.t.sleep(50);
      }
    }
    throw new UploadError(
      'No answer from the bootloader. Check that the right port is selected, nothing else (Arduino IDE serial ' +
        'monitor) has it open, and try the other upload speed.',
    );
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

    onProgress({ phase: 'reset', done: 0, total: pages });
    await this.reset();
    onProgress({ phase: 'sync', done: 0, total: pages });
    await this.sync();
    const sig = await this.readSignature();
    const sigText = sig.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    if (sameBytes(sig, SIG_328)) this.log(`Signature ${sigText}: ATmega328 (non-P). Continuing.`);
    else if (!sameBytes(sig, SIG_328P)) {
      throw new UploadError(`Unexpected chip signature ${sigText}. This uploader only supports the ATmega328P (Arduino Uno).`);
    } else this.log(`Signature ${sigText}: ATmega328P`);

    await this.command([STK_ENTER_PROGMODE]);
    for (let p = 0; p < pages; p++) {
      await this.writePage(p * PAGE_SIZE, padded.subarray(p * PAGE_SIZE, (p + 1) * PAGE_SIZE));
      onProgress({ phase: 'write', done: p + 1, total: pages });
    }
    for (let p = 0; p < pages; p++) {
      const got = await this.readPage(p * PAGE_SIZE, PAGE_SIZE);
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

function sameBytes(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
