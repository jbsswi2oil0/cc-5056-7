import type { Rgb } from '../core/types';
import {
  clamp01,
  linearToSrgbByte,
  opennessFromTransmittance,
  presentOverBackground,
} from '../core/color';
import type { LinearImage } from './compose';

export type { ViewMode } from './state';
import type { ViewMode } from './state';

export interface RenderViewOptions {
  view: ViewMode;
  background: Rgb;
  /** Canvas pixels per image pixel. */
  scale: number;
}

/**
 * Render a composited linear image into a canvas. Every view is derived from
 * the same radiance/transmittance arrays that export and verification use, so
 * what the canvas shows is what the PNG export writes.
 */
export function drawImage(
  canvas: HTMLCanvasElement,
  image: LinearImage,
  opts: RenderViewOptions,
): void {
  const { width, height } = image;
  const scale = Math.max(1, Math.floor(opts.scale));
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  const ctxImage = ctx.createImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    if (opts.view === 'color') {
      const c = presentOverBackground(image.radiance[i], image.transmittance[i], opts.background);
      ctxImage.data[o] = c.r;
      ctxImage.data[o + 1] = c.g;
      ctxImage.data[o + 2] = c.b;
      ctxImage.data[o + 3] = 255;
    } else if (opts.view === 'transmittance') {
      const t = image.transmittance[i];
      ctxImage.data[o] = linearToSrgbByte(clamp01(t.r));
      ctxImage.data[o + 1] = linearToSrgbByte(clamp01(t.g));
      ctxImage.data[o + 2] = linearToSrgbByte(clamp01(t.b));
      ctxImage.data[o + 3] = 255;
    } else if (opts.view === 'coverage') {
      const v = linearToSrgbByte(clamp01(1 - opennessFromTransmittance(image.transmittance[i])));
      ctxImage.data[o] = v;
      ctxImage.data[o + 1] = v;
      ctxImage.data[o + 2] = v;
      ctxImage.data[o + 3] = 255;
    } else {
      const exact = image.exact[i];
      ctxImage.data[o] = exact ? 46 : 244;
      ctxImage.data[o + 1] = exact ? 204 : 63;
      ctxImage.data[o + 2] = exact ? 113 : 94;
      ctxImage.data[o + 3] = 255;
    }
  }
  const scratch = document.createElement('canvas');
  scratch.width = width;
  scratch.height = height;
  scratch.getContext('2d')!.putImageData(ctxImage, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(scratch, 0, 0, canvas.width, canvas.height);
}

/** Render 8-bit sRGB bytes from a LinearImage for PNG export. */
export function imageToRgbaBytes(
  image: LinearImage,
  view: ViewMode,
  background: Rgb,
): { width: number; height: number; data: Uint8Array } {
  const data = new Uint8Array(image.width * image.height * 4);
  for (let i = 0; i < image.width * image.height; i++) {
    const o = i * 4;
    if (view === 'color') {
      const c = presentOverBackground(image.radiance[i], image.transmittance[i], background);
      data[o] = c.r;
      data[o + 1] = c.g;
      data[o + 2] = c.b;
    } else if (view === 'transmittance') {
      const t = image.transmittance[i];
      data[o] = linearToSrgbByte(clamp01(t.r));
      data[o + 1] = linearToSrgbByte(clamp01(t.g));
      data[o + 2] = linearToSrgbByte(clamp01(t.b));
    } else if (view === 'coverage') {
      const v = linearToSrgbByte(clamp01(1 - opennessFromTransmittance(image.transmittance[i])));
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
    } else {
      const exact = image.exact[i];
      data[o] = exact ? 46 : 244;
      data[o + 1] = exact ? 204 : 63;
      data[o + 2] = exact ? 113 : 94;
    }
    data[o + 3] = 255;
  }
  return { width: image.width, height: image.height, data };
}
