#include "display.h"
#include "ui_font.h"
#include <string.h>
#include <stdio.h>
#include <stdbool.h>
#include <math.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "esp_log.h"
#include "esp_attr.h"
#include "esp_heap_caps.h"
#include "esp_memory_utils.h"   // esp_ptr_external_ram
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_vendor.h"   // esp_lcd_new_panel_st7789
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_ili9341.h"        // esp_lcd_new_panel_ili9341 + vendor cfg
#include "driver/i2c_master.h"

// ---- BOX-3 LCD wiring ----
#define LCD_HOST        SPI3_HOST
#define PIN_LCD_PCLK    7
#define PIN_LCD_MOSI    6
#define PIN_LCD_DC      4
#define PIN_LCD_CS      5
#define PIN_LCD_RST     48
#define PIN_LCD_BL      47
#define LCD_W           320
#define LCD_H           240
#define LCD_CLK_HZ      (40 * 1000 * 1000)
#define TT21100_ADDR    0x24   // if present -> ST7789 panel, else ILI9341

static const char *TAG = "display";
static esp_lcd_panel_handle_t s_panel = NULL;

// ILI9341 vendor init (from the BOX-3 BSP).
static const ili9341_lcd_init_cmd_t ili_init[] = {
    {0xC8, (uint8_t []){0xFF, 0x93, 0x42}, 3, 0},
    {0xC0, (uint8_t []){0x0E, 0x0E}, 2, 0},
    {0xC5, (uint8_t []){0xD0}, 1, 0},
    {0xC1, (uint8_t []){0x02}, 1, 0},
    {0xB4, (uint8_t []){0x02}, 1, 0},
    {0xE0, (uint8_t []){0x00,0x03,0x08,0x06,0x13,0x09,0x39,0x39,0x48,0x02,0x0a,0x08,0x17,0x17,0x0F}, 15, 0},
    {0xE1, (uint8_t []){0x00,0x28,0x29,0x01,0x0d,0x03,0x3f,0x33,0x52,0x04,0x0f,0x0e,0x37,0x38,0x0F}, 15, 0},
    {0xB1, (uint8_t []){0x00,0x1B}, 2, 0},
    {0x36, (uint8_t []){0x08}, 1, 0},
    {0x3A, (uint8_t []){0x55}, 1, 0},
    {0xB7, (uint8_t []){0x06}, 1, 0},
    {0x11, (uint8_t []){0}, 0x80, 0},
    {0x29, (uint8_t []){0}, 0x80, 0},
    {0, (uint8_t []){0}, 0xff, 0},
};

// ---- Interior palette (public semantic colors live in display.h) ----------
// The background is TRUE BLACK, not a warm charcoal, and that is deliberate.
// This panel's black point is blue-violet, and a near-black warm grey sits at
// ~15% brightness where the panel's cast completely swamps the encoded hue --
// on real glass it reads as purple mud, not charcoal (confirmed on hardware;
// lifting the values only made the violet brighter). Only at 0,0,0 does the
// panel go properly dark. The warmth therefore has to come from the surfaces
// and the amber, which are bright enough to hold their hue.
#define C_SURFACE   rgb565(0x45, 0x3A, 0x30)   // R8  G14 B6  -- raised card
#define C_SURFACE_HI rgb565(0x55, 0x48, 0x3C)  // R10 G18 B7  -- outlined button
#define C_LINE      rgb565(0x6B, 0x5A, 0x47)   // R13 G22 B8  -- hairlines, rules
#define C_TEXT      rgb565(0xF5, 0xEF, 0xE6)   // cream body text
#define C_MUTED     rgb565(0xA7, 0x9B, 0x8C)   // secondary text
#define C_ON_ACCENT rgb565(0x2A, 0x18, 0x06)   // near-black warm, for amber fills
#define C_CHIP      rgb565(0x3E, 0x26, 0x0B)   // darkened amber, header chip
#define C_ERR_SOFT  rgb565(0xF0, 0x8A, 0x86)   // red text on dark
#define C_ERR_EDGE  rgb565(0x7A, 0x33, 0x30)   // red outline on dark

