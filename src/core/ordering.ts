import type { IntervalSample, PointSample, Sample, SampleChain } from './types';
import { DEFAULT_TOLERANCE } from './sample';

/**
 * Ordering and merge-contract rules for a depth event stream.
 *
 * Events are integrated front-to-back (ascending depth). A medium span owns its
 * near edge and excludes its far edge: [zNear, zFar). When a hard surface sits
 * exactly on a span's near edge the surface is applied first, then the span
 * attenuates it. The reverse ordering (span first at a shared edge) is the
 * classic wrong example: it would attenuate the surface by medium it is in
 * front of.
 */

export type EventOrderKind = 'hard-edge' | 'medium-near' | 'medium-far';

export interface OrderingEntry {
  z: number;
  kind: EventOrderKind;
  sampleIds: string[];
}

/**
 * Flatten samples into sortable depth edges with the near-edge/far-edge
 * convention made explicit. Point samples produce a single hard-edge entry.
 */
export function orderingEntries(chain: SampleChain, tol = DEFAULT_TOLERANCE): OrderingEntry[] {
  const entries: OrderingEntry[] = [];
  for (const s of chain.samples) {
    if (s.kind === 'point') {
      entries.push({ z: s.z, kind: 'hard-edge', sampleIds: [s.id] });
    } else if (s.kind === 'interval') {
      entries.push({ z: s.zNear, kind: 'medium-near', sampleIds: [s.id] });
      entries.push({ z: s.zFar, kind: 'medium-far', sampleIds: [s.id] });
    } else {
      entries.push({ z: s.zNear, kind: 'medium-near', sampleIds: [s.id] });
      entries.push({ z: s.zFar, kind: 'medium-far', sampleIds: [s.id] });
    }
  }
  void tol;
  // Ascending depth; at a shared depth hard edges lead, then near edges, then
  // far edges. Near before far keeps [near, far) half-open semantics.
  const rank: Record<EventOrderKind, number> = {
    'hard-edge': 0,
    'medium-near': 1,
    'medium-far': 2,
  };
  entries.sort((a, b) => a.z - b.z || rank[a.kind] - rank[b.kind]);
  return entries;
}

/**
 * Two intervals can be coalesced into one medium over [z0, z1) only when both
 * cover the whole span. Coalescing then means summing per-unit coefficients,
 * which integrates identically because dL/dz = e - sigma L is linear. An
 * interval that only partially reaches the span, or a span cut by a surface,
 * cannot be represented by one summed interval across the cut.
 */
export function canCoalesceIntervals(
  a: IntervalSample,
  b: IntervalSample,
  z0: number,
  z1: number,
  tol = DEFAULT_TOLERANCE,
): boolean {
  const covers = (m: IntervalSample) => m.zNear <= z0 + tol && m.zFar >= z1 - tol;
  return z1 - z0 > tol && covers(a) && covers(b);
}

export type NonMergeableReason =
  | 'coincident-hard-edge'
  | 'interior-surface-cut'
  | 'partial-interval-cover'
  | 'mixed-kind';

export interface MergeSpan {
  z0: number;
  z1: number;
  /** Interval owners active on the span. */
  ownerIds: string[];
  /** Hard edges sitting on the near boundary. */
  edgePointIds: string[];
  mergeable: boolean;
  reason: NonMergeableReason | 'coefficient-sum' | 'single-owner';
}

export interface MergeContract {
  spans: MergeSpan[];
  /** Ranges that must stay separate events; the reader keeps their order. */
  nonMergeableRanges: Array<{ z0: number; z1: number; reason: NonMergeableReason; sampleIds: string[] }>;
  /** Coincident hard-edge groups, which never merge with a medium. */
  hardEdgeGroups: Array<{ z: number; pointIds: string[] }>;
  ordered: OrderingEntry[];
}

function intervalsOf(samples: Sample[]): IntervalSample[] {
  return samples.filter((s): s is IntervalSample => s.kind === 'interval');
}

function pointsOf(samples: Sample[]): PointSample[] {
  return samples.filter((s): s is PointSample => s.kind === 'point');
}

