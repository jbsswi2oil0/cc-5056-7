/**
 * Core data model for depth-sample compositing.
 *
 * A pixel is an unordered set of depth samples. A point sample carries
 * premultiplied color and coverage at one depth; an interval sample describes a
 * homogeneous medium with per-unit extinction and emission coefficients.
 * Composition is exact over the real depth axis: the compositor sorts every
 * depth event, splits overlapping media into disjoint spans, splits media at
 * point depths, integrates each span in closed form, and applies surface
 * samples in between. No layer is reduced to a single nearest depth.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Rgba extends Rgb {
  a: number;
}

export type LayerId = string;

export interface PointSample {
  kind: 'point';
  /** Stable identity; canonical ordering tie-breaker and diagnostics. */
  id: string;
  layer?: LayerId;
  /** Depth in scene units. Must be finite. */
  z: number;
  /** Premultiplied linear color; the alpha channel is coverage. */
  color: Rgba;
  /** Provenance for assets that originate outside this app. */
  provenance?: 'segmented' | 'supplemented' | 'derived' | 'legacy';
}

export interface IntervalSample {
  kind: 'interval';
  id: string;
  layer?: LayerId;
  /** Inclusive near depth. */
  zNear: number;
  /** Exclusive far depth. */
  zFar: number;
  /** Per-unit extinctance coefficient, linear, >= 0. */
  extinction: Rgb;
  /** Per-unit emitted radiance, linear, >= 0. */
  emission: Rgb;
  provenance?: 'segmented' | 'supplemented';
}

/**
 * An old-style asset records only the total accumulated premultiplied color of
 * a whole segment. It cannot be split at an interior surface without
 * additional samples.
 */
export interface LegacySegmentSample {
  kind: 'legacy-segment';
  id: string;
  layer?: LayerId;
  zNear: number;
  zFar: number;
  /** Whole-segment accumulated premultiplied color. */
  accumulated: Rgba;
  provenance: 'legacy-accumulated';
}

export type Sample = PointSample | IntervalSample | LegacySegmentSample;

export interface SampleChain {
  samples: Sample[];
}

export type TiePolicy = 'stable-order' | 'exchangeable-merge';
export type MergePolicy = TiePolicy;

export interface CompositeOptions {
  /** Depth tolerance for tie grouping and boundary merging. Default 1e-7. */
  tolerance?: number;
  /** Coincident-depth combination policy. Default `stable-order`. */
  tiePolicy?: TiePolicy;
  /**
   * Permit a clearly marked approximate preview for legacy segments with
   * interior events. Default false: integrateChain throws SampleError.
   */
  allowApproximateLegacy?: boolean;
  /** Collect the ordered event chain for inspection. Default false. */
  collectEvents?: boolean;
}

export type SampleIssueCode =
  | 'non-finite'
  | 'empty-interval'
  | 'zero-coverage'
  | 'unknown-kind'
  | 'duplicate-id'
  | 'sanitized'
  | 'legacy-needs-segmentation'
  | 'legacy-approximate'
  | 'legacy-exact'
  | 'overlap'
  | 'tie'
  | 'large-tie-group';

export interface SampleIssue {
  code: SampleIssueCode;
  message: string;
  sampleIds?: string[];
  count?: number;
}

export interface SampleSource {
  id: string;
  layer?: LayerId;
  /** Per-unit coefficients for the span, before combining. */
  extinction: Rgb;
  emission: Rgb;
}

export interface ChainEvent {
  kind: 'medium' | 'point' | 'legacy';
  /** Footprint: [z0, z1) for medium, [z, z] otherwise. */
  z0: number;
  z1: number;
  sourceIds: string[];
  layers: LayerId[];
  /** Multiple coincident samples were merged under the tie policy. */
  merged: boolean;
  /** Multiple media coexisted on this span and were summed. */
  overlap: boolean;
  approximate: boolean;
  /** Integrated emitted radiance from this event (premultiplied). */
  emitted: Rgba;
  /** Integrated optical depth over this event. */
  extinctance: Rgb;
  /** Combined per-unit coefficients for a medium span. */
  extinction?: Rgb;
  emission?: Rgb;
  /** Per-source coefficients for a medium span. */
  sources?: SampleSource[];
  /** Combined premultiplied color applied by a point/legacy event. */
  color?: Rgba;
  /** State before and after applying this event. */
  transmittanceBefore: Rgb;
  radianceBefore: Rgb;
  transmittanceAfter: Rgb;
  radianceAfter: Rgb;
}

export interface IntegrationReport {
  coveredSpan: number;
  overlapSpan: number;
  /** Number of medium spans integrated. */
  pieces: number;
  /** Number of point samples committed (including merged groups). */
  points: number;
  /** Number of legacy segments handled (exact or approximate). */
  legacySegments: number;
  dropped: number;
  nonFinite: number;
  /** Number of coincident-depth groups with more than one sample. */
  ties: number;
  issues: SampleIssue[];
  /** True if the result is exact for the given asset. */
  exact: boolean;
  approximateSamples: string[];
}

export interface CompositeResult {
  /** Premultiplied accumulated radiance over transparent black. */
  rgba: Rgba;
  radiance: Rgb;
  /** Per-channel transmittance after all samples. */
  transmittance: Rgb;
  /** Coverage: 1 - mean(transmittance), a display/compositing scalar. */
  coverage: number;
  report: IntegrationReport;
}

export interface ImageSize {
  width: number;
  height: number;
}

export class SampleError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'SampleError';
  }
}

export const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };
export const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
export const WHITE: Rgba = { r: 1, g: 1, b: 1, a: 1 };
export const CLEAR_TRANSMITTANCE: Rgb = { r: 1, g: 1, b: 1 };
export const ZERO_RGB: Rgb = { r: 0, g: 0, b: 0 };
