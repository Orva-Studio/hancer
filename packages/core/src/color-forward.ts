import { FADE_COLOR_HUES, FADE_TINT_STRENGTH } from "./render-constants";

type ParamDict = Record<string, string | number | boolean | undefined>;

/**
 * CPU port of shaders/color-settings.frag.wgsl plus the uniform packing in
 * wgpu/src/params.rs `color_settings_uniform`. The reference matcher has to
 * evaluate the grade thousands of times on a thumbnail while searching, which
 * rules out standing up a GPU context; keeping the port beside the shader is
 * the tradeoff. Any edit to that shader must land here too — colorForward.test
 * pins the values that would drift.
 */

export interface ColorUniform {
  contrast: number;
  brightness: number;
  saturation: number;
  gamma: number;
  whiteBalance: number;
  tint: number;
  bleachBypass: number;
  lift: [number, number, number];
}

const LUMA = [0.2126, 0.7152, 0.0722] as const;
const D65 = [1.0, 0.9468, 0.9228] as const;

function num(params: ParamDict, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function hueToRgb(hueDeg: number): [number, number, number] {
  const h = (((hueDeg % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  if (h < 1) return [1, x, 0];
  if (h < 2) return [x, 1, 0];
  if (h < 3) return [0, 1, x];
  if (h < 4) return [0, x, 1];
  if (h < 5) return [x, 0, 1];
  return [1, 0, x];
}

export function colorUniform(params: ParamDict): ColorUniform {
  const fade = num(params, "fade", 0);
  const fadeColor = typeof params["fade-color"] === "string" ? params["fade-color"] : "neutral";
  const fadeHue = (FADE_COLOR_HUES as Record<string, number>)[fadeColor];
  const fadeTint = fadeHue === undefined ? 0 : FADE_TINT_STRENGTH;
  const hue = hueToRgb(fadeHue ?? 0);
  const liftBase = fade * 0.05;

  return {
    contrast: num(params, "contrast", 1) * (1 - fade),
    brightness: num(params, "exposure", 0) * 0.1,
    saturation: num(params, "subtractive-sat", 1) * num(params, "richness", 1),
    gamma: 1 - num(params, "highlights", 0) * 0.5,
    whiteBalance: num(params, "white-balance", 6500),
    tint: num(params, "tint", 0) / 100,
    bleachBypass: num(params, "bleach-bypass", 0),
    lift: [
      liftBase * (1 + fadeTint * (hue[0] - 1)),
      liftBase * (1 + fadeTint * (hue[1] - 1)),
      liftBase * (1 + fadeTint * (hue[2] - 1)),
    ],
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Kelvin to per-channel gain, matching applyWhiteBalance in the shader. */
export function whiteBalanceGain(kelvin: number): [number, number, number] {
  if (Math.abs(kelvin - 6500) < 1) return [1, 1, 1];
  const t = kelvin / 100;
  let r: number;
  let g: number;
  let b: number;

  if (t <= 66) {
    r = 1;
    g = clamp01(0.39008 * Math.log(t) - 0.63184);
  } else {
    r = clamp01(1.292936 * Math.pow(t - 60, -0.1332047592));
    g = clamp01(1.129891 * Math.pow(t - 60, -0.0755148492));
  }

  if (t >= 66) b = 1;
  else if (t <= 19) b = 0;
  else b = clamp01(0.5432 * Math.log(t - 10) - 1.19625);

  return [r / D65[0], g / D65[1], b / D65[2]];
}

/**
 * Apply the colour-settings pass to one RGB triple in place-free form.
 * Inputs and outputs are 0–1 linear-in-texture values, exactly as the shader
 * sees them.
 */
export function applyColorSettings(
  rgb: readonly [number, number, number],
  u: ColorUniform,
  wbGain: readonly [number, number, number] = whiteBalanceGain(u.whiteBalance),
): [number, number, number] {
  let r = Math.pow(rgb[0], u.gamma);
  let g = Math.pow(rgb[1], u.gamma);
  let b = Math.pow(rgb[2], u.gamma);

  r = (r - 0.5) * u.contrast + 0.5 + u.brightness + u.lift[0];
  g = (g - 0.5) * u.contrast + 0.5 + u.brightness + u.lift[1];
  b = (b - 0.5) * u.contrast + 0.5 + u.brightness + u.lift[2];

  r = clamp01(r);
  g = clamp01(g);
  b = clamp01(b);

  const luma = r * LUMA[0] + g * LUMA[1] + b * LUMA[2];
  r = luma + (r - luma) * u.saturation;
  g = luma + (g - luma) * u.saturation;
  b = luma + (b - luma) * u.saturation;

  r *= wbGain[0];
  g *= wbGain[1];
  b *= wbGain[2];
  g += u.tint * 0.1;

  r = clamp01(r);
  g = clamp01(g);
  b = clamp01(b);

  if (u.bleachBypass > 0) {
    const desat = r * LUMA[0] + g * LUMA[1] + b * LUMA[2];
    const high = clamp01((desat - 0.5) * 1.3 + 0.5);
    r += (high - r) * u.bleachBypass;
    g += (high - g) * u.bleachBypass;
    b += (high - b) * u.bleachBypass;
  }

  return [r, g, b];
}

/** Run the colour pass over an interleaved RGB float buffer, returning a new buffer. */
export function applyColorSettingsBuffer(rgb: Float32Array, params: ParamDict): Float32Array {
  const u = colorUniform(params);
  const wbGain = whiteBalanceGain(u.whiteBalance);
  const out = new Float32Array(rgb.length);

  for (let i = 0; i < rgb.length; i += 3) {
    const [r, g, b] = applyColorSettings([rgb[i]!, rgb[i + 1]!, rgb[i + 2]!], u, wbGain);
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
  }

  return out;
}