// A gradient's darker end: scale a color's channels to `pct` percent.
static uint16_t shade(uint16_t c, int pct)
{
    int r = ((c >> 11) & 0x1F) * pct / 100;
    int g = ((c >> 5) & 0x3F) * pct / 100;
    int b = (c & 0x1F) * pct / 100;
    return (uint16_t)((r << 11) | (g << 5) | b);
}

// ---- Framebuffer ----------------------------------------------------------
// Every screen is composed off-panel and blitted once, so partial redraws never
// show. The framebuffer holds native RGB565 (the drawing math wants that order);
// flush() byte-swaps through a small internal DMA-capable staging band, which
// also keeps us independent of whether PSRAM is DMA-reachable.
#define BAND_H 24
static uint16_t *s_fb;                                           // LCD_W*LCD_H
static uint16_t s_band[LCD_W * BAND_H] __attribute__((aligned(4)));
static SemaphoreHandle_t s_band_free;      // given when a band's DMA completes

static bool IRAM_ATTR on_color_trans_done(esp_lcd_panel_io_handle_t io,
                                          esp_lcd_panel_io_event_data_t *ev,
                                          void *arg)
{
    BaseType_t woken = pdFALSE;
    xSemaphoreGiveFromISR(s_band_free, &woken);
    return woken == pdTRUE;
}

// Blend `c` over the pixel at coverage `a` (0 = keep, 255 = replace).
static inline void blend(int x, int y, uint16_t c, uint8_t a)
{
    if (a == 0 || x < 0 || y < 0 || x >= LCD_W || y >= LCD_H) return;
    uint16_t *p = &s_fb[y * LCD_W + x];
    if (a == 255) { *p = c; return; }
    uint32_t d = *p, ia = 255u - a;
    uint32_t r = (((c >> 11) & 0x1F) * a + ((d >> 11) & 0x1F) * ia + 127) / 255;
    uint32_t g = (((c >> 5) & 0x3F) * a + ((d >> 5) & 0x3F) * ia + 127) / 255;
    uint32_t b = ((c & 0x1F) * a + (d & 0x1F) * ia + 127) / 255;
    *p = (uint16_t)((r << 11) | (g << 5) | b);
}

// esp_lcd_panel_draw_bitmap() is ASYNCHRONOUS: it queues a DMA transfer and
// returns. Since every band is staged through the same s_band, the next band
// must not be written until the previous transfer has actually read it -- the
// byte-swap loop takes ~100us while the transfer takes ~3ms, so without this
// wait the CPU queues all ten bands almost instantly and most of them DMA
// whatever happens to be in the buffer at the time. That looks like duplicated
// or blank regions on screen, not like a subtle glitch.
static void flush(void)
{
    for (int y = 0; y < LCD_H; y += BAND_H) {
        int h = (y + BAND_H <= LCD_H) ? BAND_H : (LCD_H - y);
        const uint16_t *src = &s_fb[y * LCD_W];
        int n = h * LCD_W;
        for (int i = 0; i < n; i++) {
            uint16_t v = src[i];
            s_band[i] = (uint16_t)((v >> 8) | (v << 8));   // panel wants big-endian
        }
        esp_lcd_panel_draw_bitmap(s_panel, 0, y, LCD_W, y + h, s_band);
        xSemaphoreTake(s_band_free, portMAX_DELAY);        // transfer has read it
    }
}

static void rect(int x, int y, int w, int h, uint16_t c)
{
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > LCD_W) w = LCD_W - x;
    if (y + h > LCD_H) h = LCD_H - y;
    for (int yy = y; yy < y + h; yy++) {
        uint16_t *row = &s_fb[yy * LCD_W + x];
        for (int xx = 0; xx < w; xx++) row[xx] = c;
    }
}

