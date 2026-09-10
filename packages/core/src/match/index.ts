import { decodeSampleFrame } from "./decode";
import { matchColorParams, type MatchReport, type MatchOptions } from "./solve";

/**
 * Match the colour of `sourcePath` to the look of `referencePath`, returning
 * Hance parameters rather than a baked transform so the result stays editable.
 *
 * Both paths may be a still or a clip.
 */
export async function matchReference(
  sourcePath: string,
  referencePath: string,
  options?: MatchOptions,
): Promise<MatchReport> {
  const [source, reference] = await Promise.all([
    decodeSampleFrame(sourcePath),
    decodeSampleFrame(referencePath),
  ]);

  return matchColorParams(source, reference, options);
}

export { matchColorParams } from "./solve";
export type { MatchReport, MatchOptions, MatchedParams } from "./solve";
export { decodeSampleFrame, rgbBytesToFloats, SAMPLE_WIDTH, SAMPLE_HEIGHT } from "./decode";
export { computeStats, statsDistance, samplePixels, PERCENTILES } from "./stats";
export type { ColorStats } from "./stats";
