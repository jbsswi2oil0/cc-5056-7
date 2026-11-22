import type { IntegrationReport, Rgb, SampleChain, TiePolicy } from '../core/types';
import { integrateChainDetailed } from '../core/compositor';

export interface LinearImage {
  width: number;
  height: number;
  radiance: Rgb[];
  transmittance: Rgb[];
  exact: boolean[];
  approximate: boolean[];
  /** Per-pixel integration report, retained for anomaly aggregation. */
  reports: IntegrationReport[];
}

export interface PixelBudget {
  maxSamples: number;
  maxPieces: number;
}

export interface ComposeProgress {
  rowsDone: number;
  rowsTotal: number;
}

export interface ComposeOptions {
  /** Emit a progress event every N rows. */
  progressEvery?: number;
  onProgress?: (p: ComposeProgress) => void;
  /** Throw when a pixel exceeds a sample budget instead of composing it. */
  budget?: PixelBudget;
  /** Coincident-depth policy forwarded to the integrator. */
  tiePolicy?: TiePolicy;
  /** Permit marked approximate previews for legacy segments. */
  allowApproximateLegacy?: boolean;
  /** Depth tolerance forwarded to the integrator. */
  tolerance?: number;
  /** Surface color convention policy forwarded to the integrator. */
  colorPolicy?: 'convert-at-read' | 'reject';
}

/**
 * Compose a list of per-pixel sample chains. This is the only function the UI,
 * CLI, and exporters use to turn chains into pixels, so displayed, exported,
 * and verified results all share one code path.
 */
export function composeChains(
  chains: SampleChain[],
  width: number,
  height: number,
  options: ComposeOptions = {},
): LinearImage {
  if (chains.length !== width * height) {
    throw new Error(`expected ${width * height} chains, received ${chains.length}`);
  }
  const radiance: Rgb[] = new Array(chains.length);
  const transmittance: Rgb[] = new Array(chains.length);
  const exact: boolean[] = new Array(chains.length);
  const approximate: boolean[] = new Array(chains.length);
  const reports: IntegrationReport[] = new Array(chains.length);
  const every = options.progressEvery ?? Math.max(1, Math.floor(height / 20));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const chain = chains[i];
      if (options.budget && chain.samples.length > options.budget.maxSamples) {
        throw new Error(
          `pixel ${x},${y} has ${chain.samples.length} samples, over the ${options.budget.maxSamples} budget`,
        );
      }
      const { result } = integrateChainDetailed(chain, {
        collectEvents: false,
        tiePolicy: options.tiePolicy,
        allowApproximateLegacy: options.allowApproximateLegacy,
        tolerance: options.tolerance,
        colorPolicy: options.colorPolicy,
      });
      radiance[i] = result.radiance;
      transmittance[i] = result.transmittance;
      exact[i] = result.report.exact;
      approximate[i] = !result.report.exact;
      reports[i] = result.report;
    }
    if (options.onProgress && ((y + 1) % every === 0 || y + 1 === height)) {
      options.onProgress({ rowsDone: y + 1, rowsTotal: height });
    }
  }
  return { width, height, radiance, transmittance, exact, approximate, reports };
}

export function countApproximatePixels(image: LinearImage): number {
  let n = 0;
  for (const a of image.approximate) if (a) n++;
  return n;
}
