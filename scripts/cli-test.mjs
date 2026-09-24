// CLI smoke test: exercises the bundled dist/cli/muse.cjs end-to-end.
//
//   node scripts/cli-test.mjs   (build first: bash scripts/build-cli.sh)

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";

const CLI = "dist/cli/muse.cjs";
const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}`);
  if (!ok) failures.push(label);
};

if (!existsSync(CLI)) {
  console.error("missing dist/cli/muse.cjs — run: bash scripts/build-cli.sh");
  process.exit(1);
}

// 1. --help
{
  const r = spawnSync("node", [CLI, "--help"], { encoding: "utf8" });
  check(r.status === 0 && r.stdout.includes("live music DSL"), "--help exits 0 and prints usage");
}

// 2. --version
{
  const r = spawnSync("node", [CLI, "--version"], { encoding: "utf8" });
  check(r.status === 0 && /^\d+\.\d+\.\d+/.test(r.stdout.trim()), `--version (${r.stdout.trim()})`);
}

// 3. run a pattern file → wav
const WAV = "/tmp/muse-cli-test.wav";
{
  rmSync(WAV, { force: true });
  const r = spawnSync(
    "node",
    [CLI, "run", "examples/demo.js", "--seconds", "2", "--no-play", "-o", WAV],
    { encoding: "utf8" },
  );
  check(r.status === 0, `run exits 0 (stderr: ${r.stderr.trim().slice(0, 120)})`);
  check(existsSync(WAV), "wav file written");

  if (existsSync(WAV)) {
    const buf = readFileSync(WAV);
    const expected = 44 + 48000 * 2 * 2 * 2; // 2 s stereo 16-bit @48k
    check(buf.length === expected, `wav size exact (${buf.length} vs ${expected})`);
    check(buf.subarray(0, 4).toString() === "RIFF", "RIFF magic");

    // compute RMS from the PCM payload
    let sum = 0;
    const n = (buf.length - 44) / 2;
    for (let i = 0; i < n; i++) {
      const v = buf.readInt16LE(44 + i * 2) / 32768;
      sum += v * v;
    }
    const r2 = Math.sqrt(sum / n);
    check(r2 > 0.01, `rendered audio is audible (rms=${r2.toFixed(3)})`);
    check(r.stdout.includes("✓"), "run reports stats");
  }
}

// 4. syntax error → non-zero exit
{
  const r = spawnSync("node", [CLI, "run", "/dev/null", "--no-play"], { encoding: "utf8" });
  check(r.status !== 0, "empty program rejected");
}

// 5. scripted REPL over stdin
{
  const input = [
    ":bpm 140",
    'stack("bd . sn .", gain(0.6, "hh/2"))',
    'note("c3 e3 g3 b3").delay(0.3)',
    "this is not valid js)))",
    ":help",
    ":bpm",
    ":quit",
    "",
  ].join("\n");
  const r = spawnSync("node", [CLI, "repl", "--no-audio"], {
    encoding: "utf8",
    input,
    timeout: 20000,
  });
  check(r.status === 0, `repl exits 0 (status=${r.status})`);
  check(r.stdout.includes("pattern installed"), "repl evaluated patterns");
  check(r.stdout.includes("✗"), "repl reported the syntax error");
  check(r.stdout.includes("bye"), "repl said goodbye");
  check(r.stdout.includes("140 bpm"), "bpm command applied");
  check(!r.stdout.includes("undefined NaN"), "no NaN leaks in output");
}

console.log(failures.length ? `\n${failures.length} check(s) FAILED` : "\nall cli checks passed");
process.exit(failures.length ? 1 : 0);
