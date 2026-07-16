#include "display.h"
#include <string.h>
#include <math.h>
#include "esp_log.h"
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

// ---- 5x7 font (columns in low 5 bits, bit4 = leftmost). Only the glyphs we
// use are filled; everything else is blank. Index = ASCII - 0x20. ----
static const uint8_t FONT[96][7] = {
    [' '-0x20] = {0,0,0,0,0,0,0},
    ['!'-0x20] = {0x04,0x04,0x04,0x04,0x04,0,0x04},
    ['\''-0x20] = {0x0C,0x04,0x08,0,0,0,0},
    [','-0x20] = {0,0,0,0,0,0x0C,0x08},
    ['.'-0x20] = {0,0,0,0,0,0x0C,0x0C},
    [':'-0x20] = {0,0x0C,0x0C,0,0x0C,0x0C,0},
    ['?'-0x20] = {0x0E,0x11,0x01,0x02,0x04,0,0x04},
    ['-'-0x20] = {0,0,0,0x1F,0,0,0},
    ['0'-0x20] = {0x0E,0x11,0x13,0x15,0x19,0x11,0x0E},
    ['1'-0x20] = {0x04,0x0C,0x04,0x04,0x04,0x04,0x0E},
    ['2'-0x20] = {0x0E,0x11,0x01,0x02,0x04,0x08,0x1F},
    ['3'-0x20] = {0x1E,0x01,0x01,0x0E,0x01,0x01,0x1E},
    ['4'-0x20] = {0x02,0x06,0x0A,0x12,0x1F,0x02,0x02},
    ['5'-0x20] = {0x1F,0x10,0x1E,0x01,0x01,0x11,0x0E},
    ['6'-0x20] = {0x0E,0x10,0x10,0x1E,0x11,0x11,0x0E},
    ['7'-0x20] = {0x1F,0x01,0x02,0x04,0x08,0x08,0x08},
    ['8'-0x20] = {0x0E,0x11,0x11,0x0E,0x11,0x11,0x0E},
    ['9'-0x20] = {0x0E,0x11,0x11,0x0F,0x01,0x01,0x0E},
    ['A'-0x20] = {0x0E,0x11,0x11,0x1F,0x11,0x11,0x11},
    ['B'-0x20] = {0x1E,0x11,0x11,0x1E,0x11,0x11,0x1E},
    ['C'-0x20] = {0x0F,0x10,0x10,0x10,0x10,0x10,0x0F},
    ['D'-0x20] = {0x1E,0x11,0x11,0x11,0x11,0x11,0x1E},
    ['E'-0x20] = {0x1F,0x10,0x10,0x1E,0x10,0x10,0x1F},
    ['F'-0x20] = {0x1F,0x10,0x10,0x1E,0x10,0x10,0x10},
    ['G'-0x20] = {0x0F,0x10,0x10,0x13,0x11,0x11,0x0F},
    ['H'-0x20] = {0x11,0x11,0x11,0x1F,0x11,0x11,0x11},
    ['I'-0x20] = {0x1F,0x04,0x04,0x04,0x04,0x04,0x1F},
    ['J'-0x20] = {0x01,0x01,0x01,0x01,0x01,0x11,0x0E},
    ['K'-0x20] = {0x11,0x12,0x14,0x18,0x14,0x12,0x11},
    ['L'-0x20] = {0x10,0x10,0x10,0x10,0x10,0x10,0x1F},
    ['M'-0x20] = {0x11,0x1B,0x15,0x15,0x11,0x11,0x11},
    ['N'-0x20] = {0x11,0x19,0x15,0x15,0x13,0x11,0x11},
    ['O'-0x20] = {0x0E,0x11,0x11,0x11,0x11,0x11,0x0E},
    ['P'-0x20] = {0x1E,0x11,0x11,0x1E,0x10,0x10,0x10},
    ['Q'-0x20] = {0x0E,0x11,0x11,0x11,0x15,0x12,0x0D},
    ['R'-0x20] = {0x1E,0x11,0x11,0x1E,0x14,0x12,0x11},
    ['S'-0x20] = {0x0F,0x10,0x10,0x0E,0x01,0x01,0x1E},
    ['T'-0x20] = {0x1F,0x04,0x04,0x04,0x04,0x04,0x04},
    ['U'-0x20] = {0x11,0x11,0x11,0x11,0x11,0x11,0x0E},
    ['V'-0x20] = {0x11,0x11,0x11,0x11,0x11,0x0A,0x04},
    ['W'-0x20] = {0x11,0x11,0x11,0x15,0x15,0x1B,0x11},
    ['X'-0x20] = {0x11,0x11,0x0A,0x04,0x0A,0x11,0x11},
    ['Y'-0x20] = {0x11,0x11,0x0A,0x04,0x04,0x04,0x04},
    ['Z'-0x20] = {0x1F,0x01,0x02,0x04,0x08,0x10,0x1F},
};