// Per-channel lerp in 5/6/5 space; good enough over the short spans we use.
static uint16_t mix(uint16_t a, uint16_t b, int t /* 0..255 */)
{
    int ar = (a >> 11) & 0x1F, ag = (a >> 5) & 0x3F, ab = a & 0x1F;
    int br = (b >> 11) & 0x1F, bg = (b >> 5) & 0x3F, bb = b & 0x1F;
    int r = ar + (br - ar) * t / 255;
    int g = ag + (bg - ag) * t / 255;
    int bl = ab + (bb - ab) * t / 255;
    return (uint16_t)((r << 11) | (g << 5) | bl);
}

static void vgrad(int x, int y, int w, int h, uint16_t top, uint16_t bot)
{
    for (int i = 0; i < h; i++) {
        rect(x, y + i, w, 1, mix(top, bot, h > 1 ? i * 255 / (h - 1) : 0));
    }
}

// Rounded rectangle with anti-aliased corners, optionally vertically graded.
// Coverage in a corner is (r + 0.5 - distance from the corner's center circle).
static void round_rect(int x, int y, int w, int h, int r, uint16_t top, uint16_t bot)
{
    if (w <= 0 || h <= 0) return;
    if (r > w / 2) r = w / 2;
    if (r > h / 2) r = h / 2;
    for (int yy = 0; yy < h; yy++) {
        uint16_t c = (top == bot) ? top : mix(top, bot, h > 1 ? yy * 255 / (h - 1) : 0);
        int in_corner_band = (yy < r) || (yy >= h - r);
        if (!in_corner_band) { rect(x, y + yy, w, 1, c); continue; }
        float cy = (yy < r) ? (r - 0.5f - yy) : (yy - (h - r) + 0.5f);
        rect(x + r, y + yy, w - 2 * r, 1, c);
        for (int i = 0; i < r; i++) {
            float cx = r - 0.5f - i;
            float cov = (float)r + 0.5f - sqrtf(cx * cx + cy * cy);
            if (cov <= 0.0f) continue;
            uint8_t a = (cov >= 1.0f) ? 255 : (uint8_t)(cov * 255.0f);
            blend(x + i, y + yy, c, a);
            blend(x + w - 1 - i, y + yy, c, a);
        }
    }
}

// 1px rounded outline, drawn as a filled round rect punched out by the inset one.
// Cheap and exact enough at these radii, and avoids a second AA path.
static void round_border(int x, int y, int w, int h, int r, uint16_t c, uint16_t inner)
{
    round_rect(x, y, w, h, r, c, c);
    round_rect(x + 1, y + 1, w - 2, h - 2, r - 1, inner, inner);
}

// Dotted horizontal rule -- reads as a menu separator without the heaviness of
// a solid line at this contrast.
static void dots(int x, int y, int w, uint16_t c, int on, int off)
{
    for (int i = 0; i < w; i += on + off) {
        int run = (i + on <= w) ? on : (w - i);
        rect(x + i, y, run, 1, c);
    }
}

// ---- Text ----------------------------------------------------------------
static const ui_glyph_t *glyph_of(const ui_font_t *f, char c)
{
    unsigned u = (unsigned char)c;
    if (u < f->first || u > f->last) u = '?';
    return &f->glyphs[u - f->first];
}

static int text_w(const ui_font_t *f, const char *s)
{
    if (!s || !*s) return 0;
    int w = 0;
    for (const char *p = s; *p; p++) w += glyph_of(f, *p)->adv + f->track;
    return w - f->track;                      // no trailing tracking
}

