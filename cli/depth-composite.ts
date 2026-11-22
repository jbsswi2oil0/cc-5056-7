#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Rgb, SampleChain } from '../src/core/types';
import { parseHexColor } from '../src/core/color';
import { decodeDsc, encodeDsc, chainStatistics } from '../src/io/dsc';
import { composeChains } from '../src/app/compose';
import { buildSceneChains, DEFAULT_SCENE, SCENE_LAYERS } from '../src/scene/scene';
import { renderReferenceImage } from '../src/scene/reference';
import { compareImages, checkEnergy } from '../src/verify/metrics';
import { checkImageSemantics } from '../src/verify/semantics';
import { imageToPng, type ViewMode } from './png';

const USAGE = `depth-composite — command-line helper for the depth compositing canvas

The primary interface is the browser canvas (npm run dev). This CLI mirrors the
same compositor and I/O for scripted checks and asset generation.

Usage:
  depth-composite compose --input <file.dsc> --output <file.png> [options]
  depth-composite gen-scene --kind segmented|legacy --output <file.dsc>
  depth-composite verify --input <file.dsc> --reference scene [--json]
  depth-composite semantics --input <file.dsc> [--json]
  depth-composite inspect --input <file.dsc>

Options for compose:
  --view color|transmittance|coverage|exactness   (default color)
  --background #rrggbb                            (default #0b1020)
  --tie stable-order|exchangeable-merge           (default stable-order)
  --color-policy convert-at-read|reject           (default convert-at-read)
  --allow-approximate-legacy                      (mark approximate previews)
  --no-compress                                   (write uncompressed DSC)

Exit codes: 0 success, 1 usage/IO error, 2 compositing error (e.g. legacy
segments need segmentation, or mixed color conventions), 3 verification failed.`;

function fail(message: string, code = 1): never {
  console.error(`error: ${message}`);
  process.exit(code);
}

function parseBackground(hex: string | undefined): Rgb {
  const c = parseHexColor(hex ?? '#0b1020');
  if (!c) fail(`invalid background color "${hex}"`);
  return c;
}

function parseView(v: string | undefined): ViewMode {
  const view = (v ?? 'color') as ViewMode;
  if (!['color', 'transmittance', 'coverage', 'exactness'].includes(view)) {
    fail(`invalid view "${v}"`);
  }
  return view;
}

async function loadChains(path: string): Promise<{ chains: SampleChain[]; width: number; height: number }> {
  const buf = new Uint8Array(await readFile(resolve(path)));
  const doc = await decodeDsc(buf);
  return { chains: doc.chains, width: doc.width, height: doc.height };
}

async function cmdCompose(args: ReturnType<typeof parseArgs>['values']): Promise<void> {
  const input = args.input as string | undefined;
  const output = args.output as string | undefined;
  if (!input || !output) fail('compose requires --input and --output');
  const { chains, width, height } = await loadChains(input);
  const background = parseBackground(args.background as string | undefined);
  const view = parseView(args.view as string | undefined);
  const tiePolicy = (args.tie as string | undefined) ?? 'stable-order';
  if (tiePolicy !== 'stable-order' && tiePolicy !== 'exchangeable-merge') {
    fail(`invalid --tie "${tiePolicy}"`);
  }
  const colorPolicy = (args['color-policy'] as string | undefined) ?? 'convert-at-read';
  if (colorPolicy !== 'convert-at-read' && colorPolicy !== 'reject') {
    fail(`invalid --color-policy "${colorPolicy}"`);
  }
  let image;
  try {
    image = composeChains(chains, width, height, {
      tiePolicy,
      allowApproximateLegacy: Boolean(args['allow-approximate-legacy']),
      colorPolicy,
    });
  } catch (err) {
    fail((err as Error).message, 2);
  }
  const energy = checkEnergy(image);
  const png = imageToPng(image, { view, background });
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(resolve(output), png);
  let approximate = 0;
  for (const a of image.approximate) if (a) approximate++;
  console.log(
    `composed ${width}x${height} -> ${output} [${view}] approximatePixels=${approximate} energyOk=${energy.ok}`,
  );
  if (!energy.ok) fail('energy check failed (non-finite or out-of-range output)', 3);
}

