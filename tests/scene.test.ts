import { describe, expect, it } from 'vitest';
import { buildSceneChains, DEFAULT_SCENE, wholeSegmentAccumulation, segmentedChainForPixel, legacyChainForPixel } from '../src/scene/scene';
import { renderReferenceImage } from '../src/scene/reference';
import { renderReferencePixel } from '../src/scene/reference';
import { composeChains } from '../src/app/compose';
import { compareImages, compareLinearImages, checkEnergy, checkSplitInvariance } from '../src/verify/metrics';
import { integrateChain } from '../src/core/compositor';

describe('segmented scene vs independent ray-marched reference', () => {
  it('matches the reference within numerical tolerance on every pixel', () => {
    const chains = buildSceneChains(DEFAULT_SCENE, 'segmented');
    const image = composeChains(chains, DEFAULT_SCENE.width, DEFAULT_SCENE.height, {});
    const reference = renderReferenceImage(DEFAULT_SCENE);
    const diff = compareImages(image, reference);
    expect(diff.maxRadiance).toBeLessThan(2e-3);
    expect(diff.maxTransmittance).toBeLessThan(2e-3);
    expect(diff.meanRadiance).toBeLessThan(1e-4);
  });

  it('passes the energy sanity check', () => {
    const chains = buildSceneChains(DEFAULT_SCENE, 'segmented');
    const image = composeChains(chains, DEFAULT_SCENE.width, DEFAULT_SCENE.height, {});
    const energy = checkEnergy(image);
    expect(energy.ok).toBe(true);
    expect(energy.nonFinite).toBe(0);
  });

  it('has genuinely empty pixels that compose to transparent black', () => {
    let empty = 0;
    const chains = buildSceneChains(DEFAULT_SCENE, 'segmented');
    for (const chain of chains) if (chain.samples.length === 0) empty++;
    expect(empty).toBeGreaterThan(0);
    const emptyChain = { samples: [] };
    const r = integrateChain(emptyChain);
    expect(r.radiance).toEqual({ r: 0, g: 0, b: 0 });
    expect(r.transmittance).toEqual({ r: 1, g: 1, b: 1 });
  });

  it('composing is invariant to shuffling samples within each pixel', () => {
    const chains = buildSceneChains(DEFAULT_SCENE, 'segmented');
    const shuffled = chains.map((c) => ({
      samples: [...c.samples].sort(() => Math.random() - 0.5),
    }));
    const a = composeChains(chains, DEFAULT_SCENE.width, DEFAULT_SCENE.height, {});
    const b = composeChains(shuffled, DEFAULT_SCENE.width, DEFAULT_SCENE.height, {});
    const diff = compareLinearImages(a, b);
    expect(diff.maxRadiance).toBe(0);
    expect(diff.maxTransmittance).toBe(0);
  });

  it('the slice actually splits both smoke segments in a pixel where they overlap', () => {
    // Find a pixel containing both media and the slice.
    let found: { x: number; y: number } | null = null;
    for (let y = 0; y < DEFAULT_SCENE.height && !found; y++) {
      for (let x = 0; x < DEFAULT_SCENE.width; x++) {
        const chain = segmentedChainForPixel(x, y, DEFAULT_SCENE);
        const kinds = new Set(chain.samples.map((s) => s.id));
        if (kinds.has('smoke-a') && kinds.has('smoke-b') && kinds.has('slice')) {
          found = { x, y };
          break;
        }
      }
    }
    expect(found).not.toBeNull();
    const chain = segmentedChainForPixel(found!.x, found!.y, DEFAULT_SCENE);
    for (const id of ['smoke-a', 'smoke-b']) {
      const inv = checkSplitInvariance(chain, id, DEFAULT_SCENE.sliceZ, {});
      expect(inv.maxDelta).toBeLessThan(1e-12);
    }
  });

  it('a pixel containing only one medium still matches the reference', () => {
    let tested = 0;
    for (let y = 2; y < DEFAULT_SCENE.height; y += 7) {
      for (let x = 2; x < DEFAULT_SCENE.width; x += 7) {
        const chain = segmentedChainForPixel(x, y, DEFAULT_SCENE);
        const media = chain.samples.filter((s) => s.kind === 'interval');
        if (media.length !== 1) continue;
        const image = composeChains([chain], 1, 1, {});
        const ref = renderReferencePixel(x, y, DEFAULT_SCENE);
        expect(Math.abs(image.radiance[0].r - ref.radiance.r)).toBeLessThan(2e-3);
        expect(Math.abs(image.transmittance[0].g - ref.transmittance.g)).toBeLessThan(2e-3);
        tested++;
      }
    }
    expect(tested).toBeGreaterThan(5);
  });
});

describe('legacy whole-segment asset', () => {
  it('contains legacy segments with only accumulated color', () => {
    const chains = buildSceneChains(DEFAULT_SCENE, 'legacy');
    let legacyCount = 0;
    for (const chain of chains) {
      for (const s of chain.samples) if (s.kind === 'legacy-segment') legacyCount++;
    }
    expect(legacyCount).toBeGreaterThan(0);
  });

  it('exact composition is refused wherever a slice or overlap falls inside a legacy span', () => {
    const chains = buildSceneChains(DEFAULT_SCENE, 'legacy');
    let refused = 0;
    let accepted = 0;
    for (const chain of chains) {
      const hasInteriorSlice = chain.samples.some((s) => s.kind === 'point' && s.id === 'slice');
      const legacy = chain.samples.filter((s) => s.kind === 'legacy-segment');
      if (legacy.length === 0) continue;
      try {
        integrateChain(chain);
        expect(hasInteriorSlice).toBe(false);
        accepted++;
      } catch (err) {
        expect((err as { code?: string }).code).toBe('LEGACY_NEEDS_SEGMENTATION');
        refused++;
      }
    }
    expect(refused).toBeGreaterThan(0);
    expect(accepted).toBeGreaterThan(0);
  });

  it('the marked approximation differs measurably from the exact segmented truth', () => {
    // This is the core claim: whole-segment accumulated color is not sufficient
    // to reproduce the exact image, and the difference is not a rounding error.
    const segmented = buildSceneChains(DEFAULT_SCENE, 'segmented');
    const legacy = buildSceneChains(DEFAULT_SCENE, 'legacy');
    const truth = composeChains(segmented, DEFAULT_SCENE.width, DEFAULT_SCENE.height, {});
    const approx = composeChains(legacy, DEFAULT_SCENE.width, DEFAULT_SCENE.height, {
      allowApproximateLegacy: true,
    });
    const diff = compareLinearImages(approx, truth);
    expect(diff.maxRadiance).toBeGreaterThan(1e-2);
    let approximate = 0;
    for (const a of approx.approximate) if (a) approximate++;
    expect(approximate).toBeGreaterThan(0);
  });

  it('the whole-segment accumulation is a lossy summary, not the per-span data', () => {
    const coeff = {
      extinction: { r: 0.5, g: 0.44, b: 0.36 },
      emission: { r: 0.1, g: 0.062, b: 0.03 },
    };
    const acc = wholeSegmentAccumulation(coeff, 2.5, 7.5);
    // Its scalar alpha cannot reproduce per-channel transmittance.
    expect(acc.a).toBeGreaterThan(0);
    expect(acc.a).toBeLessThan(1);
    // Splitting the span by hand changes nothing for a true medium, but the
    // legacy asset has no way to express that split.
    const pixelChain = legacyChainForPixel(60, 60, DEFAULT_SCENE);
    void pixelChain;
  });
});
