// listen_v2 (wireless) — ESP32-S3-BOX-3 mic recorder that POSTs a WAV to the PC
// over WiFi.
//
// Controls:
//   TOUCH SCREEN       — the primary control. TAP the idle screen to start a
//                        listen turn (up to listen.max_record_seconds, auto-stops on
//                        silence or a tap while recording) and it goes
//                        straight to the backend — no separate confirm/send
//                        step. HOLD the BUSY badge 1.5s to end a session by
//                        hand (staff gesture).
//   BOOT (GPIO0, side) — physical backup. TAP = start a listen turn, same as
//                        touch. HOLD 5s = wipe WiFi creds and re-provision.
//   MUTE (GPIO1, top)  — NOT a firmware trigger. It's the hardware mic-mute:
//                        measured on real hardware it's a TOGGLE that flips the
//                        actual mic on/off each press, so it can't reliably
//                        start a listen turn (muted the mic every other press).
//                        Left as the privacy mute it physically is.
// Recording auto-stops after listen.silence_hold_ms of silence following
// detected speech, or hits listen.max_record_seconds as an absolute safety cap.
// Both are runtime settings pushed by the server, not compile-time constants —
// see box_settings.h.
//
// Mic path fixes (see notes): new I2C master driver (not legacy), DUPLEX I2S so
// the ES7210 gets a stable MCLK, I2S Std Philips mono 16-bit. Console on
// USB-Serial-JTAG. Recording buffers into PSRAM (variable length, unknown
// until stop) then sends in one POST. Playback runs through a small jitter
// buffer to smooth over brief WiFi stalls.

#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include <stdlib.h>   // strtoul, for the settings push's revision header
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "freertos/stream_buffer.h"
#include "freertos/semphr.h"
#include "driver/i2c_master.h"
#include "driver/i2s_std.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_heap_caps.h"
#include "nvs_flash.h"
#include "esp_http_client.h"
#include "esp_http_server.h"
#include "esp_codec_dev.h"
#include "esp_codec_dev_defaults.h"
#include "display.h"
#include "provisioning.h"
#include "box_actions.h"
#include "box_settings.h"
#include "ws_client.h"
#include "esp_timer.h"
#include "mdns.h"
#include "touch.h"
#include "sensor.h"
#include "ota.h"

// WiFi credentials and the PC endpoint are NO LONGER compiled in (the old
// wifi_config.h path put a real password in source once — never again). They
// live in NVS, written by the phone-based provisioning portal. A box with no
// saved credentials boots straight into provisioning mode (QR on screen).

// Caption-vs-READY race guard: STT on the Mac is fast enough (~0.7s) that the
// "YOU: ..." caption arrives while the post-upload SENT screen is still up, and
// the main loop's READY write 1.2s later was wiping it after a blink. The main
// loop only draws READY if no caption has arrived since the last upload.
// FreeRTOS ticks (not esp_timer) — 10ms resolution is plenty for this.
static volatile TickType_t s_caption_at_tick = 0;
static volatile TickType_t s_upload_done_tick = 0;

// A recording now goes straight to the backend the moment it ends (VAD
// silence, a manual tap, or the listen.max_record_seconds cap) — there is no
// separate tap-to-confirm step any more. Mishearings are corrected
// conversationally through the agent instead of gated by a screen tap.

// ---- Session lifecycle -----------------------------------------------------
// A "session" is one customer. It starts when the presence radar first sees
// someone (greet ONCE) or when they simply start ordering by touch/BOOT (no
// greeting — they're already talking to us). It ends when the radar has seen
// nobody for session.absent_ms, which resets the conversation server-side so
// the next customer is greeted fresh and never inherits the previous order.
//
// This replaces a bare 20s greet cooldown, which only approximated a session:
// it re-greeted a customer who lingered past the timer, and never reset the
// conversation when one walked away.
//
// How long with NO sign of the customer before we call the session over.
//
// MEASURED: this radar reports motion, not static presence — someone standing
// still reads as "absent" for 10s+ at a time. At 12s that ended sessions while
// the customer was still standing there, and their next small movement started
// a fresh session and re-greeted them (4 greetings in 70s). So the timer is
// longer AND, more importantly, it is fed by interaction as well as radar:
// a customer who is tapping, talking or confirming is obviously present.
//
// Now a runtime setting (session.absent_ms) rather than a constant — the right
// number depends on where the box is standing and what the radar can see from
// there, which is not something a firmware release can know. See box_settings.h.
static volatile bool s_session_active = false;
// Last moment we had ANY evidence of the customer — radar presence or a
// deliberate interaction. Sessions end relative to this, not to radar alone.
static volatile TickType_t s_last_seen_tick = 0;
static inline void note_activity(void) { s_last_seen_tick = xTaskGetTickCount(); }
// Only let "absent" end a session once the radar has actually reported presence
// at least once. A box with no sensor dock reads permanently absent, and must
// not have touch-started sessions killed out from under it.
static volatile bool s_radar_seen = false;

// Provisioned identity + endpoints, loaded from NVS in app_main. All the
// /health and /register URLs are derived from s_post_url so the
// portal form stays the single place addresses are entered.
static char s_box_id[33];         // immutable, MAC-derived — X-Box-Id on every request
static char s_box_name[33];       // human display label from the portal form
static char s_post_url[81];       // http://<mac>:<port>/upload
static char s_health_url[112];
static char s_register_url[112];
static char s_wake_url[112];
static char s_session_end_url[112];
static char s_session_start_url[112];
static char s_order_action_url[112];
// Shared secret with our server. Empty = not yet adopted, in which case the box
// accepts unauthenticated requests so it can be bootstrapped (see
// prov_load_fleet_token). Once set, every inbound request must carry it and
// every outbound request sends it.
static char s_fleet_token[65] = "";
// Reverse-channel URL. Empty = LAN push only (the original behavior).
static char s_ws_url[120] = "";


// ---- BOX-3 wiring ----
#define I2C_PORT        I2C_NUM_0
#define PIN_I2C_SDA     8
#define PIN_I2C_SCL     18
#define I2S_PORT        I2S_NUM_0
#define PIN_I2S_MCLK    2
#define PIN_I2S_BCLK    17
#define PIN_I2S_WS      45
#define PIN_I2S_DOUT    15
#define PIN_I2S_DIN     16
// Front-facing MUTE button, repurposed as REC — BOOT (GPIO0) is a recessed
// back-panel button reserved for flashing/download-mode, awkward for normal use.
// Record trigger = BOOT button (GPIO0). NOT the front button (GPIO1): that's
// the hardware mic-MUTE, so holding/pressing it silences the mic we record
// from. BOOT is the only usable physical button for recording.
#define PIN_REC_BTN     0
// MUTE (GPIO1) is used as a WAKE trigger, not a record trigger — measured on
// hardware: holding it drives the mic to exactly zero (a real hardware mute
// line, confirmed independent of firmware — our code never reads GPIO1 and it
// still mutes), but a quick tap-then-release restores real mic input almost
// immediately. So a fast tap is safe: it notifies the Mac, which plays a
// greeting; the box only starts LISTENING after that tap is already released,
// well clear of the mute window. Never treat this as a hold-to-talk button.
#define PIN_MUTE_BTN    1

// ---- Recording params ----
// The wire format is fixed by what the STT model expects, so these stay
// compiled in. The TUNING that sits on top of them — gain, thresholds, how long
// a turn may run — moved to box_settings.h, because those are properties of the
// room the box is standing in, not of the audio pipeline.
#define SAMPLE_RATE     16000
#define BITS_PER_SAMPLE 16
#define CHANNELS        1
#define VAD_CHUNK_MS           32   // 1024 bytes @ 16kHz/16-bit mono ≈ 32ms

// The recording buffer is allocated once, at this ceiling, and
// listen.max_record_seconds shortens turns within it. Sizing the buffer from a
// runtime setting instead would mean a reallocation — of ~640KB of PSRAM — in
// the middle of a conversation, on a box whose memory is already the tightest
// resource it has.
#define MAX_RECORD_BYTES  ((uint32_t)SAMPLE_RATE * BOX_MAX_RECORD_SECONDS_CEIL * (BITS_PER_SAMPLE/8) * CHANNELS)

static const char *TAG = "listen_v2";

// Identity + shared secret on every outbound request. The token is omitted
// while un-adopted, so a fresh box can still reach a server that has fleet auth
// turned off — that's the bootstrap path, and it's why rollout order doesn't
// matter. One helper so a new call site can't silently forget the header.
static void set_box_headers(esp_http_client_handle_t client)
{
    esp_http_client_set_header(client, "X-Box-Id", s_box_id);
    if (s_fleet_token[0]) esp_http_client_set_header(client, "X-Fleet-Token", s_fleet_token);
}

// Is this inbound request from our own server?
//
// With no token stored the box is un-adopted and accepts anything — that's the
// bootstrap window on your own LAN, and it's also what makes lockout
// impossible. Once adopted, every request must carry the secret; without this,
// anyone on the same WiFi can repoint the microphone upload URL (POST /server)
// or force a recording (POST /play with X-Auto-Listen) with a single curl.
static bool fleet_authed(httpd_req_t *req)
{
    if (s_fleet_token[0] == '\0') return true;   // not adopted yet
    char got[sizeof(s_fleet_token)] = "";
    if (httpd_req_get_hdr_value_str(req, "X-Fleet-Token", got, sizeof(got)) != ESP_OK) return false;
    return strcmp(got, s_fleet_token) == 0;
}

// 401 + a reason, so a legitimate operator hitting this by hand knows why.
static esp_err_t fleet_deny(httpd_req_t *req)
{
    ESP_LOGW(TAG, "rejected unauthenticated request to %s", req->uri);
    httpd_resp_set_status(req, "401 Unauthorized");
    httpd_resp_sendstr(req, "missing or wrong X-Fleet-Token");
    return ESP_FAIL;
}
static esp_codec_dev_handle_t s_mic = NULL;   // ES7210 input
static esp_codec_dev_handle_t s_spk = NULL;   // ES8311 output
static i2c_master_bus_handle_t s_i2c_bus = NULL;
static i2s_chan_handle_t s_i2s_tx = NULL;
static EventGroupHandle_t s_wifi_events;
#define WIFI_CONNECTED_BIT BIT0
#define WIFI_GIVEUP_BIT    BIT1   // set after retry budget exhausted — no more auto-reconnects
static char s_ip_str[16] = "";
#define WIFI_MAX_RETRIES   5
static int s_disconn_retries = 0;
static esp_netif_t *s_sta_netif = NULL;

// Exposed to display.c so it can probe the touch chip to pick the panel type.
i2c_master_bus_handle_t bsp_i2c_bus(void) { return s_i2c_bus; }

// How long the BUSY badge must be held to end a session by hand. Long enough
// that a customer brushing the corner cannot trigger it, short enough that a
// waiter clearing a table does not think it is broken. Tunable at runtime as
// screen.badge_hold_ms.

