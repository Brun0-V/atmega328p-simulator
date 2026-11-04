import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { EditorState, RangeSet, StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  Decoration, EditorView, GutterMarker, drawSelection, gutter, highlightActiveLine,
  highlightActiveLineGutter, keymap, lineNumbers,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import type { AsmMessage } from '../core/assembler';
import { M328P_EQU } from '../core/m328pdef';

// ---------------------------------------------------------------------------
// Syntax highlighting

const IO_NAMES = new Set(Object.keys(M328P_EQU).map((k) => k.toLowerCase()));
const MNEMONICS = new Set(
  (
    'add adc adiw sub subi sbc sbci sbiw and andi or ori eor com neg sbr cbr inc dec tst clr ser mul muls mulsu ' +
    'fmul fmuls fmulsu rjmp ijmp jmp rcall icall call ret reti cpse cp cpc cpi sbrc sbrs sbic sbis brbs brbc ' +
    'breq brne brcs brcc brsh brlo brmi brpl brge brlt brhs brhc brts brtc brvs brvc brie brid mov movw ldi ' +
    'ld ldd lds st std sts lpm spm in out push pop lsl lsr rol ror asr swap bset bclr sbi cbi bst bld sec clc ' +
    'sen cln sez clz sei cli ses cls sev clv set clt seh clh break nop sleep wdr'
  ).split(' '),
);

interface LexState {
  atStart: boolean;
}

const avrAsm = StreamLanguage.define<LexState>({
  name: 'avr-asm',
  startState: () => ({ atStart: true }),
  token(stream, state) {
    if (stream.sol()) state.atStart = true;
    if (stream.eatSpace()) return null;
    if (stream.match(';') || stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match(/^"([^"\\]|\\.)*"?/)) return 'string';
    if (stream.match(/^'(\\.|[^'])'/)) return 'string';
    if (stream.match(/^[.#]\w+/)) {
      state.atStart = false;
      return 'directive';
    }
    if (stream.match(/^(0x[0-9a-f]+|\$[0-9a-f]+|0b[01]+|\d+)/i)) return 'number';
    const word = stream.match(/^[A-Za-z_]\w*/) as RegExpMatchArray | null;
    if (word) {
      const w = word[0].toLowerCase();
      if (state.atStart && stream.peek() === ':') {
        state.atStart = false;
        return 'label';
      }
      if (state.atStart) {
        state.atStart = false;
        return MNEMONICS.has(w) ? 'mnemonic' : 'ident';
      }
      if (/^r([0-9]|[12][0-9]|3[01])$/.test(w) || /^[xyz][lh]?$/.test(w)) return 'register';
      if (IO_NAMES.has(w)) return 'ioreg';
      if (/^(low|high|byte[1-4]|lwrd|hwrd|page|exp2|log2|abs|defined)$/.test(w)) return 'func';
      return 'ident';
    }
    stream.next();
    return 'op';
  },
  tokenTable: {
    mnemonic: t.keyword,
    directive: t.meta,
    register: t.atom,
    ioreg: t.typeName,
    label: t.labelName,
    number: t.number,
    string: t.string,
    comment: t.lineComment,
    op: t.operator,
    ident: t.variableName,
    func: t.function(t.variableName),
  },
});

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: '#7dd3fc', fontWeight: '600' },
  { tag: t.meta, color: '#c084fc' },
  { tag: t.atom, color: '#fbbf24' },
  { tag: t.typeName, color: '#5eead4' },
  { tag: t.labelName, color: '#f472b6', fontWeight: '600' },
  { tag: t.number, color: '#fdba74' },
  { tag: t.string, color: '#86efac' },
  { tag: t.lineComment, color: '#6b7280', fontStyle: 'italic' },
  { tag: t.operator, color: '#9ca3af' },
  { tag: t.variableName, color: '#e5e7eb' },
  { tag: t.function(t.variableName), color: '#a5b4fc' },
]);

// ---------------------------------------------------------------------------
// Breakpoints

const toggleBreakpoint = StateEffect.define<{ pos: number; on: boolean }>({
  map: (v, m) => ({ pos: m.mapPos(v.pos), on: v.on }),
});
const clearBreakpoints = StateEffect.define<null>();

class BreakpointMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-bp-dot';
    return el;
  }
}
const bpMarker = new BreakpointMarker();

const breakpointField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(clearBreakpoints)) set = RangeSet.empty;
      if (e.is(toggleBreakpoint)) {
        if (e.value.on) set = set.update({ add: [bpMarker.range(e.value.pos)] });
        else set = set.update({ filter: (from) => from !== e.value.pos });
      }
    }
    return set;
  },
});

function hasBreakpoint(state: EditorState, pos: number): boolean {
  let found = false;
  state.field(breakpointField).between(pos, pos, () => {
    found = true;
  });
  return found;
}

// ---------------------------------------------------------------------------
// Current line (PC), diagnostics and address gutter

const setPcLine = StateEffect.define<{ line: number | null; kind: 'pc' | 'break' }>();
const pcField = StateField.define<{ line: number | null; kind: 'pc' | 'break' }>({
  create: () => ({ line: null, kind: 'pc' }),
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setPcLine)) v = e.value;
    if (tr.docChanged && v.line !== null && v.line > tr.state.doc.lines) v = { ...v, line: null };
    return v;
  },
});

const pcDecorations = EditorView.decorations.compute([pcField], (state) => {
  const { line, kind } = state.field(pcField);
  if (line === null || line > state.doc.lines) return Decoration.none;
  const l = state.doc.line(line);
  return Decoration.set([Decoration.line({ class: kind === 'break' ? 'cm-pc-line cm-pc-break' : 'cm-pc-line' }).range(l.from)]);
});

class PcMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-pc-arrow';
    el.textContent = '▶';
    return el;
  }
}
const pcMarker = new PcMarker();

const setDiagnostics = StateEffect.define<AsmMessage[]>();
const diagField = StateField.define<AsmMessage[]>({
  create: () => [],
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setDiagnostics)) v = e.value;
    return v;
  },
});
const diagDecorations = EditorView.decorations.compute([diagField], (state) => {
  const msgs = state.field(diagField);
  const ranges = [];
  const seen = new Set<number>();
  for (const m of msgs) {
    if (m.severity === 'info' || m.line < 1 || m.line > state.doc.lines || seen.has(m.line)) continue;
    seen.add(m.line);
    const l = state.doc.line(m.line);
    ranges.push(
      Decoration.line({
        class: m.severity === 'error' ? 'cm-error-line' : 'cm-warning-line',
        attributes: { title: m.message },
      }).range(l.from),
    );
  }
  ranges.sort((a, b) => a.from - b.from);
  return Decoration.set(ranges);
});

const setAddresses = StateEffect.define<Map<number, number> | null>();
const addrField = StateField.define<Map<number, number> | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setAddresses)) v = e.value;
    // Addresses are stale once the source changes.
    if (tr.docChanged && !tr.effects.some((e) => e.is(setAddresses))) v = null;
    return v;
  },
});

class AddrMarker extends GutterMarker {
  constructor(readonly text: string) {
    super();
  }
  eq(o: AddrMarker) {
    return o.text === this.text;
  }
  toDOM() {
    return document.createTextNode(this.text);
  }
}

// ---------------------------------------------------------------------------

const theme = EditorView.theme(
  {
    '&': { height: '100%', fontSize: '13px', backgroundColor: 'transparent', color: '#e5e7eb' },
    '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55' },
    '.cm-content': { caretColor: '#a5b4fc' },
    '.cm-cursor': { borderLeftColor: '#a5b4fc' },
    '.cm-gutters': { backgroundColor: 'transparent', color: '#4b5563', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#9ca3af' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(99,102,241,0.35) !important' },
    '.cm-lineNumbers .cm-gutterElement': { cursor: 'pointer', padding: '0 6px 0 4px' },
  },
  { dark: true },
);

export interface EditorCallbacks {
  onChange: () => void;
  onBreakpointsChange: () => void;
  keys: { key: string; run: () => boolean }[];
}

export class AsmEditor {
  readonly view: EditorView;

