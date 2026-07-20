// ESP32-S3-BOX-3-SENSOR dock: human-presence radar (greet on approach).
// The presence output is a digital pin, not I2C — see sensor.c for how that
// was determined on real hardware.
#pragma once
#include <stdbool.h>

// Configure the radar's presence pin. Safe to call even with no dock attached
// (the pin simply never goes high).
void sensor_init(void);

// True while a person is in front of the box.
bool sensor_presence(void);
