import type {
  ChainEvent,
  CompositeOptions,
  CompositeResult,
  IntervalSample,
  LegacySegmentSample,
  PointSample,
  Rgb,
  Rgba,
  SampleChain,
  SampleIssue,
  SampleSource,
  TiePolicy,
} from './types';
import { CLEAR_TRANSMITTANCE, SampleError } from './types';
import {
  DEFAULT_TOLERANCE,
  MAX_TIE_GROUP,
  analyzeLegacy,
  compareMedia,
  sanitizeChain,
} from './sample';

interface Span {
  z0: number;
  z1: number;
  owners: IntervalSample[];
}

interface PointGroup {
  z: number;
  points: PointSample[];
}

interface AccState {
  radiance: Rgb;
  transmittance: Rgb;
}

function zeroRgb(): Rgb {
  return { r: 0, g: 0, b: 0 };
}

function copyRgb(c: Rgb): Rgb {
  return { r: c.r, g: c.g, b: c.b };
}

function copyRgba(c: Rgba): Rgba {
  return { r: c.r, g: c.g, b: c.b, a: c.a };
}

function addInto(target: Rgb, a: Rgb): void {
  target.r += a.r;
  target.g += a.g;
  target.b += a.b;
}

function mulInto(target: Rgb, a: Rgb): void {
  target.r *= a.r;
  target.g *= a.g;
  target.b *= a.b;
}

function coverageFromTransmittance(t: Rgb): number {
  const luma = 0.2126 * t.r + 0.7152 * t.g + 0.0722 * t.b;
  return Math.min(1, Math.max(0, 1 - luma));
}

function sourcesOf(owners: IntervalSample[]): SampleSource[] {
  return owners.map((m) => ({
    id: m.id,
    layer: m.layer,
    extinction: copyRgb(m.extinction),
    emission: copyRgb(m.emission),
  }));
}

function sumOwners(owners: IntervalSample[]): { extinction: Rgb; emission: Rgb } {
  const extinction = zeroRgb();
  const emission = zeroRgb();
  for (const m of owners) {
    addInto(extinction, m.extinction);
    addInto(emission, m.emission);
  }
  return { extinction, emission };
}

/**
 * Break the union of media extents into spans with a constant owner set. Every
 * media boundary AND every point depth becomes an edge, so a surface inside a
 * medium splits that medium into independent spans.
 */
function buildSpans(media: IntervalSample[], pointDepths: number[], tol: number): Span[] {
  const edges: number[] = [];
  for (const m of media) edges.push(m.zNear, m.zFar);
  for (const z of pointDepths) edges.push(z);
  edges.sort((a, b) => a - b);
  const unique: number[] = [];
  for (const e of edges) {
    if (unique.length === 0 || e - unique[unique.length - 1] > tol) unique.push(e);
  }
  const spans: Span[] = [];
  for (let i = 0; i + 1 < unique.length; i++) {
    const z0 = unique[i];
    const z1 = unique[i + 1];
    if (!(z1 > z0 + tol)) continue;
    const mid = z0 + (z1 - z0) * 0.5;
    const owners: IntervalSample[] = [];
    for (const m of media) {
      if (mid >= m.zNear - tol && mid < m.zFar - tol) owners.push(m);
    }
    if (owners.length === 0) continue;
    owners.sort(compareMedia);
    spans.push({ z0, z1, owners });
  }
  return spans;
}

function overlapSpanOf(spans: Span[]): number {
  let total = 0;
  for (const s of spans) if (s.owners.length > 1) total += s.z1 - s.z0;
  return total;
}

/**
 * Ensure every point depth that lies strictly inside a span (beyond tolerance)
 * becomes a span boundary. This is what makes a surface split the medium around
 * it exact, independent of tolerance-based edge dedup.
 */
