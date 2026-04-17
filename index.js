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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-KEY");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (path === "/api/health") {
    return res.status(200).json({ status: "ok", service: "agent-memory-api" });
  }

  // 認証
  const key = req.headers["x-api-key"];
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const body = req.method !== "GET" ? req.body : {};
  const agentId = (body && body.agent_id) || url.searchParams.get("agent_id") || "rimuru";
  const hashKey = `agent:${agentId}`;

  try {
    // スナップショット取得（state + 直近ログを1回で）
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
      return res.status(200).json({
        ok: true,
        agent_id: agentId,
        state: data,
        logs: (logs || []).map(l => JSON.parse(l)),
      });
    }

    // 差分保存（変わった部分だけ更新）
    if (path === "/api/save" && req.method === "POST") {
      const { data } = body;
      if (!data) return res.status(400).json({ error: "data is required" });
      const args = ["HSET", hashKey];
      for (const [k, v] of Object.entries(data)) {
        args.push(k, JSON.stringify(v));
      }
      await redis(args);
      return res.status(200).json({ ok: true, agent_id: agentId });
    }

    // ログ追記
    if (path === "/api/append" && req.method === "POST") {
      const { entry } = body;
      if (!entry) return res.status(400).json({ error: "entry is required" });
      const logKey = `${hashKey}:log`;
      await redis(["LPUSH", logKey, JSON.stringify({ ts: new Date().toISOString(), entry })]);
      await redis(["LTRIM", logKey, 0, 49]);
      return res.status(200).json({ ok: true, agent_id: agentId });
    }

    // リセット
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
