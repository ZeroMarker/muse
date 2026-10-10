import {afterEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../src/audio/engine";
import { atom } from "../src/ir";
import { WasmCore } from "../src/wasm";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function audioMocks(failFirst = false) {
  let contexts = 0;
  const close = vi.fn(async () => {});
  const disconnect = vi.fn();
  const nodes: EventTarget[] = [];
  const schedFree = vi.fn();
  const setPattern = vi.fn(() => 1);
  const peek = vi.fn(() => 0);
  const alloc = vi.fn(() => 1024);
  const free = vi.fn();
  vi.spyOn(WasmCore, "fetchBytes").mockResolvedValue(new ArrayBuffer(8));
  vi.spyOn(WebAssembly, "instantiate").mockResolvedValue({
    instance: { exports: { sched_new: () => 1, sched_free: schedFree, sched_set_pattern: setPattern,
      memory: new WebAssembly.Memory({ initial: 4 }), muse_alloc: alloc, muse_free: free,
      sched_reset: () => {}, sched_set_cps: () => {}, sched_cycle_at: (_h: number, t: number) => t,
      sched_peek: peek,
      ir_decode: () => 1, ir_release: () => {} } },
  } as unknown as WebAssembly.Instance);
  vi.stubGlobal("AudioContext", class {
    currentTime = 0;
    resume = async () => {};
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
  return { count: () => contexts, close, disconnect, nodes, schedFree, setPattern, peek, alloc, free };
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
  it("checks the sample budget before allocating and mixing mono PCM", async () => {
    audioMocks();
    const engine = new Engine();
    engine.initIfNeeded = () => engine.init("processor", "wasm");
    await engine.initIfNeeded();
    const sample = { data: new Float32Array(1024 * 1024), rate: 48000 };
    for (let i = 0; i < 32; i++) engine.registerSample("s" + i, sample);
    const getChannelData = vi.fn();
    engine.ctx!.decodeAudioData = vi.fn(async () => ({ duration: 0.1, length: 4800, numberOfChannels: 2, sampleRate: 48000, getChannelData } as unknown as AudioBuffer));
    await expect(engine.loadSample("extra", new ArrayBuffer(8))).rejects.toThrow(/128 MiB/);
    expect(getChannelData).not.toHaveBeenCalled();
    expect(engine.samples.size).toBe(32);
  });
  it("rejects nonfinite tempos without changing the clock", () => {
    const engine = new Engine();
    engine.setCps(2);
    for (const cps of [0, -1, NaN, Infinity]) expect(() => engine.setCps(cps)).toThrow(/tempo/);
    expect(engine.cps).toBe(2);
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


describe("visualization scheduling", () => {
  async function setup() {
    const mocks = audioMocks();
    const scheduled = vi.spyOn(WasmCore.prototype, "queryScheduled").mockReturnValue([]);
    const visualize = vi.fn();
    const engine = new Engine();
    engine.hooks.onVisualize = visualize;
    await engine.init("processor", "wasm");
    vi.useFakeTimers();
    await engine.play();
    const advance = (time: number) => {
      Object.defineProperty(engine.ctx!, "currentTime", { value: time, configurable: true });
      vi.advanceTimersByTime(60);
    };
    return { engine, mocks, scheduled, visualize, advance };
  }

  it("keeps audio ticks at 60 ms while halving visual queries and reusing the buffer", async () => {
    const { engine, mocks, scheduled, visualize, advance } = await setup();
    try {
      for (let i = 1; i <= 10; i++) advance(i * 0.06);
      expect(scheduled).toHaveBeenCalledTimes(11);
      expect(mocks.peek).toHaveBeenCalledTimes(6);
      expect(visualize).toHaveBeenCalledTimes(6);
      expect(mocks.alloc).toHaveBeenCalledTimes(1);
      expect(mocks.free).not.toHaveBeenCalled();
      engine.setCps(2);
      expect(mocks.peek).toHaveBeenCalledTimes(7);
      engine.setPattern(atom("bd"));
      expect(mocks.peek).toHaveBeenCalledTimes(8);
    } finally { engine.stop(); }
  });

  it("skips hidden or unobserved visualizations while audio scheduling continues", async () => {
    const { engine, mocks, scheduled, advance } = await setup();
    try {
      const page = { hidden: true };
      vi.stubGlobal("document", page);
      advance(0.12);
      advance(0.24);
      expect(mocks.peek).toHaveBeenCalledTimes(1);
      page.hidden = false;
      advance(0.30);
      expect(mocks.peek).toHaveBeenCalledTimes(2);
      engine.hooks.onVisualize = undefined;
      advance(0.42);
      expect(mocks.peek).toHaveBeenCalledTimes(2);
      expect(scheduled).toHaveBeenCalledTimes(5);
    } finally { engine.stop(); }
  });

  it("releases the visual buffer on processor failure and allocates a fresh one on recovery", async () => {
    const { engine, mocks } = await setup();
    try {
      mocks.nodes[0].dispatchEvent(new Event("processorerror"));
      expect(mocks.free).toHaveBeenCalledExactlyOnceWith(1024, 128 * 1024);
      vi.useRealTimers();
      await engine.init("processor", "wasm");
      vi.useFakeTimers();
      await engine.play();
      expect(mocks.alloc).toHaveBeenCalledTimes(2);
      expect(mocks.peek).toHaveBeenCalledTimes(2);
      expect(engine.playing).toBe(true);
    } finally { engine.stop(); }
  });
});
