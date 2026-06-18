/**
 * Umans provider for pi.
 *
 * Registers the Umans Code gateway (https://api.code.umans.ai) as a first-class
 * pi provider using its Anthropic-compatible /v1/messages endpoint.
 *
 * Configuration is read from environment:
 *   UMANS_API_KEY          - required for inference (pi resolves $UMANS_API_KEY)
 *   UMANS_BASE_URL         - override gateway base URL (default: https://api.code.umans.ai)
 *   UMANS_BUDGET_THINKING  - "1" opts out of adaptive (effort-level) thinking into legacy budget-based thinking
 *   UMANS_DISABLE          - "1" disables the extension entirely
 *
 * Models and capabilities are fetched live from /v1/models/info on extension
 * load. If the gateway is unreachable, a static fallback catalog is used so the
 * provider still registers.
 *
 * Usage:
 *   UMANS_API_KEY=uk-... pi -e ~/.pi/agent/extensions/umans-provider
 *   # then /model umans/umans-coder
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ReasoningInfo = {
  supported: boolean;
  can_disable: boolean;
  levels: string[];
  default_level: string;
};

type ModelCapabilities = {
  max_completion_tokens?: number;
  recommended_max_tokens?: number;
  context_window?: number;
  supports_vision?: boolean | "via-handoff";
  supports_tools?: boolean;
  reasoning?: ReasoningInfo;
};

type UmansModelInfo = {
  name: string;
  display_name?: string;
  description?: string;
  deprecation?: unknown;
  capabilities: ModelCapabilities;
};

const DEFAULT_BASE_URL = "https://api.code.umans.ai";
const API_KEY_ENV = "UMANS_API_KEY";
const USER_AGENT = "pi-umans-provider/1.0.0";

// Static fallback when /v1/models/info cannot be reached. Keep in sync with the
// public model list from https://api.code.umans.ai/v1/models
const STATIC_CATALOG: Record<string, UmansModelInfo> = {
  "umans-kimi-k2.6": {
    name: "umans-kimi-k2.6",
    display_name: "Umans Kimi K2.6",
    capabilities: {
      max_completion_tokens: 262144,
      recommended_max_tokens: 32768,
      context_window: 262144,
      supports_vision: true,
      supports_tools: true,
      reasoning: {
        supported: true,
        can_disable: true,
        levels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
        default_level: "medium",
      },
    },
  },
  "umans-kimi-k2.7": {
    name: "umans-kimi-k2.7",
    display_name: "Umans Kimi K2.7 Code",
    capabilities: {
      max_completion_tokens: 262144,
      recommended_max_tokens: 32768,
      context_window: 262144,
      supports_vision: true,
      supports_tools: true,
      reasoning: {
        supported: true,
        can_disable: false,
        levels: ["minimal", "low", "medium", "high", "xhigh", "max"],
        default_level: "medium",
      },
    },
  },
  "umans-glm-5.1": {
    name: "umans-glm-5.1",
    display_name: "Umans GLM 5.1",
    capabilities: {
      max_completion_tokens: 131072,
      recommended_max_tokens: 131071,
      context_window: 202752,
      supports_vision: "via-handoff",
      supports_tools: true,
      reasoning: {
        supported: true,
        can_disable: true,
        levels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
        default_level: "medium",
      },
    },
  },
  "umans-glm-5.2": {
    name: "umans-glm-5.2",
    display_name: "Umans GLM 5.2",
    capabilities: {
      max_completion_tokens: 131072,
      recommended_max_tokens: 131071,
      context_window: 405504,
      supports_vision: "via-handoff",
      supports_tools: true,
      reasoning: {
        supported: true,
        can_disable: true,
        levels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
        default_level: "medium",
      },
    },
  },
  "umans-coder": {
    name: "umans-coder",
    display_name: "Umans Coder",
    capabilities: {
      max_completion_tokens: 262144,
      recommended_max_tokens: 32768,
      context_window: 262144,
      supports_vision: true,
      supports_tools: true,
      reasoning: {
        supported: true,
        can_disable: false,
        levels: ["minimal", "low", "medium", "high", "xhigh", "max"],
        default_level: "medium",
      },
    },
  },
  "umans-flash": {
    name: "umans-flash",
    display_name: "Umans Flash",
    capabilities: {
      max_completion_tokens: 262144,
      recommended_max_tokens: 32768,
      context_window: 262144,
      supports_vision: true,
      supports_tools: true,
      reasoning: {
        supported: true,
        can_disable: true,
        levels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
        default_level: "medium",
      },
    },
  },
  "umans-qwen3.6-35b-a3b": {
    name: "umans-qwen3.6-35b-a3b",
    display_name: "Umans Qwen3.6 35B A3B",
    capabilities: {
      max_completion_tokens: 262144,
      recommended_max_tokens: 32768,
      context_window: 262144,
      supports_vision: true,
      supports_tools: true,
      reasoning: {
        supported: true,
        can_disable: true,
        levels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
        default_level: "medium",
      },
    },
  },
};

/**
 * Resolve an output budget that never hits the gateway's hard cap.
 * The gateway rejects max_tokens >= max_completion_tokens with a 400.
 */