async function cmdGenScene(args: ReturnType<typeof parseArgs>['values']): Promise<void> {
  const kind = (args.kind as string | undefined) ?? 'segmented';
  if (kind !== 'segmented' && kind !== 'legacy') fail(`invalid --kind "${kind}"`);
  const output = (args.output as string | undefined) ?? `out/scene-${kind}.dsc`;
  const chains = buildSceneChains(DEFAULT_SCENE, kind);
  const layers = SCENE_LAYERS.map((l) => ({
    id: l.id,
    label: l.label,
    color: parseInt(l.color.slice(1), 16),
  }));
  const encoded = await encodeDsc(
    { width: DEFAULT_SCENE.width, height: DEFAULT_SCENE.height, layers, chains },
    !args['no-compress'],
  );
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(resolve(output), encoded);
  const stats = chainStatistics({ width: DEFAULT_SCENE.width, height: DEFAULT_SCENE.height, layers, chains, compressed: true });
  console.log(
    `wrote ${output} (${encoded.length} bytes) kind=${kind} pixels=${stats.pixels} samples=${stats.samples} empty=${stats.emptyPixels}`,
  );
}

async function cmdVerify(args: ReturnType<typeof parseArgs>['values']): Promise<void> {
  const input = args.input as string | undefined;
  if (!input) fail('verify requires --input');
  const { chains, width, height } = await loadChains(input);
  if (width !== DEFAULT_SCENE.width || height !== DEFAULT_SCENE.height) {
    fail(
      `reference scene is ${DEFAULT_SCENE.width}x${DEFAULT_SCENE.height}; input is ${width}x${height}`,
    );
  }
  let image;
  try {
    image = composeChains(chains, width, height, {});
  } catch (err) {
    fail((err as Error).message, 2);
  }
  const reference = renderReferenceImage(DEFAULT_SCENE);
  const diff = compareImages(image, reference);
  const energy = checkEnergy(image);
  const result = {
    maxRadiance: diff.maxRadiance,
    meanRadiance: diff.meanRadiance,
    maxTransmittance: diff.maxTransmittance,
    meanTransmittance: diff.meanTransmittance,
    worstPixel: diff.worstPixel,
    energyOk: energy.ok,
  };
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `reference compare: maxRadiance=${diff.maxRadiance.toExponential(3)} meanRadiance=${diff.meanRadiance.toExponential(3)} maxTransmittance=${diff.maxTransmittance.toExponential(3)} energyOk=${energy.ok}`,
    );
    console.log('verification passed');
  }
  const tolerance = 2e-3;
  if (diff.maxRadiance > tolerance || diff.maxTransmittance > tolerance || !energy.ok) {
    fail('verification failed', 3);
  }
}

async function cmdInspect(args: ReturnType<typeof parseArgs>['values']): Promise<void> {
  const input = args.input as string | undefined;
  if (!input) fail('inspect requires --input');
  const buf = new Uint8Array(await readFile(resolve(input)));
  const doc = await decodeDsc(buf);
  const stats = chainStatistics(doc);
  const { layers: layerCounts, ...rest } = stats;
  console.log(
    JSON.stringify(
      {
        width: doc.width,
        height: doc.height,
        compressed: doc.compressed,
        layers: doc.layers,
        ...rest,
        layerSampleCounts: layerCounts,
      },
      null,
      2,
    ),
  );
}

async function cmdSemantics(args: ReturnType<typeof parseArgs>['values']): Promise<void> {
  const input = args.input as string | undefined;
  if (!input) fail('semantics requires --input');
  const { chains } = await loadChains(input);
  const summary = checkImageSemantics(chains);
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          ok: summary.ok,
          pixels: chains.length,
          failedPixels: summary.pixelFailures.slice(0, 20).map((f) => ({
            index: f.index,
            violations: f.report.violations.map((v) => v.code),
          })),
          failureCount: summary.pixelFailures.length,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `semantics: ${summary.ok ? 'ok' : 'FAILED'} (${summary.pixelFailures.length} of ${chains.length} pixels violate the contract)`,
    );
    for (const f of summary.pixelFailures.slice(0, 10)) {
      for (const v of f.report.violations) {
        console.log(`  pixel ${f.index}: ${v.code} — ${v.message}`);
      }
    }
  }
  if (!summary.ok) fail('sample semantics check failed', 3);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      input: { type: 'string', short: 'i' },
      output: { type: 'string', short: 'o' },
      kind: { type: 'string', short: 'k' },
      view: { type: 'string' },
      background: { type: 'string' },
      tie: { type: 'string' },
      'color-policy': { type: 'string' },
      'allow-approximate-legacy': { type: 'boolean' },
      'no-compress': { type: 'boolean' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
  });
  switch (command) {
    case 'compose':
      await cmdCompose(values);
      break;
    case 'gen-scene':
      await cmdGenScene(values);
      break;
    case 'verify':
      await cmdVerify(values);
      break;
    case 'semantics':
      await cmdSemantics(values);
      break;
    case 'inspect':
      await cmdInspect(values);
      break;
    default:
      fail(`unknown command "${command}"\n\n${USAGE}`);
  }
}

main().catch((err) => {
  fail((err as Error).message ?? String(err), 1);
});
