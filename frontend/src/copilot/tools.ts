// Co-pilot tool registry — MCP-shaped tool definitions that operate on the live
// Excalidraw imperative API. Each tool is the single source of truth: its JSON
// schema is fed to the OpenAI Realtime session as a function tool, and the same
// definition can be registered with WebMCP (see webmcp.ts) to expose an external
// MCP surface. Handlers mutate the scene via `api.updateScene(...)`, which the
// Editor's existing onChange wiring then broadcasts (socket) and autosaves (PUT).
//
// Pure module: no React. `api` is the ExcalidrawImperativeAPI handle.
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";

export type JSONSchema = Record<string, unknown>;

export type CopilotTool = {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  // Returns a short, model-facing result string (becomes the function_call output).
  handler: (api: ExcalidrawApi, args: any) => Promise<string> | string;
};

// Minimal structural type for the bits of the Excalidraw imperative API we use.
export type ExcalidrawApi = {
  getSceneElements: () => readonly any[];
  getSceneElementsIncludingDeleted: () => readonly any[];
  updateScene: (scene: { elements?: readonly any[]; appState?: Record<string, unknown> }) => void;
  scrollToContent: (target?: any, opts?: Record<string, unknown>) => void;
  getAppState: () => any;
};

// ---- helpers -------------------------------------------------------------

const summarizeElement = (el: any) => ({
  id: el.id,
  type: el.type,
  x: Math.round(el.x),
  y: Math.round(el.y),
  width: el.width != null ? Math.round(el.width) : undefined,
  height: el.height != null ? Math.round(el.height) : undefined,
  text: typeof el.text === "string" ? el.text.slice(0, 80) : undefined,
});

// Convert compact skeletons (model-friendly) into full Excalidraw elements.
// Skeleton shape mirrors Excalidraw's programmatic API, e.g.
//   { type: "rectangle", x, y, width, height, label: { text } }
//   { type: "arrow", x, y, width, height, start: { id }, end: { id } }
const skeletonsToElements = (skeletons: any[]) =>
  convertToExcalidrawElements(skeletons as any, { regenerateIds: true });

// ---- tools ---------------------------------------------------------------

