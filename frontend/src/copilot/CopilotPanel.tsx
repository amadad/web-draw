// Co-pilot panel: voice (push-to-talk) + text-to-agent + a raw tool-runner for debugging.
// Voice/text drive the gpt-realtime-2 session; the session calls our canvas tools.
import { useEffect, useRef, useState } from "react";
import type { RunTool } from "./useCopilotTools";
import { RealtimeCopilot, type CopilotState } from "./realtime";
import { realtimeToolSchemas } from "./tools";

const TOOL_EXAMPLES = [
  '{"tool":"add_elements","args":{"skeletons":[{"type":"rectangle","x":100,"y":100,"width":160,"height":80,"label":{"text":"API"}}]}}',
  '{"tool":"get_scene","args":{}}',
  '{"tool":"set_viewport","args":{"fit":"all"}}',
];

const STATE_LABEL: Record<CopilotState, string> = {
  idle: "● idle",
  connecting: "● connecting…",
  live: "● live",
  error: "● error",
};
const STATE_COLOR: Record<CopilotState, string> = {
  idle: "text-gray-400",
  connecting: "text-amber-500",
  live: "text-emerald-500",
  error: "text-red-500",
};

export function CopilotPanel({ runTool }: { runTool: RunTool }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<CopilotState>("idle");
  const [log, setLog] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [dev, setDev] = useState(false);
  const [toolInput, setToolInput] = useState(TOOL_EXAMPLES[0]);
  const rtRef = useRef<RealtimeCopilot | null>(null);

  const pushLog = (line: string) => setLog((l) => [line, ...l].slice(0, 14));

  useEffect(() => () => rtRef.current?.disconnect(), []);

  const start = async () => {
    if (rtRef.current) return;
    const rt = new RealtimeCopilot({
      toolSchemas: realtimeToolSchemas(),
      runTool: async (name, args) => {
        const r = await runTool(name, args);
        pushLog(`✓ ${name}: ${r}`);
        return r;
      },
      onState: (s, detail) => {
        setState(s);
        if (detail) pushLog(`${s}: ${detail}`);
      },
      onEvent: (label) => pushLog(label),
    });
    rtRef.current = rt;
    await rt.connect();
  };

  const stop = () => {
    rtRef.current?.disconnect();
    rtRef.current = null;
    setState("idle");
  };

  const sendText = () => {
    const t = text.trim();
    if (!t || !rtRef.current || state !== "live") return;
    pushLog(`🗣 ${t}`);
    rtRef.current.sendText(t);
    setText("");
  };

  const runToolJson = async () => {
    try {
      const parsed = JSON.parse(toolInput);
      const r = await runTool(parsed.tool, parsed.args ?? {});
      pushLog(`✓ ${parsed.tool}: ${r}`);
    } catch (e: any) {
      pushLog(`⚠ ${e?.message || "invalid JSON"}`);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="Co-pilot"
        className="fixed bottom-4 right-4 z-50 rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-lg hover:bg-indigo-500"
        data-testid="copilot-open"
      >
        🤖 Co-pilot
      </button>
    );
  }

  const live = state === "live";

  return (
    <div className="fixed bottom-4 right-4 z-50 w-96 rounded-xl border border-gray-200 bg-white p-3 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">
          🤖 Co-pilot <span className={`ml-1 text-xs ${STATE_COLOR[state]}`}>{STATE_LABEL[state]}</span>
        </span>
        <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600" aria-label="Close">
          ✕
        </button>
      </div>

      <div className="flex items-center gap-2">
        {state === "idle" || state === "error" ? (
          <button
            onClick={start}
            data-testid="copilot-start"
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
          >
            Start co-pilot
          </button>
        ) : (
          <button onClick={stop} data-testid="copilot-stop" className="rounded-md bg-gray-200 px-3 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-300 dark:bg-neutral-700 dark:text-gray-100">
            Stop
          </button>
        )}
        {live && (
          <button
            onMouseDown={() => rtRef.current?.setMicEnabled(true)}
            onMouseUp={() => rtRef.current?.setMicEnabled(false)}
            onMouseLeave={() => rtRef.current?.setMicEnabled(false)}
            data-testid="copilot-ptt"
            className="select-none rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 active:bg-emerald-700"
            title="Hold to talk"
          >
            🎙 Hold to talk
          </button>
        )}
      </div>

      {live && (
        <div className="mt-2 flex items-center gap-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendText()}
            placeholder="Tell the co-pilot… (e.g. draw the auth flow)"
            data-testid="copilot-text"
            className="flex-1 rounded-md border border-gray-300 bg-gray-50 px-2 py-1.5 text-sm dark:border-neutral-600 dark:bg-neutral-800 dark:text-gray-100"
          />
          <button onClick={sendText} data-testid="copilot-send" className="rounded-md bg-indigo-600 px-2.5 py-1.5 text-sm text-white hover:bg-indigo-500">
            Send
          </button>
        </div>
      )}

      <div className="mt-2 max-h-40 overflow-auto rounded-md bg-gray-50 p-2 font-mono text-[11px] text-gray-700 dark:bg-neutral-800 dark:text-gray-300" data-testid="copilot-log">
        {log.length === 0 ? <div className="text-gray-400">Start the co-pilot, then talk or type…</div> : log.map((line, i) => <div key={i}>{line}</div>)}
      </div>

      <button onClick={() => setDev((d) => !d)} className="mt-2 text-[11px] text-gray-400 hover:text-gray-600">
        {dev ? "▾ hide dev tools" : "▸ dev tools"}
      </button>
      {dev && (
        <div className="mt-1 flex items-center gap-2">
          <input
            value={toolInput}
            onChange={(e) => setToolInput(e.target.value)}
            spellCheck={false}
            data-testid="copilot-input"
            className="flex-1 rounded-md border border-gray-300 bg-gray-50 px-2 py-1.5 font-mono text-[11px] dark:border-neutral-600 dark:bg-neutral-800 dark:text-gray-100"
          />
          <button onClick={runToolJson} data-testid="copilot-run" className="rounded-md bg-gray-700 px-2 py-1.5 text-xs text-white hover:bg-gray-600">
            Run
          </button>
        </div>
      )}
    </div>
  );
}
