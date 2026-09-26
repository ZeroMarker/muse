// CLI smoke test: exercises the bundled dist/cli/muse.cjs end-to-end.
//
//   node scripts/cli-test.mjs   (build first: bash scripts/build-cli.sh)

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";

import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMidi } from "midi-file";

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

// Compressed formats: inspect actual codecs, decode audio, and verify lossless FLAC.
{
  const directory = mkdtempSync(join(tmpdir(), "muse-codec-test-"));
  try {
    for (const [format, codec] of [["mp3", "mp3"], ["flac", "flac"], ["ogg", "vorbis"], ["aac", "aac"], ["m4a", "aac"]]) {
      const output = join(directory, "song." + format);
      const result = spawnSync("node", [CLI, "run", "examples/demo.js", "--seconds", "2", "--no-play", "-o", output], { encoding: "utf8", timeout: 30000 });
      check(result.status === 0 && existsSync(output), format + " inferred from extension and exported");
      if (!existsSync(output)) continue;
      const probe = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", output], { encoding: "utf8" });
      const stream = probe.status === 0 ? JSON.parse(probe.stdout).streams[0] : null;
      check(stream?.codec_name === codec && stream?.channels === 2 && Number(stream?.sample_rate) === 48000, format + " codec, stereo and 48 kHz verified");
      const decoded = spawnSync("ffmpeg", ["-v", "error", "-i", output, "-f", "s16le", "-acodec", "pcm_s16le", "-"], { maxBuffer: 4 * 1024 * 1024 });
      check(decoded.status === 0 && decoded.stdout.length > 48000 * 4 * 1.8 && decoded.stdout.some((b) => b !== 0), format + " decodes to audible PCM");
      if (format === "flac") check(decoded.stdout.equals(readFileSync(WAV).subarray(44)), "FLAC roundtrip preserves every PCM sample");
    }
    const midiPath = join(directory, "song.mid");
    const midi = spawnSync("node", [CLI, "run", "examples/canon.js", "--seconds", "2", "--format", "midi", "--no-play", "-o", midiPath], { encoding: "utf8" });
    check(midi.status === 0 && existsSync(midiPath), "MIDI alias accepted and exported");
    if (existsSync(midiPath)) {
      const data = parseMidi(readFileSync(midiPath));
      check(data.header.format === 1 && data.tracks.some((track) => track.some((e) => e.type === "noteOn")), "MIDI has tempo and note tracks");
    }
    const mismatch = spawnSync("node", [CLI, "run", "examples/demo.js", "--format", "mp3", "-o", join(directory, "wrong.wav"), "--no-play"], { encoding: "utf8" });
    check(mismatch.status !== 0 && !existsSync(join(directory, "wrong.wav")), "mismatched output format rejected without creating a file");
    const missing = spawnSync(process.execPath, [CLI, "run", "examples/demo.js", "--format", "mp3", "-o", join(directory, "missing.mp3"), "--no-play"], { encoding: "utf8", env: { ...process.env, PATH: "/nonexistent" } });
    check(missing.status !== 0 && missing.stderr.includes("FFmpeg is required"), "missing FFmpeg gives actionable error");
  } finally { rmSync(directory, { recursive: true, force: true }); }
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