  constructor(parent: HTMLElement, doc: string, cb: EditorCallbacks) {
    const toggleAt = (view: EditorView, pos: number) => {
      const line = view.state.doc.lineAt(pos);
      view.dispatch({ effects: toggleBreakpoint.of({ pos: line.from, on: !hasBreakpoint(view.state, line.from) }) });
      cb.onBreakpointsChange();
      return true;
    };

    const extensions: Extension[] = [
      breakpointField,
      pcField,
      pcDecorations,
      diagField,
      diagDecorations,
      addrField,
      gutter({
        class: 'cm-bp-gutter',
        markers: (v) => v.state.field(breakpointField),
        initialSpacer: () => bpMarker,
        domEventHandlers: { mousedown: (view, line) => toggleAt(view, line.from) },
      }),
      lineNumbers({ domEventHandlers: { mousedown: (view, line) => toggleAt(view, line.from) } }),
      gutter({
        class: 'cm-pc-gutter',
        lineMarker: (view, line) => {
          const { line: pcLine } = view.state.field(pcField);
          if (pcLine === null || pcLine > view.state.doc.lines) return null;
          return view.state.doc.line(pcLine).from === line.from ? pcMarker : null;
        },
        lineMarkerChange: (u) => u.startState.field(pcField) !== u.state.field(pcField),
        initialSpacer: () => pcMarker,
      }),
      gutter({
        class: 'cm-addr-gutter',
        lineMarker: (view, line) => {
          const map = view.state.field(addrField);
          if (!map) return null;
          const n = view.state.doc.lineAt(line.from).number;
          const a = map.get(n);
          return a === undefined ? null : new AddrMarker(a.toString(16).padStart(4, '0'));
        },
        lineMarkerChange: (u) => u.startState.field(addrField) !== u.state.field(addrField),
        initialSpacer: () => new AddrMarker('0000'),
      }),
      highlightActiveLineGutter(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      avrAsm,
      syntaxHighlighting(highlight),
      theme,
      keymap.of([
        ...cb.keys,
        { key: 'F9', run: (v) => toggleAt(v, v.state.selection.main.head) },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) cb.onChange();
      }),
    ];

    this.view = new EditorView({ parent, state: EditorState.create({ doc, extensions }) });
  }

  get text(): string {
    return this.view.state.doc.toString();
  }

  setText(text: string): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      effects: [clearBreakpoints.of(null), setDiagnostics.of([]), setPcLine.of({ line: null, kind: 'pc' })],
    });
  }

  /** 1-based line numbers that have a breakpoint. */
  breakpointLines(): number[] {
    const lines: number[] = [];
    const doc = this.view.state.doc;
    this.view.state.field(breakpointField).between(0, doc.length, (from) => {
      lines.push(doc.lineAt(from).number);
    });
    return lines;
  }

  setBreakpointLines(lines: number[]): void {
    const doc = this.view.state.doc;
    const effects: StateEffect<unknown>[] = [clearBreakpoints.of(null)];
    for (const l of lines) if (l >= 1 && l <= doc.lines) effects.push(toggleBreakpoint.of({ pos: doc.line(l).from, on: true }));
    this.view.dispatch({ effects });
  }

  setPc(line: number | null, kind: 'pc' | 'break' = 'pc', scroll = true): void {
    const cur = this.view.state.field(pcField);
    if (cur.line === line && cur.kind === kind) return;
    const effects: StateEffect<unknown>[] = [setPcLine.of({ line, kind })];
    if (scroll && line !== null && line <= this.view.state.doc.lines) {
      effects.push(EditorView.scrollIntoView(this.view.state.doc.line(line).from, { y: 'nearest', yMargin: 60 }));
    }
    this.view.dispatch({ effects });
  }

  setDiagnostics(msgs: AsmMessage[]): void {
    this.view.dispatch({ effects: setDiagnostics.of(msgs) });
  }

  setAddresses(map: Map<number, number> | null): void {
    this.view.dispatch({ effects: setAddresses.of(map) });
  }

  goToLine(line: number): void {
    if (line < 1 || line > this.view.state.doc.lines) return;
    const l = this.view.state.doc.line(line);
    this.view.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: 'center' }) });
    this.view.focus();
  }
}
