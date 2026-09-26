// Monaco setup: JavaScript language, dark theme, DSL completions & hovers.

import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

const DOCS: Record<string, string> = {
  stack: "stack(...pats) — play patterns simultaneously",
  cat: "cat(...pats) — sequence patterns across one cycle",
  alt: "alt(...pats) — one pattern per cycle (<a b>)",
  fast: "fast(k, pat) — k times faster (also 'pat*2' in mini-notation)",
  slow: "slow(k, pat) — k times slower ('pat/2')",
  rev: "rev(pat) — mirror each cycle",
  every: "every(n, f, pat) — apply f every n-th cycle",
  sometimes: "sometimes(prob, f, pat) — apply f on ~prob of cycles",
  chunk: "chunk(n, f, pat) — cycle split in n slots, f on slot cycle%n",
  shift: "shift(cycles, pat) — move the pattern in time",
  struct: "struct(mask, pat) — mask like 'x.x..x..' gates the pattern",
  euclid: "euclid(k, n, pat, rot?) — k hits over n steps",
  sound: "sound(name, pat) — assign an instrument (bd sn hh oh cp tom sine saw square tri noise pulse organ)",
  note: "note(midi, pat) or note('c3 e3 g3') — pitch",
  transpose: "transpose(semis, pat) — shift all notes",
  gain: "gain(v, pat) — volume 0..1",
  cutoff: "cutoff(hz, pat) — low-pass cutoff",
  res: "res(v, pat) — filter resonance 0..1",
  pan: "pan(v, pat) — 0 left … 1 right",
  attack: "attack(sec, pat) — envelope attack",
  decay: "decay(sec, pat) — envelope decay",
  sustain: "sustain(v, pat) — envelope sustain level",
  release: "release(sec, pat) — envelope release",
  echo: "echo(repeats, cycles, feedback, pat) — cycle-synced repeats (0–8)",
  chorus: "chorus(depth, pat) — stereo detune (0–0.1)",
  delay: "delay(v, pat) — delay send 0..1",
  speed: "speed(v, pat) — playback rate of the oscillator",
  crush: "crush(v, pat) — bitcrush 0..1",
  p: 'p("bd [hh hh] <sn cp>") — mini-notation as a function',
  silence: "silence — no events",
  Pattern: "Pattern — immutable pattern value with chainable methods",
};

type SnippetDef = Omit<monaco.languages.CompletionItem, "range">;

const SNIPPETS: SnippetDef[] = [
  {
    label: "every(4, fast(2), …)",
    kind: monaco.languages.CompletionItemKind.Snippet,
    insertText: "every(${1:4}, fast(${2:2}), ${3:pat})",
    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
    documentation: "apply a transform every n cycles",
  },
  {
    label: "euclid(3, 8, …)",
    kind: monaco.languages.CompletionItemKind.Snippet,
    insertText: "euclid(${1:3}, ${2:8}, ${3:pat})",
    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
    documentation: "euclidean rhythm",
  },
  {
    label: "stack(…)",
    kind: monaco.languages.CompletionItemKind.Snippet,
    insertText: "stack(\n\t${1:\"bd . hh .\"},\n\t${2:\"sn . . sn\"}\n)",
    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
    documentation: "layer patterns",
  },
];

export function createEditor(container: HTMLElement, initial: string): monaco.editor.IStandaloneCodeEditor {
  monaco.languages.registerCompletionItemProvider("javascript", {
    triggerCharacters: [".", "("],
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position);
      const range: monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const suggestions: monaco.languages.CompletionItem[] = Object.entries(DOCS).map(
        ([label, documentation]) => ({
          label,
          kind: monaco.languages.CompletionItemKind.Function,
          insertText: label,
          documentation,
          range,
        }),
      );
      for (const s of SNIPPETS) {
        suggestions.push({ ...s, range });
      }
      return { suggestions };
    },
  });

  monaco.languages.registerHoverProvider("javascript", {
    provideHover: (model, position) => {
      const w = model.getWordAtPosition(position);
      if (w && DOCS[w.word]) {
        return { contents: [{ value: `**${w.word}** — ${DOCS[w.word]}` }] };
      }
      return null;
    },
  });

  return monaco.editor.create(container, {
    value: initial,
    language: "javascript",
    theme: "vs-dark",
    fontSize: 15,
    fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, monospace",
    fontLigatures: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    lineNumbersMinChars: 3,
    padding: { top: 12, bottom: 12 },
    renderLineHighlight: "all",
    tabSize: 2,
    wordWrap: "on",
    smoothScrolling: true,
  });
}

export function showEditorError(editor: monaco.editor.IStandaloneCodeEditor, error?: { error: string; line?: number; column?: number }): void {
  const model = editor.getModel();
  if (!model) return;
  const line = Math.min(model.getLineCount(), Math.max(1, error?.line ?? 1));
  const column = Math.min(model.getLineMaxColumn(line), Math.max(1, error?.column ?? 1));
  monaco.editor.setModelMarkers(model, "muse", error ? [{
    severity: monaco.MarkerSeverity.Error, message: error.error,
    startLineNumber: line, endLineNumber: line,
    startColumn: column, endColumn: Math.min(model.getLineMaxColumn(line), column + 1),
  }] : []);
  if (error?.line) editor.revealPositionInCenter({ lineNumber: line, column });
}
