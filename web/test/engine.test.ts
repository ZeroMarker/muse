import {afterEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../src/audio/engine";
import { WasmCore } from "../src/wasm";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function audioMocks(failFirst = false) {
  let contexts = 0;
  const close = vi.fn(async () => {});
  const disconnect = vi.fn();
  vi.spyOn(WasmCore, "fetchBytes").mockResolvedValue(new ArrayBuffer(8));
  vi.spyOn(WebAssembly, "instantiate").mockResolvedValue({
    instance: { exports: { sched_new: () => 1 } },
  } as unknown as WebAssembly.Instance);
  vi.stubGlobal("AudioContext", class {
    sampleRate = 48000;
    baseLatency = 0.01;
    close = close;
    audioWorklet = { addModule: async () => { if (failFirst && contexts === 1) throw new Error("module failed"); } };
    constructor() { contexts++; }
  });
  vi.stubGlobal("AudioWorkletNode", class {
    port = { onmessage: null as null | ((event: { data: { type: string } }) => void), close: vi.fn(), postMessage: () => {
      queueMicrotask(() => this.port.onmessage?.({ data: { type: "ready" } }));
    } };
    connect() {}
    disconnect = disconnect;
    addEventListener() {}
  });
  return { count: () => contexts, close, disconnect };
}

describe("audio initialization", () => {
  it("honours Stop while initialization is pending", async () => {
    audioMocks();
    const engine = new Engine();
    engine.initIfNeeded = () => engine.init("processor", "wasm");
    const playing = engine.play();
    engine.stop();
    await playing;
    expect(engine.playing).toBe(false);
    expect(engine.audioReady).toBe(true);
  });
  it("shares a single initialization across simultaneous calls", async () => {
    const mocks = audioMocks();
    const engine = new Engine();
    await Promise.all([engine.init("processor", "wasm"), engine.init("processor", "wasm")]);
    expect(mocks.count()).toBe(1);
    expect(engine.audioReady).toBe(true);
  });
  it("closes failed contexts and allows a fresh retry", async () => {
    const mocks = audioMocks(true);
    const engine = new Engine();
    await expect(engine.init("processor", "wasm")).rejects.toThrow("module failed");
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(engine.ctx).toBeNull();
    expect(engine.core).toBeNull();
    await engine.init("processor", "wasm");
    expect(mocks.count()).toBe(2);
    expect(engine.audioReady).toBe(true);
  });
});