// `y` is the top of the line box; glyph dy is measured down from there.
static void text(int x, int y, const ui_font_t *f, uint16_t c, const char *s)
{
    if (!s) return;
    for (const char *p = s; *p; p++) {
        const ui_glyph_t *g = glyph_of(f, *p);
        const uint8_t *a = &f->alpha[g->off];
        for (int gy = 0; gy < g->h; gy++) {
            for (int gx = 0; gx < g->w; gx++) {
                uint8_t v = a[gy * g->w + gx];
                if (v) blend(x + g->dx + gx, y + g->dy + gy, c, v);
            }
        }
        x += g->adv + f->track;
    }
}

static void text_center(int x0, int w, int y, const ui_font_t *f, uint16_t c,
                        const char *s)
{
    int tw = text_w(f, s);
    int x = x0 + (w - tw) / 2;
    text(x < x0 ? x0 : x, y, f, c, s);
}

static void text_right(int x_right, int y, const ui_font_t *f, uint16_t c,
                       const char *s)
{
    int x = x_right - text_w(f, s);
    text(x < 0 ? 0 : x, y, f, c, s);
}

// Draw `s` but never wider than max_w; overlong text loses its tail to "..".
static void text_clipped(int x, int y, const ui_font_t *f, uint16_t c,
                         const char *s, int max_w)
{
    if (!s) return;
    if (text_w(f, s) <= max_w) { text(x, y, f, c, s); return; }
    char buf[64];
    int ell = text_w(f, "..");
    size_t n = 0;
    int w = 0;
    while (s[n] && n < sizeof(buf) - 3) {
        int adv = glyph_of(f, s[n])->adv + f->track;
        if (w + adv + ell > max_w) break;
        w += adv;
        buf[n] = s[n];
        n++;
    }
    buf[n] = '.'; buf[n + 1] = '.'; buf[n + 2] = 0;
    text(x, y, f, c, buf);
}

// Largest of three fonts (biggest first) whose rendering of `s` fits max_w.
static const ui_font_t *fit(const char *s, int max_w, const ui_font_t *big,
                            const ui_font_t *mid, const ui_font_t *small)
{
    if (text_w(big, s) <= max_w) return big;
    if (text_w(mid, s) <= max_w) return mid;
    return small;
}

// ---- Screens -------------------------------------------------------------
// Flat, not graded: a full-screen gradient this subtle is invisible head-on and
// turns into a hard bright/dark split when the screen is viewed off-axis, which
// looks like half the screen failed to draw.
static void backdrop(void)
{
    rect(0, 0, LCD_W, LCD_H, COL_BLACK);
}

void display_status(const char *line1, const char *line2, uint16_t accent)
{
    if (!s_fb) return;
    backdrop();
    rect(0, 0, LCD_W, 3, accent);                 // accent rule along the top

    const int MARGIN = 16, AVAIL = LCD_W - 2 * MARGIN;

    // Spacing is measured off line1's baseline, not its line box: the hero font
    // carries 13px of unused descent that would otherwise read as a gap.
    if (line1 && line2) {
        const ui_font_t *f1 = fit(line1, AVAIL, &F_HERO, &F_HEAD, &F_ROW);
        // line2 is picked from the sizes strictly below line1's, so a long line1
        // that fell back to F_HEAD doesn't end up the same size as its subtitle.
        const ui_font_t *f2 = (f1 == &F_HERO) ? fit(line2, AVAIL, &F_HEAD, &F_ROW, &F_LABEL)
                            : (f1 == &F_HEAD) ? fit(line2, AVAIL, &F_ROW, &F_LABEL, &F_LABEL)
                                              : &F_LABEL;
        int block = f1->ascent + 10 + f2->line_h;
        int y = (LCD_H - block) / 2 - 4;
        text_center(MARGIN, AVAIL, y, f1, C_TEXT, line1);
        text_center(MARGIN, AVAIL, y + f1->ascent + 10, f2, accent, line2);
    } else if (line1) {
        const ui_font_t *f1 = fit(line1, AVAIL, &F_HERO, &F_HEAD, &F_ROW);
        int y = (LCD_H - f1->ascent) / 2 - 12;
        text_center(MARGIN, AVAIL, y, f1, C_TEXT, line1);
        round_rect(LCD_W / 2 - 26, y + f1->ascent + 14, 52, 4, 2, accent, accent);
    }
    flush();
}

