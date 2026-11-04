import './style.css';
import iconUrl from '../assets/icon.svg';
import { assemble, type AsmResult } from './core/assembler';
import { ATmega328P, type StopReason } from './core/mcu';
import { EXAMPLES } from './examples';
import { wordsToBytes } from './upload/stk500';
import { ArduinoWindow } from './ui/arduino';
import { TimingChart } from './ui/chart';
import { formatHz, h, setClass, setText } from './ui/dom';
import { AsmEditor } from './ui/editor';
import { MemoryPanel } from './ui/memory';
import {
  CpuPanel, InterruptsPanel, PortsPanel, RegistersPanel, TimersPanel, UsartPanel, type Panel, type RenderCtx,
} from './ui/panels';

// ---------------------------------------------------------------------------
// Settings persisted in localStorage

const STORE_KEY = 'atmega328p-sim:v1';
interface Saved {
  source?: string;
  example?: string;
  speed?: string;
  fcpu?: number;
  pins?: string[];
  window?: number;
  breakpoints?: number[];
}
const saved: Saved = (() => {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
  } catch {
    return {};
  }
})();
let saveTimer = 0;
function save(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const data: Saved = {
      source: editor.text,
      example: exampleSel.value,
      speed: speedSel.value,
      fcpu: mcu.frequency,
      pins: chart.pins,
      window: chart.window,
      breakpoints: editor.breakpointLines(),
    };
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
    } catch {
      /* storage full or disabled */
    }
  }, 300);
}

// ---------------------------------------------------------------------------
// State

const mcu = new ATmega328P();
if (saved.fcpu && saved.fcpu > 0) mcu.frequency = saved.fcpu;
let asm: AsmResult | null = null;
let loadedSource = '';
let breakpointAddrs = new Set<number>();
let running = false;
/** Run at full speed until this returns true (step over / step out). */
let runUntil: (() => boolean) | null = null;
let runLabel = '';
let budget = 0;
let lastFrame = 0;
let prevSnapshot: Uint8Array | null = null;
let prevPc: number | null = null;
let statusMsg: { text: string; kind: '' | 'ok' | 'warn' | 'err' } = { text: '', kind: '' };
let speedSample = { t: performance.now(), cycles: 0, hz: 0 };

const SPEEDS: [string, string][] = [
  ['1', '1 Hz'], ['2', '2 Hz'], ['5', '5 Hz'], ['10', '10 Hz'], ['50', '50 Hz'], ['100', '100 Hz'],
  ['1000', '1 kHz'], ['10000', '10 kHz'], ['100000', '100 kHz'], ['1000000', '1 MHz'],
  ['realtime', 'Real time'], ['max', 'Max'],
];

// ---------------------------------------------------------------------------
// Toolbar

const exampleSel = h('select', { title: 'Load an example program' },
  h('option', { value: '' }, 'Examples…'),
  ...EXAMPLES.map((e) => h('option', { value: e.id }, e.title)));
const speedSel = h('select', { title: 'Simulated clock speed while running (CPU cycles per second)' },
  ...SPEEDS.map(([v, l]) => h('option', { value: v }, l)));
speedSel.value = SPEEDS.some(([v]) => v === saved.speed) ? saved.speed! : 'realtime';
const fcpuInput = h('input', {
  class: 'fcpu', type: 'number', min: '0.001', max: '32', step: 'any', value: String(mcu.frequency / 1e6),
  title: 'Oscillator frequency F_CPU in MHz. Used for time, baud rate and the "Real time" speed.',
});

const btnAssemble = h('button', { class: 'btn primary', title: 'Assemble the source and reset the MCU (Ctrl+Enter)', onclick: () => doAssemble() }, 'Assemble & Reset');
const btnStep = h('button', { class: 'btn', title: 'Execute one instruction (F10)', onclick: () => doStep() }, 'Step');
const btnOver = h('button', { class: 'btn', title: 'Step over calls: run until the call returns (Shift+F10)', onclick: () => doStepOver() }, 'Step over');
const btnOut = h('button', { class: 'btn', title: 'Run until the current subroutine returns (Ctrl+F10)', onclick: () => doStepOut() }, 'Step out');
const btnRun = h('button', { class: 'btn run', title: 'Run / pause (F5)', onclick: () => (running ? stop('paused') : start()) }, 'Run');
const btnReset = h('button', { class: 'btn', title: 'Reset the MCU (keeps the program)', onclick: () => doReset() }, 'Reset');
const statusPill = h('span', { class: 'pill' }, 'READY');
const speedText = h('span', { class: 'muted small speed-text' });
const helpBtn = h('button', { class: 'btn ghost', title: 'Help', onclick: () => helpDialog.showModal() }, '?');
const btnArduino = h('button', {
  class: 'btn arduino',
  title: 'Upload the program to a real Arduino Uno over USB (Web Serial)',
  onclick: () => arduino.show(),
}, 'Upload to Arduino');
exampleSel.classList.add('example-sel');

