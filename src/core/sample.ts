import type {
  ColorConvention,
  IntervalSample,
  LegacySegmentSample,
  PointSample,
  Rgb,
  Rgba,
  Sample,
  SampleChain,
  SampleIssue,
  SampleIssueCode,
} from './types';
import { SampleError } from './types';
import { findMixedConvention, resolveConvention } from './convention';

export const DEFAULT_TOLERANCE = 1e-7;
export const MAX_TIE_GROUP = 8;

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Stable scalar serialization used for fingerprints and deterministic ties. */
export function canonNumber(v: number): string {
  if (!Number.isFinite(v)) return 'nonfinite';
  const q = Math.round(v * 1e12) / 1e12;
  return Object.is(q, -0) ? '0' : String(q);
}

function canonRgb(c: Rgb): string {
  return `${canonNumber(c.r)},${canonNumber(c.g)},${canonNumber(c.b)}`;
}

function canonRgba(c: Rgba): string {
  return `${canonRgb(c)},${canonNumber(c.a)}`;
}

export function sampleFingerprint(s: Sample): string {
  switch (s.kind) {
    case 'point':
      return `p:${canonNumber(s.z)}:${canonRgba(s.color)}`;
    case 'interval':
      return `i:${canonNumber(s.zNear)}:${canonNumber(s.zFar)}:${canonRgb(s.extinction)}:${canonRgb(s.emission)}`;
    case 'legacy-segment':
      return `l:${canonNumber(s.zNear)}:${canonNumber(s.zFar)}:${canonRgba(s.accumulated)}`;
  }
}

function isFiniteRgb(c: Rgb | undefined): boolean {
  return !!c && Number.isFinite(c.r) && Number.isFinite(c.g) && Number.isFinite(c.b);
}

function isFiniteRgba(c: Rgba | undefined): boolean {
  return isFiniteRgb(c) && !!c && Number.isFinite(c.a);
}

function clampNonNegativeRgb(c: Rgb): Rgb {
  return {
    r: c.r > 0 ? c.r : 0,
    g: c.g > 0 ? c.g : 0,
    b: c.b > 0 ? c.b : 0,
  };
}

function clampNonNegativeRgba(c: Rgba): Rgba {
  const rgb = clampNonNegativeRgb(c);
  return { r: rgb.r, g: rgb.g, b: rgb.b, a: clamp01(c.a) };
}

function sameRgb(a: Rgb, b: Rgb): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

function sameRgba(a: Rgba, b: Rgba): boolean {
  return sameRgb(a, b) && a.a === b.a;
}

function issue(
  issues: SampleIssue[],
  code: SampleIssueCode,
  message: string,
  sampleIds?: string[],
  count?: number,
): void {
  issues.push({ code, message, sampleIds, count });
}

export interface SanitizedChain {
  media: IntervalSample[];
  points: PointSample[];
  legacy: LegacySegmentSample[];
  issues: SampleIssue[];
  dropped: number;
  nonFinite: number;
  /** Surface samples converted from straight to premultiplied at read time. */
  straightConverted: number;
  /** True when the input mixed premultiplied and straight surface color. */
  mixedConvention: boolean;
  /** Original input position of each kept sample, for stable-order ties. */
  ordinal: Map<Sample, number>;
}

export type ColorPolicy = 'convert-at-read' | 'reject';

/**
 * Validate a chain and split it into media, point, and legacy lists. Invalid
 * fields are dropped, never propagated; every removal is reported so the UI can
 * surface anomalies instead of silently changing the image.
 *
 * Color conventions are resolved here, at the read boundary: straight surface
 * color is premultiplied once (or rejected), and a chain that mixes the two
 * conventions is isolated with SampleError instead of being blended.
 *
 * The result is sorted into a canonical order so that floating-point
 * accumulation is independent of the caller's array order.
 */