void display_order(const char *title, const order_line_t *lines, int count,
                   const char *total)
{
    if (!s_fb) return;
    const int HEAD_H = 44, ROW_H = 26, ROW_MAX = 5;
    const int CARD_H = 42, CARD_Y = LCD_H - CARD_H - 8;   // 190
    const uint16_t accent = COL_ACCENT, accent_dk = shade(COL_ACCENT, 68);

    backdrop();

    // Header: amber gradient, title left, item count in a darkened chip right.
    vgrad(0, 0, LCD_W, HEAD_H, accent, accent_dk);
    rect(0, HEAD_H - 1, LCD_W, 1, shade(accent, 50));
    char chip[16];
    snprintf(chip, sizeof(chip), "%d %s", count, count == 1 ? "ITEM" : "ITEMS");
    int chip_w = text_w(&F_LABEL, chip) + 20;
    int chip_x = LCD_W - 14 - chip_w;
    round_rect(chip_x, (HEAD_H - 22) / 2, chip_w, 22, 11, C_CHIP, C_CHIP);
    text_center(chip_x, chip_w, (HEAD_H - 22) / 2 + 3, &F_LABEL, accent, chip);
    text_clipped(16, (HEAD_H - F_HEAD.line_h) / 2, &F_HEAD, C_ON_ACCENT,
                 title ? title : "ORDER", chip_x - 26);

    // Itemized rows: name left (clipped so it can never reach the price),
    // price right, dotted rule under every row but the last.
    // When the order overflows, the last slot carries the "+N more" note rather
    // than a row, so the two can never land on top of each other.
    int shown = count, overflow = count > ROW_MAX;
    if (overflow) shown = ROW_MAX - 1;
    int y = HEAD_H + 10;
    for (int i = 0; i < shown; i++) {
        int price_w = lines[i].price ? text_w(&F_ROW, lines[i].price) : 0;
        text_clipped(16, y, &F_ROW, C_TEXT, lines[i].name,
                     LCD_W - 32 - price_w - 12);
        if (lines[i].price) text_right(LCD_W - 16, y, &F_ROW, accent, lines[i].price);
        if (overflow || i < shown - 1) dots(16, y + ROW_H - 2, LCD_W - 32, C_LINE, 2, 3);
        y += ROW_H;
    }
    if (count == 0) {
        text_center(0, LCD_W, HEAD_H + 40, &F_BODY, C_MUTED, "No items yet");
    } else if (overflow) {
        char more[24];
        snprintf(more, sizeof(more), "+%d more", count - shown);
        text(16, y + 3, &F_LABEL, C_MUTED, more);
    }

    // Rounded amber TOTAL card, pinned to the bottom.
    round_rect(8, CARD_Y, LCD_W - 16, CARD_H, 12, accent, accent_dk);
    int ty = CARD_Y + (CARD_H - F_HEAD.line_h) / 2;
    text(22, ty, &F_HEAD, C_ON_ACCENT, "TOTAL");
    if (total) text_right(LCD_W - 22, ty, &F_HEAD, C_ON_ACCENT, total);
    flush();
}

#define WRAP_LH (F_BODY.line_h + 3)
// Height a wrapped block of `n` lines occupies (the last line contributes ink,
// not leading), so a card can be sized to its text.
static int wrap_height(int n) { return n ? n * WRAP_LH - (WRAP_LH - F_BODY.line_h) : 0; }

