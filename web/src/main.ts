import "./styles.css";

import { engine } from "./audio/engine";
import { evaluate } from "./repl";
import { EXAMPLES } from "./examples";
import ExportWorker from "./audio/export-worker?worker";
import { createEditor, showEditorError } from "./ui/editor";
import { Visualizer } from "./ui/visualizer";

const INITIAL = `// muse — live-coded music · ctrl+enter runs the editor
// mini-notation: "bd [hh hh] <sn cp> bd*2 hh/2 . =rest"

const drums = stack(
  "bd . hh bd . hh . hh",
  gain(0.55, fast(2, "sn . . sn")),
  gain(0.35, "hh*4")
);

const bass = note("c2 . . c2 . g1 . .")
  .gain(0.75)
  .cutoff(500);

const lead = every(2, rev, note("c3 e3 g3 b3"))
  .gain(0.4)
  .delay(0.4);

stack(drums, bass, lead)
`;

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

// --- console ---------------------------------------------------------------

const consoleEl = $("console");
const MAX_LINES = 200;

function log(line: string, kind: "info" | "error" | "ok" = "info"): void {
  const div = document.createElement("div");
  div.className = `line ${kind}`;
  const time = new Date().toLocaleTimeString(undefined, { hour12: false });
  div.innerHTML = `<span class="ts">${time}</span>${escapeHtml(line)}`;
  consoleEl.appendChild(div);
  while (consoleEl.childNodes.length > MAX_LINES) {
    consoleEl.removeChild(consoleEl.firstChild!);
  }
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- visualizer ------------------------------------------------------------

const viz = new Visualizer($("viz"));
let lastVisual: { evs: Parameters<Visualizer["draw"]>[0]; lo: number; hi: number; pos: number } | null =
  null;

// --- engine wiring ---------------------------------------------------------

engine.hooks = {
  onLog: (line, kind) => log(line, kind === "error" ? "error" : "info"),
  onTick: (info) => {
    const pos = $("pos");
    if (info.playing) {
      const bar = Math.floor(info.cycle);
      const beat = (info.cycle - bar).toFixed(2).slice(2);
      pos.textContent = `${bar}.${beat} · ${Math.round(info.cps * 60)} bpm`;
      pos.classList.add("live");
    } else {
      pos.textContent = "stopped";
      pos.classList.remove("live");
    }
    setStatus(engine.audioReady);
    if (!info.playing && lastVisual) {
      viz.clear();
    }
  },
  onVisualize: (evs, lo, hi, pos) => {
    lastVisual = { evs, lo, hi, pos };
    viz.draw(evs, lo, hi, pos, engine.cps);
  },
};

function setStatus(ready: boolean): void {
  const el = $("audio-status");
  el.textContent = ready ? "audio ●" : "audio ○";
  el.classList.toggle("on", ready);
}

// --- editor ----------------------------------------------------------------

const DRAFT_KEY = "muse.draft.v1";
const BACKUP_KEY = "muse.draft.backup.v1";
function readDraft(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
const editor = createEditor($("editor"), readDraft(DRAFT_KEY) ?? INITIAL);
function saveDraft(): void {
  try {
    localStorage.setItem(DRAFT_KEY, editor.getValue());
    $("draft-status").textContent = "draft saved";
  } catch { $("draft-status").textContent = "draft could not be saved"; }
}
editor.onDidChangeModelContent(() => { saveDraft(); showEditorError(editor); });
const restoreButton = $<HTMLButtonElement>("restore");
restoreButton.disabled = readDraft(BACKUP_KEY) === null;
$<HTMLSelectElement>("example").addEventListener("change", (event) => {
  const select = event.target as HTMLSelectElement;
  const example = select.value === "default" ? INITIAL : EXAMPLES[select.value];
  if (!example) return;
  try {
    localStorage.setItem(BACKUP_KEY, editor.getValue());
    restoreButton.disabled = false;
  } catch { log("cannot back up draft; example was not loaded", "error"); return; }
  editor.setValue(example);
  select.value = "";
  editor.focus();
});
restoreButton.addEventListener("click", () => {
  const backup = readDraft(BACKUP_KEY);
  if (backup !== null) {
    const current = editor.getValue();
    try { localStorage.setItem(BACKUP_KEY, current); } catch { return; }
    editor.setValue(backup);
  }
});
$<HTMLInputElement>("sample-file").addEventListener("change", async (event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    if (file.size > 50 * 1024 * 1024) throw new Error("audio file must be smaller than 50 MiB");
    const name = $<HTMLInputElement>("sample-name").value.trim();
    await engine.loadSample(name, await file.arrayBuffer());
    log(`sample loaded: sound("${name}", "x*4") · speed(2, …) doubles pitch`, "ok");
    setStatus(engine.audioReady);
  } catch (error) { log(String(error), "error"); }
  finally { input.value = ""; }
});
$<HTMLButtonElement>("export").addEventListener("click", () => {
  const result = evaluate(editor.getValue());
  if (!result.ok) { showEditorError(editor, result); log(result.error, "error"); return; }
  const seconds = Number($<HTMLInputElement>("export-seconds").value);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 300) { log("export duration must be 1–300 seconds", "error"); return; }
  const button = $<HTMLButtonElement>("export");
  button.disabled = true;
  button.textContent = "rendering…";
  const worker = new ExportWorker();
  const finish = () => { worker.terminate(); button.disabled = false; button.textContent = "download WAV"; };
  worker.onerror = (event) => { log(event.message, "error"); finish(); };
  worker.onmessage = (event) => {
    if (event.data.error) log(event.data.error, "error");
    else {
      const url = URL.createObjectURL(new Blob([event.data.wav], { type: "audio/wav" }));
      const link = document.createElement("a");
      link.href = url; link.download = "muse.wav"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      log(`exported ${seconds}s WAV`, "ok");
    }
    finish();
  };
  worker.postMessage({ code: editor.getValue(), seconds, cps: engine.cps,
    wasmUrl: new URL("muse_core.wasm", document.baseURI).href, samples: [...engine.samples] });
});

