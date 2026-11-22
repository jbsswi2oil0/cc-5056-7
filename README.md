# Depth Composite

A depth-sample compositing canvas. Each pixel is an unordered set of depth
samples — point samples (premultiplied color + coverage at one depth) and
interval samples (a homogeneous medium with per-unit extinction and emission).
The compositor sorts every depth event, splits overlapping media into disjoint
spans, splits each medium at interior surfaces, integrates every span in closed
form, and applies surface samples between medium spans. The result is an
order-independent, physically meaningful image with real volumetric occlusion.

The generated demo scene contains:

- a foreground blue plate at `z = 0.8`,
- two smoke segments, `A ∈ [2.5, 7.5]` (warm) and `B ∈ [3.5, 9.0]` (cool),
  which overlap in depth and store uniform extinction/emission coefficients,
- a thin red slice sample at `z = 5` that passes through both smoke segments.

Because the slice is *inside* the smoke segments, each segment is split at
`z = 5` into a near and a far span. The slice is attenuated only by the near
spans, and the far spans are attenuated by the slice. That interleaving is what
a nearest-depth-per-layer or a flat 2-D stack cannot reproduce.

## Graphical entry point

The primary interface is the browser canvas:

```bash
npm install
npm run dev          # opens http://127.0.0.1:5173
```

In the canvas you can:

- **Switch depth layers** on and off (plate, smoke A, smoke B, red slice) and
  see the composited result and occlusion update.
- **Switch views**: Color, Transmittance, Occlusion, and Exactness. Every view
  is derived from the same computed radiance/transmittance arrays.
- **Click any pixel** to expand its ordered sample chain. The inspector lists
  every depth event with its depth, contribution, transmittance before/after,
  per-source coefficients, and `split` / `overlap split` / `merged` / `approx`
  markers.
- **Load assets**: “Segmented asset” and “Legacy asset” generate the two
  materials from the brief; “Open .dsc…” reads a saved asset from disk.
- **Save assets**: “Save .dsc” writes the real depth-sample container;
  “Export PNG” writes the current view using the same compositor.
- **Supply segmented samples**: when a legacy asset is loaded, “Supply
  segmented…” replaces its whole-segment samples with matching segmented
  samples from another `.dsc`, restoring exact composition and export.
- Choose the **coincident-sample policy** (stable order or exchangeable merge)
  and optionally **compare against a ray-marched reference** rendered by an
  independent algorithm.

The Result panel reports approximate-pixel count, exactness, the energy check,
and (when enabled) the reference comparison. Anomalies — non-finite inputs,
overlaps, coincident samples, legacy limitations — are surfaced in the UI and
in the pixel inspector.

## Sample semantics

- **Point sample** `{ kind:'point', z, color }`: `color` is premultiplied
  linear light; `color.a` is coverage in `[0,1]`. Applied with the over
  operator at its depth.
- **Interval sample** `{ kind:'interval', zNear, zFar, extinction, emission }`:
  a homogeneous medium. `extinction` is per-unit optical depth `σ_t`;
  `emission` is per-unit emitted radiance. Over `[zNear, zFar)` the exact
  solution of `dL/dz = e − σL` is used per channel:
  `T = exp(−σ·len)`, `L_span = (e/σ)(1 − exp(−σ·len))`.
- **Legacy segment** `{ kind:'legacy-segment', zNear, zFar, accumulated }`:
  an old asset that stores only the segment's total accumulated premultiplied
  color. It carries no interior distribution and no per-unit coefficients.

All three use premultiplied linear RGB internally. Display and PNG export
composite accumulated radiance over a backdrop through per-channel
transmittance, which a single scalar alpha cannot express.

## Exactness and the legacy asset

When a legacy segment has no interior event (nothing intersects its open span),
it is expressible exactly as one surface color and composes exactly. When a
surface or another medium reaches inside its span, the single accumulated color
does not contain enough information to say how much arrived before vs. after
that event. In that case:

- exact composition **throws** `LEGACY_NEEDS_SEGMENTATION`;
- an explicitly requested, clearly marked **approximate preview** is available
  (uniform-emission model, `approximatePixels > 0`, Exactness view magenta),
  and approximate export is labeled as such;
- **supplying segmented samples** for the affected layers replaces the legacy
  data and restores exact composition.

The two demo assets therefore cannot be conflated: the segmented asset exports
exactly, and the legacy asset is refused exact export until segmented samples
are supplied.

## Command-line helper (auxiliary)

The CLI mirrors the same compositor and container; it is a scripting aid, not
the primary interface.

```bash
npm run cli -- gen-scene --kind segmented --output out/scene-segmented.dsc
npm run cli -- gen-scene --kind legacy    --output out/scene-legacy.dsc
npm run cli -- compose --input out/scene-segmented.dsc --output out/color.png
npm run cli -- compose --input out/scene-legacy.dsc --output out/legacy.png
npm run cli -- compose --input out/scene-legacy.dsc --output out/approx.png --allow-approximate-legacy
npm run cli -- compose --view transmittance|coverage|exactness ...
npm run cli -- verify --input out/scene-segmented.dsc --json
npm run cli -- inspect --input out/scene-segmented.dsc
```

`verify` compares the composited image against the independent ray-marched
reference. Exit codes: `0` success, `1` usage/IO, `2` compositing error (e.g.
legacy needs segmentation), `3` verification failed.

## File format (DSC1)

`src/io/dsc.ts` defines a compact, versioned, deterministic container with
optional gzip. It stores per-pixel sample chains (point, interval, and legacy
kinds), layer metadata, and provenance. All-original sample kinds survive a
round trip, so the two assets remain distinguishable on disk. See the module
header for the byte layout.

## Verification

- `npm test` — unit and integration tests (Vitest).
- `npm run e2e` — browser tests (Playwright) covering reading, composing,
  layer switching, pixel inspection, legacy refusal/preview, supplementation,
  saving, and re-reading.
- `npm run typecheck`, `npm run build`.

The reference renderer (`src/scene/reference.ts`) is an intentionally different
algorithm: front-to-back numerical ray marching with fixed substeps. The
closed-form compositor matches it to ~1e-4 on the generated scene. Tests also
assert: split invariance of intervals, order independence under shuffling,
overlap spans summing (not averaging) coefficients, foreground-plate occlusion,
legacy rejection/approximation, coincidence policies, empty pixels, and
non-finite handling.

Tests that need Chromium on a machine without system libraries: run
`scripts/setup-browser-deps.sh` once; it extracts the required libraries into
`.cache/chromium-deps`, which the Playwright config and browser harness pick up
automatically.