/**
 * Derive the executable merge contract for a chain. Every depth boundary (media
 * edges and hard-edge depths) partitions the axis; each resulting span records
 * whether its owners may be coalesced and why. The same data drives the
 * documentation contract and the maintenance check, so the two cannot drift.
 */
export function deriveMergeContract(chain: SampleChain, tol = DEFAULT_TOLERANCE): MergeContract {
  const samples = chain.samples;
  const media = intervalsOf(samples);
  const points = pointsOf(samples);

  const edges: number[] = [];
  for (const m of media) edges.push(m.zNear, m.zFar);
  for (const p of points) edges.push(p.z);
  edges.sort((a, b) => a - b);
  const unique: number[] = [];
  for (const e of edges) {
    if (unique.length === 0 || e - unique[unique.length - 1] > tol) unique.push(e);
  }

  const spans: MergeSpan[] = [];
  for (let i = 0; i + 1 < unique.length; i++) {
    const z0 = unique[i];
    const z1 = unique[i + 1];
    if (!(z1 - z0 > tol)) continue;
    const mid = z0 + (z1 - z0) * 0.5;
    const owners = media.filter((m) => mid >= m.zNear - tol && mid < m.zFar - tol);
    const edgePoints = points.filter((p) => Math.abs(p.z - z0) <= tol);
    if (owners.length === 0 && edgePoints.length === 0) continue;

    let mergeable = true;
    let reason: MergeSpan['reason'] = 'single-owner';
    if (edgePoints.length > 0 && owners.length > 0) {
      mergeable = false;
      reason = 'coincident-hard-edge';
    } else if (owners.length > 1) {
      let allCover = true;
      for (let k = 1; k < owners.length; k++) {
        if (!canCoalesceIntervals(owners[0], owners[k], z0, z1, tol)) {
          allCover = false;
          break;
        }
      }
      if (allCover) {
        reason = 'coefficient-sum';
      } else {
        mergeable = false;
        reason = 'partial-interval-cover';
      }
    } else if (owners.length === 1) {
      const only = owners[0];
      if (only.zNear > z0 + tol || only.zFar < z1 - tol) {
        mergeable = false;
        reason = 'partial-interval-cover';
      }
    } else {
      // Hard edge with no medium: never a merge candidate with another kind.
      mergeable = false;
      reason = 'mixed-kind';
    }
    spans.push({
      z0,
      z1,
      ownerIds: owners.map((m) => m.id),
      edgePointIds: edgePoints.map((p) => p.id),
      mergeable,
      reason,
    });
  }

  const nonMergeableRanges = spans
    .filter((s) => !s.mergeable)
    .map((s) => ({
      z0: s.z0,
      z1: s.z1,
      reason: s.reason as NonMergeableReason,
      sampleIds: [...s.edgePointIds, ...s.ownerIds],
    }));

  const hardEdgeGroups: Array<{ z: number; pointIds: string[] }> = [];
  const sortedPoints = [...points].sort((a, b) => a.z - b.z);
  for (const p of sortedPoints) {
    const last = hardEdgeGroups[hardEdgeGroups.length - 1];
    if (last && Math.abs(p.z - last.z) <= tol) last.pointIds.push(p.id);
    else hardEdgeGroups.push({ z: p.z, pointIds: [p.id] });
  }

  return { spans, nonMergeableRanges, hardEdgeGroups, ordered: orderingEntries(chain, tol) };
}

/**
 * A surface strictly inside a media span forces a cut: the medium before and
 * after the surface are independent spans and must not be coalesced across it.
 * Returns the cut depths that the contract has to preserve.
 */
export function interiorSurfaceCuts(chain: SampleChain, tol = DEFAULT_TOLERANCE): number[] {
  const media = intervalsOf(chain.samples);
  const points = pointsOf(chain.samples);
  const cuts = new Set<number>();
  for (const m of media) {
    for (const p of points) {
      if (p.z > m.zNear + tol && p.z < m.zFar - tol) cuts.add(p.z);
    }
  }
  return [...cuts].sort((a, b) => a - b);
}
