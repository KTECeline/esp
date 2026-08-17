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

export function createMcpServer({ boxes, speakToBox, vision, spc, transcribe, waitForTranscript }) {
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
          "Lists every OrangePi (single-board computer) attached to this fleet, what each can do, and whether each is answering right now. Call this first to discover valid device_id values for the other spc tools.\n\nThese are NOT the ESP voice boxes — those are separate hardware with their own esp_* tools. A Pi is a small Linux machine that can have a microphone, a speaker, sensors and optionally a camera.\n\nArgs:\n  (none)\n\nReturns:\n  { \"devices\": [{ \"id\": string, \"name\": string, \"base_url\": string, \"capabilities\": string[], \"online\": boolean, \"reports\": string[]|null }] }\n\nExamples:\n  - Use when: you need to know which Pi to talk through, or whether one is reachable\n  - Use when: an spc tool failed and you want to know if the device is simply off\n  - Don't use when: you want the ESP boxes (use esp_list_boxes)\n\nError Handling:\n  - Never errors; an empty list means no Pi is configured in this deployment\n  - online=false means the Pi did not answer — powered off, spc-agent not running, or its Tailscale name no longer resolves\n  - `capabilities` is what this server is configured to expose; `reports` is what the Pi itself says it has. If they disagree, the hardware and the config are out of sync and the extra tools will fail\n  - reports is null for an offline device, since it could not be asked",
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
              reports: health.online ? (health.capabilities ?? []) : null
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
            .describe("What to say out loud, in plain text.")
        })
        .strict();

      server.registerTool(
        "spc_speak",
        {
          title: "Speak Text on an OrangePi",
          description:
            "Says text out loud through an OrangePi's speaker. Waits until the audio has actually finished playing before returning, so two calls in a row will not talk over each other.\n\nThis is the Pi's speaker, not an ESP box's — use esp_speak for a box. Picking the right one matters: they are in different places, and a customer only hears the one they are standing next to.\n\nArgs:\n  - device_id (string, optional): target Pi; defaults to the only speaker-equipped device\n  - text (string): what to say, 1-2000 characters\n\nReturns:\n  { \"spoken\": true, \"device_id\": string, \"total_ms\": number }\n\nExamples:\n  - Use when: you want a Pi to say something out loud\n  - Use when: you asked a question through spc_speak and will follow it with spc_listen\n  - Don't use when: the person is at a voice box (use esp_speak)\n\nError Handling:\n  - Returns an error naming valid ids if device_id is unknown, ambiguous, or has no speaker\n  - Returns an error explaining what to check if the Pi is unreachable\n  - Long text takes proportionally long to speak; a very long passage may exceed the call budget even though the Pi is healthy",
          inputSchema: SpcSpeakInput,
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false
          }
        },
        async ({ device_id, text }) => {
          const { device, error } = resolveSpc(spc, "speak", device_id);
          if (error) return mcpError(error);
          if (!text.trim()) return mcpError("text is empty — nothing to say.");
          try {
            const t0 = Date.now();
            await device.speak(text);
            console.log(`[${device.id}] spc_speak: ${JSON.stringify(text.slice(0, 60))}`);
            return mcpJson({ spoken: true, device_id: device.id, total_ms: Date.now() - t0 });
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
            .enum(["message", "qr", "choices", "order", "blank"])
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
            .enum(["neutral", "happy", "listening", "thinking", "speaking", "confused", "sad", "wink", "sleeping", "error"])
            .optional()
            .describe("The face in the upper half. Omit to leave the current face alone."),
          gaze: z
            .enum(["center", "left", "right", "up", "down"])
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
            "Drives the screen attached to an OrangePi. The screen has two halves and this one tool sets either or both: an animated FACE on top (eyes, brows, mouth) and a PANEL below (a message, a QR code, choice tiles, or an order summary).\n\nWhatever you leave out stays as it is. Send only `expression` to change the face while a QR code stays up for scanning; send only `panel` to change what is written without changing the mood. The face keeps blinking and breathing on its own between calls — you never need to call this to keep it alive.\n\nThis is the Pi's screen, not an ESP box's small LCD (that is esp_display), and it makes no sound (that is spc_speak). A natural turn is: set a listening face, listen, set a thinking face, then speak and show what you said.\n\nArgs:\n  - device_id (string, optional): target Pi; defaults to the only screen-equipped device\n  - expression (string, optional): neutral, happy, listening, thinking, speaking, confused, sad, wink, sleeping, error\n  - gaze (string, optional): center, left, right, up, down\n  - panel (object, optional): { mode } plus the fields that mode uses:\n      mode=message  title, subtitle\n      mode=qr       qr_data (required), qr_caption\n      mode=choices  title, subtitle, choices[{id,label,icon}]\n      mode=order    title, items[{name,qty,price}], total, note\n      mode=blank    clears the panel, leaving the face alone\n\nReturns:\n  { \"updated\": true, \"device_id\": string, \"expression\": string, \"panel_mode\": string, \"version\": number }\n\nExamples:\n  - Use when: you are about to listen and want the face to show it (expression=listening)\n  - Use when: showing a payment or menu QR the customer scans with their phone\n  - Use when: mirroring the sentence you are speaking, as panel.subtitle, so it can be read as well as heard\n  - Don't use when: you want the ESP box's screen (use esp_display), or you want sound (use spc_speak)\n\nError Handling:\n  - Returns an error naming valid ids if device_id is unknown, ambiguous, or has no screen\n  - Returns an error if neither expression, gaze nor panel is given — there would be nothing to change\n  - Returns an error if mode=qr arrives without qr_data, since there would be nothing to encode\n  - Returns an error explaining what to check if the Pi is unreachable\n  - Succeeds even if nobody is looking at the screen and even if no browser is currently showing it: the state is stored on the Pi and the panel picks it up when it next connects\n  - Prices and totals are shown exactly as given; this server never computes them",
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
            console.log(`[${device.id}] spc_expression: ${result.expression} / ${result.panel_mode}`);
            return mcpJson({
              updated: true,
              device_id: device.id,
              expression: result.expression,
              panel_mode: result.panel_mode,
              version: result.version
            });
          } catch (err) {
            return mcpError(`Could not update the screen on "${device.id}": ${err.message}`);
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

  return server;
}
