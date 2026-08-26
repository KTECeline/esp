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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { asciiOneline, sendCaption, sendDisplay, sendSessionOverride } from "./boxes.js";
import { wsHas } from "./ws-hub.js";

// What is left of the fixed face vocabulary: gazes and panel modes, which are
// still branches compiled into both renderers and so still have to agree.
//
// Expressions are NOT here any more. They are JSON files on each device, and
// the device validates them — see the note in face-spec.json. All this file
// still carries about them is `builtin_expressions`, the ten every device is
// guaranteed to have, quoted into spc_expression's description as a safe
// default rather than enforced as an enum.
//
// Read at import time and hard-failed on: face-spec.json ships in this
// directory alongside this file, so its absence means a broken install, and a
// server that came up anyway would register an expression enum it invented.
const FACE_SPEC = (() => {
  const specPath = join(dirname(fileURLToPath(import.meta.url)), "face-spec.json");
  let spec;
  try {
    spec = JSON.parse(readFileSync(specPath, "utf8"));
  } catch (err) {
    throw new Error(
      `Cannot read the face vocabulary at ${specPath}: ${err.message}. ` +
      `It ships next to mcp-tools.js — restore it from the repo rather than ` +
      `hardcoding expression names here.`
    );
  }
  for (const key of ["builtin_expressions", "gazes", "panel_modes"]) {
    if (!Array.isArray(spec[key]) || spec[key].length === 0) {
      throw new Error(`face-spec.json is missing a non-empty "${key}" array.`);
    }
  }
  return spec;
})();

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

// Which spc device answers an spc_* call. Unlike resolveBox this is filtered by
// CAPABILITY first, because "which device" and "which device can do this" are
// different questions once a fleet is mixed. With one Pi that has a mic and one
// that doesn't, spc_listen has exactly one valid target and should just use it
// rather than demanding a device_id the model has no way to choose between.
function resolveSpc(spc, cap, deviceId) {
  const able = spc.withCapability(cap);
  const ids = able.map((d) => d.id).join(", ");
  if (!deviceId) {
    if (able.length === 1) return { device: able[0] };
    if (able.length === 0) {
      return { error: `No configured device can "${cap}". Check the devices block in config.json.` };
    }
    return { error: `device_id is required — more than one device can "${cap}". Available: ${ids}` };
  }
  const device = spc.byId(deviceId);
  if (!device) {
    const all = spc.devices.map((d) => d.id).join(", ") || "(none configured)";
    return { error: `Device "${deviceId}" not found. Configured devices: ${all}` };
  }
  if (!device.has(cap)) {
    return { error: `Device "${deviceId}" cannot "${cap}" — it offers: ${device.capabilities.join(", ")}. Devices that can: ${ids || "(none)"}` };
  }
  return { device };
}

