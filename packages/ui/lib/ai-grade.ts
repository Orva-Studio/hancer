import { EFFECT_SCHEMA } from "@hance/core";
import type { RangeOption, SelectOption } from "@hance/core";

/**
 * Asks a model to propose Hance parameters, either from the footage alone or
 * in response to an instruction.
 *
 * The model is never asked to measure the image. Testing showed it estimates
 * numbers from a picture poorly, inverting white balance on a warm frame; what
 * it does reliably is turn an instruction into named parameters, and judge
 * direction. So it proposes, the renderer stays authoritative, and the person
 * approves what they see.
 */

const ENDPOINT = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-5.6-luna";

/** Only colour carries a look. Motion and optical effects are left alone. */
const GROUPS = ["colorSettings", "splitTone", "colorWheels", "filmDensity"];

export interface AiGradeRequest {
  /** Current slider values, so an instruction edits rather than replaces. */
  params: Record<string, string | number | boolean>;
  /** A data URL of the current frame. */
  image?: string;
  /** What the user typed. Omitted for the opening proposal. */
  instruction?: string;
}

export interface AiGradeResult {
  params: Record<string, number | string>;
  note: string;
}

export function gradableOptions(): Array<RangeOption | SelectOption> {
  const out: Array<RangeOption | SelectOption> = [];
  for (const group of EFFECT_SCHEMA) {
    if (!GROUPS.includes(group.key)) continue;
    for (const opt of group.options) {
      if (opt.type === "range" || opt.type === "select") out.push(opt);
    }
  }
  return out;
}

/** The schema, rendered for the prompt so the model answers in Hance's own vocabulary. */
export function describeParams(): string {
  return gradableOptions().map(opt => {
    if (opt.type === "select") {
      return `- ${opt.key}: one of ${opt.choices.join("|")}, default ${opt.default}`;
    }
    return `- ${opt.key}: ${opt.min} to ${opt.max}, default ${opt.default}. ${opt.description}`;
  }).join("\n");
}

export function buildSystemPrompt(): string {
  return `You are a colour grading assistant for Hance, a film-look tool.
You propose values for Hance's own parameters. You never describe an image back to the user.

Parameters you may set:
${describeParams()}

Rules:
- white-balance is Kelvin. LOWER is warmer/orange, HIGHER is cooler/blue.
- Return only the parameters you want to change. Omit anything that should stay as it is.
- Respect every range. Never invent a parameter name that is not listed above.
- Prefer a restrained grade. A film look is usually a small move, not a large one.

Reply with JSON only:
{"params": {"<name>": <value>}, "note": "<one short sentence describing the look>"}`;
}

/** Drop anything the model invented or pushed out of range. */
export function sanitizeParams(raw: unknown): Record<string, number | string> {
  const clean: Record<string, number | string> = {};
  if (typeof raw !== "object" || raw === null) return clean;

  const allowed = new Map(gradableOptions().map(o => [o.key, o]));
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const opt = allowed.get(key);
    if (!opt) continue;

    if (opt.type === "select") {
      if (typeof value === "string" && opt.choices.includes(value)) clean[key] = value;
      continue;
    }
    // Only a number, or a string that is one. Number(null) and Number("") are
    // both 0, which would sail through a Number.isFinite check and silently
    // crush contrast or saturation to black.
    let n: number;
    if (typeof value === "number") n = value;
    else if (typeof value === "string" && value.trim() !== "") n = Number(value);
    else continue;
    if (!Number.isFinite(n)) continue;
    clean[key] = Math.min(opt.max, Math.max(opt.min, n));
  }
  return clean;
}

export async function proposeGrade(req: AiGradeRequest, apiKey: string): Promise<AiGradeResult> {
  const current = gradableOptions()
    .map(o => `${o.key}=${req.params[o.key] ?? o.default}`)
    .join(" ");

  const task = req.instruction
    ? `Current settings: ${current}\n\nThe user asks: "${req.instruction}"\nAdjust from the current settings.`
    : `Current settings: ${current}\n\nPropose a cinematic film look for this footage as a starting point.`;

  const content: unknown[] = [{ type: "text", text: task }];
  if (req.image) {
    content.push({ type: "image_url", image_url: { url: req.image, detail: "low" } });
  }

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content },
      ],
      response_format: { type: "json_object" },
    }),
  });

  const json = await res.json() as {
    error?: { message?: string };
    choices?: Array<{ message?: { content?: string } }>;
  };

  if (json.error) throw new Error(json.error.message || "The grading model refused the request");

  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error("The grading model returned nothing");

  let parsed: { params?: unknown; note?: unknown };
  try { parsed = JSON.parse(text); }
  catch { throw new Error("The grading model returned something that was not JSON"); }

  return {
    params: sanitizeParams(parsed.params),
    note: typeof parsed.note === "string" ? parsed.note : "",
  };
}
