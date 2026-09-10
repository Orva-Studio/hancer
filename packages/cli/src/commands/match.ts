import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { matchReference, userPresetsDir, rebuildPresetIndex, type MatchedParams } from "@hance/core";

declare const HANCE_VERSION: string | undefined;
const VERSION: string = (typeof HANCE_VERSION !== "undefined" ? HANCE_VERSION : (process.env.HANCE_VERSION ?? "dev"));

const HELP_TEXT = `
hance match - read a reference image and print the Hance parameters that get closest to its look.

Usage: hance match <reference> <source> [options]

  <reference>   A still or clip whose look you want to copy
  <source>      The footage you want graded

Options:
  --save <name>   Save the result as a preset instead of printing flags
  --json          Print the parameters as JSON
  --help, -h      Show this help

Only colour parameters are matched. Grain, halation and the other optical
effects are left at their current values.

Examples:
  hance match still.jpg clip.mov                  print flags you can paste
  hance match still.jpg clip.mov --json           machine-readable output
  hance match still.jpg clip.mov --save mylook    save as a preset
  hance clip.mov $(hance match still.jpg clip.mov)  grade in one line
`.trim();

/**
 * Render the fitted parameters as CLI flags, skipping anything left at its
 * default. Rounding happens before the comparison: the solver lands on values
 * like 1.000004 that are a default in every sense that matters, and printing
 * them would bury the handful of flags that actually carry the look.
 */
export function formatMatchFlags(params: MatchedParams, defaults: MatchedParams): string[] {
  const flags: string[] = [];

  for (const [key, value] of Object.entries(params)) {
    const rounded = typeof value === "number" ? roundForFlag(key, value) : value;
    if (rounded === defaults[key]) continue;
    flags.push(`--${key}`, String(rounded));
  }

  return flags;
}

function roundForFlag(key: string, value: number): number {
  // Kelvin reads as a whole number; everything else is a 0-1ish slider.
  if (key === "white-balance") return Math.round(value);
  return Math.round(value * 1000) / 1000;
}

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

export async function runMatch(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    console.log(HELP_TEXT);
    return;
  }

  const positional = args.filter(a => !a.startsWith("-"));
  const saveIdx = args.indexOf("--save");
  const saveName = saveIdx !== -1 ? args[saveIdx + 1] : undefined;
  const asJson = args.includes("--json");

  // --save consumes the name after it, which would otherwise read as a path.
  const paths = positional.filter(a => a !== saveName);
  const [reference, source] = paths;

  if (!reference || !source) {
    console.error("Error: hance match needs a reference and a source. See hance match --help");
    process.exit(1);
  }

  for (const [label, file] of [["Reference", reference], ["Source", source]] as const) {
    if (!existsSync(file)) {
      console.error(`${label} not found: ${file}`);
      process.exit(1);
    }
  }

  const report = await matchReference(source, reference);

  if (asJson) {
    console.log(JSON.stringify({
      params: report.params,
      distance: report.distance,
      baseline: report.baseline,
      skipped: report.skipped,
    }, null, 2));
    return;
  }

  if (saveName) {
    const dir = userPresetsDir();
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${saveName}.hlook`);
    writeFileSync(file, JSON.stringify(
      { hance_version: VERSION, name: saveName, params: report.params }, null, 2));
    try { rebuildPresetIndex(); } catch (err) {
      console.error("preset index rebuild failed:", (err as Error).message);
    }
    process.stdout.write(path.resolve(file) + "\n");
    return;
  }

  console.log(formatMatchFlags(report.params, DEFAULTS).join(" "));
}
