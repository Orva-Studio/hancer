import { test, expect, describe } from "bun:test";
import {
  computeParade, paradeImageData, paradeWidth,
  PARADE_COLUMNS, PARADE_BINS, PANEL_GAP,
} from "../app/lib/parade";

/** Build an RGBA buffer of a single flat colour. */
function flat(width: number, height: number, r: number, g: number, b: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = 255;
  }
  return out;
}

/** Index of the highest-valued bin in one column of a channel. */
function peakBin(channel: Float32Array, column: number, bins: number): number {
  let best = 0;
  for (let bin = 1; bin < bins; bin++) {
    if (channel[column * bins + bin]! > channel[column * bins + best]!) best = bin;
  }
  return best;
}

describe("computeParade", () => {
  test("black sits in the lowest bin of every channel", () => {
    const parade = computeParade(flat(32, 16, 0, 0, 0), 32, 16);
    for (const channel of parade.channels) {
      expect(peakBin(channel, 0, parade.bins)).toBe(0);
    }
  });

  test("white sits in the highest bin of every channel", () => {
    const parade = computeParade(flat(32, 16, 255, 255, 255), 32, 16);
    for (const channel of parade.channels) {
      expect(peakBin(channel, 0, parade.bins)).toBe(parade.bins - 1);
    }
  });

  test("mid grey lands near the middle", () => {
    const parade = computeParade(flat(32, 16, 128, 128, 128), 32, 16);
    const mid = (parade.bins - 1) / 2;
    for (const channel of parade.channels) {
      expect(Math.abs(peakBin(channel, 0, parade.bins) - mid)).toBeLessThan(3);
    }
  });

  test("a red cast puts the red trace above green and blue", () => {
    const parade = computeParade(flat(32, 16, 220, 60, 60), 32, 16);
    const [r, g, b] = parade.channels;
    const redPeak = peakBin(r, 0, parade.bins);
    expect(redPeak).toBeGreaterThan(peakBin(g, 0, parade.bins));
    expect(redPeak).toBeGreaterThan(peakBin(b, 0, parade.bins));
  });

  test("channels are normalised against a shared peak", () => {
    const parade = computeParade(flat(32, 16, 255, 255, 255), 32, 16);
    let max = 0;
    for (const channel of parade.channels) {
      for (let i = 0; i < channel.length; i++) if (channel[i]! > max) max = channel[i]!;
    }
    expect(max).toBeCloseTo(1, 5);
  });

  test("horizontal position is preserved", () => {
    // Left half black, right half white: the trace must follow.
    const width = 64;
    const height = 8;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const value = x < width / 2 ? 0 : 255;
        const i = (y * width + x) * 4;
        pixels[i] = value;
        pixels[i + 1] = value;
        pixels[i + 2] = value;
        pixels[i + 3] = 255;
      }
    }

    const parade = computeParade(pixels, width, height);
    const red = parade.channels[0]!;
    expect(peakBin(red, 0, parade.bins)).toBe(0);
    expect(peakBin(red, parade.columns - 1, parade.bins)).toBe(parade.bins - 1);
  });

  test("every column is filled when the source is narrower than the scope", () => {
    // The comb case: a scatter mapping would leave most columns empty here.
    const parade = computeParade(flat(8, 4, 200, 200, 200), 8, 4);
    for (let column = 0; column < parade.columns; column++) {
      const total = parade.channels[0]!
        .subarray(column * parade.bins, (column + 1) * parade.bins)
        .reduce((sum, v) => sum + v, 0);
      expect(total).toBeGreaterThan(0);
    }
  });

  test("a flat field reads at even brightness whatever the sample width", () => {
    // Uneven bucket sizes must not band the trace, so per-column counts are
    // divided by how many source pixels fed them.
    for (const width of [10, 192, 640]) {
      const parade = computeParade(flat(width, 8, 255, 255, 255), width, 8);
      const red = parade.channels[0]!;
      const peaks = [];
      for (let column = 0; column < parade.columns; column++) {
        peaks.push(red[column * parade.bins + (parade.bins - 1)]!);
      }
      const min = Math.min(...peaks);
      const max = Math.max(...peaks);
      expect(max - min).toBeLessThan(1e-6);
    }
  });

  test("no source column is dropped when the source is wider than the scope", () => {
    // One bright column against black: it must survive into some output column.
    const width = 600;
    const height = 4;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
    for (let y = 0; y < height; y++) {
      const i = (y * width + 417) * 4;
      pixels[i] = 255;
      pixels[i + 1] = 255;
      pixels[i + 2] = 255;
    }

    const parade = computeParade(pixels, width, height);
    const red = parade.channels[0]!;
    let bright = 0;
    for (let column = 0; column < parade.columns; column++) {
      if (red[column * parade.bins + (parade.bins - 1)]! > 0) bright++;
    }
    expect(bright).toBeGreaterThan(0);
  });

  test("empty input does not throw", () => {
    const parade = computeParade(new Uint8ClampedArray(0), 0, 0);
    expect(parade.channels[0]!.every(v => v === 0)).toBe(true);
  });
});

describe("paradeImageData", () => {
  test("output is three panels wide plus the gaps", () => {
    expect(paradeWidth()).toBe(PARADE_COLUMNS * 3 + PANEL_GAP * 2);
  });

  test("image dimensions match the parade data", () => {
    const parade = computeParade(flat(16, 8, 128, 128, 128), 16, 8);
    const image = paradeImageData(parade);
    expect(image.width).toBe(paradeWidth());
    expect(image.height).toBe(PARADE_BINS);
    expect(image.data.length).toBe(image.width * image.height * 4);
  });

  test("each panel draws only its own channel", () => {
    const parade = computeParade(flat(16, 8, 255, 255, 255), 16, 8);
    const image = paradeImageData(parade);
    const topRow = 0;
    const at = (x: number) => {
      const o = (topRow * image.width + x) * 4;
      return [image.data[o]!, image.data[o + 1]!, image.data[o + 2]!];
    };

    const red = at(4);
    const green = at(PARADE_COLUMNS + PANEL_GAP + 4);
    const blue = at((PARADE_COLUMNS + PANEL_GAP) * 2 + 4);

    expect(red[0]).toBeGreaterThan(red[2]!);
    expect(green[1]).toBeGreaterThan(green[0]!);
    expect(blue[2]).toBeGreaterThan(blue[0]!);
  });

  test("black draws at the bottom of the panel", () => {
    const parade = computeParade(flat(16, 8, 0, 0, 0), 16, 8);
    const image = paradeImageData(parade);
    const bottom = ((image.height - 1) * image.width + 4) * 4;
    const top = (0 * image.width + 4) * 4;
    expect(image.data[bottom + 3]).toBe(255);
    expect(image.data[top + 3]).toBe(0);
  });

  test("gap columns stay empty", () => {
    const parade = computeParade(flat(16, 8, 255, 255, 255), 16, 8);
    const image = paradeImageData(parade);
    const gapX = PARADE_COLUMNS + 2;
    for (let y = 0; y < image.height; y++) {
      expect(image.data[(y * image.width + gapX) * 4 + 3]).toBe(0);
    }
  });
});
