#!/usr/bin/env node
// Restaurant agent: ALL the business logic for the mamak ordering flow lives
// here, behind a webhook — the mcp-core router knows nothing about menus,
// prices, or screens. Swap this service out and the same core drives a
// completely different product.
//
// Webhook contract (POST /agent):
//   in:  { "session_id": "box1", "text": "one roti canai please" }
//   out: { "reply": "...", "display": [{ "path": "/order", "body": "TITLE|..." }],
//          "end_session": false }
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.AGENT_PORT || 4000;
// The agent picks its own LLM — this is deliberately NOT in the core's config.
const LLM_URL = process.env.AGENT_LLM_URL || "http://localhost:11434/v1/chat/completions";
const LLM_MODEL = process.env.AGENT_LLM_MODEL || "llama3.2:3b";
const LLM_TOKEN = process.env.AGENT_LLM_TOKEN || "";

// menu.json is the single source of truth for items and prices. The LLM only
// decides WHAT was ordered; prices and totals are computed here from the menu
// (a 3B model cannot be trusted with arithmetic).
const MENU = JSON.parse(readFileSync(path.join(HERE, "menu.json"), "utf8"));

const menuLines = MENU.items.map((i) => `- ${i.name} (${MENU.currency}${i.price.toFixed(2)})`).join("\n");
const SYSTEM_PROMPT =
  `You are the voice order-taker at ${MENU.restaurant}, a Malaysian mamak stall. MENU:\n${menuLines}\n\n` +
  "Rules:\n" +
  "- Speak like a friendly mamak worker: short natural spoken replies, 1-2 sentences, no lists.\n" +
  "- Reply in English with light Manglish flavor (lah, boss). Do not reply in Malay — the voice output is English-only.\n" +
  "- Only take orders for menu items. If asked for something not on the menu, say so and suggest something similar from the menu.\n" +
  "- If the customer asks a general question, answer briefly and steer back to the order.\n" +
  "- Track the customer's FULL order across the whole conversation.\n" +
  "- NEVER state prices or totals yourself — you are bad at arithmetic. Where you want to " +
  "say the total, write exactly {TOTAL} and the till will fill in the correct amount.\n" +
  "- When the customer says they are done ordering, read the order back with {TOTAL} and ask them to confirm.\n" +
  "- Set status to \"confirmed\" ONLY when the customer explicitly says yes/confirm/correct " +
  "AFTER hearing the order read back — never on the same turn they finish ordering.\n\n" +
  "Respond ONLY with JSON, exactly this shape:\n" +
  '{"reply": "<what you say out loud>", "order": {"status": "none|open|confirmed", "items": [{"qty": <number>, "name": "<menu item name>"}]}}\n' +
  'The items array is the complete order so far (not just new items). Use status "none" when nothing has been ordered yet.';

// Per-session state (one session per box). History is capped so a long chat
// can't grow the prompt without bound.
const HISTORY_MAX = 12;
const sessions = new Map(); // session_id -> { history: [], lastOrder: null }

function getSession(id) {
  if (!sessions.has(id)) sessions.set(id, { history: [], lastOrder: null });
  return sessions.get(id);
}

function resetSession(id, reason) {
  sessions.delete(id);
  console.log(`Session ${id} reset (${reason})`);
}

// Map an LLM item name onto the menu (exact, alias, or substring match).
function resolveMenuItem(name) {
  const n = (name || "").toLowerCase().trim();
  if (!n) return null;
  for (const item of MENU.items) {
    if (item.name === n || item.aliases.includes(n)) return item;
  }
  for (const item of MENU.items) {
    if (n.includes(item.name) || item.name.includes(n) ||
        item.aliases.some((a) => n.includes(a) || a.includes(n))) return item;
  }
  return null;
}

// Turn the LLM's claimed order into a priced one using menu truth. Items that
// don't match the menu are dropped (the spoken reply still addresses them).
function priceOrder(order) {
  if (!order || !Array.isArray(order.items)) return null;
  const items = [];
  let total = 0;
  for (const it of order.items) {
    const menuItem = resolveMenuItem(it.name);
    const qty = Math.max(1, Math.min(20, parseInt(it.qty, 10) || 1));
    if (!menuItem) continue;
    const line = { qty, name: menuItem.name, unit_price: menuItem.price, line_total: qty * menuItem.price };
    total += line.line_total;
    items.push(line);
  }
  if (items.length === 0) return null;
  return { status: order.status === "confirmed" ? "confirmed" : "open",
           currency: MENU.currency, items, total: Math.round(total * 100) / 100 };
}

