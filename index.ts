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
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

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
const USER_AGENT = "pi-umans-provider/1.2.5";
const STATUS_UPDATE_INTERVAL_MS = 1000;

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
  let value =
    typeof recommended === "number" && recommended > 0 ? recommended : fallback;
  if (typeof cap === "number" && cap > 0) {
    value = Math.min(value, cap - 1);
  }
  return Math.max(value, 1);
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
  if (process.env.UMANS_DISABLE === "1") return;

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
          // Adaptive thinking returns thinking blocks with NO valid signature.
          // pi's default converts unsigned prior thinking to plain text on the next
          // turn, which corrupts context: the model echoes it as
          // `[Thinking from previous turn]`, the marker stacks each turn, and any
          // junk directive locks in (observed degrading a long helpdesk build until
          // thinking collapsed to just the marker). Preserve the thinking block with
          // an empty signature instead — Umans accepts empty-signature thinking.
          allowEmptySignature: true,
        },
      };
    });

  if (models.length === 0) {
    throw new Error("Umans provider: no models available from gateway or fallback");
  }

  async function loginUmans(
    callbacks: OAuthLoginCallbacks,
  ): Promise<OAuthCredentials> {
    const apiKey = await callbacks.onPrompt({
      message: "Enter your Umans API key:",
    });
    const key = apiKey.trim();
    if (!key) throw new Error("Umans API key is required");
    return {
      refresh: key,
      access: key,
      expires: Date.now() + 100 * 365 * 24 * 60 * 60 * 1000,
    };
  }

  function refreshUmansToken(
    credentials: OAuthCredentials,
  ): Promise<OAuthCredentials> {
    return Promise.resolve(credentials);
  }

  function getApiKey(credentials: OAuthCredentials): string {
    return credentials.access;
  }

  pi.registerProvider("umans", {
    name: "Umans",
    baseUrl,
    apiKey: `$${API_KEY_ENV}`,
    api: "anthropic-messages",
    authHeader: true,
    models,
    oauth: {
      name: "Umans",
      login: loginUmans,
      refreshToken: refreshUmansToken,
      getApiKey,
    },
  });

  // === Status bar: TTFT | TPS | Conc current/guaranteed ===
  const STATUS_KEY = "umans";
  let guaranteedConcurrency: number | undefined;
  let currentConcurrency: number | undefined;
  let requestLimit: number | undefined;
  let requestsUsed: number | undefined;

  type LiveRequest = {
    startTime: number;
    firstTokenTime?: number;
    estimatedTokens: number;
    lastStatusUpdate: number;
  };
  let activeTurns = 0;
  let liveRequest: LiveRequest | undefined;
  let lastMetrics: { ttft?: number; tps?: number } = {};

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshStopped = false;

  function stopRefreshLoop() {
    refreshStopped = true;
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
  }

  function restartRefreshLoop(apiKey: string) {
    stopRefreshLoop();
    refreshStopped = false;
    scheduleRefresh(apiKey);
  }

  function scheduleRefresh(apiKey: string) {
    if (refreshStopped || !apiKey) return;
    refreshTimer = setTimeout(async () => {
      await refreshUsage(apiKey);
      scheduleRefresh(apiKey);
    }, 5000);
  }

  function computeCumulativeTps(req: LiveRequest, now: number): number {
    if (!req.firstTokenTime || req.estimatedTokens <= 0) return 0;
    const elapsedSec = (now - req.firstTokenTime) / 1000;
    // Wait a moment so a tiny first chunk does not create a wild initial value.
    if (elapsedSec < 0.5) return 0;
    return Math.round(req.estimatedTokens / elapsedSec);
  }

  function statusText(metrics?: { ttft?: number; tps?: number }) {
    const parts: string[] = [];
    if (metrics?.ttft !== undefined) parts.push(`TTFT ${metrics.ttft}ms`);
    if (metrics?.tps !== undefined) parts.push(`TPS ${metrics.tps}`);
    const guaranteed = guaranteedConcurrency !== undefined ? String(guaranteedConcurrency) : "?";
    // Account-wide conc from /v1/usage (includes other clients, not just this
    // pi instance). Floor with local active turns so the counter ticks on a
    // turn boundary before the next poll reflects it; ponytail: can overstate
    // if local turns don't map 1:1 to gateway sessions — drop the max if so.
    const current =
      currentConcurrency !== undefined
        ? String(Math.max(currentConcurrency, activeTurns))
        : activeTurns > 0 ? String(activeTurns) : "?";
    parts.push(`Conc ${current}/${guaranteed}`);
    // Only show request usage when the plan has a hard limit (e.g. the $20 tier).
    if (requestsUsed !== undefined && requestLimit !== undefined) {
      parts.push(`Req ${requestsUsed}/${requestLimit}`);
    }
    return `Umans ${parts.join(" │ ")}`;
  }

  function setWidget(ctx: any, text?: string) {
    try {
      ctx.ui.setWidget(
        STATUS_KEY,
        text ? [ctx.ui.theme.fg("dim", text)] : undefined,
        { placement: "belowEditor" },
      );
    } catch {
      // UI may not be available in all modes; ignore.
    }
  }

  function updateStatus(ctx: any, metrics?: { ttft?: number; tps?: number }) {
    if (metrics) {
      // TTFT is tied to the current response; update it when provided.
      if (metrics.ttft !== undefined) lastMetrics.ttft = metrics.ttft;
      // Keep the last non-zero TPS so the display does not flash 0 during
      // tool-call gaps or tiny response tails. It resets only when the user
      // switches away from Umans or the session shuts down.
      if (metrics.tps !== undefined && metrics.tps > 0) {
        lastMetrics.tps = metrics.tps;
      }
    }
    setWidget(ctx, statusText(lastMetrics));
  }

  async function refreshUsage(apiKey: string) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(`${baseUrl}/v1/usage`, {
        signal: ctrl.signal,
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
      // null ?? undefined normalizes unlimited (null) limits so the display
      // guards below hide them instead of rendering "x/null".
      guaranteedConcurrency = data.limits?.concurrency?.limit ?? undefined;
      currentConcurrency = data.usage?.concurrent_sessions;
      requestLimit = data.limits?.requests?.limit ?? undefined;
      requestsUsed = data.usage?.requests_in_window;
    } catch {
      // Leave as undefined; status bar will show "?".
    } finally {
      clearTimeout(timer);
    }
  }

  function isActiveUmans(ctx: any, msg?: any) {
    return (msg?.provider ?? ctx.model?.provider) === "umans";
  }

  async function resolveApiKey(ctx?: any): Promise<string | undefined> {
    const envKey = process.env[API_KEY_ENV]?.trim();
    if (envKey) return envKey;
    try {
      return await ctx?.modelRegistry?.getApiKeyForProvider("umans");
    } catch {
      return undefined;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    const apiKey = await resolveApiKey(ctx);
    if (ctx.model?.provider === "umans") {
      if (apiKey) await refreshUsage(apiKey);
      restartRefreshLoop(apiKey || "");
      updateStatus(ctx);
    }
  });

  pi.on("model_select", async (event, ctx) => {
    const provider = event.model.provider;
    if (provider !== "umans") {
      stopRefreshLoop();
      setWidget(ctx, undefined);
      activeTurns = 0;
      liveRequest = undefined;
      lastMetrics = {};
      return;
    }
    updateStatus(ctx);
    const apiKey = await resolveApiKey(ctx);
    if (apiKey) await refreshUsage(apiKey);
    restartRefreshLoop(apiKey || "");
  });

  // turn_start opens the TTFT clock: it fires before API-key/HTTP/prefill, so TTFT
  // spans the full send→first-token gap, not just the stream body from message_start.
  pi.on("turn_start", async (event, ctx) => {
    if (ctx.model?.provider !== "umans") return;
    activeTurns++;
    liveRequest = { startTime: event.timestamp, estimatedTokens: 0, lastStatusUpdate: 0 };
    updateStatus(ctx);
  });

  pi.on("turn_end", async (event, ctx) => {
    if (ctx.model?.provider !== "umans") return;
    activeTurns = Math.max(0, activeTurns - 1);
    updateStatus(ctx);
  });
  pi.on("message_update", async (event, ctx) => {
    if (ctx.model?.provider !== "umans") return;
    const req = liveRequest;
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
      if (elapsedSec > 0 && now - req.lastStatusUpdate > STATUS_UPDATE_INTERVAL_MS) {
        const tps = computeCumulativeTps(req, now);
        updateStatus(ctx, { tps, ttft: req.firstTokenTime - req.startTime });
        req.lastStatusUpdate = now;
      }
    }
  });

  pi.on("message_end", async (event, ctx) => {
    const msg = event.message as any;
    if (!isActiveUmans(ctx, msg)) return;
    if (msg?.role !== "assistant") return;
    const req = liveRequest;
    let ttft: number | undefined;
    let tps: number | undefined;
    if (req) {
      ttft = req.firstTokenTime ? req.firstTokenTime - req.startTime : undefined;
      // Compute final TPS from the cumulative live count, excluding tool-call
      // JSON so a big tool argument dump does not spike TPS.
      tps = computeCumulativeTps(req, Date.now());
      liveRequest = undefined;
    }
    updateStatus(ctx, { ttft, tps });
  });

  // Safety nets: if anything aborts or finishes without firing message_end/turn_end,
  // reset counters so the status bar never stays inflated.
  pi.on("agent_end", async (_event, ctx) => {
    if (ctx.model?.provider !== "umans") return;
    activeTurns = 0;
    liveRequest = undefined;
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopRefreshLoop();
    activeTurns = 0;
    liveRequest = undefined;
    lastMetrics = {};
    setWidget(ctx, undefined);
  });

}


