// Touch controller — proof of concept. BOX-3 units shipped with EITHER a
// TT21100 (I2C 0x24) or a GT911 (I2C 0x5D) touch chip depending on hardware
// revision — confirmed on real units, not a guess: display.c's ST7789/ILI9341
// panel-type probe only checks 0x24, so it is NOT a reliable indicator of
// which touch chip (if any) is actually present. This probes both addresses
// and initializes whichever one responds.
#include "touch.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_touch.h"
#include "esp_lcd_touch_tt21100.h"
#include "esp_lcd_touch_gt911.h"
#include "driver/i2c_master.h"

static const char *TAG = "touch";
static esp_lcd_touch_handle_t s_touch = NULL;

extern i2c_master_bus_handle_t bsp_i2c_bus(void);   // provided by main (listen_v2.c)

#define TT21100_ADDR 0x24
#define GT911_ADDR   0x5D

bool touch_init(void)
{
    i2c_master_bus_handle_t bus = bsp_i2c_bus();
    if (!bus) {
        ESP_LOGW(TAG, "no I2C bus available");
        return false;
    }

    bool has_tt21100 = i2c_master_probe(bus, TT21100_ADDR, 30) == ESP_OK;
    bool has_gt911   = i2c_master_probe(bus, GT911_ADDR, 30) == ESP_OK;
    ESP_LOGI(TAG, "touch probe: TT21100(0x24)=%s GT911(0x5D)=%s",
             has_tt21100 ? "yes" : "no", has_gt911 ? "yes" : "no");

    if (!has_tt21100 && !has_gt911) {
        ESP_LOGW(TAG, "no touch controller found at either known address");
        return false;
    }

    esp_lcd_panel_io_handle_t io = NULL;
    esp_err_t err;

    if (has_tt21100) {
        esp_lcd_panel_io_i2c_config_t io_cfg = ESP_LCD_TOUCH_IO_I2C_TT21100_CONFIG();
        if (esp_lcd_new_panel_io_i2c(bus, &io_cfg, &io) != ESP_OK) {
            ESP_LOGW(TAG, "TT21100: panel IO create failed");
            return false;
        }
        // TT21100 uses INT as a data-ready line — without it wired, reads
        // NACK with an I2C error (confirmed on hardware). Reset stays NC:
        // the official esp-box-3 BSP leaves it unwired too. GPIO3 =
        // BSP_LCD_TOUCH_INT in Espressif's esp-box-3 BSP (esp-bsp repo),
        // confirmed free in this project's own pin map.
        esp_lcd_touch_config_t touch_cfg = {
            .x_max = 320, .y_max = 240,
            .rst_gpio_num = GPIO_NUM_NC,
            .int_gpio_num = GPIO_NUM_3,
            .levels = { .reset = 0, .interrupt = 0 },
        };
        err = esp_lcd_touch_new_i2c_tt21100(io, &touch_cfg, &s_touch);
        if (err != ESP_OK) { ESP_LOGW(TAG, "TT21100 init failed"); return false; }
        ESP_LOGI(TAG, "touch controller ready (TT21100)");
        return true;
    }

    // GT911 path.
    esp_lcd_panel_io_i2c_config_t io_cfg = ESP_LCD_TOUCH_IO_I2C_GT911_CONFIG();
    if (esp_lcd_new_panel_io_i2c(bus, &io_cfg, &io) != ESP_OK) {
        ESP_LOGW(TAG, "GT911: panel IO create failed");
        return false;
    }
    esp_lcd_touch_config_t touch_cfg = {
        .x_max = 320, .y_max = 240,
        .rst_gpio_num = GPIO_NUM_NC,
        .int_gpio_num = GPIO_NUM_NC,
    };
    err = esp_lcd_touch_new_i2c_gt911(io, &touch_cfg, &s_touch);
    if (err != ESP_OK) { ESP_LOGW(TAG, "GT911 init failed"); return false; }
    ESP_LOGI(TAG, "touch controller ready (GT911)");
    return true;
}

// Panel coordinates already match display coordinates 1:1 — MEASURED on
// hardware, don't "fix" this without re-measuring. display.c mirrors the LCD
// (esp_lcd_panel_mirror(panel, true, true)) which suggests touch would need
// flipping too, but it doesn't: a tap on the bottom-left CANCEL button reports
// panel(~70,~215), which is already that button's display rect. Flipping sent
// it to the opposite corner and no button ever responded.
#define TOUCH_MIRROR_XY 0

// The GT911 in polling mode (no INT pin) reports a "new" point repeatedly for
// one continuous press — a rising edge alone gave ~25 taps per finger press.
// A time floor between accepted taps is what actually makes one press = one tap.
#define TAP_DEBOUNCE_MS 400

static bool s_was_pressed = false;
static TickType_t s_last_tap_tick = 0;

bool touch_is_pressed(void)
{
    if (!s_touch) return false;
    esp_lcd_touch_read_data(s_touch);
    uint16_t tx[1], ty[1], strength[1];
    uint8_t n = 0;
    // s_was_pressed is deliberately NOT updated here. It belongs to
    // touch_get_tap()'s rising-edge detection, and writing it from a second
    // caller would make held fingers eat the next real tap.
    return esp_lcd_touch_get_coordinates(s_touch, tx, ty, strength, &n, 1) && n > 0;
}

bool touch_get_tap(int *x, int *y)
{
    if (!s_touch) return false;
    esp_lcd_touch_read_data(s_touch);

    uint16_t tx[1], ty[1], strength[1];
    uint8_t n = 0;
    bool pressed = esp_lcd_touch_get_coordinates(s_touch, tx, ty, strength, &n, 1) && n > 0;
    bool edge = pressed && !s_was_pressed;
    s_was_pressed = pressed;
    if (!edge) return false;

    TickType_t now = xTaskGetTickCount();
    if (s_last_tap_tick && (int32_t)(now - s_last_tap_tick) < pdMS_TO_TICKS(TAP_DEBOUNCE_MS)) {
        return false;
    }
    s_last_tap_tick = now;

#if TOUCH_MIRROR_XY
    int dx = 320 - tx[0], dy = 240 - ty[0];
#else
    int dx = tx[0], dy = ty[0];
#endif
    ESP_LOGI(TAG, "tap: panel(%u,%u) -> display(%d,%d)", tx[0], ty[0], dx, dy);
    *x = dx; *y = dy;
    return true;
}