// Word-wrap `s` into a box `w` wide, preserving case (the old 5x7 font forced
// uppercase; Inter has real lowercase). Stops after max_lines; the rest is
// dropped. Returns the number of lines used -- callers measure with draw=false,
// size and place the card, then draw with the same max_lines so both passes
// agree on where the breaks fall.
static int wrap_text(const char *s, int x0, int y0, int w, int max_lines, bool draw)
{
    if (!s || max_lines <= 0) return 0;
    const ui_font_t *f = &F_BODY;
    const int LH = WRAP_LH;

    char line[96];
    int ll = 0, ly = y0, used = 0, lw = 0;
    const char *p = s;
    while (*p && used < max_lines) {
        while (*p == ' ') p++;
        if (!*p) break;
        const char *word = p;
        int wl = 0;
        while (word[wl] && word[wl] != ' ') wl++;
        p = word + wl;

        char buf[96];
        if (wl > (int)sizeof(buf) - 1) wl = sizeof(buf) - 1;
        memcpy(buf, word, wl);
        buf[wl] = 0;
        int bw = text_w(f, buf);
        int space_w = glyph_of(f, ' ')->adv + f->track;

        // A word too wide for a whole line (a URL, or speech-to-text running
        // words together) is hard-broken instead of spilling past the card.
        while (bw > w && used < max_lines) {
            if (ll) {                               // finish the current line first
                line[ll] = 0;
                if (draw) text(x0, ly, f, C_TEXT, line);
                ly += LH; used++; ll = 0; lw = 0;
                if (used >= max_lines) break;
            }
            int take = 0, tw = 0;
            while (take < wl) {
                int adv = glyph_of(f, buf[take])->adv + f->track;
                if (tw + adv > w) break;
                tw += adv; take++;
            }
            if (take == 0) take = 1;                // pathologically narrow box
            memcpy(line, buf, take);
            line[take] = 0;
            if (draw) text(x0, ly, f, C_TEXT, line);
            ly += LH; used++;
            memmove(buf, buf + take, wl - take + 1);
            wl -= take;
            bw = text_w(f, buf);
        }
        if (used >= max_lines) break;
        if (wl == 0) continue;

        if (ll && lw + space_w + bw > w) {          // break before this word
            line[ll] = 0;
            if (draw) text(x0, ly, f, C_TEXT, line);
            ly += LH; used++; ll = 0; lw = 0;
            if (used >= max_lines) break;
        }
        if (ll && ll < (int)sizeof(line) - 1) { line[ll++] = ' '; lw += space_w; }
        for (int i = 0; i < wl && ll < (int)sizeof(line) - 1; i++) line[ll++] = buf[i];
        lw += bw;
    }
    if (ll && used < max_lines) {
        line[ll] = 0;
        if (draw) text(x0, ly, f, C_TEXT, line);
        used++;
    }
    return used;
}

// Speaker pill + the card the transcript sits in. Returns the card's bottom.
static void caption_frame(const char *speaker, uint16_t bar, const char *s,
                          int card_bottom)
{
    backdrop();

    const char *who = speaker ? speaker : "";
    int pill_w = text_w(&F_LABEL, who) + 24;
    round_rect(12, 12, pill_w, 26, 13, bar, shade(bar, 78));
    text_center(12, pill_w, 12 + (26 - F_LABEL.line_h) / 2, &F_LABEL, C_TEXT, who);

    // The card hugs its text (measure pass, then draw), so a one-line reply is a
    // chat bubble rather than a mostly-empty panel, and it grows as text streams
    // in. A short bubble is centred in the free space instead of clinging to the
    // top, which otherwise leaves the screen looking half-drawn.
    const int CARD_Y = 48, PAD = 12, TEXT_W = LCD_W - 44;
    int avail = card_bottom - CARD_Y;
    int max_lines = (avail - 2 * PAD + (WRAP_LH - F_BODY.line_h)) / WRAP_LH;
    if (max_lines < 1) max_lines = 1;

    int lines = wrap_text(s, 0, 0, TEXT_W, max_lines, false);
    int th = wrap_height(lines);
    int card_h = th + 2 * PAD;
    if (card_h < 56) card_h = 56;
    if (card_h > avail) card_h = avail;
    int card_y = CARD_Y + (avail - card_h) / 2;

    round_border(8, card_y, LCD_W - 16, card_h, 14, C_LINE, C_SURFACE);
    wrap_text(s, 22, card_y + (card_h - th) / 2, TEXT_W, max_lines, true);
}

