// Get the XIAO OUT OF THE WAY, for when the XMOS runs its USB firmware.
//
// WHICH FIRMWARE THE XIAO SHOULD RUN DEPENDS ENTIRELY ON THE XMOS:
//
//   XMOS I2S firmware  -> XIAO is the audio source and the I2S MASTER.
//                         It must drive BCLK/WS continuously or the amp squeals.
//                         Use [[respeaker_silence]] (or respeaker_tone to test).
//
//   XMOS USB firmware  -> the XMOS is a USB sound card and owns the codec itself.
//                         A XIAO still driving BCLK/WS is a SECOND master on the
//                         same bus. Two masters fighting is what produced the
//                         "glitchy, no real voice" playback on 2026-08-13.
//                         Use THIS app.
//
// So the correct app is the opposite one each time, which is easy to get wrong.
// The symptom is the same in both directions — bad noise out of the speaker —
// and the fix is to ask which firmware the XMOS is running, not to keep
// reflashing the XIAO hoping.
//
// All this does is park the I2S pins as high-impedance inputs and sleep. It
// exists rather than leaving the chip erased because an ERASED ESP32-S3
// boot-loops: the USB port flaps on and off, which makes it hard to reflash and
// slams the amp dozens of times a second.

#include "driver/gpio.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "idle";

// The I2S bus shared with the XMOS — see respeaker_tone.c for the pinout source.
// GPIO43/44 are also the ESP32-S3's default UART0 pins, which is why this build
// keeps the console on USB Serial/JTAG (see sdkconfig.defaults): otherwise boot
// logs would be driven straight down the speaker's data line.
#define PIN_BCLK 8
#define PIN_WS   7
#define PIN_DOUT 43
#define PIN_DIN  44

void app_main(void) {
    const gpio_config_t io = {
        .pin_bit_mask = (1ULL << PIN_BCLK) | (1ULL << PIN_WS) |
                        (1ULL << PIN_DOUT) | (1ULL << PIN_DIN),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&io));

    ESP_LOGI(TAG, "I2S pins %d/%d/%d/%d parked as inputs; XMOS owns the bus",
             PIN_BCLK, PIN_WS, PIN_DOUT, PIN_DIN);

    while (1) {
        vTaskDelay(pdMS_TO_TICKS(10000));
    }
}