const toolbar = h('header', { class: 'toolbar' },
  h('div', { class: 'brand' }, h('img', { src: iconUrl, alt: '' }), h('div', {}, h('b', {}, 'ATmega328P'), h('span', {}, ' Simulator'))),
  exampleSel,
  h('div', { class: 'btn-group' }, btnAssemble, btnArduino),
  h('div', { class: 'btn-group' }, btnStep, btnOver, btnOut, btnRun, btnReset),
  h('label', { class: 'field' }, 'Clock', speedSel),
  h('label', { class: 'field' }, 'F_CPU', fcpuInput, h('span', { class: 'muted' }, 'MHz')),
  h('div', { class: 'status' }, statusPill, speedText),
  helpBtn,
);

// ---------------------------------------------------------------------------
// Editor and panels

const editorHost = h('div', { class: 'editor-host' });
const modifiedBadge = h('span', { class: 'badge warn', style: 'display:none', title: 'The running program is from the last assembly' }, 'modified — press Assemble');
const messagesEl = h('div', { class: 'messages' });
const editorPanel = h('section', { class: 'panel editor-panel' },
  h('div', { class: 'panel-head' }, h('h2', {}, 'Assembly'), modifiedBadge,
    h('span', { class: 'muted small hint' }, 'Click a line number to set a breakpoint')),
  editorHost,
  messagesEl);

const editor = new AsmEditor(editorHost, '', {
  onChange: () => {
    updateModified();
    save();
  },
  onBreakpointsChange: () => {
    computeBreakpoints();
    save();
  },
  keys: [],
});

const onEdit = () => {
  render();
};
const cpuPanel = new CpuPanel(mcu, onEdit);
const regPanel = new RegistersPanel(mcu, onEdit);
const portsPanel = new PortsPanel(mcu, onEdit);
const timersPanel = new TimersPanel(mcu);
const intPanel = new InterruptsPanel(mcu);
const usartPanel = new UsartPanel(mcu);
const memPanel = new MemoryPanel(mcu, onEdit, (line) => editor.goToLine(line));
const chart = new TimingChart(mcu, saved.pins ?? ['PB5'], saved.window ?? 1e5, save);

const panels: Panel[] = [cpuPanel, regPanel, portsPanel, timersPanel, intPanel, usartPanel, memPanel, chart];

const helpDialog = h('dialog', { class: 'help' },
  h('h2', {}, 'ATmega328P Simulator'),
  h('p', {}, 'Write AVR assembly (AVRA / Atmel syntax), assemble it, then step through it or run it. ',
    'All ATmega328P register and bit names from m328Pdef.inc are built in.'),
  h('h3', {}, 'Keyboard'),
  h('table', { class: 'tbl' },
    ...[
      ['Ctrl+Enter', 'Assemble & reset'], ['F10', 'Step one instruction'], ['Shift+F10', 'Step over (calls run to completion)'],
      ['Ctrl+F10', 'Step out of the current subroutine'], ['F5', 'Run / pause'], ['F9', 'Toggle breakpoint on the cursor line'],
      ['Esc', 'Pause'],
    ].map(([k, v]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, v)))),
  h('h3', {}, 'Clock'),
  h('p', {}, '"Clock" sets how many CPU cycles are simulated per second while running. "Real time" runs at F_CPU; ',
    '"Max" runs as fast as your browser allows. F_CPU only changes how cycles convert to time and baud rate.'),
  h('h3', {}, 'Upload to a real Arduino Uno'),
  h('p', {}, '"Upload to Arduino" sends the code in the editor to an Uno over USB using Web Serial (Chrome, Edge or Opera on desktop). ',
    'It goes through the Uno’s bootloader like the Arduino IDE does: the bootloader itself is never written, fuses are never changed, ',
    'and every page is read back and verified. Programs that would reach the bootloader area (byte 0x7E00) are refused.'),
  h('h3', {}, 'What is simulated'),
  h('p', {}, 'The full AVR instruction set of the ATmega328P with cycle counts, SRAM and stack, GPIO ports B/C/D with pull-ups, ',
    'Timer0/1/2 (all waveform modes, compare outputs, input capture, external clock), USART0, INT0/INT1, pin-change interrupts and SLEEP (idle). ',
    'Not simulated: ADC, SPI, TWI, EEPROM, watchdog and self-programming (SPM).'),
  h('form', { method: 'dialog' }, h('button', { class: 'btn primary' }, 'Close')));

