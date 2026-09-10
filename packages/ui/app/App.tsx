import { useState, useCallback, useRef, useEffect } from "react";
import { useUpload } from "./hooks/useUpload";
import { useInitialFile } from "./hooks/useInitialFile";
import { useLooks } from "./hooks/useLooks";
import { useResizable } from "./hooks/useResizable";
import { useHistory } from "./hooks/useHistory";
import { useCanvasTransform } from "./hooks/useCanvasTransform";
import { useCanvasInput } from "./hooks/useCanvasInput";
import { useUndoRedo } from "./hooks/useUndoRedo";
import { useExport } from "./hooks/useExport";
import { useCanvasRect } from "./hooks/useCanvasRect";
import { TopBar } from "./components/TopBar";
import { LooksPanel } from "./components/LooksPanel";
import { AdjustmentsPanel } from "./components/AdjustmentsPanel";
import { Canvas } from "./components/Canvas";
import { Landing } from "./components/Landing";
import { Timeline } from "./components/Timeline";
import { ResizeDivider } from "./components/ResizeDivider";
import { NewLookModal } from "./components/NewLookModal";
import { AboutModal } from "./components/AboutModal";
import { ExportModal } from "./components/ExportModal";
import { LutExportModal } from "./components/LutExportModal";
import { fetchLutCube, downloadCube } from "./lib/bakeLut";
import { ViewModeToolbar, type ViewMode } from "./components/ViewModeToolbar";
import { Parade } from "./components/Parade";
import { readPixels } from "./lib/readPixels";
import { matchColorParams } from "@hance/core";
import { CompareOverlay } from "./components/CompareOverlay";
import type { Renderer, PreviewParams } from "./gpu/renderer";
import type { EffectGroup } from "@hance/core";
import { seedDefaults } from "@hance/core";
import { fetchJson } from "./lib/fetchJson";
import { useProxyStream } from "./hooks/useProxyStream";
import { useFirstFrame } from "./hooks/useFirstFrame";
import { useMenuActions } from "./hooks/useMenuActions";
import { setThumbnailSource } from "./lib/lookThumbnails";
import { pickNativeFile } from "./lib/openFile";

// Warn once the on-disk preview proxy cache passes this size. Caching never
// evicts (by design), so this nudges the user to clear it manually.
const PROXY_CACHE_WARN_BYTES = 5 * 1024 ** 3;

