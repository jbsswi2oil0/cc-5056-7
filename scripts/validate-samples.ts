#!/usr/bin/env node
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeDsc, decodeDsc } from '../src/io/dsc';
import { buildSceneChains, DEFAULT_SCENE, SCENE_LAYERS } from '../src/scene/scene';
import { composeChains } from '../src/app/compose';
import { checkImageSemantics } from '../src/verify/semantics';
import { checkEnergy } from '../src/verify/metrics';
import { demonstrationScene } from '../src/scene/sampleLab';
import { SampleError } from '../src/core/types';

/**
 * Clean-directory depth-sample validation entry point.
 *
 * Everything is generated into a fresh temp directory and derived from code —
 * there are no hand-edited fixtures and no reliance on pre-existing files. The
 * script fails loudly (non-zero exit) on any contract violation rather than
 * substituting a default value, so a misread sample can never be masked.
 */

const layers = SCENE_LAYERS.map((l) => ({
  id: l.id,
  label: l.label,
  color: parseInt(l.color.slice(1), 16),
}));

interface Step {
  name: string;
  ok: boolean;
  detail: string;
}

function step(name: string, ok: boolean, detail: string): Step {
  if (!ok) console.error(`  FAIL ${name}: ${detail}`);
  else console.log(`  ok   ${name}: ${detail}`);
  return { name, ok, detail };
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dc-validate-'));
  const steps: Step[] = [];
  try {
    console.log(`validation workspace: ${dir}`);

    // 1. Generate both assets fresh and round-trip them through the container.
    const segmented = buildSceneChains(DEFAULT_SCENE, 'segmented');
    const legacy = buildSceneChains(DEFAULT_SCENE, 'legacy');
    const segPath = join(dir, 'segmented.dsc');
    await writeFile(
      segPath,
      await encodeDsc({ width: DEFAULT_SCENE.width, height: DEFAULT_SCENE.height, layers, chains: segmented }),
    );
    const reloaded = await decodeDsc(await readFile(segPath));

    // 2. Executable semantics over every generated pixel.
    const segSemantics = checkImageSemantics(reloaded.chains);
    steps.push(
      step('segmented semantics', segSemantics.ok, `${segSemantics.pixelFailures.length} failing pixels`),
    );

    // 3. Integration actually runs end-to-end and stays physical.
    const image = composeChains(reloaded.chains, DEFAULT_SCENE.width, DEFAULT_SCENE.height, {});
    const energy = checkEnergy(image);
    steps.push(step('energy', energy.ok && energy.nonFinite === 0, `nonFinite=${energy.nonFinite}`));

    // 4. Legacy asset still runs through its documented refusal path.
    let legacyRefused = false;
    try {
      composeChains(legacy, DEFAULT_SCENE.width, DEFAULT_SCENE.height, {});
    } catch (err) {
      legacyRefused = (err as SampleError).code === 'LEGACY_NEEDS_SEGMENTATION';
    }
    steps.push(step('legacy refusal', legacyRefused, 'interior-event legacy segments are refused exactly'));

    // 5. Lab demonstration: multi-layer samples integrated independently, with
    //    the middle-matte separation proof and per-event contributions.
    const demo = demonstrationScene();
    steps.push(
      step(
        'lab semantics',
        demo.base.semantics.ok,
        `events=${demo.base.contributions.length} nonMergeable=${demo.base.semantics.nonMergeableRanges}`,
      ),
    );
    steps.push(
      step(
        'middle-matte separation',
        demo.matte.equivalentOnEmpty && demo.matte.separates,
        `equivalentOnEmpty=${demo.matte.equivalentOnEmpty} separates=${demo.matte.separates}`,
      ),
    );

    const failed = steps.filter((s) => !s.ok);
    console.log(`\n${steps.length - failed.length}/${steps.length} checks passed`);
    if (failed.length > 0) process.exit(3);
    console.log('depth sample validation passed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