// Small scratch buffers (internal RAM — no PSRAM needed).
static uint16_t s_band[LCD_W * 16];      // for background fills
static uint16_t s_cell[30 * 42];         // one char at scale up to 6

static void fill_screen(uint16_t color)
{
    for (int i = 0; i < LCD_W * 16; i++) s_band[i] = color;
    for (int y = 0; y < LCD_H; y += 16) {
        int h = (y + 16 <= LCD_H) ? 16 : (LCD_H - y);
        esp_lcd_panel_draw_bitmap(s_panel, 0, y, LCD_W, y + h, s_band);
    }
}

// Solid-color rectangle, drawn in horizontal strips through s_band (cap = one
// full-width 16px band). Used for the order screen's title / total bars.
static void fill_rect(int x, int y, int w, int h, uint16_t color)
{
    if (w <= 0 || h <= 0) return;
    int cap = LCD_W * 16;
    int strip = cap / w;                 // max rows we can fill per draw
    if (strip < 1) strip = 1;
    int prime = w * (strip < h ? strip : h);
    for (int i = 0; i < prime; i++) s_band[i] = color;
    for (int yy = 0; yy < h; yy += strip) {
        int sh = (yy + strip <= h) ? strip : (h - yy);
        esp_lcd_panel_draw_bitmap(s_panel, x, y + yy, x + w, y + yy + sh, s_band);
    }
}

// Anti-aliased glyph rendering: bilinearly sample the coarse 5x7 bitmap
// instead of nearest-neighbor block-scaling it. Same glyph data as before
// (already confirmed legible) — this only smooths the edges so big scaled-up
// text doesn't look like a blocky LCD clock digit.
static inline int font_bit(const uint8_t *g, int col, int row)
{
    if (col < 0 || col > 4 || row < 0 || row > 6) return 0;   // fades at edges
    return (g[row] & (1 << (4 - col))) ? 1 : 0;
}

static inline uint16_t swap16(uint16_t v) { return (uint16_t)((v >> 8) | (v << 8)); }

// t in [0,1]: 0 -> bg, 1 -> fg, blended per RGB565 channel.
static uint16_t blend_color(uint16_t bg_sw, uint16_t fg_sw, float t)
{
    if (t <= 0.0f) return bg_sw;
    if (t >= 1.0f) return fg_sw;
    uint16_t bg = swap16(bg_sw), fg = swap16(fg_sw);
    int br = (bg >> 11) & 0x1F, bgn = (bg >> 5) & 0x3F, bb = bg & 0x1F;
    int fr = (fg >> 11) & 0x1F, fgn = (fg >> 5) & 0x3F, fb = fg & 0x1F;
    int r = br + (int)((fr - br) * t + 0.5f);
    int gg = bgn + (int)((fgn - bgn) * t + 0.5f);
    int b = bb + (int)((fb - bb) * t + 0.5f);
    return swap16((uint16_t)((r << 11) | (gg << 5) | b));
}

