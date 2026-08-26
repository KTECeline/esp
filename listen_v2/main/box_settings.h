// Runtime-tunable behaviour for this box.
//
// Everything here used to be a #define in listen_v2.c. That made each one a
// reflash to change, which in practice meant nobody changed them: the
// voice-activity thresholds were measured once, in one room, and every box
// everywhere then used that room's numbers. A stall with a fan running and a
// quiet counter need different answers, and neither is a firmware release.
//
// So these live in NVS instead, pushed by the server (POST /settings, or the
// same path over the reverse channel) and applied on the next listen or
// session. The server owns the defaults and the documentation — see
// mcp-core/settings-spec.json — and this file owns the box's own opinion about
// what is survivable, which is why every field is clamped again here. A box
// that accepted silence_hold_ms=0 because something upstream miscalculated
// would stop recording the instant anyone paused for breath, and the only way
// out would be a reflash. Independent clamping is what keeps a bad push from
// bricking the interaction.
#pragma once
#include <stdbool.h>
#include <stdint.h>

// The recording buffer is allocated ONCE at boot for this many seconds of
// 16kHz/16-bit mono audio. listen.max_record_seconds may shorten a turn but can
// never exceed this — growing the ceiling really is a reflash, because it is a
// PSRAM allocation, not a timer.
#define BOX_MAX_RECORD_SECONDS_CEIL 20

typedef struct {
    // ---- Voice-activity auto-stop ----
    int32_t silence_hold_ms;        // quiet, after speech, before we stop
    int32_t silence_peak;           // int16 peak below which a chunk is "quiet"
    int32_t speech_confirm_chunks;  // loud chunks before speech counts as started
    int32_t max_record_seconds;     // hard cap on one turn
    float   mic_gain_db;            // input gain, applied per recording

    // ---- Session ----
    int32_t session_absent_ms;      // no sign of the customer before the session ends

    // ---- Screen ----
    int32_t badge_hold_ms;          // how long SENT/ERROR stays up
    int32_t help_max_ms;            // how long the help QR stays up
} box_settings_t;

// The live values. Never NULL — before box_settings_load() runs it returns the
// compiled-in defaults, so an early caller cannot read garbage.
const box_settings_t *box_settings(void);

// Restore from NVS. Call once in app_main, before anything reads a setting.
// A box that has never been pushed to keeps the defaults, which is the same
// behaviour it had when these were #defines.
void box_settings_load(void);

// Apply a pushed settings body: newline-separated "key|value" lines, using the
// server's dotted key names verbatim. Unknown keys are skipped (so an older box
// tolerates a newer server adding a knob), out-of-range values are clamped and
// logged rather than rejected, and the result is persisted only if something
// actually changed.
//
// MUTATES `body` in place while parsing, exactly like do_order().
// Returns the number of fields that changed.
int box_settings_apply(char *body, uint32_t revision);

// The settings revision this box has stored, or 0 if it has never been pushed
// to. Reported at /register so the server can tell which boxes are behind
// without asking each one for its whole configuration.
uint32_t box_settings_revision(void);
