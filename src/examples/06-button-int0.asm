; Toggle the LED (PB5) with a button on PD2 using the INT0 interrupt.
; PD2 has its pull-up enabled, so it reads high while released.
; Click PD2 in the "I/O ports" panel to press the button (drive it low),
; click again to release it.

.include "m328Pdef.inc"

.def temp = r16

.cseg
.org 0x0000
    rjmp reset
.org INT0addr
    rjmp int0_isr

.org INT_VECTORS_SIZE
reset:
    ldi temp, high(RAMEND)
    out SPH, temp
    ldi temp, low(RAMEND)
    out SPL, temp

    sbi DDRB, DDB5                  ; LED output
    cbi DDRD, DDD2                  ; button input
    sbi PORTD, PORTD2               ; with pull-up

    ldi temp, (1<<ISC01)            ; INT0 on falling edge
    sts EICRA, temp
    ldi temp, (1<<INT0)
    out EIMSK, temp
    sei

main:
    rjmp main

int0_isr:
    sbi PINB, PINB5                 ; toggle LED
    reti