// Watch a finger already resting on the badge. Returns true only if it stays
// down for the full hold. Blocking on purpose — it lasts at most a second or
// two, mirrors how the 5s BOOT hold is timed, and nothing else in the idle loop
// is urgent.
static bool badge_hold_completed(void)
{
    const TickType_t start = xTaskGetTickCount();
    // Read once: a push landing mid-hold must not move the finish line under a
    // finger that is already down.
    const int32_t hold_ms = box_settings()->badge_hold_ms;
    bool acked = false;
    while ((int32_t)(xTaskGetTickCount() - start) < pdMS_TO_TICKS(hold_ms)) {
        if (!touch_is_pressed()) return false;      // released early: just a tap
        // Confirm the hold registered at the halfway mark, so a waiter is not
        // holding a screen that gives no sign of listening. Drawn once, not per
        // poll — repainting at 20Hz would flicker.
        if (!acked && (int32_t)(xTaskGetTickCount() - start) >= pdMS_TO_TICKS(hold_ms / 2)) {
            acked = true;
            display_badge("HOLD", COL_WARN);
        }
        vTaskDelay(pdMS_TO_TICKS(50));
    }
    return true;
}

// Customer-facing idle screen. Touch anywhere (or tap BOOT) starts a turn.
//
// The badge reports whether the box still considers a customer present. This is
// the one screen where it earns its place: a box mid-session looks IDENTICAL to
// a free one here, yet behaves differently — an occupied box deliberately will
// NOT greet the next person who walks up, because re-greeting someone mid-order
// is the bug this session model exists to prevent. Without the badge, "the
// greeting stopped working" and "it is doing exactly what it should" are
// indistinguishable from the front of the counter.
static void show_ready(void)
{
    display_status("ORDER", "TAP TO START", COL_ACCENT);
    display_badge(s_session_active ? "BUSY" : "FREE",
                  s_session_active ? COL_INFO : COL_OK);
}

// --------------------------------------------------------------------------
// Hardware init (I2C + duplex I2S + ES7210)
// --------------------------------------------------------------------------
static void i2c_init(void)
{
    i2c_master_bus_config_t bus_cfg = {
        .i2c_port = I2C_PORT,
        .sda_io_num = PIN_I2C_SDA,
        .scl_io_num = PIN_I2C_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    ESP_ERROR_CHECK(i2c_new_master_bus(&bus_cfg, &s_i2c_bus));
}

static i2s_chan_handle_t i2s_init(void)
{
    i2s_chan_handle_t tx = NULL, rx = NULL;
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_PORT, I2S_ROLE_MASTER);
    chan_cfg.auto_clear = true;
    ESP_ERROR_CHECK(i2s_new_channel(&chan_cfg, &tx, &rx));

    i2s_std_config_t std_cfg = {
        .clk_cfg  = I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT,
                                                        I2S_SLOT_MODE_MONO),
        .gpio_cfg = {
            .mclk = PIN_I2S_MCLK, .bclk = PIN_I2S_BCLK, .ws = PIN_I2S_WS,
            .dout = PIN_I2S_DOUT, .din = PIN_I2S_DIN,
            .invert_flags = { false, false, false },
        },
    };
    ESP_ERROR_CHECK(i2s_channel_init_std_mode(tx, &std_cfg));
    ESP_ERROR_CHECK(i2s_channel_init_std_mode(rx, &std_cfg));
    ESP_ERROR_CHECK(i2s_channel_enable(tx));
    ESP_ERROR_CHECK(i2s_channel_enable(rx));
    s_i2s_tx = tx;   // kept for the speaker (ES8311)
    return rx;
}

static void mic_init(i2s_chan_handle_t rx)
{
    audio_codec_i2s_cfg_t i2s_cfg = { .port = I2S_PORT, .rx_handle = rx };
    const audio_codec_data_if_t *data_if = audio_codec_new_i2s_data(&i2s_cfg);
    assert(data_if);
    audio_codec_i2c_cfg_t i2c_cfg = { .port = I2C_PORT, .addr = ES7210_CODEC_DEFAULT_ADDR,
                                      .bus_handle = s_i2c_bus };
    const audio_codec_ctrl_if_t *ctrl_if = audio_codec_new_i2c_ctrl(&i2c_cfg);
    assert(ctrl_if);
    es7210_codec_cfg_t es_cfg = { .ctrl_if = ctrl_if };
    const audio_codec_if_t *es7210 = es7210_codec_new(&es_cfg);
    assert(es7210);
    esp_codec_dev_cfg_t dev_cfg = {
        .dev_type = ESP_CODEC_DEV_TYPE_IN, .codec_if = es7210, .data_if = data_if,
    };
    s_mic = esp_codec_dev_new(&dev_cfg);
    assert(s_mic);   // opened per-recording (see record_and_post)
}

// ES8311 speaker (output). Shares the same I2S bus (tx handle). Opened per-play.
static void speaker_init(void)
{
    audio_codec_i2s_cfg_t i2s_cfg = { .port = I2S_PORT, .tx_handle = s_i2s_tx };
    const audio_codec_data_if_t *data_if = audio_codec_new_i2s_data(&i2s_cfg);
    assert(data_if);
    audio_codec_i2c_cfg_t i2c_cfg = { .port = I2C_PORT, .addr = ES8311_CODEC_DEFAULT_ADDR,
                                      .bus_handle = s_i2c_bus };
    const audio_codec_ctrl_if_t *ctrl_if = audio_codec_new_i2c_ctrl(&i2c_cfg);
    assert(ctrl_if);
    const audio_codec_gpio_if_t *gpio_if = audio_codec_new_gpio();
    esp_codec_dev_hw_gain_t gain = { .pa_voltage = 5.0, .codec_dac_voltage = 3.3 };
    es8311_codec_cfg_t es_cfg = {
        .ctrl_if = ctrl_if, .gpio_if = gpio_if,
        .codec_mode = ESP_CODEC_DEV_WORK_MODE_DAC,
        .pa_pin = 46, .use_mclk = true, .hw_gain = gain,
    };
    const audio_codec_if_t *es8311 = es8311_codec_new(&es_cfg);
    assert(es8311);
    esp_codec_dev_cfg_t dev_cfg = {
        .dev_type = ESP_CODEC_DEV_TYPE_OUT, .codec_if = es8311, .data_if = data_if,
    };
    s_spk = esp_codec_dev_new(&dev_cfg);
    assert(s_spk);
}

// --------------------------------------------------------------------------
// WiFi station
// --------------------------------------------------------------------------
static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        // Connect is kicked off by wifi_connect_sta() instead, so the diagnostic
        // scan can finish first (scanning and connecting are mutually exclusive).
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        // Reason codes tell wrong-password apart from SSID-not-found:
        //   201 NO_AP_FOUND = SSID invisible (typo, or network is 5GHz-only —
        //       this chip is 2.4GHz-only); 2/15/204 AUTH_* = bad password.
        wifi_event_sta_disconnected_t *d = (wifi_event_sta_disconnected_t *)data;
        xEventGroupClearBits(s_wifi_events, WIFI_CONNECTED_BIT);
        // Bounded retries with light backoff — the old retry-forever loop is
        // how a box with a bad password sat on "CONNECTING" until reflashed.
        if (s_disconn_retries < WIFI_MAX_RETRIES) {
            s_disconn_retries++;
            ESP_LOGW(TAG, "wifi disconnected (reason %d), retry %d/%d...",
                     d ? d->reason : -1, s_disconn_retries, WIFI_MAX_RETRIES);
            vTaskDelay(pdMS_TO_TICKS(300 * s_disconn_retries));
            esp_wifi_connect();
        } else {
            ESP_LOGW(TAG, "wifi disconnected (reason %d) — retry budget spent, giving up",
                     d ? d->reason : -1);
            xEventGroupSetBits(s_wifi_events, WIFI_GIVEUP_BIT);
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = (ip_event_got_ip_t *)data;
        snprintf(s_ip_str, sizeof(s_ip_str), IPSTR, IP2STR(&e->ip_info.ip));
        ESP_LOGI(TAG, "connected, got IP %s", s_ip_str);
        // Override the DHCP-supplied DNS server with a public one. Some
        // routers (seen MEASURED on a mesh network) NXDOMAIN anything that
        // looks like a VPN/tunnel hostname — including the Tailscale Funnel
        // address the reverse channel dials — while a public resolver answers
        // the same query fine. This fires on every IP acquisition, including a
        // DHCP renewal, so a router that reasserts its own DNS gets overridden
        // again rather than just once at boot.
        esp_netif_dns_info_t dns = { .ip.type = ESP_IPADDR_TYPE_V4 };
        dns.ip.u_addr.ip4.addr = esp_ip4addr_aton("1.1.1.1");
        esp_netif_set_dns_info(s_sta_netif, ESP_NETIF_DNS_MAIN, &dns);
        dns.ip.u_addr.ip4.addr = esp_ip4addr_aton("1.0.0.1");
        esp_netif_set_dns_info(s_sta_netif, ESP_NETIF_DNS_BACKUP, &dns);
        s_disconn_retries = 0;   // a fresh drop later gets a fresh retry budget
        xEventGroupSetBits(s_wifi_events, WIFI_CONNECTED_BIT);
    }
}

// One-shot diagnostic: log every AP the chip can actually SEE. A reason-201
// ("no AP found") means the target SSID never appeared in this list — compare
// it against what a phone sees to tell a typo apart from a network the chip
// cannot reach (5GHz-only, or a channel outside the configured country range).
static void wifi_scan_log(void)
{
    wifi_scan_config_t sc = { .show_hidden = true };
    esp_err_t err = esp_wifi_scan_start(&sc, true);   // true = block until done
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "scan failed: %s", esp_err_to_name(err));
        return;
    }
    uint16_t n = 0;
    esp_wifi_scan_get_ap_num(&n);
    if (n == 0) {
        ESP_LOGW(TAG, "scan: NO APs visible at all — antenna/RF problem, not a config problem");
        return;
    }
    if (n > 24) n = 24;
    wifi_ap_record_t *recs = calloc(n, sizeof(wifi_ap_record_t));
    if (!recs) return;
    esp_wifi_scan_get_ap_records(&n, recs);
    ESP_LOGI(TAG, "scan: %u AP(s) visible to the box:", n);
    for (int i = 0; i < n; i++) {
        ESP_LOGI(TAG, "   \"%s\"  ch%-2d  %d dBm", (char *)recs[i].ssid,
                 recs[i].primary, recs[i].rssi);
    }
    free(recs);
}

// Fallback target for the help QR, used until a server pushes a real one (see
// prov_save_help_url). Kept here rather than in config so a box that has NEVER
// reached a server — the case where someone most needs the guide — still shows
// something scannable.
//
// NOTE: replace this with the guide's public URL once it's hosted. A link that
// demands a login is worse than no QR, because the person scanning it has
// already been told it would help.
#define DEFAULT_HELP_URL "https://claude.ai/code/artifact/3bde646b-0200-4437-9a17-b180b3a215bf"

