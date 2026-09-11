import { existsSync, mkdirSync } from "node:fs";
import { probe, applyPreset, resolveExportPreset, requireCodecLicense, HANCE_PRO_URL } from "@hance/core";
import type { PresetData, FilmOptions, LicenseContext } from "@hance/core";
import { runGpuExport } from "@hance/gpu";
import { parseEffectFlags, EFFECT_HELP_TEXT } from "./effect-flags";
import { loadConfig, configToArgv } from "./config";
import path from "node:path";

declare const HANCE_VERSION: string | undefined;
const VERSION: string = (typeof HANCE_VERSION !== "undefined" ? HANCE_VERSION : (process.env.HANCE_VERSION ?? "dev"));

const HELP_TEXT = `
hance — applies cinematic film effects to video/images in one FFmpeg pass.

Usage: hance <input> [<input> ...] [options]

Commands:
  hance <input>...            render video/images with effects (default; flags below)
  hance ui [--port <n>]       launch the browser UI for live tweaking
  hance preview <input>       render a single preview frame or contact sheet
  hance preset list|save      list presets or save current flags as one
  hance config [path]         show the resolved config (or just its file path)
  hance skills [get <name>]   print the agent skill docs (for AI harnesses)

Start here:
  hance clip.mov                      apply the default look
  hance preset list                   list available presets
  hance <input> --preset <name>       the fast path — flags below are for fine-tuning

  Input/Output:
  --output, -o <path>       Output file (single input) or directory (multiple inputs).
                            Default: <input>_hanced.<ext> next to each input.
  --codec      <string>     Output codec: h264/prores/h265 (default: h264)
  --encode-preset <string>  FFmpeg preset: fast/medium/slow (default: medium)
  --crf        <0-51>       Quality — lower is better (default: 18, ignored for prores)
  --export     <preset>     Export quality: low/medium/high/max (default: none)
  --blend      <0-1>        Global blend with original (default: 1)

  Preset:
  --preset     <name>       Load a preset file (default: "default")

${EFFECT_HELP_TEXT}

  Config:
  --no-config               Ignore config file

  One config file is applied if present (a local file shadows the global one;
  CLI flags override it):
    ./.hancerc.json                       project config, searched upward from cwd
    ~/.config/hance/config.json           global config (used only if no local file)
  Run "hance config" to see which one is active and its values.

  General:
  --help, -h                Show this help
  --version, -v             Print version and exit

Examples:
  hance clip.mov                                  default look, writes clip_hanced.mov
  hance clip.mov -o out.mp4 --preset portra-400   apply a named preset to a chosen output
  hance *.jpg -o ./graded/ --export high          batch images into a directory, high-quality export
  hance shot.mov --grain-iso 800 --no-halation   tweak one effect, disable another
  hance shot.mov --exposure 0.5 --contrast 1.2    quick color grade
  hance preset save mylook --bleach-bypass 0.4    save current flags as a reusable preset

Agents: run "hance skills" first for the agent skill router.
Docs: https://hance.video/docs  (agent guide: https://hance.video/docs/agent/overview)
`.trim();

export type Subcommand = "ui" | "preview" | "preset" | "config" | "skills" | "render";

export function resolveSubcommand(args: string[]): Subcommand {
  switch (args[0]) {
    case "ui": return "ui";
    case "preview": return "preview";
    case "preset": return "preset";
    case "config": return "config";
    case "skills": return "skills";
    default: return "render";
  }
}

export function isSubcommand(args: string[]): boolean {
  return resolveSubcommand(args) === "ui";
}

export interface UiArgs {
  port: number;
  open: boolean;
  initialFile?: string;
}

export function parseUiArgs(subArgs: string[]): UiArgs {
  const portIdx = subArgs.indexOf("--port");
  const port = portIdx !== -1 ? parseInt(subArgs[portIdx + 1], 10) : 4800;
  const open = !subArgs.includes("--no-open");
  let initialFile: string | undefined;
  for (let j = 0; j < subArgs.length; j++) {
    const a = subArgs[j];
    if (a === "--port") { j++; continue; }
    if (a === "--no-open") continue;
    if (!a.startsWith("-")) { initialFile = a; break; }
  }
  return { port, open, initialFile };
}

export function getDefaultOutput(inputPath: string): string {
  const ext = path.extname(inputPath);
  const base = inputPath.slice(0, -ext.length);
  return `${base}_hanced${ext}`;
}

interface ParsedArgs extends FilmOptions {
  help: boolean;
  params: PresetData;
  inputs: string[];
  outputs: string[];
  outputArg: string;
}

