import { useState, useRef, useEffect } from "react";
import { ZOOM_LEVELS, type ZoomLevel } from "../hooks/useCanvasTransform";

export type ViewMode = "normal" | "split" | "reference";

interface Props {
  mode: ViewMode;
  onChange: (m: ViewMode) => void;
  referenceDisabled?: boolean;
  splitDisabled?: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  zoom: ZoomLevel;
  onZoomChange: (z: ZoomLevel) => void;
  panMode: boolean;
  onPanModeChange: (on: boolean) => void;
  showParade: boolean;
  onToggleParade: () => void;
}

function IconNormal() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1" stroke="currentColor" strokeWidth="1.25" /></svg>;
}
function IconSplit() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1" stroke="currentColor" strokeWidth="1.25" /><line x1="8" y1="3" x2="8" y2="13" stroke="currentColor" strokeWidth="1.25" /></svg>;
}
function IconReference() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1" stroke="currentColor" strokeWidth="1.25" /><line x1="8" y1="3" x2="8" y2="13" stroke="currentColor" strokeWidth="1.25" /><path d="M10.5 7.5l1.5 1.5 1.5-1.5" stroke="currentColor" strokeWidth="1.25" fill="none" /></svg>;
}
function IconUndo() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M6 4L2.5 7.5 6 11" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.5 7.5h7a4 4 0 0 1 0 8H7" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconRedo() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M10 4l3.5 3.5L10 11" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.5 7.5h-7a4 4 0 0 0 0 8H9" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconHand() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="white">
      <path d="M10.5 1.875a1.125 1.125 0 0 1 2.25 0v8.219c.517.162 1.02.382 1.5.659V3.375a1.125 1.125 0 0 1 2.25 0v10.937a4.505 4.505 0 0 0-3.25 2.373 8.963 8.963 0 0 1 4-.935A.75.75 0 0 0 18 15v-2.266a3.368 3.368 0 0 1 .988-2.37 1.125 1.125 0 0 1 1.591 1.59 1.118 1.118 0 0 0-.329.79v3.006h-.005a6 6 0 0 1-1.752 4.007l-1.736 1.736a6 6 0 0 1-4.242 1.757H10.5a7.5 7.5 0 0 1-7.5-7.5V6.375a1.125 1.125 0 0 1 2.25 0v5.519c.46-.452.965-.832 1.5-1.141V3.375a1.125 1.125 0 0 1 2.25 0v6.526c.495-.1.997-.151 1.5-.151V1.875Z" />
    </svg>
  );
}

function IconParade() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="3" width="3.5" height="10" rx="0.5" stroke="currentColor" strokeWidth="1.1" />
      <rect x="6.25" y="3" width="3.5" height="10" rx="0.5" stroke="currentColor" strokeWidth="1.1" />
      <rect x="11" y="3" width="3.5" height="10" rx="0.5" stroke="currentColor" strokeWidth="1.1" />
      <path d="M2 9.5h2.5M6.75 7h2.5M11.5 10.5h2.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function ZoomDropdown({ zoom, onZoomChange, disabled: isDisabled }: { zoom: ZoomLevel; onZoomChange: (z: ZoomLevel) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function close(e: globalThis.MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const label = zoom === "fit" ? "Fit" : `${zoom}%`;
  const options: ZoomLevel[] = ["fit", ...ZOOM_LEVELS];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => !isDisabled && setOpen(!open)}
        disabled={isDisabled}
        className={`flex items-center gap-1 px-2 py-1 rounded-sm text-xs transition-colors min-w-[52px] justify-center ${isDisabled ? "text-zinc-600 cursor-not-allowed" : "text-zinc-300 hover:text-zinc-100 hover:bg-zinc-700"}`}
        title="Zoom level"
      >
        {label}
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none"><path d="M2 3l2 2 2-2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 bg-zinc-800 border border-zinc-700 rounded-sm py-1 z-50 min-w-[80px]">
          {options.map(z => (
            <button
              key={z}
              onClick={() => { onZoomChange(z); setOpen(false); }}
              className={`block w-full text-left px-3 py-1 text-xs transition-colors ${z === zoom ? "text-zinc-100 bg-zinc-700" : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700"}`}
            >
              {z === "fit" ? "Fit" : `${z}%`}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ViewModeToolbar({ mode, onChange, referenceDisabled, splitDisabled, canUndo, canRedo, onUndo, onRedo, zoom, onZoomChange, panMode, onPanModeChange, showParade, onToggleParade }: Props) {
  const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
  const mod = isMac ? "⌘" : "Ctrl";
  const base = "p-1.5 rounded-sm transition-colors";
  const active = "text-zinc-100 bg-zinc-700";
  const idle = "text-zinc-400 hover:text-zinc-200";
  const disabled = "text-zinc-600 cursor-not-allowed";
  return (
    <div
      className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-zinc-900/90 border border-zinc-800 z-20 rounded-sm px-1.5 py-1"
    >
      <button
        onClick={() => onChange("normal")}
        className={`${base} ${mode === "normal" ? active : idle}`}
        aria-label="Normal view"
        title="Normal view"
      ><IconNormal /></button>
      <button
        onClick={() => !splitDisabled && onChange("split")}
        disabled={splitDisabled}
        className={`${base} ${mode === "split" ? active : splitDisabled ? disabled : idle}`}
        aria-label="Split compare"
        title="Split compare"
      ><IconSplit /></button>
      <button
        onClick={() => !referenceDisabled && onChange("reference")}
        disabled={referenceDisabled}
        className={`${base} ${mode === "reference" ? active : referenceDisabled ? disabled : idle}`}
        aria-label="Reference compare"
        title="Reference compare"
      ><IconReference /></button>
      <div className="self-stretch w-px bg-zinc-800 mx-1" />
      <button
        onClick={onUndo}
        disabled={!canUndo}
        className={`${base} ${canUndo ? idle : disabled}`}
        aria-label="Undo"
        title={`Undo (${mod}Z)`}
      ><IconUndo /></button>
      <button
        onClick={onRedo}
        disabled={!canRedo}
        className={`${base} ${canRedo ? idle : disabled}`}
        aria-label="Redo"
        title={`Redo (${mod}⇧Z)`}
      ><IconRedo /></button>
      <div className="self-stretch w-px bg-zinc-800 mx-1" />
      <button
        onClick={() => mode === "normal" && zoom !== "fit" && onPanModeChange(!panMode)}
        disabled={mode !== "normal" || zoom === "fit"}
        className={`${base} ${mode !== "normal" || zoom === "fit" ? disabled : panMode ? active : idle}`}
        aria-label="Pan tool"
        title="Pan (H)"
      ><IconHand /></button>
      <button
        onClick={onToggleParade}
        className={`${base} ${showParade ? active : idle}`}
        aria-label="RGB parade"
        title="RGB parade"
      ><IconParade /></button>
      <ZoomDropdown zoom={zoom} onZoomChange={onZoomChange} disabled={mode !== "normal"} />
    </div>
  );
}
