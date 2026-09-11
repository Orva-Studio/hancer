import { EFFECT_SCHEMA, seedDefaults, loadPreset, builtinPresetsDir, userPresetsDir, listPresetNames, probe, rebuildPresetIndex, requireCodecLicense } from "@hance/core";
import type { PresetData, LicenseContext } from "@hance/core";
import { runGpuExport, bakeLutCube } from "@hance/gpu";
import { join, extname, basename, resolve, dirname } from "node:path";
import { existsSync, readdirSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { streamFragmentedMp4, proxyDonePath } from "./lib/transcode";
import { proposeGrade } from "./lib/ai-grade";
import pkg from "./package.json";

const pkgVersion: string = pkg.version;

// Throwing a non-Error is legal in JS, and `(err as Error).message` on one
// reads back as the string "undefined" — worse than useless in a message the
// user is meant to act on.
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Cache key from cheap file metadata (name + size + mtime), so a cache hit can
// be detected from a tiny lookup request without uploading or hashing the whole
// multi-GB source. A different file sharing all three is vanishingly unlikely.
function proxyKey(name: string, size: number, lastModified: number): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${name}:${size}:${lastModified}`);
  return hasher.digest("hex").slice(0, 16);
}

// Total bytes of the proxy cache dir, so the client can warn when it grows
// large. Cheap stat walk over a flat directory.
function proxyCacheBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const name of readdirSync(dir)) {
    try { total += statSync(join(dir, name)).size; } catch {}
  }
  return total;
}

// Resolve a client-supplied path and confirm it stays inside `allowedDir`,
// defeating `..` traversal that a raw startsWith() check would let through.
// Returns the normalized path only if it exists within the dir, else null.
function resolveWithinDir(rawPath: string | null, allowedDir: string): string | null {
  if (!rawPath) return null;
  const resolved = resolve(rawPath);
  const root = resolve(allowedDir);
  if (resolved !== root && !resolved.startsWith(root + "/")) return null;
  if (!existsSync(resolved)) return null;
  return resolved;
}

function safeExt(name: string): string {
  const ext = extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : "";
}

function preparePresetWrite(name: unknown, data: unknown): { ok: true; path: string } | { ok: false; res: Response } {
  if (!name || !data) return { ok: false, res: new Response("name and data required", { status: 400 }) };
  const dir = userPresetsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return { ok: true, path: join(dir, `${name}.hlook`) };
}

function listLooks(): string[] {
  return listPresetNames();
}

let initialFilePath: string | null = null;
const allowedFilePaths = new Set<string>();

export function allowFilePath(path: string): void {
  allowedFilePaths.add(resolve(path));
}

export function setInitialFile(path: string | null): void {
  initialFilePath = path;
}

function safeRebuildIndex(): void {
  try { rebuildPresetIndex(); } catch (err) { console.error("preset index rebuild failed:", err); }
}

export interface RecentEntry {
  path: string;
  name: string;
  thumbnail?: string;
  activeLook?: string;
  openedAt: number;
}

const MAX_RECENTS = 12;
// Data-URL thumbnails live inline in recents.json; cap each so the file stays small.
const MAX_THUMBNAIL_CHARS = 200_000;

// HANCE_RECENTS_PATH override exists for tests, which must not touch the
// user's real ~/.hance/recents.json.
function recentsPath(): string {
  return process.env.HANCE_RECENTS_PATH ?? join(homedir(), ".hance", "recents.json");
}

function readRecents(): RecentEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(recentsPath(), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is RecentEntry => typeof e?.path === "string" && typeof e?.name === "string",
    );
  } catch {
    return [];
  }
}

function writeRecents(entries: RecentEntry[]): void {
  const path = recentsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(entries, null, 2));
}

export interface ServerHooks {
  // Native "open file" dialog, provided by the desktop shell. Returns the
  // chosen absolute path, or null if the user cancelled. Absent in browser/CLI
  // mode, where /api/pick-file 404s and the UI falls back to <input type=file>.
  pickFile?: () => Promise<string | null>;
}

export function createServer(port: number, hostname?: string, distDir?: string, hooks?: ServerHooks) {
  return Bun.serve({
    port,
    ...(hostname ? { hostname } : {}),
    maxRequestBodySize: 1024 * 1024 * 1024 * 16,
    async fetch(req) {
      const url = new URL(req.url);

      // Reject requests whose Host header is not a loopback name. The server
      // only ever binds localhost, but a DNS-rebinding page (attacker domain
      // resolving to 127.0.0.1) would otherwise reach the API — including
      // /api/local-file reads and native /api/pick-file dialogs — because the
      // browser treats it as same-origin with the attacker's site.
      if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
        return new Response("Forbidden", { status: 403 });
      }

      if (url.pathname === "/api/schema") {
        return Response.json(EFFECT_SCHEMA);
      }

      if (url.pathname === "/api/license") {
        const tier = process.env.HANCE_LICENSE === "pro" ? "pro" : "free";
        return Response.json({ tier });
      }

      // Bakes the current look into a .cube 3D LUT. Runs in the GPU sidecar
      // rather than the webview so the LUT comes from the same renderer as a
      // real export. Reached only from the desktop app's File menu.
      if (url.pathname === "/api/lut" && req.method === "POST") {
        let body: { params?: Record<string, string | number | boolean>; title?: string };
        try {
          body = await req.json() as typeof body;
        } catch {
          return new Response("Invalid JSON body", { status: 400 });
        }
        if (!body.params || typeof body.params !== "object" || Array.isArray(body.params)) {
          return new Response("Missing params", { status: 400 });
        }
        if (body.title !== undefined && typeof body.title !== "string") {
          return new Response("title must be a string", { status: 400 });
        }
        try {
          const cube = await bakeLutCube(body.params, body.title || "Hance");
          return new Response(cube, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
        } catch (err) {
          return new Response(`LUT bake failed: ${errorMessage(err)}`, { status: 500 });
        }
      }

      if (url.pathname === "/api/ai-grade" && req.method === "POST") {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
          return Response.json(
            { error: "Set OPENAI_API_KEY to use AI adjustments." }, { status: 503 });
        }
        let body: { params?: Record<string, string | number | boolean>; image?: string; instruction?: string };
        try { body = await req.json() as typeof body; }
        catch { return new Response("Invalid JSON body", { status: 400 }); }
        if (!body.params || typeof body.params !== "object") {
          return new Response("Missing params", { status: 400 });
        }
        try {
          const result = await proposeGrade({
            params: body.params,
            image: typeof body.image === "string" ? body.image : undefined,
            instruction: typeof body.instruction === "string" ? body.instruction : undefined,
          }, apiKey);
          return Response.json(result);
        } catch (err) {
          return Response.json({ error: errorMessage(err) }, { status: 502 });
        }
      }

      if (url.pathname === "/api/version") {
        return Response.json({ version: pkgVersion });
      }

      if (url.pathname === "/api/initial-file" && req.method === "GET") {
        if (!initialFilePath || !existsSync(initialFilePath)) {
          return new Response("no initial file", { status: 404 });
        }
        const file = Bun.file(initialFilePath);
        const name = initialFilePath.split("/").pop() || "file";
        return new Response(file, {
          headers: {
            "X-Filename": encodeURIComponent(name),
            "Content-Type": file.type || "application/octet-stream",
          },
        });
      }

      if (url.pathname === "/api/pick-file" && req.method === "POST") {
        if (!hooks?.pickFile) return new Response("Not supported", { status: 404 });
        const picked = await hooks.pickFile();
        if (!picked) return new Response(null, { status: 204 });
        const path = resolve(picked);
        allowedFilePaths.add(path);
        return Response.json({ path, name: basename(path) });
      }

      if (url.pathname === "/api/recents" && req.method === "GET") {
        const entries = readRecents().filter(e => existsSync(e.path));
        // Recents came from paths the user picked natively; re-allow them so
        // /api/local-file can serve them after a restart.
        for (const e of entries) allowedFilePaths.add(resolve(e.path));
        return Response.json(entries);
      }

      if (url.pathname === "/api/recents" && req.method === "POST") {
        let body: { path?: unknown; name?: unknown; thumbnail?: unknown; activeLook?: unknown };
        try { body = await req.json(); } catch {
          return new Response("invalid JSON", { status: 400 });
        }
        if (typeof body.path !== "string" || typeof body.name !== "string") {
          return new Response("path and name required", { status: 400 });
        }
        const path = resolve(body.path);
        // Only paths already vetted (native picker, CLI initial file, prior
        // recents) may enter the list — GET re-allows every stored entry, so
        // accepting arbitrary paths here would let the page whitelist any file.
        if (!allowedFilePaths.has(path)) {
          return new Response("unknown file", { status: 403 });
        }
        const thumbnail =
          typeof body.thumbnail === "string" && body.thumbnail.length <= MAX_THUMBNAIL_CHARS
            ? body.thumbnail
            : readRecents().find(e => resolve(e.path) === path)?.thumbnail;
        const activeLook = typeof body.activeLook === "string" ? body.activeLook : undefined;
        const entry: RecentEntry = { path, name: body.name, thumbnail, activeLook, openedAt: Date.now() };
        const entries = [entry, ...readRecents().filter(e => resolve(e.path) !== path)].slice(0, MAX_RECENTS);
        writeRecents(entries);
        return Response.json(entries);
      }

      if (url.pathname === "/api/local-file" && (req.method === "GET" || req.method === "HEAD")) {
        const rawPath = url.searchParams.get("path");
        const filePath = rawPath ? resolve(rawPath) : null;
        if (!filePath || !allowedFilePaths.has(filePath) || !existsSync(filePath)) {
          return new Response("File not found", { status: 404 });
        }
        const file = Bun.file(filePath);
        // Accept-Ranges lets the desktop WKWebView <video> play the original
        // file (e.g. ProRes .mov) straight off disk with seeking — Bun.serve
        // answers Range requests on Bun.file bodies automatically.
        return new Response(file, {
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "Accept-Ranges": "bytes",
          },
        });
      }

      if (url.pathname === "/api/looks" && req.method === "GET") {
        return Response.json(listLooks());
      }

      if (url.pathname === "/api/look/info" && req.method === "GET") {
        const name = url.searchParams.get("name") || "default";
        try {
          const raw = loadPreset(name);
          const params = raw.params ?? raw;
          return Response.json({
            name: raw.name ?? name,
            description: raw.description ?? "",
            keywords: raw.keywords ?? [],
            characteristics: raw.characteristics ?? [],
            params,
          });
        } catch {
          return new Response("Look not found", { status: 404 });
        }
      }

      if (url.pathname === "/api/look" && req.method === "GET") {
        const name = url.searchParams.get("name") || "default";
        try {
          const raw = loadPreset(name);
          // .hlook files have params nested; .json files have them at top level.
          // Seed schema defaults so the renderer receives fully-populated params
          // (single defaults source — see seedDefaults).
          const params = seedDefaults(raw.params ?? raw);
          return Response.json(params);
        } catch {
          return new Response("Look not found", { status: 404 });
        }
      }

      if (url.pathname === "/api/looks" && req.method === "POST") {
        const body = await req.json();
        const { name, data, description, keywords, characteristics } = body;
        const prep = preparePresetWrite(name, data);
        if (!prep.ok) return prep.res;
        const lookData = { name, description: description || "", keywords: keywords || [], characteristics: characteristics || [], params: data };
        writeFileSync(prep.path, JSON.stringify(lookData, null, 2));
        safeRebuildIndex();
        return Response.json({ ok: true });
      }

      if (url.pathname === "/api/look" && req.method === "PUT") {
        const body = await req.json();
        const { name, data } = body;
        const prep = preparePresetWrite(name, data);
        if (!prep.ok) return prep.res;
        const filePath = prep.path;
        let existing: Record<string, unknown> = {};
        try {
          existing = JSON.parse(await Bun.file(filePath).text());
        } catch {
          for (const ext of [".hlook", ".json"]) {
            const builtinPath = join(builtinPresetsDir(), `${name}${ext}`);
            if (existsSync(builtinPath)) {
              try { existing = JSON.parse(await Bun.file(builtinPath).text()); } catch {}
              break;
            }
          }
        }
        const updated = { ...existing, params: data };
        writeFileSync(filePath, JSON.stringify(updated, null, 2));
        safeRebuildIndex();
        return Response.json({ ok: true });
      }

      if (url.pathname === "/api/look" && req.method === "DELETE") {
        const name = url.searchParams.get("name");
        if (!name) return new Response("name required", { status: 400 });
        for (const dir of [userPresetsDir(), builtinPresetsDir()]) {
          for (const ext of [".hlook", ".json"]) {
            const filePath = join(dir, `${name}${ext}`);
            if (existsSync(filePath)) unlinkSync(filePath);
          }
        }
        safeRebuildIndex();
        return Response.json({ ok: true });
      }

      if (url.pathname === "/api/look/rename" && req.method === "POST") {
        const body = await req.json();
        const { oldName, newName } = body;
        if (!oldName || !newName) return new Response("oldName and newName required", { status: 400 });
        for (const dir of [userPresetsDir(), builtinPresetsDir()]) {
          for (const ext of [".hlook", ".json"]) {
            const oldPath = join(dir, `${oldName}${ext}`);
            if (existsSync(oldPath)) {
              const newPath = join(dir, `${newName}.hlook`);
              renameSync(oldPath, newPath);
              safeRebuildIndex();
              return Response.json({ ok: true });
            }
          }
        }
        return new Response("Look not found", { status: 404 });
      }

      if (url.pathname === "/api/look/import" && req.method === "POST") {
        const formData = await req.formData();
        const file = formData.get("file") as File | null;
        if (!file || !file.name.endsWith(".hlook")) {
          return new Response("Valid .hlook file required", { status: 400 });
        }
        const text = await file.text();
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(text);
        } catch {
          return new Response("Invalid JSON in .hlook file", { status: 400 });
        }
        const dir = userPresetsDir();
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        // The look is stored under its internal `name`, not the filename, so
        // importing clay_new.hlook whose name is "clay" replaces an existing
        // "clay". Report that back — silently overwriting looks identical to
        // the import doing nothing at all.
        const name = (parsed.name as string) || file.name.replace(".hlook", "");
        // `name` comes from inside the uploaded file, so it is attacker-chosen:
        // a look named "../../evil" would write outside the presets dir. Only a
        // single plain path segment names a look.
        if (typeof name !== "string" || name !== basename(name) || name === "." || name === "..") {
          return new Response("Invalid look name", { status: 400 });
        }
        const target = join(dir, `${name}.hlook`);
        const overwritten = existsSync(target);
        writeFileSync(target, JSON.stringify(parsed, null, 2));
        safeRebuildIndex();
        return Response.json({ ok: true, name, overwritten });
      }

      if (url.pathname === "/api/export" && req.method === "POST") {
        const formData = await req.formData();
        const file = formData.get("file") as File | null;
        const sourcePathRaw = formData.get("sourcePath");
        const paramsJson = formData.get("params") as string | null;
        if ((!file && typeof sourcePathRaw !== "string") || !paramsJson) {
          return new Response("file or sourcePath, and params required", { status: 400 });
        }

        const params: PresetData = JSON.parse(paramsJson);
        const codecLabel = String(formData.get("codec") ?? "H.264");
        const crf = Number(formData.get("crf") ?? 23);
        const outputName = String(formData.get("outputName") ?? "");
        const codec: "h264" | "h265" | "prores" =
          codecLabel === "ProRes 422" ? "prores" :
          codecLabel === "H.265" ? "h265" : "h264";

        const license: LicenseContext = { tier: process.env.HANCE_LICENSE === "pro" ? "pro" : "free" };
        try {
          requireCodecLicense(codec, license);
        } catch (err) {
          return new Response((err as Error).message, { status: 403 });
        }

        const pixelFormat = codec === "prores" ? "yuv422p10le" : "yuv420p";
        const tempDir = join(tmpdir(), "hance-export");
        if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });
        // Desktop path lane: export reads the vetted local file in place, so
        // the source is never uploaded or copied into the temp dir.
        let inputPath: string;
        if (typeof sourcePathRaw === "string") {
          const p = resolve(sourcePathRaw);
          if (!allowedFilePaths.has(p) || !existsSync(p)) {
            return new Response("File not found", { status: 404 });
          }
          inputPath = p;
        } else {
          inputPath = join(tempDir, file!.name);
          await Bun.write(inputPath, file!);
        }

        const probeResult = await probe(inputPath);

        if (probeResult.isImage) {
          return new Response("Image export is handled client-side", { status: 400 });
        }

        const defaultExt = codec === "prores" ? "mov" : "mp4";
        const candidate = outputName ? basename(outputName) : "";
        const safeName = /^[A-Za-z0-9._-]+\.(mp4|mov)$/.test(candidate)
          ? candidate
          : `export_${Date.now()}.${defaultExt}`;
        const outputPath = join(tempDir, safeName);

        const stream = new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();
            try {
              await runGpuExport(
                inputPath,
                outputPath,
                params as Record<string, unknown>,
                probeResult,
                (ratio) => {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ progress: ratio })}\n\n`));
                },
                { codec, crf, encodePreset: "medium", pixelFormat: pixelFormat as "yuv420p" | "yuv422p10le" },
                req.signal,
              );
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, downloadUrl: `/api/download?path=${encodeURIComponent(outputPath)}` })}\n\n`));
            } catch (err) {
              // On cancel the client has already gone away, so there is no one
              // to receive an error frame and enqueueing on the closed stream
              // would itself throw. Stay silent and just close.
              if (!req.signal.aborted) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: (err as Error).message })}\n\n`));
              }
            }
            try { controller.close(); } catch { /* stream already torn down by the abort */ }
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          },
        });
      }

      // Cheap cache probe: the client sends only file metadata, so a hit costs
      // no upload and no hashing. Miss falls through to the streaming POST.
      if (url.pathname === "/api/proxy/lookup" && req.method === "POST") {
        const { name, size, lastModified } = await req.json();
        const proxyDir = join(tmpdir(), "hance-proxy");
        const outputPath = join(proxyDir, `proxy_${proxyKey(name, size, lastModified)}.mp4`);
        const donePath = proxyDonePath(outputPath);
        const hit = existsSync(outputPath) && existsSync(donePath);
        return Response.json({
          cached: hit,
          proxyPath: hit ? outputPath : null,
          durationSec: hit ? Number(readFileSync(donePath, "utf8").trim()) || 0 : 0,
          cacheBytes: proxyCacheBytes(proxyDir),
        });
      }

      if (url.pathname === "/api/proxy" && req.method === "POST") {
        const formData = await req.formData();
        const file = formData.get("file") as File | null;
        if (!file) return new Response("file required", { status: 400 });

        const proxyDir = join(tmpdir(), "hance-proxy");
        mkdirSync(proxyDir, { recursive: true });
        const id = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        const inputPath = join(proxyDir, `input_${id}${safeExt(file.name)}`);
        await Bun.write(inputPath, file);

        // Key the proxy by the same metadata the lookup uses, so a later upload
        // of the same file is found without re-transcoding. The .done marker
        // means the file is complete (a partial proxy has none and is rebuilt).
        const lastModified = Number(formData.get("lastModified") ?? file.lastModified ?? 0);
        const outputPath = join(proxyDir, `proxy_${proxyKey(file.name, file.size, lastModified)}.mp4`);
        const donePath = proxyDonePath(outputPath);
        if (existsSync(outputPath) && existsSync(donePath)) {
          try { unlinkSync(inputPath); } catch {}
          const cachedDuration = readFileSync(donePath, "utf8").trim();
          return new Response(Bun.file(outputPath), {
            headers: {
              "Content-Type": "video/mp4",
              "Cache-Control": "no-store",
              "X-Proxy-Duration": cachedDuration || "0",
              "X-Proxy-Path": outputPath,
              "X-Proxy-Cached": "1",
              "X-Proxy-Cache-Bytes": String(proxyCacheBytes(proxyDir)),
            },
          });
        }

        let proxy;
        try {
          proxy = await streamFragmentedMp4(inputPath, outputPath);
        } catch (err) {
          try { unlinkSync(inputPath); } catch {}
          return new Response((err as Error).message, { status: 500 });
        }

        const reader = proxy.stream.getReader();
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                controller.enqueue(value);
              }
              controller.close();
            } catch (err) {
              controller.error(err);
            } finally {
              try { unlinkSync(inputPath); } catch {}
            }
          },
          cancel() {
            reader.cancel();
            try { unlinkSync(inputPath); } catch {}
          },
        });

        return new Response(body, {
          headers: {
            "Content-Type": "video/mp4",
            "Cache-Control": "no-store",
            "X-Proxy-Duration": String(proxy.durationSec),
            "X-Proxy-Path": outputPath,
            "X-Proxy-Cache-Bytes": String(proxyCacheBytes(proxyDir)),
          },
        });
      }

      // Desktop path lane: transcode straight from a vetted local path, so a
      // file already on disk is never uploaded (or copied) before ffmpeg
      // reads it. Same cache key/dir as /api/proxy, so both lanes share hits.
      if (url.pathname === "/api/proxy/from-path" && req.method === "POST") {
        let body: { path?: unknown };
        try { body = await req.json(); } catch {
          return new Response("invalid JSON", { status: 400 });
        }
        if (typeof body.path !== "string") {
          return new Response("path required", { status: 400 });
        }
        const inputPath = resolve(body.path);
        // Same vetting as /api/local-file: only paths from the native picker,
        // CLI initial file, or stored recents may be read.
        if (!allowedFilePaths.has(inputPath) || !existsSync(inputPath)) {
          return new Response("File not found", { status: 404 });
        }

        const proxyDir = join(tmpdir(), "hance-proxy");
        mkdirSync(proxyDir, { recursive: true });
        const stat = statSync(inputPath);
        const outputPath = join(
          proxyDir,
          `proxy_${proxyKey(basename(inputPath), stat.size, Math.floor(stat.mtimeMs))}.mp4`,
        );
        const donePath = proxyDonePath(outputPath);
        if (existsSync(outputPath) && existsSync(donePath)) {
          const cachedDuration = readFileSync(donePath, "utf8").trim();
          return new Response(Bun.file(outputPath), {
            headers: {
              "Content-Type": "video/mp4",
              "Cache-Control": "no-store",
              "X-Proxy-Duration": cachedDuration || "0",
              "X-Proxy-Path": outputPath,
              "X-Proxy-Cached": "1",
              "X-Proxy-Cache-Bytes": String(proxyCacheBytes(proxyDir)),
            },
          });
        }

        let proxy;
        try {
          proxy = await streamFragmentedMp4(inputPath, outputPath);
        } catch (err) {
          return new Response((err as Error).message, { status: 500 });
        }
        // No input cleanup here: the input is the user's own file, not an
        // uploaded temp copy.
        return new Response(proxy.stream, {
          headers: {
            "Content-Type": "video/mp4",
            "Cache-Control": "no-store",
            "X-Proxy-Duration": String(proxy.durationSec),
            "X-Proxy-Path": outputPath,
            "X-Proxy-Cache-Bytes": String(proxyCacheBytes(proxyDir)),
          },
        });
      }

      if (url.pathname === "/api/proxy-file" && req.method === "GET") {
        const filePath = resolveWithinDir(url.searchParams.get("path"), join(tmpdir(), "hance-proxy"));
        if (!filePath) {
          return new Response("File not found", { status: 404 });
        }
        return new Response(Bun.file(filePath), {
          headers: {
            "Content-Type": "video/mp4",
            "Accept-Ranges": "bytes",
          },
        });
      }

      if (url.pathname === "/api/download" && req.method === "GET") {
        const filePath = resolveWithinDir(url.searchParams.get("path"), join(tmpdir(), "hance-export"));
        if (!filePath) {
          return new Response("File not found", { status: 404 });
        }
        return new Response(Bun.file(filePath), {
          headers: { "Content-Disposition": `attachment; filename="${filePath.split("/").pop()}"` },
        });
      }

      // Static file serving (SPA)
      const localDist = distDir ?? join(import.meta.dir, "dist");
      const staticDir = existsSync(localDist) ? localDist : join(homedir(), ".hance", "ui");
      const filePath = join(staticDir, url.pathname === "/" ? "index.html" : url.pathname);
      // no-store on everything: dist assets are not content-hashed
      // (index.js/index.css), so any cached copy can go stale after a
      // rebuild - WKWebView in the desktop shell caches aggressively.
      const noStore = { "Cache-Control": "no-store" };
      if (existsSync(filePath)) {
        return new Response(Bun.file(filePath), { headers: noStore });
      }
      const indexPath = join(staticDir, "index.html");
      if (existsSync(indexPath)) {
        return new Response(Bun.file(indexPath), { headers: noStore });
      }
      return new Response("Not found", { status: 404 });
    },
  });
}

