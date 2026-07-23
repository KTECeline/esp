// listen_v2 (wireless) — ESP32-S3-BOX-3 mic recorder that POSTs a WAV to the PC
// over WiFi.
//
// Controls:
//   TOUCH SCREEN       — the primary control. TAP the idle screen to start a
//                        turn (greeting, then auto-listen). On the confirm
//                        screen, on-screen SEND / CANCEL buttons send the
//                        transcript to the assistant or clear it and re-listen.
//   BOOT (GPIO0, side) — physical backup. TAP = start a turn (idle) or clear+
//                        re-listen (transcript showing). HOLD 5s = wipe WiFi
//                        creds and re-provision.
//   MUTE (GPIO1, top)  — NOT a firmware trigger. It's the hardware mic-mute:
//                        measured on real hardware it's a TOGGLE that flips the
//                        actual mic on/off each press, so it can't reliably
//                        start a listen turn (muted the mic every other press).
//                        Left as the privacy mute it physically is.
// Recording auto-stops after VAD_SILENCE_HOLD_MS of silence following detected
// speech, or hits MAX_RECORD_SECONDS as an absolute safety cap.
//
// Mic path fixes (see notes): new I2C master driver (not legacy), DUPLEX I2S so
// the ES7210 gets a stable MCLK, I2S Std Philips mono 16-bit. Console on
// USB-Serial-JTAG. Recording buffers into PSRAM (variable length, unknown
// until stop) then sends in one POST. Playback runs through a small jitter
// buffer to smooth over brief WiFi stalls.

#include <stdio.h>
#include <string.h>
#include <stdint.h>
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
#include "esp_timer.h"
#include "mdns.h"
#include "touch.h"
#include "sensor.h"

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

// Confirm-before-LLM: when the Mac pushes the transcript caption with an
// X-Confirm header, the next BOOT tap within this window means "yes, send it"
// (POSTed to the Mac's /confirm) instead of starting a new recording. No tap
// -> cancelled, nothing reaches the LLM. Guards against STT mishearings
// becoming wrong orders.
// 8s proved too tight once the screen had buttons: reading the transcript,
// deciding, and reaching for the screen ate most of it. 15s still sits well
// inside the Mac's 25s pending-transcript window, and CANCEL is now an
// explicit button so waiting out the timer is no longer the only way to bail.
#define CONFIRM_WINDOW_MS 15000
// After greeting someone, don't greet again for this long — the radar drops
// and re-fires as a person shifts around, which would otherwise re-greet the
// same customer mid-order.
#define GREET_COOLDOWN_MS 20000
static volatile bool s_confirm_pending = false;
static volatile TickType_t s_confirm_deadline_tick = 0;

// Provisioned identity + endpoints, loaded from NVS in app_main. All the
// /confirm, /health and /register URLs are derived from s_post_url so the
// portal form stays the single place addresses are entered.
static char s_box_id[33];         // immutable, MAC-derived — X-Box-Id on every request
static char s_box_name[33];       // human display label from the portal form
static char s_post_url[81];       // http://<mac>:<port>/upload
static char s_confirm_url[112];
static char s_health_url[112];
static char s_register_url[112];
static char s_wake_url[112];

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
#define SAMPLE_RATE     16000
#define BITS_PER_SAMPLE 16
#define CHANNELS        1
#define MIC_GAIN_DB     30.0f
// Press-to-start recording, auto-stops on silence (voice-activity detection).
// Manual tap-to-stop and this MAX cap both still work as fallbacks.
#define MAX_RECORD_SECONDS 30   // PSRAM buffer (8MB free) — plenty of headroom now

