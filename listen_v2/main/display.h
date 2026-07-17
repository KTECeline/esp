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

// On-screen buttons. Only the confirm screen has any today.
typedef enum {
    BTN_NONE = 0,
    BTN_CANCEL,
    BTN_SEND,
} display_button_t;

// Confirm screen: like display_caption(), but the transcript area is shortened
// to fit CANCEL (red, left) and SEND (green, right) buttons along the bottom.
// The BOOT button still confirms — touch is an addition, not a replacement.
void display_confirm(const char *speaker, uint16_t bar, const char *text);

// Which button contains this point, in DISPLAY coordinates (touch.c converts
// from panel coordinates). Meaningful only while a display_confirm() screen is
// up — the caller tracks that. Geometry lives in display.c beside the drawing
// code so the buttons and their hit boxes can never drift apart.
display_button_t display_hit_test(int x, int y);

// Provisioning QR screen: modules is a size*size byte array (1 = black module),
// drawn centered on white with "JOIN <ssid>" / "PASS <psk>" text underneath.
void display_qr(const uint8_t *modules, int size, const char *ssid, const char *psk);
