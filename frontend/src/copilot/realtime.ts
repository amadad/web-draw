// OpenAI Realtime (gpt-realtime-2) WebRTC client for the in-tab voice co-pilot.
// Flow: mint ephemeral secret (our backend) → RTCPeerConnection (mic + remote audio)
// → data channel → session.update with our tools → on function_call, run the tool and
// return its output. Also supports sendText() for typed commands (and headless testing).
import type { RunTool } from "./useCopilotTools";

type ToolSchema = { type: "function"; name: string; description: string; parameters: Record<string, unknown> };

export type CopilotState = "idle" | "connecting" | "live" | "error";

export type RealtimeOptions = {
  toolSchemas: ToolSchema[];
  runTool: RunTool;
  onState?: (s: CopilotState, detail?: string) => void;
  onEvent?: (label: string) => void;
};

const SESSION_INSTRUCTIONS = [
  "You are a drawing co-pilot embedded in an Excalidraw whiteboard.",
  "When the user asks for anything visual, USE THE TOOLS to draw/edit/navigate the canvas —",
  "do not just describe what you would do. Call get_scene first when you need element ids.",
  "Prefer add_diagram (Mermaid) for structured diagrams and add_elements for a few shapes.",
  "Keep spoken replies short — one sentence — since the result is visible on the canvas.",
].join(" ");

async function fetchCsrf(): Promise<{ token: string; header: string }> {
  const r = await fetch("/api/csrf-token", { credentials: "include" });
  return r.json();
}

async function mintEphemeralSecret(): Promise<{ client_secret: string; model: string }> {
  const { token, header } = await fetchCsrf();
  const r = await fetch("/api/realtime/session", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", [header]: token },
    body: "{}",
  });
  if (!r.ok) throw new Error(`session mint failed: ${r.status}`);
  return r.json();
}

export class RealtimeCopilot {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private micTrack: MediaStreamTrack | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private opts: RealtimeOptions;
  state: CopilotState = "idle";

  constructor(opts: RealtimeOptions) {
    this.opts = opts;
  }

  private setState(s: CopilotState, detail?: string) {
    this.state = s;
    this.opts.onState?.(s, detail);
  }

  async connect(): Promise<void> {
    if (this.state === "connecting" || this.state === "live") return;
    this.setState("connecting");
    try {
      const { client_secret, model } = await mintEphemeralSecret();

      const pc = new RTCPeerConnection();
      this.pc = pc;

      // Remote model audio → hidden <audio>.
      this.audioEl = document.createElement("audio");
      this.audioEl.autoplay = true;
      pc.ontrack = (e) => {
        if (this.audioEl) this.audioEl.srcObject = e.streams[0];
      };

      // Local mic (push-to-talk starts muted). Non-fatal: if there's no mic or the
      // user denies permission, fall back to text-only mode (recvonly for model audio).
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.micTrack = mic.getAudioTracks()[0];
        this.micTrack.enabled = false;
        pc.addTrack(this.micTrack, mic);
      } catch (micErr) {
        console.warn("[copilot] no microphone — text-only mode", micErr);
        this.opts.onEvent?.("no mic: text-only mode");
        pc.addTransceiver("audio", { direction: "recvonly" });
      }

      // Events / tool-calls.
      const dc = pc.createDataChannel("oai-events");
      this.dc = dc;
      dc.onopen = () => this.configureSession();
      dc.onmessage = (e) => this.onServerEvent(JSON.parse(e.data));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpRes = await fetch(`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(model)}`, {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${client_secret}`, "Content-Type": "application/sdp" },
      });
      if (!sdpRes.ok) throw new Error(`SDP exchange failed: ${sdpRes.status}`);
      const answer = { type: "answer" as const, sdp: await sdpRes.text() };
      await pc.setRemoteDescription(answer);

      this.setState("live");
    } catch (err: any) {
      console.error("[copilot] connect failed", err);
      this.setState("error", err?.message || String(err));
      this.disconnect();
    }
  }

  private send(obj: unknown) {
    if (this.dc && this.dc.readyState === "open") this.dc.send(JSON.stringify(obj));
  }

  private configureSession() {
    this.send({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: SESSION_INSTRUCTIONS,
        tools: this.opts.toolSchemas,
        tool_choice: "auto",
      },
    });
    this.opts.onEvent?.("session configured");
  }

  // Type a command (also the headless test path). Triggers a model response.
  sendText(text: string) {
    this.send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    });
    this.send({ type: "response.create" });
  }

  setMicEnabled(on: boolean) {
    if (this.micTrack) this.micTrack.enabled = on;
  }

  private async onServerEvent(evt: any) {
    switch (evt.type) {
      case "response.function_call_arguments.done": {
        const { name, call_id, arguments: argStr } = evt;
        let args: unknown = {};
        try {
          args = argStr ? JSON.parse(argStr) : {};
        } catch {
          /* leave as {} */
        }
        this.opts.onEvent?.(`tool: ${name}`);
        const result = await this.opts.runTool(name, args);
        this.send({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id, output: result },
        });
        this.send({ type: "response.create" });
        break;
      }
      case "error":
        console.error("[copilot] realtime error", evt.error);
        this.opts.onEvent?.(`error: ${evt.error?.message || "unknown"}`);
        break;
      default:
        // response.audio_transcript.*, response.done, etc. — ignored for now.
        break;
    }
  }

  disconnect() {
    try {
      this.micTrack?.stop();
      this.dc?.close();
      this.pc?.close();
    } catch {
      /* noop */
    }
    this.micTrack = null;
    this.dc = null;
    this.pc = null;
    if (this.audioEl) {
      this.audioEl.srcObject = null;
      this.audioEl = null;
    }
    if (this.state !== "error") this.setState("idle");
  }
}
