import type { Rgb, Rgba } from './types';
import { TRANSPARENT } from './types';

export function rgba(r: number, g: number, b: number, a: number): Rgba {
  return { r, g, b, a };
}

export function rgb(r: number, g: number, b: number): Rgb {
  return { r, g, b };
}

export function addRgb(a: Rgb, b: Rgb): Rgb {
  return { r: a.r + b.r, g: a.g + b.g, b: a.b + b.b };
}

export function scaleRgb(a: Rgb, s: number): Rgb {
  return { r: a.r * s, g: a.g * s, b: a.b * s };
}

export function mulRgb(a: Rgb, b: Rgb): Rgb {
  return { r: a.r * b.r, g: a.g * b.g, b: a.b * b.b };
}

export function isFiniteRgba(a: Rgba): boolean {
  return (
    Number.isFinite(a.r) &&
    Number.isFinite(a.g) &&
    Number.isFinite(a.b) &&
    Number.isFinite(a.a)
  );
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function clampRgba01(a: Rgba): Rgba {
  return { r: clamp01(a.r), g: clamp01(a.g), b: clamp01(a.b), a: clamp01(a.a) };
}

/**
 * Composite a pixel's accumulated emission over a backdrop using per-channel
 * transmittance. Chromatic extinction attenuates each backdrop channel
 * independently, which a single scalar alpha cannot express.
 */
export function compositeOverTransmittance(radiance: Rgb, transmittance: Rgb, background: Rgb): Rgb {
  return {
    r: radiance.r + background.r * transmittance.r,
    g: radiance.g + background.g * transmittance.g,
    b: radiance.b + background.b * transmittance.b,
  };
}

export function linearToSrgb(v: number): number {
  const x = v <= 0 ? 0 : v >= 1 ? 1 : v;
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function srgbByteToLinear(byte: number): number {
  return srgbToLinear(byte / 255);
}

export function linearToSrgbByte(v: number): number {
  return Math.round(clamp01(linearToSrgb(v)) * 255);
}

/** Convert premultiplied linear RGBA to 8-bit sRGB bytes, unpremultiplying. */
export function premulLinearToBytes(c: Rgba): { r: number; g: number; b: number; a: number } {
  const invA = c.a > 1e-8 ? 1 / c.a : 0;
  return {
    r: linearToSrgbByte(c.r * invA),
    g: linearToSrgbByte(c.g * invA),
    b: linearToSrgbByte(c.b * invA),
    a: Math.round(clamp01(c.a) * 255),
  };
}

/**
 * Present a pixel over an opaque backdrop as straight 8-bit sRGB. Used for the
 * color view and for PNG export so what is shown is what is saved.
 */
export function presentOverBackground(
  radiance: Rgb,
  transmittance: Rgb,
  background: Rgb,
): { r: number; g: number; b: number } {
  const comp = compositeOverTransmittance(radiance, transmittance, background);
  return {
    r: linearToSrgbByte(comp.r),
    g: linearToSrgbByte(comp.g),
    b: linearToSrgbByte(comp.b),
  };
}

/** Luminance-weighted openness of a pixel; 1 = fully transmissive. */
export function opennessFromTransmittance(transmittance: Rgb): number {
  return clamp01(transmittance.r * 0.2126 + transmittance.g * 0.7152 + transmittance.b * 0.0722);
}

export function premultiply(color: Rgb, coverage: number): Rgba {
  return {
    r: color.r * coverage,
    g: color.g * coverage,
    b: color.b * coverage,
    a: coverage,
  };
}

export function luminance(c: Rgb): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

export function parseHexColor(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return {
    r: srgbByteToLinear((n >> 16) & 0xff),
    g: srgbByteToLinear((n >> 8) & 0xff),
    b: srgbByteToLinear(n & 0xff),
  };
}

export function toHexColor(c: Rgb): string {
  const h = (v: number) => linearToSrgbByte(v).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

export { TRANSPARENT };
