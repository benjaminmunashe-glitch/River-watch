// River Watch: Cloudflare Worker that keeps the AI keys server-side.
// No key is in this file. Keys live in Cloudflare as encrypted secrets
// (Worker > Settings > Variables and Secrets > Add > Type: Secret):
//   GEMINI_API_KEY  (required)  Google Gemini key
//   GROQ_API_KEY    (optional)  Groq key, used only if every Gemini model fails
// It also relays the river forecast (GET /flood) so a rate-limited connection can still read it.
// The page sends the messages here; this Worker adds the key and forwards them.
// Gemini's free tier allows about 20 requests per day PER MODEL, so if a model is busy (503),
// out of quota (429), retired (404) or too slow, the Worker moves on to the next model.

const ALLOWED_ORIGINS = ["https://benjaminmunashe-glitch.github.io"]; // only River Watch's page may use it
const DEFAULT_MODEL = "gemini-3.5-flash";
// Tried in this order after the requested model (only those this key can use).
const PREFERRED = ["gemini-3.5-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite",
  "gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.5-flash-lite", "gemini-3.7-flash", "gemini-3.8-flash"];
const GROQ_MODEL = "llama-3.3-70b-versatile";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_CHAT = GEMINI_BASE + "/openai/chat/completions";
const GROQ_CHAT = "https://api.groq.com/openai/v1/chat/completions";
const MAX_BODY_CHARS = 60000;   // stops very large (costly) requests
const MAX_MODELS = 8;           // most Gemini models tried per question
const CALL_TIMEOUT_MS = 25000;  // give up on a stuck model
const DEADLINE_MS = 75000;      // stop trying new models after this (Cloudflare cuts off at ~100 s)

const FLOOD_API = "https://flood-api.open-meteo.com/v1/flood";
const FLOOD_CACHE_MS = 30 * 60 * 1000;  // river forecasts update about daily; 30 min keeps calls to Open-Meteo low
const floodCache = new Map();           // upstream URL -> { t, body }

let cachedModels = null;          // models this key can use (cached per Worker instance)
const exhausted = new Map();      // model -> time until which it is skipped (out of daily quota)

async function listModels(key) {
  if (cachedModels) return cachedModels;
  const r = await fetch(GEMINI_BASE + "/models?pageSize=200", { headers: { "x-goog-api-key": key } });
  if (!r.ok) return [];
  const j = await r.json();
  cachedModels = (j.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map(m => m.name.replace(/^models\//, ""))
    .filter(n => /^gemini-/.test(n) && /flash/.test(n) && !/(tts|image|embedding|live|audio|vision|transcribe|preview-native)/.test(n));
  return cachedModels;
}

function modelOrder(requested, available) {
  const ver = n => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]);
  const others = [...available].sort((a, b) => ver(b) - ver(a));
  const list = [requested, ...PREFERRED.filter(m => available.includes(m)), ...others];
  const now = Date.now();
  return [...new Set(list)].filter(m => !(exhausted.get(m) > now));
}

async function callModel(url, key, model, messages, timeoutMs) {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
      body: JSON.stringify({ model, messages, temperature: 0.1, max_tokens: 4000 })
    });
    return { status: r.status, ok: r.ok, text: await r.text() };
  } catch (e) {
    return { status: 504, ok: false, text: JSON.stringify({ error: { message: `${model} did not answer within ${Math.round(timeoutMs / 1000)} s` } }) };
  }
}

