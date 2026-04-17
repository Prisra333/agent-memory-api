const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const API_KEY = process.env.MEMORY_API_KEY;

async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cmd),
  });
  return (await r.json()).result;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (path === "/api/health") {
    return res.status(200).json({ status: "ok", key_loaded: !!API_KEY });
  }

  // ヘッダーをデバッグ
  if (path === "/api/debug") {
    return res.status(200).json({ headers: req.headers });
  }

  const incoming = req.headers["x-api-key"];
  if (!incoming || incoming !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized", incoming, expected_length: API_KEY ? API_KEY.length : 0 });
  }

  const body = req.method !== "GET" ? req.body : {};
  const agentId = (body && body.agent_id) || url.searchParams.get("agent_id") || "rimuru";
  const hashKey = `agent:${agentId}`;

  try {
    if (path === "/api/snapshot" && req.method === "GET") {
      const [state, logs] = await Promise.all([
        redis(["HGETALL", hashKey]),
        redis(["LRANGE", `${hashKey}:log`, 0, 9]),
      ]);
      const data = {};
      if (state) {
        for (let i = 0; i < state.length; i += 2) {
          try { data[state[i]] = JSON.parse(state[i + 1]); }
          catch { data[state[i]] = state[i + 1]; }
        }
      }
      return res.status(200).json({ ok: true, agent_id: agentId, state: data, logs: (logs || []).map(l => JSON.parse(l)) });
    }

    if (path === "/api/save" && req.method === "POST") {
      const { data } = body;
      if (!data) return res.status(400).json({ error: "data is required" });
      const args = ["HSET", hashKey];
      for (const [k, v] of Object.entries(data)) args.push(k, JSON.stringify(v));
      await redis(args);
      return res.status(200).json({ ok: true, agent_id: agentId });
    }

    if (path === "/api/append" && req.method === "POST") {
      const { entry } = body;
      if (!entry) return res.status(400).json({ error: "entry is required" });
      const logKey = `${hashKey}:log`;
      await redis(["LPUSH", logKey, JSON.stringify({ ts: new Date().toISOString(), entry })]);
      await redis(["LTRIM", logKey, 0, 49]);
      return res.status(200).json({ ok: true, agent_id: agentId });
    }

    if (path === "/api/flush" && req.method === "POST") {
      await redis(["DEL", hashKey]);
      await redis(["DEL", `${hashKey}:log`]);
      return res.status(200).json({ ok: true, agent_id: agentId, message: "Flushed" });
    }

    return res.status(404).json({ error: "Not found" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
