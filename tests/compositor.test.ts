import { describe, expect, it } from 'vitest';
import type {
  IntervalSample,
  LegacySegmentSample,
  PointSample,
  Rgb,
  Sample,
  SampleChain,
} from '../src/core/types';
import { integrateChain, integrateChainDetailed } from '../src/core/compositor';
import { checkSplitInvariance } from '../src/verify/metrics';

const smokeA: IntervalSample = {
  kind: 'interval',
  id: 'smoke-a',
  layer: 'smoke-a',
  zNear: 2.5,
  zFar: 7.5,
  extinction: { r: 0.5, g: 0.44, b: 0.36 },
  emission: { r: 0.1, g: 0.062, b: 0.03 },
};
const smokeB: IntervalSample = {
  kind: 'interval',
  id: 'smoke-b',
  layer: 'smoke-b',
  zNear: 3.5,
  zFar: 9.0,
  extinction: { r: 0.34, g: 0.42, b: 0.56 },
  emission: { r: 0.02, g: 0.04, b: 0.095 },
};
const slice: PointSample = {
  kind: 'point',
  id: 'slice',
  layer: 'slice',
  z: 5,
  color: { r: 0.93 * 0.9, g: 0.03 * 0.9, b: 0.018 * 0.9, a: 0.9 },
};
const plate: PointSample = {
  kind: 'point',
  id: 'plate',
  layer: 'plate',
  z: 0.8,
  color: { r: 0.1 * 0.8, g: 0.32 * 0.8, b: 0.95 * 0.8, a: 0.8 },
};

function maxDiff(a: Rgb, b: Rgb): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

describe('interval integration', () => {
  it('integrates a homogeneous medium in closed form', () => {
    const lone: IntervalSample = {
      kind: 'interval',
      id: 'm',
      zNear: 1,
      zFar: 4,
      extinction: { r: 0.2, g: 0.1, b: 0.05 },
      emission: { r: 0.3, g: 0.2, b: 0.1 },
    };
    const r = integrateChain({ samples: [lone] });
    const len = 3;
    const channel = (sigma: number, e: number) => {
      const tau = sigma * len;
      return (e * len * (1 - Math.exp(-tau))) / tau;
    };
    expect(r.radiance.r).toBeCloseTo(channel(0.2, 0.3), 12);
    expect(r.radiance.g).toBeCloseTo(channel(0.1, 0.2), 12);
    expect(r.radiance.b).toBeCloseTo(channel(0.05, 0.1), 12);
    expect(r.transmittance.r).toBeCloseTo(Math.exp(-0.2 * len), 12);
    expect(r.transmittance.g).toBeCloseTo(Math.exp(-0.1 * len), 12);
    expect(r.transmittance.b).toBeCloseTo(Math.exp(-0.05 * len), 12);
  });

  it('is additive over adjacent sub-intervals (split invariance)', () => {
    const chain: SampleChain = { samples: [smokeA, smokeB, slice, plate] };
    const whole = integrateChain(chain);
    const split = checkSplitInvariance(chain, 'smoke-a', 5, {});
    expect(split.maxDelta).toBeLessThan(1e-12);
    expect(maxDiff(whole.radiance, split.splitRadiance)).toBeLessThan(1e-12);
    const reference = integrateChainDetailed(chain, { collectEvents: true });
    expect(reference.result.radiance).toEqual(whole.radiance);
  });

  it('splits a medium at an interior surface instead of applying it after the medium', () => {
    // A purely absorbing smoke around an opaque-ish red surface: the surface
    // must be attenuated by the near half only, and the far half must be
    // attenuated by the surface. Applying the whole medium first would give a
    // different, wrong answer.
    const smoke: IntervalSample = {
      kind: 'interval',
      id: 's',
      zNear: 0,
      zFar: 10,
      extinction: { r: 0.5, g: 0.5, b: 0.5 },
      emission: { r: 0, g: 0, b: 0 },
    };
    const point: PointSample = { kind: 'point', id: 'p', z: 5, color: { r: 1, g: 1, b: 1, a: 1 } };
    const { result, events } = integrateChainDetailed({ samples: [smoke, point] }, { collectEvents: true });
    expect(events.map((e) => e.kind)).toEqual(['medium', 'point', 'medium']);
    expect(result.radiance.r).toBeCloseTo(Math.exp(-0.5 * 5), 12);
    // The far half contributes nothing because it is fully occluded.
    expect(result.transmittance.r).toBeCloseTo(0, 12);
  });

  it('does not average overlapping media over their intersection', () => {
    const { result, events } = integrateChainDetailed({ samples: [smokeA, smokeB] }, { collectEvents: true });
    // The overlap [3.5, 7.5] must be its own span with two sources.
    const overlap = events.filter((e) => e.overlap);
    expect(overlap.length).toBe(1);
    expect(overlap[0].z0).toBeCloseTo(3.5, 12);
    expect(overlap[0].z1).toBeCloseTo(7.5, 12);
    expect(overlap[0].sourceIds.sort()).toEqual(['smoke-a', 'smoke-b']);
    // Coefficients are summed, not averaged: sigma_t is the sum over owners.
    expect(overlap[0].extinction!.r).toBeCloseTo(0.5 + 0.34, 12);
    expect(overlap[0].extinction!.g).toBeCloseTo(0.44 + 0.42, 12);
    expect(result.report.overlapSpan).toBeCloseTo(4, 12);
  });

  it('is invariant to input order for non-tied samples', () => {
    const base: Sample[] = [smokeA, smokeB, slice, plate];
    const reference = integrateChain({ samples: base });
    for (let trial = 0; trial < 25; trial++) {
      const shuffled = [...base].sort(() => Math.random() - 0.5);
      const r = integrateChain({ samples: shuffled });
      expect(maxDiff(r.radiance, reference.radiance)).toBe(0);
      expect(maxDiff(r.transmittance, reference.transmittance)).toBe(0);
    }
  });
});

