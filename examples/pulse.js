// Pulse bass over a Euclidean beat.
stack(
  euclid(3, 8, "bd"),
  "~ sn ~ sn",
  gain(0.3, "hh*8").crush(0.3),
  note("c2 c2 g1 <eb2 f2>").sound("pulse").cutoff(800).res(0.4).gain(0.5)
)
