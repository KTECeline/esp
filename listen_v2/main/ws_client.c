// Reverse channel: the box dials OUT to the server and holds the connection
// open, so the server can push to it from any network.
//
// Why not a VPN on the box: MicroLink (ESP32 Tailscale) doesn't use lwIP
// sockets, so adopting it means rewriting every bit of networking here on a
// proprietary API; esp_wireguard is alpha and lists neither ESP32-S3 nor
// IDF 5.x. Hand-rolling WireGuard was considered and rejected — that's writing
// your own cryptography, which is exactly the code you should not write
// yourself. An outbound WebSocket needs none of it: ordinary TLS, the same
// thing any HTTPS client does, with NAT traversal handled by the fact that the
// connection is outbound.
//
// This file is transport only. Every instruction it receives is executed by
// box_actions.h, the same functions the HTTP handlers call — so behavior can't
// drift between the two paths.
#include "ws_client.h"
#include <string.h>
#include <stdlib.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_websocket_client.h"
#include "esp_crt_bundle.h"
#include "box_actions.h"

static const char *TAG = "ws_client";
static esp_websocket_client_handle_t s_client = NULL;

// ---- Inbound frame assembly -------------------------------------------------
// Wire format (one WebSocket message per instruction), deliberately NOT JSON —
// this firmware avoids a JSON parser on purpose (the order screen uses a
// pipe-delimited protocol for the same reason), and this parses with strchr:
//
//     <path>\n  id:<n>\n  <Header>:<value>\n  ...  \n\n  <raw body bytes>
//
// esp_websocket_client delivers a message in fragments, so this is a small
// state machine: collect the header block first, then stream the body straight
// into playback (never buffering a whole clip — see box_actions.h).

#define WS_HEAD_MAX  640    // header block + the 44-byte WAV header
#define WS_BODY_MAX  512    // caption/order bodies only; audio is streamed

typedef enum { WS_IDLE, WS_HEAD, WS_PLAY_STREAM, WS_TEXT_BODY, WS_SKIP } ws_state_t;

static ws_state_t s_state = WS_IDLE;
static char  s_head[WS_HEAD_MAX];
static int   s_head_len;
static char  s_req_id[24];
static char  s_path[32];
static char  s_speaker[16];
static bool  s_confirm;
static play_opts_t s_opts;
static play_session_t s_play;
static char  s_body[WS_BODY_MAX];
static int   s_body_len;
static uint32_t s_body_expected;   // bytes of body still to come (play only)

static void ws_ack(const char *id, int status)
{
    if (!s_client || !id[0]) return;
    char msg[48];
    int n = snprintf(msg, sizeof(msg), "ACK %s %d", id, status);
    esp_websocket_client_send_text(s_client, msg, n, pdMS_TO_TICKS(2000));
}

// NOTHING long-running may run on the websocket event task — it is the ONLY
// thing servicing this socket, so blocking it stops reads, stops the keepalive
// and stops acks. The server then sees a dead channel and terminates it, the
// mid-clip drop trips play_abort(), and the result is chopped speech with
// pushes falling back to LAN behind it. The HTTP path never hits this because
// httpd gives every request its own task.
//
// That rule was originally applied to play_after() alone, which was only half
// the problem: play_finish_audio() waits for the speaker to drain, so it blocks
// for most of the clip too. Over a proxied link (Tailscale Funnel) those seconds
// of silence are exactly what gets reaped — the ROADMAP item 9 "drops around
// large audio pushes" symptom. Both now run here, off the event task.
//
// The ack still goes out only when playback has actually finished: mcp-core's
// sendAudio() treats the ack as "playback complete" and speakToBox() paces its
// sentence chunks against it, so acking early would collapse that pacing.
static volatile bool s_completing = false;
static char s_complete_id[sizeof(s_req_id)];

static void play_complete_task(void *arg)
{
    play_finish_audio(&s_play);
    ws_ack(s_complete_id, 200);
    play_after(&s_play);
    s_completing = false;
    vTaskDelete(NULL);
}

static void play_complete_async(void)
{
    // Copied, not read from s_req_id at ack time: now that the event task no
    // longer blocks, the next instruction can land while this clip is still
    // draining and would otherwise overwrite the id we still owe an ack for.
    strlcpy(s_complete_id, s_req_id, sizeof(s_complete_id));
    s_completing = true;
    if (xTaskCreate(play_complete_task, "play_done", 4096, NULL, 5, NULL) == pdPASS) return;

    // Falling back to inline means blocking the event task — the very thing this
    // exists to avoid — but silently never acking would hang the server's push
    // for its full timeout, which is worse.
    ESP_LOGE(TAG, "could not spawn playback completion task — finishing inline");
    s_completing = false;
    play_finish_audio(&s_play);
    ws_ack(s_complete_id, 200);
    play_after(&s_play);
}

