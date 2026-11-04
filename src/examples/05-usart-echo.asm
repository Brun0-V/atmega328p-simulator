; Print a message over USART0 at 9600 baud, then echo everything you type.
; Type in the serial console below. TXD is PD1: watch it in the timing chart.

.include "m328Pdef.inc"

.def temp = r16

.equ F_CPU = 16000000
.equ BAUD  = 9600
.equ UBRR_VALUE = F_CPU / 16 / BAUD - 1   ; = 103

.cseg
.org 0x0000
    rjmp reset

reset:
    ldi temp, high(RAMEND)
    out SPH, temp
    ldi temp, low(RAMEND)
    out SPL, temp

    ldi temp, high(UBRR_VALUE)
    sts UBRR0H, temp
    ldi temp, low(UBRR_VALUE)
    sts UBRR0L, temp
    ldi temp, (1<<RXEN0)|(1<<TXEN0)       ; enable receiver and transmitter
    sts UCSR0B, temp
    ldi temp, (1<<UCSZ01)|(1<<UCSZ00)     ; 8 data bits, no parity, 1 stop bit
    sts UCSR0C, temp

    ldi ZL, low(message * 2)              ; Z = byte address of the string
    ldi ZH, high(message * 2)
print:
    lpm temp, Z+                          ; read one byte from flash
    tst temp
    breq echo                             ; stop at the 0 terminator
    rcall uart_send
    rjmp print

echo:
    lds temp, UCSR0A
    sbrs temp, RXC0                       ; wait for a received byte
    rjmp echo
    lds temp, UDR0
    rcall uart_send
    rjmp echo

; Send the byte in r16
uart_send:
    lds r17, UCSR0A
    sbrs r17, UDRE0                       ; wait until the data register is empty
    rjmp uart_send
    sts UDR0, temp
    ret

message:
    .db "Hello from the ATmega328P!", 13, 10, "Type something: ", 0
