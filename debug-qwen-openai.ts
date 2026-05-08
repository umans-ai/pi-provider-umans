/**
 * Debug: test the OpenAI completions endpoint for Qwen thinking
 */
import { writeFileSync } from "node:fs";

const API_KEY = process.env.UMANS_API_KEY;
if (!API_KEY) { console.error("Set UMANS_API_KEY"); process.exit(1); }

const BASE_URL = "https://api.code.umans.ai/v1";
const MODEL = "umans-qwen3.6-35b-a3b";

const VARIANTS = [
  { label: "openai-with-enable_thinking", extra: { enable_thinking: true } },
  { label: "openai-without-enable_thinking", extra: {} },
];

const allResults: any = {};

for (const variant of VARIANTS) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Testing: ${variant.label}`);

  const payload: any = {
    model: MODEL,
    max_tokens: 1024,
    stream: true,
    messages: [{ role: "user", content: "What is 2+2? Think step by step." }],
    ...variant.extra,
  };

  const result: any = {
    request: payload,
    response: { status: null as number | null, headers: {} as Record<string, string>, events: [] as any[], contentChunks: [] as string[], reasoningChunks: [] as string[] },
  };

  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    result.response.status = res.status;
    for (const [k, v] of res.headers.entries()) result.response.headers[k] = v;

    if (!res.ok) {
      const text = await res.text();
      result.response.error = text;
      console.log(`  ERROR ${res.status}: ${text.slice(0, 300)}`);
      allResults[variant.label] = result;
      continue;
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        if (line.startsWith("data: ") && line !== "data: [DONE]") {
          try {
            const data = JSON.parse(line.slice(6));
            result.response.events.push(data);
            const delta = data.choices?.[0]?.delta;
            if (delta?.content) {
              result.response.contentChunks.push(delta.content);
            }
            if (delta?.reasoning_content) {
              result.response.reasoningChunks.push(delta.reasoning_content);
              console.log(`  reasoning_chunk: ${delta.reasoning_content.slice(0, 80)}...`);
            }
            if (data.choices?.[0]?.finish_reason) {
              console.log(`  finish_reason=${data.choices[0].finish_reason}`);
            }
            if (data.usage) {
              console.log(`  usage=${JSON.stringify(data.usage)}`);
            }
          } catch {}
        }
      }
    }

    console.log(`  Content: ${result.response.contentChunks.join("").length} chars`);
    console.log(`  Reasoning: ${result.response.reasoningChunks.join("").length} chars`);

  } catch (err: any) {
    result.response.error = err.message;
    console.log(`  FETCH ERROR: ${err.message}`);
  }

  allResults[variant.label] = result;
}

writeFileSync("/tmp/umans-qwen-openai-debug.json", JSON.stringify(allResults, null, 2));
console.log(`\nFull results saved to /tmp/umans-qwen-openai-debug.json`);
