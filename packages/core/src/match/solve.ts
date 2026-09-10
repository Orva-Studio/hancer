import { applyColorSettingsBuffer } from "../color-forward";
import { computeStats, statsDistance, samplePixels, type ColorStats } from "./stats";

type ParamValue = string | number;
export type MatchedParams = Record<string, ParamValue>;

export interface MatchOptions {
  /** Pixels sampled from each image before fitting. */
  maxPixels?: number;
  /** Coordinate-descent sweeps. Each sweep revisits every parameter. */
  passes?: number;
}

export interface MatchReport {
  params: MatchedParams;
  /** Statistical distance to the reference after fitting. */
  distance: number;
  /** Distance before fitting, for reporting how much the match moved. */
  baseline: number;
  /** Parameters the solve deliberately left alone, with the reason. */
  skipped: Array<{ key: string; reason: string }>;
}

/**
 * Solved in the order the shader applies them, so a parameter is fitted
 * against an input the earlier stages have already shaped. Coupled pairs
 * (fade lifts blacks *and* scales contrast) are resolved by sweeping more
 * than once rather than by solving them jointly.
 */
const SOLVE_ORDER: Array<{ key: string; lo: number; hi: number; def: number }> = [
  { key: "highlights", lo: -1, hi: 1, def: 0 },
  { key: "contrast", lo: 0.2, hi: 2.5, def: 1 },
  { key: "exposure", lo: -2, hi: 2, def: 0 },
  { key: "fade", lo: 0, hi: 1, def: 0 },
  { key: "white-balance", lo: 2000, hi: 14000, def: 6500 },
  { key: "tint", lo: -100, hi: 100, def: 0 },
  { key: "subtractive-sat", lo: 0, hi: 2.5, def: 1 },
];

/**
 * Exposure, contrast, highlights and fade all reshape the same tone curve, so
 * many combinations reproduce a look equally well and the fit alone cannot
 * choose between them. An L1 penalty on distance from the defaults breaks the
 * tie toward the sparsest explanation: leave a slider alone unless moving it
 * genuinely buys a better match. L1 rather than L2 because the goal is fewer
 * moved sliders, not smaller movements spread across all of them.
 */
const REGULARIZATION = 0.02;

const FADE_COLORS = ["neutral", "warm", "green", "teal", "magenta"] as const;

/** Below this the blacks are not lifted enough for a tint to be meaningful. */
const FADE_TINT_THRESHOLD = 0.02;

const GOLDEN = (Math.sqrt(5) - 1) / 2;

/**
 * Coarse scan then golden-section refine. The scan matters: the loss is not
 * reliably unimodal (clipping flattens it at the extremes), so starting a
 * bracketed search from the ends can settle into the wrong basin.
 */
function minimize1D(
  f: (x: number) => number,
  lo: number,
  hi: number,
  coarseSteps = 12,
  refineIters = 14,
): { x: number; value: number } {
  let bestX = lo;
  let bestValue = Infinity;

  for (let i = 0; i <= coarseSteps; i++) {
    const x = lo + ((hi - lo) * i) / coarseSteps;
    const value = f(x);
    if (value < bestValue) {
      bestValue = value;
      bestX = x;
    }
  }

  const step = (hi - lo) / coarseSteps;
  let a = Math.max(lo, bestX - step);
  let b = Math.min(hi, bestX + step);

  let c = b - GOLDEN * (b - a);
  let d = a + GOLDEN * (b - a);
  let fc = f(c);
  let fd = f(d);

  for (let i = 0; i < refineIters; i++) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - GOLDEN * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + GOLDEN * (b - a);
      fd = f(d);
    }
  }

  const x = (a + b) / 2;
  const value = f(x);
  return value < bestValue ? { x, value } : { x: bestX, value: bestValue };
}

/**
 * Nelder-Mead over the whole parameter vector, in normalised 0–1 space.
 *
 * Coordinate descent alone stalls here: exposure, contrast, highlights and
 * fade reshape the same tone curve, so the loss surface has long diagonal
 * valleys that no single-axis move can descend. The simplex can travel along
 * them. Coordinate descent still runs first: it lands close on the
 * separable parameters cheaply, and Nelder-Mead converges far faster from
 * there than from the defaults.
 */
