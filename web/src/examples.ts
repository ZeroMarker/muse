export const EXAMPLES: Record<string, string> = {
  drums: '// Euclidean drums\nstack(\n  euclid(3, 8, "bd"),\n  gain(0.5, "hh*8"),\n  gain(0.7, "~ sn ~ sn")\n)',
  ambient: '// Organ chords with delay\nstack(\n  note("c3 e3 g3 b3").sound("organ").slow(4).attack(0.3).release(1).gain(0.4),\n  note("c4 g4 e4 b4").sound("sine").slow(2).pan(0.8).gain(0.3)\n).delay(0.6)',
  pulse: '// Pulse bass and drums\nstack(\n  "bd ~ sn ~",\n  note("c2 c2 g1 <eb2 f2>").sound("pulse").cutoff(800).res(0.4).gain(0.5),\n  gain(0.3, "hh*8").crush(0.3)\n)',
};
