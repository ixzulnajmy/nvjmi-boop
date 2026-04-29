import "./env-setup.js";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { addClient } from "./broadcast.js";
import { parseInbound, sendTypingIndicator, verifyAndRegisterWebhook, isDuplicate } from "./telegram.js";
import { handleUserMessage } from "./interaction-agent.js";
import { loadIntegrations } from "./integrations/registry.js";
import { startCleanupLoop } from "./memory/clean.js";
import { startAutomationLoop } from "./automations.js";
import { startHeartbeatLoop } from "./heartbeat.js";
import { startConsolidationLoop } from "./consolidation.js";
import { cancelAgent, retryAgent } from "./execution-agent.js";
import { createComposioRouter } from "./composio-routes.js";

async function main() {
  await loadIntegrations();
  startCleanupLoop();
  startAutomationLoop();
  startHeartbeatLoop();
  startConsolidationLoop();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "boop-agent" });
  });

  app.get("/telegram/webhook", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.post("/telegram/webhook", async (req, res) => {
    const wt0 = Date.now();
    const wms = () => `+${Date.now() - wt0}ms`;
    console.log(`[tg:webhook] POST received — body keys: ${Object.keys(req.body ?? {}).join(", ")}`);
    res.sendStatus(200);
    try {
      const msg = parseInbound(req.body);
      if (!msg) { console.log(`[tg:webhook] ${wms()} parseInbound → null, dropping`); return; }

      console.log(`[tg:webhook] ${wms()} parsed msgId=${msg.messageId} chatId=${msg.from}`);

      if (isDuplicate(msg.messageId)) { console.log(`[tg:webhook] ${wms()} duplicate, dropping`); return; }

      console.log(`[tg:webhook] ${wms()} sendTypingIndicator → START`);
      await sendTypingIndicator(msg.from);
      console.log(`[tg:webhook] ${wms()} sendTypingIndicator done`);

      console.log(`[tg:webhook] ${wms()} handleUserMessage → START`);
      const reply = await handleUserMessage({
        conversationId: `tg:${msg.from}`,
        content: msg.text,
      });
      console.log(`[tg:webhook] ${wms()} handleUserMessage done — reply="${reply.slice(0, 80)}"`);
    } catch (err) {
      console.error(`[tg:webhook] ${wms()} UNCAUGHT ERROR:`, err);
    }
  });
  app.use("/composio", createComposioRouter());

  app.post("/agents/:id/cancel", (req, res) => {
    const ok = cancelAgent(req.params.id);
    res.json({ ok });
  });

  app.post("/consolidate", async (_req, res) => {
    try {
      const { runConsolidation } = await import("./consolidation.js");
      // Fire-and-forget so the HTTP request returns immediately.
      runConsolidation("manual").catch((err) =>
        console.error("[consolidation] manual run failed", err),
      );
      res.json({ ok: true, triggered: "manual" });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/agents/:id/retry", async (req, res) => {
    const result = await retryAgent(req.params.id);
    if (!result) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    res.json(result);
  });

  // Chat endpoint for local testing and the debug dashboard
  app.post("/chat", async (req, res) => {
    const { conversationId, content } = req.body ?? {};
    if (!conversationId || !content) {
      res.status(400).json({ error: "conversationId and content required" });
      return;
    }
    try {
      const reply = await handleUserMessage({ conversationId, content });
      res.json({ reply });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: String(err) });
    }
  });

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    addClient(ws);
    ws.send(JSON.stringify({ event: "hello", data: { ok: true }, at: Date.now() }));
  });

  const port = Number(process.env.PORT ?? 3456);
  server.listen(port, () => {
    console.log(`boop-agent server listening on :${port}`);
    console.log(`  health      GET  http://localhost:${port}/health`);
    console.log(`  chat        POST http://localhost:${port}/chat`);
    console.log(`  sendblue    POST http://localhost:${port}/sendblue/webhook`);
    console.log(`  websocket   WS   ws://localhost:${port}/ws`);
    // ADD after the last console.log inside server.listen:
    const publicUrl = process.env.PUBLIC_URL;
    if (publicUrl) verifyAndRegisterWebhook(publicUrl);
  });
}

main().catch((err) => {
  console.error("fatal", err);
  process.exit(1);
});
