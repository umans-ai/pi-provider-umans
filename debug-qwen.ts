/**
 * Debug script: sends a request to the Umans Anthropic Messages endpoint
 * with thinking enabled, captures the full streaming response, and saves
 * everything to /tmp/umans-qwen-debug.json
 *
 * Usage: UMANS_API_KEY=sk-... npx tsx debug-qwen.ts
 */

const API_KEY = process.env.UMANS_API_KEY;
if (!API_KEY) {
  console.error("Set UMANS_API_KEY env var");
  process.exit(1);
}

const BASE_URL = "https://api.code.umans.ai";

async function debug() {
  const payload = {
    model: "umans-qwen3.6-35b-a3b",
    max_tokens: 1024,
    stream: true,
    thinking: { type: "enabled", budget_tokens: 16384, display: "summarized" },
    messages: [
      {
        role: "user",
        content: "What is 2+2? Think step by step.",
      },
    ],
  };

  const debugData: any = {
    timestamp: new Date().toISOString(),
    request: {
      url: `${BASE_URL}/v1/messages`,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": "***redacted***",
        accept: "application/json",
      },
      payload,
    },
    response: {
      status: null as number | null,
      headers: {} as Record<string, string>,
      events: [] as any[],
      rawChunks: [] as string[],
    },
    finalMessage: null as any,
  };

  console.log("Sending request...");
  console.log("Payload:", JSON.stringify(payload, null, 2));

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

  debugData.response.status = res.status;
  for (const [k, v] of res.headers.entries()) {
    debugData.response.headers[k] = v;
  }

  console.log(`\nResponse status: ${res.status}`);
  console.log("Response headers:", JSON.stringify(debugData.response.headers, null, 2));

  if (!res.ok) {
    const text = await res.text();
    console.error("Error response:", text);
    debugData.response.rawChunks.push(text);
    writeDebug(debugData);
    return;
  }

  // Parse SSE stream
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentMessage: any = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    debugData.response.rawChunks.push(buffer.slice(-500)); // keep last 500 chars per chunk

    const lines = buffer.split("\n");
    buffer = lines.pop()!;

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        const eventType = line.slice(7).trim();
        debugData.response.events.push({ event: eventType });
      } else if (line.startsWith("data: ")) {
        const dataStr = line.slice(6);
        try {
          const data = JSON.parse(dataStr);
          const lastEvent = debugData.response.events[debugData.response.events.length - 1];
          if (lastEvent) lastEvent.data = data;

          // Log interesting events
          if (data.type === "message_start") {
            currentMessage = data.message;
            console.log(`\nmessage_start: model=${data.message?.model}, thinking=${JSON.stringify(data.message?.thinking)}`);
          } else if (data.type === "content_block_start") {
            console.log(`content_block_start: index=${data.index}, type=${data.content_block?.type}`);
            if (data.content_block?.type === "thinking") {
              console.log(`  thinking block started — thinking=${JSON.stringify(data.content_block?.thinking)?.slice(0, 100)}`);
            }
          } else if (data.type === "content_block_stop") {
            console.log(`content_block_stop: index=${data.index}`);
          } else if (data.type === "message_delta") {
            if (data.delta?.stop_reason) {
              console.log(`message_delta: stop_reason=${data.delta.stop_reason}`);
            }
          } else if (data.type === "message_stop") {
            console.log("message_stop");
          }
        } catch {
          // non-JSON data line
        }
      }
    }
  }

  debugData.finalMessage = currentMessage;
  writeDebug(debugData);
}

import { writeFileSync } from "node:fs";

function writeDebug(data: any) {
  const outPath = "/tmp/umans-qwen-debug.json";
  data.response.rawChunks = data.response.rawChunks.slice(-20);
  writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`\nFull debug data saved to ${outPath}`);
}

debug().catch(console.error);