static void draw_char(int x, int y, int scale, uint16_t fg, uint16_t bg, char c)
{
    if (c < 0x20 || c > 0x7F) c = ' ';
    const uint8_t *g = FONT[c - 0x20];
    int cw = 5 * scale, ch = 7 * scale;
    for (int py = 0; py < ch; py++) {
        float fy = (py + 0.5f) / scale;
        int j0 = (int)floorf(fy - 0.5f);
        float wy = (fy - 0.5f) - j0;
        for (int px = 0; px < cw; px++) {
            float fx = (px + 0.5f) / scale;
            int i0 = (int)floorf(fx - 0.5f);
            float wx = (fx - 0.5f) - i0;
            float v00 = font_bit(g, i0,     j0);
            float v10 = font_bit(g, i0 + 1, j0);
            float v01 = font_bit(g, i0,     j0 + 1);
            float v11 = font_bit(g, i0 + 1, j0 + 1);
            float top = v00 + (v10 - v00) * wx;
            float bot = v01 + (v11 - v01) * wx;
            float val = top + (bot - top) * wy;
            s_cell[py * cw + px] = blend_color(bg, fg, val);
        }
    }
    esp_lcd_panel_draw_bitmap(s_panel, x, y, x + cw, y + ch, s_cell);
}

static void draw_text_centered(int y, int scale, uint16_t fg, uint16_t bg, const char *s)
{
    int len = strlen(s);
    int adv = 6 * scale;                 // 5 cols + 1 spacing
    int width = len * adv - scale;
    int x = (LCD_W - width) / 2;
    if (x < 0) x = 0;
    for (int i = 0; i < len; i++) draw_char(x + i * adv, y, scale, fg, bg, s[i]);
}

static void draw_text_left(int x, int y, int scale, uint16_t fg, uint16_t bg, const char *s)
{
    int adv = 6 * scale;
    for (int i = 0; s[i]; i++) draw_char(x + i * adv, y, scale, fg, bg, s[i]);
}

// Right edge of the text sits at x_right (used for prices / the total).
static void draw_text_right(int x_right, int y, int scale, uint16_t fg, uint16_t bg, const char *s)
{
    int adv = 6 * scale;
    int width = (int)strlen(s) * adv - scale;
    int x = x_right - width;
    if (x < 0) x = 0;
    draw_text_left(x, y, scale, fg, bg, s);
}

void display_status(const char *line1, const char *line2, uint16_t bg)
{
    if (!s_panel) return;
    fill_screen(bg);
    if (line1) draw_text_centered(line2 ? 70 : 100, 6, COL_WHITE, bg, line1);
    if (line2) draw_text_centered(160, 3, COL_WHITE, bg, line2);
}

void display_order(const char *title, const order_line_t *lines, int count,
                   const char *total)
{
    if (!s_panel) return;
    const uint16_t blue = rgb565(0, 90, 160);
    const int TITLE_H = 34;
    const int TOTAL_H = 44;

    fill_screen(COL_BLACK);

    // Title bar (blue) with centered title.
    fill_rect(0, 0, LCD_W, TITLE_H, blue);
    draw_text_centered(TITLE_H / 2 - 10, 3, COL_WHITE, blue, title ? title : "ORDER");

    // Itemized rows: "QTYx NAME" left, price right. Up to 5 fit above the total.
    const int ROW_MAX = 5;
    int y = TITLE_H + 16;
    for (int i = 0; i < count && i < ROW_MAX; i++) {
        if (lines[i].name)  draw_text_left(12, y, 2, COL_WHITE, COL_BLACK, lines[i].name);
        if (lines[i].price) draw_text_right(LCD_W - 12, y, 2, COL_WHITE, COL_BLACK, lines[i].price);
        y += 26;
    }

    // Total bar (blue) pinned to the bottom.
    int ty = LCD_H - TOTAL_H;
    fill_rect(0, ty, LCD_W, TOTAL_H, blue);
    draw_text_left(12, ty + 11, 3, COL_WHITE, blue, "TOTAL");
    if (total) draw_text_right(LCD_W - 12, ty + 11, 3, COL_WHITE, blue, total);
}