// Pull one "Name:value" out of the collected header block. Returns false if
// absent. `head` is NUL-terminated and lines are '\n'-separated.
static bool head_get(const char *head, const char *name, char *out, size_t out_len)
{
    size_t nlen = strlen(name);
    const char *p = head;
    while (p && *p) {
        const char *eol = strchr(p, '\n');
        size_t linelen = eol ? (size_t)(eol - p) : strlen(p);
        if (linelen > nlen && p[nlen] == ':' && strncmp(p, name, nlen) == 0) {
            size_t vlen = linelen - nlen - 1;
            if (vlen >= out_len) vlen = out_len - 1;
            memcpy(out, p + nlen + 1, vlen);
            out[vlen] = 0;
            return true;
        }
        p = eol ? eol + 1 : NULL;
    }
    return false;
}

// Header block is complete: decide what this instruction is and set up for the
// body. Returns bytes of `body` consumed here (the 44-byte WAV header for play).
static void begin_instruction(const char *body, int body_len, uint32_t total_body)
{
    char v[8];
    s_req_id[0] = 0;
    head_get(s_head, "id", s_req_id, sizeof(s_req_id));

    const char *nl = strchr(s_head, '\n');
    size_t plen = nl ? (size_t)(nl - s_head) : strlen(s_head);
    if (plen >= sizeof(s_path)) plen = sizeof(s_path) - 1;
    memcpy(s_path, s_head, plen);
    s_path[plen] = 0;

    if (strcmp(s_path, "/play") == 0) {
        if (total_body < 44) { ESP_LOGW(TAG, "/play body too short"); s_state = WS_SKIP; return; }
        // Only reachable now that the event task no longer blocks through a
        // clip: a second /play can arrive while the previous one is still
        // draining. There is one s_play session and play_begin() opens the
        // codec, so re-entering it would corrupt playback state. mcp-core paces
        // chunks off the ack, so this should not happen in the normal flow —
        // hence a loud log and an explicit non-200 rather than silence.
        if (s_completing) {
            ESP_LOGW(TAG, "/play arrived while the previous clip was still finishing — dropping it");
            ws_ack(s_req_id, 503);
            s_state = WS_SKIP;
            return;
        }
        memset(&s_opts, 0, sizeof(s_opts));
        if (!head_get(s_head, "X-Reply-Text", s_opts.reply_txt, sizeof(s_opts.reply_txt))) {
            s_opts.reply_txt[0] = 0;
        }
        s_opts.quiet       = head_get(s_head, "X-Quiet", v, sizeof(v))       && v[0] == '1';
        s_opts.final       = head_get(s_head, "X-Final", v, sizeof(v))       && v[0] == '1';
        s_opts.auto_listen = head_get(s_head, "X-Auto-Listen", v, sizeof(v)) && v[0] == '1';

        // The 44-byte WAV header is guaranteed present: we only get here once
        // the staging buffer holds the header block plus 44 bytes.
        s_body_expected = total_body - 44;
        play_begin(&s_play, (const uint8_t *)body, s_body_expected, &s_opts);
        s_state = WS_PLAY_STREAM;
        if (body_len > 44) {
            play_feed_nonblocking(&s_play, body + 44, body_len - 44);
            s_body_expected -= (body_len - 44);
        }
        if (s_body_expected == 0) {
            play_complete_async();
            s_state = WS_IDLE;
        }
        return;
    }

    // No body at all — the whole instruction is one header. Dispatched
    // synchronously instead of going through WS_TEXT_BODY, since there's
    // nothing to wait for.
    if (strcmp(s_path, "/session") == 0) {
        char v[4] = "";
        bool occupied = head_get(s_head, "X-Occupied", v, sizeof(v)) && v[0] == '1';
        do_session(occupied);
        ws_ack(s_req_id, 200);
        s_state = WS_IDLE;
        return;
    }

    if (strcmp(s_path, "/caption") == 0 || strcmp(s_path, "/order") == 0) {
        if (strcmp(s_path, "/caption") == 0) {
            strlcpy(s_speaker, "YOU", sizeof(s_speaker));
            head_get(s_head, "X-Speaker", s_speaker, sizeof(s_speaker));
            s_confirm = head_get(s_head, "X-Confirm", v, sizeof(v)) && v[0] == '1';
        }
        s_body_len = 0;
        s_state = WS_TEXT_BODY;
        int take = body_len;
        if (take > WS_BODY_MAX - 1) take = WS_BODY_MAX - 1;
        memcpy(s_body, body, take);
        s_body_len = take;
        return;
    }

    ESP_LOGW(TAG, "unknown path \"%s\" — ignoring", s_path);
    s_state = WS_SKIP;
}

