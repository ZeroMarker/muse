// End-to-end smoke test: serves dist/, opens the app in headless Chromium,
// runs the editor and verifies the full pipeline:
//   Monaco → REPL → IR encode → wasm decode/scheduler → worklet DSP → meter.
//
//   node scripts/e2e.mjs

import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const ROOT = new URL("../dist", import.meta.url).pathname;
const PORT = 4319;

if (!existsSync(join(ROOT, "index.html"))) {
  console.error("dist/ not built — run: npm run build");
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
  await page.evaluate(() => {
    const r = window.__muse.evaluate('sound("bd", euclid(5, 8, "bd"))');
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

  check(consoleErrors.length === 0, `no browser console errors${consoleErrors.length ? `: ${consoleErrors[0]}` : ""}`);
} catch (e) {
  check(false, `unexpected failure: ${e}`);
} finally {
  await browser.close();
  server.close();
}

console.log(failures.length ? `\n${failures.length} check(s) FAILED` : "\nall e2e checks passed");
process.exit(failures.length ? 1 : 0);
