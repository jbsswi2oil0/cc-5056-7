import type { CompositeOptions, Rgb, Sample, SampleChain, TiePolicy } from '../core/types';
import { DEFAULT_TOLERANCE } from '../core/sample';
import { composeChains, countApproximatePixels, type LinearImage } from './compose';
import { buildSceneChains, DEFAULT_SCENE, SCENE_LAYERS, type SceneConfig } from '../scene/scene';
import { encodeDsc, decodeDsc, type DscDocument } from '../io/dsc';
import { renderReferenceImage } from '../scene/reference';
import { compareImages, checkEnergy, type ImageDifference } from '../verify/metrics';

export type AssetKind = 'segmented' | 'legacy';
export type ViewMode = 'color' | 'transmittance' | 'coverage' | 'exactness';

export interface SceneMeta {
  name: string;
  kind: AssetKind;
  /** True when this asset was produced by the app's own generator. */
  generated: boolean;
  source: string;
  layers: { id: string; label: string; color: number }[];
}

export interface AppState {
  width: number;
  height: number;
  chains: SampleChain[];
  meta: SceneMeta;
  /** Raw encoded bytes for the loaded asset, if any. */
  bytes: Uint8Array | null;
}

export interface ComposeRequest {
  chains: SampleChain[];
  width: number;
  height: number;
  tiePolicy: TiePolicy;
  allowApproximateLegacy: boolean;
  tolerance: number;
}

export interface ComposeOutcome {
  image: LinearImage;
  approximatePixels: number;
  difference: ImageDifference | null;
  energyOk: boolean;
  error: string | null;
  errorCode: string | null;
  exact: boolean;
  /** Per-issue-code counts aggregated across every pixel's integration report. */
  issueCounts: Record<string, number>;
  /** True when at least one pixel reported a non-mergeable same-depth range. */
  nonMergeableTies: number;
  /** Surface samples converted from straight color at read time. */
  straightConverted: number;
  /** Pixels whose chain mixed premultiplied and straight color. */
  mixedConventionPixels: number;
}

export function layerMeta() {
  return SCENE_LAYERS.map((l) => ({
    id: l.id,
    label: l.label,
    color: parseInt(l.color.slice(1), 16),
  }));
}

export function makeGeneratedState(kind: AssetKind, cfg: SceneConfig = DEFAULT_SCENE): AppState {
  const chains = buildSceneChains(cfg, kind);
  return {
    width: cfg.width,
    height: cfg.height,
    chains,
    meta: {
      name: kind === 'segmented' ? 'Segmented smoke + red slice' : 'Legacy whole-segment smoke',
      kind,
      generated: true,
      source: 'generated in-app',
      layers: layerMeta(),
    },
    bytes: null,
  };
}

export async function encodeState(state: AppState, compress = true): Promise<Uint8Array> {
  return encodeDsc(
    { width: state.width, height: state.height, layers: state.meta.layers, chains: state.chains },
    compress,
  );
}

export async function decodeToState(bytes: Uint8Array): Promise<AppState> {
  const doc: DscDocument = await decodeDsc(bytes);
  return {
    width: doc.width,
    height: doc.height,
    chains: doc.chains,
    meta: {
      name: 'Loaded depth asset',
      kind: detectKind(doc),
      generated: false,
      source: doc.compressed ? 'loaded compressed DSC1' : 'loaded DSC1',
      layers: doc.layers,
    },
    bytes,
  };
}

function detectKind(doc: DscDocument): AssetKind {
  for (const chain of doc.chains) {
    if (chain.samples.some((s) => s.kind === 'legacy-segment')) return 'legacy';
  }
  return 'segmented';
}

export interface LayerVisibility {
  plate: boolean;
  'smoke-a': boolean;
  'smoke-b': boolean;
  slice: boolean;
}

export function filterChainsByLayers(
  chains: SampleChain[],
  visibility: LayerVisibility,
): SampleChain[] {
  return chains.map((chain) => ({
    samples: chain.samples.filter((s) => {
      if (!s.layer) return true;
      const key = s.layer as keyof LayerVisibility;
      return visibility[key] !== false;
    }),
  }));
}

export interface ComposeRunOptions {
  visibility: LayerVisibility;
  tiePolicy: TiePolicy;
  allowApproximateLegacy: boolean;
  tolerance?: number;
  referenceEnabled: boolean;
}

/**
 * Compose a state with the real integrator. Layer visibility is applied first,
 * then the exact compositor runs. The returned image is the single object the
 * canvas, statistics panel, and PNG export all consume.
 */
