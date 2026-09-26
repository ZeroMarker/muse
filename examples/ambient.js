// Slow organ harmony and stereo sine melody.
stack(
  note("c3 e3 g3 b3").sound("organ").slow(4).attack(0.3).release(1).chorus(0.01),
  note("c4 g4 e4 b4").sound("sine").slow(2).pan(0.8).echo(3, 0.25, 0.4)
).delay(0.4)
