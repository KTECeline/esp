1. Start the full stack (Ollama + MOSS-TTS + bridge/MCP + box adapter)

~/start_voice_assistant.sh 192.168.68.142

Replace the IP if the box shows a different one on its screen. Wait ~5s, then confirm it's healthy:

curl -s http://localhost:3000/health

2. Run the accuracy + latency test

cd ~/esp/listen_v2/eval
python3 -u stt_eval.py

It prints one command at a time — for each: tap BOOT, say the phrase, tap BOOT again, then wait for the box to finish speaking its reply before doing the next one (full round trip is ~15–25s; the script waits up to 90s per command, so don't rush). When done (or Ctrl-C early), it prints WER, Command Accuracy %, and per-stage latency stats, and saves a JSON report.

Command list: stt_test_commands.txt (20 lines now — add more, one phrase per line, to reach 100)

3. Optional: watch live per-stage timing while testing
In a second terminal:

cd ~/esp/listen_v2
python3 show_latency.py
Shows a full timeline (record/upload/STT/LLM/TTS/playback) for every interaction as it happens, plus flags if playback stutters.

. Optional: TTS voice-quality test (needs human raters)
cd ~/esp/listen_v2/eval
python3 tts_generate_samples.py      # generates 30 speech clips + blank ratings CSV
# have people rate the clips 1-5 in tts_ratings_template.csv (naturalness/clarity/pronunciation)
python3 tts_score_mos.py             # computes MOS once ratings are filled in