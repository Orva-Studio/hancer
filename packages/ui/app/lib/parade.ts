/**
 * RGB parade scope. Each channel gets its own panel; within a panel the
 * horizontal axis is the image's own horizontal axis and the vertical axis is
 * signal level, so a colour cast reads as one panel sitting higher than the
 * others at the same horizontal position.
 */

export const PARADE_COLUMNS = 192;
export const PARADE_BINS = 160;
/** Blank columns between the three panels. */
export const PANEL_GAP = 8;

export interface ParadeData {
  columns: number;
  bins: number;
  /** Per channel, `columns * bins` counts normalised to 0-1, row 0 = black. */
  channels: [Float32Array, Float32Array, Float32Array];
}

/** Trace colours. Kept bright: the traces are drawn against a near-black panel. */
const TRACE = [
  [255, 72, 72],
  [72, 235, 120],
  [96, 150, 255],
] as const;

export function paradeWidth(columns = PARADE_COLUMNS): number {
  return columns * 3 + PANEL_GAP * 2;
}

/**
 * Bin an RGBA buffer into per-channel column histograms.
 *
 * Counts are normalised against the single busiest bin across all three
 * channels rather than per channel, so the panels stay comparable: a channel
 * that genuinely carries less signal should look dimmer, not be rescaled to
 * match the others.
 */
export function computeParade(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  columns = PARADE_COLUMNS,
  bins = PARADE_BINS,
): ParadeData {
  const channels: [Float32Array, Float32Array, Float32Array] = [
    new Float32Array(columns * bins),
    new Float32Array(columns * bins),
    new Float32Array(columns * bins),
  ];

  if (width <= 0 || height <= 0) return { columns, bins, channels };

  const maxBin = bins - 1;

  // Gather per output column rather than scattering per source pixel: when the
  // source is narrower than the scope, scattering leaves unwritten columns and
  // the trace combs. Gathering guarantees every column reads at least one.
  for (let column = 0; column < columns; column++) {
    const x0 = Math.min(width - 1, Math.floor((column * width) / columns));
    const x1 = Math.max(x0 + 1, Math.min(width, Math.floor(((column + 1) * width) / columns)));

    for (let x = x0; x < x1; x++) {
      for (let y = 0; y < height; y++) {
        const i = (y * width + x) * 4;
        for (let c = 0; c < 3; c++) {
          const bin = Math.min(maxBin, Math.round((pixels[i + c]! / 255) * maxBin));
          channels[c]![column * bins + bin]! += 1;
        }
      }
    }

    // Columns can cover an uneven number of source columns when the sample is
    // not the scope's own width. Without this a flat field bands, because the
    // shared-peak normalisation that follows would compare raw counts from
    // buckets of different sizes.
    const contributing = (x1 - x0) * height;
    for (const channel of channels) {
      for (let bin = 0; bin < bins; bin++) channel[column * bins + bin]! /= contributing;
    }
  }

  let peak = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) if (channel[i]! > peak) peak = channel[i]!;
  }
  if (peak > 0) {
    for (const channel of channels) {
      for (let i = 0; i < channel.length; i++) channel[i] = channel[i]! / peak;
    }
  }

  return { columns, bins, channels };
}

/**
 * Render parade data to RGBA pixels.
 *
 * `gain` lifts faint traces: a scope is mostly sparse, and without it a normal
 * image shows only the few bins where flat areas pile up. The square root is
 * the conventional scope response, compressing the peaks that a handful of
 * flat regions produce without crushing the rest of the trace.
 */
export function paradeImageData(
  data: ParadeData,
  gain = 6,
): { data: Uint8ClampedArray; width: number; height: number } {
  const { columns, bins, channels } = data;
  const width = paradeWidth(columns);
  const height = bins;
  const out = new Uint8ClampedArray(width * height * 4);

  for (let c = 0; c < 3; c++) {
    const channel = channels[c]!;
    const [tr, tg, tb] = TRACE[c]!;
    const xOffset = c * (columns + PANEL_GAP);

    for (let column = 0; column < columns; column++) {
      for (let bin = 0; bin < bins; bin++) {
        const value = channel[column * bins + bin]!;
        if (value <= 0) continue;

        const intensity = Math.min(1, Math.sqrt(value) * gain);
        // Row 0 is black, and a scope draws black at the bottom.
        const y = bins - 1 - bin;
        const o = (y * width + xOffset + column) * 4;
        out[o] = tr * intensity;
        out[o + 1] = tg * intensity;
        out[o + 2] = tb * intensity;
        out[o + 3] = 255;
      }
    }
  }

  return { data: out, width, height };
}

/**
 * Sample a rendered canvas down to a size the parade can bin quickly.
 * Reading the full preview back every frame is what would cost, not the
 * binning, so the sample is taken small.
 */
export function sampleCanvas(
  source: HTMLCanvasElement,
  target: HTMLCanvasElement,
  width = PARADE_COLUMNS,
  height = 120,
): ImageData | null {
  if (source.width === 0 || source.height === 0) return null;

  if (target.width !== width) target.width = width;
  if (target.height !== height) target.height = height;
  const ctx = target.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  ctx.drawImage(source, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}
