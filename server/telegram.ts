// file: server/telegram.ts
// Telegram Bot API bridge — drop-in replacement for sendblue.ts
// Docs: https://core.telegram.org/bots/api

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InboundMessage {
  from: string;       // chat_id as string — this is your "conversation ID"
  text: string;
  messageId: number;
  timestamp: number;
}

// ─── Webhook verification (Telegram uses GET for setup check) ─────────────────

import express from 'express';

export function handleWebhookVerification(
  req: express.Request,
  res: express.Response
) {
  // Telegram doesn't need a verification handshake like Meta does
  // This is just a health check endpoint
  res.json({ status: 'ok', bot: process.env.TELEGRAM_BOT_TOKEN ? 'configured' : 'missing token' });
}

// ─── Parse inbound webhook ────────────────────────────────────────────────────

export function parseInbound(body: any): InboundMessage | null {
  try {
    const message = body?.message;
    if (!message) {
      console.log(`[tg:parse] no message field in body (update_id=${body?.update_id})`);
      return null;
    }

    if (!message.text) {
      console.log(`[tg:parse] non-text message — chat=${message.chat?.id} type=${message.chat?.type}`);
      return null;
    }

    const parsed = {
      from: String(message.chat.id),
      text: message.text,
      messageId: message.message_id,
      timestamp: message.date * 1000,
    };
    console.log(`[tg:parse] ok — chatId=${parsed.from} msgId=${parsed.messageId} text="${parsed.text.slice(0, 60)}"`);
    return parsed;
  } catch (err) {
    console.error('[tg:parse] threw:', err);
    return null;
  }
}

// ─── Send message ─────────────────────────────────────────────────────────────

export async function sendTelegram(to: string, text: string): Promise<void> {
  // Telegram has a 4096 char limit per message
  const MAX_LENGTH = 4000;
  const chunks: string[] = [];

  if (text.length <= MAX_LENGTH) {
    chunks.push(text);
  } else {
    let remaining = text;
    while (remaining.length > 0) {
      let breakAt = MAX_LENGTH;
      if (remaining.length > MAX_LENGTH) {
        const lastNewline = remaining.lastIndexOf('\n', MAX_LENGTH);
        const lastPeriod = remaining.lastIndexOf('. ', MAX_LENGTH);
        const best = Math.max(lastNewline, lastPeriod);
        if (best > MAX_LENGTH * 0.5) breakAt = best;
      }
      chunks.push(remaining.slice(0, breakAt).trim());
      remaining = remaining.slice(breakAt).trim();
    }
  }

  for (const chunk of chunks) {
    await sendSingleMessage(to, chunk);
    if (chunks.length > 1) await sleep(300);
  }
}

async function sendSingleMessage(chatId: string, text: string): Promise<void> {
  console.log(`[tg:send] → chatId=${chatId} len=${text.length}`);
  const t0 = Date.now();

  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    signal: AbortSignal.timeout(15_000),
  });

  console.log(`[tg:send] HTTP ${res.status} in ${Date.now() - t0}ms`);

  if (!res.ok) {
    const err = await res.json().catch(() => res.statusText);
    if ((err as any)?.description?.includes('parse')) {
      console.warn('[tg:send] Markdown parse error, retrying plain text');
      await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(15_000),
      });
      return;
    }
    console.error('[tg:send] failed:', JSON.stringify(err));
    throw new Error(`Telegram send failed: ${res.status}`);
  }

  const data = await res.json() as any;
  console.log(`[tg:send] ok — delivered msgId=${data.result?.message_id} total=${Date.now() - t0}ms`);
}

// ─── Typing indicator — Telegram supports this natively ──────────────────────

export async function sendTypingIndicator(chatId: string): Promise<void> {
  console.log(`[tg:typing] → chatId=${chatId}`);
  const t0 = Date.now();
  await fetch(`${TELEGRAM_API}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    signal: AbortSignal.timeout(8_000),
  }).then(r => {
    console.log(`[tg:typing] done ${r.status} in ${Date.now() - t0}ms`);
  }).catch(err => {
    console.warn(`[tg:typing] failed after ${Date.now() - t0}ms:`, err.message);
  });
}

// ─── Register webhook with Telegram ──────────────────────────────────────────
// Call this once on startup to tell Telegram where to send updates

export async function registerWebhook(publicUrl: string): Promise<void> {
  const webhookUrl = `${publicUrl}/telegram/webhook`;

  const res = await fetch(`${TELEGRAM_API}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl }),
  });

  const data = await res.json() as any;
  if (data.ok) {
    console.log(`[telegram] webhook registered: ${webhookUrl}`);
  } else {
    console.error('[telegram] webhook registration failed:', data);
  }
}

// ─── Dedup ────────────────────────────────────────────────────────────────────

const seenMessageIds = new Set<number>();

export function isDuplicate(messageId: number): boolean {
  if (seenMessageIds.has(messageId)) {
    console.log(`[tg:dedup] DUPLICATE dropped — msgId=${messageId} (seen ${seenMessageIds.size} ids in memory)`);
    return true;
  }
  seenMessageIds.add(messageId);
  console.log(`[tg:dedup] new — msgId=${messageId} (now tracking ${seenMessageIds.size} ids)`);
  if (seenMessageIds.size > 1000) {
    const first = seenMessageIds.values().next().value;
    if (first !== undefined) seenMessageIds.delete(first);
  }
  return false;
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
