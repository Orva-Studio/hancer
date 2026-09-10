import { useRef, useEffect } from "react";
import {
  computeParade, paradeImageData, sampleCanvas, paradeWidth,
  PARADE_COLUMNS, PARADE_BINS, PANEL_GAP,
} from "../lib/parade";

interface Props {
  canvas: HTMLCanvasElement | null;
  onClose: () => void;
}

/** Scope refresh rate. Reading pixels back stalls the GPU, so this stays well
 * under the preview's frame rate: a scope only has to track the eye. */
const REFRESH_HZ = 12;

const GRATICULE = [0, 0.25, 0.5, 0.75, 1];

export function Parade({ canvas, onClose }: Props) {
  const outputRef = useRef<HTMLCanvasElement>(null);
  const samplerRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    if (!canvas || !outputRef.current) return;

    const output = outputRef.current;
    const width = paradeWidth();
    const height = PARADE_BINS;
    output.width = width;
    output.height = height;

    const ctx = output.getContext("2d");
    if (!ctx) return;

    if (!samplerRef.current) samplerRef.current = document.createElement("canvas");
    const sampler = samplerRef.current;

    let cancelled = false;
    let lastDraw = 0;

    function draw(now: number) {
      if (cancelled) return;
      rafRef.current = requestAnimationFrame(draw);
      if (now - lastDraw < 1000 / REFRESH_HZ) return;
      lastDraw = now;

      const sample = sampleCanvas(canvas!, sampler);
      if (!sample) return;

      const parade = computeParade(sample.data, sample.width, sample.height);
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
    }

    rafRef.current = requestAnimationFrame(draw);
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      samplerRef.current = null;
    };
  }, [canvas]);

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
      {!canvas && (
        <div className="px-2.5 py-2 text-[10px] text-zinc-500">Waiting for a frame</div>
      )}
    </div>
  );
}