describe('depth interleaving with a foreground plate', () => {
  it('attenuates volume radiance with the plate in front', () => {
    const withoutPlate = integrateChain({ samples: [smokeA, slice] });
    const withPlate = integrateChain({ samples: [plate, smokeA, slice] });
    // The plate covers 80% at z=0.8, before the smoke. The plate adds its own
    // premultiplied color, and the smoke's radiance passes at (1 - 0.8).
    for (const k of ['r', 'g', 'b'] as const) {
      expect(withPlate.radiance[k]).toBeCloseTo(
        plate.color[k] + (1 - plate.color.a) * withoutPlate.radiance[k],
        10,
      );
    }
  });

  it('keeps a plate behind the volume from changing the emitted radiance', () => {
    const behind: PointSample = { ...plate, z: 9.5 };
    const without = integrateChain({ samples: [smokeA] });
    const withBehind = integrateChain({ samples: [smokeA, behind] });
    // The plate is behind the medium, so the medium's emitted radiance is
    // untouched. The plate only adds its own color, attenuated by the medium.
    const tauR = smokeA.extinction.r * (smokeA.zFar - smokeA.zNear);
    const tAfterR = Math.exp(-tauR);
    expect(withBehind.radiance.r).toBeCloseTo(without.radiance.r + behind.color.r * tAfterR, 10);
    expect(withBehind.transmittance.r).toBeCloseTo(without.transmittance.r * (1 - behind.color.a), 10);
  });
});

