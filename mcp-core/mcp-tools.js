// The ESP fleet as MCP tools — this is what makes mcp-core "pull and use".
//
// Until this file existed, mcp-core was an MCP *client* only: it consumed
// voice-mcp-server's tools and drove the boxes through private internal code,
// so nothing outside this process could touch a box. Now any MCP client
// (Claude, another agent, a cloud LLM with tool use) can drive the fleet.
//
// Dependencies are injected (boxes, speakToBox) rather than imported from
// server.js — server.js imports this file, so importing back would be circular.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asciiOneline, sendCaption, sendDisplay, sendSessionOverride } from "./boxes.js";
import { wsHas } from "./ws-hub.js";

// MCP clients consume tool failures through the protocol's own error shape, so
// a raw JS throw escaping a handler is something a model can't reason about.
// Every failure returns through here. Matches what voice-mcp-server already
// returns from its catch blocks, so both MCP servers look identical to a client.
const mcpError = (message) => ({
  content: [{ type: "text", text: message }],
  isError: true
});

const mcpJson = (obj) => ({
  content: [{ type: "text", text: JSON.stringify(obj) }],
  structuredContent: obj
});

// box_id is optional in the common single-box case; required once there's a
// fleet. Errors name the valid ids — the message is often all the model sees.
function resolveBox(boxes, boxId) {
  const all = boxes.boxes;
  const ids = all.map((b) => b.id).join(", ") || "(none registered)";
  if (!boxId) {
    if (all.length === 1) return { box: all[0] };
    if (all.length === 0) {
      return { error: "No boxes are registered. A box registers itself when it boots and joins WiFi." };
    }
    return { error: `box_id is required when more than one box is registered. Available: ${ids}` };
  }
  const box = boxes.byId(boxId);
  if (!box) return { error: `Box "${boxId}" not found. Available: ${ids}` };
  return { box };
}

// Real reachability, not a guess. Deliberately not derived from a stored
// "last seen" — an idle-but-healthy box only contacts the server at boot, so a
// timestamp would report it offline and lie.
//
// ANY HTTP response proves the box's server is listening; the status code is
// irrelevant. /caption is POST-only, so a GET draws a method-not-allowed of
// some flavour — 405 from the firmware's esp_http_server, 501 from the Python
// mock box. Allowlisting specific codes false-negatives on anything that
// answers differently (which is exactly what an allowlist of 200/405 did to
// the mock). Only a thrown error — timeout, connection refused, DNS failure —
// means nothing is there.
async function probeOnline(box) {
  // A live reverse channel is stronger evidence than any probe: the box dialled
  // us and the heartbeat says the socket is still answering. It's also the ONLY
  // evidence available for a box on another network, whose LAN ip we cannot
  // reach at all — probing that would report a perfectly healthy box as
  // offline, which is worse than not probing.
  if (wsHas(box.id)) return true;
  try {
    await fetch(`http://${box.ip}/caption`, {
      method: "GET",
      signal: AbortSignal.timeout(2000)
    });
    return true;
  } catch {
    return false;
  }
}

// The firmware's order screen renders through a 5x7 font with no lowercase
// glyphs and no wrapping, and display_order() (unlike display_caption()) does
// not uppercase for you. Names are also truncated so name+price fit 320px at
// scale 2. This is wire-format adaptation, not business logic: the caller
// supplies the items and the total, mcp-core just encodes them.
const orderField = (s, limit = 15) => asciiOneline(String(s ?? ""), limit).toUpperCase();