// "Tap RST twice" -> put the setup guide on screen as a QR. Dismissed by a tap
// or by the timeout, then boot continues exactly as it would have; nothing here
// changes state, so triggering it by accident costs a few seconds and nothing
// else.
static void show_help_qr_if_double_reset(void)
{
    if (!prov_double_reset()) return;

    char url[256];
    if (!prov_load_help_url(url, sizeof(url)) || url[0] == '\0') {
        strlcpy(url, DEFAULT_HELP_URL, sizeof(url));
    }

    if (!prov_show_url_qr(url, "SCAN FOR HELP", "SETUP GUIDE")) {
        // Encoding failed (empty or over-long URL) — say so plainly instead of
        // leaving whatever was on screen and looking like a freeze.
        display_status("NO HELP LINK", "SET HELP URL", COL_WARN);
        vTaskDelay(pdMS_TO_TICKS(4000));
        return;
    }
    ESP_LOGI(TAG, "help QR on screen (%s) — tap to dismiss", url);

    // Runtime setting (screen.help_max_ms), read once so the countdown a person
    // is watching cannot be changed out from under them mid-scan.
    TickType_t start = xTaskGetTickCount();
    const int32_t help_max_ms = box_settings()->help_max_ms;
    int x, y;
    while ((xTaskGetTickCount() - start) < pdMS_TO_TICKS(help_max_ms)) {
        if (touch_get_tap(&x, &y)) break;
        // BOOT is pulled up, so LOW = pressed. Reading it directly keeps this
        // working on a box whose touch panel wasn't detected.
        if (gpio_get_level(PIN_REC_BTN) == 0) break;
        vTaskDelay(pdMS_TO_TICKS(50));
    }
    ESP_LOGI(TAG, "help screen dismissed — continuing boot");
}

// One-time WiFi stack bring-up: netif, event loop, driver, handlers, country.
// Split from connecting so provisioning mode (SoftAP, no credentials) can use
// the same initialized stack.
static void wifi_stack_init(void)
{
    s_wifi_events = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    s_sta_netif = esp_netif_create_default_wifi_sta();
    // Also needed for provisioning mode's SoftAP (APSTA): without this netif,
    // there's no DHCP server on the AP side — a phone can complete the WPA2
    // handshake and "join" the hotspot, but never gets an IP, so it can never
    // reach the portal or trigger a captive-portal popup at all. Created once
    // here (not in provisioning.c, which can re-enter portal_up() repeatedly).
    esp_netif_create_default_wifi_ap();
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event, NULL));

    // Malaysia allows 2.4GHz channels 1-13, but the ESP-IDF default country
    // ("01" world-safe, AUTO policy) only SCANS channels 1-11 — so an AP on
    // ch12/13 is invisible and reports reason 201, which looks exactly like a
    // wrong SSID. Mesh routers auto-pick their channel and move over time,
    // which is how a network that used to work stops being found without
    // anything being retyped.
    // "MY" is NOT in esp_wifi's country table (see esp_wifi.h: 01/AT/AU/../US),
    // so world-safe "01" is used with an explicit MANUAL 1-13 range instead.
    // Soft-fail on purpose: a rejected country code must never abort the boot.
    wifi_country_t country = {
        .cc = "01", .schan = 1, .nchan = 13, .policy = WIFI_COUNTRY_POLICY_MANUAL
    };
    esp_err_t cerr = esp_wifi_set_country(&country);
    if (cerr != ESP_OK) {
        ESP_LOGW(TAG, "set_country failed: %s — scan may be limited to ch1-11",
                 esp_err_to_name(cerr));
    }
}

// Connect to an AP with NVS-provisioned credentials. Returns false instead of
// blocking forever: the old portMAX_DELAY wait is how a box with a bad network
// name sat on "CONNECTING" until someone attached a serial cable.
static bool wifi_connect_sta(const char *ssid, const char *pass)
{
    wifi_config_t wc = { .sta = {
        // A mesh has several nodes sharing one SSID: scan every channel and
        // take the strongest, instead of grabbing the first (possibly distant)
        // node that answers.
        .scan_method = WIFI_ALL_CHANNEL_SCAN,
        .sort_method = WIFI_CONNECT_AP_BY_SIGNAL,
    } };
    strlcpy((char *)wc.sta.ssid, ssid, sizeof(wc.sta.ssid));
    strlcpy((char *)wc.sta.password, pass, sizeof(wc.sta.password));
    s_disconn_retries = 0;
    xEventGroupClearBits(s_wifi_events, WIFI_CONNECTED_BIT | WIFI_GIVEUP_BIT);
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
    ESP_ERROR_CHECK(esp_wifi_start());

    wifi_scan_log();   // from this task, not the event loop — blocking is fine here

    ESP_LOGI(TAG, "connecting to WiFi \"%s\"...", ssid);
    esp_wifi_connect();
    // 20s covers association + WPA2 handshake + DHCP (1-8s worst case) plus a
    // few retries — long enough to be reliable, short enough that a stuck box
    // visibly falls into provisioning mode instead of hanging.
    EventBits_t bits = xEventGroupWaitBits(s_wifi_events,
        WIFI_CONNECTED_BIT | WIFI_GIVEUP_BIT, pdFALSE, pdFALSE, pdMS_TO_TICKS(20000));
    return (bits & WIFI_CONNECTED_BIT) != 0;
}

// Resolves a "<name>.local" host inside a URL to its numeric IP via mDNS, so
// the provisioning form's "computer address" field can be a fixed, memorable
// hostname (mcp-core.local) instead of requiring someone to look up a raw LAN
// IP in Terminal/network settings. `out` receives the URL with the hostname
// portion replaced by the resolved IP; on any failure (not a .local host, or
// resolution times out) `out` is just a copy of `url` unchanged — the
// subsequent reachability check/backoff already treats "can't reach this URL"
// as the signal to fall back into provisioning, so no special-casing is
// needed here for the failure path.
static void resolve_mdns_host(const char *url, char *out, size_t out_len)
{
    strlcpy(out, url, out_len);
    const char *proto_end = strstr(url, "://");
    if (!proto_end) return;
    const char *host_start = proto_end + 3;
    const char *host_end = host_start;
    while (*host_end && *host_end != ':' && *host_end != '/') host_end++;
    size_t host_len = host_end - host_start;
    if (host_len < 7 || strncmp(host_end - 6, ".local", 6) != 0) return;   // not an mDNS host

    char hostname[64];
    size_t name_len = host_len - 6;   // strip the ".local" suffix mdns_query_a expects bare
    if (name_len == 0 || name_len >= sizeof(hostname)) return;
    memcpy(hostname, host_start, name_len);
    hostname[name_len] = '\0';

    esp_ip4_addr_t addr;
    esp_err_t err = mdns_query_a(hostname, 3000, &addr);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "mDNS resolve of \"%s.local\" failed: %s", hostname, esp_err_to_name(err));
        return;   // out already holds the unresolved url
    }
    char ip_str[16];
    snprintf(ip_str, sizeof(ip_str), IPSTR, IP2STR(&addr));
    ESP_LOGI(TAG, "mDNS: %s.local -> %s", hostname, ip_str);

    int proto_len = (int)(host_start - url);   // includes "://"
    snprintf(out, out_len, "%.*s%s%s", proto_len, url, ip_str, host_end);
}

// After WiFi is up: poll mcp-core's /health before declaring READY. WiFi-OK +
// server-unreachable is NOT a provisioning problem most of the time — it's
// "the Mac hasn't started mcp-core yet". So retry patiently (backoff, 5 min)
// on the connection we already have; only a full window of failures falls
// back to re-provisioning (that's a genuinely wrong post_url).
// Sleep in short slices while watching for a 5s BOOT hold. Returns true if the
// hold completed — the caller should wipe creds and reboot.
//
// This exists because the escape hatch used to be dead exactly when it was
// needed: the button was only configured and polled in the main loop, which is
// reached AFTER wait_server_reachable() succeeds. A box that couldn't find its
// server (Mac moved networks, stale post_url) sat in the retry loop ignoring
// the button entirely, with no way to re-provision short of waiting out the
// full 5-minute timeout.
static bool sleep_watching_for_wifi_reset(int seconds)
{
    const TickType_t slice = pdMS_TO_TICKS(50);
    TickType_t held = 0;
    for (int elapsed = 0; elapsed < seconds * 20; elapsed++) {
        if (gpio_get_level(PIN_REC_BTN) == 0) {
            held += slice;
            if (held >= pdMS_TO_TICKS(5000)) {
                display_status("RESET WIFI", "RELEASE NOW", COL_ERR);
                while (gpio_get_level(PIN_REC_BTN) == 0) vTaskDelay(pdMS_TO_TICKS(20));
                return true;
            }
        } else {
            held = 0;
        }
        vTaskDelay(slice);
    }
    return false;
}

static bool wait_server_reachable(void)
{
    int64_t deadline = esp_timer_get_time() + 5LL * 60 * 1000000;
    int delay_s = 2;
    bool shown = false;
    while (esp_timer_get_time() < deadline) {
        esp_http_client_config_t cfg = { .url = s_health_url, .timeout_ms = 5000 };
        esp_http_client_handle_t client = esp_http_client_init(&cfg);
        esp_err_t err = esp_http_client_perform(client);
        int status = (err == ESP_OK) ? esp_http_client_get_status_code(client) : -1;
        esp_http_client_cleanup(client);
        if (status == 200) return true;
        if (!shown) {
            // Show the box's OWN ip: it's reachable now (the HTTP server is up
            // before this wait), so this is the address to POST /server to.
            display_status("NO SERVER", s_ip_str, COL_WARN);
            shown = true;
        }
        ESP_LOGW(TAG, "server not reachable at %s (%d) — retrying in %ds "
                      "(hold BOOT 5s to re-provision)", s_health_url, status, delay_s);
        if (sleep_watching_for_wifi_reset(delay_s)) {
            prov_erase_creds();
            display_status("WIFI RESET", "REBOOTING", COL_ERR);
            vTaskDelay(pdMS_TO_TICKS(800));
            esp_restart();
        }
        if (delay_s < 30) delay_s *= 2;
    }
    return false;
}

// Best-effort boot announcement so mcp-core's config.json learns/refreshes this
// box's IP without manual editing. Failure is non-fatal: per-request X-Box-Id
// self-healing covers the same ground on the server side.
static void register_with_core(void)
{
    // fw/slot/sha say which image is really running. Registration is the right
    // place for them: it happens on every boot, including the boot that follows
    // a rollback — which is the one where the reported build silently stops
    // matching the build that was pushed.
    //
    // settings_rev rides along for the same reason: this is the first thing the
    // box says after a reboot, so it is the earliest possible moment the server
    // can notice that a box came back holding tuning older than the current
    // revision — and re-push it before the first customer of the day.
    char body[352];
    int len = snprintf(body, sizeof(body),
                       "{\"box_id\":\"%s\",\"name\":\"%s\",\"ip\":\"%s\","
                       "\"fw\":\"%s\",\"fw_sha\":\"%s\",\"slot\":\"%s\",\"pending_verify\":%s,"
                       "\"settings_rev\":%u}",
                       s_box_id, s_box_name[0] ? s_box_name : s_box_id, s_ip_str,
                       ota_running_version(), ota_running_sha(), ota_running_slot(),
                       ota_pending_verify() ? "true" : "false",
                       (unsigned)box_settings_revision());
    esp_http_client_config_t cfg = { .url = s_register_url,
                                     .method = HTTP_METHOD_POST, .timeout_ms = 5000 };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    esp_http_client_set_header(client, "Content-Type", "application/json");
    set_box_headers(client);
    esp_http_client_set_post_field(client, body, len);
    esp_err_t err = esp_http_client_perform(client);
    int status = (err == ESP_OK) ? esp_http_client_get_status_code(client) : -1;
    esp_http_client_cleanup(client);
    ESP_LOGI(TAG, "register -> %s (%d)", s_register_url, status);
}