describe('legacy whole-segment assets', () => {
  const legacyA: LegacySegmentSample = {
    kind: 'legacy-segment',
    id: 'smoke-a',
    zNear: 2.5,
    zFar: 7.5,
    accumulated: { r: 0.5, g: 0.32, b: 0.2, a: 0.7 },
    provenance: 'legacy-accumulated',
  };

  it('refuses exact composition when an interior surface makes splitting impossible', () => {
    expect(() => integrateChain({ samples: [legacyA, slice] })).toThrowError(
      /cannot be split exactly/,
    );
    try {
      integrateChain({ samples: [legacyA, slice] });
    } catch (err) {
      expect((err as { code?: string }).code).toBe('LEGACY_NEEDS_SEGMENTATION');
    }
  });

  it('refuses exact composition when another segment overlaps the legacy span', () => {
    expect(() => integrateChain({ samples: [legacyA, smokeB] })).toThrowError(
      /cannot be split exactly/,
    );
  });

  it('accepts a legacy segment that has no interior event', () => {
    const isolated: LegacySegmentSample = { ...legacyA, zNear: 0, zFar: 1 };
    const r = integrateChain({ samples: [isolated] });
    expect(r.report.exact).toBe(true);
    expect(r.radiance.r).toBeCloseTo(0.5, 12);
  });

  it('produces a marked approximation only when explicitly allowed', () => {
    const r = integrateChain({ samples: [legacyA, slice] }, { allowApproximateLegacy: true });
    expect(r.report.exact).toBe(false);
    expect(r.report.approximateSamples).toContain('smoke-a');
    const approximateIssue = r.report.issues.find((i) => i.code === 'legacy-approximate');
    expect(approximateIssue).toBeDefined();
    // The approximation is visible as a distinct image, not an exact export.
    const exactish = integrateChain({ samples: [legacyA] });
    expect(maxDiff(r.radiance, exactish.radiance)).toBeGreaterThan(1e-3);
  });
});

describe('coincident depth samples', () => {
  const red: PointSample = { kind: 'point', id: 'red', z: 5, color: { r: 0.9, g: 0, b: 0, a: 0.5 } };
  const green: PointSample = { kind: 'point', id: 'green', z: 5, color: { r: 0, g: 0.9, b: 0, a: 0.5 } };

  it('stable-order composites in input order and can differ when order flips', () => {
    const rg = integrateChain({ samples: [red, green] }, { tiePolicy: 'stable-order' });
    const gr = integrateChain({ samples: [green, red] }, { tiePolicy: 'stable-order' });
    expect(rg.radiance.r).toBeCloseTo(0.9, 12);
    expect(rg.radiance.g).toBeCloseTo(0.45, 12);
    expect(gr.radiance.r).toBeCloseTo(0.45, 12);
    expect(gr.radiance.g).toBeCloseTo(0.9, 12);
    expect(rg.report.ties).toBe(1);
  });

  it('exchangeable-merge is invariant to input order and marked approximate', () => {
    const rg = integrateChain({ samples: [red, green] }, { tiePolicy: 'exchangeable-merge' });
    const gr = integrateChain({ samples: [green, red] }, { tiePolicy: 'exchangeable-merge' });
    expect(maxDiff(rg.radiance, gr.radiance)).toBe(0);
    expect(rg.radiance.r).toBeCloseTo(0.45, 12);
    expect(rg.radiance.g).toBeCloseTo(0.45, 12);
    expect(rg.report.exact).toBe(false);
  });

  it('stable-order is deterministic across repeated runs on the same input', () => {
    const a = integrateChain({ samples: [red, green] }, { tiePolicy: 'stable-order' });
    for (let i = 0; i < 10; i++) {
      const b = integrateChain({ samples: [red, green] }, { tiePolicy: 'stable-order' });
      expect(b.radiance).toEqual(a.radiance);
    }
  });

  it('treats a surface at the near edge of a span deterministically', () => {
    const medium: IntervalSample = {
      kind: 'interval',
      id: 'm',
      zNear: 5,
      zFar: 6,
      extinction: { r: 1, g: 1, b: 1 },
      emission: { r: 0, g: 0, b: 0 },
    };
    const surface: PointSample = { kind: 'point', id: 's', z: 5, color: { r: 1, g: 1, b: 1, a: 1 } };
    const a = integrateChain({ samples: [medium, surface] });
    const b = integrateChain({ samples: [surface, medium] });
    expect(a.radiance).toEqual(b.radiance);
    // Surface first, then the medium attenuates it.
    expect(a.transmittance.r).toBeCloseTo(0, 12);
  });
});

