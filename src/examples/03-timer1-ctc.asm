; Timer1 in CTC mode toggles OC1A (PB1 / D9) in hardware every 0.5 s.
; The compare-match interrupt counts matches in r20.

.include "m328Pdef.inc"

.def temp = r16
.equ TICKS = 7812                   ; 16 MHz / 1024 / 2 = 7812.5 -> 0.5 s

.cseg
.org 0x0000
    rjmp reset
.org OC1Aaddr                       ; Timer1 compare match A
    rjmp timer1_compa

.org INT_VECTORS_SIZE
reset:
    ldi temp, high(RAMEND)
    out SPH, temp
    ldi temp, low(RAMEND)
    out SPL, temp

    sbi DDRB, DDB1                  ; OC1A pin is an output
    clr r20

    ldi temp, high(TICKS)           ; 16-bit registers: write high byte first
    sts OCR1AH, temp
    ldi temp, low(TICKS)
    sts OCR1AL, temp

    ldi temp, (1<<COM1A0)           ; toggle OC1A on compare match
    sts TCCR1A, temp
    ldi temp, (1<<WGM12)|(1<<CS12)|(1<<CS10)  ; CTC mode, clk/1024
    sts TCCR1B, temp
    ldi temp, (1<<OCIE1A)
    sts TIMSK1, temp
    sei

main:
    rjmp main

timer1_compa:
    inc r20                         ; main loop uses no flags, so SREG is not saved here
    reti
