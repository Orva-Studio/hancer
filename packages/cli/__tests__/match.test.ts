import { test, expect, describe } from "bun:test";
import { formatMatchFlags } from "../src/commands/match";
import { resolveSubcommand } from "../src/cli";
import type { MatchedParams } from "@hance/core";

const DEFAULTS: MatchedParams = {
  exposure: 0,
  contrast: 1,
  highlights: 0,
  fade: 0,
  "fade-color": "neutral",
  "white-balance": 6500,
  tint: 0,
  "subtractive-sat": 1,
};

describe("resolveSubcommand", () => {
  test("routes match", () => {
    expect(resolveSubcommand(["match", "a.jpg", "b.mov"])).toBe("match");
  });

  test("leaves other commands alone", () => {
    expect(resolveSubcommand(["clip.mov"])).toBe("render");
    expect(resolveSubcommand(["preset", "list"])).toBe("preset");
  });
});

describe("formatMatchFlags", () => {
  test("omits parameters left at their default", () => {
    expect(formatMatchFlags({ ...DEFAULTS }, DEFAULTS)).toEqual([]);
  });

  test("omits values that only differ below display precision", () => {
    const params = { ...DEFAULTS, contrast: 1.000004, "white-balance": 6500.06, fade: 1.5e-7 };
    expect(formatMatchFlags(params, DEFAULTS)).toEqual([]);
  });

  test("emits flags for parameters that moved", () => {
    const flags = formatMatchFlags({ ...DEFAULTS, exposure: 0.42 }, DEFAULTS);
    expect(flags).toEqual(["--exposure", "0.42"]);
  });

  test("rounds kelvin to a whole number", () => {
    const flags = formatMatchFlags({ ...DEFAULTS, "white-balance": 4218.32 }, DEFAULTS);
    expect(flags).toEqual(["--white-balance", "4218"]);
  });

  test("rounds sliders to three places", () => {
    const flags = formatMatchFlags({ ...DEFAULTS, "subtractive-sat": 0.9442309 }, DEFAULTS);
    expect(flags).toEqual(["--subtractive-sat", "0.944"]);
  });

  test("passes string parameters through", () => {
    const flags = formatMatchFlags({ ...DEFAULTS, fade: 0.4, "fade-color": "teal" }, DEFAULTS);
    expect(flags).toContain("--fade-color");
    expect(flags).toContain("teal");
  });

  test("output can be pasted back as argv", () => {
    const flags = formatMatchFlags({ ...DEFAULTS, exposure: 0.3, contrast: 1.2 }, DEFAULTS);
    expect(flags.length % 2).toBe(0);
    for (let i = 0; i < flags.length; i += 2) {
      expect(flags[i]!.startsWith("--")).toBe(true);
      expect(flags[i + 1]!.startsWith("--")).toBe(false);
    }
  });
});
