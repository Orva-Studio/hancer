import { test, expect, describe } from "bun:test";
import { rgbaToRgbFloats } from "../app/lib/readPixels";

describe("rgbaToRgbFloats", () => {
  test("drops alpha and normalises to 0-1", () => {
    const rgba = new Uint8ClampedArray([255, 128, 0, 255]);
    const rgb = rgbaToRgbFloats(rgba);
    expect(rgb.length).toBe(3);
    expect(rgb[0]).toBeCloseTo(1, 5);
    expect(rgb[1]).toBeCloseTo(128 / 255, 5);
    expect(rgb[2]).toBe(0);
  });

  test("keeps pixel order across several pixels", () => {
    const rgba = new Uint8ClampedArray([
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
    ]);
    const rgb = rgbaToRgbFloats(rgba);
    expect(rgb.length).toBe(9);
    expect(Array.from(rgb)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  test("a fully transparent pixel keeps its colour channels", () => {
    // The matcher never reads alpha, so transparency must not zero the colour.
    const rgb = rgbaToRgbFloats(new Uint8ClampedArray([255, 255, 255, 0]));
    expect(Array.from(rgb)).toEqual([1, 1, 1]);
  });

  test("empty input gives empty output", () => {
    expect(rgbaToRgbFloats(new Uint8ClampedArray(0)).length).toBe(0);
  });
});
