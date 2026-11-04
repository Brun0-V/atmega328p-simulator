; Step through this program line by line (F10) and watch the
; registers and the SREG flags change.

.include "m328Pdef.inc"

.dseg
result: .byte 1                     ; one byte of SRAM

.cseg
.org 0x0000
    ldi r16, high(RAMEND)
    out SPH, r16
    ldi r16, low(RAMEND)
    out SPL, r16

    ; Half carry: 0x0F + 0x01 carries out of bit 3 -> H = 1
    ldi r16, 0x0F
    ldi r17, 0x01
    add r16, r17

    ; Carry: 200 + 100 = 300 does not fit in 8 bits -> r16 = 44, C = 1
    ldi r16, 200
    ldi r17, 100
    add r16, r17

    ; 16-bit addition: r25:r24 = 1000 + 2000
    ldi r24, low(1000)
    ldi r25, high(1000)
    ldi r22, low(2000)
    ldi r23, high(2000)
    add r24, r22
    adc r25, r23

    ; Unsigned multiply: r1:r0 = 12 * 34 = 408
    ldi r16, 12
    ldi r17, 34
    mul r16, r17

    ; Signed compare: -5 < 3 so the branch is taken
    ldi r16, -5
    cpi r16, 3
    brlt is_less
    ldi r18, 0                      ; skipped
is_less:
    ldi r18, 1

    ; Call a subroutine: r0 = 5! = 120, then store it in SRAM
    ldi r16, 5
    rcall factorial
    sts result, r0

done:
    rjmp done

; r0 = r16! (r16 <= 5). Uses the stack to preserve r17.
factorial:
    push r17
    ldi r17, 1
fact_loop:
    mul r17, r16                    ; r1:r0 = r17 * r16
    mov r17, r0
    dec r16
    brne fact_loop
    mov r0, r17
    pop r17
    ret