// --------------------------------------------------------------------------
// Build 44-byte WAV header
// --------------------------------------------------------------------------
static void build_wav_header(uint8_t h[44], uint32_t data_bytes)
{
    uint32_t byte_rate = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8);
    uint16_t block_align = CHANNELS * (BITS_PER_SAMPLE / 8);
    memcpy(h, "RIFF", 4);
    uint32_t riff = 36 + data_bytes;
    h[4]=riff; h[5]=riff>>8; h[6]=riff>>16; h[7]=riff>>24;
    memcpy(h + 8, "WAVEfmt ", 8);
    h[16]=16; h[17]=0; h[18]=0; h[19]=0; h[20]=1; h[21]=0;
    h[22]=CHANNELS; h[23]=0;
    h[24]=SAMPLE_RATE; h[25]=SAMPLE_RATE>>8; h[26]=SAMPLE_RATE>>16; h[27]=SAMPLE_RATE>>24;
    h[28]=byte_rate; h[29]=byte_rate>>8; h[30]=byte_rate>>16; h[31]=byte_rate>>24;
    h[32]=block_align; h[33]=block_align>>8; h[34]=BITS_PER_SAMPLE; h[35]=0;
    memcpy(h + 36, "data", 4);
    h[40]=data_bytes; h[41]=data_bytes>>8; h[42]=data_bytes>>16; h[43]=data_bytes>>24;
}

// --------------------------------------------------------------------------
// Press-to-start / press-to-stop recording. Buffered into PSRAM (variable
// length, unknown until stop) then sent in one POST once we know the size.
// --------------------------------------------------------------------------
static uint8_t *s_record_buf = NULL;
static uint32_t s_record_len = 0;

// Tap-to-toggle recording, done as ONE tight blocking read loop (reads chunks
// back-to-back — that's what keeps the ES7210/I2S RX fed and non-silent; the
// earlier "one chunk per main-loop iteration with a vTaskDelay" structure
// returned all zeros). The caller has already consumed the START tap; this
// records until the NEXT tap (a fresh button press) or the max length.
static void record_toggle_and_send(const char *rec_line2)
{
    s_record_buf = heap_caps_malloc(MAX_RECORD_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s_record_buf) {
        ESP_LOGE(TAG, "recording buffer alloc FAILED (%u bytes)", (unsigned)MAX_RECORD_BYTES);
        display_status("MEM", "ERROR", COL_ERR);
        vTaskDelay(pdMS_TO_TICKS(1200));
        show_ready();
        return;
    }
    s_record_len = 0;

    esp_codec_dev_sample_info_t mic_fs = {
        .bits_per_sample = BITS_PER_SAMPLE, .channel = CHANNELS, .sample_rate = SAMPLE_RATE,
    };
    ESP_ERROR_CHECK(esp_codec_dev_open(s_mic, &mic_fs));

    // Snapshotted for this turn. A settings push landing mid-recording must not
    // move the auto-stop threshold while someone is halfway through a sentence
    // — the customer would experience it as the box behaving differently within
    // one breath, which is the least debuggable kind of bug there is. The new
    // values take effect on the next turn, milliseconds later.
    const box_settings_t set = *box_settings();
    esp_codec_dev_set_in_gain(s_mic, set.mic_gain_db);
    // The runtime cap, which may be shorter than the buffer we allocated but
    // can never be longer (box_settings clamps it to the ceiling).
    const uint32_t max_bytes =
        (uint32_t)SAMPLE_RATE * (uint32_t)set.max_record_seconds * (BITS_PER_SAMPLE / 8) * CHANNELS;
    ESP_LOGI(TAG, ">>> recording (auto-stops after %dms silence below peak %d, or tap REC, max %ds) <<<",
            (int)set.silence_hold_ms, (int)set.silence_peak, (int)set.max_record_seconds);
    display_status("REC", rec_line2, COL_REC);

    const uint32_t chunk = 1024;
    uint8_t tmp[1024];
    uint32_t call_ctr = 0;
    int pressed_streak = 0;    // consecutive reads seeing the button LOW (a new tap)
    int speech_run = 0;        // consecutive loud chunks (confirms real speech, not a click)
    bool speech_started = false;
    uint32_t silence_ms = 0;
    while (s_record_len + chunk <= max_bytes) {
        // Tight, back-to-back read — nothing slow in between.
        if (esp_codec_dev_read(s_mic, tmp, chunk) == 0) {
            memcpy(s_record_buf + s_record_len, tmp, chunk);
            s_record_len += chunk;

            int16_t *sm = (int16_t *)tmp; int peak = 0;
            for (int i = 0; i < (int)(chunk / 2); i++) {
                int v = sm[i]; if (v < 0) v = -v; if (v > peak) peak = v;
            }

            if (peak > set.silence_peak) {
                if (++speech_run >= set.speech_confirm_chunks) speech_started = true;
                silence_ms = 0;
            } else {
                speech_run = 0;
                if (speech_started) silence_ms += VAD_CHUNK_MS;
            }

            if (++call_ctr % 16 == 0) {
                ESP_LOGI(TAG, "chunk#%u peak=%d len=%u speech=%d silence_ms=%u",
                        (unsigned)call_ctr, peak, (unsigned)s_record_len, speech_started, (unsigned)silence_ms);
            }

            if (speech_started && silence_ms >= (uint32_t)set.silence_hold_ms) {
                ESP_LOGI(TAG, "auto-stop: %ums silence after speech", (unsigned)silence_ms);
                break;
            }
        }
        // Manual stop via BOOT tap: ~2 consecutive LOW reads (~64ms) is a real
        // press, not contact bounce.
        if (gpio_get_level(PIN_REC_BTN) == 0) {
            if (++pressed_streak >= 2) { ESP_LOGI(TAG, "manual stop (tap)"); break; }
        } else {
            pressed_streak = 0;
        }
        // Manual stop via SCREEN tap — the reliable "I'm done" in noisy rooms
        // where VAD lags. Polled every ~4 chunks (~128ms) so the touch I2C
        // read doesn't slow the tight mic loop and starve the DMA.
        if (call_ctr % 4 == 0) {
            int _tx, _ty;
            if (touch_get_tap(&_tx, &_ty)) { ESP_LOGI(TAG, "manual stop (touch)"); break; }
        }
    }

    esp_codec_dev_close(s_mic);
    display_status("SENDING", NULL, COL_INFO);

    uint32_t data_bytes = s_record_len;
    uint32_t total_len = 44 + data_bytes;

    esp_http_client_config_t cfg = { .url = s_post_url, .method = HTTP_METHOD_POST, .timeout_ms = 15000 };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    esp_http_client_set_header(client, "Content-Type", "audio/wav");
    // The box declares its own identity — the server must never have to guess
    // it from a source IP that DHCP can reassign tomorrow.
    set_box_headers(client);

    int status = -1;
    if (esp_http_client_open(client, total_len) != ESP_OK) {
        ESP_LOGE(TAG, "HTTP connect failed — is server.py running on the PC?");
    } else {
        uint8_t header[44];
        build_wav_header(header, data_bytes);
        esp_http_client_write(client, (char *)header, 44);
        esp_http_client_write(client, (char *)s_record_buf, data_bytes);
        esp_http_client_fetch_headers(client);
        status = esp_http_client_get_status_code(client);
        ESP_LOGI(TAG, "sent %u bytes (%.1fs), server responded %d",
                (unsigned)(44 + data_bytes), data_bytes / (float)(SAMPLE_RATE * 2), status);
        esp_http_client_close(client);
    }
    esp_http_client_cleanup(client);
    free(s_record_buf);
    s_record_buf = NULL;
    s_record_len = 0;

    s_upload_done_tick = xTaskGetTickCount();
    if (status == 200) display_status("SENT", NULL, COL_OK);
    else if (status < 0) display_status("NO PC", "START SERVER", COL_ERR);
    else display_status("SEND", "FAILED", COL_ERR);
    vTaskDelay(pdMS_TO_TICKS(1200));
}

typedef struct {
    const char *rec_line2;
    SemaphoreHandle_t done;
} auto_listen_args_t;

static void auto_listen_task(void *arg)
{
    auto_listen_args_t *a = (auto_listen_args_t *)arg;
    record_toggle_and_send(a->rec_line2);
    xSemaphoreGive(a->done);
    vTaskDelete(NULL);
}

// record_toggle_and_send() runs fine on the ~3.5KB main-task stack when
// called directly (the normal BOOT-tap path) — but calling it INLINE from
// inside play_handler overflows the httpd worker's 8KB stack anyway: it's
// httpd's own internal frames + play_handler's locals + the recording call
// chain (I2S/codec + a NESTED esp_http_client POST for /upload) all stacked
// on top of each other. Confirmed on hardware (reproduced twice, identical
// crash both times). Fix: run it in a fresh dedicated task instead — the
// same pattern this file already uses for playback_task, for the same
// reason. Blocks the caller via semaphore so play_handler's behavior
// (respond, then act) is otherwise unchanged.
static void run_auto_listen(const char *rec_line2)
{
    auto_listen_args_t args = { .rec_line2 = rec_line2, .done = xSemaphoreCreateBinary() };
    xTaskCreate(auto_listen_task, "auto_listen", 8192, &args, 5, NULL);
    xSemaphoreTake(args.done, portMAX_DELAY);
    vSemaphoreDelete(args.done);
}

// Start a turn immediately — record until silence, upload, straight to the
// backend. NO greeting: tapping to order goes straight to listening (a
// greeting-on-approach can come later from a presence sensor).
// Runs on the main-task stack (called from the main loop, not an httpd
// handler), so record_toggle_and_send() needs no trampoline task.
static void report_session_start(void);   // defined below, near end_session_on_server

static void start_listening(void)
{
    // Ordering by touch/BOOT starts a session too — without a greeting, since
    // they're already talking to us. This is also what keeps a box with NO
    // sensor dock working: sessions still begin, they just never auto-end.
    // Report it (only on the actual transition) so occupied-status queries
    // stay accurate no matter which trigger started the session — presence
    // starts already report as a side effect of asking for the greeting
    // (/wake), but a silent start has no other server call to piggyback on.
    if (!s_session_active) report_session_start();
    s_session_active = true;
    note_activity();
    record_toggle_and_send("TAP WHEN DONE");
    if ((int32_t)(s_caption_at_tick - s_upload_done_tick) <= 0) {
        show_ready();
    }
}

// --------------------------------------------------------------------------
// TALK: PC POSTs a WAV to http://<box-ip>/play -> box plays it on the speaker.
// The WAV's own header sets the sample rate/channels, so any 16-bit PCM WAV works.
//
// Playback runs through a small jitter buffer (ring buffer + separate task)
// instead of writing straight from the network socket to the codec: a brief
// WiFi stall used to directly stall the I2S write and cause an audible gap.
// Now the playback task drains a ring buffer that the network-receive loop
// keeps topped up, so short stalls get absorbed instead of heard.
// --------------------------------------------------------------------------
// Sized so a whole sentence chunk fits WITHOUT the feeder ever having to wait.
// That matters far beyond jitter absorption: on the WebSocket transport the
// feeder IS the single event task servicing the socket (ws_client.c), so any
// blocking in play_feed() stops the box reading the socket, stops its keepalive
// and stops its acks — which is what a proxied/relayed link (Tailscale Funnel)
// reaps as a dead connection. See ROADMAP item 9.
//
// In PSRAM, not internal SRAM: 512KB would never fit internally, and the 64KB
// internal ring this replaces is exactly what ran the internal heap dry against
// a live TLS session and crashed the box once already.
#define PLAYBACK_RINGBUF_BYTES   (512 * 1024)  // ~11.6s of audio at 22050/16/mono
#define PLAYBACK_PREBUFFER_BYTES (16 * 1024)   // ~0.36s prebuffer before starting

