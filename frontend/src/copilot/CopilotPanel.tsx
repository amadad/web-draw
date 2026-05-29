// Co-pilot panel. Phase 1: a typed-command harness that invokes tools directly,
// so the tool spine can be proven before any voice/LLM is wired. Phase 3 adds the
// push-to-talk voice button alongside this. Mount only when the feature flag is on.
import { useState } from "react";
import type { RunTool } from "./useCopilotTools";

const EXAMPLES = [
  '{"tool":"add_elements","args":{"skeletons":[{"type":"rectangle","x":100,"y":100,"width":160,"height":80,"label":{"text":"API"}}]}}',
  '{"tool":"get_scene","args":{}}',
  '{"tool":"set_viewport","args":{"fit":"all"}}',
  '{"tool":"add_diagram","args":{"mermaid":"flowchart LR\\n A[Client] --> B[API] --> C[(DB)]"}}',
];

export function CopilotPanel({ runTool }: { runTool: RunTool }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState(EXAMPLES[0]);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      let parsed: any;
      try {
        parsed = JSON.parse(input);
      } catch {
        setLog((l) => ['⚠ Input must be JSON: {"tool":"...","args":{...}}', ...l]);
        return;
      }
      const result = await runTool(parsed.tool, parsed.args ?? {});
      setLog((l) => [`✓ ${parsed.tool}: ${result}`, ...l].slice(0, 12));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="Co-pilot (beta)"
        className="fixed bottom-4 right-4 z-50 rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-lg hover:bg-indigo-500"
        data-testid="copilot-open"
      >
        🤖 Co-pilot
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 w-96 rounded-xl border border-gray-200 bg-white p-3 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">Co-pilot — tool harness</span>
        <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600" aria-label="Close">
          ✕
        </button>
      </div>
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        rows={4}
        spellCheck={false}
        data-testid="copilot-input"
        className="w-full rounded-md border border-gray-300 bg-gray-50 p-2 font-mono text-xs text-gray-900 dark:border-neutral-600 dark:bg-neutral-800 dark:text-gray-100"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={run}
          disabled={busy}
          data-testid="copilot-run"
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {busy ? "Running…" : "Run"}
        </button>
        <select
          onChange={(e) => e.target.value && setInput(e.target.value)}
          value=""
          className="flex-1 rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs dark:border-neutral-600 dark:bg-neutral-800 dark:text-gray-100"
        >
          <option value="">Insert example…</option>
          {EXAMPLES.map((ex, i) => (
            <option key={i} value={ex}>
              {JSON.parse(ex).tool}
            </option>
          ))}
        </select>
      </div>
      <div className="mt-2 max-h-40 overflow-auto rounded-md bg-gray-50 p-2 font-mono text-[11px] text-gray-700 dark:bg-neutral-800 dark:text-gray-300" data-testid="copilot-log">
        {log.length === 0 ? <div className="text-gray-400">Results appear here…</div> : log.map((line, i) => <div key={i}>{line}</div>)}
      </div>
    </div>
  );
}
