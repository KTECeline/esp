// listen_v2 (wireless) — ESP32-S3-BOX-3 mic recorder that POSTs a WAV to the PC
// over WiFi. Tap BOOT (GPIO0 — the front button is a hardware mic-MUTE, don't
// use it) to start recording; it auto-stops after VAD_SILENCE_HOLD_MS of
// silence following detected speech, or tap BOOT again to stop early, or hits
// MAX_RECORD_SECONDS as an absolute safety cap.
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

// WiFi + PC endpoint config lives in wifi_config.h, which is gitignored so real
// credentials never get committed. First-time setup:
//   cp main/wifi_config.example.h main/wifi_config.h   (then edit the copy)
#include "wifi_config.h"

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

// ---- Recording params ----
#define SAMPLE_RATE     16000
#define BITS_PER_SAMPLE 16
#define CHANNELS        1
#define MIC_GAIN_DB     30.0f
// Press-to-start recording, auto-stops on silence (voice-activity detection).
// Manual tap-to-stop and this MAX cap both still work as fallbacks.
#define MAX_RECORD_SECONDS 30   // PSRAM buffer (8MB free) — plenty of headroom now

// --- Voice-activity auto-stop tuning ---
// VAD_SILENCE_PEAK: below this int16 peak, a chunk counts as "quiet". Tuned
// for a quiet room with MIC_GAIN_DB=30 — a noisy restaurant environment will
// likely need this raised (and/or the mic gain lowered) so background chatter
// doesn't count as speech. Re-tune using the per-chunk peak values already
// logged during recording.
#define VAD_SILENCE_PEAK      400
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
static char s_ip_str[16] = "";

// Exposed to display.c so it can probe the touch chip to pick the panel type.
i2c_master_bus_handle_t bsp_i2c_bus(void) { return s_i2c_bus; }

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
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        ESP_LOGW(TAG, "wifi disconnected, retrying...");
        esp_wifi_connect();
        xEventGroupClearBits(s_wifi_events, WIFI_CONNECTED_BIT);
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = (ip_event_got_ip_t *)data;
        snprintf(s_ip_str, sizeof(s_ip_str), IPSTR, IP2STR(&e->ip_info.ip));
        ESP_LOGI(TAG, "connected, got IP %s", s_ip_str);
        xEventGroupSetBits(s_wifi_events, WIFI_CONNECTED_BIT);
    }
}

static void wifi_init(void)
{
    s_wifi_events = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event, NULL));
    wifi_config_t wc = { .sta = { .ssid = WIFI_SSID, .password = WIFI_PASS } };
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_LOGI(TAG, "connecting to WiFi \"%s\"...", WIFI_SSID);
    xEventGroupWaitBits(s_wifi_events, WIFI_CONNECTED_BIT, pdFALSE, pdTRUE, portMAX_DELAY);
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
static void record_toggle_and_send(void)
{
    s_record_buf = heap_caps_malloc(MAX_RECORD_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s_record_buf) {
        ESP_LOGE(TAG, "recording buffer alloc FAILED (%u bytes)", (unsigned)MAX_RECORD_BYTES);
        display_status("MEM", "ERROR", rgb565(180, 0, 0));
        vTaskDelay(pdMS_TO_TICKS(1200));
        display_status("READY", s_ip_str, rgb565(0, 90, 160));
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
    display_status("REC", "SPEAK, PAUSE TO SEND", rgb565(200, 0, 0));

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
        // Manual tap still works as an immediate override: ~2 consecutive
        // LOW reads (~64ms) is a real press, not a contact bounce.
        if (gpio_get_level(PIN_REC_BTN) == 0) {
            if (++pressed_streak >= 2) { ESP_LOGI(TAG, "manual stop (tap)"); break; }
        } else {
            pressed_streak = 0;
        }
    }

    esp_codec_dev_close(s_mic);
    display_status("SENDING", NULL, rgb565(0, 90, 160));

    uint32_t data_bytes = s_record_len;
    uint32_t total_len = 44 + data_bytes;

    esp_http_client_config_t cfg = { .url = POST_URL, .method = HTTP_METHOD_POST, .timeout_ms = 15000 };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    esp_http_client_set_header(client, "Content-Type", "audio/wav");

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

    if (status == 200) display_status("SENT", NULL, rgb565(0, 150, 0));
    else if (status < 0) display_status("NO PC", "START SERVER", rgb565(180, 0, 0));
    else display_status("SEND", "FAILED", rgb565(180, 0, 0));
    vTaskDelay(pdMS_TO_TICKS(1200));
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

    display_status("PLAYING", NULL, rgb565(0, 150, 0));
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
    display_status("READY", s_ip_str, rgb565(0, 90, 160));
    httpd_resp_sendstr(req, "played");
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
        ESP_LOGI(TAG, "TALK server up: POST a WAV to http://%s/play", s_ip_str);
    } else {
        ESP_LOGE(TAG, "failed to start HTTP server");
    }
}