// --- Voice-activity auto-stop tuning ---
// VAD_SILENCE_PEAK: below this int16 peak, a chunk counts as "quiet". Raised
// from 400 to 1500 after MEASURING the real ambient noise floor on-site
// (median ~646, p90 ~1360, occasional spikes to ~3800 with MIC_GAIN_DB=30) —
// at 400 background noise never dropped below the threshold, so it never
// auto-stopped. At 1500 most ambient counts as quiet. In genuinely loud rooms
// the noise still overlaps speech and auto-stop can lag; the tap-to-stop
// override in the record loop is the reliable manual backup there.
#define VAD_SILENCE_PEAK      1500
// How many consecutive quiet chunks (~32ms each) after real speech before we
// consider the user done talking and auto-stop.
#define VAD_SILENCE_HOLD_MS   1200
// How many consecutive loud chunks are needed to confirm "speech actually
// started" (filters out a single click/pop from falsely arming the timer).
#define VAD_SPEECH_CONFIRM_CHUNKS 3
#define VAD_CHUNK_MS           32   // 1024 bytes @ 16kHz/16-bit mono ≈ 32ms
#define MAX_RECORD_BYTES  ((uint32_t)SAMPLE_RATE * MAX_RECORD_SECONDS * (BITS_PER_SAMPLE/8) * CHANNELS)

static const char *TAG = "listen_v2";
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

// Exposed to display.c so it can probe the touch chip to pick the panel type.
i2c_master_bus_handle_t bsp_i2c_bus(void) { return s_i2c_bus; }

