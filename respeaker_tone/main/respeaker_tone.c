// Bring-up test: prove the ReSpeaker Lite's amp + JST + 4R driver actually work.
//
// The XMOS on the ReSpeaker Lite ships with I2S firmware, which does NOT
// enumerate over USB — so the Mac/Pi can't reach the speaker at all. In that
// mode the XIAO is the audio source and the XMOS is just the codec + amp.
// This plays a tone down that path. Sound out of the box = the whole analog
// chain is good, and anything still broken is firmware, not hardware.

#include <math.h>

#include "driver/i2s_std.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "tone";

// Seeed's I2S-firmware pinout for ReSpeaker Lite + XIAO ESP32-S3, taken from
// their test sketch's I2S.setPins(8, 7, 43, 44) — the signature is
// setPins(bclk, ws, dout, din), so 43 is the playback pin, not 44.
#define PIN_BCLK 8
#define PIN_WS   7
#define PIN_DOUT 43  // XIAO -> XMOS, feeds the speaker
#define PIN_DIN  44  // XMOS -> XIAO, the mic array (unused here)

#define SAMPLE_RATE 16000
#define TONE_HZ     400    // divides the sample rate evenly, so the buffer loops without a click
#define AMPLITUDE   6000   // ~18% of full scale: clearly audible, easy on a 4R driver

#define FRAMES (SAMPLE_RATE / TONE_HZ * 40)  // 1600 frames = 0.1 s of whole cycles

static int16_t tone_buf[FRAMES * 2];  // stereo, interleaved L/R

void app_main(void) {
    for (int i = 0; i < FRAMES; i++) {
        int16_t s = (int16_t)(AMPLITUDE * sinf(2.0f * (float)M_PI * TONE_HZ * i / SAMPLE_RATE));
        tone_buf[2 * i] = s;
        tone_buf[2 * i + 1] = s;
    }

    i2s_chan_handle_t tx = NULL;
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_AUTO, I2S_ROLE_MASTER);
    ESP_ERROR_CHECK(i2s_new_channel(&chan_cfg, &tx, NULL));

    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = PIN_BCLK,
            .ws = PIN_WS,
            .dout = PIN_DOUT,
            .din = I2S_GPIO_UNUSED,
            .invert_flags = {.mclk_inv = false, .bclk_inv = false, .ws_inv = false},
        },
    };
    ESP_ERROR_CHECK(i2s_channel_init_std_mode(tx, &std_cfg));
    ESP_ERROR_CHECK(i2s_channel_enable(tx));

    ESP_LOGI(TAG, "I2S up: bclk=%d ws=%d dout=%d @ %d Hz", PIN_BCLK, PIN_WS, PIN_DOUT, SAMPLE_RATE);

    while (1) {
        ESP_LOGI(TAG, "beep");
        size_t written = 0;
        for (int i = 0; i < 10; i++) {  // 10 x 0.1 s = a 1 s tone
            ESP_ERROR_CHECK(i2s_channel_write(tx, tone_buf, sizeof(tone_buf), &written, portMAX_DELAY));
        }
        vTaskDelay(pdMS_TO_TICKS(500));  // gap, so the beeps are countable
    }
}
