// The three things a server can tell this box to do — play audio, show a
// caption, show an order — separated from HOW the instruction arrived.
//
// There are two transports now: the inbound HTTP server (works while the box
// shares a network with the server) and an outbound WebSocket the box dials
// itself (works from anywhere, see ws_client.h). Both end up here, so the
// behavior can't drift between them.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/stream_buffer.h"

// ---- Playback ---------------------------------------------------------------
// Split into begin/feed/finish so neither transport has to buffer a whole clip
// before starting — a ~170KB reply chunk would otherwise add real latency.

typedef struct {
    StreamBufferHandle_t ring;
    SemaphoreHandle_t done;
    uint32_t total_bytes;
    // Set to make the playback task stop early instead of waiting out its
    // 3s starvation timeout. Needed because a dropped transport stops feeding
    // the ring without ever delivering the byte count play_begin() promised.
    volatile bool abort_now;
    // How many times a feeder had to wait for ring space. Non-zero means a clip
    // outran the ring, which on the WebSocket transport is the beginning of the
    // stall that kills a proxied channel — so it gets logged, not swallowed.
    uint32_t waits;
} playback_task_args_t;

typedef struct {
    char reply_txt[256];   // X-Reply-Text: still parsed, no longer drawn (captions off)
    bool quiet;            // X-Quiet:  mid-chunk of a pipelined reply, leave the screen alone
    bool final;            // X-Final:  last chunk, linger then READY
    bool auto_listen;      // X-Auto-Listen: start a listen turn once playback ends
} play_opts_t;

typedef struct {
    playback_task_args_t args;
    play_opts_t opts;
    TickType_t end_tick;
    // True between play_begin() and play_finish_audio()/play_abort(). Lets a
    // transport tear down a clip it can no longer feed without having to track
    // that state itself, and makes the teardown idempotent.
    bool active;
} play_session_t;

// h is the 44-byte WAV header; body_len is the PCM byte count that follows.
void play_begin(play_session_t *ps, const uint8_t h[44], uint32_t body_len,
                const play_opts_t *opts);
void play_feed(play_session_t *ps, const void *data, size_t len);
// play_feed() for a caller that must not block. The HTTP path gets a task per
// request from httpd and so can afford to wait; the WebSocket event task is the
// ONLY thing servicing that socket, and blocking it stops reads, keepalives and
// acks — which a proxied link (Tailscale Funnel) reaps as a dead connection.
// Waits in short slices and drops the remainder rather than starving the
// transport. See ROADMAP item 9.
void play_feed_nonblocking(play_session_t *ps, const void *data, size_t len);
// Blocks until the audio has finished leaving the speaker. MUST NOT be called
// from the WebSocket event task — use ws_client.c's play_complete_async().
void play_finish_audio(play_session_t *ps);
// Give up on a clip whose transport died mid-stream. Without this the codec is
// left open and the still-enabled I2S TX channel keeps re-clocking its last DMA
// buffer — an audible glitch loop until the box is rebooted — and the clip's
// 64KB ring buffer is never freed. Safe to call when nothing is playing.
void play_abort(play_session_t *ps);
// Screen + auto-listen policy. Call AFTER acknowledging the transport, so the
// 3.5s caption linger doesn't delay the server's next turn.
void play_after(play_session_t *ps);

// ---- Screen -----------------------------------------------------------------
// `who` picks the speaker-bar colour ("BOX" = green, anything else = amber).
void do_caption(const char *text, const char *who);

// Pipe-delimited line protocol (TITLE|.. / ITEM|name|price / TOTAL|..).
// NOTE: mutates `body` in place while parsing.
void do_order(char *body);

// Server-initiated session override: occupied=true forces a session start
// (plays the greeting, same as real presence detection); occupied=false
// forces a session end (same cleanup a real departure does). See listen_v2.c
// for why this exists — testing without the radar, or clearing a stuck box.
void do_session(bool occupied);
