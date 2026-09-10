import { useRef, useEffect } from "react";
import type { Renderer } from "../gpu/renderer";
import {
  computeParade, paradeImageData, paradeWidth,
  PARADE_COLUMNS, PARADE_BINS, PANEL_GAP,
} from "../lib/parade";

interface Props {
  renderer: Renderer | null;
  canvas: HTMLCanvasElement | null;
  onClose: () => void;
}

/** Scope refresh rate. Each tick costs a GPU readback, so this stays well
 * under the preview's frame rate: a scope only has to track the eye. */
const REFRESH_HZ = 10;

/** Rows sampled per tick. The parade bins columns, so dropping rows costs
 * nothing but noise while keeping a full-resolution readback affordable. */
const TARGET_ROWS = 120;

const GRATICULE = [0, 0.25, 0.5, 0.75, 1];

export function Parade({ renderer, canvas, onClose }: Props) {
  const outputRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    if (!renderer || !canvas || !outputRef.current) return;

    const output = outputRef.current;
    const width = paradeWidth();
    const height = PARADE_BINS;
    output.width = width;
    output.height = height;

    const ctx = output.getContext("2d");
    if (!ctx) return;

    let cancelled = false;
    let lastDraw = 0;
    let inFlight = false;

    async function tick(now: number) {
      if (cancelled) return;
      rafRef.current = requestAnimationFrame(tick);
      if (inFlight || now - lastDraw < 1000 / REFRESH_HZ) return;
      lastDraw = now;
      inFlight = true;

      try {
        // Reads the renderer's own output texture rather than the canvas: a
        // WebGPU canvas snapshots as empty through drawImage, which silently
        // produced an all-black trace.
        const pixels = await renderer!.readPixels();
        if (cancelled) return;

        const sourceWidth = canvas!.width;
        const sourceHeight = canvas!.height;
        if (sourceWidth === 0 || sourceHeight === 0) return;

        const rowStep = Math.max(1, Math.floor(sourceHeight / TARGET_ROWS));
        const parade = computeParade(
          pixels, sourceWidth, sourceHeight, PARADE_COLUMNS, PARADE_BINS, rowStep,
        );
        const image = paradeImageData(parade);

        ctx!.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);

        ctx!.strokeStyle = "rgba(255,255,255,0.14)";
        ctx!.lineWidth = 1;
        for (let panel = 0; panel < 3; panel++) {
          const x0 = panel * (PARADE_COLUMNS + PANEL_GAP);
          for (const level of GRATICULE) {
            const y = Math.round((1 - level) * (height - 1)) + 0.5;
            ctx!.beginPath();
            ctx!.moveTo(x0, y);
            ctx!.lineTo(x0 + PARADE_COLUMNS, y);
            ctx!.stroke();
          }
        }
      } catch {
        // A readback can fail while the renderer is being torn down or the
        // source swapped. The next tick picks it back up.
      } finally {
        inFlight = false;
      }
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
    };
  }, [renderer, canvas]);

  return (
    <div className="absolute bottom-3 right-3 z-20 bg-zinc-900/95 backdrop-blur border border-zinc-700 rounded-md overflow-hidden shadow-lg">
      <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-zinc-800">
        <span className="text-[11px] text-zinc-300 tracking-wide">RGB Parade</span>
        <button
          onClick={onClose}
          aria-label="Hide RGB parade"
          className="text-zinc-500 hover:text-zinc-200 text-sm leading-none px-1"
        >
          ×
        </button>
      </div>
      <div className="flex flex-col gap-1 px-2 pt-2 pb-2">
        <div
          className="flex text-[9px] text-zinc-500 tracking-wider"
          style={{ width: paradeWidth() / 2, gap: PANEL_GAP / 2 }}
        >
          <span className="text-center" style={{ width: PARADE_COLUMNS / 2 }}>R</span>
          <span className="text-center" style={{ width: PARADE_COLUMNS / 2 }}>G</span>
          <span className="text-center" style={{ width: PARADE_COLUMNS / 2 }}>B</span>
        </div>
        <canvas
          ref={outputRef}
          className="block bg-black"
          style={{ width: paradeWidth() / 2, height: PARADE_BINS / 2 }}
        />
      </div>
      {!renderer && (
        <div className="px-2.5 pb-2 text-[10px] text-zinc-500">Waiting for a frame</div>
      )}
    </div>
  );
}
