import { useState, useRef, useEffect } from "react";

export interface AiTurn {
  /** What the user asked, or null for the opening proposal. */
  instruction: string | null;
  note: string;
  params: Record<string, number | string>;
}

interface Props {
  turns: AiTurn[];
  busy: boolean;
  error: string | null;
  canRevert: boolean;
  onPropose: (instruction?: string) => void;
  onRevert: () => void;
  onDismissError: () => void;
}

const SUGGESTIONS = ["Warmer", "More filmic", "Cooler shadows", "Lift the blacks", "Less saturated"];

export function AiPanel(props: Props) {
  const { turns, busy, error, canRevert, onPropose, onRevert, onDismissError } = props;
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [turns.length, busy]);

  function submit() {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    onPropose(text);
  }

  return (
    <div className="flex flex-col h-full">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3">
        {turns.length === 0 && !busy && (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-zinc-400 leading-relaxed">
              Describe the look you want, or start from a suggestion. Every result lands on the
              sliders, so you can finish by hand.
            </p>
            <button
              onClick={() => onPropose()}
              className="text-xs text-white bg-accent hover:bg-accent-hover rounded-sm px-3 py-2"
            >
              Best guess
            </button>
            <p className="text-[11px] text-zinc-600 leading-relaxed">
              Colour only. Grain, halation and the other optical effects stay where you left them.
            </p>
          </div>
        )}

        {turns.map((turn, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            {turn.instruction && (
              <div className="self-end max-w-[85%] text-xs text-zinc-200 bg-zinc-800 rounded-sm px-2.5 py-1.5">
                {turn.instruction}
              </div>
            )}
            <div className="flex flex-col gap-1 text-xs text-zinc-400 bg-zinc-850 border border-zinc-800 rounded-sm px-2.5 py-2">
              <span className="text-zinc-300">{turn.note || "Applied."}</span>
              <span className="text-[10px] text-zinc-500 leading-relaxed">
                {Object.entries(turn.params).map(([k, v]) =>
                  `${k} ${typeof v === "number" ? Number(v.toFixed(2)) : v}`).join(" · ") || "no change"}
              </span>
            </div>
          </div>
        ))}

        {busy && (
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span className="w-3 h-3 rounded-full border-2 border-zinc-700 border-t-accent animate-spin" />
            Thinking
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 text-xs text-danger bg-danger/10 border border-danger/40 rounded-sm px-2.5 py-2">
            <span className="flex-1">{error}</span>
            <button onClick={onDismissError} className="text-zinc-400 hover:text-zinc-200">×</button>
          </div>
        )}
      </div>

      <div className="border-t border-zinc-800 px-5 py-3 flex flex-col gap-2">
        {turns.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTIONS.map(s => (
              <button
                key={s}
                disabled={busy}
                onClick={() => onPropose(s)}
                className="text-[11px] text-zinc-400 hover:text-zinc-200 border border-zinc-700 hover:border-zinc-600 disabled:opacity-40 rounded-full px-2.5 py-1"
              >{s}</button>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <input
            id="ai-prompt"
            value={draft}
            disabled={busy}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") submit(); }}
            placeholder="Make it warmer, less contrast..."
            className="flex-1 min-w-0 text-xs bg-zinc-950 border border-zinc-700 focus:border-zinc-500 outline-none rounded-sm px-2.5 py-2 text-zinc-200 placeholder:text-zinc-600"
          />
          <button
            onClick={submit}
            disabled={busy || draft.trim().length === 0}
            className="text-xs text-white bg-accent hover:bg-accent-hover disabled:opacity-40 rounded-sm px-3"
          >Send</button>
        </div>
        <button
          onClick={onRevert}
          disabled={!canRevert}
          className="text-[11px] text-zinc-400 hover:text-zinc-200 disabled:text-zinc-700 self-start"
        >Revert to before AI</button>
      </div>
    </div>
  );
}