static void finish_text_instruction(void)
{
    s_body[s_body_len] = 0;
    if (strcmp(s_path, "/caption") == 0) {
        do_caption(s_body, s_speaker, s_confirm);
    } else if (strcmp(s_path, "/order") == 0) {
        do_order(s_body);
    }
    ws_ack(s_req_id, 200);
    s_state = WS_IDLE;
}

static void on_data(const esp_websocket_event_data_t *d)
{
    // Text frames from the server aren't used today (the box is the only side
    // that sends text, as acks) — ignore rather than misparse.
    if (d->op_code == 0x1) return;

    const char *p = d->data_ptr;
    int len = d->data_len;

    if (d->payload_offset == 0) {           // first fragment of a new message
        s_state = WS_HEAD;
        s_head_len = 0;
    }
    if (s_state == WS_SKIP) return;

    if (s_state == WS_HEAD) {
        int take = len;
        if (s_head_len + take > WS_HEAD_MAX - 1) take = WS_HEAD_MAX - 1 - s_head_len;
        memcpy(s_head + s_head_len, p, take);
        s_head_len += take;
        s_head[s_head_len] = 0;

        char *sep = strstr(s_head, "\n\n");
        if (!sep) {
            if (s_head_len >= WS_HEAD_MAX - 1) { ESP_LOGW(TAG, "header block too long"); s_state = WS_SKIP; }
            return;                          // need more fragments
        }
        *sep = 0;                            // terminate the header block
        int head_bytes = (int)(sep - s_head) + 2;
        const char *body = s_head + head_bytes;
        int have_body = s_head_len - head_bytes;
        uint32_t total_body = d->payload_len - head_bytes;

        // For /play, wait until 44 body bytes are staged before starting.
        if (strncmp(s_head, "/play", 5) == 0 && have_body < 44 && total_body >= 44) {
            *sep = '\n';                     // undo, keep collecting
            return;
        }
        begin_instruction(body, have_body, total_body);

        // BUG FIX: the copy into s_head above is capped at WS_HEAD_MAX, but the
        // incoming fragment can be much larger (up to the 4096-byte WS buffer)
        // when it's the first chunk of an audio message — the header is only
        // ~150-250 bytes of that, the rest is real PCM. Anything past the cap
        // was never copied anywhere and was being silently dropped: exactly the
        // "glitch near the start of every greeting" bug. `p[take..len)` is the
        // tail of THIS fragment that s_head's clamp cut off — feed it into
        // whatever state begin_instruction() just transitioned to.
        if (take < len) {
            const char *rest = p + take;
            int leftover = len - take;
            if (s_state == WS_PLAY_STREAM) {
                uint32_t take2 = (uint32_t)leftover;
                if (take2 > s_body_expected) take2 = s_body_expected;
                play_feed_nonblocking(&s_play, rest, take2);
                s_body_expected -= take2;
                if (s_body_expected == 0) {
                    play_complete_async();
                    s_state = WS_IDLE;
                }
            } else if (s_state == WS_TEXT_BODY) {
                int take2 = leftover;
                if (s_body_len + take2 > WS_BODY_MAX - 1) take2 = WS_BODY_MAX - 1 - s_body_len;
                memcpy(s_body + s_body_len, rest, take2);
                s_body_len += take2;
            }
        }
        // Whole message already delivered in this fragment?
        if (s_state == WS_TEXT_BODY && d->payload_offset + d->data_len >= d->payload_len) {
            finish_text_instruction();
        }
        return;
    }

    if (s_state == WS_PLAY_STREAM) {
        uint32_t take = (uint32_t)len;
        if (take > s_body_expected) take = s_body_expected;
        play_feed_nonblocking(&s_play, p, take);
        s_body_expected -= take;
        if (s_body_expected == 0) {
            play_complete_async();
            s_state = WS_IDLE;
        }
        return;
    }

    if (s_state == WS_TEXT_BODY) {
        int take = len;
        if (s_body_len + take > WS_BODY_MAX - 1) take = WS_BODY_MAX - 1 - s_body_len;
        memcpy(s_body + s_body_len, p, take);
        s_body_len += take;
        if (d->payload_offset + d->data_len >= d->payload_len) finish_text_instruction();
    }
}