// How long play_feed() will wait for ring space before giving up on the bytes it
// was handed. Only reachable if a clip outruns the ring above; dropping audio
// (a momentary glitch) beats starving the socket until the far end kills it.
#define PLAY_FEED_WAIT_MS        250
#define PLAY_FEED_GIVEUP_MS      2000

// playback_task_args_t / play_opts_t / play_session_t now live in box_actions.h
// so the WebSocket transport can drive the same playback path.

static void playback_task(void *arg)
{
    playback_task_args_t *a = (playback_task_args_t *)arg;
    uint8_t buf[2048];
    uint32_t written = 0;
    uint32_t prebuffer = PLAYBACK_PREBUFFER_BYTES < a->total_bytes ? PLAYBACK_PREBUFFER_BYTES : a->total_bytes;

    while (!a->abort_now && xStreamBufferBytesAvailable(a->ring) < prebuffer && written < a->total_bytes) {
        vTaskDelay(pdMS_TO_TICKS(5));
    }
    while (!a->abort_now && written < a->total_bytes) {
        size_t want = sizeof(buf);
        if (a->total_bytes - written < want) want = a->total_bytes - written;
        size_t got = xStreamBufferReceive(a->ring, buf, want, pdMS_TO_TICKS(3000));
        if (got == 0) break;   // stream stalled for 3s straight — give up
        esp_codec_dev_write(s_spk, buf, got);
        written += got;
    }
    xSemaphoreGive(a->done);
    vTaskDelete(NULL);
}

// Playback is split into begin/feed/finish so it can be driven by EITHER
// transport without either one buffering the whole clip:
//   - HTTP: httpd_req_recv() loop feeds it (unchanged behavior)
//   - WebSocket: message fragments feed it as they arrive (ws_client.c)
// Keeping it streaming on both paths is the point — buffering a whole 170KB
// chunk before starting would add audible latency to every reply.
void play_begin(play_session_t *ps, const uint8_t h[44], uint32_t body_len,
                const play_opts_t *opts)
{
    uint32_t rate = h[24] | (h[25]<<8) | (h[26]<<16) | ((uint32_t)h[27]<<24);
    uint16_t ch   = h[22] | (h[23]<<8);
    uint16_t bits = h[34] | (h[35]<<8);
    bool is_wav = (memcmp(h, "RIFF", 4) == 0);
    if (!is_wav || rate < 8000 || rate > 48000) { rate = 16000; ch = 1; bits = 16; }
    if (ch < 1 || ch > 2) ch = 1;
    if (bits != 16) bits = 16;
    // Internal-SRAM reading, not a guess from sdkconfig: the crash this box hit
    // once (TLS buffers vs the playback ring) was root-caused by reasoning about
    // config instead of measuring, and nothing in the firmware read the heap.
    ESP_LOGI(TAG, "playing: %u Hz, %u ch, %u-bit (internal heap free: %u B)",
             (unsigned)rate, ch, bits,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));

    ps->opts = *opts;
    if (opts->reply_txt[0]) {
        display_caption("BOX", COL_OK, opts->reply_txt);
    } else if (!opts->quiet) {
        display_status("PLAYING", NULL, COL_OK);
    }

    esp_codec_dev_sample_info_t fs = { .bits_per_sample = bits, .channel = ch, .sample_rate = rate };
    esp_codec_dev_open(s_spk, &fs);
    esp_codec_dev_set_out_vol(s_spk, 85);

    ps->args.ring = xStreamBufferCreateWithCaps(PLAYBACK_RINGBUF_BYTES, 1,
                                                MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    ps->args.done = xSemaphoreCreateBinary();
    ps->args.waits = 0;
    // Under real memory pressure (e.g. a live TLS session competing for the
    // same internal-RAM pool) either allocation can come back NULL. Every
    // FreeRTOS call below trusts a non-null handle without checking — feeding
    // one a NULL handle doesn't fail softly, it hits an internal assert and
    // reboots the box. A skipped clip beats that.
    if (!ps->args.ring || !ps->args.done) {
        ESP_LOGE(TAG, "playback alloc failed (ring=%p done=%p) — dropping this clip",
                  ps->args.ring, ps->args.done);
        if (ps->args.ring) { vStreamBufferDeleteWithCaps(ps->args.ring); ps->args.ring = NULL; }
        if (ps->args.done) { vSemaphoreDelete(ps->args.done); ps->args.done = NULL; }
        esp_codec_dev_close(s_spk);
        ps->active = false;
        return;
    }
    ps->args.total_bytes = body_len;
    ps->args.abort_now = false;
    ps->active = true;
    xTaskCreate(playback_task, "playback", 4096, &ps->args, 5, NULL);
}

void play_feed(play_session_t *ps, const void *data, size_t len)
{
    if (!ps->active) return;   // play_begin() couldn't start this clip — nowhere to put these bytes
    const uint8_t *p = (const uint8_t *)data;
    size_t sent = 0;
    while (sent < len) {
        sent += xStreamBufferSend(ps->args.ring, p + sent, len - sent, portMAX_DELAY);
    }
}

// play_feed() for callers that must not block: the WebSocket event task is the
// only thing servicing the socket, so a long wait here silently kills the
// channel rather than just delaying audio (ROADMAP item 9). Waits in short
// slices, counts them so we can tell whether the ring is actually big enough,
// and drops the remainder rather than starving the transport indefinitely.
void play_feed_nonblocking(play_session_t *ps, const void *data, size_t len)
{
    if (!ps->active) return;
    const uint8_t *p = (const uint8_t *)data;
    size_t sent = 0;
    int waited_ms = 0;
    while (sent < len) {
        size_t n = xStreamBufferSend(ps->args.ring, p + sent, len - sent,
                                     pdMS_TO_TICKS(PLAY_FEED_WAIT_MS));
        sent += n;
        if (sent >= len) break;
        // Ring full: the clip is outrunning PLAYBACK_RINGBUF_BYTES. Worth
        // knowing about — it means the sizing assumption no longer holds.
        ps->args.waits++;
        waited_ms += PLAY_FEED_WAIT_MS;
        if (waited_ms >= PLAY_FEED_GIVEUP_MS) {
            ESP_LOGW(TAG, "play_feed gave up after %dms with %u bytes unwritten — "
                          "dropping them to keep the socket alive",
                     waited_ms, (unsigned)(len - sent));
            return;
        }
    }
}

// Blocks until the audio has actually finished coming out of the speaker.
void play_finish_audio(play_session_t *ps)
{
    if (!ps->active) return;   // already finished or aborted
    xSemaphoreTake(ps->args.done, portMAX_DELAY);
    vSemaphoreDelete(ps->args.done);
    vStreamBufferDeleteWithCaps(ps->args.ring);
    esp_codec_dev_close(s_spk);
    ps->active = false;
    if (!ps->args.abort_now) {
        // waits>0 means a feeder had to wait on ring space. On the WebSocket
        // path that is the failure mode from ROADMAP item 9 starting to
        // reappear, so it is surfaced rather than absorbed silently.
        if (ps->args.waits) {
            ESP_LOGW(TAG, "playback done — feeder waited on ring space %u times "
                          "(clip outran the %uKB ring)",
                     (unsigned)ps->args.waits, PLAYBACK_RINGBUF_BYTES / 1024);
        } else {
            ESP_LOGI(TAG, "playback done");
        }
    }
    ps->end_tick = xTaskGetTickCount();
}

// Same teardown as play_finish_audio(), but tells the playback task to stop
// first. The distinction matters: the normal path waits for every promised byte
// to reach the speaker, whereas here those bytes are never coming, so waiting
// would just stall the caller for the full starvation timeout.
void play_abort(play_session_t *ps)
{
    if (!ps->active) return;
    ESP_LOGW(TAG, "playback aborted — transport dropped mid-clip");
    ps->args.abort_now = true;
    play_finish_audio(ps);
}

// Screen/auto-listen policy, run AFTER the transport has acknowledged, so the
// 3.5s caption linger never delays the server's next turn.
void play_after(play_session_t *ps)
{
    if (ps->opts.quiet && !ps->opts.final) return;

    if (ps->opts.auto_listen) {
        // Greeting just finished — go straight into a listen turn, no button
        // needed. Same recording+upload path BOOT uses, so everything
        // downstream (STT, backend, order) is completely unchanged.
        run_auto_listen("LISTENING...");
        if ((int32_t)(s_caption_at_tick - s_upload_done_tick) <= 0) show_ready();
        return;
    }

    if (ps->opts.reply_txt[0] || ps->opts.final) vTaskDelay(pdMS_TO_TICKS(3500));
    if ((int32_t)(s_caption_at_tick - ps->end_tick) <= 0) show_ready();
}

static esp_err_t play_handler(httpd_req_t *req)
{
    if (!fleet_authed(req)) return fleet_deny(req);
    uint8_t h[44];
    int got = 0;
    while (got < 44) {
        int r = httpd_req_recv(req, (char *)h + got, 44 - got);
        if (r <= 0) { httpd_resp_send_500(req); return ESP_FAIL; }
        got += r;
    }

    // Display policy per chunk-protocol headers:
    //   X-Reply-Text (legacy /respond path): show reply caption, linger after.
    //   X-Quiet: sentence chunk of a pipelined reply — the BOX caption is
    //            already on screen via /caption, so touch nothing.
    //   X-Final: last chunk — after playback, linger the caption then READY.
    //   none of the above (talk.sh etc.): old PLAYING/READY behavior.
    play_opts_t opts = { 0 };
    if (httpd_req_get_hdr_value_str(req, "X-Reply-Text", opts.reply_txt,
                                    sizeof(opts.reply_txt)) != ESP_OK) {
        opts.reply_txt[0] = 0;
    }
    char hdr[4] = "";
    opts.quiet = (httpd_req_get_hdr_value_str(req, "X-Quiet", hdr, sizeof(hdr)) == ESP_OK)
                 && hdr[0] == '1';
    hdr[0] = 0;
    opts.final = (httpd_req_get_hdr_value_str(req, "X-Final", hdr, sizeof(hdr)) == ESP_OK)
                 && hdr[0] == '1';
    hdr[0] = 0;
    opts.auto_listen = (httpd_req_get_hdr_value_str(req, "X-Auto-Listen", hdr, sizeof(hdr)) == ESP_OK)
                       && hdr[0] == '1';

    play_session_t ps;
    uint32_t remaining = req->content_len - 44;
    play_begin(&ps, h, remaining, &opts);

    char buf[4096];
    while (remaining > 0) {
        int want = remaining < sizeof(buf) ? remaining : sizeof(buf);
        int r = httpd_req_recv(req, buf, want);
        if (r <= 0) break;
        play_feed(&ps, buf, r);
        remaining -= r;
    }
    play_finish_audio(&ps);

    // Answer first, THEN linger — see play_after().
    httpd_resp_sendstr(req, "played");
    play_after(&ps);
    return ESP_OK;
}

