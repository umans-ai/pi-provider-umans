// ponytail: one runnable check for the branchy pure logic of the vision handoff.
// Verifies model picking (env override / default / fallback / none) and image-id
// hashing. Does NOT cover the network path (analyzeImage) — that's integration.
//
// Run: bun selfcheck.ts
import { isNativeVision, pickVisionModel, hashImageId, stripClientWebSearchTool } from "./index.ts";

function vision(
  name: string,
  v: boolean | "via-handoff" = true,
  deprecation?: unknown,
) {
  return { name, capabilities: { supports_vision: v }, ...(deprecation ? { deprecation } : {}) };
}

const CATALOG = {
  "umans-kimi-k2.6": vision("umans-kimi-k2.6", true),
  "umans-kimi-k2.7": vision("umans-kimi-k2.7", true),
  "umans-glm-5.2": vision("umans-glm-5.2", "via-handoff"),
  "umans-coder": vision("umans-coder", true),
};

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("ok  ", msg);
}

// --- isNativeVision: true only for non-deprecated native-vision models ---
assert(isNativeVision(vision("a", true)) === true, "native vision is native");
assert(isNativeVision(vision("a", "via-handoff")) === false, "via-handoff is not native");
assert(isNativeVision(vision("a", true, "deprecated")) === false, "deprecated is not native");
assert(isNativeVision(vision("a", false)) === false, "non-vision is not native");

// --- pickVisionModel ---
delete process.env.UMANS_VISION_MODEL;
assert(pickVisionModel(CATALOG) === "umans-kimi-k2.7", "defaults to kimi-k2.7 (not insertion-order k2.6)");

process.env.UMANS_VISION_MODEL = "umans-coder";
assert(pickVisionModel(CATALOG) === "umans-coder", "env override honored when native-vision");

process.env.UMANS_VISION_MODEL = "umans-glm-5.2"; // via-handoff, not native
assert(pickVisionModel(CATALOG) === "umans-kimi-k2.7", "env override pointing at via-handoff ignored");

process.env.UMANS_VISION_MODEL = "umans-does-not-exist";
assert(pickVisionModel(CATALOG) === "umans-kimi-k2.7", "unknown env override ignored");

const NO_KIMI = {
  "umans-glm-5.2": vision("umans-glm-5.2", "via-handoff"),
  "umans-coder": vision("umans-coder", true),
};
delete process.env.UMANS_VISION_MODEL;
assert(pickVisionModel(NO_KIMI) === "umans-coder", "falls back to first native-vision model");

const TEXT_ONLY = { "umans-glm-5.2": vision("umans-glm-5.2", "via-handoff") };
assert(pickVisionModel(TEXT_ONLY) === undefined, "undefined when no native-vision model");

// --- hashImageId: deterministic, unique, well-formed ---
const a = hashImageId("data-a");
assert(a === hashImageId("data-a"), "hash is deterministic");
assert(a !== hashImageId("data-b"), "hash differs for different images");
assert(/^img_[0-9a-f]{8}$/.test(a), "hash format is img_<8 hex>");

// --- stripClientWebSearchTool: drop client `web_search`, keep the rest ---
// Regression guard for the umans-gateway echo bug: the gateway auto-promotes
// any client tool named `web_search` into a server-side Exa search on every
// turn (last user message = query), corrupting the reply. pi-web-access
// registers exactly such a tool.
const TOOLS = [
  { name: "read" },
  { name: "web_search", description: "pi-web-access client tool" },
  { name: "umans_web_search" },
  { name: "fetch_content" },
];
const stripped = stripClientWebSearchTool(TOOLS);
assert(stripped.length === 3, "removes the single client web_search tool");
assert(!stripped.some((t) => t.name === "web_search"), "no web_search survives");
assert(stripped.some((t) => t.name === "umans_web_search"), "keeps umans_web_search");
assert(stripped.some((t) => t.name === "fetch_content"), "keeps unrelated tools");
assert(stripClientWebSearchTool([{ name: "read" }, { name: "bash" }]).length === 2, "no-op when web_search absent");
assert(stripClientWebSearchTool([]).length === 0, "empty in, empty out");
// An explicit server tool (type web_search_20250305) is preserved on purpose.
const SERVER = [{ type: "web_search_20250305", name: "web_search" }];
assert(stripClientWebSearchTool(SERVER).length === 1, "keeps explicit server web_search_20250305");
// Untouched when only same-named-but-different-type tools exist.
assert(stripClientWebSearchTool([{ name: "web_search_exa" }]).length === 1, "leaves web_search_exa alone");

console.log("\nall checks passed");
