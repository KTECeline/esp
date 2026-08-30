// UI for the ESP32-S3-BOX-3 (ILI9341/ST7789 over SPI). No LVGL: display.c
// composes each screen into a PSRAM framebuffer with anti-aliased Inter glyphs
// (main/ui_font.h), rounded cards and gradients, then blits the frame in one
// pass so nothing flickers.
#pragma once
#include <stdint.h>
#include <stdbool.h>

// Native RGB565. display.c byte-swaps once per frame on the way to the panel,
// so every color here stays in the order the blending math wants.
static inline uint16_t rgb565(uint8_t r, uint8_t g, uint8_t b)
{
    return (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
}
#define COL_BLACK   0x0000
#define COL_WHITE   0xFFFF

// ---- Palette: warm restaurant dark. Deep charcoal ground, amber accent,
// cream text. Status colors stay semantic but are desaturated to sit in it. ---
#define COL_ACCENT  rgb565(0xE8, 0x93, 0x3A)   // amber: default / branded
#define COL_OK      rgb565(0x4F, 0xA9, 0x6A)   // green: sent, playing, done
#define COL_ERR     rgb565(0xD9, 0x53, 0x4F)   // red: failures, resets
#define COL_WARN    rgb565(0xE0, 0xA9, 0x3A)   // yellow: misconfigured, degraded
#define COL_INFO    rgb565(0x5A, 0x9E, 0xD6)   // blue: in-progress, neutral
#define COL_REC     rgb565(0xE5, 0x4B, 0x4B)   // red: recording

void display_init(void);

// Status screen: one big auto-fitted line, an optional smaller second line, and
// `accent` used for the top rule / second line / underline (NOT as a full-screen
// flood -- pass a palette color such as COL_OK or COL_ERR).
void display_status(const char *line1, const char *line2, uint16_t accent);

// Waiting-for-the-agent screen: three dots under "THINKING". Shown from the
// upload ack until the reply audio starts, so the gap while the server runs
// STT -> LLM -> TTS doesn't look like a frozen "SENT".
void display_thinking(void);

// Talking-back screen: a centred sound-wave motif under the word "SPEAKING".
// Held for the whole time the box is playing the agent's reply so a customer
// can see at a glance that it is answering them. No transcript -- subtitles are
// deliberately off on this box (see display_caption's note). Call it once per
// streamed reply chunk; successive calls shift the wave so it visibly pulses
// instead of sitting frozen.
void display_speaking(void);

// Stamps a small state pill in the top-right corner of whatever is currently on
// screen. Call it AFTER the screen it annotates — it composites over the
// existing framebuffer and flushes itself.
//   display_status("ORDER", "TAP TO START", COL_ACCENT);
//   display_badge("FREE", COL_OK);
void display_badge(const char *label, uint16_t color);

// Did (x,y) land on the badge drawn by the last display_badge() call? False
// once any other screen has painted over it. Includes a finger-sized margin.
bool display_badge_hit(int x, int y);

// One row of an itemized order. name e.g. "2X NASI LEMAK", price e.g. "RM11.00".
// Mixed case renders correctly now, so callers may send "2x Nasi Lemak".
typedef struct {
    const char *name;
    const char *price;
} order_line_t;

// Everything the order screen can show. Optional fields are NULL when unused,
// which is what selects the layout — one struct rather than a five-argument
// call that grows every time the screen gains a state.
typedef struct {
    const char *title;          // e.g. "YOUR ORDER", "PAY NOW"
    const order_line_t *lines;  // itemized rows; may be NULL when count == 0
    int count;
    const char *total;          // e.g. "RM13.50"; NULL hides the TOTAL card
    // Replaces the item list with a centred, wrapped message. This is how the
    // payment prompt reuses this screen instead of needing its own.
    const char *note;
    // Both set = a two-button bar along the bottom, and the TOTAL card moves up
    // to make room (which also costs two item rows — see ROW_MAX in display.c).
    // Either one NULL = no buttons, original full-height layout.
    const char *btn_left;       // outlined, left  (e.g. "ADD ORDER")
    const char *btn_right;      // solid green, right (e.g. "END + PAY")
} order_screen_t;

// Order screen: amber header with an item-count chip, rows separated by dotted
// rules, and a rounded amber TOTAL card. Rows past the limit are dropped (no
// scrolling yet) and summarized as "+N more".
void display_order(const order_screen_t *s);

// Live-caption screen: a rounded speaker pill ("YOU"/"BOX") tinted `bar`, then
// the text word-wrapped inside a raised card. Showed what was heard / what is
// being said in realtime.
//
// CURRENTLY UNUSED: subtitles are deliberately off on this box — do_caption()
// in listen_v2.c is a no-op and playback shows a wordless "SPEAKING" pill. Kept
// here so re-enabling captions is a one-line change, not a rewrite.
void display_caption(const char *speaker, uint16_t bar, const char *text);

// On-screen buttons. Only the order screen draws a pair now — display_hit_test()
// reports it only while that screen is actually up, so a caller can never act
// on a button the customer cannot see.
typedef enum {
    BTN_NONE = 0,
    BTN_ADD_ORDER,   // order screen, left
    BTN_END_PAY,     // order screen, right
} display_button_t;

// Which button contains this point, in DISPLAY coordinates (touch.c converts
// from panel coordinates). Returns BTN_NONE unless a screen with buttons is
// currently up, and the returned constant identifies WHICH screen's button was
// hit -- display.c remembers what it last drew, so a tap landing where a button
// used to be cannot be mistaken for a live one. Geometry lives in display.c
// beside the drawing code so buttons and hit boxes can never drift apart.
display_button_t display_hit_test(int x, int y);

// Provisioning QR screen: modules is a size*size byte array (1 = black module),
// drawn on a white rounded card (which doubles as the quiet zone) with
// "JOIN <ssid>" / "PASS <psk>" underneath for phones that can't read WiFi QRs.
void display_qr(const uint8_t *modules, int size, const char *ssid, const char *psk);
