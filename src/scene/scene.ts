import type {
  IntervalSample,
  LegacySegmentSample,
  PointSample,
  Rgb,
  Rgba,
  Sample,
  SampleChain,
} from '../core/types';

export interface SceneLayer {
  id: string;
  label: string;
  color: string;
  description: string;
}

export const SCENE_LAYERS: SceneLayer[] = [
  {
    id: 'plate',
    label: 'Foreground plate · z=0.8',
    color: '#3b82f6',
    description: 'Opaque blue plate in front of the volume. Any radiance from the smoke behind it must be attenuated.',
  },
  {
    id: 'smoke-a',
    label: 'Smoke A (warm) · z 2.5–7.5',
    color: '#f59e0b',
    description: 'Warm uniform medium storing per-unit extinction and emission. Crosses the red slice at z=5.',
  },
  {
    id: 'smoke-b',
    label: 'Smoke B (cool) · z 3.5–9.0',
    color: '#22d3ee',
    description: 'Cool uniform medium crossing the same slice at z=5. Overlaps A in depth where both plumes cover a pixel.',
  },
  {
    id: 'slice',
    label: 'Red slice · z=5',
    color: '#ef4444',
    description: 'Thin premultiplied surface sample inside both media. It splits each smoke segment into a near and a far span.',
  },
];

export interface SceneConfig {
  width: number;
  height: number;
  zMin: number;
  zMax: number;
  smokeA: { zNear: number; zFar: number };
  smokeB: { zNear: number; zFar: number };
  sliceZ: number;
  plateZ: number;
}

export const DEFAULT_SCENE: SceneConfig = {
  width: 224,
  height: 140,
  zMin: 0,
  zMax: 10,
  smokeA: { zNear: 2.5, zFar: 7.5 },
  smokeB: { zNear: 3.5, zFar: 9.0 },
  sliceZ: 5,
  plateZ: 0.8,
};

export interface SmokeCoefficients {
  extinction: Rgb;
  emission: Rgb;
}

