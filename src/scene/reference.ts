import type { Rgb } from '../core/types';
import { sceneFieldAtPixel, type SceneConfig } from './scene';
import { DEFAULT_SCENE } from './scene';

export interface ReferencePixel {
  radiance: Rgb;
  transmittance: Rgb;
}

interface SurfaceEvent {
  z: number;
  color: Rgb;
  coverage: number;
}

/**
 * Independent reference renderer. This does not call the compositor. It walks
 * depth from front to back, integrating media numerically with fixed substeps
 * and applying surface events in depth order. It is deliberately a different
 * algorithm from the closed-form span integrator so the tests exercise the
 * integration rather than a shared implementation.
 *
 * Surfaces are assumed to be epsilon-thin and to consume their coverage
 * fraction at their exact depth. The plate is placed in front of the volume;
 * the slice is placed inside it.
 */
export function renderReferencePixel(
  x: number,
  y: number,
  cfg: SceneConfig = DEFAULT_SCENE,
  substepsPerUnit = 192,
): ReferencePixel {
  const field = sceneFieldAtPixel(x, y, cfg);

  const surfaces: SurfaceEvent[] = [];
  if (field.plate) {
    surfaces.push({ z: cfg.plateZ, color: field.plate.color, coverage: field.plate.coverage });
  }
  if (field.slice) {
    surfaces.push({ z: cfg.sliceZ, color: field.slice.color, coverage: field.slice.coverage });
  }
  // Back-to-front is not used; we accumulate front to back, so sort ascending.
  surfaces.sort((a, b) => a.z - b.z);

  const radiance: Rgb = { r: 0, g: 0, b: 0 };
  const transmittance: Rgb = { r: 1, g: 1, b: 1 };

  const mediumAt = (z: number): { sigma: Rgb; emission: Rgb } => {
    const sigma: Rgb = { r: 0, g: 0, b: 0 };
    const emission: Rgb = { r: 0, g: 0, b: 0 };
    if (field.smokeA && z >= cfg.smokeA.zNear && z < cfg.smokeA.zFar) {
      sigma.r += field.smokeA.extinction.r;
      sigma.g += field.smokeA.extinction.g;
      sigma.b += field.smokeA.extinction.b;
      emission.r += field.smokeA.emission.r;
      emission.g += field.smokeA.emission.g;
      emission.b += field.smokeA.emission.b;
    }
    if (field.smokeB && z >= cfg.smokeB.zNear && z < cfg.smokeB.zFar) {
      sigma.r += field.smokeB.extinction.r;
      sigma.g += field.smokeB.extinction.g;
      sigma.b += field.smokeB.extinction.b;
      emission.r += field.smokeB.emission.r;
      emission.g += field.smokeB.emission.g;
      emission.b += field.smokeB.emission.b;
    }
    return { sigma, emission };
  };

  // Build integration pieces between surface events.
  const stops = [cfg.zMin, ...surfaces.map((s) => s.z), cfg.zMax].sort((a, b) => a - b);
  const uniqueStops: number[] = [];
  for (const s of stops) {
    if (uniqueStops.length === 0 || s - uniqueStops[uniqueStops.length - 1] > 1e-12) {
      uniqueStops.push(s);
    }
  }

  const surfaceAt = new Map<number, SurfaceEvent>();
  for (const s of surfaces) surfaceAt.set(s.z, s);

  const integratePiece = (a: number, b: number) => {
    if (!(b > a)) return;
    const steps = Math.max(1, Math.ceil((b - a) * substepsPerUnit));
    const dz = (b - a) / steps;
    for (let i = 0; i < steps; i++) {
      const z0 = a + i * dz;
      const zMid = z0 + dz * 0.5;
      const { sigma, emission } = mediumAt(zMid);
      // Midpoint transmittance over the substep, then source in the middle.
      const stepT: Rgb = {
        r: Math.exp(-sigma.r * dz),
        g: Math.exp(-sigma.g * dz),
        b: Math.exp(-sigma.b * dz),
      };
      const halfT: Rgb = {
        r: Math.exp(-sigma.r * dz * 0.5),
        g: Math.exp(-sigma.g * dz * 0.5),
        b: Math.exp(-sigma.b * dz * 0.5),
      };
      radiance.r += transmittance.r * emission.r * dz * halfT.r;
      radiance.g += transmittance.g * emission.g * dz * halfT.g;
      radiance.b += transmittance.b * emission.b * dz * halfT.b;
      transmittance.r *= stepT.r;
      transmittance.g *= stepT.g;
      transmittance.b *= stepT.b;
    }
  };

  for (let i = 0; i + 1 < uniqueStops.length; i++) {
    const a = uniqueStops[i];
    const b = uniqueStops[i + 1];
    integratePiece(a, b);
    const surf = surfaceAt.get(b);
    if (surf) {
      radiance.r += transmittance.r * surf.color.r * surf.coverage;
      radiance.g += transmittance.g * surf.color.g * surf.coverage;
      radiance.b += transmittance.b * surf.color.b * surf.coverage;
      const keep = 1 - surf.coverage;
      transmittance.r *= keep;
      transmittance.g *= keep;
      transmittance.b *= keep;
    }
  }
  // Any surface exactly at zMax.
  const last = surfaceAt.get(uniqueStops[uniqueStops.length - 1]);
  if (last) {
    radiance.r += transmittance.r * last.color.r * last.coverage;
    radiance.g += transmittance.g * last.color.g * last.coverage;
    radiance.b += transmittance.b * last.color.b * last.coverage;
    const keep = 1 - last.coverage;
    transmittance.r *= keep;
    transmittance.g *= keep;
    transmittance.b *= keep;
  }

  return { radiance, transmittance };
}

export function renderReferenceImage(
  cfg: SceneConfig = DEFAULT_SCENE,
): { width: number; height: number; pixels: ReferencePixel[] } {
  const pixels: ReferencePixel[] = new Array(cfg.width * cfg.height);
  for (let y = 0; y < cfg.height; y++) {
    for (let x = 0; x < cfg.width; x++) {
      pixels[y * cfg.width + x] = renderReferencePixel(x, y, cfg);
    }
  }
  return { width: cfg.width, height: cfg.height, pixels };
}