export const COPILOT_TOOLS: CopilotTool[] = [
  {
    name: "get_scene",
    description:
      "List the elements currently on the board (id, type, position, size, text). Call this before editing so you know what exists and can reference ids.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: (api) => {
      const els = api.getSceneElements().map(summarizeElement);
      return JSON.stringify({ count: els.length, elements: els });
    },
  },
  {
    name: "add_elements",
    description:
      "Add one or more shapes/text/arrows to the board from compact skeletons. " +
      "Each skeleton: {type:'rectangle'|'ellipse'|'diamond'|'text'|'arrow'|'line', x, y, width?, height?, " +
      "label?:{text}, text?, strokeColor?, backgroundColor?}. For connectors use type:'arrow' with " +
      "start:{id} and end:{id} referencing existing element ids. Coordinates are canvas pixels.",
    inputSchema: {
      type: "object",
      properties: {
        skeletons: {
          type: "array",
          description: "Array of Excalidraw element skeletons to create.",
          items: { type: "object" },
        },
      },
      required: ["skeletons"],
      additionalProperties: false,
    },
    handler: (api, args) => {
      const skeletons = Array.isArray(args?.skeletons) ? args.skeletons : [];
      if (skeletons.length === 0) return "No skeletons provided.";
      const created = skeletonsToElements(skeletons);
      const existing = api.getSceneElementsIncludingDeleted();
      api.updateScene({ elements: [...existing, ...created] });
      return `Added ${created.length} element(s): ${created.map((e: any) => `${e.type}#${e.id.slice(0, 6)}`).join(", ")}`;
    },
  },
  {
    name: "add_diagram",
    description:
      "Render a Mermaid diagram (flowchart, sequence, class, etc.) onto the board. Provide valid Mermaid source. " +
      "Best for structured diagrams; for a few loose shapes use add_elements instead.",
    inputSchema: {
      type: "object",
      properties: {
        mermaid: { type: "string", description: "Mermaid diagram source." },
        x: { type: "number", description: "Optional top-left x offset (default 0)." },
        y: { type: "number", description: "Optional top-left y offset (default 0)." },
      },
      required: ["mermaid"],
      additionalProperties: false,
    },
    handler: async (api, args) => {
      const src = typeof args?.mermaid === "string" ? args.mermaid : "";
      if (!src.trim()) return "No mermaid source provided.";
      // Dynamic import: keeps this optional dep out of the critical path.
      const { parseMermaidToExcalidraw } = await import("@excalidraw/mermaid-to-excalidraw");
      const { elements: skeletons, files } = await parseMermaidToExcalidraw(src);
      const created = convertToExcalidrawElements(skeletons as any, { regenerateIds: true });
      const dx = Number(args?.x) || 0;
      const dy = Number(args?.y) || 0;
      const shifted = created.map((e: any) => ({ ...e, x: e.x + dx, y: e.y + dy }));
      const existing = api.getSceneElementsIncludingDeleted();
      api.updateScene({ elements: [...existing, ...shifted] });
      // Mermaid may emit image files (e.g. for some node types); ignore if none.
      void files;
      return `Rendered Mermaid diagram as ${shifted.length} element(s).`;
    },
  },
  {
    name: "update_element",
    description:
      "Modify properties of an existing element by id. Pass only the fields to change, " +
      "e.g. {id, backgroundColor, strokeColor, x, y, width, height, text}.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Target element id." },
        props: { type: "object", description: "Partial properties to merge onto the element." },
      },
      required: ["id", "props"],
      additionalProperties: false,
    },
    handler: (api, args) => {
      const id = String(args?.id || "");
      const props = (args?.props && typeof args.props === "object") ? args.props : {};
      const all = api.getSceneElementsIncludingDeleted();
      let found = false;
      const next = all.map((el: any) => {
        if (el.id !== id) return el;
        found = true;
        return { ...el, ...props, version: (el.version || 0) + 1 };
      });
      if (!found) return `No element with id ${id}.`;
      api.updateScene({ elements: next });
      return `Updated element ${id}.`;
    },
  },
  {
    name: "delete_elements",
    description: "Delete elements by id (marks them deleted so the deletion syncs to collaborators).",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Element ids to delete." },
      },
      required: ["ids"],
      additionalProperties: false,
    },
    handler: (api, args) => {
      const ids: string[] = Array.isArray(args?.ids) ? args.ids.map(String) : [];
      if (ids.length === 0) return "No ids provided.";
      const idSet = new Set(ids);
      const all = api.getSceneElementsIncludingDeleted();
      let n = 0;
      const next = all.map((el: any) => {
        if (!idSet.has(el.id) || el.isDeleted) return el;
        n += 1;
        return { ...el, isDeleted: true, version: (el.version || 0) + 1 };
      });
      api.updateScene({ elements: next });
      return `Deleted ${n} element(s).`;
    },
  },
  {
    name: "select_elements",
    description: "Select elements by id (highlights them for the user). Pass an empty array to clear selection.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Element ids to select." },
      },
      required: ["ids"],
      additionalProperties: false,
    },
    handler: (api, args) => {
      const ids: string[] = Array.isArray(args?.ids) ? args.ids.map(String) : [];
      const selectedElementIds: Record<string, true> = {};
      ids.forEach((id) => (selectedElementIds[id] = true));
      api.updateScene({ appState: { selectedElementIds } });
      return ids.length ? `Selected ${ids.length} element(s).` : "Cleared selection.";
    },
  },
  {
    name: "set_viewport",
    description:
      "Control what the user sees. Either fit the whole drawing ({fit:'all'}), zoom to specific elements " +
      "({fit:'elements', ids:[...]}), or set an explicit zoom level ({zoom: 1.5}).",
    inputSchema: {
      type: "object",
      properties: {
        fit: { type: "string", enum: ["all", "elements"], description: "Fit mode." },
        ids: { type: "array", items: { type: "string" }, description: "Element ids when fit='elements'." },
        zoom: { type: "number", description: "Explicit zoom level (e.g. 1 = 100%)." },
      },
      additionalProperties: false,
    },
    handler: (api, args) => {
      if (typeof args?.zoom === "number") {
        api.updateScene({ appState: { zoom: { value: args.zoom } } });
        return `Set zoom to ${Math.round(args.zoom * 100)}%.`;
      }
      if (args?.fit === "elements" && Array.isArray(args?.ids) && args.ids.length) {
        const idSet = new Set(args.ids.map(String));
        const targets = api.getSceneElements().filter((el: any) => idSet.has(el.id));
        api.scrollToContent(targets, { fitToContent: true, animate: true });
        return `Zoomed to ${targets.length} element(s).`;
      }
      api.scrollToContent(api.getSceneElements(), { fitToContent: true, animate: true });
      return "Fit the whole drawing into view.";
    },
  },
];

export const TOOLS_BY_NAME: Record<string, CopilotTool> =
  Object.fromEntries(COPILOT_TOOLS.map((t) => [t.name, t]));

// Tool schemas in the shape the OpenAI Realtime API expects (session.tools).
export const realtimeToolSchemas = () =>
  COPILOT_TOOLS.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));