// Show a live caption. Body = the text; optional "X-Speaker" header ("YOU"/"BOX")
// picks the bar label + color (defaults to YOU / amber). Used by the Mac to push
// "what was heard" the moment STT finishes, before the reply audio arrives.
void do_caption(const char *text, const char *who)
{
    uint16_t bar = (strcmp(who, "BOX") == 0) ? COL_OK   // green
                                             : COL_ACCENT; // amber
    s_caption_at_tick = xTaskGetTickCount();
    display_caption(who, bar, text);
}

static esp_err_t caption_handler(httpd_req_t *req)
{
    if (!fleet_authed(req)) return fleet_deny(req);
    int len = req->content_len;
    if (len < 0) len = 0;
    if (len > 255) len = 255;
    char text[256];
    int got = 0;
    while (got < len) {
        int r = httpd_req_recv(req, text + got, len - got);
        if (r <= 0) break;
        got += r;
    }
    text[got] = 0;

    char who[16] = "YOU";
    httpd_req_get_hdr_value_str(req, "X-Speaker", who, sizeof(who));

    do_caption(text, who);
    httpd_resp_sendstr(req, "ok");
    return ESP_OK;
}

// Greet on approach: ask the Mac to speak its (pre-cached) greeting. Fired by
// the presence radar when someone walks up. Greeting ONLY — it does not start
// listening, because the customer orders by tapping the screen, which records
// immediately. The audio arrives back as a normal /play POST.
static void trigger_wake(void)
{
    esp_http_client_config_t cfg = { .url = s_wake_url, .method = HTTP_METHOD_POST,
                                     .timeout_ms = 5000 };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    set_box_headers(client);
    esp_http_client_set_post_field(client, "1", 1);
    esp_err_t err = esp_http_client_perform(client);
    int status = (err == ESP_OK) ? esp_http_client_get_status_code(client) : -1;
    esp_http_client_cleanup(client);
    ESP_LOGI(TAG, "greet -> %s (%d)", s_wake_url, status);
    // The greeting audio arrives as a /play POST. The screen keeps showing
    // "TAP TO ORDER" throughout — a failed greeting shouldn't scare a customer
    // with an error, they can still just tap and order.
}

// The customer left: tell the server to drop this box's conversation and any
// half-finished order, so the next person starts clean instead of inheriting
// someone else's session. Best-effort — if the server is unreachable the box
// still resets its own state, and the server's own pending-transcript window
// expires on its own shortly after.
static void end_session_on_server(void)
{
    esp_http_client_config_t cfg = { .url = s_session_end_url, .method = HTTP_METHOD_POST,
                                     .timeout_ms = 5000 };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    set_box_headers(client);
    esp_http_client_set_post_field(client, "1", 1);
    esp_err_t err = esp_http_client_perform(client);
    int status = (err == ESP_OK) ? esp_http_client_get_status_code(client) : -1;
    esp_http_client_cleanup(client);
    ESP_LOGI(TAG, "session-end -> %s (%d)", s_session_end_url, status);
}

// Touch/BOOT-started sessions skip the greeting on purpose (the customer is
// already engaging — a "hi" would be redundant), so unlike a presence start
// there's no /wake call for the server to piggyback occupied-status on. This
// is that missing signal, so esp_list_boxes/health stay accurate regardless
// of which trigger began the session.
static void report_session_start(void)
{
    esp_http_client_config_t cfg = { .url = s_session_start_url, .method = HTTP_METHOD_POST,
                                     .timeout_ms = 5000 };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    set_box_headers(client);
    esp_http_client_set_post_field(client, "1", 1);
    esp_err_t err = esp_http_client_perform(client);
    int status = (err == ESP_OK) ? esp_http_client_get_status_code(client) : -1;
    esp_http_client_cleanup(client);
    ESP_LOGI(TAG, "session-start -> %s (%d)", s_session_start_url, status);
}

// Server-initiated override — lets an operator/agent mark a box occupied or
// free without waiting for the radar (useful for testing), or clear a session
// the radar failed to end on its own (a stuck-occupied box). Deliberately
// mirrors the two NATURAL paths rather than inventing a third behavior:
// forcing occupied=true plays the same one-time greeting a real presence
// detection would; forcing occupied=false does the same cleanup a real
// departure does. No echo back to the server in either direction — the
// server already knows, since it's the one that just asked for this.
void do_session(bool occupied)
{
    if (occupied) {
        if (!s_session_active) {
            s_session_active = true;
            note_activity();
            ESP_LOGI(TAG, "session start (manual override) — greeting once");
            trigger_wake();
        }
    } else if (s_session_active) {
        s_session_active = false;
        ESP_LOGI(TAG, "session end (manual override)");
        show_ready();
    }
}

// The customer pressed one of the order-screen buttons. The server owns what
// happens next (finalizing the order, showing the payment prompt) and pushes
// the resulting screen back — the box just reports the press.
static void post_order_action(const char *action)
{
    esp_http_client_config_t cfg = { .url = s_order_action_url, .method = HTTP_METHOD_POST,
                                     .timeout_ms = 8000 };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    set_box_headers(client);
    esp_http_client_set_post_field(client, action, strlen(action));
    esp_err_t err = esp_http_client_perform(client);
    int status = (err == ESP_OK) ? esp_http_client_get_status_code(client) : -1;
    esp_http_client_cleanup(client);
    ESP_LOGI(TAG, "order-action \"%s\" -> %s (%d)", action, s_order_action_url, status);
    if (status != 200) {
        // Includes 409 (server has no open order for us — e.g. it restarted
        // mid-session). Say so rather than leaving a dead-looking screen.
        display_status("NOT NOW", "TAP TO ORDER", COL_ERR);
    }
}

// Render an itemized order. Body is a line protocol (built by the Mac so the
// firmware needs no JSON parsing):
//   TITLE|YOUR ORDER
//   ITEM|2X NASI LEMAK|RM11.00     (up to 5 ITEM lines)
//   TOTAL|RM15.50
//   NOTE|POINT YOUR PAYMENT QR AT THE CAMERA   (optional; replaces the items)
//   ACTIONS|ADD ORDER|END + PAY               (optional; draws the button bar)
void do_order(char *body)
{
    const char *title = "YOUR ORDER";
    const char *note = NULL, *btn_l = NULL, *btn_r = NULL;
    static char total[20];
    order_line_t lines[5];
    int count = 0;
    total[0] = 0;

    char *save = NULL;
    for (char *ln = strtok_r(body, "\n", &save); ln; ln = strtok_r(NULL, "\n", &save)) {
        char *p1 = strchr(ln, '|');
        if (!p1) continue;
        *p1++ = 0;
        if (strcmp(ln, "TITLE") == 0) {
            title = p1;
        } else if (strcmp(ln, "ITEM") == 0 && count < 5) {
            char *p2 = strchr(p1, '|');
            if (!p2) continue;
            *p2++ = 0;
            lines[count].name = p1;
            lines[count].price = p2;
            count++;
        } else if (strcmp(ln, "TOTAL") == 0) {
            strlcpy(total, p1, sizeof(total));
        } else if (strcmp(ln, "NOTE") == 0) {
            note = p1;
        } else if (strcmp(ln, "ACTIONS") == 0) {
            // ACTIONS|<left>|<right> — both labels required, since one button
            // alone would leave half the bar hit-testable but unpainted.
            char *p2 = strchr(p1, '|');
            if (p2) { *p2++ = 0; btn_l = p1; btn_r = p2; }
        }
    }

    s_caption_at_tick = xTaskGetTickCount();   // order owns the screen now
    order_screen_t scr = { .title = title, .lines = lines, .count = count,
                           .total = total[0] ? total : NULL, .note = note,
                           .btn_left = btn_l, .btn_right = btn_r };
    display_order(&scr);
    ESP_LOGI(TAG, "order screen: %d items, total %s%s", count, total,
             btn_l ? " (+buttons)" : "");
}

static esp_err_t order_handler(httpd_req_t *req)
{
    if (!fleet_authed(req)) return fleet_deny(req);
    static char body[512];   // static: keeps httpd task stack small
    int len = req->content_len;
    if (len < 0) len = 0;
    if (len > (int)sizeof(body) - 1) len = sizeof(body) - 1;
    int got = 0;
    while (got < len) {
        int r = httpd_req_recv(req, body + got, len - got);
        if (r <= 0) break;
        got += r;
    }
    body[got] = 0;

    do_order(body);
    httpd_resp_sendstr(req, "ok");
    return ESP_OK;
}

// Runtime settings push: newline-separated "key|value" lines, the server's
// dotted key names verbatim. Same shape as /order, and for the same reason —
// this firmware links no JSON parser, and adding one to carry eight integers
// would cost internal SRAM the TLS buffers already need.
//
// Answers with the revision it now holds, so the server learns whether the push
// landed from the response rather than from a follow-up poll.
static esp_err_t settings_handler(httpd_req_t *req)
{
    if (!fleet_authed(req)) return fleet_deny(req);
    static char body[512];   // static: keeps httpd task stack small
    int len = req->content_len;
    if (len < 0) len = 0;
    if (len > (int)sizeof(body) - 1) len = sizeof(body) - 1;
    int got = 0;
    while (got < len) {
        int r = httpd_req_recv(req, body + got, len - got);
        if (r <= 0) break;
        got += r;
    }
    body[got] = 0;

    char rev[16] = "0";
    httpd_req_get_hdr_value_str(req, "X-Settings-Rev", rev, sizeof(rev));
    int changed = box_settings_apply(body, (uint32_t)strtoul(rev, NULL, 10));

    char reply[64];
    snprintf(reply, sizeof(reply), "ok rev=%u changed=%d",
             (unsigned)box_settings_revision(), changed);
    httpd_resp_sendstr(req, reply);
    return ESP_OK;
}

// /health, /register and /wake all live next to /upload on the same
// server, so they're derived from post_url (which carries the real host AND
// port). Re-run whenever post_url changes so a repointed box updates every URL
// at once instead of leaving stale ones behind.
// snprintf truncates silently, which would leave a plausible-looking but wrong
// URL (e.g. ".../session-en") that fails in a way nobody would trace back to
// here. Check every one and say so loudly.
static void derive_one_url(char *dst, size_t cap, const char *suffix, int base_len)
{
    int n = snprintf(dst, cap, "%.*s%s", base_len, s_post_url, suffix);
    if (n < 0 || (size_t)n >= cap) {
        ESP_LOGE(TAG, "server URL too long, truncated: %s%s (max %u) — shorten the server address",
                 suffix, "", (unsigned)cap);
    }
}

