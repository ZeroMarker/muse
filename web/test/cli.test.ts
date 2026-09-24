// Offline renderer tests — the CLI's `muse run` path.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { loadCore } from "../../cli/core";
import { encodeWav, renderOffline, rms, SAMPLE_RATE } from "../../cli/wav";
import { mini } from "../src/mini";
import { stack } from "../src/dsl";

const WASM_HINT = resolve(process.cwd(), "web/public/muse_core.wasm");

describe("cli offline render (muse run)", () => {
  it("renders audible stereo audio", async () => {
    expect(existsSync(WASM_HINT), "run npm run build:wasm first").toBe(true);
    const core = await loadCore();
    const pat = stack("bd . hh .", "sn . . sn").pat;
    const pcm = renderOffline(core, pat, 1.5, 2);

    expect(pcm.length).toBe(1.5 * SAMPLE_RATE * 2);
    expect(rms(pcm)).toBeGreaterThan(0.01);
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]) / 32768);
    expect(peak).toBeLessThanOrEqual(1);
    expect(peak).toBeGreaterThan(0.1);
  });

  it("renders silence for silence", async () => {
    const core = await loadCore();
    const pcm = renderOffline(core, mini(""), 1, 2);
    expect(rms(pcm)).toBe(0);
  });

  it("pitched patterns produce sustained output", async () => {
    const core = await loadCore();
    const pcm = renderOffline(core, mini("c3 e3 g3"), 1, 2);
    expect(rms(pcm)).toBeGreaterThan(0.01);
  });

  it("encodes a valid wav header", async () => {
    const core = await loadCore();
    const pcm = renderOffline(core, mini("bd"), 0.5, 2);
    const wav = encodeWav(pcm, SAMPLE_RATE, 2);
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(SAMPLE_RATE);
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.length).toBe(44 + pcm.length * 2);
    expect(wav.readUInt32LE(40)).toBe(pcm.length * 2);
  });

  it("is deterministic (same input → identical bytes)", async () => {
    const core = await loadCore();
    const pat = stack("bd . sn .", "hh/2").pat;
    const a = renderOffline(core, pat, 0.5, 2);
    const b = renderOffline(core, pat, 0.5, 2);
    expect(Buffer.from(a.buffer)).toEqual(Buffer.from(b.buffer));
  });
});
