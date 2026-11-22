#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  buildLabChain,
  demonstrationScene,
  runLabChain,
  type LabLayer,
} from '../src/scene/sampleLab';
import { separationExperiment, invisibleOnBlackEdge } from '../src/verify/matte';

/**
 * sample-lab — generate deterministic multi-layer samples and integrate them
 * with the same closed-form compositor, but without touching the image canvas.
 * All printed values are computed from the generated samples; there are no
 * hand-entered expected numbers.
 *
 * Usage:
 *   sample-lab demo
 *   sample-lab run --point id,z,r,g,b,a[,straight] --interval id,zNear,zFar,sr,sg,sb,er,eg,eb
 *   sample-lab matte --point ... --matte z,r,g,b
 */

const USAGE = `sample-lab — multi-layer sample generator and independent integrator

Commands:
  demo                  run the built-in overlapping-media + interior-edge scene
  run                   integrate layers given on the command line
  matte                 same as run, then insert a middle matte and report separation

Layer syntax:
  --point id,z,r,g,b,a[,straight]
  --interval id,zNear,zFar,sigmaR,sigmaG,sigmaB,emitR,emitG,emitB
  --matte z,r,g,b       (matte command only)`;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function num(token: string, label: string): number {
  const v = Number(token);
  if (!Number.isFinite(v)) fail(`bad ${label}: ${token}`);
  return v;
}

function parsePoint(token: string): LabLayer {
  const parts = token.split(',');
  if (parts.length !== 6 && parts.length !== 7) fail(`point needs id,z,r,g,b,a[,straight]: ${token}`);
  const [id, z, r, g, b, a, convention] = parts;
  return {
    id,
    kind: 'point',
    z: num(z, 'z'),
    color: { r: num(r, 'r'), g: num(g, 'g'), b: num(b, 'b'), a: num(a, 'a') },
    colorConvention: convention === 'straight' ? 'straight' : 'premultiplied',
  };
}

function parseInterval(token: string): LabLayer {
  const parts = token.split(',');
  if (parts.length !== 9) fail(`interval needs id,zNear,zFar,sr,sg,sb,er,eg,eb: ${token}`);
  const [id, zNear, zFar, sr, sg, sb, er, eg, eb] = parts;
  return {
    id,
    kind: 'interval',
    zNear: num(zNear, 'zNear'),
    zFar: num(zFar, 'zFar'),
    extinction: { r: num(sr, 'sigmaR'), g: num(sg, 'sigmaG'), b: num(sb, 'sigmaB') },
    emission: { r: num(er, 'emitR'), g: num(eg, 'emitG'), b: num(eb, 'emitB') },
  };
}

function round(v: number): number {
  return Math.round(v * 1e9) / 1e9;
}

function printReport(title: string, report: ReturnType<typeof runLabChain>): void {
  console.log(`\n== ${title} ==`);
  console.log('ordered contributions:');
  for (const c of report.contributions) {
    const flags = [c.merged ? 'merged' : '', c.overlap ? 'overlap' : ''].filter(Boolean).join(' ');
    console.log(
      `  #${c.index} ${c.kind.padEnd(6)} ${c.depth.padEnd(14)} ` +
        `ids=[${c.sourceIds.join(',')}] emitted=(${round(c.emitted.r)}, ${round(c.emitted.g)}, ${round(c.emitted.b)}) ` +
        `T_after=(${round(c.transmittanceAfter.r)}, ${round(c.transmittanceAfter.g)}, ${round(c.transmittanceAfter.b)}) ${flags}`,
    );
  }
  console.log(
    `radiance=(${round(report.radiance.r)}, ${round(report.radiance.g)}, ${round(report.radiance.b)}) ` +
      `T=(${round(report.transmittance.r)}, ${round(report.transmittance.g)}, ${round(report.transmittance.b)}) exact=${report.exact}`,
  );
  console.log(
    `non-mergeable ranges=${report.semantics.nonMergeableRanges} overlap spans=${report.semantics.overlapSpans} ` +
      `interior cuts=${report.semantics.interiorCuts} semanticsOk=${report.semantics.ok}`,
  );
  if (report.probes.some((p) => p.convention === 'straight')) {
    console.log('convention probes:');
    for (const p of report.probes) {
      if (p.convention !== 'straight') continue;
      console.log(
        `  ${p.id} straight coverage=${round(p.coverage)} declaredT=(${round(p.declared.r)}, ${round(p.declared.g)}, ${round(p.declared.b)}) ` +
          `misreadT=(${round(p.misread.r)}, ${round(p.misread.g)}, ${round(p.misread.b)}) gap=${round(p.gap.r)}`,
      );
    }
  }
}

