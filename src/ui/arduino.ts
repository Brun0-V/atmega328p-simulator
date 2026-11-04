import { Stk500, UploadError, checkImage } from '../upload/stk500';
import { SerialConnection, describePort, requestPort, webSerialSupported, type SerialPortLike } from '../upload/webserial';
import { h, setText } from './dom';

/** Returns the program bytes to upload, or throws with a message for the user. */
export type ImageProvider = () => Uint8Array;

const MONITOR_BAUDS = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];

/** Floating window: upload the assembled program to an Arduino Uno over Web Serial. */
export class ArduinoWindow {
  readonly el: HTMLDialogElement;
  private port: SerialPortLike | null = null;
  private conn: SerialConnection | null = null;
  private busy = false;

  private portLabel = h('span', { class: 'mono' }, 'no port selected');
  private speedSel = h('select', { title: 'Bootloader speed. Uno (Optiboot) = 115200, older boards/Nano old bootloader = 57600.' },
    h('option', { value: 'auto' }, 'Auto (115200, then 57600)'),
    h('option', { value: '115200' }, '115200 (Uno, Optiboot)'),
    h('option', { value: '57600' }, '57600 (old bootloader)'));
  private uploadBtn = h('button', { class: 'btn primary' }, 'Upload');
  private portBtn = h('button', { class: 'btn' }, 'Choose port…');
  private progress = h('div', { class: 'bar' }, h('div', { class: 'bar-fill' }));
  private status = h('div', { class: 'small' });
  private log = h('pre', { class: 'upload-log' });

  private monBaud = h('select', { title: 'Serial monitor baud rate (must match UBRR in your program)' },
    ...MONITOR_BAUDS.map((b) => h('option', { value: String(b) }, `${b} baud`)));
  private monBtn = h('button', { class: 'btn' }, 'Open monitor');
  private monOut = h('pre', { class: 'console board-console' });
  private monIn = h('input', { class: 'console-input', placeholder: 'Send to the board (Enter)…', spellcheck: 'false' });
  private monText = '';

