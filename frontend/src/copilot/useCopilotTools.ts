// Binds the co-pilot tool registry to the live Excalidraw API ref and exposes a
// single `runTool(name, args)` dispatcher. Also (best-effort) registers the tools
// with WebMCP so an external MCP client can drive the same canvas. Returns the
// dispatcher plus the Realtime tool schemas for the voice layer.
import { useCallback, useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { TOOLS_BY_NAME, realtimeToolSchemas, type ExcalidrawApi } from "./tools";
import { registerToolsWithWebMCP } from "./webmcp";

export type RunTool = (name: string, args: unknown) => Promise<string>;

export function useCopilotTools(
  excalidrawAPI: MutableRefObject<ExcalidrawApi | null>,
  opts?: { canEdit?: boolean }
): { runTool: RunTool; toolSchemas: ReturnType<typeof realtimeToolSchemas> } {
  const canEdit = opts?.canEdit !== false;

  const runTool = useCallback<RunTool>(
    async (name, args) => {
      const tool = TOOLS_BY_NAME[name];
      if (!tool) return `Unknown tool: ${name}`;
      const api = excalidrawAPI.current;
      if (!api) return "Canvas not ready yet.";
      if (!canEdit && name !== "get_scene") return "Read-only access: cannot edit this drawing.";
      try {
        return await tool.handler(api, args ?? {});
      } catch (err: any) {
        console.error(`[copilot] tool ${name} failed`, err);
        return `Tool ${name} failed: ${err?.message || String(err)}`;
      }
    },
    [excalidrawAPI, canEdit]
  );

  // Keep a stable ref so WebMCP handlers always call the latest dispatcher.
  const runToolRef = useRef(runTool);
  runToolRef.current = runTool;

  useEffect(() => {
    const cleanup = registerToolsWithWebMCP((name, args) => runToolRef.current(name, args));
    return cleanup;
  }, []);

  return { runTool, toolSchemas: realtimeToolSchemas() };
}
