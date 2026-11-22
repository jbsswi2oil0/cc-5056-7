import { describe, expect, it } from 'vitest';
import type { IntervalSample, PointSample, SampleChain } from '../src/core/types';
import { integrateChain, integrateChainDetailed } from '../src/core/compositor';
import {
  canCoalesceIntervals,
  deriveMergeContract,
  interiorSurfaceCuts,
  orderingEntries,
} from '../src/core/ordering';
import { checkSampleSemantics } from '../src/verify/semantics';
import { middleMatteProof, rearMatteExperiment } from '../src/verify/matte';

const haze: IntervalSample = {
  kind: 'interval',
  id: 'haze',
  zNear: 2,
  zFar: 8,
  extinction: { r: 0.4, g: 0.4, b: 0.4 },
  emission: { r: 0.1, g: 0.1, b: 0.1 },
};
const haze2: IntervalSample = {
  kind: 'interval',
  id: 'haze-2',
  zNear: 3,
  zFar: 7,
  extinction: { r: 0.2, g: 0.2, b: 0.2 },
  emission: { r: 0.05, g: 0.05, b: 0.05 },
};
const hardEdge: PointSample = {
  kind: 'point',
  id: 'edge',
  z: 5,
  color: { r: 0.3, g: 0.3, b: 0.3, a: 0.6 },
};

describe('ordering relation at shared depths', () => {
  it('places a hard edge before the medium near edge it coincides with', () => {
    const surface: PointSample = { kind: 'point', id: 's', z: 2, color: { r: 1, g: 1, b: 1, a: 1 } };
    const entries = orderingEntries({ samples: [haze, surface] });
    const atTwo = entries.filter((e) => e.z === 2);
    expect(atTwo[0].kind).toBe('hard-edge');
    expect(atTwo[1].kind).toBe('medium-near');
  });

  it('the compositor applies the coincident surface first then attenuates it', () => {
    const surface: PointSample = { kind: 'point', id: 's', z: 2, color: { r: 1, g: 1, b: 1, a: 1 } };
    const a = integrateChain({ samples: [haze, surface] });
    const b = integrateChain({ samples: [surface, haze] });
    expect(a.radiance).toEqual(b.radiance);
  });

  it('near edges always sort before far edges so spans stay half-open', () => {
    const entries = orderingEntries({ samples: [haze] });
    const kinds = entries.map((e) => e.kind);
    expect(kinds).toEqual(['medium-near', 'medium-far']);
  });
});

describe('interval coalescing contract', () => {
  it('allows coalescing two intervals that both cover the whole span', () => {
    const a: IntervalSample = { ...haze, id: 'a', zNear: 0, zFar: 10 };
    const b: IntervalSample = { ...haze2, id: 'b', zNear: 0, zFar: 10 };
    expect(canCoalesceIntervals(a, b, 2, 6)).toBe(true);
  });

  it('refuses to coalesce an interval that only partially reaches the span', () => {
    expect(canCoalesceIntervals(haze, haze2, 2, 3)).toBe(false);
    expect(canCoalesceIntervals(haze, haze2, 7, 8)).toBe(false);
  });

  it('marks an interior hard edge as a non-mergeable range', () => {
    const contract = deriveMergeContract({ samples: [haze, hardEdge] });
    // The surface at z=5 splits the haze into [2,5) and [5,8); the span that
    // starts on the hard edge cannot be merged across it.
    expect(contract.nonMergeableRanges.length).toBeGreaterThan(0);
    expect(
      contract.nonMergeableRanges.some(
        (r) => r.reason === 'coincident-hard-edge' && r.sampleIds.includes('edge'),
      ),
    ).toBe(true);
    expect(interiorSurfaceCuts({ samples: [haze, hardEdge] })).toEqual([5]);
  });

  it('flags a hard edge coinciding with a medium boundary as non-mergeable', () => {
    const onBoundary: PointSample = { ...hardEdge, z: 2 };
    const contract = deriveMergeContract({ samples: [haze, onBoundary] });
    expect(contract.nonMergeableRanges.some((r) => r.reason === 'coincident-hard-edge')).toBe(true);
  });
});

describe('same-depth haze and semi-transparent hard edge', () => {
  it('keeps the ordered events and reports a non-mergeable tie under stable order', () => {
    const onBoundary: PointSample = { ...hardEdge, z: 2 };
    const r = integrateChainDetailed({ samples: [haze, onBoundary] }, { collectEvents: true });
    expect(r.result.report.nonMergeableTies).toBeGreaterThan(0);
    expect(r.result.report.issues.some((i) => i.code === 'non-mergeable-tie')).toBe(true);
    // The point event remains distinct from the medium span.
    expect(r.events.some((e) => e.kind === 'point')).toBe(true);
    expect(r.events.some((e) => e.kind === 'medium')).toBe(true);
  });

  it('merges only the eligible point group under exchangeable policy, never cross-kind', () => {
    const a: PointSample = { kind: 'point', id: 'a', z: 5, color: { r: 0.2, g: 0, b: 0, a: 0.5 } };
    const b: PointSample = { kind: 'point', id: 'b', z: 5, color: { r: 0, g: 0.2, b: 0, a: 0.5 } };
    const r = integrateChainDetailed(
      { samples: [a, b, haze] },
      { collectEvents: true, tiePolicy: 'exchangeable-merge' },
    );
    // The two points may be averaged into one event, but that event is still
    // separate from the medium spans.
    const pointEvents = r.events.filter((e) => e.kind === 'point');
    expect(pointEvents.length).toBe(1);
    expect(pointEvents[0].merged).toBe(true);
    expect(r.events.filter((e) => e.kind === 'medium').length).toBeGreaterThan(0);
  });
});

describe('executable semantics maintenance check', () => {
  it('passes a valid overlapping + interior-edge chain', () => {
    const chain: SampleChain = { samples: [haze, haze2, hardEdge] };
    const report = checkSampleSemantics(chain);
    expect(report.ok).toBe(true);
    expect(report.overlapSpans).toBeGreaterThan(0);
    expect(report.interiorCuts).toBe(1);
    expect(report.violations).toEqual([]);
  });

  it('sums rather than averages overlapping coefficients', () => {
    const { events } = integrateChainDetailed({ samples: [haze, haze2] }, { collectEvents: true });
    const overlap = events.find((e) => e.overlap)!;
    expect(overlap.extinction!.r).toBeCloseTo(0.4 + 0.2, 12);
  });
});

describe('middle-matte separation contract', () => {
  it('builds chains equal on empty black that separate with a rear backdrop', () => {
    const proof = middleMatteProof(2, 5, 0.5, 0.3);
    const emptyA = integrateChain(proof.reference);
    const emptyB = integrateChain(proof.withEdge);
    // Equal radiance on empty black.
    expect(emptyA.radiance.r).toBeCloseTo(emptyB.radiance.r, 12);
    // Different open transmittance.
    expect(emptyA.transmittance.r).not.toBeCloseTo(emptyB.transmittance.r, 12);
    const result = rearMatteExperiment(proof.reference, proof.withEdge, {
      z: 0,
      color: { r: 1, g: 1, b: 1 },
    });
    expect(result.equivalentOnEmpty).toBe(true);
    expect(result.separates).toBe(true);
    expect(result.matteDelta.r).toBeGreaterThan(0);
  });
});
