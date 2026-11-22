import type { Rgb, Rgba, SampleChain } from '../core/types';
import { integrateChain } from '../core/compositor';

/**
 * Middle-matte separation experiment.
 *
 * On an empty (black) backdrop the final pixel radiance is just the accumulated
 * premultiplied radiance; two chains can agree on that number while retaining
 * different per-channel transmittance. Inserting a matte — an opaque surface
 * placed at a chosen depth — multiplies everything behind it by the surviving
 * transmittance, which is exactly the term the empty backdrop hides. The
 * experiment reports where two chains that were equal on an empty background
 * separate once a matte is present.
 */

export interface MatteConfig {
  /** Depth at which the opaque matte is inserted. */
  z: number;
  /** Opaque straight color of the matte. */
  color: Rgb;
  /** Sample id used for the injected matte. */
  id?: string;
}

export function matteSample(matte: MatteConfig): SampleChain['samples'][number] {
  // A MatteConfig carries straight color; encode coverage as the color's
  // magnitude so callers can build translucent mattes, then premultiply.
  const coverage = Math.max(matte.color.r, matte.color.g, matte.color.b);
  const color: Rgba = {
    r: matte.color.r,
    g: matte.color.g,
    b: matte.color.b,
    a: coverage,
  };
  return {
    kind: 'point',
    id: matte.id ?? 'middle-matte',
    z: matte.z,
    color,
    colorConvention: 'premultiplied',
  };
}

export interface SeparationResult {
  /** Per-channel radiance difference on the empty backdrop. */
  emptyDelta: Rgb;
  /** True when the two chains are equivalent (within eps) on empty black. */
  equivalentOnEmpty: boolean;
  /** Per-channel radiance difference after the matte is inserted. */
  matteDelta: Rgb;
  /** True when inserting the matte separates previously equivalent chains. */
  separates: boolean;
  /** Transmittance gap that the matte exposed. */
  transmittanceDelta: Rgb;
}

function diff3(a: Rgb, b: Rgb): Rgb {
  return { r: Math.abs(a.r - b.r), g: Math.abs(a.g - b.g), b: Math.abs(a.b - b.b) };
}

function max3(v: Rgb): number {
  return Math.max(v.r, v.g, v.b);
}

/**
 * Compare two chains before and after inserting the same matte. The matte is
 * placed at `matte.z` in both chains, so any new difference comes from the
 * transmittance the two chains carry into that depth, not from the matte
 * itself.
 */
export function separationExperiment(
  a: SampleChain,
  b: SampleChain,
  matte: MatteConfig,
  eps = 1e-12,
  options: Parameters<typeof integrateChain>[1] = {},
): SeparationResult {
  const emptyA = integrateChain(a, options);
  const emptyB = integrateChain(b, options);
  const emptyDelta = diff3(emptyA.radiance, emptyB.radiance);

  const withMatte = (chain: SampleChain): SampleChain => ({
    samples: [...chain.samples, matteSample(matte)],
  });
  const matteA = integrateChain(withMatte(a), options);
  const matteB = integrateChain(withMatte(b), options);
  const matteDelta = diff3(matteA.radiance, matteB.radiance);
  const transmittanceDelta = diff3(matteA.transmittance, matteB.transmittance);

  const equivalentOnEmpty = max3(emptyDelta) <= eps;
  return {
    emptyDelta,
    equivalentOnEmpty,
    matteDelta,
    separates: equivalentOnEmpty && max3(matteDelta) > eps,
    transmittanceDelta,
  };
}

/**
 * Rear-matte variant for chains that already contain an opaque surface. An
 * opaque surface closes transmittance in front of it, so a matte inserted among
 * the events cannot expose anything behind that surface; placing the matte
 * *behind* every event (like lighting a backdrop) instead reveals the
 * transmittance each chain leaves open. Two chains can match on empty black
 * while keeping different open transmittance, and the rear matte multiplies the
 * backdrop by exactly that difference.
 */
