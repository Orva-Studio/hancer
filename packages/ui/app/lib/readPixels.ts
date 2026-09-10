/**
 * Read a video frame or image URL as interleaved RGB floats in 0-1, the format
 * the colour matcher expects.
 *
 * Sampled small on purpose: the matcher only reads colour distributions, which
 * a thumbnail carries as faithfully as a full frame, and the solver evaluates
 * the grade once per candidate.
 */

export const SAMPLE_WIDTH = 256;
export const SAMPLE_HEIGHT = 144;

export function rgbaToRgbFloats(rgba: Uint8ClampedArray): Float32Array {
  const pixels = rgba.length / 4;
  const out = new Float32Array(pixels * 3);
  for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) {
    out[o] = rgba[i]! / 255;
    out[o + 1] = rgba[i + 1]! / 255;
    out[o + 2] = rgba[i + 2]! / 255;
  }
  return out;
}

export async function readPixels(
  source: HTMLVideoElement | string,
  width = SAMPLE_WIDTH,
  height = SAMPLE_HEIGHT,
): Promise<Float32Array> {
  let drawable: HTMLVideoElement | HTMLImageElement;

  if (typeof source === "string") {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = source;
    await img.decode();
    drawable = img;
  } else {
    drawable = source;
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not read pixels from this file");

  ctx.drawImage(drawable, 0, 0, width, height);
  return rgbaToRgbFloats(ctx.getImageData(0, 0, width, height).data);
}
