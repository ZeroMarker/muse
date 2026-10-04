import {afterEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../src/audio/engine";
import { atom } from "../src/ir";
import { WasmCore } from "../src/wasm";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function audioMocks(failFirst = false) {
  let contexts = 0;
  const close = vi.fn(async () => {});
  const disconnect = vi.fn();
  const nodes: EventTarget[] = [];
  const schedFree = vi.fn();
  const setPattern = vi.fn(() => 1);
  vi.spyOn(WasmCore, "fetchBytes").mockResolvedValue(new ArrayBuffer(8));
  vi.spyOn(WebAssembly, "instantiate").mockResolvedValue({
    instance: { exports: { sched_new: () => 1, sched_free: schedFree, sched_set_pattern: setPattern,
      memory: new WebAssembly.Memory({ initial: 1 }), muse_alloc: () => 1024, muse_free: () => {},
      ir_decode: () => 1, ir_release: () => {} } },
  } as unknown as WebAssembly.Instance);
  vi.stubGlobal("AudioContext", class {
    sampleRate = 48000;
    baseLatency = 0.01;
    close = close;
    audioWorklet = { addModule: async () => { if (failFirst && contexts === 1) throw new Error("module failed"); } };
    constructor() { contexts++; }
  });
  vi.stubGlobal("AudioWorkletNode", class extends EventTarget {
    constructor() { super(); nodes.push(this); }
    port = { onmessage: null as null | ((event: { data: { type: string } }) => void), close: vi.fn(), postMessage: vi.fn((message: { type: string }) => {
      if (message.type === "init") queueMicrotask(() => this.port.onmessage?.({ data: { type: "ready" } }));
    }) };
    connect() {}
    disconnect = disconnect;
  });
  return { count: () => contexts, close, disconnect, nodes, schedFree, setPattern };
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
  it("resets a failed processor and restores the installed pattern and samples on retry", async () => {
    const mocks = audioMocks();
    const engine = new Engine();
    engine.registerSample("sample", { data: new Float32Array([0.5]), rate: 48000 });
    await engine.init("processor", "wasm");
    engine.setPattern(atom("sample"));
    mocks.nodes[0].dispatchEvent(new Event("processorerror"));
    expect(engine.audioReady).toBe(false);
    expect(engine.playing).toBe(false);
    expect(engine.ctx).toBeNull();
    expect(mocks.schedFree).toHaveBeenCalledOnce();
    await engine.init("processor", "wasm");
    expect(engine.audioReady).toBe(true);
    expect(mocks.count()).toBe(2);
    expect(mocks.setPattern).toHaveBeenCalledTimes(2);
    const node = mocks.nodes[1] as EventTarget & { port: { postMessage: ReturnType<typeof vi.fn> } };
    expect(node.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "sample", name: "sample" }));
    // Errors from an old processor must not tear down its replacement.
    mocks.nodes[0].dispatchEvent(new Event("processorerror"));
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