function safeMaxTokens(recommended?: number, cap?: number): number {
  const fallback = 32768;
  const value =
    typeof recommended === "number" && recommended > 0 ? recommended : fallback;
  if (typeof cap === "number" && cap > 0) {
    return Math.min(value, cap - 1);
  }
  return value;
}

/**
 * Models that report any vision support (native or via-handoff) can accept
 * images through the Anthropic /v1/messages endpoint. The gateway handles the
 * handoff internally; from the client's perspective they are vision-capable.
 */
function toInputModalities(info: UmansModelInfo): ("text" | "image")[] {
  const v = info.capabilities?.supports_vision;
  return v === true || v === "via-handoff"
    ? ["text", "image"]
    : ["text"];
}

/**
 * Map pi thinking levels to Umans reasoning levels.
 *
 * Umans exposes levels: none, minimal, low, medium, high, xhigh, max.
 * Pi exposes levels: off, minimal, low, medium, high, xhigh.
 * Pi has no "max" level, so pi's xhigh is mapped to Umans's max when available,
 * giving users access to the deepest reasoning tier via pi's highest level.
 * When a model cannot disable reasoning (can_disable === false), mark the
 * "off" level as unsupported (null) so pi clamps to the minimum level instead
 * of sending a disabled-thinking parameter the model rejects.
 */
function toThinkingLevelMap(
  info: UmansModelInfo,
): Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string | null>> {
  const reasoning = info.capabilities?.reasoning;
  if (!reasoning?.supported) return {};

  const levels = new Set(reasoning.levels);
  const map: Partial<
    Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string | null>
  > = {};

  map.off = reasoning.can_disable && levels.has("none") ? "none" : null;
  map.minimal = levels.has("minimal") ? "minimal" : null;
  map.low = levels.has("low") ? "low" : null;
  map.medium = levels.has("medium") ? "medium" : null;
  map.high = levels.has("high") ? "high" : null;
  map.xhigh = levels.has("max") ? "max" : levels.has("xhigh") ? "xhigh" : null;

  return map;
}