function splitSpansAtPoints(spans: Span[], pointDepths: number[], tol: number): Span[] {
  const out: Span[] = [];
  for (const span of spans) {
    const interior: number[] = [];
    for (const z of pointDepths) {
      if (z > span.z0 + tol && z < span.z1 - tol) interior.push(z);
    }
    if (interior.length === 0) {
      out.push(span);
      continue;
    }
    const cuts = [...new Set(interior)].sort((a, b) => a - b);
    let start = span.z0;
    for (const z of cuts) {
      if (z - start > tol) out.push({ z0: start, z1: z, owners: span.owners });
      start = z;
    }
    if (span.z1 - start > tol) out.push({ z0: start, z1: span.z1, owners: span.owners });
  }
  return out;
}

/**
 * Integrate a homogeneous medium over [z0, z1) with summed coefficients.
 * Closed-form solution of dL/dz = e - sigma*L with zero incoming radiance:
 *   transmittance = exp(-sigma*len)
 *   local emission toward the near side = (e/sigma) * (1 - exp(-sigma*len))
 * Both are per-channel. The local emission is the radiance the segment adds
 * toward the camera before attenuation by whatever is in front of it.
 */
function integrateMedium(
  extinction: Rgb,
  emission: Rgb,
  len: number,
): { transmittance: Rgb; emitted: Rgb; extinctance: Rgb } {
  const tau: Rgb = {
    r: extinction.r * len,
    g: extinction.g * len,
    b: extinction.b * len,
  };
  const transmittance: Rgb = {
    r: Math.exp(-tau.r),
    g: Math.exp(-tau.g),
    b: Math.exp(-tau.b),
  };
  const local = (sigma: number, e: number, t: number) => {
    const tauC = sigma * len;
    if (tauC > 1e-12) return (e * len * (1 - t)) / tauC;
    return e * len;
  };
  const emitted: Rgb = {
    r: local(extinction.r, emission.r, transmittance.r),
    g: local(extinction.g, emission.g, transmittance.g),
    b: local(extinction.b, emission.b, transmittance.b),
  };
  return { transmittance, emitted, extinctance: tau };
}

/** Apply a premultiplied point/surface color over the accumulated radiance. */
function applySurface(state: AccState, color: Rgba): { radianceDelta: Rgb } {
  const delta: Rgb = {
    r: state.transmittance.r * color.r,
    g: state.transmittance.g * color.g,
    b: state.transmittance.b * color.b,
  };
  addInto(state.radiance, delta);
  const inv = 1 - color.a;
  mulInto(state.transmittance, { r: inv, g: inv, b: inv });
  return { radianceDelta: delta };
}

/**
 * Apply a coincident point group.
 * - stable-order: composite in input order (JS sort is stable), a deterministic
 *   but non-commutative over-sequence.
 * - exchangeable-merge: average the premultiplied colors, which is invariant to
 *   input order; the UI marks this result as approximate.
 */
function mergePointGroup(
  group: PointSample[],
  policy: TiePolicy,
  ordinalOf: (p: PointSample) => number,
): { color: Rgba; merged: boolean; approximate: boolean } {
  if (group.length === 1) {
    return { color: copyRgba(group[0].color), merged: false, approximate: false };
  }
  if (policy === 'stable-order') {
    const ordered = [...group].sort((a, b) => ordinalOf(a) - ordinalOf(b));
    let color = copyRgba(ordered[0].color);
    for (let i = 1; i < ordered.length; i++) {
      const c = ordered[i].color;
      const inv = 1 - color.a;
      color = {
        r: color.r + inv * c.r,
        g: color.g + inv * c.g,
        b: color.b + inv * c.b,
        a: color.a + inv * c.a,
      };
    }
    return { color, merged: true, approximate: false };
  }
  // Canonical ordering makes the average bit-identical regardless of input
  // order: floating-point summation order changes the result.
  const canonical = [...group].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sum = { r: 0, g: 0, b: 0, a: 0 };
  for (const p of canonical) {
    sum.r += p.color.r;
    sum.g += p.color.g;
    sum.b += p.color.b;
    sum.a += p.color.a;
  }
  const inv = 1 / canonical.length;
  return {
    color: { r: sum.r * inv, g: sum.g * inv, b: sum.b * inv, a: sum.a * inv },
    merged: true,
    approximate: true,
  };
}