export interface SceneField {
  plate: { coverage: number; color: Rgb } | null;
  smokeA: SmokeCoefficients | null;
  smokeB: SmokeCoefficients | null;
  slice: { coverage: number; color: Rgb } | null;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function gauss(x: number, y: number, cx: number, cy: number, sx: number, sy: number): number {
  const dx = (x - cx) / sx;
  const dy = (y - cy) / sy;
  return Math.exp(-0.5 * (dx * dx + dy * dy));
}

/** Hard support cutoff so regions outside the plumes are genuinely empty. */
function support(d: number, threshold: number): number {
  if (d <= threshold) return 0;
  return (d - threshold) / (1 - threshold);
}

/**
 * Analytic scene field in normalized pixel coordinates. The same field drives
 * both the sample generator and the independent ray-marching reference.
 *
 * Plumes are spatially separated so most pixels contain at most one smoke
 * segment, while both plumes cross the slice plane z=5. Regions outside the
 * supports are empty: their chains contain no medium and no surface.
 */
export function sceneField(u: number, v: number): SceneField {
  const plateCov = clamp01(gauss(u, v, 0.2, 0.5, 0.1, 0.17) * 1.8) * 0.96;
  const plate = plateCov > 1e-4 ? { coverage: plateCov, color: { r: 0.1, g: 0.32, b: 0.95 } } : null;

  const bandCenter = 0.5 + 0.06 * Math.sin(v * 6.1) + 0.022 * Math.cos(v * 13.0);
  const band = smoothstep(0.075, 0.015, Math.abs(u - bandCenter));
  const ribbons = 0.6 + 0.4 * Math.pow(Math.max(0, Math.sin(v * 26 + u * 9)), 1.4);
  const sliceCov = clamp01(band * ribbons * 0.95);
  const slice =
    sliceCov > 1e-4 ? { coverage: sliceCov, color: { r: 0.93, g: 0.03, b: 0.018 } } : null;

  const plumeA =
    0.95 * gauss(u, v, 0.3 + 0.045 * Math.sin(v * 3.4), 0.52, 0.135, 0.3) *
    (0.72 + 0.28 * Math.sin(v * 18 + u * 5));
  const plumeB =
    0.92 * gauss(u, v, 0.7 - 0.04 * Math.cos(v * 2.7), 0.5, 0.14, 0.28) *
    (0.7 + 0.3 * Math.sin(v * 15 + 1.7));
  const densityA = support(clamp01(plumeA), 0.05);
  const densityB = support(clamp01(plumeB), 0.05);

  const smokeA =
    densityA > 0
      ? {
          extinction: { r: 0.5 * densityA, g: 0.44 * densityA, b: 0.36 * densityA },
          emission: { r: 0.1 * densityA, g: 0.062 * densityA, b: 0.03 * densityA },
        }
      : null;
  const smokeB =
    densityB > 0
      ? {
          extinction: { r: 0.34 * densityB, g: 0.42 * densityB, b: 0.56 * densityB },
          emission: { r: 0.02 * densityB, g: 0.04 * densityB, b: 0.095 * densityB },
        }
      : null;

  return { plate, smokeA, smokeB, slice };
}

export function sceneFieldAtPixel(x: number, y: number, cfg: SceneConfig = DEFAULT_SCENE): SceneField {
  const u = (x + 0.5) / cfg.width;
  const v = (y + 0.5) / cfg.height;
  return sceneField(u, v);
}

export function premultipliedSurface(color: Rgb, coverage: number): Rgba {
  const a = clamp01(coverage);
  return { r: color.r * a, g: color.g * a, b: color.b * a, a };
}

/** Build the exact, segmented sample chain for one pixel. */
export function segmentedChainForPixel(
  x: number,
  y: number,
  cfg: SceneConfig = DEFAULT_SCENE,
): SampleChain {
  const field = sceneFieldAtPixel(x, y, cfg);
  const samples: Sample[] = [];

  if (field.plate) {
    const point: PointSample = {
      kind: 'point',
      id: 'plate',
      layer: 'plate',
      z: cfg.plateZ,
      color: premultipliedSurface(field.plate.color, field.plate.coverage),
      provenance: 'segmented',
    };
    samples.push(point);
  }
  if (field.smokeA) {
    const interval: IntervalSample = {
      kind: 'interval',
      id: 'smoke-a',
      layer: 'smoke-a',
      zNear: cfg.smokeA.zNear,
      zFar: cfg.smokeA.zFar,
      extinction: { ...field.smokeA.extinction },
      emission: { ...field.smokeA.emission },
      provenance: 'segmented',
    };
    samples.push(interval);
  }
  if (field.smokeB) {
    const interval: IntervalSample = {
      kind: 'interval',
      id: 'smoke-b',
      layer: 'smoke-b',
      zNear: cfg.smokeB.zNear,
      zFar: cfg.smokeB.zFar,
      extinction: { ...field.smokeB.extinction },
      emission: { ...field.smokeB.emission },
      provenance: 'segmented',
    };
    samples.push(interval);
  }
  if (field.slice) {
    const point: PointSample = {
      kind: 'point',
      id: 'slice',
      layer: 'slice',
      z: cfg.sliceZ,
      color: premultipliedSurface(field.slice.color, field.slice.coverage),
      provenance: 'segmented',
    };
    samples.push(point);
  }
  return { samples };
}

/**
 * How a whole homogeneous segment appears if integrated by itself: emitted
 * premultiplied radiance plus a scalar coverage. This is exactly the limited
 * information an old asset preserves. It is lossy: per-channel extinction is
 * collapsed to a scalar coverage, and nothing records the distribution of the
 * contribution inside the span.
 */
export function wholeSegmentAccumulation(
  coeff: SmokeCoefficients,
  zNear: number,
  zFar: number,
): Rgba {
  const len = zFar - zNear;
  const channel = (sigma: number, e: number) => {
    const tau = sigma * len;
    if (tau > 1e-12) return (e * len * (1 - Math.exp(-tau))) / tau;
    return e * len;
  };
  const r = channel(coeff.extinction.r, coeff.emission.r);
  const g = channel(coeff.extinction.g, coeff.emission.g);
  const b = channel(coeff.extinction.b, coeff.emission.b);
  const meanSigma = (coeff.extinction.r + coeff.extinction.g + coeff.extinction.b) / 3;
  const alpha = 1 - Math.exp(-meanSigma * len);
  return { r, g, b, a: clamp01(alpha) };
}

/** Build the legacy, whole-segment asset for one pixel. */
export function legacyChainForPixel(
  x: number,
  y: number,
  cfg: SceneConfig = DEFAULT_SCENE,
): SampleChain {
  const field = sceneFieldAtPixel(x, y, cfg);
  const samples: Sample[] = [];

  if (field.plate) {
    samples.push({
      kind: 'point',
      id: 'plate',
      layer: 'plate',
      z: cfg.plateZ,
      color: premultipliedSurface(field.plate.color, field.plate.coverage),
      provenance: 'segmented',
    } satisfies PointSample);
  }
  if (field.smokeA) {
    samples.push({
      kind: 'legacy-segment',
      id: 'smoke-a',
      layer: 'smoke-a',
      zNear: cfg.smokeA.zNear,
      zFar: cfg.smokeA.zFar,
      accumulated: wholeSegmentAccumulation(field.smokeA, cfg.smokeA.zNear, cfg.smokeA.zFar),
      provenance: 'legacy-accumulated',
    } satisfies LegacySegmentSample);
  }
  if (field.smokeB) {
    samples.push({
      kind: 'legacy-segment',
      id: 'smoke-b',
      layer: 'smoke-b',
      zNear: cfg.smokeB.zNear,
      zFar: cfg.smokeB.zFar,
      accumulated: wholeSegmentAccumulation(field.smokeB, cfg.smokeB.zNear, cfg.smokeB.zFar),
      provenance: 'legacy-accumulated',
    } satisfies LegacySegmentSample);
  }
  if (field.slice) {
    samples.push({
      kind: 'point',
      id: 'slice',
      layer: 'slice',
      z: cfg.sliceZ,
      color: premultipliedSurface(field.slice.color, field.slice.coverage),
      provenance: 'segmented',
    } satisfies PointSample);
  }
  return { samples };
}

export function buildSceneChains(cfg: SceneConfig, kind: 'segmented' | 'legacy'): SampleChain[] {
  const chains: SampleChain[] = new Array(cfg.width * cfg.height);
  for (let y = 0; y < cfg.height; y++) {
    for (let x = 0; x < cfg.width; x++) {
      chains[y * cfg.width + x] =
        kind === 'segmented' ? segmentedChainForPixel(x, y, cfg) : legacyChainForPixel(x, y, cfg);
    }
  }
  return chains;
}