async function fetchModelCatalog(
  baseUrl: string,
): Promise<Record<string, UmansModelInfo> | undefined> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${baseUrl}/v1/models/info`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) return undefined;
    const data = await res.json();
    // Expect a flat object keyed by model id, each value carrying capabilities.
    // Reject arrays or wrapper shapes ({ data: [...] }) so we fall back to static.
    if (!data || Array.isArray(data) ||
        !Object.values(data).every((m: unknown) => !!m && typeof m === "object" &&
          typeof (m as UmansModelInfo).capabilities === "object")) {
      return undefined;
    }
    return Object.keys(data).length > 0 ? (data as Record<string, UmansModelInfo>) : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
export default async function (pi: ExtensionAPI) {
  if (process.env.UMANS_DISABLE) return;

  const baseUrl =
    process.env.UMANS_BASE_URL?.trim().replace(/\/$/, "") || DEFAULT_BASE_URL;

  // The model-info endpoint is public, so this works even before the user has
  // configured an API key. It lets pi --list-models report accurate models.
  const catalog = (await fetchModelCatalog(baseUrl)) ?? STATIC_CATALOG;

  // Umans models expose reasoning as effort levels (low/medium/high/xhigh/max),
  // which is Anthropic's adaptive-thinking format (`thinking.type: "adaptive"` +
  // `output_config.effort`). Force adaptive by default so pi sends that format.
  // Set UMANS_BUDGET_THINKING=1 to fall back to legacy budget-based thinking.
  const useBudgetThinking = process.env.UMANS_BUDGET_THINKING === "1";

  const models = Object.entries(catalog)
    .filter(([, info]) => !info.deprecation)
    .map(([id, info]) => {
      const capabilities = info.capabilities ?? {};
      const reasoning = capabilities.reasoning;

      return {
        id,
        name: info.display_name || info.name || id,
        reasoning: reasoning?.supported ?? false,
        thinkingLevelMap: toThinkingLevelMap(info),
        input: toInputModalities(info),
        // ponytail: Umans gateway is currently unmetered; revisit when pricing appears in /v1/models/info.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: capabilities.context_window || 262144,
        maxTokens: safeMaxTokens(
          capabilities.recommended_max_tokens,
          capabilities.max_completion_tokens,
        ),
        compat: {
          // Umans models use effort levels = Anthropic adaptive thinking format.
          // Force adaptive by default; UMANS_BUDGET_THINKING=1 opts into legacy
          // budget-based thinking.
          forceAdaptiveThinking: reasoning?.supported && !useBudgetThinking,
        },
      };
    });

  if (models.length === 0) {
    throw new Error("Umans provider: no models available from gateway or fallback");
  }

  pi.registerProvider("umans", {
    name: "Umans",
    baseUrl,
    apiKey: `$${API_KEY_ENV}`,
    api: "anthropic-messages",
    models,
  });

  // === Status bar: TTFT | TPS | Conc current/guaranteed ===
  const STATUS_KEY = "umans";
  let guaranteedConcurrency: number | undefined;
  let requestLimit: number | undefined;
  let requestsUsed: number | undefined;
  let currentProvider = "";

  type LiveRequest = {
    startTime: number;
    firstTokenTime?: number;
    estimatedTokens: number;
    lastStatusUpdate: number;
  };
  const liveRequests = new Map<string, LiveRequest>();
  let activeTurns = 0;

  function statusText(metrics?: { ttft?: number; tps?: number }) {
    const parts: string[] = [];
    if (metrics?.ttft !== undefined) parts.push(`TTFT ${metrics.ttft}ms`);
    if (metrics?.tps !== undefined && activeTurns > 0) parts.push(`TPS ${metrics.tps}`);
    const guaranteed = guaranteedConcurrency !== undefined ? String(guaranteedConcurrency) : "?";
    parts.push(`Conc ${activeTurns}/${guaranteed}`);
    if (requestsUsed !== undefined && requestLimit !== undefined) {
      parts.push(`Req ${requestsUsed}/${requestLimit}`);
    } else if (requestsUsed !== undefined) {
      parts.push(`Req ${requestsUsed}`);
    }
    return `umans ${parts.join(" | ")}`;
  }

  function updateStatus(ctx: any, metrics?: { ttft?: number; tps?: number }) {
    ctx.ui.setStatus(STATUS_KEY, statusText(metrics));
  }

  async function refreshUsage(apiKey: string) {
    try {
      const res = await fetch(`${baseUrl}/v1/usage`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
      });
      if (!res.ok) return;
      const data = await res.json() as {
        limits?: {
          concurrency?: { limit?: number };
          requests?: { limit?: number };
        };
        usage?: { requests_in_window?: number; concurrent_sessions?: number };
      };
      guaranteedConcurrency = data.limits?.concurrency?.limit;
      requestLimit = data.limits?.requests?.limit;
      requestsUsed = data.usage?.requests_in_window ?? data.usage?.concurrent_sessions;
    } catch {
      // Leave as undefined; status bar will show "?".
    }
  }

  function isActiveUmans(ctx: any, msg?: any) {
    return (msg?.provider ?? ctx.model?.provider) === "umans";
  }

  pi.on("session_start", async (_event, ctx) => {
    const apiKey = process.env[API_KEY_ENV]?.trim();
    if (apiKey) await refreshUsage(apiKey);
    if (ctx.model?.provider === "umans") updateStatus(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    currentProvider = event.model.provider;
    if (currentProvider !== "umans") {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      activeTurns = 0;
      liveRequests.clear();
      return;
    }
    updateStatus(ctx);
    const apiKey = process.env[API_KEY_ENV]?.trim();
    if (apiKey) await refreshUsage(apiKey);
  });

  // Track active provider turns for the concurrency counter. A turn maps to one
  // gateway request, so this is the most reliable signal for "current concurrency".
  pi.on("turn_start", async (_event, ctx) => {
    if (ctx.model?.provider !== "umans") return;
    activeTurns++;
    updateStatus(ctx);
  });

  pi.on("turn_end", async (event, ctx) => {
    if (ctx.model?.provider !== "umans") return;
    activeTurns = Math.max(0, activeTurns - 1);
    updateStatus(ctx);
  });

  // Track per-message latency and throughput for TTFT/TPS.
  pi.on("message_start", async (event, ctx) => {
    if (ctx.model?.provider !== "umans") return;
    const msg = event.message as any;
    if (msg?.role !== "assistant") return;
    const id = msg.id || `umans-${Date.now()}-${Math.random()}`;
    liveRequests.set(id, { startTime: Date.now(), estimatedTokens: 0, lastStatusUpdate: 0 });
    updateStatus(ctx);
  });

  pi.on("message_update", async (event, ctx) => {
    if (ctx.model?.provider !== "umans") return;
    const id = (event.message as any).id;
    const req = liveRequests.get(id);
    if (!req) return;
    const now = Date.now();
    const ev = event.assistantMessageEvent as any;
    let delta = "";
    if (ev?.type === "text_delta") delta = String(ev.delta ?? "");
    else if (ev?.type === "thinking_delta") delta = String(ev.delta ?? "");

    if (delta) {
      if (!req.firstTokenTime) req.firstTokenTime = now;
      req.estimatedTokens += Math.max(1, Math.round(delta.length / 4));
      const elapsedSec = req.firstTokenTime ? (now - req.firstTokenTime) / 1000 : 0;
      if (elapsedSec > 0 && now - req.lastStatusUpdate > 150) {
        const tps = Math.round(req.estimatedTokens / elapsedSec);
        updateStatus(ctx, { tps, ttft: req.firstTokenTime - req.startTime });
        req.lastStatusUpdate = now;
      }
    }
  });

  pi.on("message_end", async (event, ctx) => {
    const msg = event.message as any;
    if (!isActiveUmans(ctx, msg)) return;
    if (msg?.role !== "assistant") return;
    const id = msg.id;
    const req = liveRequests.get(id);
    let ttft: number | undefined;
    let tps: number | undefined;
    if (req) {
      ttft = req.firstTokenTime ? req.firstTokenTime - req.startTime : undefined;
      const outputTokens = typeof msg.usage?.output === "number" ? msg.usage.output : undefined;
      if (outputTokens && req.firstTokenTime) {
        const elapsedSec = (Date.now() - req.firstTokenTime) / 1000;
        if (elapsedSec > 0) tps = Math.round(outputTokens / elapsedSec);
      }
      liveRequests.delete(id);
    }
    updateStatus(ctx, { ttft, tps });
  });

  // Safety nets: if anything aborts or finishes without firing message_end/turn_end,
  // reset counters so the status bar never stays inflated.
  pi.on("agent_end", async (_event, ctx) => {
    if (ctx.model?.provider !== "umans") return;
    activeTurns = 0;
    liveRequests.clear();
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  // Refresh usage stats every 5s in TUI/RPC to keep the guaranteed limit current.
  const apiKey = process.env[API_KEY_ENV]?.trim();
  if (apiKey) {
    const loop = async () => {
      await refreshUsage(apiKey);
      setTimeout(loop, 5000);
    };
    loop();
  }
}


