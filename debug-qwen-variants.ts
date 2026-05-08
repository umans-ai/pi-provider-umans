/**
 * Debug: test multiple thinking param variants against the Umans Qwen model
 * and save all results to /tmp/umans-qwen-debug.json
 */
import { writeFileSync } from "node:fs";

const API_KEY = process.env.UMANS_API_KEY;
if (!API_KEY) { console.error("Set UMANS_API_KEY"); process.exit(1); }

const BASE_URL = "https://api.code.umans.ai";
const MODEL = "umans-qwen3.6-35b-a3b";

const VARIANTS = [
  { label: "1-full-anthropic-thinking", thinking: { type: "enabled", budget_tokens: 16384, display: "summarized" } },
  { label: "2-stripped-thinking", thinking: { type: "enabled" } },
  { label: "3-no-budget-tokens", thinking: { type: "enabled", display: "summarized" } },
  { label: "4-thinking-disabled", thinking: { type: "disabled" } },
  { label: "5-no-thinking-param" },
];

const allResults: any[] = {};

for (const variant of VARIANTS) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Testing: ${variant.label}`);
  console.log(`thinking param: ${JSON.stringify(variant.thinking ?? "(absent)")}`);

  const payload: any = {
    model: MODEL,
    max_tokens: 1024,
    stream: true,
    messages: [{ role: "user", content: "What is 2+2? Think step by step." }],
  };
  if (variant.thinking !== undefined) {
    payload.thinking = variant.thinking;
  }

  const result: any = {
    request: payload,
    response: { status: null as number | null, headers: {} as Record<string, string>, events: [] as any[], contentBlocks: [] as any[] },
  };

  try {
    const res = await fetch(`${BASE_URL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": API_KEY,
        accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    result.response.status = res.status;
    for (const [k, v] of res.headers.entries()) result.response.headers[k] = v;

    if (!res.ok) {
      const text = await res.text();
      result.response.error = text;
      console.log(`  ERROR ${res.status}: ${text.slice(0, 200)}`);
      allResults[variant.label] = result;
      continue;
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentBlock: any = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            result.response.events.push(data);
            if (data.type === "message_start") {
              console.log(`  message_start: model=${data.message?.model}, thinking=${JSON.stringify(data.message?.thinking)}`);
            } else if (data.type === "content_block_start") {
              currentBlock = { index: data.index, type: data.content_block?.type, text: data.content_block?.type === "thinking" ? "" : data.content_block?.text ?? "" };
              result.response.contentBlocks.push(currentBlock);
              console.log(`  content_block_start[${data.index}]: type=${data.content_block?.type}`);
            } else if (data.type === "content_block_delta" && currentBlock) {
              if (data.delta?.type === "thinking_delta") currentBlock.text += data.delta.thinking ?? "";
              else if (data.delta?.type === "text_delta") currentBlock.text += data.delta.text ?? "";
            } else if (data.type === "message_delta") {
              console.log(`  stop_reason=${data.delta?.stop_reason}, usage=${JSON.stringify(data.usage)}`);
            }
          } catch {}
        }
      }
    }

    console.log(`  Content blocks: ${result.response.contentBlocks.map((b: any) => `${b.type}(${b.text.length}chars)`).join(", ")}`);

  } catch (err: any) {
    result.response.error = err.message;
    console.log(`  FETCH ERROR: ${err.message}`);
  }

  allResults[variant.label] = result;
}

writeFileSync("/tmp/umans-qwen-debug.json", JSON.stringify(allResults, null, 2));
console.log(`\nFull results saved to /tmp/umans-qwen-debug.json`);
