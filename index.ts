import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type {
  ProviderModelConfig,
  OAuthCredentials,
  OAuthLoginCallbacks,
  AssistantMessage,
} from "@mariozechner/pi-ai";

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

const MODELS_INFO_URL = "https://api.code.umans.ai/v1/models/info";
const USAGE_URL = "https://api.code.umans.ai/v1/usage";

const FALLBACK_MODELS: ProviderModelConfig[] = [
  {
    id: "umans-coder",
    name: "Umans Coder",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 32768,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "umans-kimi-k2.5",
    name: "Umans Kimi K2.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 32768,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "umans-kimi-k2.6",
    name: "Umans Kimi K2.6",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 32768,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "umans-glm-5.1",
    name: "Umans GLM 5.1",
    reasoning: true,
    input: ["text"],
    contextWindow: 202752,
    maxTokens: 131072,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "umans-minimax-m2.5",
    name: "Umans MiniMax M2.5",
    reasoning: true,
    input: ["text"],
    contextWindow: 204800,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
];

function mapUmansModel(id: string, info: any): ProviderModelConfig {
  const caps = info.capabilities ?? {};
  const supportsVision = caps.supports_vision === true;

  // recommended_max_tokens = max output tokens. Fall back to 65000 if missing or < 8192.
  const recommendedMax = caps.recommended_max_tokens;
  const maxTokens: number =
    typeof recommendedMax === "number" && recommendedMax >= 8192
      ? recommendedMax
      : 65000;
  return {
    id,
    name: info.display_name || id,
    reasoning: true,
    input: supportsVision ? ["text", "image"] : ["text"],
    contextWindow: caps.context_window ?? 200000,
    maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

// Dynamic model fetch at module load time
let models: ProviderModelConfig[] = FALLBACK_MODELS;

try {
  const res = await fetch(MODELS_INFO_URL, { signal: AbortSignal.timeout(5000) });
  if (res.ok) {
    const data = await res.json();
    models = Object.entries(data).map(([id, info]) =>
      mapUmansModel(id, info as any),
    );
  } else {
    console.warn(
      `[pi-provider-umans] Models API returned ${res.status}, using fallback`,
    );
  }
} catch (err) {
  console.warn(
    "[pi-provider-umans] Failed to fetch dynamic models, using fallback:",
    err,
  );
}

// ---------------------------------------------------------------------------
// OAuth (API key stored in auth.json)
// ---------------------------------------------------------------------------

async function loginUmans(
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  const apiKey = await callbacks.onPrompt({
    message: "Enter your Umans API key (starts with sk-):",
  });
  const key = apiKey.trim();
  if (!key.startsWith("sk-")) {
    throw new Error("Invalid API key: must start with 'sk-'");
  }
  // API keys don't expire — use far-future timestamp to avoid unnecessary refresh attempts
  return { refresh: key, access: key, expires: Date.now() + 100 * 365 * 24 * 60 * 60 * 1000 };
}

function refreshUmansToken(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  return Promise.resolve(credentials);
}

function getApiKey(credentials: OAuthCredentials): string {
  return credentials.access;
}

// ---------------------------------------------------------------------------
// Usage API
// ---------------------------------------------------------------------------

interface UsageData {
  plan: string;
  requestsUsed: number;
  requestsLimit: number | null;
  remainingRequests: number | null;
  resetsInMinutes: number | null;
  concurrent: number;
  concurrentLimit: number | null;
  tokensIn: number;
  tokensOut: number;
}

async function fetchUsage(apiKey: string): Promise<UsageData | null> {
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const plan = data.plan?.display_name || data.plan?.slug || "Unknown";
    const limits = data.limits ?? {};
    const usage = data.usage ?? {};
    const window = data.window ?? {};

    return {
      plan,
      requestsUsed: usage.requests_in_window ?? 0,
      requestsLimit: limits.requests?.limit ?? null,
      remainingRequests: usage.remaining_requests ?? null,
      resetsInMinutes: window.remaining_minutes ?? null,
      concurrent: usage.concurrent_sessions ?? 0,
      concurrentLimit: limits.concurrency?.limit ?? null,
      tokensIn: usage.tokens_in ?? 0,
      tokensOut: usage.tokens_out ?? 0,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// Shared state between status bar helpers
let lastApiKey: string | null = null;

async function updateUsageStatus(ctx: any, tps?: string, ttft?: string): Promise<void> {
  const theme = ctx.ui.theme;
  const apiKey = lastApiKey;
  if (!apiKey) return;

  const usage = await fetchUsage(apiKey);
  if (!usage) return;

  const perfParts: string[] = [];
  if (tps) perfParts.push(`T/S:${tps}`);
  if (ttft) perfParts.push(`TTFT:${ttft}`);
  const perfStr = perfParts.length > 0 ? perfParts.join(" │ ") + " │ " : "";

  const reqPart = usage.requestsLimit !== null
    ? `${usage.requestsUsed}/${usage.requestsLimit}`
    : `${usage.requestsUsed}`;
  const resetPart = usage.resetsInMinutes !== null ? ` ⟳${usage.resetsInMinutes}m` : "";

  ctx.ui.setWidget(
    "umans",
    [theme.fg("dim", `Umans ${perfStr}${reqPart}${resetPart}`)],
    { placement: "belowEditor" },
  );
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // --- Provider registration ---
  pi.registerProvider("umans", {
    baseUrl: "https://api.code.umans.ai",
    api: "anthropic-messages",
    apiKey: "UMANS_API_KEY",
    authHeader: true,
    models,
    oauth: {
      name: "Umans AI (API Key)",
      login: loginUmans,
      refreshToken: refreshUmansToken,
      getApiKey,
    },
  });

  // pi-ai's transform-messages.js already inserts synthetic tool_result entries
  // for orphaned tool_use blocks before this hook fires (see AnthropicMessagesCompat
  // and transform-messages.js). No manual repair needed.

  // --- Status bar: usage + performance ---
  let turnStartTime = 0;
  let firstTokenTime = 0;

  // Show usage on session start
  pi.on("session_start", async (_event, ctx) => {
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider("umans").catch(() => undefined);
    if (apiKey) {
      lastApiKey = apiKey;
      await updateUsageStatus(ctx, undefined, undefined);
    } else {
      const theme = ctx.ui.theme;
      ctx.ui.setWidget("umans", [theme.fg("dim", "Umans: /login umans")], { placement: "belowEditor" });
    }
  });

  // Track turn timing
  pi.on("turn_start", async (_event, _ctx) => {
    turnStartTime = Date.now();
    firstTokenTime = 0;
  });

  // Track first token (TTFT) — just record the time, no separate status
  pi.on("message_update", async (event, _ctx) => {
    if (firstTokenTime === 0 && turnStartTime > 0) {
      const msg = event.message as AssistantMessage;
      if (msg.role === "assistant" && msg.content?.length > 0) {
        firstTokenTime = Date.now();
      }
    }
  });

  // On turn end, compute TPS and refresh usage
  pi.on("turn_end", async (event, ctx) => {
    const theme = ctx.ui.theme;
    const msg = event.message as AssistantMessage;

    if (msg.role !== "assistant" || turnStartTime === 0) return;

    const elapsed = Date.now() - turnStartTime;
    const outputTokens = msg.usage?.output ?? 0;
    const tps =
      elapsed > 0 && outputTokens > 0 ? (outputTokens / (elapsed / 1000)).toFixed(0) : "—";
    const ttft = firstTokenTime > 0 ? fmtDuration(firstTokenTime - turnStartTime) : "—";

    // Resolve API key from model registry (covers env var and OAuth)
    let apiKey = await ctx.modelRegistry.getApiKeyForProvider("umans").catch(() => undefined) || lastApiKey;
    let usageStr = "";

    if (apiKey) {
      lastApiKey = apiKey;
      const usage = await fetchUsage(apiKey);
      if (usage) {
        const reqPart =
          usage.requestsLimit !== null
            ? `${usage.requestsUsed}/${usage.requestsLimit}`
            : `${usage.requestsUsed}`;
        const resetPart =
          usage.resetsInMinutes !== null
            ? ` ⟳${usage.resetsInMinutes}m`
            : "";
        usageStr = ` │ ${reqPart}${resetPart}`;
      }
    }

    const perfStr = usageStr ? `T/S:${tps} │ TTFT:${ttft}${usageStr}` : `T/S:${tps} │ TTFT:${ttft}`;
    ctx.ui.setWidget(
      "umans",
      [theme.fg("dim", `Umans ${perfStr}`)],
      { placement: "belowEditor" },
    );
  });
}
