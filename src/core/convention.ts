import type { ColorConvention, Rgb, Rgba, Sample, SampleChain } from './types';
import { SampleError } from './types';
import { clamp01 } from './sample';

/**
 * Color-convention boundary.
 *
 * The integrator only ever consumes premultiplied linear color: its over
 * operator and its transmittance bookkeeping assume rgb already includes
 * coverage. Straight (unassociated) color is therefore a reader-level concern
 * that is resolved once, at read time, rather than threaded through every
 * integration node.
 */

export function premultiplyStraight(color: Rgba): Rgba {
  const a = clamp01(color.a);
  return { r: color.r * a, g: color.g * a, b: color.b * a, a };
}

export function conventionOf(sample: Sample): ColorConvention {
  if (sample.kind === 'interval') return 'premultiplied';
  return sample.colorConvention ?? 'premultiplied';
}

function surfaceSamples(chain: SampleChain): Sample[] {
  return chain.samples.filter((s) => s.kind === 'point' || s.kind === 'legacy-segment');
}

/**
 * A chain mixes conventions when its surface samples do not all agree. Interval
 * samples carry no alpha convention and are ignored. Mixing is an isolation
 * failure, not a sanitization: blending a straight sample as though it were
 * premultiplied darkens it, and premultiplying an already-premultiplied sample
 * double-darkens it. Either way the error is invisible in an energy check, so
 * the chain is rejected with the offending ids.
 */
export function findMixedConvention(chain: SampleChain): { mixed: boolean; ids: string[] } {
  const seen = new Set<ColorConvention>();
  const ids: string[] = [];
  for (const s of surfaceSamples(chain)) {
    const c = conventionOf(s);
    if (!seen.has(c)) {
      seen.add(c);
      ids.push(s.id);
    }
  }
  return { mixed: seen.size > 1, ids };
}

export interface ConvertedSample<T extends Sample = Sample> {
  sample: T;
  converted: boolean;
}

/**
 * Resolve every surface sample in a chain to premultiplied color.
 *
 * 'convert-at-read' premultiplies straight samples in one place and tags the
 * result so the compositor can count and report the conversion. 'reject'
 * throws on the first straight sample, leaving conversion to a caller that
 * implements it at a different integration node. A mixed-convention chain is
 * rejected under either policy.
 */
export function resolveConvention<T extends Sample>(
  sample: T,
  policy: 'convert-at-read' | 'reject',
): ConvertedSample<T> {
  if (sample.kind === 'interval') return { sample, converted: false };
  const convention = conventionOf(sample);
  if (convention === 'premultiplied') return { sample, converted: false };
  if (policy === 'reject') {
    throw new SampleError(
      `sample "${sample.id}" carries straight color but the reader is configured to reject conversion`,
      'STRAIGHT_COLOR_NOT_ISOLATED',
      { sampleIds: [sample.id] },
    );
  }
  if (sample.kind === 'point') {
    return {
      sample: { ...sample, color: premultiplyStraight(sample.color), colorConvention: 'premultiplied' },
      converted: true,
    };
  }
  return {
    sample: {
      ...sample,
      accumulated: premultiplyStraight(sample.accumulated),
      colorConvention: 'premultiplied',
    },
    converted: true,
  };
}

/**
 * Double-layer transmittance probe.
 *
 * Given a surface sample's coverage `a`, the transmittance a ray keeps through
 * it is `1 - a`. The probe computes the kept transmittance through the same
 * surface interpreted under both conventions. For a premultiplied sample the
 * stored alpha is already coverage, so both layers agree:
 *
 *   T_premul = 1 - a
 *
 * For a straight sample the rgb channels are unassociated, and a reader that
 * mistakes it for premultiplied color also misreads coverage by treating the
 * color magnitude as part of the surface opacity. The diagnostic surfaces the
 * gap so the position of a misread sample can be located in the ordered chain.
 */
export interface TransmittanceProbe {
  id: string;
  convention: ColorConvention;
  coverage: number;
  /** Transmittance kept when the sample is read under its declared convention. */
  declared: Rgb;
  /** Transmittance a mistaken premultiplied reading would produce. */
  misread: Rgb;
  /** Per-channel gap; zero exactly when the sample cannot be misread. */
  gap: Rgb;
}

export function transmittanceProbe(sample: Sample): TransmittanceProbe | null {
  if (sample.kind === 'interval') return null;
  const convention = conventionOf(sample);
  const color = sample.kind === 'point' ? sample.color : sample.accumulated;
  const coverage = clamp01(color.a);
  const declared: Rgb = {
    r: 1 - coverage,
    g: 1 - coverage,
    b: 1 - coverage,
  };
  if (convention === 'premultiplied') {
    return { id: sample.id, convention, coverage, declared, misread: { ...declared }, gap: { r: 0, g: 0, b: 0 } };
  }
  // Straight color misread as premultiplied: the reader takes max(rgb) as an
  // extra coverage term and clamps it. This is the specific failure mode the
  // probe is designed to expose, not a general color transform.
  const bogusCoverage = clamp01(Math.max(color.r, color.g, color.b, coverage));
  const misread: Rgb = {
    r: 1 - bogusCoverage,
    g: 1 - bogusCoverage,
    b: 1 - bogusCoverage,
  };
  const gap: Rgb = {
    r: Math.abs(declared.r - misread.r),
    g: Math.abs(declared.g - misread.g),
    b: Math.abs(declared.b - misread.b),
  };
  return { id: sample.id, convention, coverage, declared, misread, gap };
}

/** Run the probe across a chain, preserving depth order for localization. */
export function probeChainConventions(chain: SampleChain): TransmittanceProbe[] {
  const out: TransmittanceProbe[] = [];
  for (const s of chain.samples) {
    const probe = transmittanceProbe(s);
    if (probe) out.push(probe);
  }
  return out;
}