/**
 * Approximate a legacy segment at an interior event. A single total color
 * cannot describe how much arrived before vs. after the event, so this model
 * treats the color as uniform emission with no extinction. It is explicitly
 * marked approximate and must never be used for exact export.
 */
export function approximateLegacySegment(segment: LegacySegmentSample): IntervalSample {
  const len = segment.zFar - segment.zNear;
  const inv = len > 0 ? 1 / len : 0;
  return {
    kind: 'interval',
    id: `${segment.id}~approx`,
    layer: segment.layer,
    zNear: segment.zNear,
    zFar: segment.zFar,
    extinction: zeroRgb(),
    emission: {
      r: segment.accumulated.r * inv,
      g: segment.accumulated.g * inv,
      b: segment.accumulated.b * inv,
    },
    provenance: 'supplemented',
  };
}

export interface IntegrationOutput {
  result: CompositeResult;
  events: ChainEvent[];
}

export function integrateChainDetailed(
  chain: SampleChain,
  options: CompositeOptions = {},
): IntegrationOutput {
  const tol = options.tolerance ?? DEFAULT_TOLERANCE;
  const tiePolicy: TiePolicy = options.tiePolicy ?? 'stable-order';
  const colorPolicy = options.colorPolicy ?? 'convert-at-read';
  const sanitized = sanitizeChain(chain.samples ?? [], tol, colorPolicy);
  const issues: SampleIssue[] = [...sanitized.issues];

  const media = [...sanitized.media];
  // Keep input order; tie policy defines how coincident points are resolved.
  const points = [...sanitized.points];
  const legacy = [...sanitized.legacy];

  const analysis = analyzeLegacy(legacy, media, points, tol);
  const approximateSamples: string[] = [];
  const pointOrdinal = new Map<PointSample, number>();
  let approximate = false;
  let legacySegments = 0;

  for (const segment of legacy) {
    legacySegments++;
    const needs = analysis.needsSegmentation.get(segment.id) ?? false;
    if (needs) {
      if (!options.allowApproximateLegacy) {
        issues.push({
          code: 'legacy-needs-segmentation',
          message: `legacy segment "${segment.id}" spans an interior depth event; its accumulated color cannot be split exactly`,
          sampleIds: [segment.id],
        });
        throw new SampleError(
          `legacy segment "${segment.id}" spans an interior depth event; its accumulated color cannot be split exactly`,
          'LEGACY_NEEDS_SEGMENTATION',
          { sampleIds: [segment.id], issues },
        );
      }
      media.push(approximateLegacySegment(segment));
      approximateSamples.push(segment.id);
      approximate = true;
      issues.push({
        code: 'legacy-approximate',
        message: `legacy segment "${segment.id}" approximated as uniform emission (marked preview)`,
        sampleIds: [segment.id],
      });
    } else {
      const derived: PointSample = {
        kind: 'point',
        id: segment.id,
        layer: segment.layer,
        z: (segment.zNear + segment.zFar) * 0.5,
        color: copyRgba(segment.accumulated),
        provenance: 'legacy',
      };
      points.push(derived);
      pointOrdinal.set(derived, sanitized.ordinal.get(segment) ?? Number.MAX_SAFE_INTEGER);
      issues.push({
        code: 'legacy-exact',
        message: `legacy segment "${segment.id}" has no interior event; used whole as one surface color`,
        sampleIds: [segment.id],
      });
    }
  }

  // Stable-order ties resolve by original input position; exchangeable-merge
  // averages, so its order is irrelevant. Sort by depth, then input index.
  const ordinalOf = (p: PointSample) =>
    pointOrdinal.get(p) ?? sanitized.ordinal.get(p) ?? Number.MAX_SAFE_INTEGER;
  points.sort((a, b) => a.z - b.z || ordinalOf(a) - ordinalOf(b));

  const pointDepths = points.map((p) => p.z);
  const spans = buildSpans(media, pointDepths, tol);
  // Guarantee every point depth strictly inside a span becomes its own
  // boundary, even if tolerance-based edge dedup merged it with a nearby media
  // edge. This keeps the point's interleaving exact rather than letting it
  // fall on the wrong side of a whole span.
  const splitSpans = splitSpansAtPoints(spans, pointDepths, tol);
  const overlapSpan = overlapSpanOf(splitSpans);
  if (overlapSpan > tol) {
    const ids = splitSpans
      .filter((s) => s.owners.length > 1)
      .flatMap((s) => s.owners.map((o) => o.id));
    issues.push({
      code: 'overlap',
      message: `media overlap over ${overlapSpan.toFixed(6)} units; overlapping spans were split and coefficients summed, not averaged`,
      sampleIds: [...new Set(ids)],
    });
  }

  // Group coincident points (within tolerance) preserving stable order.
  const groups: PointGroup[] = [];
  for (const p of points) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(p.z - last.z) <= tol) last.points.push(p);
    else groups.push({ z: p.z, points: [p] });
  }
  // A hard edge that coincides with a medium span can never be merged into it:
  // a surface and a volume are different integration kinds. The reader keeps
  // the ordered events; only point groups that are genuinely exchangeable (and
  // only under the merge policy) may be reduced to one event.
  let nonMergeableTies = 0;
  for (const group of groups) {
    if (group.points.length > 1) {
      issues.push({
        code: 'tie',
        message: `${group.points.length} point samples coincide near z=${group.z.toFixed(6)}; using ${tiePolicy}`,
        sampleIds: group.points.map((p) => p.id),
        count: group.points.length,
      });
      if (tiePolicy === 'exchangeable-merge') {
        issues.push({
          code: 'tie',
          message: `coincident group near z=${group.z.toFixed(6)} averaged by the exchangeable-merge policy (approximate)`,
          sampleIds: group.points.map((p) => p.id),
          count: group.points.length,
        });
      } else {
        // Stable order keeps the ordered events; the range is not merged.
        nonMergeableTies++;
        issues.push({
          code: 'non-mergeable-tie',
          message: `coincident hard edges near z=${group.z.toFixed(6)} kept as an ordered sequence, not merged`,
          sampleIds: group.points.map((p) => p.id),
          count: group.points.length,
        });
      }
    }
    if (group.points.length > MAX_TIE_GROUP) {
      issues.push({
        code: 'large-tie-group',
        message: `${group.points.length} point samples coincide near z=${group.z.toFixed(6)}; ordering is defined but the group is unusually large`,
        sampleIds: group.points.map((p) => p.id),
        count: group.points.length,
      });
    }
  }
  // A hard edge sitting on a medium near/far boundary is a cross-kind boundary
  // that must stay split even though the depths match within tolerance.
  for (const span of splitSpans) {
    const onEdge = points.filter(
      (p) => Math.abs(p.z - span.z0) <= tol || Math.abs(p.z - span.z1) <= tol,
    );
    if (onEdge.length > 0 && span.owners.length > 0) {
      nonMergeableTies++;
      issues.push({
        code: 'non-mergeable-tie',
        message: `hard edge at z=${span.z0.toFixed(6)} coincides with medium span [${span.z0.toFixed(6)}, ${span.z1.toFixed(6)}); kept ordered, not merged`,
        sampleIds: [...new Set([...onEdge.map((p) => p.id), ...span.owners.map((m) => m.id)])],
      });
    }
  }

  type StreamEvent =
    | { kind: 'span'; z: number; span: Span }
    | { kind: 'points'; z: number; group: PointGroup };
  const stream: StreamEvent[] = [
    ...splitSpans.map((span) => ({ kind: 'span' as const, z: span.z0, span })),
    ...groups.map((group) => ({ kind: 'points' as const, z: group.z, group })),
  ];
  stream.sort((a, b) => {
    if (a.z !== b.z) return a.z - b.z;
    // A surface at the near edge of a span is applied before that span. Spans
    // therefore own their near edge and exclude their far edge.
    if (a.kind !== b.kind) return a.kind === 'points' ? -1 : 1;
    return 0;
  });

  const state: AccState = {
    radiance: zeroRgb(),
    transmittance: copyRgb(CLEAR_TRANSMITTANCE),
  };
  const events: ChainEvent[] = [];
  const collect = options.collectEvents ?? false;
  let pieces = 0;
  let pointsApplied = 0;
  let covered = 0;

  for (const ev of stream) {
    const before = {
      radiance: copyRgb(state.radiance),
      transmittance: copyRgb(state.transmittance),
    };
    if (ev.kind === 'span') {
      const { extinction, emission } = sumOwners(ev.span.owners);
      const integrated = integrateMedium(extinction, emission, ev.span.z1 - ev.span.z0);
      const delta: Rgb = {
        r: state.transmittance.r * integrated.emitted.r,
        g: state.transmittance.g * integrated.emitted.g,
        b: state.transmittance.b * integrated.emitted.b,
      };
      addInto(state.radiance, delta);
      mulInto(state.transmittance, integrated.transmittance);
      covered += ev.span.z1 - ev.span.z0;
      pieces++;
      if (collect) {
        events.push({
          kind: 'medium',
          z0: ev.span.z0,
          z1: ev.span.z1,
          sourceIds: ev.span.owners.map((o) => o.id),
          layers: [...new Set(ev.span.owners.map((o) => o.layer ?? 'unassigned'))].sort(),
          merged: ev.span.owners.length > 1,
          overlap: ev.span.owners.length > 1,
          approximate: ev.span.owners.some((o) => o.provenance === 'supplemented'),
          emitted: { ...integrated.emitted, a: coverageFromTransmittance(integrated.transmittance) },
          extinctance: integrated.extinctance,
          extinction: copyRgb(extinction),
          emission: copyRgb(emission),
          sources: sourcesOf(ev.span.owners),
          transmittanceBefore: before.transmittance,
          radianceBefore: before.radiance,
          transmittanceAfter: copyRgb(state.transmittance),
          radianceAfter: copyRgb(state.radiance),
        });
      }
    } else {
      const merged = mergePointGroup(ev.group.points, tiePolicy, ordinalOf);
      const hasLegacy = ev.group.points.every((p) => p.provenance === 'legacy');
      const { radianceDelta } = applySurface(state, merged.color);
      pointsApplied += ev.group.points.length;
      if (merged.approximate) approximate = true;
      if (collect) {
        events.push({
          kind: hasLegacy ? 'legacy' : 'point',
          z0: ev.z,
          z1: ev.z,
          sourceIds: ev.group.points.map((p) => p.id),
          layers: [...new Set(ev.group.points.map((p) => p.layer ?? 'unassigned'))].sort(),
          merged: merged.merged,
          overlap: false,
          approximate: merged.approximate,
          emitted: { ...radianceDelta, a: merged.color.a },
          extinctance: { r: 0, g: 0, b: 0 },
          color: copyRgba(merged.color),
          transmittanceBefore: before.transmittance,
          radianceBefore: before.radiance,
          transmittanceAfter: copyRgb(state.transmittance),
          radianceAfter: copyRgb(state.radiance),
        });
      }
    }
  }

  const report = {
    coveredSpan: covered,
    overlapSpan,
    pieces,
    points: pointsApplied,
    legacySegments,
    dropped: sanitized.dropped,
    nonFinite: sanitized.nonFinite,
    ties: groups.filter((g) => g.points.length > 1).length,
    nonMergeableTies,
    straightConverted: sanitized.straightConverted,
    mixedConvention: sanitized.mixedConvention,
    issues,
    exact: !approximate,
    approximateSamples,
  };

  const result: CompositeResult = {
    rgba: {
      r: state.radiance.r,
      g: state.radiance.g,
      b: state.radiance.b,
      a: coverageFromTransmittance(state.transmittance),
    },
    radiance: state.radiance,
    transmittance: state.transmittance,
    coverage: coverageFromTransmittance(state.transmittance),
    report,
  };

  return { result, events };
}

export function integrateChain(chain: SampleChain, options: CompositeOptions = {}): CompositeResult {
  return integrateChainDetailed(chain, options).result;
}
