import { PNG } from 'pngjs';
import type { LinearImage } from '../src/app/compose';
import type { Rgb } from '../src/core/types';
import { presentOverBackground, linearToSrgbByte, clamp01, opennessFromTransmittance } from '../src/core/color';

export type ViewMode = 'color' | 'transmittance' | 'coverage' | 'exactness';

export interface PngOptions {
  view: ViewMode;
  background: Rgb;
}

/**
 * Render a composited image to 8-bit sRGB RGBA PNG bytes.
 * - color: accumulated radiance over the chosen opaque backdrop.
 * - transmittance: grayscale of per-channel transmittance, with hue preserved.
 * - coverage: grayscale of 1 - luminance transmittance.
 * - exactness: green for exact pixels, magenta for approximate pixels.
 * The saved file uses the same compositing math as the on-screen canvas.
 */
export function imageToPng(image: LinearImage, options: PngOptions): Buffer {
  const png = new PNG({ width: image.width, height: image.height, colorType: 6 });
  for (let i = 0; i < image.width * image.height; i++) {
    let r = 0;
    let g = 0;
    let b = 0;
    if (options.view === 'color') {
      const c = presentOverBackground(image.radiance[i], image.transmittance[i], options.background);
      r = c.r;
      g = c.g;
      b = c.b;
    } else if (options.view === 'transmittance') {
      const t = image.transmittance[i];
      r = linearToSrgbByte(clamp01(t.r));
      g = linearToSrgbByte(clamp01(t.g));
      b = linearToSrgbByte(clamp01(t.b));
    } else if (options.view === 'coverage') {
      const lum = linearToSrgbByte(clamp01(1 - opennessFromTransmittance(image.transmittance[i])));
      r = lum;
      g = lum;
      b = lum;
    } else {
      const exact = image.exact[i];
      r = exact ? 46 : 244;
      g = exact ? 204 : 63;
      b = exact ? 113 : 94;
    }
    const o = i * 4;
    png.data[o] = r;
    png.data[o + 1] = g;
    png.data[o + 2] = b;
    png.data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

/** Render a transmittance visualization as a single-channel scalar map. */
export function transmittanceScalar(image: LinearImage, i: number): number {
  return opennessFromTransmittance(image.transmittance[i]);
}
