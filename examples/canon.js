// Canon in D — Johann Pachelbel · looping arrangement
// Ctrl+Enter to play · Ctrl+. to stop · suggested tempo: 90 bpm
// Ground bass: D – A – Bm – F#m – G – D – G – A

const bass = note("d2 a1 b1 f#1 g1 d2 g1 a1")
  .slow(8).sound("sine")
  .attack(0.015).release(0.12).cutoff(600).gain(0.65);

const harmony = note(`
  (d3 f#3 a3) (a2 c#3 e3) (b2 d3 f#3) (f#2 a2 c#3)
  (g2 b2 d3) (d3 f#3 a3) (g2 b2 d3) (a2 c#3 e3)
`).slow(8).sound("organ")
  .attack(0.08).release(0.2).cutoff(2500).gain(0.16);

const theme = note(`
  f#4 e4 d4 c#4 b3 a3 b3 c#4
  d4 c#4 b3 a3 g3 f#3 g3 e3
  [d4 f#4] [a4 g4] [f#4 d4] [f#4 e4]
  [d4 b3] [d4 a4] [g4 b4] [a4 g4]
  [f#4 d4] [e4 c#5] [d5 f#5] [a5 a4]
  [b4 g4] [a4 f#4] [d4 d5] [d5 c#5]
`).slow(32).sound("tri")
  .attack(0.012).release(0.16).cutoff(4200);

// Three imitative voices, one bass progression (8 beats) apart.
stack(
  bass,
  harmony,
  theme.gain(0.38).pan(0.25),
  theme.shift(8).gain(0.28).pan(0.75),
  theme.shift(16).gain(0.22).pan(0.5)
).delay(0.12)
