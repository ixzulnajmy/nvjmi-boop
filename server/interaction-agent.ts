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

const CREDS_PATH = `${os.homedir()}/.claude/.credentials.json`;
const OAUTH_TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID = "https://claude.ai/oauth/claude-code-client-metadata";
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh when within 5 min of expiry

function readCredentials(): any {
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf-8"));
}

async function refreshAccessToken(refreshToken: string): Promise<string> {
  console.log("[auth] refreshing OAuth access token via platform.claude.com");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
  });
  const res = await fetch(OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`OAuth refresh failed ${res.status}: ${err}`);
  }
  const data = await res.json() as any;
  const newAccessToken: string = data.access_token;
  const expiresIn: number = data.expires_in ?? 3600;
  if (!newAccessToken) throw new Error("OAuth refresh returned no access_token");

  // Write updated token back to credentials file
  const creds = readCredentials();
  creds.claudeAiOauth.accessToken = newAccessToken;
  creds.claudeAiOauth.expiresAt = Date.now() + expiresIn * 1000;
  if (data.refresh_token) creds.claudeAiOauth.refreshToken = data.refresh_token;
  fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2));
  console.log(`[auth] token refreshed — new expiry in ${Math.round(expiresIn / 60)}min`);
  return newAccessToken;
}

// Returns a valid OAuth access token, proactively refreshing before expiry.
// Always reads from disk so Claude CLI refreshes are immediately visible.
async function getAuthToken(): Promise<string> {
  if (process.env.ANTHROPIC_API_KEY) {
    return process.env.ANTHROPIC_API_KEY;
  }
  try {
    const creds = readCredentials();
    const oauth = creds?.claudeAiOauth;
    if (!oauth?.accessToken) throw new Error("no accessToken");

    const expiresAt: number = oauth.expiresAt ?? 0;
    const needsRefresh = expiresAt - Date.now() < REFRESH_BUFFER_MS;

    if (needsRefresh && oauth.refreshToken) {
      return await refreshAccessToken(oauth.refreshToken);
    }
    return oauth.accessToken;
  } catch (err) {
    throw new Error(`No auth token found: ${err}. Set ANTHROPIC_API_KEY or run \`claude\` to login.`);
  }
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
    let token = await getAuthToken();
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
      // 401 safety net: force-refresh (bypasses the 5-min buffer) and retry once.
      if (err?.status === 401) {
        log(`401 on first attempt — force-refreshing token`);
        const creds = readCredentials();
        const rt = creds?.claudeAiOauth?.refreshToken;
        if (!rt) throw err;
        token = await refreshAccessToken(rt);
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