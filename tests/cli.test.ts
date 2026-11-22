import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { PNG } from 'pngjs';

const run = promisify(execFile);
const ROOT = resolve(__dirname, '..');
const CLI = join(ROOT, 'cli', 'depth-composite.ts');

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run('npx', ['tsx', CLI, ...args], { cwd: ROOT });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('CLI helper', () => {
  it('generates both the segmented and legacy assets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dc-'));
    try {
      const seg = await cli(['gen-scene', '--kind', 'segmented', '--output', join(dir, 'seg.dsc')]);
      expect(seg.code).toBe(0);
      const legacy = await cli(['gen-scene', '--kind', 'legacy', '--output', join(dir, 'legacy.dsc')]);
      expect(legacy.code).toBe(0);
      const segBytes = await readFile(join(dir, 'seg.dsc'));
      const legacyBytes = await readFile(join(dir, 'legacy.dsc'));
      expect(segBytes.length).toBeGreaterThan(1000);
      expect(legacyBytes.length).toBeGreaterThan(1000);
      expect(Buffer.compare(segBytes, legacyBytes)).not.toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('composes a segmented asset and writes a valid PNG', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dc-'));
    try {
      await cli(['gen-scene', '--kind', 'segmented', '--output', join(dir, 'seg.dsc')]);
      const out = await cli(['compose', '--input', join(dir, 'seg.dsc'), '--output', join(dir, 'seg.png')]);
      expect(out.code).toBe(0);
      expect(out.stdout).toContain('approximatePixels=0');
      const png = PNG.sync.read(await readFile(join(dir, 'seg.png')));
      expect(png.width).toBe(224);
      expect(png.height).toBe(140);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses exact export of a legacy asset with an interior event (exit 2)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dc-'));
    try {
      await cli(['gen-scene', '--kind', 'legacy', '--output', join(dir, 'legacy.dsc')]);
      const out = await cli(['compose', '--input', join(dir, 'legacy.dsc'), '--output', join(dir, 'legacy.png')]);
      expect(out.code).toBe(2);
      expect(out.stderr).toContain('interior depth event');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('composes a marked approximate preview only when asked (exit 0)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dc-'));
    try {
      await cli(['gen-scene', '--kind', 'legacy', '--output', join(dir, 'legacy.dsc')]);
      const out = await cli([
        'compose',
        '--input',
        join(dir, 'legacy.dsc'),
        '--output',
        join(dir, 'legacy-approx.png'),
        '--allow-approximate-legacy',
      ]);
      expect(out.code).toBe(0);
      const match = /approximatePixels=(\d+)/.exec(out.stdout);
      expect(match).not.toBeNull();
      expect(Number(match![1])).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('verifies the segmented asset against the reference (exit 0)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dc-'));
    try {
      await cli(['gen-scene', '--kind', 'segmented', '--output', join(dir, 'seg.dsc')]);
      const out = await cli(['verify', '--input', join(dir, 'seg.dsc'), '--json']);
      expect(out.code).toBe(0);
      const report = JSON.parse(out.stdout);
      expect(report.maxRadiance).toBeLessThan(2e-3);
      expect(report.energyOk).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('inspect reports sample kinds and layer counts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dc-'));
    try {
      await cli(['gen-scene', '--kind', 'segmented', '--output', join(dir, 'seg.dsc')]);
      const out = await cli(['inspect', '--input', join(dir, 'seg.dsc')]);
      expect(out.code).toBe(0);
      const report = JSON.parse(out.stdout);
      expect(report.kinds.interval).toBeGreaterThan(0);
      expect(report.layerSampleCounts['smoke-a']).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