void display_caption(const char *speaker, uint16_t bar, const char *s)
{
    if (!s_fb) return;
    caption_frame(speaker, bar, s, LCD_H - 8);
    flush();
}

// ---- Confirm screen buttons -----------------------------------------------
// One definition of the geometry, used by both the renderer and the hit test.
#define BTN_H         46
#define BTN_W         140
#define BTN_Y         (LCD_H - BTN_H - 6)     // 188
#define BTN_CANCEL_X  8
#define BTN_SEND_X    (LCD_W - BTN_W - 8)     // 172

void display_confirm(const char *speaker, uint16_t bar, const char *s)
{
    if (!s_fb) return;
    caption_frame(speaker, bar, s, BTN_Y - 10);

    int ly = BTN_Y + (BTN_H - F_HEAD.line_h) / 2;
    // Cancel is outlined rather than a solid red slab: it keeps the red warning
    // without competing with SEND for attention.
    round_border(BTN_CANCEL_X, BTN_Y, BTN_W, BTN_H, 12, C_ERR_EDGE, C_SURFACE_HI);
    text_center(BTN_CANCEL_X, BTN_W, ly, &F_HEAD, C_ERR_SOFT, "CANCEL");
    round_rect(BTN_SEND_X, BTN_Y, BTN_W, BTN_H, 12, COL_OK, shade(COL_OK, 62));
    text_center(BTN_SEND_X, BTN_W, ly, &F_HEAD, C_TEXT, "SEND");
    flush();
}

display_button_t display_hit_test(int x, int y)
{
    if (y < BTN_Y || y > BTN_Y + BTN_H) return BTN_NONE;
    if (x >= BTN_CANCEL_X && x <= BTN_CANCEL_X + BTN_W) return BTN_CANCEL;
    if (x >= BTN_SEND_X && x <= BTN_SEND_X + BTN_W) return BTN_SEND;
    return BTN_NONE;
}

void display_qr(const uint8_t *modules, int size, const char *ssid, const char *psk)
{
    if (!s_fb || size <= 0) return;
    backdrop();

    int scale = 152 / size;                    // leaves room for two text lines
    if (scale < 2) scale = 2;
    if (scale > 6) scale = 6;
    int qr = size * scale;
    int card = qr + 20;                        // 10px white quiet zone all round
    int cx = (LCD_W - card) / 2, cy = 10;

    round_rect(cx, cy, card, card, 10, COL_WHITE, COL_WHITE);
    for (int my = 0; my < size; my++) {
        for (int mx = 0; mx < size; mx++) {
            if (!modules[my * size + mx]) continue;
            for (int yy = 0; yy < scale; yy++) {
                rect(cx + 10 + mx * scale, cy + 10 + my * scale + yy, scale, 1,
                     COL_BLACK);
            }
        }
    }

    char line[64];
    int ty = cy + card + 8;
    snprintf(line, sizeof(line), "JOIN %s", ssid ? ssid : "");
    text_center(0, LCD_W, ty, &F_ROW, C_TEXT, line);
    snprintf(line, sizeof(line), "PASS %s", psk ? psk : "");
    text_center(0, LCD_W, ty + F_ROW.line_h + 2, &F_ROW, COL_ACCENT, line);
    flush();
}