export function createMcpServer({ boxes, speakToBox, vision, spc, transcribe, waitForTranscript,
                                  settings, settingsSync }) {
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

  // ---- esp_sense -----------------------------------------------------------
  // Reads state this server ALREADY holds rather than polling the box, and
  // that is not a shortcut. The presence radar is sampled by the firmware
  // itself (sensor.c, GPIO21) and pushed here the moment it changes, because
  // the box has to act on its own presence events anyway — it greets on
  // approach without asking permission. Adding a /sense round trip to the box
  // would return the same bit, slower, and would fail for a box on a network
  // we cannot dial into, which is exactly the deployment this fleet targets.
  const SenseInput = z
    .object({
      box_id: z
        .string()
        .optional()
        .describe("Which box to read. Optional when only one box is registered.")
    })
    .strict();

  server.registerTool(
    "esp_sense",
    {
      title: "Read an ESP Box's Sensors",
      description:
        "Reads the sensor dock on an ESP32-S3-BOX-3: right now that is the human-presence radar, which tells you whether somebody is standing at the box.\n\nArgs:\n  - box_id (string, optional): target box; defaults to the only box when just one is registered\n\nReturns:\n  { \"box_id\": string, \"online\": boolean, \"sensors\": { \"presence\": boolean|null, \"presence_age_s\": number|null }, \"unavailable\": string[] }\n\nExamples:\n  - Use when: you want to know if anyone is at the box before speaking to an empty room\n  - Use when: you are deciding whether to start or wind down a conversation\n  - Don't use when: you want to CHANGE the session state (use esp_set_occupied)\n\nError Handling:\n  - Returns an error naming valid ids if box_id is unknown or ambiguous\n  - presence is null when the box has not reported a session event since this server started, or runs firmware too old to send one. null means UNKNOWN, never 'nobody there'\n  - presence_age_s is how long ago that reading last changed. A presence=true that is hours old is a stuck radar or a missed departure, not a very patient customer — treat large ages with suspicion\n  - `unavailable` lists sensors the dock physically has but this firmware does not read yet (the AHT30 temperature/humidity chip at I2C 0x38). Asking for those values is not possible today",
      inputSchema: SenseInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true      // it reports on the physical world
      }
    },
    async ({ box_id }) => {
      const { box, error } = resolveBox(boxes, box_id);
      if (error) return mcpError(error);
      const ageS =
        box.occupiedAt === null || box.occupiedAt === undefined
          ? null
          : Math.round((Date.now() - box.occupiedAt) / 1000);
      return mcpJson({
        box_id: box.id,
        online: await probeOnline(box),
        sensors: { presence: box.occupied, presence_age_s: ageS },
        // Named explicitly so a model asking "how warm is it" gets a real
        // answer about why it cannot have one, instead of an empty object it
        // has to guess the meaning of.
        unavailable: ["temperature", "humidity"]
      });
    }
  );

  // ---- esp_listen ----------------------------------------------------------
  // A PASSIVE observer of the flow that already exists, which is the only
  // honest way to build this without new firmware. The box decides when to
  // record — a tap, or the presence radar waking it — then uploads the audio
  // and this server transcribes it. There is no box command for "start
  // recording now", so a tool that claimed to make the box listen on demand
  // would be lying about who is in control.
  //
  // Critically it does not CONSUME the transcript: the tap-to-confirm window
  // still arms, and the customer's own confirm still routes to the backend as
  // usual. An MCP client watching a live box must not silently swallow the
  // turn out from under the person standing in front of it.
  const ListenInput = z
    .object({
      box_id: z
        .string()
        .optional()
        .describe("Which box to listen to. Optional when only one box is registered."),
      timeout_s: z
        .number()
        .int()
        .min(1)
        .max(120)
        .optional()
        .describe("How long to wait for someone to speak, in seconds (default 30). Returns heard=false if nobody does.")
    })
    .strict();

  server.registerTool(
    "esp_listen",
    {
      title: "Wait for Speech at an ESP Box",
      description:
        "Waits until somebody speaks at an ESP box and returns what they said, as text. The box records on its own (a tap, or the presence radar waking it) and this server transcribes it with the same speech model used for every other device, so transcripts are consistent across the fleet.\n\nThis WATCHES the box's normal flow — it does not interrupt it. The customer's own tap-to-confirm still works exactly as usual while you are listening.\n\nArgs:\n  - box_id (string, optional): target box; defaults to the only box when just one is registered\n  - timeout_s (integer, optional): how long to wait, 1-120 seconds (default 30)\n\nReturns:\n  { \"heard\": true, \"box_id\": string, \"text\": string, \"waited_ms\": number }\n  { \"heard\": false, \"box_id\": string, \"waited_ms\": number } when nobody spoke in time\n\nExamples:\n  - Use when: you asked a question through esp_speak and want the answer\n  - Use when: you want to observe what customers are saying at a box\n  - Don't use when: you want the box to SAY something (use esp_speak)\n\nError Handling:\n  - Returns an error naming valid ids if box_id is unknown or ambiguous\n  - heard=false is a NORMAL result meaning silence, not a failure — call again if you are still waiting\n  - This cannot force the box to start recording; there is no firmware command for that. If nothing is ever recorded, this will always time out\n  - Speech that transcribes to nothing intelligible is treated as silence, exactly as the box's own flow treats it",
      inputSchema: ListenInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,   // each call captures a different moment
        openWorldHint: true
      }
    },
    async ({ box_id, timeout_s }) => {
      const { box, error } = resolveBox(boxes, box_id);
      if (error) return mcpError(error);
      const waitMs = (timeout_s ?? 30) * 1000;
      const t0 = Date.now();
      try {
        const text = await waitForTranscript(box.id, waitMs);
        const waited_ms = Date.now() - t0;
        if (!text) return mcpJson({ heard: false, box_id: box.id, waited_ms });
        console.log(`[${box.name}] esp_listen heard: ${JSON.stringify(text.slice(0, 60))}`);
        return mcpJson({ heard: true, box_id: box.id, text, waited_ms });
      } catch (err) {
        return mcpError(`Could not listen on "${box.id}": ${err.message}`);
      }
    }
  );

  // ---- esp_look / esp_scan_qr ----------------------------------------------
  // Registered ONLY when a camera is configured. A client that can see these
  // tools can rely on them existing; one that cannot see them is not told about
  // a camera that is not there.
  if (vision) {
    server.registerTool(
      "esp_look",
      {
        title: "Take a Photo from the Counter Camera",
        description:
          "Takes a still photo from the camera attached to THIS SERVER and returns it as an image you can look at directly.\n\nIMPORTANT: this is the server's own camera (one, at the counter) — it is NOT a camera on a voice box. The ESP32-S3-BOX-3 has no camera, so there is no per-box view and box_id does not apply here.\n\nArgs:\n  (none)\n\nReturns:\n  An image block (JPEG) plus { \"captured\": true, \"width\": number, \"height\": number }\n\nExamples:\n  - Use when: you need to see what is physically in front of the counter camera\n  - Use when: someone asks what is on the counter, or to check whether anyone is there\n  - Don't use when: you want to READ a QR code — esp_scan_qr decodes it properly instead of asking you to read pixels\n\nError Handling:\n  - Returns an error naming the fix if the camera is busy, unplugged, or the OS is withholding camera permission\n  - The first frames of a USB webcam are discarded automatically while exposure settles",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,   // each call is a new moment in time
          openWorldHint: true      // it observes the physical world
        }
      },
      async () => {
        try {
          const jpeg = await vision.captureJpeg();
          return {
            content: [
              { type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" },
              { type: "text", text: JSON.stringify({ captured: true, width: vision.width, height: vision.height }) }
            ],
            structuredContent: { captured: true, width: vision.width, height: vision.height }
          };
        } catch (err) {
          return mcpError(`Could not take a photo: ${err.message}`);
        }
      }
    );

    server.registerTool(
      "esp_scan_qr",
      {
        title: "Scan a QR Code at the Counter",
        description:
          "Looks for a QR code in front of the server's counter camera and returns its decoded contents as text. Tries several frames, because a code held by hand moves and blurs.\n\nIMPORTANT: this reads the camera attached to THIS SERVER, not a box — the voice boxes have no camera. Use it for a customer presenting a code (a payment app, a member card, an order slip).\n\nArgs:\n  (none)\n\nReturns:\n  { \"found\": true, \"text\": string, \"corners\": {...} } when a code is read\n  { \"found\": false } when there is no code in view — this is a NORMAL result, not a failure\n\nExamples:\n  - Use when: a customer is holding a QR code up to the camera\n  - Use when: you must verify a scan before confirming a payment\n  - Don't use when: you want to SHOW a payment QR — that is drawn on the box screen, not scanned\n\nError Handling:\n  - found=false simply means nothing was in view; ask the customer to hold it steady and closer, then call again\n  - This camera captures at 640x480, so a small or distant code will not resolve — closer is better\n  - Returns an error only when the camera itself cannot be read",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true
        }
      },
      async () => {
        try {
          const found = await vision.scanQr();
          if (!found) return mcpJson({ found: false });
          console.log(`[camera] QR scanned: ${JSON.stringify(found.text.slice(0, 80))}`);
          return mcpJson({ found: true, text: found.text, corners: found.corners });
        } catch (err) {
          return mcpError(`Could not scan: ${err.message}`);
        }
      }
    );
  }

  // ---- spc_* : the OrangePi namespace --------------------------------------
  // Every tool here is registered only when some configured device declares the
  // matching capability, the same rule the camera tools follow. A fleet with no
  // Pi shows a model no spc tools at all; a Pi with no camera shows no
  // spc_look. The model never sees a tool whose only possible outcome is an
  // apology.
  //
  // The namespace split (esp_ vs spc_) is what makes "say that at the counter"
  // answerable. One merged speak tool with a device_id would make every call a
  // guess about which id refers to which piece of hardware, and the model would
  // be picking between opaque strings. Two namespaces put the choice in the
  // tool name, where the description can explain what each machine IS.
  if (spc && spc.devices.length > 0) {
    server.registerTool(
      "spc_list_devices",
      {
        title: "List OrangePi Devices",
        description:
          "Lists every OrangePi (single-board computer) attached to this fleet, what each can do, and whether each is answering right now. Call this first to discover valid device_id values for the other spc tools.\n\nThese are NOT the ESP voice boxes — those are separate hardware with their own esp_* tools. A Pi is a small Linux machine that can have a microphone, a speaker, sensors and optionally a camera.\n\nArgs:\n  (none)\n\nReturns:\n  { \"devices\": [{ \"id\": string, \"name\": string, \"base_url\": string, \"capabilities\": string[], \"online\": boolean, \"reports\": string[]|null, \"text\": { \"cjk_glyphs\": number, \"latin\": boolean, \"renderer\": string, \"note\": string }|absent }] }\n\nExamples:\n  - Use when: you need to know which Pi to talk through, or whether one is reachable\n  - Use when: an spc tool failed and you want to know if the device is simply off\n  - Don't use when: you want the ESP boxes (use esp_list_boxes)\n\nError Handling:\n  - Never errors; an empty list means no Pi is configured in this deployment\n  - online=false means the Pi did not answer — powered off, spc-agent not running, or its Tailscale name no longer resolves\n  - `capabilities` is what this server is configured to expose; `reports` is what the Pi itself says it has. If they disagree, the hardware and the config are out of sync and the extra tools will fail\n  - reports is null for an offline device, since it could not be asked\n  - `text` appears only for a device with a screen, and says what that screen can SPELL. A panel renders any character it has no glyph for as \"?\", silently. cjk_glyphs is a curated subset (roughly the common Chinese characters), NOT all of Unicode — Japanese kana and rarer hanzi are usually absent. Check it before writing non-Latin text to a panel, and read `undrawable` in spc_expression's reply to find out about one specific string",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async () => {
        const list = await Promise.all(
          spc.devices.map(async (d) => {
            const health = await d.health();
            return {
              id: d.id,
              name: d.name,
              base_url: d.baseUrl,
              capabilities: d.capabilities,
              online: health.online,
              reports: health.online ? (health.capabilities ?? []) : null,
              // What the screen can actually spell. Only devices with a screen
              // send this, and only mid-conversation reachable ones — so it is
              // omitted rather than nulled, keeping the common case (a box with
              // no screen) exactly as terse as it was.
              ...(health.text ? { text: health.text } : {}),
              // What this Pi's screen can draw. Per-device because expressions
              // are files a user can add, so this is the only way to find out
              // about one that is not in the builtin ten.
              ...(health.expressions ? { expressions: health.expressions } : {})
            };
          })
        );
        return mcpJson({ devices: list });
      }
    );

    const DeviceIdInput = (verb) =>
      z
        .object({
          device_id: z
            .string()
            .optional()
            .describe(`Which OrangePi should ${verb}. Optional when only one configured device can; use spc_list_devices to find valid ids.`)
        })
        .strict();

    if (spc.any("look")) {
      server.registerTool(
        "spc_look",
        {
          title: "Take a Photo from an OrangePi Camera",
          description:
            "Takes a still photo from the camera attached to an OrangePi and returns it as an image you can look at directly.\n\nThis is the Pi's own camera, somewhere out in the room. It is NOT the counter camera wired to this server — that one is esp_look — and the two see different things.\n\nArgs:\n  - device_id (string, optional): target Pi; defaults to the only camera-equipped device\n\nReturns:\n  An image block (JPEG) plus { \"captured\": true, \"device_id\": string, \"bytes\": number }\n\nExamples:\n  - Use when: you need to see what is in front of a specific Pi\n  - Don't use when: you want the counter view (use esp_look)\n\nError Handling:\n  - Returns an error naming valid ids if device_id is unknown, ambiguous, or has no camera\n  - Returns an error explaining what to check if the Pi is unreachable\n  - A Pi whose camera was unplugged after startup answers with a clear hardware error rather than a blank frame",
          inputSchema: DeviceIdInput("take the photo"),
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true
          }
        },
        async ({ device_id }) => {
          const { device, error } = resolveSpc(spc, "look", device_id);
          if (error) return mcpError(error);
          try {
            const jpeg = await device.look();
            return {
              content: [
                { type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" },
                { type: "text", text: JSON.stringify({ captured: true, device_id: device.id, bytes: jpeg.length }) }
              ],
              structuredContent: { captured: true, device_id: device.id, bytes: jpeg.length }
            };
          } catch (err) {
            return mcpError(`Could not take a photo on "${device.id}": ${err.message}`);
          }
        }
      );
    }

    if (spc.any("speak")) {
      const SpcSpeakInput = z
        .object({
          device_id: z
            .string()
            .optional()
            .describe("Which OrangePi should speak. Optional when only one configured device has a speaker."),
          text: z
            .string()
            .min(1)
            .max(2000)
            .describe("What to say out loud, in plain text."),
          show: z
            .boolean()
            .optional()
            .default(true)
            .describe("Also put the words on the Pi's screen while it says them, so they can be read as well as heard. Ignored on a Pi with no screen. Pass false to leave the screen alone — e.g. when a QR code is up and someone is mid-scan.")
        })
        .strict();

      server.registerTool(
        "spc_speak",
        {
          title: "Speak Text on an OrangePi",
          description:
            "Says text out loud through an OrangePi's speaker AND, by default, shows the same words on its screen while it speaks them. Waits until the audio has actually finished playing before returning, so two calls in a row will not talk over each other.\n\nThis is the Pi's speaker, not an ESP box's — use esp_speak for a box. Picking the right one matters: they are in different places, and a customer only hears the one they are standing next to.\n\nArgs:\n  - device_id (string, optional): target Pi; defaults to the only speaker-equipped device\n  - text (string): what to say, 1-2000 characters\n  - show (boolean, optional): mirror the words onto the screen as you say them; default true, ignored if the Pi has no screen\n\nReturns:\n  { \"spoken\": true, \"shown\": boolean, \"device_id\": string, \"total_ms\": number }\n\nExamples:\n  - Use when: you want a Pi to say something out loud\n  - Use when: you asked a question through spc_speak and will follow it with spc_listen\n  - Use when: you want the words heard AND read — this is the normal case, and it needs no second call\n  - Don't use when: the person is at a voice box (use esp_speak)\n  - Pass show=false when: a QR code or an order summary must stay on screen while you talk\n\nError Handling:\n  - Returns an error naming valid ids if device_id is unknown, ambiguous, or has no speaker\n  - Returns an error explaining what to check if the Pi is unreachable\n  - Long text takes proportionally long to speak; a very long passage may exceed the call budget even though the Pi is healthy\n  - shown=false with spoken=true means it talked but the screen did not take the text: either the Pi has no screen, or you passed show=false. It is never a reason to retry the speech",
          inputSchema: SpcSpeakInput,
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false
          }
        },
        async ({ device_id, text, show }) => {
          const { device, error } = resolveSpc(spc, "speak", device_id);
          if (error) return mcpError(error);
          if (!text.trim()) return mcpError("text is empty — nothing to say.");
          try {
            const t0 = Date.now();
            // Screen first, then voice. The words have to be up BEFORE the audio
            // starts — speak() blocks until playback finishes, so mirroring
            // afterwards would caption a sentence that had already been said.
            let shown = false;
            if (show && device.has("screen")) {
              try {
                await device.display({ panel: { mode: "message", subtitle: text } });
                shown = true;
              } catch (err) {
                // A screen that refuses is not a reason to go mute.
                console.warn(`[${device.id}] could not mirror speech to the screen: ${err.message}`);
              }
            }
            await device.speak(text);
            console.log(`[${device.id}] spc_speak: ${JSON.stringify(text.slice(0, 60))}`);
            return mcpJson({ spoken: true, shown, device_id: device.id, total_ms: Date.now() - t0 });
          } catch (err) {
            return mcpError(`Could not speak on "${device.id}": ${err.message}`);
          }
        }
      );
    }

    if (spc.any("screen")) {
      // The panel's four layouts, as one object rather than four flat argument
      // groups: `mode` decides which other fields are read, and nesting them
      // makes that dependency visible to the model instead of leaving it to be
      // discovered by having fields quietly ignored.
      const SpcPanelInput = z
        .object({
          mode: z
            .enum(FACE_SPEC.panel_modes)
            .describe("Which layout to draw: message (a line of text), qr (a scannable code), choices (large tiles), order (itemized list), blank (clear the panel, leaving only the face)."),
          title: z.string().max(60).optional().describe("The large line. Used by message, choices and order."),
          subtitle: z
            .string()
            .max(200)
            .optional()
            .describe("The smaller line under the title. This is where to put what you are saying out loud, so a customer who mishears can read it."),
          qr_data: z
            .string()
            .max(400)
            .optional()
            .describe("Required for mode=qr: the exact text or URL the phone should receive. Encoded verbatim."),
          qr_caption: z.string().max(60).optional().describe("Words shown beside the QR, e.g. 'Scan QR to Order'."),
          choices: z
            .array(
              z
                .object({
                  id: z.string().max(32).describe("Stable identifier for this choice."),
                  label: z.string().max(24).describe("The words on the tile."),
                  icon: z.string().max(8).optional().describe("A single emoji shown above the label.")
                })
                .strict()
            )
            .max(4)
            .optional()
            .describe("For mode=choices: up to 4 tiles. These are shown, not tappable — the customer still answers out loud."),
          items: z
            .array(
              z
                .object({
                  name: z.string().max(40).describe("Item name."),
                  qty: z.number().int().min(1).max(99).optional().describe("How many."),
                  price: z.string().max(12).optional().describe("Pre-formatted line price, e.g. 'RM9.00'. Shown verbatim.")
                })
                .strict()
            )
            .max(6)
            .optional()
            .describe("For mode=order: the lines of the order, at most 6."),
          total: z.string().max(16).optional().describe("Pre-formatted total, e.g. 'RM18.50'. Shown verbatim; never computed here."),
          note: z.string().max(160).optional().describe("A small line under the order, e.g. what to do next.")
        })
        .strict();

      const SpcExpressionInput = z
        .object({
          device_id: z
            .string()
            .optional()
            .describe("Which OrangePi's screen to change. Optional when only one configured device has one."),
          expression: z
            // Not an enum. It used to be, sourced from face-spec.json, and that
            // was right while the ten faces were compiled into both renderers.
            // They are JSON files on the device now — a user adds one by dropping
            // a file — so the valid set is per-device and changes without this
            // process being told. An enum here would reject a face that is
            // sitting on the glass. The device validates instead, and its error
            // names what it actually has; spc_list_devices reports the same list
            // so a model can look before it guesses.
            .string()
            .optional()
            .describe(
              `The face in the upper half. Omit to leave the current face alone. ` +
              `Every device draws at least these: ${FACE_SPEC.builtin_expressions.join(", ")}. ` +
              `A device may have more — spc_list_devices reports each one's full list under "expressions".`
            ),
          gaze: z
            .enum(FACE_SPEC.gazes)
            .optional()
            .describe("Where the eyes look. Omit for the expression's own default."),
          panel: SpcPanelInput.optional().describe("The lower half. Omit to leave whatever is already shown.")
        })
        .strict();

      server.registerTool(
        "spc_expression",
        {
          title: "Set an OrangePi's Face and Screen",
          description:
            "Drives the screen attached to an OrangePi. The screen has two halves and this one tool sets either or both: an animated FACE on top (eyes, brows, mouth) and a PANEL below (a message, a QR code, choice tiles, or an order summary).\n\nWhatever you leave out stays as it is. Send only `expression` to change the face while a QR code stays up for scanning; send only `panel` to change what is written without changing the mood. The face keeps blinking and breathing on its own between calls — you never need to call this to keep it alive.\n\nThis is the Pi's screen, not an ESP box's small LCD (that is esp_display), and it makes no sound (that is spc_speak). A natural turn is: set a listening face, listen, set a thinking face, then speak and show what you said.\n\nArgs:\n  - device_id (string, optional): target Pi; defaults to the only screen-equipped device\n  - expression (string, optional): the face. Every device has neutral, happy, listening, thinking, speaking, confused, sad, wink, sleeping, error. A device may have more — expressions are JSON files someone can add to a Pi, so call spc_list_devices and read its \"expressions\" list before assuming. An unknown name comes back as an error naming what that device actually has\n  - gaze (string, optional): center, left, right, up, down\n  - panel (object, optional): { mode } plus the fields that mode uses:\n      mode=message  title, subtitle\n      mode=qr       qr_data (required), qr_caption\n      mode=choices  title, subtitle, choices[{id,label,icon}]\n      mode=order    title, items[{name,qty,price}], total, note\n      mode=blank    clears the panel, leaving the face alone\n\nReturns:\n  { \"updated\": true, \"device_id\": string, \"expression\": string, \"panel_mode\": string, \"version\": number, \"undrawable\": string|absent, \"warning\": string|absent }\n\nExamples:\n  - Use when: you are about to listen and want the face to show it (expression=listening)\n  - Use when: showing a payment or menu QR the customer scans with their phone\n  - Use when: mirroring the sentence you are speaking, as panel.subtitle, so it can be read as well as heard\n  - Don't use when: you want the ESP box's screen (use esp_display), or you want sound (use spc_speak)\n\nError Handling:\n  - Returns an error naming valid ids if device_id is unknown, ambiguous, or has no screen\n  - Returns an error listing that device's expressions if `expression` is not one it has. That list is per-device and can grow without this server restarting, so trust the error over any list you remember\n  - Returns an error if neither expression, gaze nor panel is given — there would be nothing to change\n  - Returns an error if mode=qr arrives without qr_data, since there would be nothing to encode\n  - Returns an error explaining what to check if the Pi is unreachable\n  - Succeeds even if nobody is looking at the screen and even if no browser is currently showing it: the state is stored on the Pi and the panel picks it up when it next connects\n  - Prices and totals are shown exactly as given; this server never computes them\n  - The panel draws any character the screen has no glyph for as \"?\", and still reports success. When that happens the reply carries `undrawable` (those exact characters) and a `warning` — the panel IS up, so this is not an error, but the text on the glass is not what you sent. Re-send it in characters the screen covers. spc_list_devices `text` says what it has: Latin always, plus a curated Chinese subset if the device has one, so Japanese kana and rare hanzi are the usual casualties",
          inputSchema: SpcExpressionInput,
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
          }
        },
        async ({ device_id, expression, gaze, panel }) => {
          const { device, error } = resolveSpc(spc, "screen", device_id);
          if (error) return mcpError(error);
          if (expression === undefined && gaze === undefined && panel === undefined) {
            return mcpError(
              "Nothing to change — give an expression, a gaze, a panel, or any combination. " +
              "Use panel { mode: \"blank\" } if the intent was to clear the lower half."
            );
          }
          if (panel?.mode === "qr" && !panel.qr_data?.trim()) {
            return mcpError("panel.mode is \"qr\" but qr_data is missing — there is nothing to encode.");
          }
          try {
            const patch = {};
            if (expression !== undefined) patch.expression = expression;
            if (gaze !== undefined) patch.gaze = gaze;
            if (panel !== undefined) patch.panel = panel;
            const result = await device.display(patch);
            console.log(
              `[${device.id}] spc_expression: ${result.expression} / ${result.panel_mode}` +
              (result.undrawable ? ` [undrawable: ${result.undrawable}]` : "")
            );
            return mcpJson({
              updated: true,
              device_id: device.id,
              expression: result.expression,
              panel_mode: result.panel_mode,
              version: result.version,
              // The panel went up either way; these characters are showing as
              // '?' on it. Surfaced so a model can rewrite the text rather than
              // believing it displayed something the glass cannot spell.
              ...(result.undrawable
                ? {
                    undrawable: result.undrawable,
                    warning:
                      `This screen has no glyph for: ${result.undrawable}. ` +
                      `Those characters are showing as "?". Re-send the panel using ` +
                      `characters it covers — call spc_list_devices to see what it has.`
                  }
                : {})
            });
          } catch (err) {
            return mcpError(`Could not update the screen on "${device.id}": ${err.message}`);
          }
        }
      );
    }

    if (spc.any("volume")) {
      const SpcVolumeInput = z
        .object({
          device_id: z
            .string()
            .optional()
            .describe("Which OrangePi's volume to read or change. Optional when only one configured device has a volume control; use spc_list_devices to find valid ids."),
          level: z
            .number()
            .int()
            .min(0)
            .max(100)
            .optional()
            .describe("New loudness, 0-100. OMIT THIS to read the current level without changing anything.")
        })
        .strict();

      server.registerTool(
        "spc_volume",
        {
          title: "Read or Set an OrangePi's Speaker Volume",
          description:
            "Reads or changes how loud an OrangePi's speaker is, on a 0-100 scale.\n\nOmit `level` to READ the current volume and change nothing. Pass `level` to SET it. The value that comes back is what the hardware actually settled on, which can differ by a percent from what you asked for, so trust the response over your request.\n\nUse the read form first whenever someone asks for a relative change — \"turn it down a bit\", \"louder\" — because the same words mean different numbers depending on where it already is. A reasonable step is 15-20 points.\n\nThis changes playback loudness only. It does not affect the microphone, and it is not a mute for the screen (that is spc_expression).\n\nArgs:\n  - device_id (string, optional): target Pi; defaults to the only volume-capable device\n  - level (integer, optional): 0-100. Omit to read.\n\nReturns:\n  { \"device_id\": string, \"volume\": number, \"changed\": boolean, \"previous\": number|null }\n\nExamples:\n  - Use when: someone says it is too loud or too quiet\n  - Use when: a web UI or another tool needs to show the current level\n  - Use when: dropping the volume before speaking late at night, then restoring it\n  - Don't use when: you want silence for one utterance — simply do not call spc_speak\n  - Don't use when: the person is at an ESP box; these are different speakers in different places\n\nError Handling:\n  - Returns an error naming valid ids if device_id is unknown, ambiguous, or has no volume control\n  - Returns an error explaining what to check if the Pi is unreachable\n  - level is clamped to 0-100 rather than rejected, so 150 sets 100 and reports 100\n  - 0 is silence, not mute: the speaker is still selected and spc_speak still reports spoken=true, so a caller who set 0 and forgot is the usual reason for \"it says it spoke but I heard nothing\"\n  - A device can have a speaker but NO volume control, if its firmware exposes no mixer. Then this tool is absent for that device and loudness is fixed in hardware",
          inputSchema: SpcVolumeInput,
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
          }
        },
        async ({ device_id, level }) => {
          const { device, error } = resolveSpc(spc, "volume", device_id);
          if (error) return mcpError(error);
          try {
            // Read first even when setting: `previous` is what makes a relative
            // follow-up ("a bit more") possible without a second round trip, and
            // it is the only way the caller can tell a no-op from a real change.
            const before = await device.getVolume();
            if (level === undefined) {
              return mcpJson({
                device_id: device.id,
                volume: before.volume,
                changed: false,
                previous: null
              });
            }
            const after = await device.setVolume(level);
            console.log(`[${device.id}] spc_volume: ${before.volume} -> ${after.volume}`);
            return mcpJson({
              device_id: device.id,
              volume: after.volume,
              changed: after.volume !== before.volume,
              previous: before.volume
            });
          } catch (err) {
            return mcpError(`Could not ${level === undefined ? "read" : "set"} the volume on "${device.id}": ${err.message}`);
          }
        }
      );
    }

    if (spc.any("sense")) {
      server.registerTool(
        "spc_sense",
        {
          title: "Read an OrangePi's Sensors",
          description:
            "Reads whatever sensors are attached to an OrangePi and returns their current values.\n\nThe set of sensors is whatever is physically wired to that Pi, so it varies by device and this server does not interpret it — the values are passed through exactly as the Pi reports them. Read the key names to see what you were given; do not assume a particular sensor is present.\n\nArgs:\n  - device_id (string, optional): target Pi; defaults to the only sensor-equipped device\n\nReturns:\n  { \"device_id\": string, \"sensors\": object, \"ts\": string }\n\nExamples:\n  - Use when: you want to know if someone is near a Pi, or how warm/bright the room is\n  - Use when: deciding whether it is worth speaking through that Pi at all\n  - Don't use when: you want an ESP box's presence radar (use esp_sense)\n\nError Handling:\n  - Returns an error naming valid ids if device_id is unknown, ambiguous, or has no sensors\n  - Returns an error explaining what to check if the Pi is unreachable\n  - An empty sensors object means the Pi is running but no sensor produced a reading; that is a wiring problem on the Pi, not a fleet problem\n  - Individual sensors may report null for a failed read while others succeed — a null is UNKNOWN, never zero",
          inputSchema: DeviceIdInput("be read"),
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true
          }
        },
        async ({ device_id }) => {
          const { device, error } = resolveSpc(spc, "sense", device_id);
          if (error) return mcpError(error);
          try {
            const body = await device.sense();
            return mcpJson({
              device_id: device.id,
              sensors: body.sensors ?? {},
              ts: body.ts ?? new Date().toISOString()
            });
          } catch (err) {
            return mcpError(`Could not read sensors on "${device.id}": ${err.message}`);
          }
        }
      );
    }

    if (spc.any("listen")) {
      const SpcListenInput = z
        .object({
          device_id: z
            .string()
            .optional()
            .describe("Which OrangePi should listen. Optional when only one configured device has a microphone."),
          timeout_s: z
            .number()
            .int()
            .min(1)
            .max(60)
            .optional()
            .describe("Longest time to record while waiting for speech, in seconds (default 10). Recording stops early once the speaker goes quiet.")
        })
        .strict();

      server.registerTool(
        "spc_listen",
        {
          title: "Listen Through an OrangePi Microphone",
          description:
            "Records from an OrangePi's microphone and returns what was said, as text. Unlike an ESP box, a Pi records ON DEMAND — calling this actively opens the mic right now, rather than waiting for someone to press something.\n\nRecording stops as soon as the speaker falls silent, so a short answer returns quickly instead of always taking the full timeout. Transcription happens on this server with the same speech model used for the voice boxes, so a Pi and a box transcribe the same words the same way.\n\nArgs:\n  - device_id (string, optional): target Pi; defaults to the only microphone-equipped device\n  - timeout_s (integer, optional): longest recording, 1-60 seconds (default 10)\n\nReturns:\n  { \"heard\": true, \"device_id\": string, \"text\": string, \"waited_ms\": number }\n  { \"heard\": false, \"device_id\": string, \"waited_ms\": number } when nobody spoke\n\nExamples:\n  - Use when: you asked a question through spc_speak and want the reply\n  - Use when: you want to actively capture speech at a Pi without any button press\n  - Don't use when: the person is at a voice box (use esp_listen, which waits for the box's own recording)\n\nError Handling:\n  - Returns an error naming valid ids if device_id is unknown, ambiguous, or has no microphone\n  - heard=false is a NORMAL result meaning silence or nothing intelligible, not a failure\n  - Returns an error explaining what to check if the Pi is unreachable\n  - This holds the microphone for the duration; two overlapping calls to the same Pi will contend for it, so wait for one to finish",
          inputSchema: SpcListenInput,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true
          }
        },
        async ({ device_id, timeout_s }) => {
          const { device, error } = resolveSpc(spc, "listen", device_id);
          if (error) return mcpError(error);
          const t0 = Date.now();
          try {
            const wav = await device.listen({ timeoutS: timeout_s ?? 10 });
            if (!wav) return mcpJson({ heard: false, device_id: device.id, waited_ms: Date.now() - t0 });
            const raw = await transcribe(wav);
            // The same non-speech filter the box flow uses. Whisper writes
            // "(upbeat music)" or "[door slams]" for room noise; if stripping
            // the bracketed annotations leaves nothing, nobody actually spoke.
            const text = raw.replace(/[\(\[].*?[\)\]]/g, "").replace(/^[\s.,!?]+|[\s.,!?]+$/g, "");
            const waited_ms = Date.now() - t0;
            if (!text) return mcpJson({ heard: false, device_id: device.id, waited_ms });
            console.log(`[${device.id}] spc_listen heard: ${JSON.stringify(text.slice(0, 60))}`);
            return mcpJson({ heard: true, device_id: device.id, text, waited_ms });
          } catch (err) {
            return mcpError(`Could not listen on "${device.id}": ${err.message}`);
          }
        }
      );
    }
  }

  // ---- fleet_settings_* ----------------------------------------------------
  // The knobs that used to be constants, exposed so the agent can tune the
  // hardware it is standing in front of.
  //
  // Registered only when a store was injected, following the same rule as the
  // vision and spc tools: a tool that exists but cannot work is worse than a
  // tool that is absent, because a model will keep trying it.
  if (settings) {
    server.registerTool(
      "fleet_settings_list",
      {
        title: "List Fleet Settings",
        description:
          "Lists every runtime-tunable setting in the fleet: what it currently is, what it defaults to, the range it accepts, and what it actually controls. Call this before fleet_settings_set — the descriptions say what each knob does to the customer's experience, and the ranges are enforced.\n\nThese are behaviour knobs (how long to wait, how loud counts as speech, how many items fit on screen), not wiring. Addresses, tokens and which speech engine to use are NOT here; those live in config.json and are a human's job.\n\nArgs:\n  - scope (string, optional): filter to one of server, box, device, agent. Omit for all\n\nReturns:\n  { \"revision\": number, \"settings\": [{ \"key\", \"scope\", \"type\", \"value\", \"default\", \"min\", \"max\", \"unit\", \"modified\", \"summary\", \"guidance\" }], \"hardware\": [{ \"id\", \"name\", \"in_sync\" }] }\n\nWhat scope tells you:\n  - server: this server reads it live; a change applies to the next thing that uses it\n  - box: it lives on the ESP voice boxes and is pushed to them when changed\n  - device: it lives on an OrangePi and is pushed there when changed\n  - agent: this server does not use it at all; the ordering agent reads it\n\nExamples:\n  - Use when: you are about to change a setting and need its exact key and range\n  - Use when: someone asks why the box cuts them off, or waits too long, and you want to see the current tuning\n  - Don't use when: you want the fleet's addresses or hardware inventory (use esp_list_boxes / spc_list_devices)\n\nError Handling:\n  - Never errors; an unknown scope returns an error naming the valid ones\n  - modified=true means someone has changed that key from its shipped default\n  - hardware[].in_sync=false means a box has not yet acknowledged the current revision — usually it is switched off, and it will catch up on its own when it comes back",
        inputSchema: z.object({
          scope: z
            .enum(["server", "box", "device", "agent"])
            .optional()
            .describe("Limit to one scope. Omit to list everything.")
        }).strict(),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async ({ scope }) =>
        mcpJson({
          revision: settings.revision,
          settings: settings.describe(scope),
          hardware: settingsSync ? settingsSync() : []
        })
    );

    server.registerTool(
      "fleet_settings_set",
      {
        title: "Change Fleet Settings",
        description:
          "Changes one or more runtime settings and, for anything that lives on hardware, pushes it to the boxes and Pis straight away. The change is saved, so it survives a restart.\n\nEvery value is range-checked against the catalog, and the whole change is all-or-nothing: if one key is rejected, nothing is applied and the error says which key and why. Call fleet_settings_list first for the exact key names, ranges, and what each one does.\n\nArgs:\n  - changes (object): { \"key\": value } for one or more keys, e.g. { \"listen.silence_hold_ms\": 1800 }\n  - reason (string, optional): why, for the server log. Worth sending — it is what makes an odd value understandable later\n\nReturns:\n  { \"revision\": number, \"changed\": [{ \"key\", \"scope\", \"from\", \"to\" }], \"unchanged\": [string], \"pushed_to_hardware\": boolean }\n\nExamples:\n  - Use when: the customer was cut off mid-sentence — raise listen.silence_hold_ms\n  - Use when: the box never stops recording in a noisy room — raise listen.silence_peak\n  - Use when: the kitchen is backed up — raise order.prep_minutes\n  - Use when: someone asks for a longer or shorter payment window — pay.scan_timeout_ms\n  - Don't use when: you need to change an address, a token, or which speech engine runs. Those are in config.json on purpose and are not settings\n\nError Handling:\n  - Returns an error naming the key and its valid range if a value is out of bounds; NOTHING is changed in that case, including the other keys in the same call\n  - Returns an error suggesting near-matching keys if a key does not exist\n  - Keys already at the requested value come back in `unchanged` and are not an error\n  - Succeeds even when a box is switched off: the change is stored here and delivered when that box next comes back. Check hardware[].in_sync in fleet_settings_list to see whether it has landed yet\n  - A setting marked takes_effect \"on the next mcp-core restart\" is saved but not live; the reply says so",
        inputSchema: z.object({
          changes: z
            .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
            .describe("Keys and their new values, e.g. { \"listen.silence_hold_ms\": 1800, \"order.prep_minutes\": 20 }"),
          reason: z
            .string()
            .max(200)
            .optional()
            .describe("Why this is being changed. Logged next to the change.")
        }).strict(),
        annotations: {
          readOnlyHint: false,
          // Not destructive in the sense that matters: every change is bounded,
          // reversible with fleet_settings_reset, and cannot break the fleet's
          // ability to be reached — that is the reason wiring stays in
          // config.json and out of this tool's reach.
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async ({ changes, reason }) => {
        try {
          const result = await settings.set(changes, { actor: `agent${reason ? ` (${reason})` : ""}` });
          return mcpJson({
            revision: result.revision,
            changed: result.changed,
            unchanged: result.unchanged ?? [],
            pushed_to_hardware: result.changed.some((c) => c.scope === "box" || c.scope === "device")
          });
        } catch (err) {
          return mcpError(err.message);
        }
      }
    );

    server.registerTool(
      "fleet_settings_reset",
      {
        title: "Reset Fleet Settings to Defaults",
        description:
          "Puts settings back to the values the software ships with, and forgets the override. Use this to undo tuning that made things worse, rather than trying to remember what a value used to be.\n\nResetting is not the same as setting a key to today's default: a reset key FOLLOWS the default from then on, so a better default in a future version reaches this install. Writing the number back by hand would pin it forever.\n\nArgs:\n  - keys (array of strings, optional): which settings to reset\n  - all (boolean, optional): reset every setting that has been changed. Requires keys to be omitted\n\nReturns:\n  { \"revision\": number, \"changed\": [{ \"key\", \"scope\", \"from\", \"to\" }] }\n\nExamples:\n  - Use when: a tuning change made things worse and you want the known-good value back\n  - Use when: handing a box to someone else and you want it behaving as shipped\n  - Don't use when: you want a specific value (use fleet_settings_set)\n\nError Handling:\n  - Returns an error if neither keys nor all is given — resetting the whole fleet by accident is too easy otherwise\n  - Returns an error suggesting near-matching keys if a key does not exist\n  - Keys that were never changed are skipped silently; an empty `changed` list means there was nothing to undo",
        inputSchema: z.object({
          keys: z.array(z.string()).min(1).optional().describe("Setting keys to reset."),
          all: z.boolean().optional().describe("Reset every changed setting. Cannot be combined with keys.")
        }).strict(),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async ({ keys, all }) => {
        if (keys && all) {
          return mcpError("Give either keys or all:true, not both — they mean different things.");
        }
        if (!keys && !all) {
          return mcpError(
            "Nothing to reset. Pass keys:[...] for specific settings, or all:true to clear every override. " +
            "Use fleet_settings_list to see which settings are currently modified."
          );
        }
        try {
          const result = await settings.reset(all ? "all" : keys, { actor: "agent" });
          return mcpJson({ revision: result.revision, changed: result.changed });
        } catch (err) {
          return mcpError(err.message);
        }
      }
    );
  }

  return server;
}
