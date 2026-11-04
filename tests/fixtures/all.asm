.include "m328Pdef.inc"
.def temp = r16
.equ CONST = 0x3C
.equ FWDC = 0x1234
.set CNT = 1
.cseg
.org 0x0000
start:
  add r16, r22
  add r1, r29
  add r15, r3
  add r10, r7
  adc r23, r30
  adc r15, r24
  adc r6, r15
  adc r0, r13
  sub r26, r17
  sub r11, r24
  sub r10, r4
  sub r8, r28
  sbc r8, r8
  sbc r0, r0
  sbc r13, r13
  sbc r10, r10
  and r18, r20
  and r12, r13
  and r11, r12
  and r24, r19
  or r1, r23
  or r26, r10
  or r9, r16
  or r4, r21
  eor r19, r0
  eor r21, r4
  eor r19, r22
  eor r19, r30
  mov r20, r11
  mov r30, r30
  mov r11, r3
  mov r16, r1
  cp r22, r25
  cp r1, r26
  cp r23, r24
  cp r0, r28
  cpc r2, r11
  cpc r12, r7
  cpc r15, r29
  cpc r22, r22
  cpse r16, r29
  cpse r6, r23
  cpse r18, r2
  cpse r27, r5
  mul r13, r21
  mul r23, r9
  mul r21, r17
  mul r5, r19
  lsl r20
  lsl r19
  lsl r11
  rol r5
  rol r9
  rol r19
  tst r30
  tst r10
  tst r3
  clr r5
  clr r25
  clr r2
  com r15
  com r22
  com r16
  neg r29
  neg r26
  neg r9
  swap r3
  swap r2
  swap r31
  inc r21
  inc r13
  inc r8
  asr r8
  asr r26
  asr r6
  lsr r10
  lsr r27
  lsr r23
  ror r9
  ror r3
  ror r26
  dec r18
  dec r9
  dec r29
  push r10
  push r29
  push r31
  pop r20
  pop r30
  pop r17
  cpi r25, 240
  cpi r28, 75
  cpi r19, 193
  sbci r21, 255
  sbci r26, 92
  sbci r18, 251
  subi r24, 184
  subi r18, 182
  subi r17, 156
  ori r27, 143
  ori r31, 135
  ori r25, 174
  andi r21, 5
  andi r31, 128
  andi r26, 140
  ldi r30, 147
  ldi r27, 178
  ldi r24, 176
  sbr r29, 179
  sbr r21, 230
  sbr r27, 171
  cbr r20, 85
  cbr r22, 185
  cbr r31, 144
  ldi temp, low(CONST*3)
  ldi r17, high(0x1234)
  ldi r18, -1
  ldi r19, 'A'
  ldi r20, (1<<PB5)|(1<<PB3)
  ldi ZL, low(table*2)
  ldi ZH, high(table*2)
  ser r25
  adiw r24, 10
  sbiw r24, 53
  adiw r26, 21
  sbiw r26, 53
  adiw r28, 38
  sbiw r28, 34
  adiw r30, 3
  sbiw r30, 25
  adiw XL, 1
  sbiw ZL, 63
  adiw r25:r24, 2
  muls r21, r30
  mulsu r18, r19
  fmul r18, r16
  fmuls r23, r19
  fmulsu r18, r16
  movw r8, r6
  muls r26, r21
  mulsu r23, r19
  fmul r16, r22
  fmuls r23, r21
  fmulsu r22, r17
  movw r12, r14
  muls r27, r16
  mulsu r21, r22
  fmul r20, r22
  fmuls r17, r21
  fmulsu r16, r20
  movw r6, r18
  muls r26, r25
  mulsu r21, r18
  fmul r22, r22
  fmuls r21, r23
  fmulsu r18, r18
  movw r24, r30
  bld r12, 2
  bld r5, 5
  bld r0, 6
  bst r6, 5
  bst r9, 5
  bst r24, 6
  sbrc r27, 3
  sbrc r31, 4
  sbrc r30, 6
  sbrs r24, 2
  sbrs r16, 4
  sbrs r31, 4
  cbi 26, 0
  cbi 20, 4
  cbi 31, 4
  sbi 9, 7
  sbi 1, 1
  sbi 28, 3
  sbic 18, 0
  sbic 8, 6
  sbic 0, 7
  sbis 17, 3
  sbis 30, 0
  sbis 15, 7
  sbi PORTB, PB5
  cbi DDRD, 3
  in r17, 19
  out 36, r18
  in r31, 60
  out 15, r1
  in r8, 38
  out 36, r21
  in r18, 3
  out 59, r22
  in r16, SREG
  out SPL, r16
  out SPH, r17
  lds r5, 0x0100
  sts 0x08FF, r31
  lds r16, TCCR1A
  sts UDR0, r16
  lds r0, var1
  ld r11, X
  st X, r21
  ld r23, X+
  st X+, r18
  ld r4, -X
  st -X, r1
  ld r0, Y
  st Y, r8
  ld r17, Y+
  st Y+, r14
  ld r21, -Y
  st -Y, r3
  ld r21, Z
  st Z, r17
  ld r6, Z+
  st Z+, r0
  ld r13, -Z
  st -Z, r24
  ldd r27, Y+61
  ldd r24, Z+60
  std Y+50, r12
  std Z+37, r29
  ldd r4, Y+38
  ldd r0, Z+55
  std Y+36, r30
  std Z+39, r9
  ldd r10, Y+61
  ldd r31, Z+42
  std Y+19, r27
  std Z+6, r4
  ldd r14, Y+34
  ldd r5, Z+8
  std Y+3, r21
  std Z+54, r4
  lpm
  lpm r16, Z
  lpm r31, Z+
back:
  brcs back
  brcs fwd
  brlo back
  brlo fwd
  breq back
  breq fwd
  brmi back
  brmi fwd
  brvs back
  brvs fwd
  brlt back
  brlt fwd
  brhs back
  brhs fwd
  brts back
  brts fwd
  brie back
  brie fwd
  brcc back
  brcc fwd
  brsh back
  brsh fwd
  brne back
  brne fwd
  brpl back
  brpl fwd
  brvc back
  brvc fwd
  brge back
  brge fwd
  brhc back
  brhc fwd
  brtc back
  brtc fwd
  brid back
  brid fwd
  brbs 3, back
  brbc 6, fwd
fwd:
  sec
  clc
  sez
  clz
  sen
  cln
  sev
  clv
  ses
  cls
  seh
  clh
  set
  clt
  sei
  cli
  bset 4
  bclr 5
  nop
  ijmp
  icall
  ret
  reti
  sleep
  break
  wdr
  spm
  rjmp start
  rcall later
  jmp later
  call start
  rjmp PC
  rjmp PC+2
.org 0x0300
later:
  rjmp later
table: .db "Hello", 0x0D, 0x0A, 0
  .dw 0x1234, later, -2
.dseg
var1: .byte 2
var2: .byte 1
.cseg
  ldi r16, low(var2)
  ldi r17, FWDC & 0xff
.set CNT = CNT + 1
  ldi r18, CNT
.if CNT == 2
  ldi r19, 0x22
.else
  ldi r19, 0x33
.endif
.macro addi
  subi @0, -(@1)
.endm
  addi r20, 5
  ldi r21, 0b10100101
  ldi r22, $7f