export function sanitizeChain(
  samples: Sample[],
  tol: number = DEFAULT_TOLERANCE,
  colorPolicy: ColorPolicy = 'convert-at-read',
): SanitizedChain {
  const mixed = findMixedConvention({ samples });
  if (mixed.mixed) {
    throw new SampleError(
      `chain mixes premultiplied and straight color on samples ${mixed.ids.join(', ')}; conventions must be isolated`,
      'MIXED_COLOR_CONVENTION',
      { sampleIds: mixed.ids },
    );
  }

  const media: IntervalSample[] = [];
  const points: PointSample[] = [];
  const legacy: LegacySegmentSample[] = [];
  const issues: SampleIssue[] = [];
  const ordinal = new Map<Sample, number>();
  let dropped = 0;
  let nonFinite = 0;
  let straightConverted = 0;
  const idCounts = new Map<string, number>();

  const drop = (code: SampleIssueCode, message: string, id?: string) => {
    dropped++;
    issue(issues, code, message, id ? [id] : undefined);
  };

  samples.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object' || typeof (raw as Sample).kind !== 'string') {
      nonFinite++;
      drop('unknown-kind', `sample #${index} is not a recognized sample`);
      return;
    }
    let s: Sample = raw;
    // Resolve the color convention before validation reads rgb, so a straight
    // sample is never measured against premultiplied invariants.
    if (s.kind === 'point' || s.kind === 'legacy-segment') {
      const resolved = resolveConvention(s, colorPolicy);
      if (resolved.converted) {
        straightConverted++;
        issues.push({
          code: 'straight-converted',
          message: `sample "${s.id}" read as straight color and premultiplied at load`,
          sampleIds: [s.id],
        });
      }
      s = resolved.sample;
    }
    const id = String((s as { id?: unknown }).id ?? `#${index}`);
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1);

    if (s.kind === 'point') {
      if (!Number.isFinite(s.z) || !isFiniteRgba(s.color)) {
        nonFinite++;
        drop('non-finite', `point ${id} has non-finite depth or color`, id);
        return;
      }
      if (!(s.color.a > 0)) {
        drop('zero-coverage', `point ${id} has zero coverage`, id);
        return;
      }
      const color = clampNonNegativeRgba(s.color);
      if (!sameRgba(color, s.color)) {
        issue(issues, 'sanitized', `point ${id} clamped to non-negative premultiplied color`, [id]);
      }
      const point = { ...s, id, color, colorConvention: 'premultiplied' as ColorConvention };
      ordinal.set(point, index);
      points.push(point);
      return;
    }

    if (s.kind === 'interval') {
      if (
        !Number.isFinite(s.zNear) ||
        !Number.isFinite(s.zFar) ||
        !isFiniteRgb(s.extinction) ||
        !isFiniteRgb(s.emission)
      ) {
        nonFinite++;
        drop('non-finite', `interval ${id} has non-finite boundaries or coefficients`, id);
        return;
      }
      if (!(s.zFar > s.zNear + tol)) {
        drop('empty-interval', `interval ${id} has zero or reversed extent`, id);
        return;
      }
      const extinction = clampNonNegativeRgb(s.extinction);
      const emission = clampNonNegativeRgb(s.emission);
      if (
        extinction.r <= 0 &&
        extinction.g <= 0 &&
        extinction.b <= 0 &&
        emission.r <= 0 &&
        emission.g <= 0 &&
        emission.b <= 0
      ) {
        drop('empty-interval', `interval ${id} carries no extinction or emission`, id);
        return;
      }
      if (!sameRgb(extinction, s.extinction) || !sameRgb(emission, s.emission)) {
        issue(issues, 'sanitized', `interval ${id} negative coefficients clamped to zero`, [id]);
      }
      const interval = { ...s, id, extinction, emission };
      ordinal.set(interval, index);
      media.push(interval);
      return;
    }

    if (s.kind === 'legacy-segment') {
      if (
        !Number.isFinite(s.zNear) ||
        !Number.isFinite(s.zFar) ||
        !isFiniteRgba(s.accumulated)
      ) {
        nonFinite++;
        drop('non-finite', `legacy segment ${id} has non-finite boundaries or color`, id);
        return;
      }
      if (!(s.zFar > s.zNear + tol)) {
        drop('empty-interval', `legacy segment ${id} has zero or reversed extent`, id);
        return;
      }
      const accumulated = clampNonNegativeRgba(s.accumulated);
      if (accumulated.r <= 0 && accumulated.g <= 0 && accumulated.b <= 0 && accumulated.a <= 0) {
        drop('zero-coverage', `legacy segment ${id} carries no contribution`, id);
        return;
      }
      if (!sameRgba(accumulated, s.accumulated)) {
        issue(issues, 'sanitized', `legacy segment ${id} clamped to non-negative color`, [id]);
      }
      const segment = { ...s, id, accumulated, colorConvention: 'premultiplied' as ColorConvention };
      ordinal.set(segment, index);
      legacy.push(segment);
      return;
    }

    nonFinite++;
    drop('unknown-kind', `sample ${id} has unknown kind`);
  });

  for (const [id, count] of idCounts) {
    if (count > 1) {
      issue(issues, 'duplicate-id', `sample id "${id}" occurs ${count} times`, [id], count);
    }
  }

  media.sort(compareMedia);
  legacy.sort(compareLegacy);
  // Points keep input order: the stable-order tie policy is defined on it.
  return {
    media,
    points,
    legacy,
    issues,
    dropped,
    nonFinite,
    straightConverted,
    mixedConvention: mixed.mixed,
    ordinal,
  };
}

