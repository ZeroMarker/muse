// CLI smoke test: exercises the bundled dist/cli/muse.cjs end-to-end.
//
//   node scripts/cli-test.mjs   (build first: bash scripts/build-cli.sh)

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, truncateSync, rmSync, mkdtempSync } from "node:fs";

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

// Invalid inputs must fail before creating output, rather than using defaults.
{
  const directory = mkdtempSync(join(tmpdir(), "muse-input-test-"));
  try {
    const output = join(directory, "invalid.wav");
    for (const args of [["--seconds", "invalid"], ["--seconds", "0"], ["--seconds", "301"],
      ["--bpm", "invalid"], ["--bpm", "0"], ["--seconds"], ["--bpm"], ["--out"], ["--secnds", "1"]]) {
      const result = spawnSync("node", [CLI, "run", "examples/demo.js", "--no-play", "-o", output, ...args], { encoding: "utf8" });
      check(result.status !== 0 && !existsSync(output), "invalid CLI input rejected: " + args.join(" "));
    }
    const program = join(directory, "sample.js");
    writeFileSync(program, 'sound("bd", "x").gain(0.5)');
    // Silence overriding a builtin proves that audio is decoded and loaded, not ignored.
    const silentWav = Buffer.from(readFileSync(WAV));
    silentWav.fill(0, 44);
    const silentPath = join(directory, "silence.wav");
    writeFileSync(silentPath, silentWav);
    const sampleOutput = join(directory, "sample.wav");
    const sampled = spawnSync("node", [CLI, "run", program, "--sample", "bd=" + silentPath,
      "--seconds", "0.5", "--no-play", "-o", sampleOutput], { encoding: "utf8" });
    check(sampled.status === 0 && existsSync(sampleOutput) && !readFileSync(sampleOutput).subarray(44).some((b) => b !== 0), "CLI loads sample audio and overrides builtin instruments");
    const audibleOutput = join(directory, "audible.wav");
    const audible = spawnSync("node", [CLI, "run", program, "--sample", "bd=" + WAV,
      "--seconds", "0.5", "--no-play", "-o", audibleOutput], { encoding: "utf8" });
    check(audible.status === 0 && existsSync(audibleOutput) && readFileSync(audibleOutput).subarray(44).some((b) => b !== 0), "CLI sample rendering produces audio");
    const sampleMidi = join(directory, "sample.mid");
    const midi = spawnSync("node", [CLI, "run", program, "--sample", "bd=" + WAV, "--seconds", "0.5", "--no-play", "-o", sampleMidi], { encoding: "utf8" });
    check(midi.status === 0 && existsSync(sampleMidi) && parseMidi(readFileSync(sampleMidi)).tracks.some((track) => track.some((event) => event.type === "noteOn" && event.channel !== 9)), "CLI MIDI maps overridden drums to sample notes");
    const longPath = join(directory, "too-long.wav");
    const longWav = Buffer.alloc(44 + 31 * 48000 * 4);
    silentWav.copy(longWav, 0, 0, 44);
    longWav.writeUInt32LE(longWav.length - 8, 4);
    longWav.writeUInt32LE(longWav.length - 44, 40);
    writeFileSync(longPath, longWav);
    const overlong = spawnSync("node", [CLI, "run", program, "--sample", "bd=" + longPath, "--no-play", "-o", output], { encoding: "utf8" });
    check(overlong.status !== 0 && overlong.stderr.includes("at most 30 seconds") && !existsSync(output), "CLI rejects samples longer than 30 seconds");
    const largePath = join(directory, "too-large.wav");
    writeFileSync(largePath, silentWav.subarray(0, 44));
    truncateSync(largePath, 51 * 1024 * 1024);
    const oversized = spawnSync("node", [CLI, "run", program, "--sample", "bd=" + largePath, "--no-play", "-o", output], { encoding: "utf8" });
    check(oversized.status !== 0 && oversized.stderr.includes("50 MiB") && !existsSync(output), "CLI rejects sample files larger than 50 MiB");
    const missing = spawnSync(process.execPath, [CLI, "run", program, "--sample", "bd=" + WAV, "--no-play", "-o", output], { encoding: "utf8", env: { ...process.env, PATH: "/nonexistent" } });
    check(missing.status !== 0 && missing.stderr.includes("FFmpeg is required") && !existsSync(output), "CLI sample decoder reports missing FFmpeg");
    const repl = spawnSync("node", [CLI, "repl", "--no-audio", "--sample", "bd=" + WAV], { encoding: "utf8", input: 'sound("bd", "x*4")\n:quit\n', timeout: 20000 });
    check(repl.status === 0 && repl.stdout.includes("pattern installed"), "REPL accepts sample files");
    for (const sample of ["bad-name=" + WAV, "missing=" + join(directory, "missing.wav"), "bd", "bd="]) {
      const invalid = spawnSync("node", [CLI, "run", program, "--sample", sample, "--no-play", "-o", output], { encoding: "utf8" });
      check(invalid.status !== 0 && !existsSync(output), "invalid sample rejected: " + sample);
    }
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
    ":bpm invalid",
    ":bpm 0",
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
  check(r.stdout.includes("needs a number between 20 and 300") && !r.stdout.includes("→ 20 bpm"), "invalid REPL tempo preserves the current tempo");
  check(!r.stdout.includes("undefined NaN"), "no NaN leaks in output");
}

console.log(failures.length ? `\n${failures.length} check(s) FAILED` : "\nall cli checks passed");
process.exit(failures.length ? 1 : 0);
