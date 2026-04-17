import { createClient } from "@upstash/redis";

const redis = createClient({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const PRICE = BigInt("1000000000000000"); // $0.001 in wei相当

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-PAYMENT, X-PAYMENT-RESPONSE",
    "Content-Type": "application/json",
  };
}

export default async function handler(req, res) {
  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") return res.status(200).end();

  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // ヘルスチェック（無料）
  if (path === "/api/health") {
    return res.status(200).json({ status: "ok", service: "agent-memory-api" });
  }

  // x402 支払いチェック
  const payment = req.headers["x-payment"];
  if (!payment) {
    return res.status(402).json({
      error: "Payment required",
      price: "0.001 USDC",
      accepts: [{
        scheme: "exact",
        network: "base",
        maxAmountRequired: PRICE.toString(),
        resource: req.url,
        description: "Agent Memory API - 1 operation",
        mimeType: "application/json",
        payTo: process.env.WALLET_ADDRESS,
        maxTimeoutSeconds: 300,
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      }],
    });
  }

  const body = req.method !== "GET" ? req.body : {};
  const agentId = body.agent_id || url.searchParams.get("agent_id") || "default";

  try {
    // POST /api/save
    if (path === "/api/save" && req.method === "POST") {
      const { data, ttl } = body;
      if (!data) return res.status(400).json({ error: "data is required" });
      const key = `agent:${agentId}:state`;
      if (ttl) {
        await redis.setex(key, ttl, JSON.stringify(data));
      } else {
        await redis.set(key, JSON.stringify(data));
      }
      return res.status(200).json({ ok: true, agent_id: agentId, key });
    }

    // GET /api/load
    if (path === "/api/load" && req.method === "GET") {
      const key = `agent:${agentId}:state`;
      const raw = await redis.get(key);
      if (!raw) return res.status(404).json({ error: "No state found", agent_id: agentId });
      return res.status(200).json({ ok: true, agent_id: agentId, data: JSON.parse(raw) });
    }

    // POST /api/append
    if (path === "/api/append" && req.method === "POST") {
      const { entry } = body;
      if (!entry) return res.status(400).json({ error: "entry is required" });
      const key = `agent:${agentId}:log`;
      const log = { ts: new Date().toISOString(), entry };
      await redis.lpush(key, JSON.stringify(log));
      await redis.ltrim(key, 0, 99); // 最新100件保持
      return res.status(200).json({ ok: true, agent_id: agentId });
    }

    // GET /api/logs
    if (path === "/api/logs" && req.method === "GET") {
      const key = `agent:${agentId}:log`;
      const raw = await redis.lrange(key, 0, 19);
      const logs = raw.map(r => JSON.parse(r));
      return res.status(200).json({ ok: true, agent_id: agentId, logs });
    }

    // POST /api/flush
    if (path === "/api/flush" && req.method === "POST") {
      await redis.del(`agent:${agentId}:state`);
      await redis.del(`agent:${agentId}:log`);
      return res.status(200).json({ ok: true, agent_id: agentId, message: "Flushed" });
    }

    return res.status(404).json({ error: "Not found" });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
