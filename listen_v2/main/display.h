// Minimal status display for the ESP32-S3-BOX-3 (ILI9341/ST7789 over SPI).
// No LVGL — just solid color fills + a small embedded font. White-on-black
// text is robust to any panel color-order quirks.
#pragma once
#include <stdint.h>

// Byte-swapped RGB565 (SPI panels want big-endian pixels).
static inline uint16_t rgb565(uint8_t r, uint8_t g, uint8_t b)
{
    uint16_t v = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
    return (uint16_t)((v >> 8) | (v << 8));
}
#define COL_BLACK   0x0000
#define COL_WHITE   0xFFFF

void display_init(void);
// Fill the screen with bg and show up to two centered lines (line2 may be NULL).
void display_status(const char *line1, const char *line2, uint16_t bg);

// One row of an itemized order. Both strings are UPPERCASE (the 5x7 font has no
// lowercase glyphs). name e.g. "2X NASI LEMAK", price e.g. "RM11.00".
typedef struct {
    const char *name;
    const char *price;
} order_line_t;

// Order screen: blue title bar, up to 5 itemized rows, blue TOTAL bar at bottom.
// Rows past the 5th are dropped (no scrolling yet). title e.g. "YOUR ORDER".
void display_order(const char *title, const order_line_t *lines, int count,
                   const char *total);

// Live-caption screen: colored speaker bar ("YOU"/"BOX") on top, then the text
// word-wrapped below. Text is uppercased for the font; overflow past the screen
// is dropped. Used to show what was heard / what is being said in realtime.
void display_caption(const char *speaker, uint16_t bar, const char *text);
