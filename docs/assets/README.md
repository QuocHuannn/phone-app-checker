# Brand assets

Logo files for phone-app-checker. Design rules, colours and contrast numbers are in [../brand.md](../brand.md).

The mark is a rounded tile with five dots that form a check mark. The last dot, the answer, is amber.

## Files

| File | Use |
| --- | --- |
| `logo-mark.svg` | Master symbol (256 × 256). Avatars, app icons, anywhere the name is already shown. |
| `logo-horizontal.svg` | Symbol and wordmark for **light** backgrounds. |
| `logo-horizontal-dark.svg` | Same lockup for **dark** backgrounds (light wordmark). |
| `logo-mark-mono-black.svg` | One-colour mark, the dots are real holes. For one-colour print and similar. |
| `logo-mark-mono-white.svg` | One-colour mark reversed, for dark or photographic backgrounds. |
| `favicon.svg` | Small-size cut for browser tabs: dots snapped to the 32 px grid. |
| `favicon.ico` | 16, 32 and 48 px. |
| `favicon-16.png`, `favicon-32.png` | The same cut as PNG. The 16 px file is drawn on whole pixels. |
| `apple-touch-icon.png` | 180 × 180, full-bleed square (iOS rounds the corners itself). |
| `icon-512.png` | 512 × 512, rounded tile on a transparent background. |
| `social-preview.png` | 1280 × 640 GitHub social preview. Content sits inside the safe area. |

All SVGs are plain shapes: no text, no filters, no fonts. The wordmark is converted to outlines, so GitHub, browsers and `rsvg`/Inkscape render it the same way everywhere.

## Use in a README

Switch between the light and dark lockup with the user's GitHub theme:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-horizontal-dark.svg">
  <img alt="Phone App Checker" src="docs/assets/logo-horizontal.svg" width="420">
</picture>
```

## GitHub social preview

GitHub's REST API cannot upload it. In the repository open **Settings → General → Social preview → Edit → Upload an image** and choose `docs/assets/social-preview.png`.

## Licence

- The logo files are licensed like the rest of the repository, under **GPL-3.0-or-later** (see [LICENSE](../../LICENSE)). You may copy, modify and redistribute them under those terms.
- **No trademark is claimed.** The logo and the name are not registered as trademarks, and no trademark clearance search was done. Using the logo does not imply endorsement by the author.
- The mark is original geometry (circles on a rounded square). It uses no platform logo, symbol or colour.
- Wordmark outlines come from **JetBrains Mono SemiBold** (Copyright 2020 The JetBrains Mono Project Authors, SIL Open Font License 1.1, <https://github.com/JetBrains/JetBrainsMono>). The licence allows embedding the glyph shapes in artwork. The font software itself is not distributed here.
- The project is independent and is not affiliated with, endorsed by or sponsored by Telegram, WhatsApp/Meta, Zalo/VNG, Viber/Rakuten or LINE/LY Corporation (see the README).

## How they were made

Designed with the open-source [logo-design skill](https://github.com/kaankiziltug/logo-design-skill) (MIT) for process and testing (size ladder, one-colour, reversed, pixel and shelf tests). None of that skill's library artwork is used or copied here.
