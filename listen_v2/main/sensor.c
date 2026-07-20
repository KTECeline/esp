// ESP32-S3-BOX-3-SENSOR dock: human-presence radar.
//
// MEASURED on real hardware (not from a datasheet — this chip has no public
// driver): the radar's presence output is a plain digital signal on GPIO21 —
// HIGH while a person is in range, LOW when clear. Confirmed by watching every
// free expansion GPIO while a person walked up and away; GPIO21 tracked it
// exactly (0 -> 1 on approach, 1 -> 0 on leaving).
//
// It is NOT readable over I2C. The dock does expose an I2C bus on SDA=GPIO41 /
// SCL=GPIO40 carrying 0x38 (AHT30 temp/humidity) and 0x28, but a full 64-
// register dump of 0x28 showed no change at all when a person approached, so
// neither holds the presence bit. Those addresses are noted here in case the
// temp/humidity sensor is wanted later.
#include "sensor.h"
#include "driver/gpio.h"
#include "esp_log.h"

static const char *TAG = "sensor";

#define PIN_PRESENCE 21

void sensor_init(void)
{
    gpio_config_t c = {
        .pin_bit_mask = 1ULL << PIN_PRESENCE,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
    };
    gpio_config(&c);
    ESP_LOGI(TAG, "presence radar on GPIO%d (HIGH = person present)", PIN_PRESENCE);
}

bool sensor_presence(void)
{
    return gpio_get_level(PIN_PRESENCE) != 0;
}