export function createMcpServer({ boxes, speakToBox }) {
  const server = new McpServer({ name: "mcp-core", version: "1.0.0" });

  // ---- esp_list_boxes ------------------------------------------------------
  server.registerTool(
    "esp_list_boxes",
    {
      title: "List ESP Boxes",
      description:
        "Lists every ESP32-S3-BOX voice device registered with this server, whether each is currently reachable, and whether each currently has a customer at it. Call this first to discover valid box_id values for esp_speak and esp_display.\n\nArgs:\n  (none)\n\nReturns:\n  { \"boxes\": [{ \"id\": string, \"name\": string, \"ip\": string, \"online\": boolean, \"occupied\": boolean|null, \"fw\": string, \"fw_sha\": string, \"slot\": string, \"pending_verify\": boolean }] }\n\nExamples:\n  - Use when: you need to know which boxes exist, which are powered on, or which currently have someone at them\n  - Don't use when: there is exactly one box and you already know it responds\n\nError Handling:\n  - Never errors; an empty list means no box has registered yet\n  - online=false means the box did not answer within 2s (powered off, or off-network)\n  - occupied is null until the box reports its first session event (a customer approaching, or ordering) since this server started\n  - fw/fw_sha/slot describe the firmware actually running: fw_sha changes on every rebuild (fw alone does not), and slot is the app partition it booted from. After a firmware push they are the way to confirm the new image stuck — a box that rolled back reports the OLD build while looking perfectly healthy\n  - pending_verify=true means the box is running a just-installed image that has not yet confirmed itself; it will either confirm or revert on its own\n  - all four are absent for boxes that have not registered since this server started, or that run pre-OTA firmware",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      // Probed in parallel so a 20-box fleet still answers in ~2s worst case.
      const list = await Promise.all(
        boxes.boxes.map(async (b) => ({
          id: b.id,
          name: b.name,
          ip: b.ip,
          online: await probeOnline(b),
          occupied: b.occupied,
          // Spread so a box that has never registered contributes no fw keys at
          // all, rather than a row of nulls that reads like a failed update.
          ...(b.fw ?? {})
        }))
      );
      return mcpJson({ boxes: list });
    }
  );

  // ---- esp_speak -----------------------------------------------------------
  const SpeakInput = z
    .object({
      box_id: z
        .string()
        .optional()
        .describe("Which box should speak. Optional when only one box is registered; use esp_list_boxes to find valid ids."),
      text: z
        .string()
        .min(1)
        .max(2000)
        .describe("What to say out loud, in plain text. Split into sentences and streamed, so long replies start playing quickly.")
    })
    .strict();

  server.registerTool(
    "esp_speak",
    {
      title: "Speak Text on an ESP Box",
      description:
        "Says text out loud on a specific ESP box's speaker, using the local text-to-speech engine. Speaks only — it does not change what is on the screen; call esp_display for that.\n\nArgs:\n  - box_id (string, optional): target box; defaults to the only box when just one is registered\n  - text (string): what to say, 1-2000 characters\n\nReturns:\n  { \"spoken\": true, \"box_id\": string, \"chunks\": number, \"first_audio_ms\": number, \"total_ms\": number }\n\nExamples:\n  - Use when: you want a box to say something out loud\n  - Don't use when: you only want text on screen (use esp_display)\n\nError Handling:\n  - Returns an error naming valid ids if box_id is unknown or ambiguous\n  - Returns an error if the box is unreachable or speech synthesis fails",
      inputSchema: SpeakInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ box_id, text }) => {
      const { box, error } = resolveBox(boxes, box_id);
      if (error) return mcpError(error);
      if (!text.trim()) return mcpError("text is empty — nothing to say.");
      try {
        const t0 = Date.now();
        const spoken = await speakToBox(box, text);
        console.log(`[${box.name}] esp_speak: ${JSON.stringify(text.slice(0, 60))} [${spoken.chunks} chunks]`);
        return mcpJson({
          spoken: true,
          box_id: box.id,
          chunks: spoken.chunks,
          first_audio_ms: spoken.firstAudioMs,
          total_ms: Date.now() - t0
        });
      } catch (err) {
        return mcpError(`Could not speak on "${box.id}": ${err.message}`);
      }
    }
  );

  // ---- esp_display ---------------------------------------------------------
  const DisplayInput = z
    .object({
      box_id: z
        .string()
        .optional()
        .describe("Which box to draw on. Optional when only one box is registered."),
      text: z
        .string()
        .optional()
        .describe("Caption text to show. Provide this OR items, never both."),
      speaker: z
        .string()
        .optional()
        .describe("Label on the caption's colored bar, e.g. 'BOX' or 'YOU' (default: 'BOX'). Only used with text."),
      title: z
        .string()
        .optional()
        .describe("Heading for the itemized screen (default: 'YOUR ORDER'). Only used with items."),
      items: z
        .array(
          z.object({
            name: z.string().describe("Row label, e.g. '2X ROTI CANAI'. Uppercased; max ~15 chars fit on screen."),
            price: z.string().describe("Right-aligned value, e.g. 'RM4.00'. Pre-formatted by you — mcp-core does no arithmetic.")
          })
        )
        .optional()
        .describe("Itemized rows. Provide this OR text, never both. Max 5 rows fit on screen."),
      total: z
        .string()
        .optional()
        .describe("Value for the bottom total bar, e.g. 'RM6.50'. Only used with items.")
    })
    .strict();

  server.registerTool(
    "esp_display",
    {
      title: "Show Content on an ESP Box Screen",
      description:
        "Draws on a box's 320x240 screen. Two modes: pass `text` for a caption (colored speaker bar + wrapped text), or pass `items` (+ optional `total`) for an itemized list screen. Exactly one of text/items is required. Display only — it makes no sound; call esp_speak for that.\n\nArgs:\n  - box_id (string, optional): target box; defaults to the only box when just one is registered\n  - text (string, optional): caption text\n  - speaker (string, optional): caption bar label (default 'BOX')\n  - items (array, optional): [{ name, price }] rows, max 5 shown\n  - title (string, optional): heading for the items screen (default 'YOUR ORDER')\n  - total (string, optional): bottom total bar value\n\nReturns:\n  { \"displayed\": \"caption\" | \"order\", \"box_id\": string }\n\nExamples:\n  - Use when: showing what was heard, a reply, or an itemized order/total\n  - Don't use when: you want audio (use esp_speak)\n\nError Handling:\n  - Returns an error naming valid ids if box_id is unknown or ambiguous\n  - Returns an error if both text and items are given, or neither, or either is empty\n  - Prices and totals are rendered verbatim; mcp-core never computes them",
      inputSchema: DisplayInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ box_id, text, speaker, title, items, total }) => {
      const { box, error } = resolveBox(boxes, box_id);
      if (error) return mcpError(error);

      // Reject empty values, not just missing keys — text:"" or items:[] would
      // otherwise silently paint a blank screen and look like a no-op.
      const hasText = typeof text === "string" && text.trim() !== "";
      const hasItems = Array.isArray(items) && items.length > 0;
      if (hasText && hasItems) {
        return mcpError("Provide either text (caption) or items (itemized screen), not both.");
      }
      if (!hasText && !hasItems) {
        const why =
          text !== undefined && !hasText ? "text was empty"
          : items !== undefined && !hasItems ? "items was an empty list"
          : "neither was provided";
        return mcpError(`Nothing to display: ${why}. Pass a non-empty text, or a non-empty items list.`);
      }

      try {
        if (hasText) {
          const status = await sendCaption(box, text, { who: speaker || "BOX" });
          if (status === null) return mcpError(`Box "${box.id}" is unreachable at ${box.ip}.`);
          return mcpJson({ displayed: "caption", box_id: box.id });
        }

        const lines = [`TITLE|${orderField(title || "YOUR ORDER", 24)}`];
        for (const it of items.slice(0, 5)) {
          lines.push(`ITEM|${orderField(it.name)}|${orderField(it.price, 10)}`);
        }
        if (total) lines.push(`TOTAL|${orderField(total, 10)}`);
        const status = await sendDisplay(box, { path: "/order", body: lines.join("\n") });
        if (status === null) return mcpError(`Box "${box.id}" is unreachable at ${box.ip}.`);
        return mcpJson({ displayed: "order", box_id: box.id });
      } catch (err) {
        return mcpError(`Could not display on "${box.id}": ${err.message}`);
      }
    }
  );

  // ---- esp_set_occupied -----------------------------------------------------
  const SetOccupiedInput = z
    .object({
      box_id: z
        .string()
        .optional()
        .describe("Which box to change. Optional when only one box is registered."),
      occupied: z
        .boolean()
        .describe("true: force a session start — plays the greeting, exactly as if the presence sensor had just detected someone. false: force a session end — clears the conversation, exactly as if the customer had walked away.")
    })
    .strict();

  server.registerTool(
    "esp_set_occupied",
    {
      title: "Force a Box's Occupied Status",
      description:
        "Manually marks a box as occupied or free, bypassing its presence sensor. Mirrors the box's own natural behavior exactly rather than a separate silent mode: occupied=true triggers the same one-time greeting a real customer approaching would, occupied=false does the same conversation-reset a real departure does.\n\nArgs:\n  - box_id (string, optional): target box; defaults to the only box when just one is registered\n  - occupied (boolean): true = start a session (greets), false = end it (resets)\n\nReturns:\n  { \"box_id\": string, \"occupied\": boolean }\n\nExamples:\n  - Use when: testing the greeting/order flow without walking in front of the sensor\n  - Use when: a box is stuck showing occupied because its sensor missed a departure\n  - Don't use when: you just want to READ the current status — use esp_list_boxes for that\n\nError Handling:\n  - Returns an error naming valid ids if box_id is unknown or ambiguous\n  - Returns an error if the box is unreachable\n  - A no-op if the box is already in the requested state (won't re-greet an already-occupied box)",
      inputSchema: SetOccupiedInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ box_id, occupied }) => {
      const { box, error } = resolveBox(boxes, box_id);
      if (error) return mcpError(error);
      try {
        const status = await sendSessionOverride(box, occupied);
        if (status === null) return mcpError(`Box "${box.id}" is unreachable at ${box.ip}.`);
        // do_session() on the box deliberately doesn't echo this back (the
        // server already knows — it's the one that just asked), which means
        // the server's OWN status has to be updated here, not just the box's.
        // occupied=true happens to also flow through /wake's side effect, but
        // occupied=false has no such path — this is the only place it's set.
        boxes.setOccupied(box.id, occupied);
        return mcpJson({ box_id: box.id, occupied });
      } catch (err) {
        return mcpError(`Could not set occupied on "${box.id}": ${err.message}`);
      }
    }
  );

  return server;
}
