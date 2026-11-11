# JPEG fixtures for `src/report_jpeg.ts`

Small JPEGs of one **synthetic** picture (157 × 93 px: gradients, edges and seeded noise, made in
code — no photograph, no client data), each a shape `optimizeJpeg` must read correctly or leave
alone. Made 2026-11-11 with libjpeg-turbo 2.1.5's `cjpeg` (Ubuntu's `libjpeg-turbo-progs`), quality
85:

| File | `cjpeg` options | Expected |
|---|---|---|
| `ycc420.jpg` | (defaults: 2×2 chroma) | re-coded |
| `ycc422.jpg` | `-sample 2x1` | re-coded |
| `ycc444.jpg` | `-sample 1x1` | re-coded |
| `gray.jpg` | `-grayscale` | re-coded |
| `restart-rows.jpg` | `-restart 1` (each MCU row) | re-coded, its restart markers kept |
| `restart-3mcu.jpg` | `-restart 3B` (every 3 MCUs) | re-coded, its restart markers kept |
| `three-scans.jpg` | `-scans` one component per scan (`0;` `1;` `2;`) | re-coded, scan by scan |
| `three-scans-restart.jpg` | the same, `-restart 2B` | re-coded |
| `already-optimal.jpg` | `-optimize` | its scans unchanged (12 bytes saved by one DHT segment for four) |
| `progressive.jpg` | `-progressive` | left as it is |
| `arithmetic.jpg` | `-arithmetic` | left as it is |

`jpegtran/` holds the reference: each re-codable file through libjpeg-turbo's `jpegtran -copy all
-optimize` (with the same `-restart` / `-scans` as its source, so its structure is the same). Each
scan's entropy-coded data `optimizeJpeg` writes must be **byte-identical** to the reference's —
the same optimal tables, by the same procedure (Annex K.2). The files differ only in how the tables
are packed: `jpegtran` writes one table per DHT segment.