// Customer-facing idle screen. Touch anywhere (or tap BOOT) starts a turn.
static void show_ready(void)
{
    display_status("TAP TO", "ORDER", rgb565(0, 90, 160));
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

// One-time WiFi stack bring-up: netif, event loop, driver, handlers, country.
// Split from connecting so provisioning mode (SoftAP, no credentials) can use
// the same initialized stack.
static void wifi_stack_init(void)
{
    s_wifi_events = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();
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
                display_status("RESET WIFI", "RELEASE NOW", rgb565(180, 0, 0));
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
            display_status("NO SERVER", s_ip_str, rgb565(180, 120, 0));
            shown = true;
        }
        ESP_LOGW(TAG, "server not reachable at %s (%d) — retrying in %ds "
                      "(hold BOOT 5s to re-provision)", s_health_url, status, delay_s);
        if (sleep_watching_for_wifi_reset(delay_s)) {
            prov_erase_creds();
            display_status("WIFI RESET", "REBOOTING", rgb565(180, 0, 0));
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
    char body[160];
    int len = snprintf(body, sizeof(body),
                       "{\"box_id\":\"%s\",\"name\":\"%s\",\"ip\":\"%s\"}",
                       s_box_id, s_box_name[0] ? s_box_name : s_box_id, s_ip_str);
    esp_http_client_config_t cfg = { .url = s_register_url,
                                     .method = HTTP_METHOD_POST, .timeout_ms = 5000 };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_header(client, "X-Box-Id", s_box_id);
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
        display_status("MEM", "ERROR", rgb565(180, 0, 0));
        vTaskDelay(pdMS_TO_TICKS(1200));
        show_ready();
        return;
    }
    s_record_len = 0;

    esp_codec_dev_sample_info_t mic_fs = {
        .bits_per_sample = BITS_PER_SAMPLE, .channel = CHANNELS, .sample_rate = SAMPLE_RATE,
    };
    ESP_ERROR_CHECK(esp_codec_dev_open(s_mic, &mic_fs));
    esp_codec_dev_set_in_gain(s_mic, MIC_GAIN_DB);
    ESP_LOGI(TAG, ">>> recording (auto-stops after %dms silence, or tap REC, max %ds) <<<",
            VAD_SILENCE_HOLD_MS, MAX_RECORD_SECONDS);
    display_status("REC", rec_line2, rgb565(200, 0, 0));

    const uint32_t chunk = 1024;
    uint8_t tmp[1024];
    uint32_t call_ctr = 0;
    int pressed_streak = 0;    // consecutive reads seeing the button LOW (a new tap)
    int speech_run = 0;        // consecutive loud chunks (confirms real speech, not a click)
    bool speech_started = false;
    uint32_t silence_ms = 0;
    while (s_record_len + chunk <= MAX_RECORD_BYTES) {
        // Tight, back-to-back read — nothing slow in between.
        if (esp_codec_dev_read(s_mic, tmp, chunk) == 0) {
            memcpy(s_record_buf + s_record_len, tmp, chunk);
            s_record_len += chunk;

            int16_t *sm = (int16_t *)tmp; int peak = 0;
            for (int i = 0; i < (int)(chunk / 2); i++) {
                int v = sm[i]; if (v < 0) v = -v; if (v > peak) peak = v;
            }

            if (peak > VAD_SILENCE_PEAK) {
                if (++speech_run >= VAD_SPEECH_CONFIRM_CHUNKS) speech_started = true;
                silence_ms = 0;
            } else {
                speech_run = 0;
                if (speech_started) silence_ms += VAD_CHUNK_MS;
            }

            if (++call_ctr % 16 == 0) {
                ESP_LOGI(TAG, "chunk#%u peak=%d len=%u speech=%d silence_ms=%u",
                        (unsigned)call_ctr, peak, (unsigned)s_record_len, speech_started, (unsigned)silence_ms);
            }

            if (speech_started && silence_ms >= VAD_SILENCE_HOLD_MS) {
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
    display_status("SENDING", NULL, rgb565(0, 90, 160));

    uint32_t data_bytes = s_record_len;
    uint32_t total_len = 44 + data_bytes;

    esp_http_client_config_t cfg = { .url = s_post_url, .method = HTTP_METHOD_POST, .timeout_ms = 15000 };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    esp_http_client_set_header(client, "Content-Type", "audio/wav");
    // The box declares its own identity — the server must never have to guess
    // it from a source IP that DHCP can reassign tomorrow.
    esp_http_client_set_header(client, "X-Box-Id", s_box_id);

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
    if (status == 200) display_status("SENT", NULL, rgb565(0, 150, 0));
    else if (status < 0) display_status("NO PC", "START SERVER", rgb565(180, 0, 0));
    else display_status("SEND", "FAILED", rgb565(180, 0, 0));
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

// The "no / redo" action, shared by the SIDE button and the touch CANCEL
// button: throw away the wrong transcript and listen again immediately (no
// greeting — the customer is already mid-conversation). Called only from the
// main loop, so record_toggle_and_send() runs directly on the main task's
// stack (the httpd-handler stack-overflow trap doesn't apply here). The Mac's
// stale pending transcript needs no explicit cancel — the fresh recording's
// upload simply replaces it server-side.
static void clear_and_relisten(void)
{
    s_confirm_pending = false;
    ESP_LOGI(TAG, "transcript rejected — listening again");
    record_toggle_and_send("TAP WHEN DONE");
    if ((int32_t)(s_caption_at_tick - s_upload_done_tick) <= 0) {
        show_ready();
    }
}

// Start a turn immediately — record until silence, upload, transcript comes
// back as a confirm caption. NO greeting: tapping to order goes straight to
// listening (a greeting-on-approach can come later from a presence sensor).
// Runs on the main-task stack (called from the main loop, not an httpd
// handler), so record_toggle_and_send() needs no trampoline task.
static void start_listening(void)
{
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
#define PLAYBACK_RINGBUF_BYTES   (64 * 1024)   // ~1.45s of audio at 22050/16/mono
#define PLAYBACK_PREBUFFER_BYTES (16 * 1024)   // ~0.36s prebuffer before starting

typedef struct {
    StreamBufferHandle_t ring;
    SemaphoreHandle_t done;
    uint32_t total_bytes;
} playback_task_args_t;

static void playback_task(void *arg)
{
    playback_task_args_t *a = (playback_task_args_t *)arg;
    uint8_t buf[2048];
    uint32_t written = 0;
    uint32_t prebuffer = PLAYBACK_PREBUFFER_BYTES < a->total_bytes ? PLAYBACK_PREBUFFER_BYTES : a->total_bytes;

    while (xStreamBufferBytesAvailable(a->ring) < prebuffer && written < a->total_bytes) {
        vTaskDelay(pdMS_TO_TICKS(5));
    }
    while (written < a->total_bytes) {
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

static esp_err_t play_handler(httpd_req_t *req)
{
    uint8_t h[44];
    int got = 0;
    while (got < 44) {
        int r = httpd_req_recv(req, (char *)h + got, 44 - got);
        if (r <= 0) { httpd_resp_send_500(req); return ESP_FAIL; }
        got += r;
    }
    uint32_t rate = h[24] | (h[25]<<8) | (h[26]<<16) | ((uint32_t)h[27]<<24);
    uint16_t ch   = h[22] | (h[23]<<8);
    uint16_t bits = h[34] | (h[35]<<8);
    bool is_wav = (memcmp(h, "RIFF", 4) == 0);
    if (!is_wav || rate < 8000 || rate > 48000) { rate = 16000; ch = 1; bits = 16; }
    if (ch < 1 || ch > 2) ch = 1;
    if (bits != 16) bits = 16;
    ESP_LOGI(TAG, "playing: %u Hz, %u ch, %u-bit", (unsigned)rate, ch, bits);

    // Display policy per chunk-protocol headers:
    //   X-Reply-Text (legacy /respond path): show reply caption, linger after.
    //   X-Quiet: sentence chunk of a pipelined reply — the BOX caption is
    //            already on screen via /caption, so touch nothing.
    //   X-Final: last chunk — after playback, linger the caption then READY.
    //   none of the above (talk.sh etc.): old PLAYING/READY behavior.
    char reply_txt[256];
    bool had_caption = (httpd_req_get_hdr_value_str(req, "X-Reply-Text", reply_txt,
                                                    sizeof(reply_txt)) == ESP_OK) && reply_txt[0];
    char hdr[4] = "";
    bool quiet = (httpd_req_get_hdr_value_str(req, "X-Quiet", hdr, sizeof(hdr)) == ESP_OK)
                 && hdr[0] == '1';
    hdr[0] = 0;
    bool final = (httpd_req_get_hdr_value_str(req, "X-Final", hdr, sizeof(hdr)) == ESP_OK)
                 && hdr[0] == '1';
    hdr[0] = 0;
    bool auto_listen = (httpd_req_get_hdr_value_str(req, "X-Auto-Listen", hdr, sizeof(hdr)) == ESP_OK)
                       && hdr[0] == '1';
    if (had_caption) {
        display_caption("BOX", rgb565(0, 150, 0), reply_txt);
    } else if (!quiet) {
        display_status("PLAYING", NULL, rgb565(0, 150, 0));
    }
    esp_codec_dev_sample_info_t fs = { .bits_per_sample = bits, .channel = ch, .sample_rate = rate };
    esp_codec_dev_open(s_spk, &fs);
    esp_codec_dev_set_out_vol(s_spk, 85);

    uint32_t remaining = req->content_len - 44;
    playback_task_args_t args = {
        .ring = xStreamBufferCreate(PLAYBACK_RINGBUF_BYTES, 1),
        .done = xSemaphoreCreateBinary(),
        .total_bytes = remaining,
    };
    xTaskCreate(playback_task, "playback", 4096, &args, 5, NULL);

    char buf[4096];
    while (remaining > 0) {
        int want = remaining < sizeof(buf) ? remaining : sizeof(buf);
        int r = httpd_req_recv(req, buf, want);
        if (r <= 0) break;
        size_t sent = 0;
        while (sent < (size_t)r) {
            sent += xStreamBufferSend(args.ring, buf + sent, r - sent, portMAX_DELAY);
        }
        remaining -= r;
    }
    xSemaphoreTake(args.done, portMAX_DELAY);
    vSemaphoreDelete(args.done);
    vStreamBufferDelete(args.ring);

    esp_codec_dev_close(s_spk);
    ESP_LOGI(TAG, "playback done");

    // Answer the Mac first, THEN linger, so the reply caption stays readable for
    // a few seconds after the audio ends without delaying the Mac's next turn.
    // If the Mac pushes new content during the linger (the order screen arrives
    // right after /play returns), that content owns the screen — skip READY.
    // Quiet middle chunks return immediately and leave the screen alone.
    TickType_t playback_end_tick = xTaskGetTickCount();
    httpd_resp_sendstr(req, "played");
    if (quiet && !final) return ESP_OK;

    if (auto_listen) {
        // Greeting just finished — go straight into a listen turn, no button
        // needed. Same recording+upload path BOOT uses, so everything
        // downstream (STT, confirm screen, order) is completely unchanged.
        // Runs in its own task — see run_auto_listen()'s comment for why.
        run_auto_listen("LISTENING...");
        if ((int32_t)(s_caption_at_tick - s_upload_done_tick) <= 0) {
            show_ready();
        }
        return ESP_OK;
    }

    if (had_caption || final) vTaskDelay(pdMS_TO_TICKS(3500));
    if ((int32_t)(s_caption_at_tick - playback_end_tick) <= 0) {
        show_ready();
    }
    return ESP_OK;
}

// Show a live caption. Body = the text; optional "X-Speaker" header ("YOU"/"BOX")
// picks the bar label + color (defaults to YOU / amber). Used by the Mac to push
// "what was heard" the moment STT finishes, before the reply audio arrives.
static esp_err_t caption_handler(httpd_req_t *req)
{
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
    uint16_t bar = (strcmp(who, "BOX") == 0) ? rgb565(0, 150, 0)   // green
                                             : rgb565(200, 120, 0); // amber

    // X-Confirm: 1 arms the tap-to-confirm window; any other caption disarms
    // it (a new screen means the pending question is no longer on display).
    char cf[4] = "";
    httpd_req_get_hdr_value_str(req, "X-Confirm", cf, sizeof(cf));
    if (cf[0] == '1') {
        s_confirm_deadline_tick = xTaskGetTickCount() + pdMS_TO_TICKS(CONFIRM_WINDOW_MS);
        s_confirm_pending = true;
    } else {
        s_confirm_pending = false;
    }

    s_caption_at_tick = xTaskGetTickCount();
    // The confirm screen carries CANCEL/SEND buttons; a plain caption doesn't.
    if (s_confirm_pending) display_confirm(who, bar, text);
    else                   display_caption(who, bar, text);
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
    esp_http_client_set_header(client, "X-Box-Id", s_box_id);
    esp_http_client_set_post_field(client, "1", 1);
    esp_err_t err = esp_http_client_perform(client);
    int status = (err == ESP_OK) ? esp_http_client_get_status_code(client) : -1;
    esp_http_client_cleanup(client);
    ESP_LOGI(TAG, "greet -> %s (%d)", s_wake_url, status);
    // The greeting audio arrives as a /play POST. The screen keeps showing
    // "TAP TO ORDER" throughout — a failed greeting shouldn't scare a customer
    // with an error, they can still just tap and order.
}

// Tell the Mac the customer tap-confirmed the transcript on screen.
static void post_confirm(void)
{
    esp_http_client_config_t cfg = { .url = s_confirm_url, .method = HTTP_METHOD_POST,
                                     .timeout_ms = 5000 };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    esp_http_client_set_header(client, "X-Box-Id", s_box_id);
    esp_http_client_set_post_field(client, "1", 1);
    esp_err_t err = esp_http_client_perform(client);
    int status = (err == ESP_OK) ? esp_http_client_get_status_code(client) : -1;
    esp_http_client_cleanup(client);
    ESP_LOGI(TAG, "confirm -> %s (%d)", s_confirm_url, status);
    if (status != 200) {
        display_status("EXPIRED", "TAP TO RETRY", rgb565(180, 0, 0));
    }
}

// Render an itemized order. Body is a line protocol (built by the Mac so the
// firmware needs no JSON parsing):
//   TITLE|YOUR ORDER
//   ITEM|2X NASI LEMAK|RM11.00     (up to 5 ITEM lines)
//   TOTAL|RM15.50
static esp_err_t order_handler(httpd_req_t *req)
{
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

    const char *title = "YOUR ORDER";
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
        }
    }

    s_caption_at_tick = xTaskGetTickCount();   // order owns the screen now
    display_order(title, lines, count, total[0] ? total : NULL);
    ESP_LOGI(TAG, "order screen: %d items, total %s", count, total);
    httpd_resp_sendstr(req, "ok");
    return ESP_OK;
}

// /confirm, /health, /register and /wake all live next to /upload on the same
// server, so they're derived from post_url (which carries the real host AND
// port). Re-run whenever post_url changes so a repointed box updates every URL
// at once instead of leaving stale ones behind.
static void derive_server_urls(void)
{
    const char *slash = strrchr(s_post_url, '/');
    int base_len = slash ? (int)(slash - s_post_url) : (int)strlen(s_post_url);
    snprintf(s_confirm_url, sizeof(s_confirm_url), "%.*s/confirm", base_len, s_post_url);
    snprintf(s_health_url, sizeof(s_health_url), "%.*s/health", base_len, s_post_url);
    snprintf(s_register_url, sizeof(s_register_url), "%.*s/register", base_len, s_post_url);
    snprintf(s_wake_url, sizeof(s_wake_url), "%.*s/wake", base_len, s_post_url);
}

// Repoint this box at a different server, live, over the network:
//   curl -X POST http://<box-ip>/server --data "http://10.0.0.5:8000/upload"
// Persisted to NVS, so it survives reboots. This is the answer to "the server
// machine moved / changed IP and mDNS is blocked here" — previously that meant
// a full QR re-provision; now it's one request and the retry loop picks it up
// on its next pass (or immediately, if it's already waiting).
static esp_err_t server_handler(httpd_req_t *req)
{
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
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "must start with http://");
        return ESP_FAIL;
    }

    strlcpy(s_post_url, url, sizeof(s_post_url));
    derive_server_urls();
    prov_save_post_url(s_post_url);
    ESP_LOGI(TAG, "server address updated to %s", s_post_url);
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
    if (httpd_start(&server, &cfg) == ESP_OK) {
        httpd_uri_t play = { .uri = "/play", .method = HTTP_POST, .handler = play_handler };
        httpd_register_uri_handler(server, &play);
        httpd_uri_t caption = { .uri = "/caption", .method = HTTP_POST, .handler = caption_handler };
        httpd_register_uri_handler(server, &caption);
        httpd_uri_t order = { .uri = "/order", .method = HTTP_POST, .handler = order_handler };
        httpd_register_uri_handler(server, &order);
        httpd_uri_t srv = { .uri = "/server", .method = HTTP_POST, .handler = server_handler };
        httpd_register_uri_handler(server, &srv);
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
    display_status("STARTING", NULL, COL_BLACK);
    i2s_chan_handle_t rx = i2s_init();
    mic_init(rx);
    speaker_init();

    // Identity first — box_id exists before the box touches any network, so
    // even a fresh box's provisioning AP is already named after it.
    prov_ensure_box_id(s_box_id, sizeof(s_box_id));
    wifi_stack_init();

    char wifi_ssid[33], wifi_pass[64];
    if (!prov_load_creds(wifi_ssid, sizeof(wifi_ssid), wifi_pass, sizeof(wifi_pass),
                         s_post_url, sizeof(s_post_url), s_box_name, sizeof(s_box_name))) {
        ESP_LOGI(TAG, "no saved WiFi credentials — entering provisioning mode");
        start_provisioning_mode();   // never returns
    }

    display_status("WIFI", "CONNECTING", COL_BLACK);
    if (!wifi_connect_sta(wifi_ssid, wifi_pass)) {
        // Bad/absent network: only re-provisioning can fix this. The QR screen
        // replaces the old behavior of retrying forever behind "CONNECTING".
        ESP_LOGW(TAG, "could not join \"%s\" — entering provisioning mode", wifi_ssid);
        display_status("WIFI FAILED", "OPENING SETUP", rgb565(180, 0, 0));
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
        display_status("NO SERVER", "OPENING SETUP", rgb565(180, 0, 0));
        vTaskDelay(pdMS_TO_TICKS(1500));
        start_provisioning_mode();   // never returns
    }
    register_with_core();

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
    bool present_last = sensor_presence();
    TickType_t greet_ready_tick = xTaskGetTickCount();

    int hb = 0;
    while (1) {
        if (gpio_get_level(PIN_REC_BTN) == 0) {
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
                    display_status("RESET WIFI", "RELEASE NOW", rgb565(180, 0, 0));
                }
                vTaskDelay(pdMS_TO_TICKS(10));
            }
            if (long_press) {
                prov_erase_creds();   // box_id survives; only network creds go
                display_status("WIFI RESET", "REBOOTING", rgb565(180, 0, 0));
                vTaskDelay(pdMS_TO_TICKS(800));
                esp_restart();
            }

            // SIDE (boot) tap: while a transcript shows, clear the wrong text
            // and listen again; idle, start a fresh turn (physical backup for
            // the touch-screen trigger below).
            if (s_confirm_pending &&
                (int32_t)(s_confirm_deadline_tick - xTaskGetTickCount()) > 0) {
                clear_and_relisten();
                continue;
            }
            s_confirm_pending = false;
            start_listening();
            continue;
        }
        // Touch is the PRIMARY trigger: a tap anywhere on the idle screen
        // starts a turn; on the confirm screen the SEND/CANCEL buttons send or
        // clear. (The top/mute button is NOT a trigger — it's the hardware
        // mic-mute and toggles the mic on/off, so it can't reliably start a
        // listen turn; that's why the customer uses the screen or BOOT.)
        int tx, ty;
        if (touch_get_tap(&tx, &ty)) {
            if (!s_confirm_pending) {
                start_listening();   // record straight away, no greeting
                continue;
            }
            display_button_t btn = display_hit_test(tx, ty);
            if (btn == BTN_SEND) {
                s_confirm_pending = false;
                display_status("SENDING", "TO ASSISTANT", rgb565(0, 90, 160));
                post_confirm();
                continue;
            } else if (btn == BTN_CANCEL) {
                clear_and_relisten();
                continue;
            }
        }

        // Confirm window ran out with no press: discard the pending transcript
        // (customer likely walked off or went quiet — don't auto re-listen,
        // that would just record silence).
        if (s_confirm_pending &&
            (int32_t)(xTaskGetTickCount() - s_confirm_deadline_tick) >= 0) {
            s_confirm_pending = false;
            display_status("TIMED OUT", "TAP TO ORDER", rgb565(180, 0, 0));
            ESP_LOGI(TAG, "confirm window expired — transcript discarded");
        }
        // Greet on approach: when the presence radar goes from clear to
        // occupied, say hello once. The cooldown stops one customer standing
        // there from being greeted over and over (the radar drops and re-fires
        // as they shift around). Skipped while a transcript is pending so a
        // greeting can't talk over the confirm step.
        bool present_now = sensor_presence();
        if (present_now && !present_last && !s_confirm_pending &&
            (int32_t)(xTaskGetTickCount() - greet_ready_tick) >= 0) {
            greet_ready_tick = xTaskGetTickCount() + pdMS_TO_TICKS(GREET_COOLDOWN_MS);
            ESP_LOGI(TAG, "presence detected — greeting");
            trigger_wake();
        }
        present_last = present_now;

        if (++hb >= 1000) { hb = 0; ESP_LOGI(TAG, "alive, waiting for a button..."); }
        vTaskDelay(pdMS_TO_TICKS(10));   // finer polling = less chance a quick
                                         // tap lands entirely between two reads
    }
}
