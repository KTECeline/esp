// TT21100 touch — proof of concept. Shares the LCD's I2C bus (already probed
// once in display.c just to detect panel type); this is the first code that
// actually reads touch data off it.
#include "touch.h"
#include "esp_log.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_touch.h"
#include "esp_lcd_touch_tt21100.h"
#include "driver/i2c_master.h"

static const char *TAG = "touch";
static esp_lcd_touch_handle_t s_touch = NULL;

extern i2c_master_bus_handle_t bsp_i2c_bus(void);   // provided by main (listen_v2.c)

bool touch_init(void)
{
    i2c_master_bus_handle_t bus = bsp_i2c_bus();
    if (!bus) {
        ESP_LOGW(TAG, "no I2C bus available");
        return false;
    }

    esp_lcd_panel_io_handle_t io = NULL;
    esp_lcd_panel_io_i2c_config_t io_cfg = ESP_LCD_TOUCH_IO_I2C_TT21100_CONFIG();
    if (esp_lcd_new_panel_io_i2c(bus, &io_cfg, &io) != ESP_OK) {
        ESP_LOGW(TAG, "no response from touch controller");
        return false;
    }

    // No interrupt/reset pins wired for this proof of concept — polling mode
    // (touch_poll_log calling esp_lcd_touch_read_data) works without them.
    esp_lcd_touch_config_t touch_cfg = {
        .x_max = 320, .y_max = 240,
        .rst_gpio_num = GPIO_NUM_NC,
        .int_gpio_num = GPIO_NUM_NC,
    };
    if (esp_lcd_touch_new_i2c_tt21100(io, &touch_cfg, &s_touch) != ESP_OK) {
        ESP_LOGW(TAG, "tt21100 driver init failed");
        return false;
    }

    ESP_LOGI(TAG, "touch controller ready");
    return true;
}

void touch_poll_log(void)
{
    if (!s_touch) return;
    esp_lcd_touch_read_data(s_touch);

    uint16_t x[1], y[1], strength[1];
    uint8_t n = 0;
    bool pressed = esp_lcd_touch_get_coordinates(s_touch, x, y, strength, &n, 1);
    if (pressed && n > 0) {
        ESP_LOGI(TAG, "touch at (%u, %u) strength=%u", x[0], y[0], strength[0]);
    }
}
