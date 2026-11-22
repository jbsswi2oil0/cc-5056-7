import type { LinearImage } from '../app/compose';
import type { ViewMode } from '../app/state';
import type { Rgb } from '../core/types';
import { imageToRgbaBytes } from '../app/renderCanvas';

/**
 * Encode a composited image to PNG in the browser using a canvas. The bytes
 * come from the same imageToRgbaBytes routine the on-screen canvas draws, so
 * the exported file matches the displayed view.
 */
export async function imageToPngBlob(
  image: LinearImage,
  view: ViewMode,
  background: Rgb,
): Promise<Blob> {
  const { width, height, data } = imageToRgbaBytes(image, view, background);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  const imageData = new ImageData(new Uint8ClampedArray(data), width, height);
  ctx.putImageData(imageData, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('PNG encoding failed');
  return blob;
}