const errMsg = text => {
  try { const j = JSON.parse(text); return ((Array.isArray(j) ? j[0] : j).error?.message || "").slice(0, 300); }
  catch { return String(text).slice(0, 300); }
};

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
    // River forecast relay: lets the page read Open-Meteo from Cloudflare's address if its own is rate-limited.
    if (request.method === "GET" && url.pathname.endsWith("/flood")) {
      if (!allowed) return json({ error: { message: "This service only answers the River Watch page." } }, 403);
      const p = url.searchParams, coords = /^-?\d{1,3}(\.\d+)?(,-?\d{1,3}(\.\d+)?){0,19}$/;
      if (!coords.test(p.get("latitude") || "") || !coords.test(p.get("longitude") || "") || p.get("daily") !== "river_discharge"
          || !/^\d{1,2}$/.test(p.get("forecast_days") || "")) return json({ error: { message: "Bad forecast request." } }, 400);
      const up = new URL(FLOOD_API);
      for (const k of ["latitude", "longitude", "daily", "forecast_days", "timezone"]) if (p.get(k)) up.searchParams.set(k, p.get(k));
      const key = up.toString(), hit = floodCache.get(key);
      const send = (body, status, cache) => new Response(body, { status, headers: { ...cors, "Content-Type": "application/json", "X-Cache": cache } });
      if (hit && Date.now() - hit.t < FLOOD_CACHE_MS) return send(hit.body, 200, "HIT");
      try {
        const r = await fetch(key, { signal: AbortSignal.timeout(15000) });
        const body = await r.text();
        if (r.ok) { floodCache.set(key, { t: Date.now(), body }); return send(body, 200, "MISS"); }
        if (hit) return send(hit.body, 200, "STALE");
        return send(body, r.status, "ERROR");
      } catch (e) {
        if (hit) return send(hit.body, 200, "STALE");
        return json({ error: { message: "Forecast service did not answer." } }, 504);
      }
    }
    if (request.method === "GET" && url.pathname.endsWith("/models")) {
      if (!env.GEMINI_API_KEY) return json({ error: { message: "Server key not configured." } }, 500);
      return json({ models: await listModels(env.GEMINI_API_KEY), skippedForQuota: [...exhausted.keys()] });
    }
    if (request.method === "GET") return json({ ok: true, service: "River Watch AI proxy", keyConfigured: !!env.GEMINI_API_KEY,
      groqBackup: !!env.GROQ_API_KEY, defaultModel: DEFAULT_MODEL });
    if (request.method !== "POST") return json({ error: { message: "Method not allowed" } }, 405);
    if (!allowed) return json({ error: { message: "This service only answers the River Watch page." } }, 403);
    if (!env.GEMINI_API_KEY && !env.GROQ_API_KEY) return json({ error: { message: "Server key not configured." } }, 500);

    const raw = await request.text();
    if (raw.length > MAX_BODY_CHARS) return json({ error: { message: "Request too large." } }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return json({ error: { message: "Invalid JSON." } }, 400); }
    const messages = Array.isArray(body.messages) ? body.messages.slice(-8) : [];
    if (!messages.length) return json({ error: { message: "No messages." } }, 400);
    const requested = /^gemini-[\w.-]+$/.test(body.model || "") ? body.model : DEFAULT_MODEL;

    const start = Date.now();
    const tried = [];
    let lastErr = "";
    let lastStatus = 502;

    if (env.GEMINI_API_KEY) {
      const order = modelOrder(requested, await listModels(env.GEMINI_API_KEY)).slice(0, MAX_MODELS);
      for (const model of order) {
        const left = DEADLINE_MS - (Date.now() - start);
        if (left < 5000) break;
        const r = await callModel(GEMINI_CHAT, env.GEMINI_API_KEY, model, messages, Math.min(CALL_TIMEOUT_MS, left));
        tried.push(model);
        if (r.ok) {
          try { const j = JSON.parse(r.text); const o = Array.isArray(j) ? j[0] : j; o.model_used = model; o.models_tried = tried; return json(o); }
          catch { return new Response(r.text, { status: 200, headers: { ...cors, "Content-Type": "application/json" } }); }
        }
        lastErr = errMsg(r.text); lastStatus = r.status;
        if (r.status === 429 && /per ?day|daily|PerDay/i.test(lastErr)) exhausted.set(model, Date.now() + 3 * 3600 * 1000);
        if (![404, 429, 500, 503, 504].includes(r.status)) break; // e.g. bad key: no point trying other models
      }
    }

    // Last resort: Groq, if a GROQ_API_KEY secret has been added.
    if (env.GROQ_API_KEY) {
      const left = DEADLINE_MS + 15000 - (Date.now() - start);
      const r = await callModel(GROQ_CHAT, env.GROQ_API_KEY, GROQ_MODEL, messages, Math.max(5000, Math.min(CALL_TIMEOUT_MS, left)));
      tried.push("groq/" + GROQ_MODEL);
      if (r.ok) {
        try { const o = JSON.parse(r.text); o.model_used = "groq/" + GROQ_MODEL; o.models_tried = tried; return json(o); }
        catch { return new Response(r.text, { status: 200, headers: { ...cors, "Content-Type": "application/json" } }); }
      }
      lastErr = errMsg(r.text); lastStatus = r.status;
    }

    return json({ error: { message: `AI unavailable after trying ${tried.join(", ")}: ${lastErr}` } }, lastStatus || 502);
  }
};