void app_main(void)
{
    ESP_ERROR_CHECK(nvs_flash_init());
    i2c_init();
    display_init();
    display_status("STARTING", NULL, COL_BLACK);
    i2s_chan_handle_t rx = i2s_init();
    mic_init(rx);
    speaker_init();
    display_status("WIFI", "CONNECTING", COL_BLACK);
    wifi_init();
    start_http_server();

    // Boot-time demo of the new order screen so the layout is visible on flash.
    // Set to 0 (or delete) once you've seen it — it just delays READY by ~4s.
#define DISPLAY_ORDER_DEMO 1
#if DISPLAY_ORDER_DEMO
    {
        const order_line_t demo[] = {
            { "2X NASI LEMAK", "RM11.00" },
            { "1X TEH TARIK",  "RM 2.50" },
            { "1X ROTI CANAI", "RM 2.00" },
        };
        display_order("YOUR ORDER", demo, 3, "RM15.50");
        vTaskDelay(pdMS_TO_TICKS(4000));
    }
#endif

    display_status("READY", s_ip_str, rgb565(0, 90, 160));   // blue = ready

    gpio_config_t btn = {
        .pin_bit_mask = 1ULL << PIN_REC_BTN, .mode = GPIO_MODE_INPUT, .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    gpio_config(&btn);

    ESP_LOGI(TAG, "ready — TAP BOOT to start, auto-stops on silence, sends to %s", POST_URL);

    // Tap-to-toggle: tap BOOT to start, tap again to stop. Each tap is
    // consumed (wait for release) so one physical tap = one state change.
    // The whole recording happens inside record_toggle_and_send() as one
    // tight read loop, which is what keeps the mic DMA fed and non-silent.
    int hb = 0;
    while (1) {
        if (gpio_get_level(PIN_REC_BTN) == 0) {
            vTaskDelay(pdMS_TO_TICKS(30));   // debounce the press edge
            if (gpio_get_level(PIN_REC_BTN) != 0) continue;   // bounce, ignore
            // Consume the START tap: wait for a clean release first so it
            // isn't immediately re-read as the STOP tap.
            int high = 0;
            while (high < 5) { high = (gpio_get_level(PIN_REC_BTN) != 0) ? high + 1 : 0; vTaskDelay(pdMS_TO_TICKS(10)); }

            record_toggle_and_send();   // records until the next tap
            display_status("READY", s_ip_str, rgb565(0, 90, 160));
            ESP_LOGI(TAG, "done — tap BOOT again for another take.");

            // Consume the STOP tap's release too.
            high = 0;
            while (high < 5) { high = (gpio_get_level(PIN_REC_BTN) != 0) ? high + 1 : 0; vTaskDelay(pdMS_TO_TICKS(10)); }
            continue;
        }
        if (++hb >= 500) { hb = 0; ESP_LOGI(TAG, "alive, waiting for REC tap..."); }
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}
