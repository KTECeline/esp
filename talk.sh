#!/bin/bash
WHISPER_DIR=~/esp/whisper.cpp
STT_MODEL="$WHISPER_DIR/models/ggml-base.bin"
AUDIO_FILE=/tmp/recording.wav
REPLY_MP3=/tmp/reply.mp3
OLLAMA_MODEL="llama3.2:3b"
TTS_URL="http://localhost:8080/v1/audio/speech"
SYSTEM_PROMPT="You are a helpful voice assistant having a spoken conversation. Keep replies short and natural, like a real person talking, 1-2 sentences maximum. Do not use lists, bullet points, or long explanations unless specifically asked. Reply in the same language the person spoke in, without mixing in other languages."

while true; do
  echo ""
  echo "Press Enter, then start speaking. Recording auto-stops when you pause... or type 'quit' to exit"
  read INPUT
  if [ "$INPUT" == "quit" ]; then
    break
  fi

  rm -f "$AUDIO_FILE" "$REPLY_MP3"

  echo "Listening... (speak now, pause when done)"
  sox -d -r 16000 -c 1 "$AUDIO_FILE" silence 1 0.1 2% 1 2.0 2%

  T0=$(date +%s)
  echo "Transcribing..."
  TEXT=$("$WHISPER_DIR/build/bin/whisper-cli" -m "$STT_MODEL" -f "$AUDIO_FILE" -ng -nt -l auto 2>/dev/null | tr -d '\n')
  T1=$(date +%s)
  echo "[STT took $((T1-T0))s]"

  if [ -z "$TEXT" ]; then
    echo "Didn't catch anything, try again."
    continue
  fi

  echo "You said: $TEXT"
  echo "Thinking..."

  REPLY=$(curl -s http://localhost:11434/api/generate -d "$(jq -n --arg model "$OLLAMA_MODEL" --arg sys "$SYSTEM_PROMPT" --arg prompt "$TEXT" '{model: $model, system: $sys, prompt: $prompt, stream: false}')" | jq -r '.response')
  T2=$(date +%s)
  echo "[LLM took $((T2-T1))s]"

  echo "Llama replied: $REPLY"
  echo "Generating speech..."

  curl -s "$TTS_URL" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg input "$REPLY" '{model: "tts-1", input: $input, voice: "default"}')" \
    -o "$REPLY_MP3"
  T3=$(date +%s)
  echo "[TTS took $((T3-T2))s]"

  echo "Speaking..."
  afplay "$REPLY_MP3"
done

echo "Bye!"
