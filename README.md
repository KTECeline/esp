# BOX-3 voice assistant

Fully local voice pipeline for the ESP32-S3-BOX-3. No cloud, no API keys.
./start_voice_assistant.sh 192.168.1.8

cd ~/esp/listen_v2 && source idfenv.sh 
idf.py build     

Edit wifi_config.h (SSID, password, and POST_URL to your Mac's new IP on that network)
idf.py -p /dev/cu.usbmodem1201 flash
Box shows its new IP on screen → ./start_voice_assistant.sh <that_ip>

## Architecture

```
ESP box(es) --WiFi--> mcp-core (:8000) --------> agent webhook (:4000)  <- all business logic
 mic/speaker/screen    | STT/TTS via              (agents/restaurant)
                       | voice-mcp-server         falls back to ->
                       | (whisper.cpp, MOSS-TTS)  local LLM (Ollama, plain chat)
                       config: ~/esp/config.json
```

- **mcp-core/** — thin, dumb router. Speech↔text, route text to a backend, push
  audio + display payloads to boxes. Zero business logic, zero hardcoded config;
  everything comes from `config.json` (copy `config.example.json`). Refuses to
  start if no backend is configured. Reusable for non-restaurant projects as-is.
- **agents/restaurant/** — the smarts: mamak persona, `menu.json` (source of truth
  for prices — the LLM never does arithmetic), order pricing, session state, and
  the order-screen payloads the core relays verbatim to the box.
- **voice-mcp-server/** — MCP server exposing STT (whisper.cpp) and TTS (MOSS-TTS)
  tools; auto-started by mcp-core over stdio.
- **listen_v2/** — box firmware (ESP-IDF) + eval tooling.

Boxes live only in `config.json` (`boxes: [{name, ip}]`) — adding box #2..N is a
config edit, not a code change. The agent webhook contract is
`POST {session_id, text}` → `{reply, display, end_session}`, so a future remote
agent (OpenClaw etc.) plugs in by changing one URL.

## 1. Start the full stack

```
~/esp/start_voice_assistant.sh [box_ip]    # box_ip updates config.json's box1
./check_health.sh                          # one green/red line per service
```

## 2. Run the accuracy + latency test

```
cd ~/esp/listen_v2/eval
python3 -u stt_eval.py
```

It prints one command at a time — for each: tap BOOT, say the phrase, tap BOOT
again, then wait for the box to finish speaking its reply before doing the next
one (full round trip is ~15–25s; the script waits up to 90s per command, so
don't rush). When done (or Ctrl-C early), it prints WER, Command Accuracy %,
and per-stage latency stats, and saves a JSON report.

Command list: `stt_test_commands.txt` (20 lines now — add more, one phrase per
line, to reach 100)

## 3. Optional: watch live per-stage timing while testing

In a second terminal:

```
cd ~/esp/listen_v2
python3 show_latency.py
```

Shows a full timeline (record/upload/STT/LLM/TTS/playback) for every
interaction as it happens, plus flags if playback stutters.

## 4. Optional: TTS voice-quality test (needs human raters)

```
cd ~/esp/listen_v2/eval
python3 tts_generate_samples.py      # generates 30 speech clips + blank ratings CSV
# have people rate the clips 1-5 in tts_ratings_template.csv (naturalness/clarity/pronunciation)
python3 tts_score_mos.py             # computes MOS once ratings are filled in
```