const STARTUP_ASCII_ART = [
  "",
  "\x1b[36m  \u2588\u2588\u2557  \u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2588\u2557   \u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557",
  "  \u2588\u2588\u2551  \u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2557  \u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255d\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255d",
  "  \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551\u2588\u2588\u2554\u2588\u2588\u2557 \u2588\u2588\u2551\u2588\u2588\u2551     \u2588\u2588\u2588\u2588\u2588\u2557  ",
  "  \u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2551\u2588\u2588\u2551\u255a\u2588\u2588\u2557\u2588\u2588\u2551\u2588\u2588\u2551     \u2588\u2588\u2554\u2550\u2550\u255d  ",
  "  \u2588\u2588\u2551  \u2588\u2588\u2551\u2588\u2588\u2551  \u2588\u2588\u2551\u2588\u2588\u2551 \u255a\u2588\u2588\u2588\u2588\u2551\u255a\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557",
  "  \u255a\u2550\u255d  \u255a\u2550\u255d\u255a\u2550\u255d  \u255a\u2550\u255d\u255a\u2550\u255d  \u255a\u2550\u2550\u2550\u255d \u255a\u2550\u2550\u2550\u2550\u2550\u255d\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u255d\x1b[0m",
].join("\n");

export async function startUI(port: number, openBrowser = true, initialFile?: string): Promise<void> {
  initialFilePath = initialFile ?? null;
  const proxyDir = join(tmpdir(), "hance-proxy");
  const cleanup = () => { try { rmSync(proxyDir, { recursive: true, force: true }); } catch {} };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  const server = createServer(port, "127.0.0.1");
  console.log(STARTUP_ASCII_ART);
  console.log(`\n  \x1b[2mRunning at\x1b[0m \x1b[1mhttp://127.0.0.1:${server.port}\x1b[0m\n`);
  if (openBrowser) {
    const open = process.platform === "darwin" ? "open" : "xdg-open";
    Bun.spawn([open, `http://127.0.0.1:${server.port}`], { stdout: "ignore", stderr: "ignore" });
  }
}
