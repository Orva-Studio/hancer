/**
 * Statistics used to compare a graded frame against a reference. Source and
 * reference are different scenes, so nothing here compares pixels positionally
 * — only distributions.
 */

/** Percentiles sampled per channel. Spread across the range so the fit sees
 * the whole tone curve rather than just the midpoint. */
export const PERCENTILES = [0.02, 0.1, 0.25, 0.5, 0.75, 0.9, 0.98] as const;

export interface ColorStats {
  /** Per channel (r, g, b), one entry per PERCENTILES step. */
  channels: [number[], number[], number[]];
  /** Mean distance from the per-pixel luma, a saturation proxy. */
  chroma: number;
}

const LUMA = [0.2126, 0.7152, 0.0722] as const;

function percentilesOf(sorted: Float32Array): number[] {
  const n = sorted.length;
  if (n === 0) return PERCENTILES.map(() => 0);
  return PERCENTILES.map(p => {
    const idx = (n - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    const frac = idx - lo;
    return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
  });
}

export function computeStats(rgb: Float32Array): ColorStats {
  const count = rgb.length / 3;
  const r = new Float32Array(count);
  const g = new Float32Array(count);
  const b = new Float32Array(count);
  let chroma = 0;

  for (let i = 0, p = 0; i < rgb.length; i += 3, p++) {
    const cr = rgb[i]!;
    const cg = rgb[i + 1]!;
    const cb = rgb[i + 2]!;
    r[p] = cr;
    g[p] = cg;
    b[p] = cb;
    const luma = cr * LUMA[0] + cg * LUMA[1] + cb * LUMA[2];
    chroma += (Math.abs(cr - luma) + Math.abs(cg - luma) + Math.abs(cb - luma)) / 3;
  }

  r.sort();
  g.sort();
  b.sort();

  return {
    channels: [percentilesOf(r), percentilesOf(g), percentilesOf(b)],
    chroma: count === 0 ? 0 : chroma / count,
  };
}

/**
 * Distance between two stat sets. Percentile error dominates; chroma is a
 * lighter term that mainly disambiguates saturation, which percentiles alone
 * pin down only weakly.
 */
export function statsDistance(a: ColorStats, b: ColorStats): number {
  let sum = 0;
  for (let c = 0; c < 3; c++) {
    const ac = a.channels[c]!;
    const bc = b.channels[c]!;
    for (let i = 0; i < ac.length; i++) {
      const d = ac[i]! - bc[i]!;
      sum += d * d;
    }
  }
  const n = 3 * PERCENTILES.length;
  const chromaErr = a.chroma - b.chroma;
  return Math.sqrt(sum / n) + Math.abs(chromaErr) * 0.5;
}

/**
 * Take an evenly-strided sample of an interleaved RGB buffer. The solver runs
 * the grade once per candidate value, so capping the pixel count is what keeps
 * a match interactive; striding rather than cropping keeps the sample
 * representative of the whole frame.
 */
export function samplePixels(rgb: Float32Array, maxPixels: number): Float32Array {
  const count = rgb.length / 3;
  if (count <= maxPixels) return rgb;

  const stride = Math.ceil(count / maxPixels);
  const kept = Math.ceil(count / stride);
  const out = new Float32Array(kept * 3);

  for (let i = 0, o = 0; i < count; i += stride, o += 3) {
    out[o] = rgb[i * 3]!;
    out[o + 1] = rgb[i * 3 + 1]!;
    out[o + 2] = rgb[i * 3 + 2]!;
  }

  return out;
}
