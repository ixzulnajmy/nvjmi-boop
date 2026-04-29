// file: server/interaction-agent.ts
// PATCHED: replaces claude-agent-sdk query() with direct Anthropic API call
// Reason: Agent SDK spawns claude subprocess which crashes on WSL2 (known bug)
// Tradeoff: MCP tools disabled temporarily. Memory, spawn_agent, automations come back
// once boop is verified working. Core conversation loop works fine.

import fs from "fs";
import os from "os";
import Anthropic from "@anthropic-ai/sdk";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { broadcast } from "./broadcast.js";
import { sendTelegram } from "./telegram.js";

// Read OAuth token from Claude Code credentials — always reads from disk so a
// token refreshed by the Claude CLI between turns is picked up immediately.
function getAuthToken(): string {
  if (process.env.ANTHROPIC_API_KEY) {
    return process.env.ANTHROPIC_API_KEY;
  }
  try {
    const credsPath = `${os.homedir()}/.claude/.credentials.json`;
    const creds = JSON.parse(fs.readFileSync(credsPath, "utf-8"));
    const token = creds?.claudeAiOauth?.accessToken;
    if (token) return token;
  } catch {
    // ignore
  }
  throw new Error("No auth token found. Set ANTHROPIC_API_KEY or run `claude` to login.");
}

function buildAnthropicClient(token: string): Anthropic {
  return new Anthropic({
    apiKey: token,
    ...(token.startsWith("sk-ant-oat") ? {
      defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
    } : {}),
  });
}

const INTERACTION_SYSTEM = `You are Boop, a personal AI agent the user texts on Telegram.

You are warm, witty, and concise. Write like you're texting a friend.
Keep replies under 400 chars when you can. No corporate voice. No bullet dumps unless asked.

You have access to the user's conversation history for context.
Answer questions directly from your knowledge. For tasks requiring external tools
(email, calendar, web search), let the user know you're working on adding those capabilities.

Format: Plain text. Markdown sparingly since this is Telegram.`;

interface HandleOpts {
  conversationId: string;
  content: string;
  turnTag?: string;
  onThinking?: (chunk: string) => void;
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function handleUserMessage(opts: HandleOpts): Promise<string> {
  const turnId = randomId("turn");
  const tag = opts.turnTag ?? turnId.slice(-6);
  const t0 = Date.now();
  const ms = () => `+${Date.now() - t0}ms`;
  const log = (msg: string) => console.log(`[turn ${tag}] ${ms()} ${msg}`);

  log(`START convId=${opts.conversationId} text="${opts.content.slice(0, 60)}"`);

  // ── 1. Load prior history ────────────────────────────────────────────────
  log("convex.query messages.recent → START");
  let history: Awaited<ReturnType<typeof convex.query<typeof api.messages.recent>>>;
  try {
    history = await convex.query(api.messages.recent, {
      conversationId: opts.conversationId,
      limit: 10,
    });
  } catch (err) {
    log(`convex.query FAILED: ${err}`);
    throw err;
  }
  log(`convex.query done — ${history.length} messages in history`);

  const messages: Anthropic.MessageParam[] = [
    ...history
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    { role: "user", content: opts.content },
  ];
  log(`messages array built — ${messages.length} entries (${messages.length - 1} history + 1 current)`);

  // ── 2. Persist user message ──────────────────────────────────────────────
  log("convex.mutation messages.send (user) → START");
  try {
    await convex.mutation(api.messages.send, {
      conversationId: opts.conversationId,
      role: "user",
      content: opts.content,
      turnId,
    });
  } catch (err) {
    log(`convex.mutation (user) FAILED: ${err}`);
    throw err;
  }
  log("convex.mutation messages.send (user) done");
  broadcast("user_message", { conversationId: opts.conversationId, content: opts.content });

  // ── 3. Call Anthropic API ────────────────────────────────────────────────
  const model = process.env.BOOP_MODEL ?? "claude-haiku-4-5-20251001";
  let reply = "";

  try {
    let token = getAuthToken();
    log(`auth token — prefix=${token.slice(0, 14)}… isOAuth=${token.startsWith("sk-ant-oat")}`);
    log(`Anthropic API → START model=${model}`);
    const apiStart = Date.now();

    let response: Anthropic.Message;
    try {
      response = await buildAnthropicClient(token).messages.create({
        model,
        max_tokens: 1024,
        system: INTERACTION_SYSTEM,
        messages,
      });
    } catch (err: any) {
      // 401 means the OAuth token expired. The Claude CLI refreshes it in the
      // credentials file — re-read from disk and retry exactly once.
      if (err?.status === 401) {
        log(`401 on first attempt — re-reading credentials and retrying`);
        token = getAuthToken();
        log(`retry token — prefix=${token.slice(0, 14)}…`);
        response = await buildAnthropicClient(token).messages.create({
          model,
          max_tokens: 1024,
          system: INTERACTION_SYSTEM,
          messages,
        });
        log(`retry succeeded`);
      } else {
        throw err;
      }
    }

    const textBlock = response.content.find((b) => b.type === "text");
    reply = textBlock?.type === "text" ? textBlock.text.trim() : "(no reply)";

    const apiMs = Date.now() - apiStart;
    log(`Anthropic API done — ${response.usage.input_tokens}in/${response.usage.output_tokens}out in ${apiMs}ms`);

    await convex.mutation(api.usageRecords.record, {
      source: "dispatcher",
      conversationId: opts.conversationId,
      turnId,
      model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      durationMs: apiMs,
    }).catch((err) => log(`usageRecords.record non-fatal: ${err}`));

  } catch (err) {
    log(`Anthropic API FAILED: ${err}`);
    reply = "Sorry — I hit an error processing that. Try again in a moment.";
  }

  reply = reply || "(no reply)";

  // ── 4. Persist assistant reply ───────────────────────────────────────────
  log("convex.mutation messages.send (assistant) → START");
  try {
    await convex.mutation(api.messages.send, {
      conversationId: opts.conversationId,
      role: "assistant",
      content: reply,
      turnId,
    });
  } catch (err) {
    log(`convex.mutation (assistant) FAILED: ${err}`);
  }
  log("convex.mutation messages.send (assistant) done");
  broadcast("assistant_message", { conversationId: opts.conversationId, content: reply });

  // ── 5. Deliver via Telegram ──────────────────────────────────────────────
  if (opts.conversationId.startsWith("tg:")) {
    const chatId = opts.conversationId.slice(3);
    log(`sendTelegram → START chatId=${chatId}`);
    await sendTelegram(chatId, reply).catch((err) => {
      log(`sendTelegram FAILED: ${err}`);
    });
    log("sendTelegram done");
  }

  log(`DONE — total ${ms()}`);
  return reply;
}