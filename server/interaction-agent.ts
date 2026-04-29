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

// Read OAuth token from Claude Code credentials
function getAuthToken(): string {
  // First check for explicit API key
  if (process.env.ANTHROPIC_API_KEY) {
    return process.env.ANTHROPIC_API_KEY;
  }
  // Fall back to Claude Code OAuth token
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
  const log = (msg: string) => console.log(`[turn ${tag}] ${msg}`);

  // Store user message in Convex
  await convex.mutation(api.messages.send, {
    conversationId: opts.conversationId,
    role: "user",
    content: opts.content,
    turnId,
  });
  broadcast("user_message", { conversationId: opts.conversationId, content: opts.content });

  // Load conversation history
  const history = await convex.query(api.messages.recent, {
    conversationId: opts.conversationId,
    limit: 10,
  });

  // Build messages array for API
  const messages: Anthropic.MessageParam[] = history
    .slice(0, -1) // exclude the message we just saved
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

  // Add current message
  messages.push({ role: "user", content: opts.content });

  const model = process.env.BOOP_MODEL ?? "claude-haiku-4-5-20251001";
  const turnStart = Date.now();

  let reply = "";

  try {
    const token = getAuthToken();

    const client = new Anthropic({
      apiKey: token,
      ...(token.startsWith("sk-ant-oat") ? {
        defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
      } : {}),
    });

    log(`calling ${model}...`);

    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system: INTERACTION_SYSTEM,
      messages,
    });

    const textBlock = response.content.find((b) => b.type === "text");
    reply = textBlock?.type === "text" ? textBlock.text.trim() : "(no reply)";

    const durationMs = Date.now() - turnStart;
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    log(`done in ${durationMs}ms — ${inputTokens}in/${outputTokens}out`);

    // Record usage
    await convex.mutation(api.usageRecords.record, {
      source: "dispatcher",
      conversationId: opts.conversationId,
      turnId,
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0, // haiku is effectively free at personal scale
      durationMs,
    }).catch(() => {}); // non-fatal

  } catch (err) {
    console.error(`[turn ${tag}] API call failed:`, err);
    reply = "Sorry — I hit an error processing that. Try again in a moment.";
  }

  reply = reply || "(no reply)";

  // Store assistant reply
  await convex.mutation(api.messages.send, {
    conversationId: opts.conversationId,
    role: "assistant",
    content: reply,
    turnId,
  });
  broadcast("assistant_message", { conversationId: opts.conversationId, content: reply });

  // Send ack via Telegram if conversationId starts with tg:
  if (opts.conversationId.startsWith("tg:")) {
    const chatId = opts.conversationId.slice(3);
    await sendTelegram(chatId, reply).catch((err) => {
      console.error(`[turn ${tag}] telegram send failed:`, err);
    });
  }

  return reply;
}