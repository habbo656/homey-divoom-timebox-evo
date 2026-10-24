# Store assets and listing

_Part of [architecture](../architecture.md); added with #92 (icons, images, name and readme for the App Store)._

The store listing consists of two icons, two image sets, the app name and slogan, and a plain-text readme per locale.
The sources were supplied by the owner and are kept **outside the repository** in `.hwtest/issue-92/` (gitignored);
only the derived files below are committed.

## Files

| File | What | Source |
|---|---|---|
| `assets/icon.svg` | App icon: pixel fox, monochrome `#000000` on transparent, `viewBox="0 0 960 960"`, canonical path (#147) | `fox-display.png` (see below) |
| `drivers/timebox/assets/icon.svg` | Driver icon: the Timebox Evo, black stroke line art, `viewBox="0 0 960 960"` | hand-drawn (#142) |
| `drivers/timebox/assets/images/{small,large,xlarge}.png` | Driver images, 75, 500 and 1000 px square | `driver-image.png` |
| `assets/images/{small,large,xlarge}.png` | App images, 250x175, 500x350, 1000x700; unchanged by #92 | existing |
| `.homeycompose/app.json` (generated `app.json`) | Name `Divoom TimeBox Evo` (en, de; owner, 2026-10-18, was `TimeBox Evo` in 1.0.0), slogan as `description`, explicit `icon` `/assets/icon.svg` | owner |
| `locales/{en,de}.json` `app.name` | `Divoom TimeBox Evo` | owner |
| `README.txt`, `README.de.txt` | Store readme per locale | written for #92 |

`src/storeAssets.test.ts` checks the structure of all of these (viewBox, monochrome colours, icon path data, image sizes, white corners of the
driver images, name, slogan, readme rules).

## Driver icon

Redrawn by hand in #142 (UAT v1.0.0 round 1: the traced lines were 3-7 px, far thinner than other device icons). The first version
(#92) was a mirrored potrace trace of `driver-icon-source.svg` (kept outside the repository, no longer used). Homey guideline 1.6 asks for line weights of **40 / 20 / 10 px
on the 960 viewBox**, so the icon is stroke line art with exactly these widths, by construction:

```
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 960">
<g fill="none" stroke="#000000" stroke-linejoin="round" stroke-linecap="round">
<path stroke-width="40" d="…"/> <path stroke-width="20" d="…"/> <path stroke-width="10" d="…"/>
<path d="…" fill="#000000" stroke="none"/>   (the small side dot)
</g></svg>
```

No `transform`, `<path>` elements only (circles are arc paths; the test forbids `<rect`, `<image`, `<text`, `Gradient`, `style=` and `transform`, and allows only the stroke widths 40, 20 and 10).

| Weight | Elements |
|---|---|
| 40 px | Silhouette (top, side and front outline) and the inner cube edges (front top edge, front left edge, top/side edge) |
| 20 px | Display frame inset in the front face, ring of the side power button |
| 10 px | 8 x 8 pixel grid (7 + 7 lines, horizontals follow the slant of the front face), the five top-panel symbols (light, plus, power, minus, play) |
| fill | Side dot, a filled circle of 14 px diameter (no stroke) |

Composition: the Evo cube, front face to the right, side panel on the left (150 px wide), top panel visible; footprint about x 100-860,
y 65-885. Clear gaps between outline, frame and grid, and between each top-panel symbol and the outline edges, are at least 25 px (symbols are at most 32 px high, gap measured as 28 px); only the gaps inside the tiny symbols (for example between the power bar and the ring ends) are smaller. The grid
has 8 x 8 cells instead of the 16 x 16 of the device because 10 px lines of a 16 x 16 grid blur at 60-96 px.

How to measure (expected: outline 40 +/- 4, details 20 +/- 3, minor 10 +/- 2; only black and transparent pixels; transparent corners):

```
sips -s format png -z 960 960 drivers/timebox/assets/icon.svg --out icon960.png
sips -s format bmp icon960.png --out icon960.bmp     # 32 bit BGRA, top-down
```

then scan the BMP with the Python standard library (no PIL): read `off` (bytes 10-13), width/height (18-25), take the alpha byte
(index 3) of each pixel, count run lengths of pixels with alpha > 127 along a row (for example y = 450: runs 40, 38 (diagonal), 40, 20,
10 x 7, 20, 40) and a column (x = 560: 40, 40, 20, 10 x 7, 20, 40); check that all RGB bytes are 0 and the four corner pixels have alpha 0.
Also render at 96 and 60 px (`-z 96 96`, `-z 60 60`) and look at them: the cube, side panel, grid and top panel must stay recognisable.
Result of #142 on 2026-10-16: runs 40 / 20 / 10 (+/- 1), all RGB 0, corners transparent; renders in `.hwtest/issue-142/`.

## App icon (pixel fox)

A 16 x 16 grid of 60 px cells (viewBox 960), monochrome, the fox centred (rows 2 to 13 filled, 0 to 1 and 14 to 15 empty). `#` is a filled cell:

```
r2  ....#......#....
r3  ...#.#....#.#...
r4  ...#.##..##.#...
r5  ...#.######.#...
r6  ...##.####.##...
r7  ...##########...
r8  ...#.##..##.#...
r9  ...#.#.##.#.#...
r10 ..##.#.##.#.##..
r11 ..##..#..#..##..
r12 .####......####.
r13 ...##########...
```

It is a left-right symmetric reading of `fox-display.png`, a grey render of the 16x16 pixel fox on an Evo (a noisy photo-like render, the
cells of the display are about 23 px). The file is one `<path fill="#000000">` with the union outline of all filled cells (loops through
the cell edges that border empty cells: 7 loops, outer loops positive, holes negative, so the default nonzero rule gives the holes),
generated by a throwaway script that is not committed. No rects, background, stroke, gradient or `<image>`.

Canonical form (#147), layout like the driver icon:

```
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 960">
<path fill="#000000" d="M240 120 H300 V180 H240 Z M300 180 H360 V240 H420 …"/>
</svg>
```

**Explicit icon paths (owner, 2026-10-18, shipped in 1.1.0):** the manifest names the icons instead of relying on the default
location: `"icon": "/assets/icon.svg"` in `.homeycompose/app.json` and `"icon": "{{driverAssetsPath}}/icon.svg"` in
`drivers/timebox/driver.compose.json` (generated: `/drivers/timebox/assets/icon.svg`); pinned by `src/storeAssets.test.ts`.

**Defensive form (#147, kept after UAT v1.1.0):** the app icon path uses one command letter per segment, only absolute `M`, `H`, `V`, `L` and `Z`
with space separators (no commas, no implicit lineto pairs after `M`, no repeated `H`/`V` arguments), and no `fill-rule`, `clip-rule` or
`evenodd` (same fill as `nonzero` for this shape, removed only for renderer compatibility). Background: after the v1.0.0 release the icon
was missing in Devices > "+" (Add new device) and in the App Store, although it rendered correctly in CoreGraphics (`sips`) and in
headless Chrome (as `<img>` and as CSS mask). The redraw is an **unproven defensive change**: it brings the file into the same form
as the driver icon, which does show. Its compact path (only `M`/`Z` with implicit lineto pairs, `fill-rule="evenodd"`) was a structural
difference to the driver icon, but not necessarily the cause.

Counter-evidence (checked in the homey-lib corpus of 222 Athom device icons, which render in the Homey app): all 222 would fail test (a)
(SVGO-style implicit repeats), 169 have implicit lineto pairs right after `M`, and 202 use `fill-rule="evenodd"`. So a renderer that
rejects this form is unlikely. A cause outside the repository (H1: the store or test channel does not serve or caches the icon) is at
least as plausible, and the redraw would not fix it. UAT v1.1.0 (accepted 2026-10-18) showed the icon in Devices > "+", so the rule is
kept; the store page is checked by the owner after publishing 1.1.0. If the icon still does not show there, open a new issue and relax
or remove tests (a) and (b).

Ruled out (identical to working icons or checked offline): bundle content (`.homeybuild/assets/icon.svg` equals the source, `.homeyignore`
is fine), missing `width`/`height` or XML prolog (all 222 Athom device icons in homey-lib use only `viewBox="0 0 960 960"`), the explicit
`#000000` (the driver icon uses it), file size (under 1 KB), `evenodd` against `nonzero` (same fill, still removed), file mode,
dark-mode contrast.

The #147 redraw keeps the shape: `sips` renders at 960, 96 and 60 px are byte-identical to the previous file. The tests in
`src/storeAssets.test.ts` (`SVG icons (#92, #147)`): (a) in both icons every path segment has its own command letter with the exact
argument count (`M`/`L`/`T` 2, `H`/`V` 1, `Z` 0, `A` 7, `C` 6, `Q`/`S` 4); (b) the app icon has no `fill-rule`/`clip-rule`/`evenodd` and
only `M H V L Z`; (c) the cell centres (`60c+30`, `60r+30`) rasterised with the nonzero rule equal the grid above (`FOX_GRID` in the test;
keep both in sync); (d) every app icon `<path>` has `fill="#000000"`.

## Driver images

`driver-image.png` (600 x 600, Evo photo on white) has trailing bytes after the PNG `IEND` chunk, so it is always passed through `sips`,
which writes a clean file:

```
sips -s format png -z 75   75   .hwtest/issue-92/driver-image.png --out drivers/timebox/assets/images/small.png
sips -s format png -z 500  500  .hwtest/issue-92/driver-image.png --out drivers/timebox/assets/images/large.png
sips -s format png -z 1000 1000 .hwtest/issue-92/driver-image.png --out drivers/timebox/assets/images/xlarge.png
```

`xlarge` is an upscale (the source is 600 px). The photo background is white, so the corners are white (checked by the test).

## Name, slogan and readme

- App name `Divoom TimeBox Evo` (en and de; owner, 2026-10-18, shipped in 1.1.0; 1.0.0 shipped `TimeBox Evo`), slogan "The pixel heart of your smart home." / "Das Pixel-Herz deines Smart Homes." as `description`.
  Spelling (#133): user-facing texts (en + de) write "TimeBox", and "TimeBox Evo" where the product or app is named (driver
  name, pairing title, "is not a TimeBox Evo", "the TimeBox Evo app", readme), also in the log line `TimeBox Evo app initialized`
  in `src/app.ts`. The official app name (manifest, `app.name`) is "Divoom TimeBox Evo"; running text such as the store readmes
  and "the TimeBox Evo app" in error texts may use the short form. Ids, file names, code identifiers, code comments and developer-only messages keep their spelling. The
  guard test `TimeBox spelling (#133)` in `src/manifest.test.ts` fails on "Timebox" in the manifest texts, `app.json`,
  `locales/*.json` and the store readmes. Names of devices that were paired earlier are not changed.
- Store readme rules (Homey App Store): `README.txt` per locale (`README.de.txt` for German), plain text, at most two paragraphs, no URLs, no
  markdown, not just the slogan. Only shipped features are mentioned. The German text uses the informal "du" and real umlauts.
- The repository `README.md` (GitHub) is separate: it describes the app for users and keeps the developer status under "Development".

## Manifest links and brand colour

Added with #37, set in `.homeycompose/app.json` (generated into `app.json` by `homey app validate`):

- `source`: `https://github.com/habbo656/homey-divoom-timebox-evo`; `support` and `bugs.url`: the `/issues` page of the same repository.
  The links only resolve once the repository is public (owner item in [`release-checklist.md`](../release-checklist.md)).
- `brandColor`: `#FF6A00`, checked as `#RRGGBB`.
- `homeyCommunityTopicId` is left out on purpose: the community topic does not exist yet. The owner creates it after the first
  publish and adds the id then (a positive integer; the test accepts the field absent or valid).

## Owner decisions (2026-10, #92)

- The Evo faces right (the source faces left): the icon is mirrored; the mirrored symbols of the top panel are accepted.
- ~~The line thickness is kept (uniform scale, no re-stroking).~~ Superseded by #142 (UAT round 1, 2026-10-16): the icon is redrawn
  with 40 / 20 / 10 px strokes (see Driver icon).
- A pixel fox is the app icon instead of the Divoom logo (no Divoom branding; the app is not affiliated with Divoom).

## i18n completeness

Added with #37. The `store i18n` tests in `src/manifest.test.ts` require non-empty English and German texts for: every Flow card
title and hint; `titleFormatted` on every card with arguments or a droptoken (containing `[[name]]` for each argument and
`[[droptoken]]`); every argument title, dropdown label, and placeholder of text and number arguments; trigger token title and example;
every settings group label, setting label, setting hint and dropdown value label; every custom capability and enum value title; and
every `data-i18n` key and `t('<key>')` (as `pair.scan.<key>`) in `drivers/timebox/pair/*.html` in `locales/{en,de}.json`.
Homey Flow arguments have no `hint` field, so the card hint carries the explanation.

## App bundle

`.homeyignore` (#37) keeps `docs/`, `scripts/`, `CLAUDE.md`, `README.md`, `eslint.config.mjs`, `.github/`, `.claude/`, `.hwtest/` and `.venv/`
out of `.homeybuild`. The patterns are anchored to the repository root (`/docs/`, ...), so `drivers/x/docs/` would stay; the dot-directories
are also covered by the CLI's default `.*` rule. `src/storeAssets.test.ts` evaluates the file with the `ignore` package (gitignore semantics, a
dev dependency) against runtime and development paths. Check on 2026-10-16: `rm -rf .homeybuild && homey app build` leaves `app.js(.map)`, `app.json`, `assets/`, `dev/`,
`device/`, `drivers/`, `flow/`, `locales/`, `node_modules/` (`jpeg-js`, `omggif`), `package*.json`, `protocol/`, `README.txt`, `README.de.txt` and
`transport/`; none of the ignored paths and no `assets/source.png`. The size is 19 MB, of which `node_modules` is 2.9 MB.

## Owner decisions (2026-10, #37)

- `assets/source.png` is removed (it was unreferenced, and a JPEG with a `.png` extension). `assets/` holds only `icon.svg` and `images/`
  (checked by the test).
- Guideline 1.5 (prefer the company icon): the pixel-fox app icon is kept, because Divoom has no usable company icon.
- Guideline 1.6 (angle from the right side): the driver icon angle is kept; it already shows the right side.

## Source quirks

- `driver-image.png` carries bytes after `IEND`: re-encode it with `sips` before use.
- `fox-display.png` is a JPEG with a `.png` extension (592 x 592); `sips -s format png` converts it for viewing.
