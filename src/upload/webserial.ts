import { UploadError, type Transport } from './stk500';

// Minimal Web Serial API types (not yet in TypeScript's DOM library).
export interface SerialPortLike {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}
interface SerialLike {
  requestPort(options?: { filters?: { usbVendorId: number }[] }): Promise<SerialPortLike>;
}

export function webSerialSupported(): boolean {
  return 'serial' in navigator;
}

export async function requestPort(): Promise<SerialPortLike> {
  const serial = (navigator as unknown as { serial: SerialLike }).serial;
  return serial.requestPort();
}

const USB_NAMES: Record<number, string> = {
  0x2341: 'Arduino', 0x2a03: 'Arduino', 0x1a86: 'CH340', 0x0403: 'FTDI', 0x10c4: 'CP210x',
};
export function describePort(port: SerialPortLike): string {
  const { usbVendorId: v, usbProductId: p } = port.getInfo();
  if (v === undefined) return 'Serial port';
  const hex = (n: number) => n.toString(16).padStart(4, '0');
  return `${USB_NAMES[v] ?? 'USB serial'} (${hex(v)}:${hex(p ?? 0)})`;
}

/** An open serial connection with a background reader that buffers incoming bytes. */
export class SerialConnection implements Transport {
  private buf: number[] = [];
  private waiters: (() => void)[] = [];
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private closed = false;
  private readLoop: Promise<void> | null = null;
  /** Called with every chunk received (used by the serial monitor). */
  onData: ((bytes: Uint8Array) => void) | null = null;

  private constructor(readonly port: SerialPortLike) {}

  static async open(port: SerialPortLike, baudRate: number): Promise<SerialConnection> {
    try {
      await port.open({ baudRate });
    } catch (e) {
      throw new UploadError(
        `Could not open the port (${(e as Error).message}). Close any other program using it, like the Arduino IDE serial monitor.`,
      );
    }
    const c = new SerialConnection(port);
    c.writer = port.writable!.getWriter();
    c.reader = port.readable!.getReader();
    c.readLoop = c.pump();
    return c;
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await this.reader!.read();
        if (done) break;
        if (value) {
          if (this.onData) this.onData(value);
          else for (const b of value) this.buf.push(b);
          for (const w of this.waiters.splice(0)) w();
        }
      }
    } catch {
      /* port closed or unplugged */
    }
    this.closed = true;
    for (const w of this.waiters.splice(0)) w();
  }

  async write(data: Uint8Array): Promise<void> {
    await this.writer!.write(data);
  }

  async read(n: number, timeoutMs: number): Promise<Uint8Array> {
    const deadline = performance.now() + timeoutMs;
    while (this.buf.length < n) {
      if (this.closed) throw new UploadError('The serial port was closed.');
      const left = deadline - performance.now();
      if (left <= 0) throw new UploadError('Timed out waiting for the board.');
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    return new Uint8Array(this.buf.splice(0, n));
  }

  async drain(): Promise<void> {
    await this.sleep(10);
    this.buf.length = 0;
  }

  async setSignals(dtr: boolean, rts: boolean): Promise<void> {
    await this.port.setSignals({ dataTerminalReady: dtr, requestToSend: rts });
  }

  sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  async close(): Promise<void> {
    try {
      await this.reader?.cancel();
    } catch {
      /* ignore */
    }
    await this.readLoop;
    this.reader?.releaseLock();
    try {
      await this.writer?.close();
    } catch {
      /* ignore */
    }
    this.writer?.releaseLock();
    try {
      await this.port.close();
    } catch {
      /* already closed */
    }
  }
}