function nelderMead(
  f: (x: number[]) => number,
  start: number[],
  step: number,
  maxIter: number,
): { x: number[]; value: number } {
  const n = start.length;
  const clampVec = (x: number[]) => x.map(v => (v < 0 ? 0 : v > 1 ? 1 : v));
  const evaluate = (x: number[]) => f(clampVec(x));

  const simplex: number[][] = [start.slice()];
  for (let i = 0; i < n; i++) {
    const point = start.slice();
    point[i] = point[i]! + (point[i]! + step > 1 ? -step : step);
    simplex.push(point);
  }

  let values = simplex.map(evaluate);

  for (let iter = 0; iter < maxIter; iter++) {
    const order = values.map((v, i) => i).sort((a, b) => values[a]! - values[b]!);
    const best = order[0]!;
    const worst = order[n]!;
    const secondWorst = order[n - 1]!;

    if (Math.abs(values[worst]! - values[best]!) < 1e-9) break;

    const centroid = new Array<number>(n).fill(0);
    for (const idx of order.slice(0, n)) {
      for (let i = 0; i < n; i++) centroid[i] = centroid[i]! + simplex[idx]![i]! / n;
    }

    const reflected = centroid.map((c, i) => c + (c - simplex[worst]![i]!));
    const fReflected = evaluate(reflected);

    if (fReflected < values[best]!) {
      const expanded = centroid.map((c, i) => c + 2 * (c - simplex[worst]![i]!));
      const fExpanded = evaluate(expanded);
      if (fExpanded < fReflected) {
        simplex[worst] = expanded;
        values[worst] = fExpanded;
      } else {
        simplex[worst] = reflected;
        values[worst] = fReflected;
      }
    } else if (fReflected < values[secondWorst]!) {
      simplex[worst] = reflected;
      values[worst] = fReflected;
    } else {
      const contracted = centroid.map((c, i) => c + 0.5 * (simplex[worst]![i]! - c));
      const fContracted = evaluate(contracted);
      if (fContracted < values[worst]!) {
        simplex[worst] = contracted;
        values[worst] = fContracted;
      } else {
        for (const idx of order.slice(1)) {
          simplex[idx] = simplex[idx]!.map((v, i) => simplex[best]![i]! + 0.5 * (v - simplex[best]![i]!));
        }
        values = simplex.map(evaluate);
      }
    }
  }

  let bestIdx = 0;
  for (let i = 1; i < values.length; i++) if (values[i]! < values[bestIdx]!) bestIdx = i;
  return { x: clampVec(simplex[bestIdx]!), value: values[bestIdx]! };
}

/**
 * Fit the colour-settings parameters that carry a look from `source` toward
 * the distribution of `reference`.
 *
 * Both buffers are interleaved RGB in 0–1. They are different scenes, so the
 * fit matches distributions, never pixels.
 */
export function matchColorParams(
  source: Float32Array,
  reference: Float32Array,
  options: MatchOptions = {},
): MatchReport {
  const maxPixels = options.maxPixels ?? 8000;
  const passes = options.passes ?? 3;

  const src = samplePixels(source, maxPixels);
  const refStats = computeStats(samplePixels(reference, maxPixels));

  const params: MatchedParams = {
    exposure: 0,
    contrast: 1,
    highlights: 0,
    fade: 0,
    "fade-color": "neutral",
    "white-balance": 6500,
    tint: 0,
    "subtractive-sat": 1,
  };

  const fit = (candidate: MatchedParams): number =>
    statsDistance(computeStats(applyColorSettingsBuffer(src, candidate)), refStats);

  const penalty = (candidate: MatchedParams): number => {
    let sum = 0;
    for (const { key, lo, hi, def } of SOLVE_ORDER) {
      sum += Math.abs((candidate[key] as number) - def) / (hi - lo);
    }
    return sum * REGULARIZATION;
  };

  const score = (candidate: MatchedParams): number => fit(candidate) + penalty(candidate);

  const baseline = fit(params);

  for (let pass = 0; pass < passes; pass++) {
    for (const { key, lo, hi } of SOLVE_ORDER) {
      const original = params[key]!;
      const best = minimize1D(x => {
        params[key] = x;
        return score(params);
      }, lo, hi);

      params[key] = best.value <= score({ ...params, [key]: original }) ? best.x : original;
    }
  }

  const toNormalized = (p: MatchedParams): number[] =>
    SOLVE_ORDER.map(({ key, lo, hi }) => ((p[key] as number) - lo) / (hi - lo));

  const fromNormalized = (x: number[]): MatchedParams => {
    const candidate: MatchedParams = { ...params };
    SOLVE_ORDER.forEach(({ key, lo, hi }, i) => {
      candidate[key] = lo + x[i]! * (hi - lo);
    });
    return candidate;
  };

  const polished = nelderMead(x => score(fromNormalized(x)), toNormalized(params), 0.08, 900);
  if (polished.value < score(params)) Object.assign(params, fromNormalized(polished.x));

  // Only worth searching once the blacks are actually lifted; a tint on
  // unlifted blacks is invisible and the search would pick a colour at random.
  if ((params.fade as number) > FADE_TINT_THRESHOLD) {
    let bestColor: string = params["fade-color"] as string;
    let bestValue = Infinity;
    for (const color of FADE_COLORS) {
      const value = score({ ...params, "fade-color": color });
      if (value < bestValue) {
        bestValue = value;
        bestColor = color;
      }
    }
    params["fade-color"] = bestColor;
  }

  return {
    params,
    distance: fit(params),
    baseline,
    skipped: [
      { key: "richness", reason: "multiplies subtractive-sat; the pair is not separable from one frame" },
      { key: "bleach-bypass", reason: "overlaps contrast and saturation; left to the user" },
    ],
  };
}