// Uploads always use the code currently in the editor.
const arduino = new ArduinoWindow(() => {
  const res = assemble(editor.text);
  if (!res.ok) throw new Error('Fix the assembly errors before uploading.');
  return wordsToBytes(res.flash, res.size);
});

const app = document.getElementById('app')!;
app.append(
  toolbar,
  h('main', { class: 'layout' },
    h('div', { class: 'area-editor' }, editorPanel),
    h('div', { class: 'col area-cpu' }, cpuPanel.el, regPanel.el),
    h('div', { class: 'col area-io' }, portsPanel.el, usartPanel.el),
    h('div', { class: 'area-chart' }, chart.el),
    h('div', { class: 'area-mem' }, memPanel.el),
    h('div', { class: 'col area-periph' }, timersPanel.el, intPanel.el)),
  helpDialog,
  arduino.el,
);

// ---------------------------------------------------------------------------
// Actions

function computeBreakpoints(): void {
  breakpointAddrs = new Set();
  if (!asm) return;
  const lines = [...asm.lineToAddr.keys()].sort((a, b) => a - b);
  for (const l of editor.breakpointLines()) {
    // A breakpoint on a line without code applies to the next line that has code.
    const target = lines.find((x) => x >= l);
    if (target !== undefined) breakpointAddrs.add(asm.lineToAddr.get(target)!);
  }
}

function updateModified(): void {
  const modified = !!asm && editor.text !== loadedSource;
  modifiedBadge.style.display = modified ? '' : 'none';
}

function showMessages(res: AsmResult): void {
  messagesEl.textContent = '';
  const errs = res.messages.filter((m) => m.severity === 'error').length;
  if (errs === 0) {
    const sramEnd = res.symbols.filter((s) => s.kind === 'data').reduce((m, s) => Math.max(m, s.value + 1), 0x100);
    messagesEl.append(h('div', { class: 'msg ok' },
      `Assembled: ${res.size} words (${res.size * 2} bytes) of flash` +
      (sramEnd > 0x100 ? `, SRAM variables up to 0x${sramEnd.toString(16)}` : '') + '.'));
  }
  for (const m of res.messages) {
    messagesEl.append(h('div', {
      class: `msg ${m.severity === 'error' ? 'err' : m.severity === 'warning' ? 'warn' : 'info'}`,
      onclick: () => editor.goToLine(m.line),
      title: 'Go to line',
    }, h('b', {}, `Line ${m.line}: `), m.message));
  }
}

function doAssemble(): void {
  stop(null);
  const src = editor.text;
  const res = assemble(src);
  editor.setDiagnostics(res.messages);
  showMessages(res);
  if (!res.ok) {
    setStatus(`Assembly failed (${res.messages.filter((m) => m.severity === 'error').length} errors)`, 'err');
    render();
    return;
  }
  asm = res;
  loadedSource = src;
  mcu.load(res.flash.subarray(0, res.size));
  editor.setAddresses(res.lineToAddr);
  memPanel.setDataLabels(res.symbols.filter((s) => s.kind === 'data'));
  usartPanel.clear();
  computeBreakpoints();
  updateModified();
  prevSnapshot = null;
  prevPc = null;
  setStatus('Assembled and reset', 'ok');
  chart.redraw();
  render();
}

function doReset(): void {
  stop(null);
  mcu.reset();
  usartPanel.clear();
  prevSnapshot = null;
  prevPc = null;
  setStatus('Reset', '');
  chart.redraw();
  render();
}

function snapshot(): void {
  prevSnapshot = mcu.cpu.data.slice();
  prevPc = mcu.cpu.pc;
}

