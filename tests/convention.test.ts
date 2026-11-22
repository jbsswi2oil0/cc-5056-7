import { describe, expect, it } from 'vitest';
import type { PointSample, SampleChain } from '../src/core/types';
import { SampleError } from '../src/core/types';
import { integrateChain } from '../src/core/compositor';
import {
  findMixedConvention,
  premultiplyStraight,
  probeChainConventions,
  transmittanceProbe,
  resolveConvention,
} from '../src/core/convention';
import { sanitizeChain } from '../src/core/sample';

const premulPoint: PointSample = {
  kind: 'point',
  id: 'premul',
  z: 1,
  color: { r: 0.2, g: 0.4, b: 0.6, a: 0.5 },
};

const straightPoint: PointSample = {
  kind: 'point',
  id: 'straight',
  z: 2,
  colorConvention: 'straight',
  // Unassociated color whose premultiplied form equals premulPoint's color.
  color: { r: 0.4, g: 0.8, b: 1.2, a: 0.5 },
};

describe('straight color conversion at read', () => {
  it('premultiplies straight color exactly once', () => {
    const out = premultiplyStraight(straightPoint.color);
    expect(out.a).toBeCloseTo(0.5, 12);
    expect(out.r).toBeCloseTo(0.2, 12);
    expect(out.g).toBeCloseTo(0.4, 12);
    expect(out.b).toBeCloseTo(0.6, 12);
  });

  it('a converted straight sample integrates identically to its premultiplied twin', () => {
    const twin: PointSample = { ...straightPoint, id: 'twin', z: premulPoint.z, colorConvention: 'premultiplied', color: { ...premulPoint.color } };
    const straight = integrateChain({ samples: [straightPoint] });
    const premul = integrateChain({ samples: [twin] });
    expect(straight.radiance).toEqual(premul.radiance);
    expect(straight.transmittance).toEqual(premul.transmittance);
  });

  it('counts and reports the conversion in the report', () => {
    const r = integrateChain({ samples: [straightPoint] });
    expect(r.report.straightConverted).toBe(1);
    expect(r.report.issues.some((i) => i.code === 'straight-converted')).toBe(true);
  });

  it('reject policy throws instead of converting', () => {
    expect(() => sanitizeChain([straightPoint], 1e-7, 'reject')).toThrow(SampleError);
    try {
      sanitizeChain([straightPoint], 1e-7, 'reject');
    } catch (err) {
      expect((err as SampleError).code).toBe('STRAIGHT_COLOR_NOT_ISOLATED');
    }
    expect(() => integrateChain({ samples: [straightPoint] }, { colorPolicy: 'reject' })).toThrow(
      /straight color/,
    );
  });

  it('resolveConvention leaves premultiplied samples untouched', () => {
    const out = resolveConvention(premulPoint, 'convert-at-read');
    expect(out.converted).toBe(false);
    expect(out.sample).toBe(premulPoint);
  });
});

describe('mixed premultiplied and straight inputs are isolated', () => {
  it('detects a mixed chain and names the offending samples', () => {
    const chain: SampleChain = { samples: [premulPoint, straightPoint] };
    const mixed = findMixedConvention(chain);
    expect(mixed.mixed).toBe(true);
    expect(mixed.ids).toContain('premul');
    expect(mixed.ids).toContain('straight');
  });

  it('refuses to integrate a mixed chain rather than blending conventions', () => {
    const chain: SampleChain = { samples: [premulPoint, straightPoint] };
    expect(() => integrateChain(chain)).toThrow(SampleError);
    try {
      integrateChain(chain);
    } catch (err) {
      expect((err as SampleError).code).toBe('MIXED_COLOR_CONVENTION');
      expect((err as SampleError).details).toMatchObject({ sampleIds: expect.arrayContaining(['premul', 'straight']) });
    }
  });

  it('a uniformly straight chain is accepted and converted', () => {
    const other: PointSample = { ...straightPoint, id: 'straight-2', z: 3 };
    const r = integrateChain({ samples: [straightPoint, other] });
    expect(r.report.straightConverted).toBe(2);
    expect(r.report.mixedConvention).toBe(false);
  });
});

describe('double-layer transmittance probe locates a misread sample', () => {
  it('reports zero gap for a premultiplied sample', () => {
    const probe = transmittanceProbe(premulPoint)!;
    expect(probe).toBeTruthy();
    expect(probe.gap.r).toBe(0);
    expect(probe.declared.r).toBeCloseTo(0.5, 12);
  });

  it('exposes a non-zero gap when straight color is misread as premultiplied', () => {
    const probe = transmittanceProbe(straightPoint)!;
    expect(probe.convention).toBe('straight');
    expect(probe.gap.r).toBeGreaterThan(0);
    // The declared coverage keeps 1-a transmittance; the misread reading takes
    // the color magnitude as opacity and keeps strictly less.
    expect(probe.misread.r).toBeLessThan(probe.declared.r);
  });

  it('preserves depth order across the chain so the bad sample is localizable', () => {
    const probes = probeChainConventions({ samples: [premulPoint, straightPoint] });
    expect(probes.map((p) => p.id)).toEqual(['premul', 'straight']);
    const bad = probes.find((p) => p.gap.r > 0);
    expect(bad?.id).toBe('straight');
  });
});