export function App() {
  const { file, objectUrl, sourcePath, isVideo, upload, openPath, error: uploadError, clearError, reset } = useUpload();
  const proxy = useProxyStream();
  const previewSrc = proxy.previewSrc ?? objectUrl;
  const [previewError, setPreviewError] = useState<Error | null>(null);
  const [licenseTier, setLicenseTier] = useState<"free" | "pro">("free");
  const [cacheWarningDismissed, setCacheWarningDismissed] = useState(false);
  const showCacheWarning = proxy.cacheBytes > PROXY_CACHE_WARN_BYTES && !cacheWarningDismissed;

  useInitialFile(upload);

  // Only proxy when the browser actually can't decode the file. A .mov can
  // hold H.264 (plays natively) or ProRes (doesn't); the extension/MIME can't
  // tell them apart, so we let the native <video> try first and start the
  // streaming proxy if Canvas reports a decode failure.
  useEffect(() => {
    if (file && isVideo && previewError && proxy.state === "idle") {
      setPreviewError(null);
      proxy.start(file, sourcePath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewError, file, isVideo, sourcePath]);

  const [params, setParams] = useState<PreviewParams>({});
  const [schema, setSchema] = useState<EffectGroup[]>([]);
  const [renderer, setRenderer] = useState<Renderer | null>(null);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null);

  const lastTimeRef = useRef(0);
  useEffect(() => {
    if (videoElement) {
      const onTime = () => { lastTimeRef.current = videoElement.currentTime; };
      videoElement.addEventListener("timeupdate", onTime);
      return () => videoElement.removeEventListener("timeupdate", onTime);
    }
  }, [videoElement]);

  // True once the preview has decoded its first frame; until then the canvas
  // is black, so we show an explanatory loading card instead.
  const [firstFrameReady, setFirstFrameReady] = useState(false);

  // Show a spinner whenever the video stalls — at start while the streaming
  // proxy fills, or mid-clip if playback catches up to the transcode head.
  const [isBuffering, setIsBuffering] = useState(false);
  useEffect(() => {
    if (!videoElement) return;
    // WebKit fires "stalled" whenever it stops fetching — including when it
    // has intentionally paused a Range download because its buffer is full
    // (constant with large native files). Only count a stall when the decoder
    // truly lacks the data to keep playing, and clear it as soon as the
    // playhead advances, since no "playing"/"canplay" follows a false stall.
    const stall = () => {
      if (videoElement.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) setIsBuffering(true);
    };
    const resume = () => setIsBuffering(false);
    videoElement.addEventListener("waiting", stall);
    videoElement.addEventListener("stalled", stall);
    videoElement.addEventListener("playing", resume);
    videoElement.addEventListener("canplay", resume);
    videoElement.addEventListener("pause", resume);
    videoElement.addEventListener("timeupdate", resume);
    return () => {
      videoElement.removeEventListener("waiting", stall);
      videoElement.removeEventListener("stalled", stall);
      videoElement.removeEventListener("playing", resume);
      videoElement.removeEventListener("canplay", resume);
      videoElement.removeEventListener("pause", resume);
      videoElement.removeEventListener("timeupdate", resume);
    };
  }, [videoElement]);

  // When the proxy finishes we swap the blob for the on-disk file. The swap
  // resets the <video>'s currentTime to 0 (firing timeupdate=0), so we must
  // freeze the playhead at the "ready" transition — captured here during
  // render, before the new src is committed and that reset fires. Canvas then
  // seeks its first frame to this position instead of 0. Reset on new file.
  const resumeRef = useRef<number | null>(null);
  if (proxy.state === "ready" && resumeRef.current === null) {
    resumeRef.current = lastTimeRef.current;
  }
  const getStartTime = useCallback(() => resumeRef.current ?? 0, []);

  const [animating, setAnimating] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showSaveAsNew, setShowSaveAsNew] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showLutModal, setShowLutModal] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("normal");
  const [showParade, setShowParade] = useState(false);
  const [matching, setMatching] = useState(false);
  const [matchNotice, setMatchNotice] = useState<string | null>(null);
  const [referenceImage, setReferenceImage] = useState<string | null>(null);
  const [splitPosition, setSplitPosition] = useState(0.5);
  const canvasTransform = useCanvasTransform();

  const handleViewModeChange = useCallback((m: ViewMode) => {
    setViewMode(m);
    if (m !== "normal") {
      canvasTransform.setZoom("fit");
      canvasTransform.setPanMode(false);
    }
  }, [canvasTransform.setZoom, canvasTransform.setPanMode]);
  const canvasRect = useCanvasRect(canvas);
  const hoverParamsRef = useRef<PreviewParams | null>(null);
  const { exportProgress, startExport, cancelExport, resetExport } = useExport(file, sourcePath, params);

  function chooseReferenceImage() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      setReferenceImage(URL.createObjectURL(file));
    };
    input.click();
  }

  useEffect(() => {
    setPreviewError(null);
    setFirstFrameReady(false);
    lastTimeRef.current = 0;
    resumeRef.current = null;
    setReferenceImage(null);
    setViewMode("normal");
    setSplitPosition(0.5);
    canvasTransform.setZoom("fit");
    canvasTransform.setPanMode(false);
  }, [objectUrl]);

  const {
    looks, activeLook, activeLookParams,
    error: looksError, clearError: clearLooksError,
    refreshLooks, loadLook, clearLook, saveLook, createLook, deleteLook, renameLook, importLook, restoreActiveLook,
  } = useLooks();
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);

  // A stale open error, or an import notice about a look the user has since
  // moved on from, would otherwise linger in the editor's toast stack after a
  // later file loads successfully.
  useEffect(() => {
    if (objectUrl) {
      setOpenError(null);
      setImportNotice(null);
    }
  }, [objectUrl]);

  // History tracks {params, activeLook}. Only these are undoable — file
  // uploads, look CRUD, hover previews, scrub, and resizing are not.
  const history = useHistory<{ params: PreviewParams; activeLook: string | null }>(
    { params: {}, activeLook: null },
  );

  const activeLookRef = useRef<string | null>(activeLook);
  const historyRef = useRef(history);
  useEffect(() => { activeLookRef.current = activeLook; }, [activeLook]);
  useEffect(() => { historyRef.current = history; }, [history]);

  // The loaded media's first frame becomes the source image for the look
  // thumbnails in the left panel, and (when the file has a real path, i.e.
  // desktop native picker) the recents entry.
  useFirstFrame({ objectUrl, isVideo, videoElement, firstFrameReady }, frame => {
    setThumbnailSource(frame);
    refreshLooks();
    if (file && sourcePath) {
      fetch("/api/recents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: sourcePath, name: file.name, thumbnail: frame, activeLook: activeLookRef.current ?? undefined }),
      }).catch(() => {});
    }
  });

  const hasChanges = activeLookParams !== null && Object.keys(activeLookParams).some(
    key => activeLookParams[key] !== params[key]
  );

  // When activeLook changes, update the recents entry with the new look.
  useEffect(() => {
    if (file && sourcePath) {
      fetch("/api/recents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: sourcePath, name: file.name, activeLook: activeLook ?? undefined }),
      }).catch(() => {});
    }
  }, [activeLook, file, sourcePath]);

  // Reading from setParams' updater guarantees we see pending state from
  // the same event — a toggle's onChange + onCommit run before React
  // re-renders, so paramsRef would otherwise be stale by one change.
  const commitHistory = useCallback(() => {
    setParams(p => {
      historyRef.current.commit({ params: p, activeLook: activeLookRef.current });
      return p;
    });
  }, []);

  // Fetch schema and looks on mount — external server data
  useEffect(() => {
    async function init() {
      try {
        const [groups, licenseData] = await Promise.all([
          fetchJson<EffectGroup[]>("/api/schema"),
          fetchJson<{ tier: "free" | "pro" }>("/api/license"),
        ]);
        setLicenseTier(licenseData.tier);
        setSchema(groups);
        // Seed schema defaults so enabling an effect renders at its default
        // value (single defaults source), then switch every effect off.
        const disableAll: PreviewParams = seedDefaults();
        for (const group of groups) {
          disableAll[group.enableKey] = true;
        }
        const lookPath = new URLSearchParams(window.location.search).get("look");
        const lookName = lookPath?.split("/").pop()?.replace(/\.hlook$/, "") ?? null;
        if (lookName) {
          try {
            const lookParams = await loadLook(lookName);
            setParams(lookParams);
            history.replace({ params: lookParams, activeLook: lookName });
            return;
          } catch {
            // Look failed to load — fall through to default (all effects off).
          }
        }
        setParams(disableAll);
        history.replace({ params: disableAll, activeLook: null });
      } catch (err) {
        console.error("Failed to load effect schema:", err);
        setSchemaError(`Could not load effect controls: ${(err as Error).message}`);
      }
    }
    init();
    refreshLooks();
  }, []);

  const isCompareEdit = new URLSearchParams(window.location.search).has("look");
  const leftPanel = useResizable({ defaultSize: 240, minSize: 200, maxSize: 400, direction: "horizontal" });
  const rightPanel = useResizable({ defaultSize: 350, minSize: 250, maxSize: 500, direction: "horizontal", reverse: true });
  const bottomPanel = useResizable({ defaultSize: 180, minSize: 100, maxSize: 250, direction: "vertical", reverse: true });

  const handleRendererReady = useCallback((r: Renderer) => {
    setRenderer(r);
  }, []);

  const handleCanvasReady = useCallback((c: HTMLCanvasElement) => {
    setCanvas(c);
  }, []);

  const handleVideoReady = useCallback((v: HTMLVideoElement) => {
    setVideoElement(v);
    setFirstFrameReady(true);
  }, []);

  const handleParamChange = useCallback((key: string, value: number | string | boolean) => {
    setParams(prev => ({ ...prev, [key]: value }));
  }, []);

  // Matches against the ungraded source, not the preview canvas: the canvas
  // already carries the current grade, and fitting to that would compound it.
  const handleMatchReference = useCallback(async () => {
    if (!referenceImage || !previewSrc) return;
    setMatching(true);
    setMatchNotice(null);
    try {
      const [sourcePixels, referencePixels] = await Promise.all([
        readPixels(isVideo && videoElement ? videoElement : previewSrc),
        readPixels(referenceImage),
      ]);
      const report = matchColorParams(sourcePixels, referencePixels);
      setParams(prev => {
        const next = { ...prev, ...report.params };
        historyRef.current.commit({ params: next, activeLook: activeLookRef.current });
        return next;
      });
      const closer = Math.round((1 - report.distance / report.baseline) * 100);
      setMatchNotice(`Colour matched, ${closer}% closer. Grain and halation were left alone.`);
    } catch (err) {
      setMatchNotice(`Could not match this reference: ${(err as Error).message}`);
    } finally {
      setMatching(false);
    }
  }, [referenceImage, previewSrc, isVideo, videoElement]);

  const handleReset = useCallback(() => {
    if (!activeLookParams) return;
    setAnimating(true);
    setParams(activeLookParams);
    setTimeout(() => setAnimating(false), 350);
    historyRef.current.commit({ params: activeLookParams, activeLook: activeLookRef.current });
  }, [activeLookParams]);

  const handleNoLook = useCallback(() => {
    clearLook();
    setAnimating(true);
    const disableAll: PreviewParams = seedDefaults();
    for (const group of schema) {
      disableAll[group.enableKey] = true;
    }
    setParams(disableAll);
    setTimeout(() => setAnimating(false), 350);
    historyRef.current.commit({ params: disableAll, activeLook: null });
  }, [clearLook, schema]);

  // Discard the loaded file and return to Landing. Also drops the proxy
  // stream (otherwise its previewSrc/state from the old file would shadow
  // the next upload) and resets grading state to defaults, so a second file
  // opened via Home doesn't inherit the first file's effect params.
  const handleHome = useCallback(() => {
    // Going Home hides the Cancel button, so an export left running here could
    // never be stopped — and would download the previous clip minutes later,
    // onto the landing screen or over whatever file was opened next.
    cancelExport();
    proxy.reset();
    reset();
    clearLook();
    const disableAll: PreviewParams = seedDefaults();
    for (const group of schema) {
      disableAll[group.enableKey] = true;
    }
    setParams(disableAll);
    historyRef.current.replace({ params: disableAll, activeLook: null });
  }, [cancelExport, proxy, reset, clearLook, schema]);

  const handleLookSelect = useCallback(async (name: string) => {
    try {
      const lookParams = await loadLook(name);
      setAnimating(true);
      setParams(lookParams);
      setTimeout(() => setAnimating(false), 350);
      historyRef.current.commit({ params: lookParams, activeLook: name });
    } catch (err) {
      console.error(`Failed to load look "${name}":`, err);
      clearLooksError();
      setSchemaError(`Failed to load look "${name}": ${(err as Error).message}`);
    }
  }, [loadLook, clearLooksError]);

  // Importing selects the look it just wrote, so a successful import is
  // visible on the canvas rather than being a no-op the user has to hunt for
  // in the grid — and says so when it replaced a look of the same name.
  const handleImportLook = useCallback(async (file: File) => {
    // Drop the previous import's notice up front, so a failing second import
    // can't leave the first one's success message standing next to its error.
    setImportNotice(null);
    const { name, overwritten } = await importLook(file);
    setImportNotice(
      overwritten
        ? `Replaced existing look "${name}" with the imported one`
        : `Imported look "${name}"`,
    );
    await handleLookSelect(name);
  }, [importLook, handleLookSelect]);

  // Reopening a recent file that had a look applied: open the media, then
  // reapply the same look (the recents entry only remembers its name, not a
  // full param snapshot — reuses the same reusable-look path as the sidebar).
  // Always resolves the look one way or the other (reapply or clear) so a
  // previous file's activeLook can never leak onto this one via the
  // recents-tracking effect below.
  const openRecentPath = useCallback(async (path: string, name: string, activeLook?: string) => {
    await openPath(path, name);
    if (activeLook) await handleLookSelect(activeLook);
    else clearLook();
  }, [openPath, handleLookSelect, clearLook]);

  // A brand-new file (native picker, menu "Open File", drag & drop) has no
  // known look yet — clear whatever the previous file had active so it can't
  // leak onto this one via the recents-tracking effect below.
  const openFreshPath = useCallback(async (path: string, name: string) => {
    clearLook();
    await openPath(path, name);
  }, [openPath, clearLook]);

  const uploadFresh = useCallback((file: File, sourcePath?: string) => {
    clearLook();
    upload(file, sourcePath);
  }, [upload, clearLook]);

  const handleLookHover = useCallback((name: string) => {
    if (!renderer) return;
    if (!hoverParamsRef.current) {
      hoverParamsRef.current = { ...params };
    }
    fetchJson<PreviewParams>(`/api/look?name=${encodeURIComponent(name)}`)
      .then((lookParams) => {
        renderer.setParams(lookParams);
        if (!isVideo) renderer.renderFrame();
      })
      .catch((err: Error) => {
        console.error(`Look hover preview failed for "${name}":`, err);
      });
  }, [renderer, params, isVideo]);

  const handleLookHoverEnd = useCallback(() => {
    if (renderer && hoverParamsRef.current) {
      renderer.setParams(params);
      if (!isVideo) renderer.renderFrame();
      hoverParamsRef.current = null;
    }
  }, [renderer, params, isVideo]);

  const handleSave = useCallback(() => {
    if (activeLook) {
      saveLook(activeLook, params);
    }
  }, [activeLook, params, saveLook]);

  const handleSaveAsNew = useCallback(() => {
    setShowSaveAsNew(true);
  }, []);

  const handleExport = useCallback((opts: { codec: string; crf: number; outputPath: string }) => {
    setShowExportModal(false);
    startExport(opts);
  }, [startExport]);

  const handleCreateLook = useCallback((name: string, metadata: { description: string; keywords: string[]; characteristics: string[] }) => {
    createLook(name, params, metadata);
  }, [createLook, params]);

  // Native menu actions from the desktop shell (File/Edit menus).
  useMenuActions({
    "about": () => setShowAbout(true),
    "open-file": () => {
      void (async () => {
        try {
          const picked = await pickNativeFile();
          if (!picked || picked === "unsupported") return;
          await openFreshPath(picked.path, picked.name);
        } catch (err) {
          setOpenError(`Failed to open file: ${(err as Error).message}`);
        }
      })();
    },
    "save-look": () => { if (activeLook && hasChanges) saveLook(activeLook, params); },
    "save-look-as-new": () => setShowSaveAsNew(true),
    "export": () => { if (file) setShowExportModal(true); },
    // Desktop-only by construction: the menu bridge never fires in a plain
    // browser, so try/ and the web UI get no LUT export without an isDesktop check.
    "export-lut": () => setShowLutModal(true),
    "undo": () => menuUndoRedo("undo"),
    "redo": () => menuUndoRedo("redo"),
  });

  // Menu Undo/Redo target the app's edit history, mirroring useUndoRedo's
  // keyboard rules: a focused text field gets native text undo instead
  // (range inputs commit param changes, so they still use app history).
  function menuUndoRedo(kind: "undo" | "redo") {
    const el = document.activeElement as HTMLElement | null;
    if (el) {
      const tag = el.tagName;
      const isTextInput = tag === "TEXTAREA" || el.isContentEditable ||
        (tag === "INPUT" && (el as HTMLInputElement).type !== "range");
      if (isTextInput) {
        document.execCommand(kind);
        return;
      }
    }
    const snap = kind === "undo" ? historyRef.current.undo() : historyRef.current.redo();
    applySnapshot(snap);
  }

  const applySnapshot = useCallback(async (snap: { params: PreviewParams; activeLook: string | null } | null) => {
    if (!snap) return;
    setAnimating(true);
    setParams(snap.params);
    await restoreActiveLook(snap.activeLook);
    setTimeout(() => setAnimating(false), 350);
  }, [restoreActiveLook]);

  useCanvasInput(viewMode, canvasTransform, videoElement);
  useUndoRedo(history, applySnapshot);

  if (!objectUrl) {
    return (
      <div className="h-screen flex flex-col bg-zinc-950 relative">
        <TopBar
          filename={null}
          file={null}
          params={params}
          renderer={null}
          isVideo={false}
          hasChanges={false}
          onSave={() => {}}
          onSaveAsNew={() => {}}
          onExportClick={() => {}}
        />
        <Landing onFile={uploadFresh} onPath={openRecentPath} onError={setOpenError} />
        {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}
        {(uploadError || openError) && (
          <div className="absolute left-1/2 -translate-x-1/2 bottom-8 flex items-center gap-3 bg-zinc-900 border border-danger/50 px-4 py-2 rounded-md text-xs text-danger">
            <span>{uploadError ?? openError}</span>
            <button
              onClick={() => { clearError(); setOpenError(null); }}
              className="text-zinc-400 hover:text-zinc-200"
            >×</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-zinc-950">
      {isCompareEdit && (
        <div className="bg-indigo-600 px-4 py-3 text-center text-sm font-medium text-white">
          When you're happy with your edits, tell your agent to apply this look.
        </div>
      )}
      <TopBar
        filename={file?.name || null}
        file={file}
        params={params}
        renderer={renderer}
        isVideo={isVideo}
        hasChanges={hasChanges}
        onSave={handleSave}
        onSaveAsNew={handleSaveAsNew}
        onExportClick={() => setShowExportModal(true)}
        onHome={handleHome}
        exportProgress={exportProgress}
        onExportDone={resetExport}
        onCancelExport={cancelExport}
      />

      <div className="flex-1 flex overflow-hidden">
        {/* Left panel — Looks browser */}
        <div className="flex-shrink-0 bg-zinc-900 overflow-hidden" style={{ width: leftPanel.size }}>
          <LooksPanel
            looks={looks}
            activeLook={activeLook}
            onSelect={handleLookSelect}
            onNoLook={handleNoLook}
            onHover={handleLookHover}
            onHoverEnd={handleLookHoverEnd}
            onCreateLook={handleCreateLook}
            onDeleteLook={deleteLook}
            onRenameLook={renameLook}
            onImportLook={handleImportLook}
            onGetLookInfo={async (name) => await fetchJson(`/api/look/info?name=${encodeURIComponent(name)}`)}
          />
        </div>

        <ResizeDivider direction="horizontal" onMouseDown={leftPanel.onMouseDown} />

        {/* Center — Canvas */}
        <div className="flex-1 flex items-center justify-center p-4 min-w-0 relative overflow-hidden">
          {file && (
            <ViewModeToolbar
              mode={viewMode}
              onChange={handleViewModeChange}
              splitDisabled={!file}
              referenceDisabled={false}
              canUndo={history.canUndo}
              canRedo={history.canRedo}
              onUndo={() => applySnapshot(historyRef.current.undo())}
              onRedo={() => applySnapshot(historyRef.current.redo())}
              zoom={canvasTransform.zoom}
              onZoomChange={canvasTransform.setZoom}
              showParade={showParade}
              onToggleParade={() => setShowParade(v => !v)}
              panMode={canvasTransform.panMode}
              onPanModeChange={canvasTransform.setPanMode}
            />
          )}
          {proxy.state === "error" && (
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 px-3 py-1.5 rounded-full bg-danger/90 text-xs text-white">
              {proxy.errorMsg ?? "Preview failed"}
              <button className="underline" onClick={() => file && proxy.start(file, sourcePath)}>Retry</button>
            </div>
          )}
          {isVideo && !firstFrameReady && proxy.state !== "error" && (
            <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
              <div className="flex flex-col items-center gap-3 max-w-xs text-center px-6 py-5 bg-zinc-900/90 backdrop-blur rounded-lg border border-zinc-800">
                <span className="w-5 h-5 rounded-full border-2 border-zinc-600 border-t-accent animate-spin" />
                <div className="text-sm text-zinc-200">
                  {proxy.state === "streaming" ? "Converting .mov to H.264…" : "Loading preview…"}
                </div>
                <div className="text-xs text-zinc-500">
                  {proxy.state === "streaming"
                    ? "Building a 720p preview proxy. It will start buffering shortly. Export stays full-res."
                    : "Checking whether the browser can play this file."}
                </div>
              </div>
            </div>
          )}
          {isBuffering && isVideo && firstFrameReady && (
            <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-zinc-900/80 backdrop-blur text-xs text-zinc-200">
                <span className="w-3 h-3 rounded-full border-2 border-zinc-500 border-t-accent animate-spin" />
                Buffering…
              </div>
            </div>
          )}
          {previewError && !isVideo ? (
            <div className="flex flex-col items-center gap-3 max-w-md text-center p-6 bg-zinc-900 rounded-lg border border-danger/40">
              <div className="text-sm text-zinc-200">Preview failed</div>
              <div className="text-xs text-zinc-500">{previewError.message}</div>
            </div>
          ) : (
            <Canvas
              src={previewSrc!}
              isVideo={isVideo}
              params={params}
              onRendererReady={handleRendererReady}
              onCanvasReady={handleCanvasReady}
              onVideoReady={handleVideoReady}
              getStartTime={getStartTime}
              onError={setPreviewError}
              zoom={canvasTransform.zoom}
              pan={canvasTransform.pan}
              isPanning={canvasTransform.isPanning}
              panMode={canvasTransform.panMode}
              onPanMouseDown={canvasTransform.onMouseDown}
              onPanMouseMove={canvasTransform.onMouseMove}
              onPanMouseUp={canvasTransform.onMouseUp}
            />
          )}

          {showParade && file && (
            <Parade canvas={canvas} onClose={() => setShowParade(false)} />
          )}
        </div>

        <ResizeDivider direction="horizontal" onMouseDown={rightPanel.onMouseDown} />

        {/* Right panel — Adjustments */}
        <div className="flex-shrink-0 bg-zinc-900 overflow-hidden" style={{ width: rightPanel.size }}>
          <AdjustmentsPanel
            schema={schema}
            values={params}
            onChange={handleParamChange}
            onCommit={commitHistory}
            onReset={handleReset}
            canReset={hasChanges}
            animating={animating}
          />
        </div>
      </div>

      {/* Bottom — Timeline (video only) */}
      {isVideo && (
        <>
          <ResizeDivider direction="vertical" onMouseDown={bottomPanel.onMouseDown} />
          <div className="flex-shrink-0" style={{ height: bottomPanel.size }}>
            <Timeline
              videoRef={videoElement}
              durationHint={proxy.durationHint}
              streaming={proxy.state === "streaming"}
            />
          </div>
        </>
      )}

      {showCacheWarning && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-8 z-50 flex items-center gap-3 max-w-md bg-zinc-900 border border-amber-500/50 px-4 py-2 rounded-md text-xs text-zinc-200 shadow-lg">
          <span>
            Preview cache is {(proxy.cacheBytes / 1024 ** 3).toFixed(1)} GB.{" "}
            <a
              href="https://hance.video/docs/browser-ui/#clearing-the-preview-cache"
              target="_blank"
              rel="noreferrer"
              className="underline text-accent hover:text-accent-hover"
            >
              How to clear it
            </a>
          </span>
          <button
            onClick={() => setCacheWarningDismissed(true)}
            className="text-zinc-400 hover:text-zinc-200"
            aria-label="Dismiss"
          >×</button>
        </div>
      )}

      {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}

      {showSaveAsNew && (
        <NewLookModal
          onSubmit={(name, metadata) => {
            handleCreateLook(name, metadata);
            setShowSaveAsNew(false);
          }}
          onCancel={() => setShowSaveAsNew(false)}
        />
      )}

      {showLutModal && (
        <LutExportModal
          lookName={activeLook}
          params={params}
          onCancel={() => setShowLutModal(false)}
          onExport={async filename => {
            downloadCube(await fetchLutCube(params, filename.replace(/\.cube$/i, "")), filename);
            setShowLutModal(false);
          }}
        />
      )}

      {showExportModal && file && (
        <ExportModal
          defaultBasename={file.name.replace(/\.[^.]+$/, "")}
          isPro={licenseTier === "pro"}
          onCancel={() => setShowExportModal(false)}
          onExport={handleExport}
        />
      )}

      {viewMode === "split" && previewSrc && canvasRect && (
        <CompareOverlay
          mode="split"
          position={splitPosition}
          onPositionChange={setSplitPosition}
          overlaySrc={previewSrc}
          isVideo={isVideo}
          videoRef={videoElement}
          canvasRect={canvasRect}
        />
      )}
      {viewMode === "reference" && !referenceImage && canvasRect && (
        <div
          className="absolute bg-zinc-900/90 border border-zinc-700 px-4 py-3 z-30 flex flex-col items-center gap-2 rounded-md"
          style={{
            left: canvasRect.left + canvasRect.width / 2 - 110,
            top: canvasRect.top + canvasRect.height / 2 - 30,
          }}
        >
          <div className="text-xs text-zinc-300">Upload a reference image</div>
          <button
            onClick={chooseReferenceImage}
            className="text-xs text-white bg-accent hover:bg-accent-hover rounded-sm p-btn"
          >Choose image…</button>
        </div>
      )}
      {viewMode === "reference" && referenceImage && canvasRect && (
        <>
          <CompareOverlay
            mode="reference"
            position={splitPosition}
            onPositionChange={setSplitPosition}
            overlaySrc={referenceImage}
            isVideo={false}
            canvasRect={canvasRect}
          />
          <div
            className="absolute z-30 flex items-center gap-2"
            style={{
              right: `calc(100vw - ${canvasRect.left + canvasRect.width}px + 8px)`,
              top: canvasRect.top + 8,
            }}
          >
            <button
              onClick={handleMatchReference}
              disabled={matching}
              title="Set the colour sliders to approximate this reference"
              className="text-[11px] text-white bg-accent hover:bg-accent-hover disabled:opacity-60 rounded-sm px-2.5 py-1"
            >{matching ? "Matching…" : "Match colour"}</button>
            <button
              onClick={() => setReferenceImage(null)}
              className="text-[11px] text-zinc-300 bg-zinc-800/90 border border-zinc-700 hover:bg-zinc-700 rounded-sm px-2.5 py-1"
            >Replace reference</button>
          </div>
        </>
      )}

      {(schemaError || looksError || openError || importNotice || matchNotice) && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-8 flex flex-col gap-2 z-40">
          {matchNotice && (
            <div className="flex items-center gap-3 bg-zinc-900 border border-zinc-600 px-4 py-2 rounded-md text-xs text-zinc-300">
              <span>{matchNotice}</span>
              <button onClick={() => setMatchNotice(null)} className="text-zinc-400 hover:text-zinc-200">×</button>
            </div>
          )}
          {importNotice && (
            <div className="flex items-center gap-3 bg-zinc-900 border border-zinc-600 px-4 py-2 rounded-md text-xs text-zinc-300">
              <span>{importNotice}</span>
              <button onClick={() => setImportNotice(null)} className="text-zinc-400 hover:text-zinc-200">×</button>
            </div>
          )}
          {openError && (
            <div className="flex items-center gap-3 bg-zinc-900 border border-danger/50 px-4 py-2 rounded-md text-xs text-danger">
              <span>{openError}</span>
              <button onClick={() => setOpenError(null)} className="text-zinc-400 hover:text-zinc-200">×</button>
            </div>
          )}
          {schemaError && (
            <div className="flex items-center gap-3 bg-zinc-900 border border-danger/50 px-4 py-2 rounded-md text-xs text-danger">
              <span>{schemaError}</span>
              <button onClick={() => setSchemaError(null)} className="text-zinc-400 hover:text-zinc-200">×</button>
            </div>
          )}
          {looksError && (
            <div className="flex items-center gap-3 bg-zinc-900 border border-danger/50 px-4 py-2 rounded-md text-xs text-danger">
              <span>{looksError}</span>
              <button onClick={clearLooksError} className="text-zinc-400 hover:text-zinc-200">×</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
