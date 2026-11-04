; Toggle the LED on PB5 from a Timer0 overflow interrupt.
; The main loop just sleeps; the CPU wakes up on every interrupt.
; Timer0 runs at clk/1024, so it overflows every 256 * 1024 cycles (16.4 ms at 16 MHz).

.include "m328Pdef.inc"

.def temp  = r16
.def count = r17

.cseg
.org 0x0000
    rjmp reset
.org OVF0addr               ; Timer0 overflow vector
    rjmp timer0_ovf

.org INT_VECTORS_SIZE
reset:
    ldi temp, high(RAMEND)
    out SPH, temp
    ldi temp, low(RAMEND)
    out SPL, temp

    sbi DDRB, DDB5
    clr count

    ldi temp, (1<<CS02)|(1<<CS00)   ; prescaler clk/1024
    out TCCR0B, temp
    ldi temp, (1<<TOIE0)            ; enable overflow interrupt
    sts TIMSK0, temp

    ldi temp, (1<<SE)               ; idle sleep mode
    out SMCR, temp
    sei

main:
    sleep
    rjmp main

timer0_ovf:
    push temp
    in temp, SREG
    push temp

    inc count
    cpi count, 30                   ; 30 overflows = ~0.5 s
    brne timer0_done
    clr count
    sbi PINB, PINB5                 ; toggle LED

timer0_done:
    pop temp
    out SREG, temp
    pop temp
    reti