// The order screen is the agent's responsibility now: it emits the firmware's
// dead-simple line protocol and the core relays it untouched.
//     TITLE|YOUR ORDER
//     ITEM|2X NASI LEMAK|RM11.00
//     TOTAL|RM15.50
// The box font is uppercase ASCII-only; names are truncated so name+price fit
// the 320px screen at scale 2.
function orderDisplay(order) {
  const cur = order.currency || "RM";
  const title = order.status === "confirmed" ? "ORDER CONFIRMED" : "YOUR ORDER";
  const lines = [`TITLE|${title}`];
  for (const it of order.items.slice(0, 5)) {
    const name = `${it.qty}X ${it.name}`.toUpperCase().replace(/[^\x20-\x7E]/g, "").slice(0, 15);
    lines.push(`ITEM|${name}|${cur}${it.line_total.toFixed(2)}`);
  }
  lines.push(`TOTAL|${cur}${order.total.toFixed(2)}`);
  return { path: "/order", body: lines.join("\n") };
}

// One call returns both the spoken reply and the structured order. JSON output
// is FORCED via response_format (supported by Ollama's OpenAI-compat endpoint),
// so parsing can't fail on chatty non-JSON preambles.
async function askLlm(session, text) {
  session.history.push({ role: "user", content: text });
  if (session.history.length > HISTORY_MAX) session.history = session.history.slice(-HISTORY_MAX);

  const response = await fetch(LLM_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + LLM_TOKEN
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...session.history]
    })
  });
  if (!response.ok) {
    throw new Error("LLM returned status " + response.status + ": " + (await response.text()).slice(0, 300));
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content || "";
  session.history.push({ role: "assistant", content: raw });

  let reply = raw, order = null;
  try {
    const parsed = JSON.parse(raw);
    // Never fall back to the raw JSON once parsing succeeded — an empty
    // reply field would otherwise be SPOKEN as literal JSON on the box.
    reply = parsed.reply || "Sorry boss, say again?";
    order = priceOrder(parsed.order);
  } catch {
    // Shouldn't happen with response_format, but degrade to plain chat if so.
  }
  if (order) session.lastOrder = order;
  const effective = order || session.lastOrder;
  // The LLM is told to write {TOTAL} instead of doing arithmetic (it once
  // spoke "RM17.00" for a RM13.50 order). Substitute the real computed total.
  const totalStr = effective ? MENU.currency + effective.total.toFixed(2) : "";
  reply = reply.split("{TOTAL}").join(totalStr).replace(/\s{2,}/g, " ").trim();
  return { reply, order: effective };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const server = http.createServer(async (req, res) => {
  const json = (status, obj) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  try {
    if (req.method === "GET" && req.url === "/health") {
      return json(200, { status: "ok", restaurant: MENU.restaurant, sessions: sessions.size });
    }

    if (req.method === "POST" && req.url === "/agent") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const sessionId = body.session_id || "default";
      const text = (body.text || "").trim();
      if (!text) return json(400, { error: "No text" });

      const session = getSession(sessionId);
      const t0 = Date.now();
      const { reply, order } = await askLlm(session, text);
      console.log(`[${sessionId}] "${text}" -> "${reply}" [${Date.now() - t0}ms]`);
      if (order) console.log(`[${sessionId}] order:`, JSON.stringify(order));

      const confirmed = !!order && order.status === "confirmed";
      const display = order && order.items.length ? [orderDisplay(order)] : null;
      // A confirmed order ends the session: the next customer starts fresh.
      if (confirmed) resetSession(sessionId, "order confirmed");
      return json(200, { reply, display, end_session: confirmed });
    }

    if (req.method === "POST" && req.url === "/reset") {
      sessions.clear();
      console.log("All sessions reset (manual /reset)");
      return json(200, { ok: true });
    }

    json(404, { error: "Not found" });
  } catch (err) {
    console.error("Error:", err.message);
    if (!res.headersSent) json(500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`restaurant agent for "${MENU.restaurant}" listening on port ${PORT}`);
  console.log(`LLM: ${LLM_MODEL} @ ${LLM_URL}`);
});