void display_init(void)
{
    // Backlight on (full brightness via plain GPIO).
    gpio_config_t bl = { .pin_bit_mask = 1ULL << PIN_LCD_BL, .mode = GPIO_MODE_OUTPUT };
    gpio_config(&bl);
    gpio_set_level(PIN_LCD_BL, 1);

    spi_bus_config_t buscfg = {
        .sclk_io_num = PIN_LCD_PCLK,
        .mosi_io_num = PIN_LCD_MOSI,
        .miso_io_num = -1, .quadwp_io_num = -1, .quadhd_io_num = -1,
        .max_transfer_sz = LCD_W * BAND_H * 2,
    };
    ESP_ERROR_CHECK(spi_bus_initialize(LCD_HOST, &buscfg, SPI_DMA_CH_AUTO));

    esp_lcd_panel_io_handle_t io = NULL;
    esp_lcd_panel_io_spi_config_t io_cfg = {
        .dc_gpio_num = PIN_LCD_DC, .cs_gpio_num = PIN_LCD_CS,
        .pclk_hz = LCD_CLK_HZ, .lcd_cmd_bits = 8, .lcd_param_bits = 8,
        .spi_mode = 0, .trans_queue_depth = 10,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)LCD_HOST, &io_cfg, &io));

    // flush() stages every band through one buffer, so it has to know when a
    // transfer has finished reading it. Created before any draw can happen.
    s_band_free = xSemaphoreCreateBinary();
    ESP_ERROR_CHECK(s_band_free ? ESP_OK : ESP_ERR_NO_MEM);
    esp_lcd_panel_io_callbacks_t io_cbs = { .on_color_trans_done = on_color_trans_done };
    ESP_ERROR_CHECK(esp_lcd_panel_io_register_event_callbacks(io, &io_cbs, NULL));

    esp_lcd_panel_dev_config_t panel_cfg = {
        .reset_gpio_num = PIN_LCD_RST,
        .flags.reset_active_high = 1,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_BGR,
        .bits_per_pixel = 16,
    };

    // Detect panel type via the touch controller (matches BSP logic).
    extern i2c_master_bus_handle_t bsp_i2c_bus(void);   // provided by main
    bool is_st7789 = false;
    i2c_master_bus_handle_t bus = bsp_i2c_bus();
    if (bus && i2c_master_probe(bus, TT21100_ADDR, 50) == ESP_OK) is_st7789 = true;

    if (is_st7789) {
        ESP_LOGI(TAG, "panel: ST7789");
        ESP_ERROR_CHECK(esp_lcd_new_panel_st7789(io, &panel_cfg, &s_panel));
    } else {
        ESP_LOGI(TAG, "panel: ILI9341");
        ili9341_vendor_config_t vc = { .init_cmds = ili_init,
                                       .init_cmds_size = sizeof(ili_init) / sizeof(ili_init[0]) };
        panel_cfg.vendor_config = &vc;
        ESP_ERROR_CHECK(esp_lcd_new_panel_ili9341(io, &panel_cfg, &s_panel));
    }

    ESP_ERROR_CHECK(esp_lcd_panel_reset(s_panel));
    ESP_ERROR_CHECK(esp_lcd_panel_init(s_panel));
    esp_lcd_panel_mirror(s_panel, true, true);
    ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(s_panel, true));

    // 150 KB of PSRAM. Nothing is DMA'd out of it directly -- flush() copies
    // through the internal staging band -- so plain SPIRAM is enough, with
    // internal RAM as a fallback. Without it every display_* call is a no-op,
    // which is survivable: the box is voice-first.
    s_fb = heap_caps_malloc(LCD_W * LCD_H * sizeof(uint16_t),
                            MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s_fb) s_fb = heap_caps_malloc(LCD_W * LCD_H * sizeof(uint16_t),
                                       MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (!s_fb) {
        ESP_LOGE(TAG, "framebuffer alloc failed -- display disabled");
        return;
    }
    ESP_LOGI(TAG, "display ready (framebuffer %s)",
             esp_ptr_external_ram(s_fb) ? "PSRAM" : "internal");
}
