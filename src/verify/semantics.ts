import type { Rgb, SampleChain } from '../core/types';
import { integrateChain, integrateChainDetailed } from '../core/compositor';
import { deriveMergeContract, interiorSurfaceCuts, orderingEntries } from '../core/ordering';

/**
 * Executable sample-semantics maintenance check.
 *
 * The same ordering and merge rules that the compositor follows are re-derived
 * here from the raw chain, then checked two ways:
 *   1. structurally — overlapping intervals must be split (never averaged) and
 *      coincident hard edges must keep an ordered, non-merged range;
 *   2. by integration contribution — splitting an interval anywhere, or
 *      shuffling non-tied samples, must leave radiance and transmittance
 *      unchanged.
 * A failure here means the documentation contract and the implementation have
 * drifted; the check never substitutes a default value for a bad sample.
 */

export interface SemanticsViolation {
  code:
    | 'overlap-not-split'
    | 'coefficient-averaged'
    | 'hard-edge-merged'
    | 'interior-cut-lost'
    | 'ordering-mismatch'
    | 'split-invariance-broken'
    | 'shuffle-invariance-broken';
  message: string;
  sampleIds?: string[];
}

export interface SemanticsReport {
  ok: boolean;
  violations: SemanticsViolation[];
  overlapSpans: number;
  hardEdgeGroups: number;
  nonMergeableRanges: number;
  interiorCuts: number;
  events: number;
}

function maxAbs(a: Rgb, b: Rgb): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

export function checkSampleSemantics(chain: SampleChain, eps = 1e-10): SemanticsReport {
  const violations: SemanticsViolation[] = [];
  const contract = deriveMergeContract(chain);
  const detailed = integrateChainDetailed(chain, { collectEvents: true });
  const base = integrateChain(chain);
  const cuts = interiorSurfaceCuts(chain);

  // 1. Overlapping intervals: every multi-owner span must sum coefficients.
  let overlapSpans = 0;
  for (const ev of detailed.events) {
    if (ev.kind !== 'medium' || ev.sourceIds.length < 2) continue;
    overlapSpans++;
    if (!ev.overlap) {
      violations.push({
        code: 'overlap-not-split',
        message: `span [${ev.z0}, ${ev.z1}) has ${ev.sourceIds.length} owners but is not marked overlap`,
        sampleIds: ev.sourceIds,
      });
    }
    // The combined coefficient must equal the sum of the per-source coefficients.
    const sum: Rgb = { r: 0, g: 0, b: 0 };
    for (const src of ev.sources ?? []) {
      sum.r += src.extinction.r;
      sum.g += src.extinction.g;
      sum.b += src.extinction.b;
    }
    if (ev.extinction && maxAbs(sum, ev.extinction) > eps) {
      violations.push({
        code: 'coefficient-averaged',
        message: `span [${ev.z0}, ${ev.z1}) coefficients were not the sum of owners`,
        sampleIds: ev.sourceIds,
      });
    }
  }

  // 2. Coincident hard edges: the contract's non-mergeable ranges must survive
  //    into the event stream as separate ordered point events.
  const hardEdgeGroups = contract.hardEdgeGroups.filter((g) => g.pointIds.length > 1).length;
  for (const range of contract.nonMergeableRanges) {
    const covering = detailed.events.filter(
      (ev) => ev.z0 >= range.z0 - eps && ev.z1 <= range.z1 + eps,
    );
    const hasHardEdge = covering.some((ev) => ev.kind === 'point' || ev.kind === 'legacy');
    if (range.reason === 'coincident-hard-edge' && !hasHardEdge) {
      violations.push({
        code: 'hard-edge-merged',
        message: `non-mergeable range [${range.z0}, ${range.z1}) lost its ordered hard edge`,
        sampleIds: range.sampleIds,
      });
    }
  }

  // 3. Interior surface cuts must all appear as event boundaries.
  const boundaries = new Set<number>();
  for (const ev of detailed.events) {
    boundaries.add(Number(ev.z0.toFixed(12)));
    boundaries.add(Number(ev.z1.toFixed(12)));
  }
  for (const z of cuts) {
    const present = [...boundaries].some((b) => Math.abs(b - z) <= 1e-9);
    if (!present) {
      violations.push({
        code: 'interior-cut-lost',
        message: `interior surface at z=${z} did not split the medium`,
      });
    }
  }

  // 4. Ordering relation: hard edges lead at a shared depth, then near edges.
  const ordered = orderingEntries(chain);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const cur = ordered[i];
    if (Math.abs(prev.z - cur.z) <= eps) {
      const rank = { 'hard-edge': 0, 'medium-near': 1, 'medium-far': 2 } as const;
      if (rank[prev.kind] > rank[cur.kind]) {
        violations.push({
          code: 'ordering-mismatch',
          message: `at z=${cur.z} a ${cur.kind} was ordered before a ${prev.kind}`,
          sampleIds: [...prev.sampleIds, ...cur.sampleIds],
        });
      }
    }
  }

  // 5. Split invariance: split each interval at an interior point and re-integrate.
  for (const s of chain.samples) {
    if (s.kind !== 'interval') continue;
    const mid = (s.zNear + s.zFar) / 2;
    const splitSamples = chain.samples.flatMap((m) => {
      if (m !== s) return [m];
      return [
        { ...m, id: `${m.id}~check0`, zNear: m.zNear, zFar: mid },
        { ...m, id: `${m.id}~check1`, zNear: mid, zFar: m.zFar },
      ];
    });
    const split = integrateChain({ samples: splitSamples });
    if (maxAbs(split.radiance, base.radiance) > eps || maxAbs(split.transmittance, base.transmittance) > eps) {
      violations.push({
        code: 'split-invariance-broken',
        message: `splitting interval "${s.id}" changed the integrated result`,
        sampleIds: [s.id],
      });
    }
  }

  // 6. Shuffle invariance for non-tied samples: input order must not matter.
  const shuffled = { samples: [...chain.samples].reverse() };
  const reversed = integrateChain(shuffled);
  if (maxAbs(reversed.radiance, base.radiance) > eps) {
    violations.push({
      code: 'shuffle-invariance-broken',
      message: 'reversing sample order changed the integrated radiance',
    });
  }

  return {
    ok: violations.length === 0,
    violations,
    overlapSpans,
    hardEdgeGroups,
    nonMergeableRanges: contract.nonMergeableRanges.length,
    interiorCuts: cuts.length,
    events: detailed.events.length,
  };
}

/** Aggregate the per-pixel semantics check over an image's chains. */
export function checkImageSemantics(
  chains: SampleChain[],
  eps = 1e-10,
): { ok: boolean; pixelFailures: Array<{ index: number; report: SemanticsReport }> } {
  const pixelFailures: Array<{ index: number; report: SemanticsReport }> = [];
  chains.forEach((chain, index) => {
    const report = checkSampleSemantics(chain, eps);
    if (!report.ok) pixelFailures.push({ index, report });
  });
  return { ok: pixelFailures.length === 0, pixelFailures };
}
