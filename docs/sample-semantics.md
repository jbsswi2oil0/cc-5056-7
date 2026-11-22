# Depth-sample semantics

This is the maintained contract for the two sample kinds the compositor
integrates. Every numeric value below is produced by `npm run lab -- demo`; the
same numbers are re-derived by the test suite, so the document and the
implementation cannot silently drift.

## 1. Depth, color, and transparency contributions

All integration runs front-to-back (ascending depth) in **premultiplied linear
light**. The accumulated state is per-channel radiance `L` plus per-channel
transmittance `T` (initial `L = 0`, `T = 1`).

- **Point sample** `{ kind:'point', z, color }` — a hard surface at one depth.
  `color.a` is coverage in `[0,1]`. The over operator adds `T · color.rgb` to
  radiance and multiplies transmittance by `(1 - color.a)`.
- **Interval sample** `{ kind:'interval', zNear, zFar, extinction, emission }`
  — a homogeneous medium on the half-open span `[zNear, zFar)`. Over a span of
  length `len` the closed-form solution of `dL/dz = e − σL` is
  `T_span = exp(−σ·len)` and `L_span = (e/σ)(1 − exp(−σ·len))`, per channel.
  Overlapping media **sum** their per-unit coefficients; they are never
  averaged.

A point's `z` is a hard edge; an interval contributes two edges, a near edge and
a far edge.

## 2. The corrected ordering example (shared-depth rule)

The half-open convention is: a medium span **owns its near edge and excludes
its far edge**. When a hard surface sits exactly on a span's near edge the
surface is applied first, then the span attenuates it.

Given a medium `haze ∈ [2, 8)` and a hard surface at `z = 2`:

- **Correct order** — `hard-edge(2) → medium-near(2) → ... → medium-far(8)`.
  The surface is committed first; the haze then multiplies its contribution.
- **Wrong example (do not use)** — placing `medium-near(2)` before the hard
  edge would attenuate the surface by medium it is physically in front of. The
  compositor's stream sort explicitly ranks `hard-edge < medium-near <
  medium-far` at an equal depth, so this ordering cannot occur.

The rule is asserted by `orderingEntries` in `src/core/ordering.ts` and covered
by `tests/ordering.test.ts`. At every shared depth the rank order is fixed:

| rank | event |
| ---- | ----- |
| 0 | hard edge (point) |
| 1 | medium near edge |
| 2 | medium far edge |

## 3. Same-depth haze and a semi-transparent hard edge

A hard surface and a volume are different integration kinds, so even when their
depths agree within tolerance they are **never merged into one event**. The
reader has two valid behaviors, both implemented:

1. **Keep the ordered events** (`tiePolicy: 'stable-order'`, the default). The
   surface stays a distinct point event adjacent to the medium span; the range
   is reported with a `non-mergeable-tie` issue and counted in
   `report.nonMergeableTies`.
2. **Merge only eligible intervals** (`tiePolicy: 'exchangeable-merge'`).
   Coincident *point* samples may be reduced to one averaged event (marked
   approximate), but a point is still never coalesced with a medium span, and a
   span whose intervals do not both cover it fully is not coalesced either.

The merge eligibility is computed by `deriveMergeContract`. A range is
mergeable by coefficient sum only when every owner covers the whole
`[z0, z1)`; an interior surface cut or a partial-cover interval produces a
non-mergeable range instead.

## 4. Color conventions: premultiplied vs straight

The integrator only consumes premultiplied color. Surface samples may declare
`colorConvention: 'premultiplied'` (default) or `'straight'`.

- **Candidate A — convert at read** (default `colorPolicy:
  'convert-at-read'`): a straight sample is premultiplied exactly once in
  `sanitizeChain`, tagged, and counted as `report.straightConverted`.
- **Candidate B — handle at the integration node** (`colorPolicy: 'reject'`):
  the reader throws `STRAIGHT_COLOR_NOT_ISOLATED`, leaving conversion to a
  caller that implements it elsewhere.

**Mixed inputs are isolated.** A chain whose surface samples do not all share
one convention is rejected with `MIXED_COLOR_CONVENTION` before any integration.
Blending conventions would darken or double-darken color in a way an energy
check cannot detect, so the chain is refused rather than silently mis-rendered.
Interval samples carry no alpha convention and are ignored by this check.

The **double-layer transmittance probe** (`transmittanceProbe`) reports the
transmittance a sample keeps under its declared convention and under a mistaken
premultiplied reading, with the per-channel gap. A premultiplied sample has a
zero gap; a misread straight sample has a positive gap, which locates the bad
sample by its position in the ordered chain.

## 5. Middle-matte separation

Two chains can agree on accumulated radiance over an empty black backdrop while
keeping different transmittance; the empty backdrop multiplies that difference
by zero and hides it. Inserting a rear matte (an opaque backdrop integrated
last) multiplies by the surviving transmittance and separates them.

The code-generated proof (`middleMatteProof` + `rearMatteExperiment`) builds a
single translucent white surface versus a black edge followed by a brightened
white surface. Running `npm run lab -- demo` reports:

```
middle-matte separation:
  equivalentOnEmpty=true emptyDelta=0 separates=true matteDelta=0.5 transmittanceDelta=0.5
```

The two chains are bit-identical on empty black (`emptyDelta=0`) and separate
by `0.5` once the matte exists. The non-mergeable ranges exposed by this and the
overlap analysis are written back as the merge contract in section 3; ranges
that cannot be merged are kept as ordered events, never averaged away.

## 6. Mean depth is not an equivalent representation

A multi-layer chain cannot be replaced by one sample at its mean depth. Splitting
an interval at any interior depth, or shuffling non-tied samples, leaves the
integrated radiance and transmittance unchanged (split and shuffle invariance),
whereas collapsing the layers to a mean depth destroys the interior surface
interleaving and the per-channel transmittance. The lab tool always generates
and integrates the full layered chain; it never substitutes an average.

## 7. Executable maintenance check

`src/verify/semantics.ts` re-derives the contract from each raw chain and checks
it both structurally and by integration contribution:

- overlapping intervals are split and their coefficients summed (not averaged);
- coincident hard edges keep an ordered, non-merged range;
- every interior surface cut survives as an event boundary;
- the shared-depth ordering rank is honored;
- splitting any interval, and reversing sample order, leave the result
  unchanged within tolerance.

Run it over an asset without hand-editing any data:

```bash
npm run cli -- semantics --input out/scene-segmented.dsc --json
npm run validate:samples     # full clean-directory validation entry point
```

The check fails with a non-zero exit rather than substituting a default, so a
misread sample can never be masked by a fallback value.