export function runCompose(state: AppState, opts: ComposeRunOptions): ComposeOutcome {
  const filtered = filterChainsByLayers(state.chains, opts.visibility);
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;
  let image: LinearImage;
  try {
    image = composeChains(filtered, state.width, state.height, {
      tiePolicy: opts.tiePolicy,
      allowApproximateLegacy: opts.allowApproximateLegacy,
      tolerance,
    });
  } catch (err) {
    return {
      image: emptyImage(state.width, state.height),
      approximatePixels: 0,
      difference: null,
      energyOk: true,
      error: (err as Error).message,
      errorCode: (err as { code?: string }).code ?? null,
      exact: false,
      issueCounts: {},
      nonMergeableTies: 0,
      straightConverted: 0,
      mixedConventionPixels: 0,
    };
  }
  const approximatePixels = countApproximatePixels(image);
  const energy = checkEnergy(image);
  const issueCounts: Record<string, number> = {};
  let nonMergeableTies = 0;
  let straightConverted = 0;
  let mixedConventionPixels = 0;
  for (const report of image.reports) {
    if (report.nonMergeableTies > 0) nonMergeableTies += report.nonMergeableTies;
    if (report.straightConverted > 0) straightConverted += report.straightConverted;
    if (report.mixedConvention) mixedConventionPixels += 1;
    for (const issue of report.issues) {
      issueCounts[issue.code] = (issueCounts[issue.code] ?? 0) + 1;
    }
  }
  let difference: ImageDifference | null = null;
  if (
    opts.referenceEnabled &&
    state.width === DEFAULT_SCENE.width &&
    state.height === DEFAULT_SCENE.height &&
    opts.tiePolicy === 'stable-order'
  ) {
    const reference = renderReferenceImage(DEFAULT_SCENE);
    difference = compareImages(image, reference);
  }
  return {
    image,
    approximatePixels,
    difference,
    energyOk: energy.ok,
    error: null,
    errorCode: null,
    exact: approximatePixels === 0,
    issueCounts,
    nonMergeableTies,
    straightConverted,
    mixedConventionPixels,
  };
}

function emptyImage(width: number, height: number): LinearImage {
  const n = width * height;
  const radiance: Rgb[] = new Array(n).fill(null).map(() => ({ r: 0, g: 0, b: 0 }));
  const transmittance: Rgb[] = new Array(n).fill(null).map(() => ({ r: 1, g: 1, b: 1 }));
  return {
    width,
    height,
    radiance,
    transmittance,
    exact: new Array(n).fill(false),
    approximate: new Array(n).fill(false),
    reports: [],
  };
}

/** Options for the in-process pixel evaluator, mirroring the canvas compose. */
export function pixelOptions(tiePolicy: TiePolicy, allowApproximate: boolean): CompositeOptions {
  return { tiePolicy, allowApproximateLegacy: allowApproximate, collectEvents: true };
}

export interface SupplementReport {
  /** Layer ids that were supplied with segmented samples. */
  supplied: string[];
  /** Legacy samples that could not be matched and remain unresolved. */
  unresolved: string[];
  /** True when no legacy samples remain after the merge. */
  complete: boolean;
}

/**
 * Supply segmented samples for a legacy asset. For each pixel, every
 * legacy-segment sample whose layer has matching interval samples in the
 * supplied asset is replaced by those samples. This is a genuine data
 * replacement, not an approximation: after it, exact composition and exact
 * export become possible.
 *
 * The two assets must share dimensions; layers are matched by id so a legacy
 * "smoke-a" is replaced only by segmented "smoke-a" samples.
 */
export function supplementLegacy(
  legacy: AppState,
  segmented: AppState,
): { state: AppState; report: SupplementReport } {
  if (legacy.width !== segmented.width || legacy.height !== segmented.height) {
    throw new Error(
      `cannot merge assets of different sizes: ${legacy.width}x${legacy.height} vs ${segmented.width}x${segmented.height}`,
    );
  }
  const supplied = new Set<string>();
  const unresolved = new Set<string>();
  const chains: SampleChain[] = new Array(legacy.chains.length);
  for (let i = 0; i < legacy.chains.length; i++) {
    const legacySamples = legacy.chains[i].samples;
    const segmentedSamples = segmented.chains[i].samples;
    const byLayer = new Map<string, Sample[]>();
    for (const s of segmentedSamples) {
      if (s.kind === 'interval' && s.layer) {
        const list = byLayer.get(s.layer) ?? [];
        list.push(s);
        byLayer.set(s.layer, list);
      }
    }
    const merged: Sample[] = [];
    for (const s of legacySamples) {
      if (s.kind !== 'legacy-segment') {
        merged.push(s);
        continue;
      }
      const layer = s.layer;
      const replacement = layer ? byLayer.get(layer) : undefined;
      if (layer && replacement && replacement.length > 0) {
        merged.push(...replacement);
        supplied.add(layer);
      } else {
        merged.push(s);
        unresolved.add(s.id);
      }
    }
    chains[i] = { samples: merged };
  }
  const state: AppState = {
    width: legacy.width,
    height: legacy.height,
    chains,
    meta: {
      ...legacy.meta,
      name: `${legacy.meta.name} (supplemented)`,
      kind: unresolved.size === 0 ? 'segmented' : 'legacy',
      source: 'legacy asset supplemented with segmented samples',
    },
    bytes: null,
  };
  return {
    state,
    report: {
      supplied: [...supplied].sort(),
      unresolved: [...unresolved].sort(),
      complete: unresolved.size === 0,
    },
  };
}
