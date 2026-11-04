; Fade an LED on OC0A (PD6 / D6) with Timer0 fast PWM.
; The overflow interrupt moves the duty cycle up and down.
; Watch PD6 in the timing chart: the pulse width changes over time.

.include "m328Pdef.inc"

.def temp = r16
.def duty = r18
.def dir  = r19

.cseg
.org 0x0000
    rjmp reset
.org OVF0addr
    rjmp timer0_ovf

.org INT_VECTORS_SIZE
reset:
    ldi temp, high(RAMEND)
    out SPH, temp
    ldi temp, low(RAMEND)
    out SPL, temp

    sbi DDRD, DDD6                  ; OC0A is an output
    clr duty
    ldi dir, 1

    ldi temp, (1<<COM0A1)|(1<<WGM01)|(1<<WGM00)  ; non-inverting fast PWM
    out TCCR0A, temp
    ldi temp, (1<<CS01)|(1<<CS00)   ; clk/64 -> ~976 Hz PWM at 16 MHz
    out TCCR0B, temp
    ldi temp, (1<<TOIE0)
    sts TIMSK0, temp
    sei

main:
    rjmp main

timer0_ovf:
    push temp
    in temp, SREG
    push temp

    add duty, dir                   ; duty += dir (dir is +1 or -1)
    cpi duty, 255
    breq flip
    cpi duty, 0
    brne set_duty
flip:
    neg dir                         ; reverse direction at the ends
set_duty:
    out OCR0A, duty                 ; takes effect at the next PWM period

    pop temp
    out SREG, temp
    pop temp
    reti