function checkHalted(): boolean {
  if (mcu.cpu.halted) {
    setStatus(mcu.cpu.halted, 'err');
    return true;
  }
  return false;
}

function doStep(): void {
  if (running) stop('paused');
  if (checkHalted()) return render();
  snapshot();
  const cpu = mcu.cpu;
  if (cpu.sleeping) {
    // Sleeping: advance until an interrupt wakes the CPU.
    const r = mcu.run(16_000_000, undefined, () => !cpu.sleeping);
    setStatus(r === 'condition' ? 'Woke up from sleep' : 'Still sleeping (no interrupt within 16M cycles)', r === 'condition' ? '' : 'warn');
  } else {
    mcu.step();
    if (cpu.breakHit) {
      cpu.breakHit = false;
      setStatus('BREAK instruction', 'warn');
    } else setStatus('', '');
    checkHalted();
  }
  render();
}

function doStepOver(): void {
  if (running) stop('paused');
  const cpu = mcu.cpu;
  const op = cpu.flash[cpu.pc];
  const isCall = (op & 0xf000) === 0xd000 || (op & 0xfe0e) === 0x940e || op === 0x9509;
  if (!isCall) return doStep();
  const ret = cpu.pc + mcu.instructionWords();
  const sp0 = cpu.sp;
  snapshot();
  startFast(() => cpu.pc === ret && cpu.sp >= sp0, 'Step over');
}

function doStepOut(): void {
  if (running) stop('paused');
  const cpu = mcu.cpu;
  const sp0 = cpu.sp;
  snapshot();
  startFast(() => cpu.lastFlow === 'ret' && cpu.sp > sp0, 'Step out');
}

function startFast(until: () => boolean, label: string): void {
  runUntil = until;
  runLabel = label;
  start(true);
}

function start(keepSnapshot = false): void {
  if (checkHalted()) return render();
  if (!keepSnapshot) {
    prevSnapshot = null;
    runUntil = null;
  }
  running = true;
  budget = 0;
  lastFrame = performance.now();
  speedSample = { t: lastFrame, cycles: mcu.cpu.cycles, hz: 0 };
  setStatus('', '');
  requestAnimationFrame(frame);
  render();
}

function stop(reason: StopReason | 'paused' | null): void {
  if (!running && reason !== null) return;
  running = false;
  const wasFast = runUntil !== null;
  runUntil = null;
  if (reason === 'breakpoint') {
    const line = asm?.addrToLine[mcu.cpu.pc];
    setStatus(`Breakpoint${line && line > 0 ? ` at line ${line}` : ''}`, 'warn');
  } else if (reason === 'break') setStatus('BREAK instruction', 'warn');
  else if (reason === 'halted') checkHalted();
  else if (reason === 'condition') setStatus(`${runLabel} done`, '');
  else if (reason === 'paused') {
    setStatus(wasFast ? `${runLabel} interrupted` : 'Paused', '');
    if (!wasFast) prevSnapshot = null;
  }
  render();
}

function currentHz(): number {
  const v = speedSel.value;
  if (v === 'max') return Infinity;
  if (v === 'realtime') return mcu.frequency;
  return Number(v);
}

function frame(now: number): void {
  if (!running) return;
  const dt = Math.min(now - lastFrame, 100) / 1000;
  lastFrame = now;
  const hz = runUntil ? Infinity : currentHz();
  let reason: StopReason = 'budget';
  if (hz === Infinity) {
    const t0 = performance.now();
    do reason = mcu.run(100_000, breakpointAddrs, runUntil ?? undefined);
    while (reason === 'budget' && performance.now() - t0 < 12);
  } else {
    // Accumulate cycles owed by wall-clock time; cap the backlog at 100 ms so we never "catch up" in a burst.
    budget = Math.min(budget + hz * dt, Math.max(1, hz * 0.1));
    const t0 = performance.now();
    // Run in chunks and give the frame back after ~14 ms so a slow machine can't freeze the page.
    while (budget >= 1 && reason === 'budget' && performance.now() - t0 < 14) {
      const c1 = mcu.cpu.cycles;
      reason = mcu.run(Math.min(Math.floor(budget), 200_000), breakpointAddrs);
      budget -= mcu.cpu.cycles - c1;
    }
  }
  if (reason !== 'budget') stop(reason);
  else {
    render();
    requestAnimationFrame(frame);
  }
}

