# CVsprings demo video

A Remotion project that renders the ~75s CVsprings product demo video. It
lives outside the `fitscore-backend` app's own dependency tree (own
`package.json`, own `node_modules`) and does not modify anything in the main
application — it only reads real CSS/markup as reference and copies three
brand asset files (`public/brandmark.svg`, `public/brandmark-white.svg`,
`public/logo.png`) into its own `public/` folder.

## Why it isn't a literal screen recording

`fitscore-backend`'s frontend (`public/app.html`, `public/bias-report.html`)
is server-rendered static HTML with vanilla JS — there's no component
framework, so there was nothing to `import` into React. Instead, every scene
is a hand-built React/JSX reproduction that reuses the **real CSS rules**
(copied verbatim into `src/styles/cvsprings.css`, sourced from
`public/app.html` and `public/bias-report.html`), the **real DOM structure**
(same class names, same layout), the **real brand assets**, and **real
product copy** (provenance footer text, methodology bullets, "N CVs staged",
etc. — all pulled from the actual source, not invented). This is what makes
frame-accurate animation possible at all: Remotion needs deterministic,
per-frame React state, which a screen recording or a live iframe can't give.

All candidate data (`src/data/candidates.ts`) is synthetic — fabricated names
and `@example.com` addresses. No real candidate, client, or company data
appears anywhere in this project.

## Setup

```bash
npm install
```

## Preview in Remotion Studio

```bash
npm start
```

Opens Remotion Studio. The composition list has the full video (`Demo`) plus
one composition per scene (`01-Upload`, `02-Criteria`, `03-Scoring`,
`04-Breakdown`, `05-AuditBias`, `06-ReportExport`) — each independently
scrubbable/previewable without loading the whole timeline.

## Render

```bash
npm run render
```

Renders the `Demo` composition to `out/demo.mp4` (1920x1080, 30fps, h264, no
audio track).

## Adjusting scene timings

Each scene's duration is a `DURATION` export (in frames, 30fps) at the top of
its file in `src/scenes/`:

| Scene | File | Nominal duration |
|---|---|---|
| Brand card (opener) | `src/scenes/00Brand.tsx` | 60f (2s) |
| Upload | `src/scenes/01Upload.tsx` | 180f (6s) |
| Criteria | `src/scenes/02Criteria.tsx` | 330f (11s) |
| Scoring | `src/scenes/03Scoring.tsx` | 420f (14s) |
| Breakdown (hero) | `src/scenes/04Breakdown.tsx` | 480f (16s) |
| Audit + bias | `src/scenes/05AuditBias.tsx` | 420f (14s) |
| Report export + logo | `src/scenes/06ReportExport.tsx` | 390f (13s) |

To change a scene's length, edit its `DURATION` constant (and any internal
frame constants that gate when something appears — e.g. `CHIP_START` in
`01Upload.tsx`, or the `start` values in the `WEIGHTS` array in
`02Criteria.tsx`) so the internal animation beats still land inside the new
duration. `src/Video.tsx` sums these automatically — nothing else needs to
change to shift the overall runtime.

Scenes cross-dissolve into each other (`@remotion/transitions`, `fade()`).
Each transition eats `TRANSITION_FRAMES` (15 frames / 0.5s, defined at the
top of `src/Video.tsx`) from the combined runtime of the two adjacent scenes,
which is why the rendered video comes out a couple of seconds under the
nominal 75s (2280 frames of scene content − 6 transitions × 15 frames =
2190 frames = 73s). Raise or lower `TRANSITION_FRAMES` to trade fade length
against total runtime.

Scene 6 has two internal beats (the report card, then the closing logo card)
on their own `Sequence`s — `REPORT_DURATION` and `LOGO_DURATION` at the top
of `06ReportExport.tsx`.

Captions are burned in via `src/components/Caption.tsx`, one per scene, each
held for the scene's full duration. The opening brand card and the closing
logo card carry none.

## Structure

```
src/
  Root.tsx            composition registry (Demo + one per scene)
  Video.tsx            sequences the 6 scenes with cross-dissolve transitions
  theme.ts              colors/fonts, copied from the real app CSS
  data/candidates.ts   synthetic candidate data
  styles/cvsprings.css real product CSS, copied verbatim (see file header)
  components/          shared pieces (AppShell/topbar, Caption, RingScore,
                        BarChart, Brandmark, LogoCard, PushIn) reused across scenes
  scenes/              one file per scene, each exporting a DURATION and a
                        component
public/                brandmark.svg, brandmark-white.svg, logo.png — copied
                        unmodified from fitscore-backend/public/
```
