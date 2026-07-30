// Anti-aliased proportional fonts for the BOX-3 UI, generated from Inter by
// tools/gen_ui_font.py. Each glyph is an 8-bit alpha bitmap; display.c blends
// them into its framebuffer, so lowercase and real letterforms both work (the
// old hand-drawn 5x7 font was uppercase-only and blocky when scaled).
#pragma once
#include <stdint.h>

typedef struct {
    uint8_t  w, h;      // alpha bitmap size (0x0 for blank glyphs like space)
    int8_t   dx, dy;    // offset from the pen x / from the top of the line box
    uint8_t  adv;       // pen advance
    uint32_t off;       // start of this glyph inside the font's alpha blob
} ui_glyph_t;

typedef struct {
    const ui_glyph_t *glyphs;   // indexed by (char - first)
    const uint8_t    *alpha;
    uint8_t first, last;        // inclusive ASCII range covered
    uint8_t ascent;             // baseline distance from the top of the line box
    uint8_t line_h;             // ascent + descent
    int8_t  track;              // extra pen advance per glyph (negative tightens)
} ui_font_t;

extern const ui_font_t F_LABEL;   // 13px SemiBold -- chips, small captions
extern const ui_font_t F_BODY;    // 17px Regular  -- wrapped transcript text
extern const ui_font_t F_ROW;     // 18px SemiBold -- order rows and prices
extern const ui_font_t F_HEAD;    // 26px Bold     -- titles, TOTAL, buttons
extern const ui_font_t F_HERO;    // 50px Bold     -- the big status word