function setStatus(text: string, kind: '' | 'ok' | 'warn' | 'err'): void {
  statusMsg = { text, kind };
}

// ---------------------------------------------------------------------------
// Rendering

function render(): void {
  const cpu = mcu.cpu;
  const ctx: RenderCtx = { mcu, asm, prev: running ? null : prevSnapshot, prevPc, running };
  for (const p of panels) p.render(ctx);

  // Editor current line
  const hz = currentHz();
  const showLine = !running || (!runUntil && hz <= 1000);
  const line = asm ? asm.addrToLine[cpu.pc] : -1;
  const stopped = !running && (statusMsg.text.startsWith('Breakpoint') || !!cpu.halted);
  editor.setPc(showLine && line > 0 ? line : null, stopped ? 'break' : 'pc', !running || hz <= 100);

  // Status
  let pill = 'READY';
  let cls = '';
  if (cpu.halted) {
    pill = 'HALTED';
    cls = 'err';
  } else if (running) {
    pill = cpu.sleeping ? 'SLEEPING' : runUntil ? runLabel.toUpperCase() : 'RUNNING';
    cls = 'run';
  } else if (statusMsg.text.startsWith('Breakpoint')) {
    pill = 'BREAKPOINT';
    cls = 'warn';
  } else if (cpu.sleeping) {
    pill = 'SLEEPING';
    cls = 'warn';
  } else if (statusMsg.text === 'Paused') pill = 'PAUSED';
  setText(statusPill, pill);
  statusPill.className = `pill ${cls}`;

  const now = performance.now();
  if (running && now - speedSample.t > 500) {
    speedSample.hz = ((cpu.cycles - speedSample.cycles) / (now - speedSample.t)) * 1000;
    speedSample = { t: now, cycles: cpu.cycles, hz: speedSample.hz };
  }
  let st = statusMsg.text;
  if (running && speedSample.hz > 0) {
    const target = currentHz();
    const pct = isFinite(target) && !runUntil ? ` (${Math.round((speedSample.hz / target) * 100)}%)` : '';
    st = `${formatHz(speedSample.hz)}${pct}`;
  }
  setText(speedText, st);
  setClass(speedText, 'err', statusMsg.kind === 'err' && !running);
  setClass(speedText, 'warn', statusMsg.kind === 'warn' && !running);

  setText(btnRun, running && !runUntil ? 'Pause' : 'Run');
  setClass(btnRun, 'running', running);
  btnStep.disabled = !asm;
  btnOver.disabled = !asm;
  btnOut.disabled = !asm;
  btnRun.disabled = !asm;
}

// ---------------------------------------------------------------------------
// Events

exampleSel.addEventListener('change', () => {
  const ex = EXAMPLES.find((e) => e.id === exampleSel.value);
  if (!ex) return;
  if (editor.text !== loadedSource && editor.text.trim() && !confirm('Replace your current code with this example?')) {
    exampleSel.value = '';
    return;
  }
  editor.setText(ex.source);
  chart.setPins(ex.pins);
  doAssemble();
  save();
});

speedSel.addEventListener('change', () => {
  budget = 0;
  save();
  render();
});

fcpuInput.addEventListener('change', () => {
  const mhz = Number(fcpuInput.value);
  if (mhz > 0 && mhz <= 32) {
    mcu.frequency = mhz * 1e6;
    save();
    render();
    chart.redraw();
  } else fcpuInput.value = String(mcu.frequency / 1e6);
});

window.addEventListener('keydown', (e) => {
  const inField = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
  let handled = true;
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doAssemble();
  else if (e.key === 'F10' && e.shiftKey) doStepOver();
  else if (e.key === 'F10' && (e.ctrlKey || e.metaKey)) doStepOut();
  else if (e.key === 'F10') doStep();
  else if (e.key === 'F5') running ? stop('paused') : start();
  else if (e.key === 'Escape' && running && !inField) stop('paused');
  else handled = false;
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

// ---------------------------------------------------------------------------
// Startup

const initial = saved.source ?? EXAMPLES[0].source;
editor.setText(initial);
if (saved.example) exampleSel.value = saved.example;
doAssemble();
if (saved.breakpoints) {
  editor.setBreakpointLines(saved.breakpoints);
  computeBreakpoints();
}
setStatus('Ready: press Step (F10) or Run (F5)', '');
render();
