import { describe, expect, it } from 'vitest';
import { makeGeneratedState, runCompose, supplementLegacy, decodeToState, encodeState, type LayerVisibility } from '../src/app/state';
import { compareLinearImages } from '../src/verify/metrics';
import { DEFAULT_SCENE } from '../src/scene/scene';
import { decodeDsc, encodeDsc } from '../src/io/dsc';

const all: LayerVisibility = { plate: true, 'smoke-a': true, 'smoke-b': true, slice: true };

const baseRun = {
  visibility: all,
  tiePolicy: 'stable-order' as const,
  allowApproximateLegacy: false,
  referenceEnabled: false,
};

describe('supplying segmented samples for a legacy asset', () => {
  it('refuses exact composition before supplementation', () => {
    const legacy = makeGeneratedState('legacy');
    const outcome = runCompose(legacy, baseRun);
    expect(outcome.error).not.toBeNull();
    expect(outcome.errorCode).toBe('LEGACY_NEEDS_SEGMENTATION');
  });

  it('restores an exact result that matches the original segmented truth', () => {
    const legacy = makeGeneratedState('legacy');
    const segmented = makeGeneratedState('segmented');
    const { state, report } = supplementLegacy(legacy, segmented);
    expect(report.complete).toBe(true);
    expect(report.supplied.sort()).toEqual(['smoke-a', 'smoke-b']);
    const outcome = runCompose(state, baseRun);
    expect(outcome.error).toBeNull();
    expect(outcome.exact).toBe(true);
    expect(outcome.approximatePixels).toBe(0);
    // It must reproduce the true segmented image, not merely an approximate one.
    const truth = runCompose(segmented, baseRun);
    const diff = compareLinearImages(outcome.image, truth.image);
    expect(diff.maxRadiance).toBe(0);
    expect(diff.maxTransmittance).toBe(0);
  });

  it('leaves unresolved legacy samples when the supplied asset lacks a layer', () => {
    const legacy = makeGeneratedState('legacy');
    const segmented = makeGeneratedState('segmented');
    // Remove all smoke-b intervals from the supplied asset.
    const partial = {
      ...segmented,
      chains: segmented.chains.map((c) => ({
        samples: c.samples.filter((s) => s.layer !== 'smoke-b'),
      })),
    };
    const { state, report } = supplementLegacy(legacy, partial);
    expect(report.complete).toBe(false);
    expect(report.unresolved).toContain('smoke-b');
    expect(state.meta.kind).toBe('legacy');
    // Still refused exactly, because smoke-b remains a legacy segment.
    const outcome = runCompose(state, baseRun);
    expect(outcome.errorCode).toBe('LEGACY_NEEDS_SEGMENTATION');
  });

  it('rejects assets of different dimensions', () => {
    const legacy = makeGeneratedState('legacy');
    const segmented = makeGeneratedState('segmented');
    const smaller = { ...segmented, width: segmented.width - 1 };
    expect(() => supplementLegacy(legacy, smaller)).toThrow(/different sizes/);
  });

  it('a supplemented asset survives a save/load round-trip as an exact asset', async () => {
    const legacy = makeGeneratedState('legacy');
    const segmented = makeGeneratedState('segmented');
    const { state } = supplementLegacy(legacy, segmented);
    const bytes = await encodeState(state);
    const doc = await decodeDsc(bytes);
    // No legacy samples remain, and it decodes as segmented.
    for (const chain of doc.chains) {
      expect(chain.samples.some((s) => s.kind === 'legacy-segment')).toBe(false);
    }
    const reloaded = await decodeToState(bytes);
    expect(reloaded.meta.kind).toBe('segmented');
    const outcome = runCompose(reloaded, baseRun);
    expect(outcome.exact).toBe(true);
    expect(outcome.approximatePixels).toBe(0);
    void DEFAULT_SCENE;
    void encodeDsc;
  });
});