static void ws_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    const esp_websocket_event_data_t *d = (const esp_websocket_event_data_t *)data;
    switch (id) {
    case WEBSOCKET_EVENT_CONNECTED:
        // Heap is logged here because a wss:// session's TLS buffers are the
        // biggest single consumer of internal SRAM on this box, and the last
        // time that ran dry it was diagnosed from sdkconfig rather than a
        // reading. Now there is a reading.
        ESP_LOGI(TAG, "reverse channel connected — server can now reach this box "
                      "from anywhere (internal heap free: %u B)",
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
        break;
    case WEBSOCKET_EVENT_DISCONNECTED:
        ESP_LOGW(TAG, "reverse channel disconnected (auto-reconnecting)");
        s_state = WS_IDLE;
        // Resetting the parser is not enough: a clip already handed to
        // play_begin() has an open codec and a task waiting for bytes that will
        // never arrive now. Left alone it holds the speaker open and buzzes.
        play_abort(&s_play);
        break;
    case WEBSOCKET_EVENT_DATA:
        if (d->data_len > 0) on_data(d);
        break;
    case WEBSOCKET_EVENT_ERROR:
        ESP_LOGW(TAG, "reverse channel error");
        play_abort(&s_play);   // same reasoning as DISCONNECTED
        break;
    default: break;
    }
}

// Application-level keepalive, as a TEXT frame rather than a WebSocket ping.
//
// Tailscale Funnel appears not to relay WS control frames (MEASURED — it is why
// ws-hub.js counts any inbound frame as proof-of-life instead of just a pong),
// so the client's own ping_interval_sec pings can vanish in the proxy and a
// perfectly healthy box looks dead. Text frames demonstrably survive the trip:
// that is how acks get back. The server needs no change — it marks the socket
// alive on every message, and its ACK regex simply won't match this.
#define WS_KEEPALIVE_MS 15000
static TaskHandle_t s_keepalive = NULL;

static void ws_keepalive_task(void *arg)
{
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(WS_KEEPALIVE_MS));
        if (s_client && esp_websocket_client_is_connected(s_client)) {
            // Sent off the event task on purpose; the client serialises sends
            // internally, and this must keep firing even while a clip plays.
            esp_websocket_client_send_text(s_client, "PING", 4, pdMS_TO_TICKS(2000));
        }
    }
}

bool ws_client_start(const char *url, const char *box_id, const char *fleet_token)
{
    if (!url || !url[0]) { ESP_LOGI(TAG, "no reverse-channel URL configured — LAN push only"); return false; }
    if (s_client) { esp_websocket_client_destroy(s_client); s_client = NULL; }

    // Identity + secret ride the HTTP upgrade, so the socket is authenticated
    // once at connect instead of on every frame.
    char headers[160];
    snprintf(headers, sizeof(headers), "X-Box-Id: %s\r\nX-Fleet-Token: %s\r\n",
             box_id ? box_id : "", fleet_token ? fleet_token : "");

    esp_websocket_client_config_t cfg = {
        .uri = url,
        .headers = headers,
        .buffer_size = 4096,
        // The library owns reconnect + backoff. Deliberately not hand-rolled:
        // its state machine is tested, and a retry loop written here would be
        // one more thing to get subtly wrong.
        .reconnect_timeout_ms = 5000,
        .network_timeout_ms = 10000,
        // Server-side heartbeat already reaps dead sockets; this is the other
        // half, so the box notices a silently-dead link instead of sitting on it.
        .ping_interval_sec = 20,
        // Trust the standard CA bundle for wss:// (Tailscale Funnel serves a
        // real Let's Encrypt cert). Harmless for plain ws://.
        .crt_bundle_attach = esp_crt_bundle_attach,
    };

    s_client = esp_websocket_client_init(&cfg);
    if (!s_client) { ESP_LOGE(TAG, "init failed"); return false; }
    esp_websocket_register_events(s_client, WEBSOCKET_EVENT_ANY, ws_event, NULL);
    if (esp_websocket_client_start(s_client) != ESP_OK) {
        ESP_LOGE(TAG, "start failed for %s", url);
        return false;
    }
    // One task for the life of the process — ws_client_start() can be called
    // again to repoint the box, and that must not stack keepalive tasks.
    if (!s_keepalive) {
        xTaskCreate(ws_keepalive_task, "ws_keepalive", 2560, NULL, 4, &s_keepalive);
    }
    ESP_LOGI(TAG, "reverse channel dialling %s", url);
    return true;
}

bool ws_client_connected(void)
{
    return s_client && esp_websocket_client_is_connected(s_client);
}
