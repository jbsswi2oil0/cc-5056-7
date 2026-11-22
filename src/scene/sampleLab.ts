import type { IntervalSample, PointSample, Rgb, Sample, SampleChain } from '../core/types';
import { integrateChainDetailed } from '../core/compositor';
import { deriveMergeContract } from '../core/ordering';
import { probeChainConventions } from '../core/convention';
import { rearMatteExperiment, middleMatteProof, type MatteConfig } from '../verify/matte';
import { checkSampleSemantics } from '../verify/semantics';

/**
 * Sample lab: a small, self-contained generator that builds deterministic
 * multi-layer sample chains and integrates them independently of the image
 * pipeline. Every number printed by the CLI comes from running the compositor
 * on the generated samples — nothing here is a hand-typed expected value, and a
 * mean depth is never offered as a substitute for the layered data.
 */

export interface LabLayer {
  id: string;
  kind: 'point' | 'interval';
  z?: number;
  zNear?: number;
  zFar?: number;
  color?: { r: number; g: number; b: number; a: number };
  extinction?: Rgb;
  emission?: Rgb;
  colorConvention?: 'premultiplied' | 'straight';
}

let sequence = 0;

export function labPoint(id: string, z: number, color: PointSample['color'], convention: 'premultiplied' | 'straight' = 'premultiplied'): PointSample {
  sequence++;
  return {
    kind: 'point',
    id,
    z,
    color,
    ...(convention === 'straight' ? { colorConvention: 'straight' as const } : {}),
  };
}

export function labInterval(
  id: string,
  zNear: number,
  zFar: number,
  extinction: Rgb,
  emission: Rgb,
): IntervalSample {
  sequence++;
  return { kind: 'interval', id, zNear, zFar, extinction, emission };
}

/** Build a chain from layer specs; ids are unique per lab run. */
export function buildLabChain(layers: LabLayer[]): SampleChain {
  const samples: Sample[] = layers.map((layer) => {
    if (layer.kind === 'point') {
      if (layer.z === undefined || !layer.color) throw new Error(`point layer ${layer.id} needs z and color`);
      return labPoint(layer.id, layer.z, layer.color, layer.colorConvention);
    }
    if (layer.zNear === undefined || layer.zFar === undefined || !layer.extinction || !layer.emission) {
      throw new Error(`interval layer ${layer.id} needs bounds and coefficients`);
    }
    return labInterval(layer.id, layer.zNear, layer.zFar, layer.extinction, layer.emission);
  });
  return { samples };
}

export interface LabContribution {
  index: number;
  kind: string;
  depth: string;
  sourceIds: string[];
  emitted: Rgb;
  transmittanceAfter: Rgb;
  merged: boolean;
  overlap: boolean;
}

export interface LabReport {
  chain: SampleChain;
  contributions: LabContribution[];
  radiance: Rgb;
  transmittance: Rgb;
  exact: boolean;
  contract: ReturnType<typeof deriveMergeContract>;
  probes: ReturnType<typeof probeChainConventions>;
  semantics: ReturnType<typeof checkSampleSemantics>;
}

/** Integrate one generated chain and collect its per-event contributions. */
export function runLabChain(chain: SampleChain): LabReport {
  const detailed = integrateChainDetailed(chain, { collectEvents: true });
  const contributions: LabContribution[] = detailed.events.map((ev, index) => ({
    index,
    kind: ev.kind,
    depth: ev.kind === 'medium' ? `[${ev.z0}, ${ev.z1})` : String(ev.z0),
    sourceIds: ev.sourceIds,
    emitted: { r: ev.emitted.r, g: ev.emitted.g, b: ev.emitted.b },
    transmittanceAfter: { ...ev.transmittanceAfter },
    merged: ev.merged,
    overlap: ev.overlap,
  }));
  return {
    chain,
    contributions,
    radiance: { ...detailed.result.radiance },
    transmittance: { ...detailed.result.transmittance },
    exact: detailed.result.report.exact,
    contract: deriveMergeContract(chain),
    probes: probeChainConventions(chain),
    semantics: checkSampleSemantics(chain),
  };
}

/**
 * A fixed, fully code-generated demonstration: two overlapping media, an
 * interior hard edge, and a foreground plate. The returned numbers are produced
 * by the integrator, so the documentation can quote them verbatim.
 */
export function demonstrationScene(): {
  base: LabReport;
  matte: Awaited<ReturnType<typeof rearMatteExperiment>>;
  blackEdge: LabReport;
} {
  const chain = buildLabChain([
    {
      id: 'plate',
      kind: 'point',
      z: 0.8,
      color: { r: 0.08, g: 0.256, b: 0.76, a: 0.8 },
    },
    {
      id: 'haze-a',
      kind: 'interval',
      zNear: 2.5,
      zFar: 7.5,
      extinction: { r: 0.5, g: 0.44, b: 0.36 },
      emission: { r: 0.1, g: 0.062, b: 0.03 },
    },
    {
      id: 'haze-b',
      kind: 'interval',
      zNear: 3.5,
      zFar: 9,
      extinction: { r: 0.34, g: 0.42, b: 0.56 },
      emission: { r: 0.02, g: 0.04, b: 0.095 },
    },
    {
      id: 'slice',
      kind: 'point',
      z: 5,
      color: { r: 0.837, g: 0.027, b: 0.0162, a: 0.9 },
    },
  ]);

  const base = runLabChain(chain);

  // Strict middle-matte proof. On empty black the single semi-transparent white
  // surface and the black-edge-plus-brightened-white pair accumulate the same
  // radiance (the black edge adds nothing and the paired white is brightened to
  // compensate its keep factor). They keep different transmittance; a rear
  // white backdrop multiplies by that difference and separates the two results.
  const proof = middleMatteProof(2, 5, 0.5, 0.3);
  const backdrop: MatteConfig = { z: 0, color: { r: 1, g: 1, b: 1 }, id: 'rear-matte' };
  const matteResult = rearMatteExperiment(proof.reference, proof.withEdge, backdrop);
  const blackEdge = runLabChain(proof.withEdge);

  return { base, matte: matteResult, blackEdge };
}
