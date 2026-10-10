// End-to-end smoke test: serves dist/web/, opens the app in headless Chromium,
// runs the editor and verifies the full pipeline:
//   Monaco → REPL → IR encode → wasm decode/scheduler → worklet DSP → meter.
//
//   node scripts/e2e.mjs

import { spawnSync } from "node:child_process";
import { parseMidi } from "midi-file";
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const ROOT = new URL("../dist/web", import.meta.url).pathname;
const PORT = 4319;

if (!existsSync(join(ROOT, "index.html"))) {
  console.error("dist/web/ not built — run: npm run build");
  process.exit(1);
}

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".json": "application/json",
};

const server = createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path === "/") path = "/index.html";
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end("nope");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});

await new Promise((r) => server.listen(PORT, r));

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}`);
  if (!ok) failures.push(label);
};

const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required", "--disable-gpu"],
});
const page = await browser.newPage();

const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => consoleErrors.push(String(err)));

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });
  await page.waitForFunction(() => Boolean(window.__muse));

  check(await page.isVisible("#editor .monaco-editor"), "monaco editor mounted");

  // run the default program
  await page.click("#run");

  await page.waitForSelector("#audio-status.on", { timeout: 15_000 });
  check(true, "wasm + worklet initialized (audio ●)");

  await page.waitForFunction(() => window.__muse?.engine?.playing === true, { timeout: 10_000 });
  check(true, "transport running");

  // cycle position must advance
  const pos1 = await page.textContent("#pos");
  await sleep(1500);
  const pos2 = await page.textContent("#pos");
  check(pos1 !== pos2, `clock advances (${pos1?.trim()} → ${pos2?.trim()})`);

  // events must have been scheduled and DSP must produce sound
  await page.waitForFunction(() => window.__muse.engine.scheduledTotal > 4, { timeout: 10_000 });
  const total = await page.evaluate(() => window.__muse.engine.scheduledTotal);
  check(total > 4, `scheduler emitted events (n=${total})`);

  await page.waitForFunction(() => window.__muse.engine.workletNotes > 4, { timeout: 10_000 });
  const notes = await page.evaluate(() => window.__muse.engine.workletNotes);
  check(notes > 4, `worklet received notes for DSP (n=${notes})`);
  await sleep(1500);
  const diag = await page.evaluate(() => window.__muse.engine.workletDiag);
  console.log("    worklet diag:", JSON.stringify(diag));
  await page.waitForFunction(() => window.__muse.engine.peak > 0.005, { timeout: 10_000 });
  const peak = await page.evaluate(() => window.__muse.engine.peak);
  check(peak > 0.005, `worklet DSP renders audio (peak=${peak.toFixed(3)})`);

  // hot-swap a new pattern while playing
  await page.evaluate(async () => {
    const r = await window.__muse.evaluate('sound("bd", euclid(5, 8, "bd"))');
    if (!r.ok) throw new Error(r.error);
    window.__muse.engine.setPattern(r.pattern.pat);
  });
  check(true, "hot code swap while playing");

  await page.evaluate(() => window.__muse.engine.setCps(180 / 60));
  await sleep(300);
  const bpmShown = await page.textContent("#pos");
  check(bpmShown?.includes("180"), `tempo change reflected (${bpmShown?.trim()})`);

  // the visualizer canvas must have drawn events (non-background pixels)
  const painted = await page.evaluate(() => {
    const c = document.getElementById("viz");
    const ctx = c.getContext("2d");
    const img = ctx.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < img.length; i += 4) {
      // background is #0b0e14
      if (img[i] > 30 || img[i + 1] > 30 || img[i + 2] > 40) lit++;
    }
    return lit;
  });
  check(painted > 50, `visualizer drew events (lit px=${painted})`);

  // stop silences the meter
  await page.click("#stop");
  await page.waitForFunction(() => window.__muse.engine.playing === false);
  check(true, "stop works");

  const replError = await page.evaluate(() => Boolean(document.querySelector("#console .line.error")));
  check(!replError, "no REPL errors in console panel");

  // Draft persistence, backup, diagnostics and browser WAV export.
  await page.selectOption("#example", "drums");
  await page.waitForFunction(() => localStorage.getItem("muse.draft.v1")?.includes("Euclidean drums"));
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => Boolean(window.__muse));
  await page.waitForFunction(() => document.getElementById("editor").textContent.includes("Euclidean"));
  check(true, "draft restored after reload");
  await page.click("#restore");
  check(await page.evaluate(() => !localStorage.getItem("muse.draft.v1")?.includes("Euclidean drums")), "example backup restores original code");
  await page.selectOption("#example", "ambient");
  await page.fill("#export-seconds", "1");
  const downloadPromise = page.waitForEvent("download");
  await page.click("#export");
  const download = await downloadPromise;
  const wav = readFileSync(await download.path());
  check(wav.subarray(0, 4).toString() === "RIFF" && wav.length === 44 + 48000 * 4, "browser export downloads stereo WAV of requested length");
  await page.waitForFunction(() => !document.getElementById("export").disabled);

  // Load the exported audio as a custom instrument, then export a sample pattern.
  await page.setInputFiles("#sample-file", { name: "test.wav", mimeType: "audio/wav", buffer: wav });
  await page.waitForFunction(() => window.__muse.engine.samples.has("my_sample"));
  check(true, "custom audio sample loaded into engine");
  await page.locator("#editor .inputarea").focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText('sound("my_sample", "x*4")');
  await page.click("#run");
  await page.waitForFunction(() => window.__muse.engine.peak > 0.005);
  check(true, "custom sample plays through worklet DSP");
  await page.click("#stop");
  const sampleDownload = page.waitForEvent("download");
  await page.click("#export");
  const sampleWav = readFileSync(await (await sampleDownload).path());
  check(sampleWav.subarray(44).some((b) => b !== 0), "custom samples included in browser export");

  // Export evaluates code once in a disposable worker without DOM access.
  await page.waitForFunction(() => !document.getElementById("export").disabled);
  await page.locator("#editor .inputarea").focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText('globalThis.exportEvaluations = (globalThis.exportEvaluations || 0) + 1;\nif (globalThis.exportEvaluations !== 1 || typeof document !== "undefined") throw new Error("evaluation must run once in a worker");\nnote(60).sound("sine")');
  const singleEvaluation = page.waitForEvent("download");
  await page.click("#export");
  const onceWav = readFileSync(await (await singleEvaluation).path());
  check(await page.evaluate(() => globalThis.exportEvaluations === undefined) && onceWav.subarray(44).some((b) => b !== 0), "export evaluates code once and sends the resulting pattern to its worker");
  let sustainedEnergy = 0;
  const tailFrames = 4800;
  for (let offset = onceWav.length - tailFrames * 4; offset < onceWav.length; offset += 4) {
    sustainedEnergy += (onceWav.readInt16LE(offset) / 32768) ** 2;
  }
  const sustainedRms = Math.sqrt(sustainedEnergy / tailFrames);
  check(sustainedRms > 0.05 && sustainedRms < 0.25, "default-cutoff sine sustains through browser export");

  // Maximum-length sample names must work at a density that exceeded the old buffer.
  // Fast repeats need a fast-attack source, rather than the quiet ambient intro.
  const longName = "s".repeat(127);
  await page.fill("#sample-name", longName);
  await page.setInputFiles("#sample-file", { name: "long-name.wav", mimeType: "audio/wav", buffer: onceWav });
  await page.waitForFunction((name) => document.getElementById("sample-status").textContent === "sample saved: " + name, longName);
  await page.locator("#editor .inputarea").focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText(`sound("${longName}", "x*20").gain(0.3)`);
  const beforeLong = await page.evaluate(() => window.__muse.engine.scheduledTotal);
  await page.click("#run");
  await page.waitForFunction((before) => window.__muse.engine.scheduledTotal > before + 10 && window.__muse.engine.peak > 0.005, beforeLong);
  check(!(await page.textContent("#console")).includes("sched_query failed"), "127-character sample names schedule and play dense patterns");

  // Simulate processorerror through the real node, then rebuild using Play.
  check(await page.evaluate(() => {
    const engine = window.__muse.engine;
    engine.node.dispatchEvent(new Event("processorerror"));
    return !engine.audioReady && !engine.playing && engine.ctx === null;
  }), "processor failure clears audio and transport readiness");
  await page.click("#play");
  await page.waitForFunction(() => window.__muse.engine.audioReady && window.__muse.engine.playing && window.__muse.engine.workletDiag && window.__muse.engine.peak > 0.005);
  check(true, "Play rebuilds the failed audio engine with its pattern and samples");
  await page.click("#stop");

  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => Boolean(window.__muse));
  await page.waitForFunction((name) => window.__muse.engine.samples.has(name) && window.__muse.engine.samples.has("my_sample"), longName);
  check(await page.evaluate(() => !window.__muse.engine.audioReady), "samples restore from local storage without starting audio");
  await page.click("#run");
  await page.waitForFunction(() => window.__muse.engine.peak > 0.005);
  check(true, "restored samples play after reload");
  await page.click("#stop");
  await page.selectOption("#samples", longName);
  await page.click("#delete-sample");
  await page.waitForFunction((name) => !window.__muse.engine.samples.has(name), longName);
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => Boolean(window.__muse));
  await page.waitForFunction(() => document.getElementById("sample-status").textContent.includes("restored"));
  check(await page.evaluate((name) => !window.__muse.engine.samples.has(name) && window.__muse.engine.samples.has("my_sample"), longName), "sample deletion persists and preserves other samples");

  // All browser codec exports: decode real downloads instead of trusting filenames.
  const codecDirectory = mkdtempSync(join(tmpdir(), "muse-browser-codecs-"));
  try {
    await page.waitForFunction(() => !document.getElementById("export").disabled);
    await page.locator("#editor .inputarea").focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.insertText('note("d4 f#4 a4").sound("tri").cutoff(3000).gain(0.4)');
    let referencePcm = null;
    for (const [format, codec] of [["wav", "pcm_s16le"], ["mp3", "mp3"], ["flac", "flac"], ["ogg", "vorbis"], ["aac", "aac"], ["m4a", "aac"], ["mid", null]]) {
      await page.waitForFunction(() => !document.getElementById("export").disabled);
      await page.selectOption("#export-format", format);
      const downloading = page.waitForEvent("download", { timeout: 120000 });
      await page.click("#export");
      const downloaded = await downloading;
      check(downloaded.suggestedFilename() === "muse." + format, format + " browser filename matches format");
      const path = join(codecDirectory, "muse." + format);
      await downloaded.saveAs(path);
      if (format === "mid") {
        const midi = parseMidi(readFileSync(path));
        check(midi.header.format === 1 && midi.tracks.some((track) => track.some((e) => e.type === "noteOn")), "browser MIDI contains playable notes");
        continue;
      }
      const probe = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", path], { encoding: "utf8" });
      const stream = probe.status === 0 ? JSON.parse(probe.stdout).streams[0] : null;
      check(stream?.codec_name === codec && stream?.channels === 2 && Number(stream?.sample_rate) === 48000, format + " browser codec/stereo/sample rate verified");
      const decoded = spawnSync("ffmpeg", ["-v", "error", "-i", path, "-f", "s16le", "-acodec", "pcm_s16le", "-"], { maxBuffer: 4 * 1024 * 1024 });
      check(decoded.status === 0 && decoded.stdout.length > 48000 * 4 * 0.9 && decoded.stdout.some((b) => b !== 0), format + " browser download decodes to audible PCM");
      if (format === "wav") referencePcm = decoded.stdout;
      if (format === "flac") check(decoded.stdout.equals(referencePcm), "browser FLAC is bit-exact against WAV");
    }
  } finally { rmSync(codecDirectory, { recursive: true, force: true }); }
  await page.waitForFunction(() => !document.getElementById("export").disabled);
  await page.selectOption("#export-format", "wav");

  await page.locator("#editor .inputarea").focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText('const a = "bd";\nnote("c3", a)');
  await page.click("#run");
  await page.waitForSelector("#console .line.error");
  check((await page.textContent("#console")).includes("(2:"), "runtime error displays original line and column");

  // A broken encoder asset must recover the export UI and still allow WAV.
  const failurePage = await browser.newPage();
  try {
    await failurePage.route("**/*ffmpeg-core*.wasm", (route) => route.fulfill({ status: 404, body: "not found" }));
    await failurePage.goto("http://127.0.0.1:" + PORT + "/", { waitUntil: "load" });
    await failurePage.waitForFunction(() => Boolean(window.__muse));
    await failurePage.fill("#export-seconds", "1");
    await failurePage.selectOption("#export-format", "mp3");
    await failurePage.click("#export");
    await failurePage.waitForSelector("#console .line.error", { timeout: 30000 });
    check(await failurePage.locator("#export").isEnabled() && await failurePage.locator("#export-format").isEnabled(), "encoder load failure restores export controls");
    await failurePage.selectOption("#export-format", "wav");
    const recovery = failurePage.waitForEvent("download");
    await failurePage.click("#export");
    check((await recovery).suggestedFilename() === "muse.wav", "WAV works after encoder loading fails");
  } finally { await failurePage.close(); }

  // Loops must time out or be cancellable without blocking transport/UI.
  const resiliencePage = await browser.newPage();
  try {
    await resiliencePage.goto("http://127.0.0.1:" + PORT + "/", { waitUntil: "load" });
    await resiliencePage.waitForFunction(() => Boolean(window.__muse));
    const setCode = async (code) => {
      await resiliencePage.locator("#editor .inputarea").focus();
      await resiliencePage.keyboard.press("Control+a");
      await resiliencePage.keyboard.insertText(code);
    };
    await setCode("while (true) {}\n note(60)");
    await resiliencePage.click("#run");
    await resiliencePage.waitForFunction(() => document.getElementById("console").textContent.includes("evaluation timed out"));
    check(true, "infinite editor loops time out without freezing the UI");
    await resiliencePage.click("#run");
    await resiliencePage.click("#stop");
    await setCode('note(60).sound("sine")');
    await resiliencePage.click("#run");
    await resiliencePage.waitForFunction(() => window.__muse.engine.playing && window.__muse.engine.peak > 0.005);
    check(true, "Stop cancels evaluation and a fresh Run plays successfully");
    await resiliencePage.evaluate(() => {
      document.getElementById("play").click();
      document.getElementById("stop").click();
    });
    await sleep(100);
    check(await resiliencePage.evaluate(() => !window.__muse.engine.playing), "Stop supersedes a Play waiting for restored samples");
    await resiliencePage.click("#stop");
    await setCode("while (true) {}\n note(60)");
    await resiliencePage.click("#export");
    await resiliencePage.click("#cancel-export");
    check(await resiliencePage.locator("#export").isEnabled(), "export evaluation can be cancelled");
    await setCode('stack(...Array.from({length: 64}, (_, i) => note(30+i).sound("organ")))');
    await resiliencePage.fill("#export-seconds", "300");
    await resiliencePage.click("#export");
    await resiliencePage.waitForFunction(() => /^rendering [1-9]\d?%$/.test(document.getElementById("export").textContent));
    await resiliencePage.click("#cancel-export");
    check(await resiliencePage.locator("#export").isEnabled() && await resiliencePage.locator("#cancel-export").isDisabled(), "rendering reports progress and cancellation restores controls");
    await setCode('note(60).sound("sine")');
    await resiliencePage.fill("#export-seconds", "1");
    const recoveredExport = resiliencePage.waitForEvent("download");
    await resiliencePage.click("#export");
    check((await recoveredExport).suggestedFilename() === "muse.wav", "export works after cancelling a render");
    await resiliencePage.waitForFunction(() => !document.getElementById("export").disabled);
    let releaseEncoder;
    const encoderGate = new Promise((resolve) => { releaseEncoder = resolve; });
    await resiliencePage.route("**/*ffmpeg-core*.wasm", async (route) => {
      await encoderGate;
      try { await route.continue(); } catch { /* cancelled worker request */ }
    });
    try {
      await resiliencePage.selectOption("#export-format", "mp3");
      const encoderRequested = resiliencePage.waitForRequest("**/*ffmpeg-core*.wasm");
      await resiliencePage.click("#export");
      await encoderRequested;
      await resiliencePage.click("#cancel-export");
      check(await resiliencePage.locator("#export").isEnabled() && await resiliencePage.locator("#export-format").isEnabled(), "encoder loading can be cancelled without trapping the UI");
    } finally {
      releaseEncoder();
      await resiliencePage.unroute("**/*ffmpeg-core*.wasm");
      await resiliencePage.selectOption("#export-format", "wav");
    }
    await setCode('fast(1e9, "bd")');
    await resiliencePage.click("#run");
    await resiliencePage.waitForFunction(() => document.getElementById("console").textContent.includes("query work or event limit"));
    check(await resiliencePage.evaluate(() => !window.__muse.engine.playing), "excessive queries stop playback with an actionable error");
    await setCode('stack(...Array.from({length: 129}, (_, i) => note(i).sound("sine")))');
    await resiliencePage.click("#run");
    await resiliencePage.waitForFunction(() => document.getElementById("console").textContent.includes("audio overloaded"));
    check(true, "audio capacity limits are reported in the UI");
    await resiliencePage.click("#stop");
  } finally { await resiliencePage.close(); }

  // When local storage is unavailable, samples still work for the session.
  const storagePage = await browser.newPage();
  try {
    await storagePage.addInitScript(() => {
      Object.defineProperty(globalThis, "indexedDB", { value: { open() { throw new Error("storage unavailable"); } } });
    });
    await storagePage.goto("http://127.0.0.1:" + PORT + "/", { waitUntil: "load" });
    await storagePage.waitForFunction(() => Boolean(window.__muse));
    await storagePage.waitForFunction(() => document.getElementById("sample-status").textContent.includes("could not be restored"));
    await storagePage.setInputFiles("#sample-file", { name: "session.wav", mimeType: "audio/wav", buffer: wav });
    await storagePage.waitForFunction(() => document.getElementById("sample-status").textContent.includes("could not save"));
    check(await storagePage.evaluate(() => window.__muse.engine.samples.has("my_sample")), "samples remain available when saving fails");
    await storagePage.locator("#editor .inputarea").focus();
    await storagePage.keyboard.press("Control+a");
    await storagePage.keyboard.insertText('sound("my_sample", "x*4")');
    await storagePage.click("#run");
    await storagePage.waitForFunction(() => window.__muse.engine.peak > 0.005);
    await storagePage.click("#delete-sample");
    await storagePage.waitForFunction(() => !window.__muse.engine.samples.has("my_sample"));
    check(await storagePage.locator("#delete-sample").isDisabled(), "session samples can be removed when persistent storage is unavailable");
    await storagePage.click("#stop");
  } finally { await storagePage.close(); }

  check(consoleErrors.length === 0, `no browser console errors${consoleErrors.length ? `: ${consoleErrors[0]}` : ""}`);
} catch (e) {
  check(false, `unexpected failure: ${e}`);
} finally {
  await browser.close();
  server.close();
}

console.log(failures.length ? `\n${failures.length} check(s) FAILED` : "\nall e2e checks passed");
process.exit(failures.length ? 1 : 0);
