// River Watch: Cloudflare Worker that keeps the Gemini key server-side.
// The key is NOT in this file. It lives in Cloudflare as an encrypted secret named GEMINI_API_KEY
// (Worker > Settings > Variables and Secrets > Add > Type: Secret).
// The page sends the messages here; this Worker adds the key and forwards them to Gemini.
// If Gemini is busy (503/429) or a model is retired (404), it retries and falls back to another Gemini model.

const ALLOWED_ORIGINS = ["https://benjaminmunashe-glitch.github.io"]; // only River Watch's page may use it
const DEFAULT_MODEL = "gemini-3.8-flash";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const CHAT_URL = GEMINI_BASE + "/openai/chat/completions";
const MAX_BODY_CHARS = 60000;   // stops very large (costly) requests
const MAX_ATTEMPTS = 4;         // total model calls per question

let cachedModels = null;        // list of chat models this key can use (cached per Worker instance)

async function listModels(key) {
  if (cachedModels) return cachedModels;
  const r = await fetch(GEMINI_BASE + "/models?pageSize=200", { headers: { "x-goog-api-key": key } });
  if (!r.ok) return [];
  const j = await r.json();
  cachedModels = (j.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map(m => m.name.replace(/^models\//, ""))
    .filter(n => /^gemini-/.test(n) && !/(tts|image|embedding|live|audio|vision|preview-native)/.test(n));
  return cachedModels;
}

// Order: the requested model, then other "flash" models (newest first), then any other Gemini model.
function fallbackOrder(requested, available) {
  const ver = n => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]);
  const byNewest = [...available].sort((a, b) => ver(b) - ver(a));
  const flash = byNewest.filter(n => /flash/.test(n) && !/lite/.test(n));
  const lite = byNewest.filter(n => /flash-lite/.test(n));
  return [...new Set([requested, ...flash, ...lite, ...byNewest])];
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin);
    const cors = {
      "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method === "GET" && url.pathname.endsWith("/models")) {
      if (!env.GEMINI_API_KEY) return json({ error: { message: "Server key not configured." } }, 500);
      return json({ models: await listModels(env.GEMINI_API_KEY) });
    }
    if (request.method === "GET") return json({ ok: true, service: "River Watch AI proxy", keyConfigured: !!env.GEMINI_API_KEY, defaultModel: DEFAULT_MODEL });
    if (request.method !== "POST") return json({ error: { message: "Method not allowed" } }, 405);
    if (!allowed) return json({ error: { message: "This service only answers the River Watch page." } }, 403);
    if (!env.GEMINI_API_KEY) return json({ error: { message: "Server key not configured (GEMINI_API_KEY secret missing)." } }, 500);

    const raw = await request.text();
    if (raw.length > MAX_BODY_CHARS) return json({ error: { message: "Request too large." } }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return json({ error: { message: "Invalid JSON." } }, 400); }
    const messages = Array.isArray(body.messages) ? body.messages.slice(-8) : [];
    if (!messages.length) return json({ error: { message: "No messages." } }, 400);
    const requested = /^gemini-[\w.-]+$/.test(body.model || "") ? body.model : DEFAULT_MODEL;

    let order = [requested];
    const tried = [];
    let last = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt === 1) order = fallbackOrder(requested, await listModels(env.GEMINI_API_KEY));
      // attempt 0: requested; attempt 1: requested again (busy) or next model; later: next models
      const model = attempt === 1 && last && (last.status === 503 || last.status === 429) ? requested
                  : order.find(m => !tried.includes(m)) || requested;
      if (attempt > 0) await new Promise(r => setTimeout(r, 1200));
      const r = await fetch(CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + env.GEMINI_API_KEY },
        body: JSON.stringify({ model, messages, temperature: 0.1, max_tokens: 4000 })
      });
      const text = await r.text();
      if (!tried.includes(model)) tried.push(model);
      if (r.ok) {
        try { const j = JSON.parse(text); j.model_used = model; j.models_tried = tried; return json(j); }
        catch { return new Response(text, { status: 200, headers: { ...cors, "Content-Type": "application/json" } }); }
      }
      last = { status: r.status, text };
      if (![404, 429, 500, 503].includes(r.status)) break; // e.g. bad key: no point retrying
    }
    let err;
    try { const j = JSON.parse(last.text); err = (Array.isArray(j) ? j[0] : j).error?.message; } catch { err = last.text.slice(0, 300); }
    return json({ error: { message: `Gemini unavailable after trying ${tried.join(", ")}: ${err}` } }, last.status || 502);
  }
};