let everEvaluated = false;
let running = false;
let transportVersion = 0;

async function run(): Promise<void> {
  if (running) return;
  const code = editor.getValue();
  const t0 = performance.now();
  const res = evaluate(code);
  if (!res.ok) {
    showEditorError(editor, res);
    log(`✗ ${res.error}${res.line ? ` (${res.line}:${res.column})` : ""}`, "error");
    editor.focus();
    return;
  }
  showEditorError(editor);
  running = true;
  const version = ++transportVersion;
  try {
    await engine.initIfNeeded();
    if (version !== transportVersion) return;
    engine.setPattern(res.pattern.pat);
    if (!engine.playing) await engine.play();
    everEvaluated = true;
    const total = (performance.now() - t0).toFixed(0);
    log(
      `✓ pattern installed in ${total} ms (eval ${res.ms.toFixed(1)} + wasm)`,
      "ok",
    );
    if (lastVisual) viz.draw(lastVisual.evs, lastVisual.lo, lastVisual.hi, lastVisual.pos, engine.cps);
  } catch (e) {
    log(`✗ ${e instanceof Error ? e.message : String(e)}`, "error");
  } finally { running = false; }
}

async function play(): Promise<void> {
  try {
    if (!everEvaluated) {
      await run();
      return;
    }
    await engine.play();
    log("▶ playing", "ok");
  } catch (e) {
    log(`✗ ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

function stop(): void {
  transportVersion++;
  engine.stop();
  viz.clear();
  log("■ stopped");
}

// --- controls --------------------------------------------------------------

$("run").addEventListener("click", () => void run());
$("play").addEventListener("click", () => void play());
$("stop").addEventListener("click", stop);

const bpmInput = $<HTMLInputElement>("bpm");
bpmInput.addEventListener("change", () => {
  const bpm = Math.min(300, Math.max(30, Number(bpmInput.value) || 120));
  bpmInput.value = String(bpm);
  engine.setCps(bpm / 60);
});
engine.setCps(Number(bpmInput.value) / 60);

editor.focus();

window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    void run();
  } else if ((e.ctrlKey || e.metaKey) && e.key === ".") {
    e.preventDefault();
    stop();
  }
});

// --- boot --------------------------------------------------------------------

// debug handle (console access): __muse.engine, __muse.evaluate
declare global {
  interface Window {
    __muse: { engine: typeof engine; evaluate: typeof evaluate };
  }
}
window.__muse = { engine, evaluate };

log("muse · ctrl+enter = run · ctrl+. = stop");
log('mini-notation: "bd [hh hh] <sn cp>" · funcs: stack fast slow every rev euclid note gain …');
setStatus(false);
editor.focus();
