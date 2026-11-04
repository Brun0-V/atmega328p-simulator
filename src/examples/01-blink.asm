; Blink the Arduino LED (PB5 / D13) using a busy-wait delay.
; Tip: set a breakpoint on "sbi PINB" (click the line number) and press Run.

.include "m328Pdef.inc"

.def temp = r16

.cseg
.org 0x0000
    rjmp reset

reset:
    ldi temp, high(RAMEND)  ; set up the stack pointer
    out SPH, temp
    ldi temp, low(RAMEND)
    out SPL, temp

    sbi DDRB, DDB5          ; PB5 is an output

loop:
    sbi PINB, PINB5         ; writing 1 to PINx toggles the pin
    rcall delay
    rjmp loop

; Wait about 0.25 s at 16 MHz (20 x 50000 x 4 cycles)
delay:
    ldi r18, 20
delay_outer:
    ldi r24, low(50000)
    ldi r25, high(50000)
delay_inner:
    sbiw r24, 1             ; 2 cycles
    brne delay_inner        ; 2 cycles when taken
    dec r18
    brne delay_outer
    ret
