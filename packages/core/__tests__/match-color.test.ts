import { test, expect, describe } from "bun:test";
import { applyColorSettingsBuffer, colorUniform, whiteBalanceGain } from "../src/color-forward";
import { matchColorParams } from "../src/match/solve";
import { computeStats, statsDistance, samplePixels } from "../src/match/stats";

/**
 * Deterministic synthetic frame: a luminance ramp crossed with hue sweeps, so
 * every fitted parameter has signal to work with. `seed` shifts the content
 * without changing its statistics much, standing in for a different scene.
 */
function syntheticFrame(width = 96, height = 96, seed = 1): Float32Array {
  const out = new Float32Array(width * height * 3);
  let state = seed * 2654435761;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const ramp = x / (width - 1);
      const band = y / (height - 1);
      const jitter = rand() * 0.08;
      out[i] = Math.min(1, Math.max(0, ramp * 0.9 + band * 0.1 + jitter));
      out[i + 1] = Math.min(1, Math.max(0, ramp * 0.7 + (1 - band) * 0.25 + jitter));
      out[i + 2] = Math.min(1, Math.max(0, ramp * 0.5 + band * 0.4 + jitter));
    }
  }
  return out;
}

describe("colour forward model", () => {
  test("default params are a passthrough", () => {
    const uniform = colorUniform({});
    expect(uniform.contrast).toBe(1);
    expect(uniform.brightness).toBe(0);
    expect(uniform.saturation).toBe(1);
    expect(uniform.gamma).toBe(1);
    expect(uniform.whiteBalance).toBe(6500);
    expect(uniform.lift).toEqual([0, 0, 0]);
  });

  test("fade scales contrast and lifts blacks together", () => {
    const uniform = colorUniform({ fade: 0.5, contrast: 1 });
    expect(uniform.contrast).toBeCloseTo(0.5, 6);
    expect(uniform.lift[0]).toBeCloseTo(0.025, 6);
  });

  test("neutral fade colour lifts all channels equally", () => {
    const neutral = colorUniform({ fade: 0.4, "fade-color": "neutral" });
    expect(neutral.lift[0]).toBeCloseTo(neutral.lift[1], 6);
    expect(neutral.lift[1]).toBeCloseTo(neutral.lift[2], 6);
  });

  test("warm fade colour tints the lift toward red", () => {
    const warm = colorUniform({ fade: 0.4, "fade-color": "warm" });
    expect(warm.lift[0]).toBeGreaterThan(warm.lift[2]);
  });

  test("white balance is identity at 6500K", () => {
    expect(whiteBalanceGain(6500)).toEqual([1, 1, 1]);
  });

  test("lower kelvin pushes gain toward red", () => {
    const warm = whiteBalanceGain(3000);
    expect(warm[0]).toBeGreaterThan(warm[2]);
  });

  test("identity params leave pixels untouched", () => {
    const frame = syntheticFrame(16, 16);
    const out = applyColorSettingsBuffer(frame, {});
    for (let i = 0; i < frame.length; i++) {
      expect(out[i]!).toBeCloseTo(frame[i]!, 5);
    }
  });
});

describe("round trip", () => {
  // The core assertion: grade a frame with known parameters, hand the result
  // back as the reference, and the solver should recover the parameters that
  // produced it.
  const cases: Array<{ name: string; params: Record<string, string | number> }> = [
    { name: "exposure lift", params: { exposure: 0.8 } },
    { name: "contrast push", params: { contrast: 1.4 } },
    { name: "warm grade", params: { "white-balance": 4200 } },
    { name: "cool grade", params: { "white-balance": 9000 } },
    { name: "green tint", params: { tint: 25 } },
    { name: "desaturated", params: { "subtractive-sat": 0.55 } },
    { name: "faded blacks", params: { fade: 0.3 } },
    { name: "highlight rolloff", params: { highlights: 0.5 } },
    {
      name: "combined look",
      params: { exposure: 0.3, contrast: 1.25, "white-balance": 5000, "subtractive-sat": 0.8 },
    },
  ];

  for (const { name, params } of cases) {
    test(`recovers ${name}`, () => {
      const source = syntheticFrame();
      const reference = applyColorSettingsBuffer(source, params);
      const result = matchColorParams(source, reference);

      // Primary assertion is the look, not parameter equality: fade and
      // contrast are genuinely interchangeable (fade scales contrast by
      // 1-fade), so the solver may reach the same grade by another route.
      const matched = applyColorSettingsBuffer(source, result.params);
      const residual = statsDistance(computeStats(matched), computeStats(reference));

      expect(residual).toBeLessThan(0.01);
      expect(result.distance).toBeLessThan(result.baseline);
    });
  }

  // Parameters that are individually identifiable from one frame. These are
  // the ones whose slider positions should be trustworthy in the UI. Exposure
  // and fade are excluded on purpose; both trade against contrast.
  const identifiable: Array<{ key: string; value: number; tolerance: number }> = [
    { key: "white-balance", value: 4200, tolerance: 250 },
    { key: "white-balance", value: 9000, tolerance: 250 },
    { key: "contrast", value: 1.4, tolerance: 0.1 },
    { key: "subtractive-sat", value: 0.55, tolerance: 0.08 },
    { key: "highlights", value: 0.5, tolerance: 0.08 },
  ];

  for (const { key, value, tolerance } of identifiable) {
    test(`recovers the value of ${key}=${value}`, () => {
      const source = syntheticFrame();
      const reference = applyColorSettingsBuffer(source, { [key]: value });
      const result = matchColorParams(source, reference);
      expect(Math.abs((result.params[key] as number) - value)).toBeLessThan(tolerance);
    });
  }

  test("identity reference recovers a near-neutral grade", () => {
    const source = syntheticFrame();
    const result = matchColorParams(source, source);
    const matched = applyColorSettingsBuffer(source, result.params);
    const residual = statsDistance(computeStats(matched), computeStats(source));
    expect(residual).toBeLessThan(0.01);
  });
});

describe("cross-scene match", () => {
  // The realistic case: the reference is a different scene, so the fit can
  // only move the source's distribution toward the reference's, never onto it.
  test("moves a different scene toward the reference look", () => {
    const source = syntheticFrame(96, 96, 1);
    const otherScene = syntheticFrame(96, 96, 7);
    const reference = applyColorSettingsBuffer(otherScene, {
      exposure: 0.4,
      contrast: 1.3,
      "white-balance": 4500,
      "subtractive-sat": 0.75,
    });

    const result = matchColorParams(source, reference);
    expect(result.distance).toBeLessThan(result.baseline * 0.6);
    expect(result.params["white-balance"]).toBeLessThan(6500);
  });
});

describe("stats", () => {
  test("sampling caps pixel count and keeps channel order", () => {
    const frame = syntheticFrame(64, 64);
    const sampled = samplePixels(frame, 500);
    expect(sampled.length / 3).toBeLessThanOrEqual(500);
    expect(sampled.length % 3).toBe(0);
  });

  test("identical buffers have zero distance", () => {
    const frame = syntheticFrame(32, 32);
    expect(statsDistance(computeStats(frame), computeStats(frame))).toBe(0);
  });

  test("distance grows as a grade gets stronger", () => {
    const frame = syntheticFrame(32, 32);
    const base = computeStats(frame);
    const mild = computeStats(applyColorSettingsBuffer(frame, { exposure: 0.2 }));
    const strong = computeStats(applyColorSettingsBuffer(frame, { exposure: 1.2 }));
    expect(statsDistance(base, strong)).toBeGreaterThan(statsDistance(base, mild));
  });
});