void display_caption(const char *speaker, uint16_t bar, const char *text)
{
    if (!s_panel) return;
    const int BAR_H = 30;

    fill_screen(COL_BLACK);
    fill_rect(0, 0, LCD_W, BAR_H, bar);
    draw_text_left(10, 5, 3, COL_WHITE, bar, speaker ? speaker : "");

    if (!text) return;

    // Word-wrap the body at scale 2, uppercasing as we go (no lowercase glyphs).
    const int SC = 2, ADV = 6 * SC, LH = 20, X0 = 8, Y0 = BAR_H + 12;
    const int max_cols  = (LCD_W - 2 * X0) / ADV;     // ~25 chars/line
    const int max_lines = (LCD_H - Y0 - 4) / LH;      // ~9 lines

    char line[48];
    int ll = 0, ly = Y0, used = 0;
    const char *p = text;
    while (*p && used < max_lines) {
        while (*p == ' ') p++;
        if (!*p) break;
        const char *w = p;
        int fullwl = 0;
        while (w[fullwl] && w[fullwl] != ' ') fullwl++;
        p = w + fullwl;
        int drawwl = fullwl > max_cols ? max_cols : fullwl;   // hard-break long words
        int need = (ll ? ll + 1 : 0) + drawwl;
        if (ll && need > max_cols) {
            line[ll] = 0;
            draw_text_left(X0, ly, SC, COL_WHITE, COL_BLACK, line);
            ly += LH; used++; ll = 0;
            if (used >= max_lines) break;
        }
        if (ll && ll < (int)sizeof(line) - 1) line[ll++] = ' ';
        for (int i = 0; i < drawwl && ll < (int)sizeof(line) - 1; i++) {
            char c = w[i];
            if (c >= 'a' && c <= 'z') c -= 32;
            line[ll++] = c;
        }
    }
    if (ll && used < max_lines) {
        line[ll] = 0;
        draw_text_left(X0, ly, SC, COL_WHITE, COL_BLACK, line);
    }
}

// Provisioning QR screen: white background (doubles as the QR quiet zone),
// black modules, SSID + password in plain text underneath for phones whose
// camera can't read WiFi QR codes. `modules` is size*size bytes, 1 = black.
void display_qr(const uint8_t *modules, int size, const char *ssid, const char *psk)
{
    if (!s_panel || size <= 0) return;
    fill_screen(COL_WHITE);

    int scale = 168 / size;                    // target ~170px on the 240px-tall screen
    if (scale < 2) scale = 2;
    if (scale > 6) scale = 6;
    int px = size * scale;
    int x0 = (LCD_W - px) / 2;
    int y0 = 8;

    // One band per module row (width px, height scale) through s_band — same
    // strip-blit pattern as fill_rect. Worst case 174*6 pixels, well under
    // s_band's LCD_W*16 capacity.
    for (int my = 0; my < size; my++) {
        for (int mx = 0; mx < size; mx++) {
            uint16_t c = modules[my * size + mx] ? COL_BLACK : COL_WHITE;
            for (int xx = 0; xx < scale; xx++) s_band[mx * scale + xx] = c;
        }
        for (int yy = 1; yy < scale; yy++) {
            memcpy(&s_band[yy * px], s_band, px * sizeof(uint16_t));
        }
        esp_lcd_panel_draw_bitmap(s_panel, x0, y0 + my * scale,
                                  x0 + px, y0 + (my + 1) * scale, s_band);
    }

    char line[48];
    snprintf(line, sizeof(line), "JOIN %s", ssid ? ssid : "");
    draw_text_centered(y0 + px + 8, 2, COL_BLACK, COL_WHITE, line);
    snprintf(line, sizeof(line), "PASS %s", psk ? psk : "");
    draw_text_centered(y0 + px + 30, 2, COL_BLACK, COL_WHITE, line);
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
        .max_transfer_sz = LCD_W * 40 * 2,
    };
    ESP_ERROR_CHECK(spi_bus_initialize(LCD_HOST, &buscfg, SPI_DMA_CH_AUTO));

    esp_lcd_panel_io_handle_t io = NULL;
    esp_lcd_panel_io_spi_config_t io_cfg = {
        .dc_gpio_num = PIN_LCD_DC, .cs_gpio_num = PIN_LCD_CS,
        .pclk_hz = LCD_CLK_HZ, .lcd_cmd_bits = 8, .lcd_param_bits = 8,
        .spi_mode = 0, .trans_queue_depth = 10,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)LCD_HOST, &io_cfg, &io));

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
    ESP_LOGI(TAG, "display ready");
}
