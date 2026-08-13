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

// Does the customer's own words name any menu item? Used to reject phantom
// orders: a 3B model will happily "extract" an order from "yes confirm" on a
// fresh session (observed: invented 1 nasi lemak + 1 roti canai). No menu word
// in the text AND no order yet => there is no order, whatever the LLM claims.
function textMentionsMenu(text) {
  const t = (text || "").toLowerCase();
  for (const item of MENU.items) {
    if (t.includes(item.name)) return true;
    for (const a of item.aliases) if (t.includes(a)) return true;
  }
  return false;
}

// Is this an explicit "finalize my order" — a pure yes/confirm with no new
// items? Confirmation is decided HERE in code, not by the LLM's status field:
// the model confirmed prematurely on "that's all" and reset the order mid-
// conversation. "done"/"that's all" is deliberately NOT confirmation — it
// should trigger a read-back, and the customer's following yes finalizes.
//
// The word list is deliberately wide, and specifically Malaysian. It used to be
// yes/yeah/yep/correct/betul/sure/proceed/checkout only, which matched NOTHING
// a real customer said: across 103 logged turns the confirm branch never fired
// once, so no order ever reached "confirmed" and the receipt screen never
// rendered. "ok" / "ok lah" is how people actually agree here. The
// !textMentionsMenu() guard is what keeps a wide list safe — "ok, one more teh
// tarik" names an item, so it stays an ordering turn, not a confirmation.
function isConfirmation(text) {
  const t = (text || "").toLowerCase();
  const yes = /\b(confirm|confirmed|yes|yeah|yep|yup|ya|correct|betul|sure|ok|okay|okey|oklah|alright|all right|boleh|sudah|proceed|checkout|check out|that'?s all|thats all|settle|bill)\b/.test(t);
  return yes && !textMentionsMenu(text);
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
//     ACTIONS|ADD ORDER|END + PAY
// The box font is uppercase ASCII-only; names are truncated so name+price fit
// the 320px screen at scale 2.
//
// ACTIONS is what makes an order finishable by touch. Finalizing used to depend
// entirely on the customer SAYING a confirmation word, which meant the shortest
// utterance of the whole conversation ("yes") had to survive VAD + Whisper —
// and sub-second clips transcribe as "[BLANK_AUDIO]" most of the time, so the
// order simply never got confirmed. A tap can't be misheard. The voice path
// still works; this is a second, reliable way to the same place.
//
// Buttons only while the order is OPEN: once it's confirmed the core takes the
// screen over with the payment prompt, and offering "END + PAY" on a paid order
// would just re-run a finished flow.
function orderDisplay(order) {
  const cur = order.currency || "RM";
  const title = order.status === "confirmed" ? "ORDER CONFIRMED" : "YOUR ORDER";
  const lines = [`TITLE|${title}`];
  for (const it of order.items.slice(0, 5)) {
    const name = `${it.qty}X ${it.name}`.toUpperCase().replace(/[^\x20-\x7E]/g, "").slice(0, 15);
    lines.push(`ITEM|${name}|${cur}${it.line_total.toFixed(2)}`);
  }
  lines.push(`TOTAL|${cur}${order.total.toFixed(2)}`);
  if (order.status !== "confirmed" && order.items.length) {
    lines.push("ACTIONS|ADD ORDER|END + PAY");
  }
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
      // Low temperature: this is structured order EXTRACTION, not creative
      // writing. At Ollama's default (~0.8) the 3B model dropped an item from
      // "two nasi lemak and one teh tarik" ~1 in 5 times; near-0 makes it
      // extract the same items every time. A little reply variety is a fair
      // trade for not mis-charging customers.
      temperature: 0,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...session.history]
    })
  });
  if (!response.ok) {
    throw new Error("LLM returned status " + response.status + ": " + (await response.text()).slice(0, 300));
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content || "";
  session.history.push({ role: "assistant", content: raw });

  let reply = raw, llmOrder = null;
  try {
    const parsed = JSON.parse(raw);
    // Never fall back to the raw JSON once parsing succeeded — an empty
    // reply field would otherwise be SPOKEN as literal JSON on the box.
    reply = parsed.reply || "Sorry boss, say again?";
    llmOrder = priceOrder(parsed.order);
  } catch {
    // Shouldn't happen with response_format, but degrade to plain chat if so.
  }

  // Order + confirmation state are decided HERE, not trusted from the 3B model
  // (which confirmed too early and invented items — see the helper comments).
  const priorOrder = session.lastOrder;
  const priorHasItems = !!priorOrder && priorOrder.items.length > 0;
  let order, confirmed = false;

  if (isConfirmation(text) && priorHasItems) {
    // Explicit yes on an existing order: finalize the order we ALREADY have.
    // Do not adopt a fresh LLM extraction on a "yes" turn — that's exactly
    // when it corrupted the order.
    order = { ...priorOrder, status: "confirmed" };
    confirmed = true;
  } else {
    // Normal ordering turn. Drop a phantom order: brand-new items built from a
    // message that names nothing on the menu is a hallucination.
    if (llmOrder && !priorHasItems && !textMentionsMenu(text)) llmOrder = null;
    if (llmOrder) {
      llmOrder.status = "open";        // confirmation only happens in the branch above
      session.lastOrder = llmOrder;
      order = llmOrder;
    } else {
      order = priorOrder || null;      // keep showing the existing order, if any
    }
  }

  // The LLM is told to write {TOTAL} instead of doing arithmetic (it once
  // spoke "RM17.00" for a RM13.50 order). Substitute the real computed total.
  const totalStr = order ? MENU.currency + order.total.toFixed(2) : "";
  reply = reply.split("{TOTAL}").join(totalStr).replace(/\s{2,}/g, " ").trim();
  return { reply, order, confirmed };
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

    // Finalize by TOUCH — the customer tapped END + PAY on the box. Reaches the
    // same place a spoken "yes" does, without the STT round trip that made the
    // spoken path unreliable (see isConfirmation). No LLM call: the order is
    // already priced from menu truth, and asking a 3B model to re-derive it on
    // the last step is exactly where it used to invent items.
    //
    // Returns the priced order so the core can put the amount owed on the
    // payment screen. 409 when there's nothing to finalize, so a stray tap on a
    // stale screen can't manufacture an empty confirmed order.
    if (req.method === "POST" && req.url === "/finalize") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const sessionId = body.session_id || "default";
      const prior = getSession(sessionId).lastOrder;
      if (!prior || !prior.items.length) {
        return json(409, { error: "No open order to finalize" });
      }
      const order = { ...prior, status: "confirmed" };
      console.log(`[${sessionId}] finalized by touch:`, JSON.stringify(order));
      resetSession(sessionId, "order finalized at box");
      return json(200, { order, display: orderDisplay(order) });
    }

    if (req.method === "POST" && req.url === "/agent") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const sessionId = body.session_id || "default";
      const text = (body.text || "").trim();
      if (!text) return json(400, { error: "No text" });

      const session = getSession(sessionId);
      const t0 = Date.now();
      const { reply, order, confirmed } = await askLlm(session, text);
      console.log(`[${sessionId}] "${text}" -> "${reply}" [${Date.now() - t0}ms]`);
      if (order) console.log(`[${sessionId}] order:`, JSON.stringify(order));

      const display = order && order.items.length ? [orderDisplay(order)] : null;
      // A confirmed order ends the session: the next customer starts fresh.
      if (confirmed) resetSession(sessionId, "order confirmed");
      return json(200, { reply, display, end_session: !!confirmed });
    }

    // Reset one session, or all of them. mcp-core sends {"session_id": "..."}
    // when a single customer leaves (their box's presence radar saw them go);
    // an empty body still means "wipe everything", so manual `curl -X POST
    // .../reset` keeps working as before.
    if (req.method === "POST" && req.url === "/reset") {
      let sessionId = null;
      try {
        sessionId = JSON.parse((await readBody(req)) || "{}").session_id || null;
      } catch { /* not JSON — treat as a global reset */ }
      if (sessionId) {
        resetSession(sessionId, "customer left");
      } else {
        sessions.clear();
        console.log("All sessions reset (manual /reset)");
      }
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