export async function parseArgs(argv: string[], license?: LicenseContext): Promise<ParsedArgs> {
  const noConfig = argv.includes("--no-config");
  const filteredArgv = noConfig ? argv.filter(a => a !== "--no-config") : argv;

  let mergedArgv: string[];
  if (noConfig) {
    mergedArgv = filteredArgv;
  } else {
    const { config } = await loadConfig();
    const configArgv = configToArgv(config);
    mergedArgv = [...configArgv, ...filteredArgv];
  }

  const r = parseEffectFlags(mergedArgv);
  const inputs = r.positional;

  if (!r.help && inputs.length === 0) {
    throw new Error("No input file provided. Usage: hance <input> [<input> ...] [options]");
  }

  const outputs: string[] = [];
  if (r.outputArg && inputs.length > 1) {
    for (const inp of inputs) outputs.push(path.join(r.outputArg, getDefaultOutput(path.basename(inp))));
  } else if (r.outputArg) {
    outputs.push(r.outputArg);
  } else {
    for (const inp of inputs) outputs.push(getDefaultOutput(inp));
  }

  const effectOpts = applyPreset(r.presetName, r.overrides);
  const params = effectOpts.mergedParams;

  let resolvedCodec = effectOpts.codec;
  let resolvedCrf = effectOpts.crf;
  let resolvedEncodePreset = effectOpts.encodePreset;
  let resolvedPixelFormat = effectOpts.pixelFormat;

  if (r.exportPreset) {
    const exp = resolveExportPreset(r.exportPreset, {
      codec: r.overrideCodec, crf: r.overrideCrf, encodePreset: r.overrideEncodePreset,
    }, license);
    resolvedCodec = exp.codec;
    resolvedCrf = exp.crf;
    resolvedEncodePreset = exp.encodePreset;
    resolvedPixelFormat = exp.pixelFormat;
    if (r.exportPreset === "high" || r.exportPreset === "max") {
      console.error("High quality export — expect larger file sizes");
    }
  }

  requireCodecLicense(resolvedCodec, license);

  return {
    inputs, outputs, outputArg: r.outputArg,
    encodePreset: resolvedEncodePreset, codec: resolvedCodec, crf: resolvedCrf,
    blend: effectOpts.blend, pixelFormat: resolvedPixelFormat,
    colorSettings: effectOpts.colorSettings, halation: effectOpts.halation,
    aberration: effectOpts.aberration, bloom: effectOpts.bloom,
    grain: effectOpts.grain, vignette: effectOpts.vignette,
    splitTone: effectOpts.splitTone, cameraShake: effectOpts.cameraShake,
    params, help: r.help,
  };
}

async function checkDependency(name: string): Promise<void> {
  const proc = Bun.spawn(["which", name], { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error(`${name} not found. Install with: brew install ffmpeg`);
    process.exit(1);
  }
}

function resolveLicense(): LicenseContext {
  const tier = process.env.HANCE_LICENSE === "pro" ? "pro" : "free";
  return { tier };
}

async function main() {
  const args = process.argv.slice(2);
  const license = resolveLicense();

  if (args.includes("--version") || args.includes("-v")) {
    console.log(`hance ${VERSION}`);
    process.exit(0);
  }

  const sub = resolveSubcommand(args);
  if (sub === "ui") {
    const { startUI } = await import("@hance/ui/server");
    const { port, open, initialFile: rawFile } = parseUiArgs(args.slice(1));
    let initialFile: string | undefined;
    if (rawFile) {
      initialFile = path.resolve(rawFile);
      if (!existsSync(initialFile)) {
        console.error(`File not found: ${initialFile}`);
        process.exit(1);
      }
    }
    await startUI(port, open, initialFile);
    return;
  }
  if (sub === "preview") {
    const { runPreview } = await import("./commands/preview");
    await runPreview(args.slice(1));
    return;
  }
  if (sub === "preset") {
    const { runPreset } = await import("./commands/preset");
    await runPreset(args.slice(1));
    return;
  }
  if (sub === "config") {
    const { runConfig } = await import("./commands/config");
    await runConfig(args.slice(1));
    return;
  }

  if (sub === "skills") {
    const { runSkills } = await import("./commands/skills");
    await runSkills(args.slice(1));
    return;
  }

  let parsed: ParsedArgs;
  try {
    parsed = await parseArgs(args, license);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  if (parsed.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  await Promise.all([checkDependency("ffmpeg"), checkDependency("ffprobe")]);

  const isBatch = parsed.inputs.length > 1;

  if (isBatch && license.tier !== "pro") {
    console.error(`Batch processing requires a pro license. Process one file at a time, or upgrade at ${HANCE_PRO_URL}`);
    process.exit(1);
  }

  if (!isBatch) {
    if (!existsSync(parsed.inputs[0])) {
      console.error(`Input file not found: ${parsed.inputs[0]}`);
      process.exit(1);
    }
  }

  if (isBatch && parsed.outputArg) {
    mkdirSync(parsed.outputArg, { recursive: true });
  }

  if (isBatch) {
    const seen = new Set<string>();
    for (const out of parsed.outputs) {
      if (seen.has(out)) {
        console.warn(`Warning: multiple inputs resolve to the same output path and will overwrite each other: ${out}`);
      }
      seen.add(out);
    }
  }

  const total = parsed.inputs.length;
  const failures: { input: string; error: string }[] = [];

  for (let idx = 0; idx < total; idx++) {
    const input = parsed.inputs[idx];
    const output = parsed.outputs[idx];
    const prefix = isBatch ? `[${idx + 1}/${total}] ` : "";

    try {
      if (isBatch && !existsSync(input)) {
        throw new Error(`Input file not found: ${input}`);
      }
      const probeResult = await probe(input);

      console.log(`${prefix}Input:  ${input}${probeResult.isImage ? " (image)" : ""}`);
      console.log(`${" ".repeat(prefix.length)}Output: ${output}`);

      if (probeResult.isImage) {
        process.stdout.write(`${prefix}Processing...\n`);
        const { renderImage } = await import("@hance/gpu");
        await renderImage(input, output, probeResult.width!, probeResult.height!, parsed.params);
        console.log(`${prefix}Done.`);
      } else {
        await runGpuExport(input, output, parsed.params, probeResult, (ratio) => {
          const pct = Math.round(ratio * 100);
          process.stdout.write(`\r${prefix}Processing... ${pct}%`);
        }, { codec: parsed.codec, crf: parsed.crf, encodePreset: parsed.encodePreset, pixelFormat: parsed.pixelFormat });
        process.stdout.write("\n");
      }
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`${prefix}Failed: ${msg}`);
      failures.push({ input, error: msg });
      if (!isBatch) process.exit(1);
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length}/${total} input(s) failed.`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