static void derive_server_urls(void)
{
    const char *slash = strrchr(s_post_url, '/');
    int base_len = slash ? (int)(slash - s_post_url) : (int)strlen(s_post_url);
    derive_one_url(s_health_url,      sizeof(s_health_url),      "/health",      base_len);
    derive_one_url(s_register_url,    sizeof(s_register_url),    "/register",    base_len);
    derive_one_url(s_wake_url,        sizeof(s_wake_url),        "/wake",        base_len);
    derive_one_url(s_session_end_url, sizeof(s_session_end_url), "/session-end", base_len);
    derive_one_url(s_session_start_url, sizeof(s_session_start_url), "/session-start", base_len);
    derive_one_url(s_order_action_url, sizeof(s_order_action_url), "/order-action", base_len);
}

// Repoint this box at a different server, live, over the network:
//   curl -X POST http://<box-ip>/server --data "http://10.0.0.5:8000/upload"
// Persisted to NVS, so it survives reboots. This is the answer to "the server
// machine moved / changed IP and mDNS is blocked here" — previously that meant
// a full QR re-provision; now it's one request and the retry loop picks it up
// on its next pass (or immediately, if it's already waiting).
static esp_err_t server_handler(httpd_req_t *req)
{
    if (!fleet_authed(req)) return fleet_deny(req);
    char url[sizeof(s_post_url)];
    int len = req->content_len;
    if (len <= 0 || len >= (int)sizeof(url)) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "body must be the new post_url");
        return ESP_FAIL;
    }
    int got = 0;
    while (got < len) {
        int r = httpd_req_recv(req, url + got, len - got);
        if (r <= 0) { httpd_resp_send_500(req); return ESP_FAIL; }
        got += r;
    }
    url[got] = 0;
    while (got > 0 && (url[got - 1] == '\n' || url[got - 1] == '\r' || url[got - 1] == ' ')) url[--got] = 0;

    if (strncmp(url, "http://", 7) != 0 && strncmp(url, "https://", 8) != 0) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "must start with http:// or https://");
        return ESP_FAIL;
    }

    // The adopt push also carries the reverse-channel URL, so a box learns it
    // the same way it learns everything else — no extra provisioning step.
    // Changing it re-dials, which is how a box follows the server to a new
    // address (e.g. LAN ws:// today, public wss:// once a relay is set up).
    {
        char ws[sizeof(s_ws_url)] = "";
        if (httpd_req_get_hdr_value_str(req, "X-Ws-Url", ws, sizeof(ws)) == ESP_OK && ws[0]) {
            if (strcmp(ws, s_ws_url) != 0) {
                strlcpy(s_ws_url, ws, sizeof(s_ws_url));
                prov_save_ws_url(s_ws_url);
                ESP_LOGI(TAG, "reverse-channel URL set to %s", s_ws_url);
                ws_client_start(s_ws_url, s_box_id, s_fleet_token);
            }
        }
    }

    // Same idea for the help QR's target: pushed, not compiled in, so the guide
    // can be rehosted across a whole fleet without touching firmware. Only
    // written when it actually changed — this runs every 60s per box.
    {
        char help[256] = "";
        if (httpd_req_get_hdr_value_str(req, "X-Help-Url", help, sizeof(help)) == ESP_OK && help[0]) {
            char cur[256] = "";
            prov_load_help_url(cur, sizeof(cur));
            if (strcmp(help, cur) != 0) {
                prov_save_help_url(help);
                ESP_LOGI(TAG, "help URL set to %s", help);
            }
        }
    }

    // Trust-on-first-use adoption: an un-adopted box takes the token from the
    // first server that reaches it (on your own LAN, during bring-up) and
    // starts enforcing immediately afterwards. Only ever assigned when empty —
    // an adopted box getting a different token has already been rejected by
    // fleet_authed() above, so this can't be used to steal an adopted box.
    if (s_fleet_token[0] == '\0') {
        char tok[sizeof(s_fleet_token)] = "";
        if (httpd_req_get_hdr_value_str(req, "X-Fleet-Token", tok, sizeof(tok)) == ESP_OK && tok[0]) {
            strlcpy(s_fleet_token, tok, sizeof(s_fleet_token));
            prov_save_fleet_token(s_fleet_token);
            ESP_LOGI(TAG, "adopted fleet token — this box now requires X-Fleet-Token");
        }
    }

    strlcpy(s_post_url, url, sizeof(s_post_url));
    derive_server_urls();
    prov_save_post_url(s_post_url);
    ESP_LOGI(TAG, "server address updated to %s", s_post_url);
    httpd_resp_sendstr(req, "ok");
    return ESP_OK;
}

// Update this box's firmware over the network, instead of over a USB cable:
//   curl -X POST http://<box-ip>/ota --data "http://10.0.0.5:8000/firmware.bin"
// Answers immediately and downloads in the background — the transfer takes far
// longer than a request should be held open, and the box reboots itself when
// it's done. Safe to get wrong: a bad image is rejected before boot, and one
// that boots but can't reach the server reverts on its own (see ota.h).
static esp_err_t ota_handler(httpd_req_t *req)
{
    if (!fleet_authed(req)) return fleet_deny(req);
    char url[256];
    int len = req->content_len;
    if (len <= 0 || len >= (int)sizeof(url)) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "body must be the firmware URL");
        return ESP_FAIL;
    }
    int got = 0;
    while (got < len) {
        int r = httpd_req_recv(req, url + got, len - got);
        if (r <= 0) { httpd_resp_send_500(req); return ESP_FAIL; }
        got += r;
    }
    url[got] = 0;
    while (got > 0 && (url[got - 1] == '\n' || url[got - 1] == '\r' || url[got - 1] == ' ')) url[--got] = 0;

    if (strncmp(url, "http://", 7) != 0 && strncmp(url, "https://", 8) != 0) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "must start with http:// or https://");
        return ESP_FAIL;
    }

    esp_err_t err = ota_start(url, s_fleet_token);
    if (err == ESP_ERR_INVALID_STATE) {
        httpd_resp_set_status(req, "409 Conflict");
        httpd_resp_sendstr(req, "an update is already running");
        return ESP_OK;
    }
    if (err != ESP_OK) {
        httpd_resp_send_500(req);
        return ESP_FAIL;
    }
    ESP_LOGI(TAG, "firmware update requested from %s", url);
    httpd_resp_sendstr(req, "ok — downloading, the box will reboot when done");
    return ESP_OK;
}

static esp_err_t session_handler(httpd_req_t *req)
{
    if (!fleet_authed(req)) return fleet_deny(req);
    char v[4] = "";
    bool occupied = (httpd_req_get_hdr_value_str(req, "X-Occupied", v, sizeof(v)) == ESP_OK)
                    && v[0] == '1';
    do_session(occupied);
    httpd_resp_sendstr(req, "ok");
    return ESP_OK;
}

static void start_http_server(void)
{
    httpd_handle_t server = NULL;
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.stack_size = 8192;
    cfg.recv_wait_timeout = 20;
    cfg.lru_purge_enable = true;
    // The default is 8 and we now register 7. Raised deliberately, because
    // running out here fails in the worst possible way: httpd_register_uri_handler
    // returns ESP_ERR_HTTPD_HANDLERS_FULL, nothing below checks it, and the
    // route simply does not exist — a box that answers every other request
    // perfectly while one feature is silently missing. Each slot is a few bytes.
    cfg.max_uri_handlers = 12;
    if (httpd_start(&server, &cfg) == ESP_OK) {
        httpd_uri_t play = { .uri = "/play", .method = HTTP_POST, .handler = play_handler };
        httpd_register_uri_handler(server, &play);
        httpd_uri_t caption = { .uri = "/caption", .method = HTTP_POST, .handler = caption_handler };
        httpd_register_uri_handler(server, &caption);
        httpd_uri_t order = { .uri = "/order", .method = HTTP_POST, .handler = order_handler };
        httpd_register_uri_handler(server, &order);
        httpd_uri_t srv = { .uri = "/server", .method = HTTP_POST, .handler = server_handler };
        httpd_register_uri_handler(server, &srv);
        httpd_uri_t sess = { .uri = "/session", .method = HTTP_POST, .handler = session_handler };
        httpd_register_uri_handler(server, &sess);
        httpd_uri_t setg = { .uri = "/settings", .method = HTTP_POST, .handler = settings_handler };
        httpd_register_uri_handler(server, &setg);
        httpd_uri_t ota = { .uri = "/ota", .method = HTTP_POST, .handler = ota_handler };
        httpd_register_uri_handler(server, &ota);
        ESP_LOGI(TAG, "TALK server up: POST a WAV to http://%s/play", s_ip_str);
    } else {
        ESP_LOGE(TAG, "failed to start HTTP server");
    }
}

