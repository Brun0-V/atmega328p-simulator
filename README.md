<img src="assets/icon.svg" width="64" height="64" alt="">

# ATmega328P Simulator

A browser-based simulator for the ATmega328P (the chip on the Arduino Uno). Write AVR assembly,
assemble it, then step through it one instruction at a time or run it at any clock speed while
watching every register, I/O port, timer and the serial port.

Inspired by [ice458's PIO simulator](https://ice458.github.io/tools/pio_sim).

## Features

- **Assembler** for AVRA / Atmel syntax: labels, `.equ`, `.set`, `.def`, `.org`, `.cseg/.dseg/.eseg`,
  `.db`, `.dw`, `.byte`, `.macro`, `.if/.ifdef/.else`, `#define`, expressions with `low()`, `high()`, etc.
  Every register and bit name from `m328Pdef.inc` is built in. Errors point at the line.
- **CPU**: the full ATmega328P instruction set with correct flags and cycle counts.
- **Step-by-step debugging**: Step, Step over, Step out, breakpoints (click a line number),
  the current line is highlighted, and changed values light up after each step.
- **Clock speed**: run at 1 Hz up to real time (F_CPU) or as fast as possible. F_CPU is configurable.
- **State views**: R0-R31, X/Y/Z, PC, SP, SREG flags (click to toggle), SRAM hex dump with the stack,
  every I/O register with bit names, and the program memory listing with disassembly.
  Registers, SRAM and I/O registers can be edited by clicking them.
- **Peripherals**
  - GPIO ports B, C, D with pull-ups. Click an input pin to drive it high/low, right-click to release.
  - Timer0, Timer1, Timer2: all waveform modes (normal, CTC, fast PWM, phase correct, phase & frequency
    correct), compare outputs on their pins, input capture, external clock inputs.
  - USART0 with baud-rate timing and a serial console; the TXD waveform is visible on PD1.
  - INT0/INT1, pin-change interrupts, SLEEP (idle mode).
- **Timing chart** of any pins over the last 100 cycles to 100M cycles.
- Example programs: arithmetic & flags, blink, timer interrupts, CTC, PWM fade, USART echo, button on INT0.

Not simulated: ADC, SPI, TWI, EEPROM access, watchdog, and self-programming (`spm`).

## Keyboard

| Key | Action |
| --- | --- |
| Ctrl+Enter | Assemble & reset |
| F10 | Step one instruction |
| Shift+F10 | Step over (calls run to completion) |
| Ctrl+F10 | Step out |
| F5 | Run / pause |
| F9 | Toggle breakpoint on the cursor line |

## Development

```sh
npm install
npm run dev      # start the dev server
npm test         # run the test suite
npm run build    # production build in dist/
```

Everything runs client-side in TypeScript; there is no backend.

### How it is verified

- `tests/cpu-diff.test.ts` runs random instruction streams on this CPU and on
  [avr8js](https://github.com/wokwi/avr8js) and compares all state after every instruction.
  Three avr8js bugs are excluded from the comparison: its H flag (computed from bit 0 instead of bit 3),
  CBI cycle count (1 instead of 2), and FMULSU's Z flag (inverted).
- `tests/assembler.test.ts` and `tests/mcu.test.ts` compare the assembler's output byte for byte
  with AVRA 1.4.2 (`tests/fixtures/`) and check the example programs' timing and behavior.

`src/core/m328pdef.ts` is generated from AVRA's `m328Pdef.inc` with
`node scripts/gen-defs.mjs path/to/m328Pdef.inc`.

## Deploying to GitHub Pages

The workflow in `.github/workflows/deploy.yml` tests, builds and publishes the site on every push
to `main`. In the repository settings, set **Pages → Source** to **GitHub Actions**.

## Project layout

```
src/core/     simulator: cpu.ts, assembler.ts, expr.ts, disasm.ts, gpio.ts, timers.ts, usart.ts, mcu.ts
src/ui/       editor (CodeMirror), panels, memory views, timing chart
src/examples/ example programs (.asm)
tests/        test suite and AVRA reference output
```
