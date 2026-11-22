import { describe, expect, it } from 'vitest';
import type { IntervalSample, PointSample, Rgb, SampleChain } from '../src/core/types';
import { integrateChain } from '../src/core/compositor';

/** Deterministic PRNG so failures are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function maxDiff(a: Rgb, b: Rgb): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

function randomChain(rand: () => number): SampleChain {
  const samples: (IntervalSample | PointSample)[] = [];
  const mediaCount = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < mediaCount; i++) {
    const zNear = rand() * 8;
    const zFar = zNear + 0.5 + rand() * 3;
    samples.push({
      kind: 'interval',
      id: `m${i}`,
      zNear,
      zFar,
      extinction: { r: rand() * 0.6, g: rand() * 0.6, b: rand() * 0.6 },
      emission: { r: rand() * 0.2, g: rand() * 0.2, b: rand() * 0.2 },
    });
  }
  const pointCount = Math.floor(rand() * 3);
  for (let i = 0; i < pointCount; i++) {
    // Distinct depths to avoid ties; ties are tested separately.
    samples.push({
      kind: 'point',
      id: `p${i}`,
      z: rand() * 10 + i * 1e-3,
      color: {
        r: rand() * 0.5,
        g: rand() * 0.5,
        b: rand() * 0.5,
        a: rand() * 0.8,
      },
    });
  }
  return { samples };
}

function splitMedia(chain: SampleChain, suffix: string, depth: number): SampleChain {
  return {
    samples: chain.samples.flatMap((s) => {
      if (s.kind !== 'interval' || !(depth > s.zNear && depth < s.zFar)) return [s];
      return [
        { ...s, id: `${s.id}${suffix}a`, zNear: s.zNear, zFar: depth },
        { ...s, id: `${s.id}${suffix}b`, zNear: depth, zFar: s.zFar },
      ];
    }),
  };
}

describe('randomized integration invariants', () => {
  it('splitting any medium anywhere leaves the image unchanged', () => {
    const rand = mulberry32(1234);
    for (let trial = 0; trial < 200; trial++) {
      const chain = randomChain(rand);
      const base = integrateChain(chain);
      for (const s of chain.samples) {
        if (s.kind !== 'interval') continue;
        const mid = (s.zNear + s.zFar) / 2;
        const split = integrateChain(splitMedia(chain, '~s', mid));
        expect(maxDiff(base.radiance, split.radiance)).toBeLessThan(1e-10);
        expect(maxDiff(base.transmittance, split.transmittance)).toBeLessThan(1e-10);
      }
    }
  });

  it('repeated splitting of the same media stays invariant', () => {
    const rand = mulberry32(98765);
    for (let trial = 0; trial < 100; trial++) {
      const chain = randomChain(rand);
      const base = integrateChain(chain);
      let split = chain;
      let token = 0;
      for (const s of chain.samples) {
        if (s.kind !== 'interval') continue;
        for (let k = 1; k <= 4; k++) {
          const depth = s.zNear + ((s.zFar - s.zNear) * k) / 5;
          split = splitMedia(split, `~s${token++}`, depth);
        }
      }
      const res = integrateChain(split);
      expect(maxDiff(base.radiance, res.radiance)).toBeLessThan(1e-9);
    }
  });

  it('shuffling non-tied samples never changes the result', () => {
    const rand = mulberry32(555);
    for (let trial = 0; trial < 150; trial++) {
      const chain = randomChain(rand);
      const base = integrateChain(chain);
      for (let perm = 0; perm < 5; perm++) {
        const shuffled = { samples: [...chain.samples].sort(() => rand() - 0.5) };
        const r = integrateChain(shuffled);
        expect(maxDiff(base.radiance, r.radiance)).toBe(0);
        expect(maxDiff(base.transmittance, r.transmittance)).toBe(0);
      }
    }
  });

  it('overlap is always split at every owner boundary', () => {
    const rand = mulberry32(31337);
    for (let trial = 0; trial < 100; trial++) {
      const chain = randomChain(rand);
      const media = chain.samples.filter((s): s is IntervalSample => s.kind === 'interval');
      const { report } = integrateChain(chain);
      // Covered span must equal the measure of the union and never exceed the
      // sum of lengths (which would indicate double counting).
      const sumLen = media.reduce((acc, m) => acc + (m.zFar - m.zNear), 0);
      expect(report.coveredSpan).toBeLessThanOrEqual(sumLen + 1e-9);
      const spans = media.map((m) => [m.zNear, m.zFar] as [number, number]).sort((a, b) => a[0] - b[0]);
      let union = 0;
      let curStart = -Infinity;
      let curEnd = -Infinity;
      for (const [a, b] of spans) {
        if (a > curEnd) {
          if (curEnd > curStart) union += curEnd - curStart;
          curStart = a;
          curEnd = b;
        } else {
          curEnd = Math.max(curEnd, b);
        }
      }
      if (curEnd > curStart) union += curEnd - curStart;
      expect(report.coveredSpan).toBeCloseTo(union, 9);
    }
  });

  it('a surface just inside a media edge still splits the medium', () => {
    // Point depth is set only 1e-9 inside the medium, below the default
    // tolerance. Composition must place it after the near sliver, so the medium
    // is split rather than treated as wholly in front or behind.
    const medium: IntervalSample = {
      kind: 'interval',
      id: 'm',
      zNear: 1,
      zFar: 3,
      extinction: { r: 2, g: 2, b: 2 },
      emission: { r: 0, g: 0, b: 0 },
    };
    const surface: PointSample = {
      kind: 'point',
      id: 's',
      z: 1 + 1e-9,
      color: { r: 1, g: 1, b: 1, a: 1 },
    };
    const forward = integrateChain({ samples: [medium, surface] }, { tolerance: 1e-7 });
    const reverse = integrateChain({ samples: [surface, medium] }, { tolerance: 1e-7 });
    expect(forward.radiance.r).toBeCloseTo(reverse.radiance.r, 12);
    expect(forward.radiance.r).toBeLessThan(Math.exp(-1.9));
  });

  it('coincident depths under exchangeable merge are order independent', () => {
    const pts: PointSample[] = [
      { kind: 'point', id: 'a', z: 2, color: { r: 0.8, g: 0.1, b: 0, a: 0.6 } },
      { kind: 'point', id: 'b', z: 2, color: { r: 0.1, g: 0.7, b: 0.2, a: 0.4 } },
      { kind: 'point', id: 'c', z: 2, color: { r: 0, g: 0.2, b: 0.9, a: 0.9 } },
    ];
    const base = integrateChain({ samples: pts }, { tiePolicy: 'exchangeable-merge' });
    const rand = mulberry32(4242);
    for (let i = 0; i < 30; i++) {
      const shuffled = { samples: [...pts].sort(() => rand() - 0.5) };
      const r = integrateChain(shuffled, { tiePolicy: 'exchangeable-merge' });
      expect(r.radiance).toEqual(base.radiance);
    }
  });
});