export function rearMatteExperiment(
  a: SampleChain,
  b: SampleChain,
  backdrop: MatteConfig,
  eps = 1e-12,
  options: Parameters<typeof integrateChain>[1] = {},
): SeparationResult {
  const emptyA = integrateChain(a, options);
  const emptyB = integrateChain(b, options);
  const emptyDelta = diff3(emptyA.radiance, emptyB.radiance);

  // Depth beyond every sample so the backdrop is integrated last.
  const farZ = 1e6;
  const withBackdrop = (chain: SampleChain): SampleChain => ({
    samples: [...chain.samples, matteSample({ ...backdrop, z: farZ, id: 'rear-matte' })],
  });
  const matteA = integrateChain(withBackdrop(a), options);
  const matteB = integrateChain(withBackdrop(b), options);
  const matteDelta = diff3(matteA.radiance, matteB.radiance);
  const transmittanceDelta = diff3(emptyA.transmittance, emptyB.transmittance);

  const equivalentOnEmpty = max3(emptyDelta) <= eps;
  return {
    emptyDelta,
    equivalentOnEmpty,
    matteDelta,
    separates: equivalentOnEmpty && max3(matteDelta) > eps,
    transmittanceDelta,
  };
}

/**
 * A black semi-transparent hard edge contributes zero radiance on a black
 * backdrop regardless of coverage, so its presence is invisible there. The
 * matte reveals it by showing the radiance it blocks. This is the canonical
 * "equivalent on empty, separated by a matte" construction.
 */
export function invisibleOnBlackEdge(chain: SampleChain, z: number, coverage: number): SampleChain {
  return {
    samples: [
      ...chain.samples,
      {
        kind: 'point',
        id: 'black-edge',
        z,
        color: { r: 0, g: 0, b: 0, a: coverage },
      },
    ],
  };
}

/**
 * The strict middle-matte construction. Two chains produce the identical
 * accumulated radiance on an empty black backdrop yet carry different
 * transmittance:
 *
 *   reference : [white surface W at z=w, coverage aW]
 *   withEdge  : [black edge B at z=b, coverage aB] then [the same W at z=w]
 *
 * The black edge adds zero radiance and only scales the white contribution that
 * follows it. Choosing aW' = aW / (1 - aB) for the with-edge surface (clamped
 * to 1) makes the accumulated white radiance equal in both chains, while the
 * open transmittance differs: reference keeps (1 - aW), the edge chain keeps
 * (1 - aB)(1 - aW'). On empty black that surviving transmittance multiplies a
 * zero backdrop and is invisible. A rear backdrop multiplies by it, so the two
 * chains separate only once a matte/backdrop exists — the term an empty
 * backdrop cannot express.
 */
export function middleMatteProof(
  zEdge: number,
  zWhite: number,
  edgeCoverage: number,
  pairedCoverage = 0.5,
): {
  reference: SampleChain;
  withEdge: SampleChain;
  whiteSurface: MatteConfig;
} {
  const keep = 1 - edgeCoverage;
  // Equal accumulated white radiance: reference coverage a0 = keep * a1. The
  // paired surface stays translucent (a1 < 1) so the edge chain retains open
  // transmittance while the reference closes more of it.
  const referenceCoverage = keep * pairedCoverage;
  if (!(pairedCoverage > 0 && pairedCoverage < 1)) {
    throw new Error(`middleMatteProof: pairedCoverage must be in (0,1), got ${pairedCoverage}`);
  }
  const whiteSurface: MatteConfig = {
    z: zWhite,
    color: { r: referenceCoverage, g: referenceCoverage, b: referenceCoverage },
    id: 'white-surface',
  };
  const reference: SampleChain = { samples: [matteSample(whiteSurface)] };
  // The with-edge white surface coverage a1 satisfies keep * a1 = a0, so its
  // attenuated contribution equals the reference while it closes less
  // transmittance, leaving the two chains distinguishable only via a backdrop.
  const withEdge: SampleChain = {
    samples: [
      { kind: 'point', id: 'black-edge', z: zEdge, color: { r: 0, g: 0, b: 0, a: edgeCoverage } },
      matteSample({
        z: zWhite,
        color: { r: pairedCoverage, g: pairedCoverage, b: pairedCoverage },
        id: 'white-surface',
      }),
    ],
  };
  return { reference, withEdge, whiteSurface };
}
