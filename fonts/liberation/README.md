# Liberation Fonts 2.1.5

The fonts the native renderer (`src/report_render.ts`) draws text in, and embeds — subset to the
glyphs printed — in every PDF it makes, so the PDF shows the same letters on every viewer.

**Licence: SIL Open Font License, Version 1.1** — the full text is [LICENSE](LICENSE), the authors
are in [AUTHORS](AUTHORS). Copyright © 2010 Google Corporation, with Reserved Font Arimo, Tinos and
Cousine; copyright © 2012 Red Hat, Inc., with Reserved Font Name Liberation. These files are
redistributed unmodified, with that licence, as the OFL requires; they are not sold by themselves.
A PDF that embeds them is a document, not the Font Software: the OFL permits embedding, and its
condition 5 ends "The requirement for fonts to remain under this license does not apply to any
document created using the Font Software."

## Why these

They are metric-compatible with the faces Chrome draws a SkyCiv report in on Windows: every glyph has
the same advance width, so lines break where the layout measured them.

| Family | Stands in for | Used when the CSS asks for |
|---|---|---|
| Liberation Sans | Arial | `Arial`, `Helvetica`, `Helvetica Neue`, `sans-serif` (SkyCiv's `Lato` is not on the host: the next name in its list is) |
| Liberation Mono | Courier New | `Courier New`, `Courier`, `monospace` |
| Liberation Serif | Times New Roman | `Times New Roman`, `Times`, `serif` — and text with no font named (a browser's default) |

## Where they came from

The upstream release `liberation-fonts-ttf-2.1.5.tar.gz`, from
<https://github.com/liberationfonts/liberation-fonts/releases> (asset
`files/7261482/liberation-fonts-ttf-2.1.5.tar.gz`), downloaded 2026-11-11.

```
7191c669bf38899f73a2094ed00f7b800553364f90e2637010a69c0e268f25d0  liberation-fonts-ttf-2.1.5.tar.gz
```

The twelve fonts, `LICENSE` and `AUTHORS` copied from it unchanged (README, ChangeLog and TODO left
out). SHA-256 of each font:

```
bd62a0672d0b9b6710b01df434c80ad54fa5f0835207eb7b17b7a761463067bb  LiberationMono-Bold.ttf
79451f3c09fe25116098853b7a2ca6e2436220ccc11af022979adbcf195be130  LiberationMono-BoldItalic.ttf
605c01c711b44480a7508d349dfbf3264e81fa43d69e61cfa7d10b86e764c4d1  LiberationMono-Italic.ttf
f2b83c763e8afd21709333370bed4774337fae82267937e2b5aea7e2fbd922c1  LiberationMono-Regular.ttf
788abee4c806d660e8aee46689dd8540cd4bb98da03dcc9d171ce3efd99a9173  LiberationSans-Bold.ttf
698da70fc191cc5f33ad4d6d3fe830fe4624b898ea2e3169955928b7c491f1ee  LiberationSans-BoldItalic.ttf
e5bae5c4cde31f22142753855f4f8fb86da6ff39955ed3c0a11248b0d16948b0  LiberationSans-Italic.ttf
76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8  LiberationSans-Regular.ttf
d754ba427cfe0bca54ae052384baa8f842da5bd6550ad4da024ac441e7a7d5ce  LiberationSerif-Bold.ttf
f17db8af71e24d2066b587546021d4f0b296be389512b658dec3c09affeb11a7  LiberationSerif-BoldItalic.ttf
0e3dea9f8d613e006ccfa62201f33e265d19167bd0907725c3e145368b04fc2e  LiberationSerif-Italic.ttf
058ea80864aef09a23f45cbec2bb5400bc3dfbdea01c3f10538a21fcb497fb74  LiberationSerif-Regular.ttf
```

`src/report_runtime.ts` (`readRenderFonts`) checks each file against these hashes before the
renderer may use it: a changed or truncated font stops the build by name.