export function compareMedia(a: IntervalSample, b: IntervalSample): number {
  return (
    a.zNear - b.zNear ||
    a.zFar - b.zFar ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
    (sampleFingerprint(a) < sampleFingerprint(b) ? -1 : sampleFingerprint(a) > sampleFingerprint(b) ? 1 : 0)
  );
}

export function comparePoints(a: PointSample, b: PointSample): number {
  return (
    a.z - b.z ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
    (sampleFingerprint(a) < sampleFingerprint(b) ? -1 : sampleFingerprint(a) > sampleFingerprint(b) ? 1 : 0)
  );
}

export function compareLegacy(a: LegacySegmentSample, b: LegacySegmentSample): number {
  return (
    a.zNear - b.zNear ||
    a.zFar - b.zFar ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
    (sampleFingerprint(a) < sampleFingerprint(b) ? -1 : sampleFingerprint(a) > sampleFingerprint(b) ? 1 : 0)
  );
}

export interface LegacyAnalysis {
  /** Per-segment flag: true when interior events prevent exact splitting. */
  needsSegmentation: Map<string, boolean>;
  anyNeedsSegmentation: boolean;
}

/**
 * A legacy segment is exact only when nothing else contributes strictly inside
 * its span. With an interior point or an overlapping medium, a single total
 * color cannot tell us how the contribution is distributed around that event.
 */
export function analyzeLegacy(
  legacy: LegacySegmentSample[],
  media: IntervalSample[],
  points: PointSample[],
  tol: number,
): LegacyAnalysis {
  const needsSegmentation = new Map<string, boolean>();
  let any = false;
  for (const seg of legacy) {
    let needs = false;
    for (const m of media) {
      const lo = Math.max(seg.zNear, m.zNear);
      const hi = Math.min(seg.zFar, m.zFar);
      if (hi - lo > tol) {
        needs = true;
        break;
      }
    }
    if (!needs) {
      for (const p of points) {
        if (p.z > seg.zNear + tol && p.z < seg.zFar - tol) {
          needs = true;
          break;
        }
      }
    }
    if (!needs) {
      for (const other of legacy) {
        if (other === seg) continue;
        const lo = Math.max(seg.zNear, other.zNear);
        const hi = Math.min(seg.zFar, other.zFar);
        if (hi - lo > tol) {
          needs = true;
          break;
        }
        if (
          (other.zNear > seg.zNear + tol && other.zNear < seg.zFar - tol) ||
          (other.zFar > seg.zNear + tol && other.zFar < seg.zFar - tol)
        ) {
          needs = true;
          break;
        }
      }
    }
    needsSegmentation.set(seg.id, needs);
    any ||= needs;
  }
  return { needsSegmentation, anyNeedsSegmentation: any };
}
