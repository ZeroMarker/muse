// muse demo — `muse run examples/demo.js --bpm 120`

const drums = stack(
  "bd . hh bd . hh . hh",
  gain(0.5, fast(2, "sn . . sn")),
  gain(0.35, "hh*4"),
);

const bass = note("c2 . . c2 . g1 . .")
  .gain(0.8)
  .cutoff(500);

const lead = every(2, rev, note("c3 e3 g3 b3"))
  .gain(0.45)
  .delay(0.35);

stack(drums, bass, lead);
