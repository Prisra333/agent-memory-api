const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const WALLET = process.env.WALLET_ADDRESS;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-PAYMENT, X-PAYMENT-RESPONSE");
  res.setHeader("Content-Type", "application/json");
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (path === "/api/health") {
    return res.status(200).json({ status: "ok", service: "agent-memory-api" });
  }

  const payment = req.headers["x-payment"];
  if (!payment) {
    return res.status(402).json({
      error: "Payment required",
      price: "0.001 USDC",
      accepts: [{
        scheme: "exact",
        network: "base",
        maxAmountRequired: "1000000000000000",
        resource: req.url,
        description: "Agent Memory API - 1 operation",
        mimeType: "application/json",
        payTo: WALLET,
        maxTimeoutSeconds: 300,
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      }],
    });
  }

  const body = req.method !== "GET" ? req.body : {};
  const agentId = (body && body.agent_id) || url.searchParams.get("agent_id") || "default";

  try {
    if (path === "/api/save" && req.method === "POST") {
      const { data, ttl } = body;
      if (!data) return res.status(400).json({ error: "data is required" });
      const key = `agent:${agentId}:state`;
      ttl ? await redis.setex(key, ttl, JSON.stringify(data)) : await redis.set(key, JSON.stringify(data));
      return res.status(200).json({ ok: true, agent_id: agentId, key });
    }

    if (path === "/api/load" && req.method === "GET") {
      const key = `agent:${agentId}:state`;
      const raw = await redis.get(key);
      if (!raw) return res.status(404).json({ error: "No state found" });
      return res.status(200).json({ ok: true, agent_id: agentId, data: typeof raw === "string" ? JSON.parse(raw) : raw });
    }

    if (path === "/api/append" && req.method === "POST") {
      const { entry } = body;
      if (!entry) return res.status(400).json({ error: "entry is required" });
      const key = `agent:${agentId}:log`;
      await redis.lpush(key, JSON.stringify({ ts: new Date().toISOString(), entry }));
      await redis.ltrim(key, 0, 99);
      return res.status(200).json({ ok: true, agent_id: agentId });
    }

    if (path === "/api/logs" && req.method === "GET") {
      const key = `agent:${agentId}:log`;
      const raw = await redis.lrange(key, 0, 19);
      return res.status(200).json({ ok: true, agent_id: agentId, logs: raw.map(r => JSON.parse(r)) });
    }

    if (path === "/api/flush" && req.method === "POST") {
      await redis.del(`agent:${agentId}:state`);
      await redis.del(`agent:${agentId}:log`);
      return res.status(200).json({ ok: true, agent_id: agentId, message: "Flushed" });
    }

    return res.status(404).json({ error: "Not found" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
