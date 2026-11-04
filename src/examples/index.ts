import blink from './01-blink.asm?raw';
import timer0 from './02-timer0-interrupt.asm?raw';
import timer1 from './03-timer1-ctc.asm?raw';
import pwm from './04-pwm-fade.asm?raw';
import usart from './05-usart-echo.asm?raw';
import button from './06-button-int0.asm?raw';
import arithmetic from './07-arithmetic.asm?raw';

export interface Example {
  id: string;
  title: string;
  source: string;
  /** Pins to show in the timing chart. */
  pins: string[];
}

export const EXAMPLES: Example[] = [
  { id: 'arithmetic', title: 'Arithmetic & flags (step through)', source: arithmetic, pins: ['PB5'] },
  { id: 'blink', title: 'Blink LED (delay loop)', source: blink, pins: ['PB5'] },
  { id: 'timer0', title: 'Timer0 overflow interrupt', source: timer0, pins: ['PB5'] },
  { id: 'timer1', title: 'Timer1 CTC toggles OC1A', source: timer1, pins: ['PB1'] },
  { id: 'pwm', title: 'PWM LED fade (Timer0 fast PWM)', source: pwm, pins: ['PD6'] },
  { id: 'usart', title: 'USART hello + echo', source: usart, pins: ['PD1'] },
  { id: 'button', title: 'Button on INT0 toggles LED', source: button, pins: ['PD2', 'PB5'] },
];
