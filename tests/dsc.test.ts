import { describe, expect, it } from 'vitest';
import { chainStatistics, decodeDsc, encodeDsc, type DscDocument } from '../src/io/dsc';
import type { SampleChain } from '../src/core/types';
import { buildSceneChains, DEFAULT_SCENE, SCENE_LAYERS } from '../src/scene/scene';
import { integrateChain } from '../src/core/compositor';

const layers = SCENE_LAYERS.map((l) => ({ id: l.id, label: l.label, color: parseInt(l.color.slice(1), 16) }));

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function sampleDoc(chains: SampleChain[], width: number, height: number): Omit<DscDocument, 'compressed'> {
  return { width, height, layers, chains };
}

describe('DSC1 round-trip', () => {
  it('round-trips compressed scene data preserving composited pixels', async () => {
    const chains = buildSceneChains(DEFAULT_SCENE, 'segmented');
    const encoded = await encodeDsc(sampleDoc(chains, DEFAULT_SCENE.width, DEFAULT_SCENE.height), true);
    const decoded = await decodeDsc(encoded);
    expect(decoded.compressed).toBe(true);
    expect(decoded.width).toBe(DEFAULT_SCENE.width);
    expect(decoded.height).toBe(DEFAULT_SCENE.height);
    expect(decoded.layers.map((l) => l.id)).toEqual(layers.map((l) => l.id));
    let maxDelta = 0;
    for (let i = 0; i < chains.length; i++) {
      const a = integrateChain(chains[i]);
      const b = integrateChain(decoded.chains[i]);
      maxDelta = Math.max(
        maxDelta,
        Math.abs(a.radiance.r - b.radiance.r),
        Math.abs(a.radiance.g - b.radiance.g),
        Math.abs(a.radiance.b - b.radiance.b),
      );
    }
    // Float32 storage is expected to perturb values only at float precision.
    expect(maxDelta).toBeLessThan(1e-6);
  });

  it('round-trips uncompressed data identically', async () => {
    const chains = buildSceneChains(DEFAULT_SCENE, 'legacy');
    const encoded = await encodeDsc(sampleDoc(chains, DEFAULT_SCENE.width, DEFAULT_SCENE.height), false);
    const decoded = await decodeDsc(encoded);
    expect(decoded.compressed).toBe(false);
    const stats = chainStatistics(decoded);
    expect(stats.kinds['legacy-segment']).toBeGreaterThan(0);
  });

  it('preserves legacy vs segmented distinction through encode/decode', async () => {
    const segChains = buildSceneChains(DEFAULT_SCENE, 'segmented');
    const legacyChains = buildSceneChains(DEFAULT_SCENE, 'legacy');
    const segDoc = await decodeDsc(await encodeDsc(sampleDoc(segChains, DEFAULT_SCENE.width, DEFAULT_SCENE.height), true));
    const legacyDoc = await decodeDsc(await encodeDsc(sampleDoc(legacyChains, DEFAULT_SCENE.width, DEFAULT_SCENE.height), true));
    const segKinds = chainStatistics(segDoc).kinds;
    const legacyKinds = chainStatistics(legacyDoc).kinds;
    expect(segKinds['interval']).toBeGreaterThan(0);
    expect(segKinds['legacy-segment']).toBe(0);
    expect(legacyKinds['legacy-segment']).toBeGreaterThan(0);
    // The two assets must not collapse to the same file content.
    expect(segKinds).not.toEqual(legacyKinds);
  });

  it('is deterministic: same document encodes to identical bytes', async () => {
    const chains = buildSceneChains(DEFAULT_SCENE, 'segmented').slice(0, 64);
    const doc = sampleDoc(chains, 8, 8);
    const a = await encodeDsc(doc, true);
    const b = await encodeDsc(doc, true);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('rejects non-DSC data', async () => {
    await expect(decodeDsc(bytes(1, 2, 3, 4, 5, 6, 7, 8))).rejects.toThrow(/not a DSC1 file/);
  });

  it('rejects a truncated file', async () => {
    const chains = buildSceneChains(DEFAULT_SCENE, 'segmented').slice(0, 4);
    const encoded = await encodeDsc(sampleDoc(chains, 2, 2), false);
    await expect(decodeDsc(encoded.subarray(0, encoded.length - 3))).rejects.toThrow();
  });

  it('reports empty pixels in statistics', async () => {
    const empty: SampleChain = { samples: [] };
    const filled: SampleChain = {
      samples: [{ kind: 'point', id: 'p', z: 1, color: { r: 0.5, g: 0.5, b: 0.5, a: 0.5 } }],
    };
    const doc = await decodeDsc(await encodeDsc(sampleDoc([empty, filled, empty, filled], 2, 2), true));
    const stats = chainStatistics(doc);
    expect(stats.emptyPixels).toBe(2);
    expect(stats.samples).toBe(2);
  });
});