describe('invalid and empty inputs', () => {
  it('returns transparent black and full transmittance for an empty pixel', () => {
    const r = integrateChain({ samples: [] });
    expect(r.radiance).toEqual({ r: 0, g: 0, b: 0 });
    expect(r.transmittance).toEqual({ r: 1, g: 1, b: 1 });
    expect(r.coverage).toBe(0);
    expect(r.report.exact).toBe(true);
  });

  it('drops non-finite samples and reports them', () => {
    const good: PointSample = { kind: 'point', id: 'good', z: 1, color: { r: 0.5, g: 0.5, b: 0.5, a: 0.5 } };
    const bad: PointSample = { kind: 'point', id: 'bad', z: NaN, color: { r: 1, g: 1, b: 1, a: 1 } };
    const r = integrateChain({ samples: [good, bad] });
    expect(r.report.nonFinite).toBe(1);
    expect(r.report.dropped).toBe(1);
    expect(r.report.issues.some((i) => i.code === 'non-finite')).toBe(true);
    expect(r.radiance.r).toBeCloseTo(0.5, 12);
  });

  it('drops non-finite intervals and infinite coefficients', () => {
    const bad: IntervalSample = {
      kind: 'interval',
      id: 'bad',
      zNear: 0,
      zFar: Infinity,
      extinction: { r: 0.5, g: 0.5, b: 0.5 },
      emission: { r: 0, g: 0, b: 0 },
    };
    const r = integrateChain({ samples: [bad] });
    expect(r.report.nonFinite).toBe(1);
    expect(r.radiance).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('drops zero-coverage and empty samples without changing the result', () => {
    const good: PointSample = { kind: 'point', id: 'good', z: 2, color: { r: 0.4, g: 0.4, b: 0.4, a: 0.5 } };
    const zero: PointSample = { kind: 'point', id: 'zero', z: 2, color: { r: 1, g: 1, b: 1, a: 0 } };
    const empty: IntervalSample = {
      kind: 'interval',
      id: 'empty',
      zNear: 3,
      zFar: 3,
      extinction: { r: 1, g: 1, b: 1 },
      emission: { r: 0, g: 0, b: 0 },
    };
    const r = integrateChain({ samples: [good, zero, empty] });
    expect(r.radiance).toEqual(integrateChain({ samples: [good] }).radiance);
    expect(r.report.dropped).toBe(2);
  });

  it('is invariant to input order even with invalid samples mixed in', () => {
    const zero: PointSample = { kind: 'point', id: 'zero', z: 2, color: { r: 1, g: 1, b: 1, a: 0 } };
    const bad: PointSample = { kind: 'point', id: 'bad', z: NaN, color: { r: 1, g: 1, b: 1, a: 1 } };
    const base: Sample[] = [smokeA, slice, zero, bad, smokeB];
    const reference = integrateChain({ samples: base });
    for (let i = 0; i < 20; i++) {
      const shuffled = [...base].sort(() => Math.random() - 0.5);
      expect(integrateChain({ samples: shuffled }).radiance).toEqual(reference.radiance);
    }
  });
});

describe('sample-chain semantics matching the brief', () => {
  it('a single segment split at the slice matches its two spans with the slice between them', () => {
    // Manually pre-split smoke A at z=5 and place the slice between the halves.
    const near: IntervalSample = { ...smokeA, id: 'smoke-a-near', zNear: 2.5, zFar: 5 };
    const far: IntervalSample = { ...smokeA, id: 'smoke-a-far', zNear: 5, zFar: 7.5 };
    const auto = integrateChain({ samples: [smokeA, slice] });
    const manual = integrateChain({ samples: [near, far, slice] });
    expect(maxDiff(auto.radiance, manual.radiance)).toBeLessThan(1e-12);
    expect(maxDiff(auto.transmittance, manual.transmittance)).toBeLessThan(1e-12);
  });
});
