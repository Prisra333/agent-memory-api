const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const WALLET = process.env.WALLET_ADDRESS;

async function redis(cmd) {
  const r = await fetch(`${REDIS_URL}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  return j.result;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-PAYMENT, X-PAYMENT-RESPONSE");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (path === "/api/health") {
    return res.status(200).json({ status: "ok", service: "agent-memory-api" });
  }

  if (!req.headers["x-payment"]) {
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
      const val = JSON.stringify(data);
      await redis(ttl ? ["SETEX", key, ttl, val] : ["SET", key, val]);
      return res.status(200).json({ ok: true, agent_id: agentId });
    }

    if (path === "/api/load" && req.method === "GET") {
      const key = `agent:${agentId}:state`;
      const raw = await redis(["GET", key]);
      if (!raw) return res.status(404).json({ error: "No state found" });
      return res.status(200).json({ ok: true, agent_id: agentId, data: JSON.parse(raw) });
    }

    if (path === "/api/append" && req.method === "POST") {
      const { entry } = body;
      if (!entry) return res.status(400).json({ error: "entry is required" });
      const key = `agent:${agentId}:log`;
      await redis(["LPUSH", key, JSON.stringify({ ts: new Date().toISOString(), entry })]);
      await redis(["LTRIM", key, 0, 99]);
      return res.status(200).json({ ok: true, agent_id: agentId });
    }

    if (path === "/api/logs" && req.method === "GET") {
      const key = `agent:${agentId}:log`;
      const raw = await redis(["LRANGE", key, 0, 19]);
      return res.status(200).json({ ok: true, agent_id: agentId, logs: (raw || []).map(r => JSON.parse(r)) });
    }

    if (path === "/api/flush" && req.method === "POST") {
      const aid = (body && body.agent_id) || "default";
      await redis(["DEL", `agent:${aid}:state`]);
      await redis(["DEL", `agent:${aid}:log`]);
      return res.status(200).json({ ok: true, agent_id: aid, message: "Flushed" });
    }

    return res.status(404).json({ error: "Not found" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