function layersFromArgs(values: { point?: string[]; interval?: string[] }): LabLayer[] {
  const layers: LabLayer[] = [];
  for (const p of values.point ?? []) layers.push(parsePoint(p));
  for (const i of values.interval ?? []) layers.push(parseInterval(i));
  if (layers.length === 0) fail('provide at least one --point or --interval layer');
  return layers;
}

function main(): void {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }

  if (command === 'demo') {
    const { base, matte, blackEdge } = demonstrationScene();
    printReport('demonstration scene', base);
    printReport('same scene with an invisible-on-black hard edge', blackEdge);
    console.log('\nmiddle-matte separation:');
    console.log(
      `  equivalentOnEmpty=${matte.equivalentOnEmpty} emptyDelta=${round(Math.max(matte.emptyDelta.r, matte.emptyDelta.g, matte.emptyDelta.b))} ` +
        `separates=${matte.separates} matteDelta=${round(Math.max(matte.matteDelta.r, matte.matteDelta.g, matte.matteDelta.b))} ` +
        `transmittanceDelta=${round(Math.max(matte.transmittanceDelta.r, matte.transmittanceDelta.g, matte.transmittanceDelta.b))}`,
    );
    return;
  }

  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      point: { type: 'string', multiple: true },
      interval: { type: 'string', multiple: true },
      matte: { type: 'string' },
    },
  });

  if (command === 'run') {
    const chain = buildLabChain(layersFromArgs(values));
    printReport('lab run', runLabChain(chain));
    return;
  }

  if (command === 'matte') {
    if (!values.matte) fail('matte command requires --matte z,r,g,b');
    const parts = values.matte.split(',');
    if (parts.length !== 4) fail('--matte must be z,r,g,b');
    const chain = buildLabChain(layersFromArgs(values));
    const report = runLabChain(chain);
    printReport('lab run before matte', report);
    const result = separationExperiment(chain, chain, {
      z: num(parts[0], 'matte z'),
      color: { r: num(parts[1], 'matte r'), g: num(parts[2], 'matte g'), b: num(parts[3], 'matte b') },
    });
    // Comparing a chain to itself is a control; build a real contrast by adding
    // the matte to a second chain with a black edge.
    const contrast = invisibleOnBlackEdge(chain, num(parts[0], 'matte z') - 1, 0.5);
    const real = separationExperiment(chain, contrast, {
      z: num(parts[0], 'matte z'),
      color: { r: num(parts[1], 'matte r'), g: num(parts[2], 'matte g'), b: num(parts[3], 'matte b') },
    });
    console.log('\ncontrol (chain vs itself):', JSON.stringify({ separates: result.separates }));
    console.log(
      'black-edge separation:',
      JSON.stringify({
        equivalentOnEmpty: real.equivalentOnEmpty,
        separates: real.separates,
        emptyDelta: round(Math.max(real.emptyDelta.r, real.emptyDelta.g, real.emptyDelta.b)),
        matteDelta: round(Math.max(real.matteDelta.r, real.matteDelta.g, real.matteDelta.b)),
      }),
    );
    return;
  }

  fail(`unknown command "${command}"\n\n${USAGE}`);
}

main();
