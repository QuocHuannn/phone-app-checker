# Brand guidelines

A short guide to using the phone-app-checker logo. Files and licence: [assets/README.md](assets/README.md).

## The logo

**Idea:** five dots, one for each app the tool can ask, line up into a check mark. The last dot is amber: the answer that came back. It stays calm and tool-like: no phone handset, no speech bubble, no magnifying glass, no eyes, no padlock, and nothing that looks like a platform's own logo.

- **Symbol:** `logo-mark.svg`, a rounded tile with the five-dot check.
- **Lockup:** `logo-horizontal.svg` / `logo-horizontal-dark.svg`. The wordmark is **Phone App Checker** in JetBrains Mono SemiBold (SIL OFL 1.1), converted to outlines.
- **One colour:** `logo-mark-mono-black.svg` and `logo-mark-mono-white.svg` (dots are holes in the tile).
- **Small cut:** `favicon.svg` and the favicon PNGs are redrawn so the dots land on whole pixels at 16 and 32 px.

## Colour

| Name | HEX | RGB | Role |
| --- | --- | --- | --- |
| Petrol | `#17697D` | 23, 105, 125 | Tile. The brand colour. |
| Mist | `#F2F7F6` | 242, 247, 246 | Four dots; wordmark on dark backgrounds; light background. |
| Amber | `#F6B21B` | 246, 178, 27 | The fifth dot only. Never text, never a line. |
| Ink | `#0B2F3A` | 11, 47, 58 | Wordmark and text on light backgrounds. |
| Slate | `#3D6470` | 61, 100, 112 | Secondary text on Mist (social preview). |

Only RGB/HEX is defined: the project lives on screens. There is no CMYK or Pantone value; match to Petrol by eye if you ever print it.

### Contrast (WCAG relative luminance, computed with the logo-design skill's `contrast_ratio`)

| Pair | Ratio | Meaning |
| --- | --- | --- |
| Mist dots on Petrol tile | 5.79 : 1 | Above 4.5 : 1 |
| Amber dot on Petrol tile | 3.37 : 1 | Above the 3 : 1 minimum for graphics |
| Petrol tile on white | 6.26 : 1 | Light GitHub theme, light pages |
| Petrol tile on `#0D1117` (GitHub dark) | 3.02 : 1 | Just above 3 : 1 |
| Petrol tile on `#22272E` (GitHub dark dimmed) | 2.40 : 1 | Below 3 : 1; the dots inside still read at 5.79 : 1 and 3.37 : 1 |
| Ink wordmark on white | 14.17 : 1 | |
| Mist wordmark on `#0D1117` | 17.49 : 1 | |
| Ink on Mist | 13.10 : 1 | |
| Slate on Mist | 5.96 : 1 | |
| Amber on `#0D1117` | 10.19 : 1 | |
| Amber on white | 1.86 : 1 | **Fails.** Use amber only for the dot inside the tile. |

## Clear space

Keep **a quarter of the tile height** free on every side of the symbol or the lockup. This is about 1.5 dot diameters. No text, borders or other logos inside it.

## Minimum size

| Version | Minimum on screen |
| --- | --- |
| Symbol | 16 px (below 24 px use `favicon.svg` / `favicon-16.png`) |
| Horizontal lockup | 144 px wide (the tile is then about 32 px high) |

Print minimums were not tested.

## Approved backgrounds

- Full-colour symbol and `logo-horizontal.svg` on white or Mist.
- Full-colour symbol and `logo-horizontal-dark.svg` on `#0D1117` and similar dark surfaces.
- `logo-mark-mono-white.svg` on dark photos or Petrol; `logo-mark-mono-black.svg` on light, busy or one-colour print.

## Do

- Use the SVG files. Scale them proportionally.
- Use `logo-horizontal-dark.svg` on dark backgrounds instead of recolouring.
- Keep the amber dot top right, at the end of the long arm of the check.

## Don't

- Stretch, rotate, mirror or recolour the tile or the dots outside this palette.
- Add shadows, outlines, gradients or glows.
- Retype the wordmark in another font. Use the supplied outlines.
- Place the full-colour mark on a busy photo; use the white or black one-colour mark.
- Use another app's logo or colours next to it in a way that suggests a partnership. The project is independent (see the README).
- Use Petrol on Ink or on a similar dark teal: the tile disappears (2.26 : 1).

## Test results

Checked with the logo-design skill before release: size ladder and 16/32 px pixel tests, greyscale, one-colour black and white, squint blur, mirror and 180° rotation, light/dark/brand/photo/pattern backgrounds, and a shelf test against ten developer-tool logos. The `svg_audit.py` scores were 92 (mark and favicon), 83 (horizontal lockups, expected warnings only: the diagonals in the letter k are 0.3–3° from a "clean" angle by design) and 99–100 (one-colour marks). The audit's "low contrast on white" warning for the dots is a false positive: the dots sit on the Petrol tile (ratios above).