  constructor(private getImage: ImageProvider) {
    this.monBaud.value = '9600';
    const supported = webSerialSupported();
    const body = supported
      ? h('div', {},
          h('p', { class: 'muted small' },
            'Uploads through the Uno’s bootloader, like the Arduino IDE. The bootloader (last 512 bytes of flash) is never written, ',
            'fuses are never touched, and every page is read back and verified.'),
          h('div', { class: 'row' }, this.portBtn, this.portLabel),
          h('div', { class: 'row' }, h('label', { class: 'field' }, 'Bootloader', this.speedSel), this.uploadBtn),
          this.progress,
          this.status,
          this.log,
          h('h3', {}, 'Board serial monitor'),
          h('div', { class: 'row' }, this.monBaud, this.monBtn,
            h('button', { class: 'btn small', onclick: () => this.setMon('') }, 'Clear')),
          this.monOut,
          this.monIn)
      : h('div', {},
          h('p', {}, 'Your browser does not support Web Serial.'),
          h('p', { class: 'muted' }, 'Use Chrome, Edge or Opera on a desktop computer to upload to an Arduino.'));

    this.el = h('dialog', { class: 'arduino-window' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Upload to Arduino Uno'),
        h('button', { class: 'btn ghost close', title: 'Close', onclick: () => this.hide() }, '×')),
      body);

    this.portBtn.addEventListener('click', () => this.choosePort());
    this.uploadBtn.addEventListener('click', () => this.upload());
    this.monBtn.addEventListener('click', () => this.toggleMonitor());
    this.monIn.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter' || !this.conn) return;
      void this.conn.write(new TextEncoder().encode(this.monIn.value + '\n'));
      this.monIn.value = '';
    });
    this.updateButtons();
  }

  show(): void {
    if (!this.el.open) this.el.show();
  }
  hide(): void {
    this.el.close();
  }

  private say(msg: string, kind: '' | 'ok' | 'err' = ''): void {
    setText(this.status, msg);
    this.status.className = `small ${kind}`;
  }
  private addLog(msg: string): void {
    this.log.textContent += msg + '\n';
    this.log.scrollTop = this.log.scrollHeight;
  }
  private setProgress(frac: number): void {
    (this.progress.firstChild as HTMLElement).style.width = `${Math.round(frac * 100)}%`;
  }
  private setMon(text: string): void {
    this.monText = text;
    this.monOut.textContent = text;
    this.monOut.scrollTop = this.monOut.scrollHeight;
  }

  private updateButtons(): void {
    this.uploadBtn.disabled = this.busy || !this.port;
    this.portBtn.disabled = this.busy;
    this.monBtn.disabled = this.busy || !this.port;
    setText(this.monBtn, this.conn ? 'Close monitor' : 'Open monitor');
  }

  private async choosePort(): Promise<void> {
    try {
      await this.closeConn();
      this.port = await requestPort();
      setText(this.portLabel, describePort(this.port));
      this.say('');
    } catch (e) {
      if ((e as Error).name !== 'NotFoundError') this.say((e as Error).message, 'err');
    }
    this.updateButtons();
  }

  private async closeConn(): Promise<void> {
    const c = this.conn;
    this.conn = null;
    if (c) await c.close();
  }

  private async upload(): Promise<void> {
    if (!this.port || this.busy) return;
    let image: Uint8Array;
    try {
      image = this.getImage();
      checkImage(image);
    } catch (e) {
      this.say((e as Error).message, 'err');
      return;
    }
    this.busy = true;
    this.updateButtons();
    this.log.textContent = '';
    this.setProgress(0);
    await this.closeConn();
    const speeds = this.speedSel.value === 'auto' ? [115200, 57600] : [Number(this.speedSel.value)];
    let lastErr: unknown = null;
    for (const baud of speeds) {
      let conn: SerialConnection | null = null;
      try {
        this.addLog(`Opening port at ${baud} baud…`);
        conn = await SerialConnection.open(this.port, baud);
        const stk = new Stk500(conn, (m) => this.addLog(m));
        this.say('Resetting the board…');
        await stk.upload(image, (p) => {
          const labels = { reset: 'Resetting…', sync: 'Waiting for bootloader…', write: 'Writing', verify: 'Verifying', done: 'Done' };
          if (p.phase === 'write') this.setProgress((p.done / p.total) * 0.5);
          if (p.phase === 'verify') this.setProgress(0.5 + (p.done / p.total) * 0.5);
          this.say(`${labels[p.phase]}${p.phase === 'write' || p.phase === 'verify' ? ` page ${p.done}/${p.total}` : ''}`);
        });
        this.setProgress(1);
        this.addLog(`Wrote and verified ${image.length} bytes. The program is running.`);
        this.say(`Uploaded ${image.length} bytes and verified. The program is running on the board.`, 'ok');
        lastErr = null;
        await conn.close();
        break;
      } catch (e) {
        lastErr = e;
        this.addLog(`Failed at ${baud} baud: ${(e as Error).message}`);
        if (conn) await conn.close();
      }
    }
    if (lastErr) {
      this.say(lastErr instanceof UploadError ? lastErr.message : `Upload failed: ${(lastErr as Error).message}`, 'err');
    }
    this.busy = false;
    this.updateButtons();
  }

  private async toggleMonitor(): Promise<void> {
    if (!this.port) return;
    if (this.conn) {
      await this.closeConn();
      this.updateButtons();
      return;
    }
    try {
      const conn = await SerialConnection.open(this.port, Number(this.monBaud.value));
      const dec = new TextDecoder();
      conn.onData = (bytes) => {
        let t = this.monText + dec.decode(bytes, { stream: true }).replace(/\r\n?/g, '\n');
        if (t.length > 20000) t = t.slice(-15000);
        this.setMon(t);
      };
      this.conn = conn;
      this.say(`Monitor open at ${this.monBaud.value} baud. Opening the port resets the Uno, so the program restarts.`);
    } catch (e) {
      this.say((e as Error).message, 'err');
    }
    this.updateButtons();
  }
}
