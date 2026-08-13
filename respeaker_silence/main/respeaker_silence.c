// Keep the ReSpeaker Lite QUIET. This is the firmware the board should sit on
// when nobody is using it.
//
// WHY A "DO NOTHING" APP IS NOT AN EMPTY APP: the XMOS on this board is only the
// codec + amp, and the XIAO is the I2S master. The amplifier is powered and
// enabled the instant the board sees 5V — including from a USB port being used
// purely as a power source. If nothing is driving BCLK/WS, the amp has no valid
// clock and amplifies whatever it finds, which comes out as a loud high-pitched
// squeal. An ERASED chip therefore sounds far worse than a running one, and
// that is not intuitive: the fix for noise is more firmware, not less.
//
// [[respeaker_tone]] had the same bug in miniature — its 500 ms gap between
// beeps stopped writing to an enabled channel, so it glitched between the tones.
// The lesson both times: an enabled I2S channel must be fed, always.
//
// So this holds the clock steady and writes zeros forever. Silence that is
// actively transmitted, not silence by absence.

#include <string.h>

#include "driver/i2s_std.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "silence";

// Same pinout as the tone test — Seeed's I2S.setPins(8, 7, 43, 44), where the
// signature is setPins(bclk, ws, dout, din).
#define PIN_BCLK 8
#define PIN_WS   7
#define PIN_DOUT 43  // XIAO -> XMOS, feeds the speaker

#define SAMPLE_RATE 16000
#define FRAMES      1600  // 0.1 s per write: long enough to be cheap, short
                          // enough that the DMA queue never runs dry

static int16_t silence_buf[FRAMES * 2];  // stereo, interleaved — already zeroed

void app_main(void) {
    memset(silence_buf, 0, sizeof(silence_buf));

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

    ESP_LOGI(TAG, "holding I2S silent: bclk=%d ws=%d dout=%d @ %d Hz",
             PIN_BCLK, PIN_WS, PIN_DOUT, SAMPLE_RATE);

    // No vTaskDelay anywhere in here. i2s_channel_write blocks until the DMA
    // buffer has room, so this loop is self-pacing — adding a sleep would
    // reintroduce exactly the gap that makes the amp squeal.
    while (1) {
        size_t written = 0;
        ESP_ERROR_CHECK(i2s_channel_write(tx, silence_buf, sizeof(silence_buf),
                                          &written, portMAX_DELAY));
    }
}
