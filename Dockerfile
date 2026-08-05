# mcp-core in a container: Node + sox + the router, in one command.
#
# WHAT THIS IMAGE SUPPORTS
#   speech.stt: openai_whisper       (any OpenAI-compatible endpoint)
#   speech.tts: openai_tts, moss_local (moss_local reaching a MOSS server
#                                       running OUTSIDE the container, via url)
#
# WHAT IT DELIBERATELY DOES NOT SHIP: whisper.cpp.
#   Compiling it here would add a multi-GB layer AND lose Metal — on Apple
#   Silicon the measured cost is encode 180ms -> 672ms, dragging warm STT from
#   ~0.7s back toward ~8s, because a Linux container cannot reach the Mac's GPU.
#   Run whisper natively (see check_setup.sh) or use a hosted STT provider.
#
# NETWORKING — read this, it is the difference between working and bricking:
#   The boxes must reach this server, and this server tells each box what
#   address to use. Inside a bridge network that address is a Docker-internal
#   one no box can route to, and boxes PERSIST what they are told. mcp-core
#   therefore refuses to guess in a container. Pick one:
#     a) --network host          (Linux: simplest, mDNS also works)
#     b) set "lan_ip" in config.json to the HOST's LAN address (Docker Desktop
#        on macOS/Windows, where host networking is limited)
#
# BUILD:  docker build -t mcp-core .
# RUN:    see docker-compose.yml, or:
#   docker run --rm -p 8000:8000 \
#     -v "$PWD/config.json:/app/config.json:ro" \
#     -e ESP_FLEET_TOKEN -e ESP_MCP_TOKEN -e OPENAI_API_KEY \
#     mcp-core

FROM node:22-slim

# sox is not optional: every recording is peak-normalized before STT and every
# reply downsampled to the box's 22.05kHz mono speaker. Without it the audio
# path fails on the first customer, with an error naming neither.
RUN apt-get update \
 && apt-get install -y --no-install-recommends sox libsox-fmt-all \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Manifests first so `npm ci` is cached until dependencies actually change.
COPY mcp-core/package*.json ./mcp-core/
RUN cd mcp-core && npm ci --omit=dev

# voice-mcp-server is small (plain JS) and is what moss_local talks through, so
# it is included even though whisper.cpp is not. An all-hosted config never
# starts it.
COPY voice-mcp-server/package*.json ./voice-mcp-server/
RUN cd voice-mcp-server && npm ci

COPY voice-mcp-server/ ./voice-mcp-server/
RUN cd voice-mcp-server && npm run build && npm prune --omit=dev

COPY mcp-core/ ./mcp-core/

# Lets lanIp() know it must not guess an address (see server.js). /.dockerenv
# is also checked, so this still holds if the image is run by another runtime.
ENV MCP_CORE_IN_CONTAINER=1
# ESP_ROOT is what config.json's relative paths resolve against.
ENV ESP_ROOT=/app
# Boxes cannot see a container's mDNS anyway; skip the advertiser rather than
# let it fail noisily at boot.
ENV MDNS_DISABLE=1

EXPOSE 8000

# Node's built-in fetch, no curl needed in the image. /health is open by design
# (it hides the box inventory from unauthenticated callers, see server.js).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "mcp-core/server.js"]
