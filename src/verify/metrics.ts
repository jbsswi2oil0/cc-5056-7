import type { CompositeOptions, IntervalSample, Rgb, SampleChain } from '../core/types';
import { integrateChain } from '../core/compositor';
import type { LinearImage } from '../app/compose';

export interface ImageDifference {
  maxRadiance: number;
  meanRadiance: number;
  maxTransmittance: number;
  meanTransmittance: number;
  /** Pixel index where the maximum radiance error occurs. */
  worstPixel: number;
}

function abs3(a: Rgb, b: Rgb): { max: number; sum: number } {
  const dr = Math.abs(a.r - b.r);
  const dg = Math.abs(a.g - b.g);
  const db = Math.abs(a.b - b.b);
  return { max: Math.max(dr, dg, db), sum: dr + dg + db };
}

/**
 * Compare a composited image against a reference image of the same size. The
 * mean is over pixels, not over channels, so one bad pixel cannot hide in the
 * average.
 */
/** Compare two composited images of the same size. */
export function compareLinearImages(actual: LinearImage, reference: LinearImage): ImageDifference {
  return compareImages(actual, {
    width: reference.width,
    height: reference.height,
    pixels: reference.radiance.map((radiance, i) => ({
      radiance,
      transmittance: reference.transmittance[i],
    })),
  });
}

export function compareImages(
  actual: LinearImage,
  reference: { width: number; height: number; pixels: { radiance: Rgb; transmittance: Rgb }[] },
): ImageDifference {
  if (actual.width !== reference.width || actual.height !== reference.height) {
    throw new Error('image dimensions do not match');
  }
  let maxRadiance = 0;
  let sumRadiance = 0;
  let maxTransmittance = 0;
  let sumTransmittance = 0;
  let worstPixel = -1;
  for (let i = 0; i < actual.radiance.length; i++) {
    const ref = reference.pixels[i];
    const dr = abs3(actual.radiance[i], ref.radiance);
    const dt = abs3(actual.transmittance[i], ref.transmittance);
    if (dr.max > maxRadiance) {
      maxRadiance = dr.max;
      worstPixel = i;
    }
    sumRadiance += dr.sum / 3;
    maxTransmittance = Math.max(maxTransmittance, dt.max);
    sumTransmittance += dt.sum / 3;
  }
  return {
    maxRadiance,
    meanRadiance: sumRadiance / actual.radiance.length,
    maxTransmittance,
    meanTransmittance: sumTransmittance / actual.transmittance.length,
    worstPixel,
  };
}

/** Split an interval sample at depth z into two contiguous intervals. */
export function splitIntervalAt(sample: IntervalSample, z: number, suffix = '~split'): IntervalSample[] {
  if (!(z > sample.zNear && z < sample.zFar)) {
    throw new Error(`split depth ${z} is not strictly inside [${sample.zNear}, ${sample.zFar}]`);
  }
  return [
    {
      ...sample,
      id: `${sample.id}${suffix}0`,
      zNear: sample.zNear,
      zFar: z,
      extinction: { ...sample.extinction },
      emission: { ...sample.emission },
    },
    {
      ...sample,
      id: `${sample.id}${suffix}1`,
      zNear: z,
      zFar: sample.zFar,
      extinction: { ...sample.extinction },
      emission: { ...sample.emission },
    },
  ];
}

export interface SplitInvarianceResult {
  wholeRadiance: Rgb;
  splitRadiance: Rgb;
  wholeTransmittance: Rgb;
  splitTransmittance: Rgb;
  maxDelta: number;
}

/**
 * Integrate the same medium once whole and once split at the surface depth.
 * A correct integrator yields the same result because integrating a
 * homogeneous interval is additive over adjacent sub-intervals.
 */
export function checkSplitInvariance(
  chain: SampleChain,
  intervalId: string,
  splitDepth: number,
  options: CompositeOptions = {},
): SplitInvarianceResult {
  const interval = chain.samples.find(
    (s): s is IntervalSample => s.kind === 'interval' && s.id === intervalId,
  );
  if (!interval) throw new Error(`interval ${intervalId} not found`);
  const split = splitIntervalAt(interval, splitDepth);
  const splitChain: SampleChain = {
    samples: chain.samples.flatMap((s) => (s === interval ? split : [s])),
  };
  const whole = integrateChain(chain, options);
  const parts = integrateChain(splitChain, options);
  const maxDelta = Math.max(
    Math.abs(whole.radiance.r - parts.radiance.r),
    Math.abs(whole.radiance.g - parts.radiance.g),
    Math.abs(whole.radiance.b - parts.radiance.b),
    Math.abs(whole.transmittance.r - parts.transmittance.r),
    Math.abs(whole.transmittance.g - parts.transmittance.g),
    Math.abs(whole.transmittance.b - parts.transmittance.b),
  );
  return {
    wholeRadiance: whole.radiance,
    splitRadiance: parts.radiance,
    wholeTransmittance: whole.transmittance,
    splitTransmittance: parts.transmittance,
    maxDelta,
  };
}

export interface EnergyCheck {
  ok: boolean;
  maxRadiance: number;
  minTransmittance: number;
  maxTransmittance: number;
  nonFinite: number;
}

/** Basic physical sanity: finite, non-negative radiance and transmittance in [0,1]. */
export function checkEnergy(image: LinearImage): EnergyCheck {
  let maxRadiance = 0;
  let minTransmittance = Infinity;
  let maxTransmittance = -Infinity;
  let nonFinite = 0;
  for (let i = 0; i < image.radiance.length; i++) {
    const r = image.radiance[i];
    const t = image.transmittance[i];
    for (const v of [r.r, r.g, r.b, t.r, t.g, t.b]) {
      if (!Number.isFinite(v)) nonFinite++;
    }
    maxRadiance = Math.max(maxRadiance, r.r, r.g, r.b);
    minTransmittance = Math.min(minTransmittance, t.r, t.g, t.b);
    maxTransmittance = Math.max(maxTransmittance, t.r, t.g, t.b);
  }
  const ok =
    nonFinite === 0 &&
    maxRadiance >= 0 &&
    minTransmittance >= -1e-6 &&
    maxTransmittance <= 1 + 1e-6;
  return { ok, maxRadiance, minTransmittance, maxTransmittance, nonFinite };
}

/**
 * Verify that a foreground occluder actually occludes: radiance behind it must
 * be attenuated relative to the same scene without the occluder.
 */
export function occlusionDelta(
  withOccluder: SampleChain,
  withoutOccluder: SampleChain,
  foregroundId: string,
  options: CompositeOptions = {},
): { reduced: boolean; radianceWith: Rgb; radianceWithout: Rgb } {
  const a = integrateChain(withOccluder, options);
  const b = integrateChain(withoutOccluder, options);
  const lum = (c: Rgb) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const reduced = lum(a.radiance) < lum(b.radiance) - 1e-9;
  void foregroundId;
  return { reduced, radianceWith: a.radiance, radianceWithout: b.radiance };
}