void app_main(void)
{
    // NVS now holds real app state (provisioned credentials), so recover from
    // a full/upgraded partition instead of aborting the boot.
    esp_err_t nerr = nvs_flash_init();
    if (nerr == ESP_ERR_NVS_NO_FREE_PAGES || nerr == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        nerr = nvs_flash_init();
    }
    ESP_ERROR_CHECK(nerr);

    // Immediately after NVS and before ANY of the code that reads a setting.
    // show_help_qr_if_double_reset() below is the first such reader and it runs
    // only a few lines down, so there is no window in which a default is used
    // in place of a value this box has actually been given.
    box_settings_load();

    i2c_init();
    display_init();
    if (!touch_init()) {
        ESP_LOGW(TAG, "touch controller not found — screen is display-only");
    }
    sensor_init();    // sensor-dock presence radar (greet on approach)
    // Button up FIRST, before anything that can block: the 5s hold-to-
    // re-provision is the escape hatch for "box can't find its server", so it
    // has to be alive during the pre-READY phases, not just in the main loop.
    gpio_config_t btn = {
        .pin_bit_mask = 1ULL << PIN_REC_BTN, .mode = GPIO_MODE_INPUT, .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    gpio_config(&btn);
    // Tap RST twice = "I need help". Runs here because the screen, touch and
    // BOOT are all up (so it can be dismissed) but nothing that can block has
    // started yet — meaning the gesture still works on a box that never gets as
    // far as WiFi, which is exactly when someone needs the guide.
    show_help_qr_if_double_reset();
    display_status("STARTING", NULL, COL_ACCENT);
    i2s_chan_handle_t rx = i2s_init();
    mic_init(rx);
    speaker_init();

    // Identity first — box_id exists before the box touches any network, so
    // even a fresh box's provisioning AP is already named after it.
    prov_ensure_box_id(s_box_id, sizeof(s_box_id));
    // Load before the HTTP server comes up, so the box is never briefly open
    // during boot. Absent = un-adopted; the first /server push adopts us.
    prov_load_fleet_token(s_fleet_token, sizeof(s_fleet_token));
    prov_load_ws_url(s_ws_url, sizeof(s_ws_url));
    ESP_LOGI(TAG, "fleet auth: %s", s_fleet_token[0]
             ? "ON (X-Fleet-Token required on all endpoints)"
             : "OFF — un-adopted, accepting unauthenticated requests until a server adopts this box");
    wifi_stack_init();

    char wifi_ssid[33], wifi_pass[64];
    if (!prov_load_creds(wifi_ssid, sizeof(wifi_ssid), wifi_pass, sizeof(wifi_pass),
                         s_post_url, sizeof(s_post_url), s_box_name, sizeof(s_box_name))) {
        ESP_LOGI(TAG, "no saved WiFi credentials — entering provisioning mode");
        start_provisioning_mode();   // never returns
    }

    display_status("WIFI", "CONNECTING", COL_INFO);
    if (!wifi_connect_sta(wifi_ssid, wifi_pass)) {
        // Bad/absent network: only re-provisioning can fix this. The QR screen
        // replaces the old behavior of retrying forever behind "CONNECTING".
        ESP_LOGW(TAG, "could not join \"%s\" — entering provisioning mode", wifi_ssid);
        // If this boot is a just-installed image, prefer the version that was
        // working over a QR screen nobody is standing in front of.
        ota_rollback_if_pending();
        display_status("WIFI FAILED", "OPENING SETUP", COL_ERR);
        vTaskDelay(pdMS_TO_TICKS(1500));
        start_provisioning_mode();   // never returns
    }

    // mDNS lets the provisioning form use a fixed hostname (mcp-core.local)
    // instead of a raw LAN IP nobody but a developer knows how to look up.
    // Resolved once here, in memory only — NVS keeps the hostname, so a
    // changed Mac IP next boot re-resolves instead of going stale like a
    // saved IP would. A non-".local" post_url (someone typed a raw IP) passes
    // through resolve_mdns_host() unchanged, so both forms keep working.
    if (mdns_init() == ESP_OK) {
        mdns_hostname_set(s_box_id);   // makes the box itself discoverable too, for free
        // ...but a hostname is only findable by something that already knows
        // the name to ask for, which for a box nobody has adopted yet is
        // nothing. Advertising a SERVICE makes the box enumerable: mcp-core
        // browses _espbox._tcp and lists whatever answers (discovery.js), so a
        // new box shows up on the setup page by itself instead of having to be
        // hunted down by ARP-scanning the subnet for Espressif MAC prefixes —
        // which cannot see across a subnet and cannot tell you WHICH box it
        // found. The TXT records carry that: identity, not just an address.
        //
        // Port 80 is where start_http_server() below listens, and is what the
        // server dials for /play, /caption, /order and /server.
        mdns_txt_item_t txt[] = {
            { "id",   s_box_id },
            { "name", s_box_name[0] ? s_box_name : s_box_id },
            { "fw",   ota_running_version() },
        };
        esp_err_t merr = mdns_service_add(NULL, "_espbox", "_tcp", 80,
                                          txt, sizeof(txt) / sizeof(txt[0]));
        if (merr != ESP_OK) {
            // Non-fatal by design: discovery is a convenience for setup, and a
            // box that cannot advertise is still fully usable once adopted by
            // address. Logged because otherwise "it never appears on the setup
            // page" has no visible cause.
            ESP_LOGW(TAG, "mDNS service advertise failed: %s", esp_err_to_name(merr));
        } else {
            ESP_LOGI(TAG, "advertising _espbox._tcp as \"%s\"", s_box_id);
        }
    }
    char resolved_post_url[sizeof(s_post_url)];
    resolve_mdns_host(s_post_url, resolved_post_url, sizeof(resolved_post_url));
    strlcpy(s_post_url, resolved_post_url, sizeof(s_post_url));

    derive_server_urls();

    // HTTP server comes up BEFORE the reachability wait, on purpose. If the
    // box can't find its server (mDNS blocked, server machine moved to a new
    // IP), it used to sit here unreachable — the one moment you most need to
    // talk to it. Now it is always addressable on the LAN, so `POST /server`
    // can repoint it live with no QR, no re-provision, no button.
    start_http_server();

    // WiFi is right but the server isn't answering: NOT a provisioning issue
    // most of the time (mcp-core simply not started yet), so this retries for
    // 5 minutes before concluding the post_url itself is wrong.
    if (!wait_server_reachable()) {
        ESP_LOGW(TAG, "server never became reachable — entering provisioning mode");
        ota_rollback_if_pending();   // see the WiFi path above
        display_status("NO SERVER", "OPENING SETUP", COL_ERR);
        vTaskDelay(pdMS_TO_TICKS(1500));
        start_provisioning_mode();   // never returns
    }
    // The box is on WiFi and the server answered (wait_server_reachable above),
    // so if this boot is a freshly installed image it has now demonstrated the
    // one thing OTA can break. Nothing before this point is proof — confirming
    // earlier would keep an image that cannot phone home, which is exactly the
    // un-fixable case.
    //
    // ORDER MATTERS, and it used to be wrong: register_with_core() reports
    // pending_verify, and it ran BEFORE this call. The box therefore always
    // reported "pending" and then confirmed itself a line later, with no second
    // registration to correct the record — so the server's pending_verify read
    // true forever after every OTA and could never distinguish a confirmed image
    // from one still on probation. That flag is the only outward sign of a
    // silent rollback, so a permanently-stuck value defeated the whole check.
    ota_mark_valid();
    register_with_core();
    // Dial the reverse channel once the network is up. Non-blocking and
    // self-reconnecting, so a server that isn't listening yet costs nothing —
    // and a box with no URL stored simply keeps using LAN pushes.
    ws_client_start(s_ws_url, s_box_id, s_fleet_token);

    show_ready();   // blue = ready
    // GPIO1 (top mute button) intentionally not configured/read — see the
    // note in the main loop; it's the hardware mic-mute, not a usable trigger.

    ESP_LOGI(TAG, "ready — TAP SCREEN (or BOOT) to order. BOOT hold 5s = reset WiFi. "
                 "Top button = mic mute only. Sends to %s", s_post_url);

    // Tap-to-toggle: tap BOOT to start, tap again to stop. Each tap is
    // consumed (wait for release) so one physical tap = one state change.
    // The whole recording happens inside record_toggle_and_send() as one
    // tight read loop, which is what keeps the mic DMA fed and non-silent.
    // NOTE: GPIO1 (the top "mute" button) is deliberately NOT read as a
    // trigger. Measured on hardware it's a TOGGLE that also flips the actual
    // hardware mic-mute on every press — so using it to start a turn muted the
    // mic every other press. It stays what it physically is: a privacy mute.
    // Greet-on-approach state (see the presence check at the end of the loop).
    note_activity();   // seed the session timer at boot

    int hb = 0;
    while (1) {
        if (gpio_get_level(PIN_REC_BTN) == 0) {
            note_activity();   // someone is definitely here, whatever radar says
            vTaskDelay(pdMS_TO_TICKS(8));    // settle contact bounce only —
            // do NOT reject here if already released: a fast tap is real, and
            // the old "still held after 30ms?" gate is what made presses need
            // a second try. The press is committed once we're past this point;
            // the loop below just waits for a clean release + times the hold.
            // Consume the START tap: wait for a clean release first so it
            // isn't immediately re-read as the STOP tap. The same wait doubles
            // as long-press detection: holding BOOT >=5s means "reset WiFi and
            // re-provision" — the no-computer way to move a box to a new
            // network. Feedback appears exactly at the threshold so the user
            // knows the hold registered.
            TickType_t press_start = xTaskGetTickCount();
            bool long_press = false;
            int high = 0;
            while (high < 5) {
                high = (gpio_get_level(PIN_REC_BTN) != 0) ? high + 1 : 0;
                if (!long_press && high == 0 &&
                    (xTaskGetTickCount() - press_start) >= pdMS_TO_TICKS(5000)) {
                    long_press = true;
                    display_status("RESET WIFI", "RELEASE NOW", COL_ERR);
                }
                vTaskDelay(pdMS_TO_TICKS(10));
            }
            if (long_press) {
                prov_erase_creds();   // box_id survives; only network creds go
                display_status("WIFI RESET", "REBOOTING", COL_ERR);
                vTaskDelay(pdMS_TO_TICKS(800));
                esp_restart();
            }

            // SIDE (boot) tap: physical backup for the touch-screen trigger
            // below — always starts a fresh listen turn.
            start_listening();
            continue;
        }
        // Touch is the PRIMARY trigger: a tap anywhere on the idle screen
        // starts a turn and goes straight to the backend once the customer
        // stops talking — no separate confirm/send step. (The top/mute
        // button is NOT a trigger — it's the hardware mic-mute and toggles
        // the mic on/off, so it can't reliably start a listen turn; that's
        // why the customer uses the screen or BOOT.)
        int tx, ty;
        if (touch_get_tap(&tx, &ty)) {
            note_activity();   // someone is definitely here, whatever radar says
            // Staff gesture: HOLD the BUSY badge to end the session by hand,
            // for when a customer walks off and the radar has not timed out
            // yet (session.absent_ms defaults to 30s, and it is fed by
            // interaction, so
            // a lingering group can hold a box "busy" far longer).
            //
            // It has to be intercepted HERE, before start_listening(), because
            // a hold begins with an ordinary tap edge — otherwise the box
            // would start recording the instant the finger landed and the
            // hold could never complete.
            //
            // A hold, not a tap: this corner is one mis-aimed customer press
            // away from wiping a session mid-order. Releasing early is not an
            // error, it just falls through to the normal "tap to order".
            if (s_session_active && display_badge_hit(tx, ty)) {
                if (badge_hold_completed()) {
                    s_session_active = false;
                    ESP_LOGI(TAG, "session cleared by staff (badge hold)");
                    end_session_on_server();   // reset the conversation too
                    show_ready();              // repaints the badge as FREE
                    continue;
                }
            }
            // Order-screen buttons. Checked BEFORE start_listening(),
            // because otherwise the tap that presses a button would also be
            // the tap that opens the mic. display_hit_test() only reports
            // these while that screen is actually up, so this cannot fire
            // on the idle screen.
            display_button_t ob = display_hit_test(tx, ty);
            if (ob == BTN_ADD_ORDER) {
                // Deliberately back to idle rather than straight into
                // recording: the customer is often still deciding, and
                // opening the mic on them captures the room, not an order.
                ESP_LOGI(TAG, "ADD ORDER — back to idle");
                show_ready();
                continue;
            }
            if (ob == BTN_END_PAY) {
                ESP_LOGI(TAG, "END + PAY — finalizing with server");
                display_status("FINISHING", "ONE MOMENT", COL_INFO);
                post_order_action("end");   // server pushes the pay screen
                continue;
            }
            start_listening();   // record straight away, no greeting
            continue;
        }

        // ---- Session lifecycle (one session = one customer) ----------------
        // Present + no session  -> start one, greet ONCE.
        // Present + session     -> nothing; the greeting never repeats.
        // Absent for a while    -> end the session, reset the conversation, so
        //                          the next customer is greeted and starts a
        //                          clean order.
        bool present_now = sensor_presence();
        if (present_now) {
            s_radar_seen = true;
            note_activity();               // radar sees them: session stays alive
            if (!s_session_active) {
                s_session_active = true;
                ESP_LOGI(TAG, "session start (presence) — greeting once");
                trigger_wake();
            }
        } else if (s_session_active && s_radar_seen &&
                   (int32_t)(xTaskGetTickCount() - s_last_seen_tick) >=
                       pdMS_TO_TICKS(box_settings()->session_absent_ms)) {
            // No radar presence AND no interaction for the whole window.
            s_session_active = false;
            ESP_LOGI(TAG, "session end (customer left) — resetting conversation");
            end_session_on_server();
            show_ready();
        }

        if (++hb >= 1000) { hb = 0; ESP_LOGI(TAG, "alive, waiting for a button..."); }
        vTaskDelay(pdMS_TO_TICKS(10));   // finer polling = less chance a quick
                                         // tap lands entirely between two reads
    }
}
