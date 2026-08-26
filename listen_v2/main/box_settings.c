#include "box_settings.h"
#include <string.h>
#include <stdlib.h>
#include "esp_log.h"
#include "nvs.h"

static const char *TAG = "box_settings";

// Its own NVS namespace, NOT "prov". prov_erase_creds() clears that one to
// factory-reset WiFi, and tuning is not a credential — someone re-provisioning
// a box onto a new network should not silently lose the thresholds that were
// measured for the room it is standing in.
#define NVS_NS "boxset"
#define NVS_KEY "v1"

// The values these had as #defines, kept verbatim so a box with an empty NVS
// behaves exactly as it did before any of this existed. The reasoning behind
// each number lives in mcp-core/settings-spec.json, which is also what a person
// reads before changing one; duplicating it here would just be two places to
// disagree.
static box_settings_t s_set = {
    .silence_hold_ms       = 1200,
    .silence_peak          = 1500,
    .speech_confirm_chunks = 3,
    .max_record_seconds    = BOX_MAX_RECORD_SECONDS_CEIL,
    .mic_gain_db           = 30.0f,
    .session_absent_ms     = 30000,
    .badge_hold_ms         = 1500,
    .help_max_ms           = 60000,
};

static uint32_t s_revision = 0;

const box_settings_t *box_settings(void) { return &s_set; }
uint32_t box_settings_revision(void) { return s_revision; }

// Deliberately WIDER than the server's ranges. The server's job is to stop
// someone typing a silly number; this one's is to stop a value that would leave
// the box unusable and unreachable-by-tuning. Two different questions, so two
// different sets of bounds — and this side has to hold even if the push came
// from something that is not our server at all.
static int32_t clamp_i(int32_t v, int32_t lo, int32_t hi)
{
    return v < lo ? lo : (v > hi ? hi : v);
}

static float clamp_f(float v, float lo, float hi)
{
    return v < lo ? lo : (v > hi ? hi : v);
}

static void clamp_all(box_settings_t *s)
{
    // Never zero: a 0ms hold ends the turn on the first quiet chunk, which is
    // the pause between two words.
    s->silence_hold_ms       = clamp_i(s->silence_hold_ms, 100, 30000);
    // Never zero either — every chunk would count as speech and auto-stop
    // would never fire, leaving only the manual tap.
    s->silence_peak          = clamp_i(s->silence_peak, 50, 32767);
    s->speech_confirm_chunks = clamp_i(s->speech_confirm_chunks, 1, 100);
    // The ceiling is a hard physical limit, not a preference: the recording
    // buffer was sized for it at boot.
    s->max_record_seconds    = clamp_i(s->max_record_seconds, 2, BOX_MAX_RECORD_SECONDS_CEIL);
    s->mic_gain_db           = clamp_f(s->mic_gain_db, 0.0f, 60.0f);
    // A session that ends in under a second would reset the order between two
    // sentences. The radar reports motion, not presence, so this needs room.
    s->session_absent_ms     = clamp_i(s->session_absent_ms, 3000, 3600000);
    s->badge_hold_ms         = clamp_i(s->badge_hold_ms, 100, 30000);
    s->help_max_ms           = clamp_i(s->help_max_ms, 2000, 3600000);
}

void box_settings_load(void)
{
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READONLY, &h) != ESP_OK) {
        ESP_LOGI(TAG, "no saved settings — using built-in defaults");
        return;
    }
    box_settings_t stored;
    size_t len = sizeof(stored);
    esp_err_t err = nvs_get_blob(h, NVS_KEY, &stored, &len);
    if (err == ESP_OK && len == sizeof(stored)) {
        s_set = stored;
        // Clamped on the way IN as well as on the way in from the network: a
        // blob written by an older build, or one that survived a spec change,
        // must not be trusted just because it came off our own flash.
        clamp_all(&s_set);
        uint32_t rev = 0;
        nvs_get_u32(h, "rev", &rev);
        s_revision = rev;
        ESP_LOGI(TAG, "settings rev %u loaded: silence_hold=%dms peak=%d confirm=%d "
                      "max_rec=%ds gain=%.1fdB absent=%dms",
                 (unsigned)s_revision, (int)s_set.silence_hold_ms, (int)s_set.silence_peak,
                 (int)s_set.speech_confirm_chunks, (int)s_set.max_record_seconds,
                 s_set.mic_gain_db, (int)s_set.session_absent_ms);
    } else if (err == ESP_ERR_NVS_INVALID_LENGTH || (err == ESP_OK && len != sizeof(stored))) {
        // The struct grew or shrank across a firmware update. Defaults are the
        // honest answer — a partial memcpy would apply half of one setting to
        // another — and the next push from the server restores real values
        // within a minute, because it sweeps for boxes off the current revision.
        ESP_LOGW(TAG, "saved settings are from a different firmware layout — using defaults "
                      "until the server pushes again");
    } else {
        ESP_LOGI(TAG, "no saved settings — using built-in defaults");
    }
    nvs_close(h);
}

static void persist(void)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "cannot open NVS to save settings (%s) — they are live but will not "
                      "survive a reboot", esp_err_to_name(err));
        return;
    }
    if (nvs_set_blob(h, NVS_KEY, &s_set, sizeof(s_set)) == ESP_OK &&
        nvs_set_u32(h, "rev", s_revision) == ESP_OK) {
        nvs_commit(h);
    } else {
        ESP_LOGW(TAG, "settings write failed — they are live but will not survive a reboot");
    }
    nvs_close(h);
}

// One "key|value" line. Returns true if it changed something.
//
// Matching on the server's full dotted key rather than a shortened wire name is
// deliberate: the string in the firmware, the string in the JSON catalog and
// the string a person types into the tool are then all the same string, and a
// mismatch is impossible to introduce by editing only one side.
static bool apply_line(const char *key, const char *val, box_settings_t *out)
{
    #define SET_I(name, field)                                        \
        if (strcmp(key, name) == 0) {                                 \
            int32_t v = (int32_t)strtol(val, NULL, 10);               \
            if (out->field == v) return false;                        \
            out->field = v;                                           \
            return true;                                              \
        }
    #define SET_F(name, field)                                        \
        if (strcmp(key, name) == 0) {                                 \
            float v = strtof(val, NULL);                              \
            if (out->field == v) return false;                        \
            out->field = v;                                           \
            return true;                                              \
        }

    SET_I("listen.silence_hold_ms",       silence_hold_ms)
    SET_I("listen.silence_peak",          silence_peak)
    SET_I("listen.speech_confirm_chunks", speech_confirm_chunks)
    SET_I("listen.max_record_seconds",    max_record_seconds)
    SET_F("listen.mic_gain_db",           mic_gain_db)
    SET_I("session.absent_ms",            session_absent_ms)
    SET_I("screen.badge_hold_ms",         badge_hold_ms)
    SET_I("screen.help_max_ms",           help_max_ms)

    #undef SET_I
    #undef SET_F

    // Not a warning. A newer server pushing a knob this firmware predates is an
    // expected state during a rolling update, not a fault, and warning about it
    // would fill the log on every push for as long as the fleet is mixed.
    ESP_LOGD(TAG, "ignoring unknown setting \"%s\"", key);
    return false;
}

int box_settings_apply(char *body, uint32_t revision)
{
    // Staged in a copy so a body that turns out to be nonsense cannot leave the
    // box half-configured mid-conversation. Same all-or-nothing reasoning as
    // the server side, for the same reason: partially applied tuning is harder
    // to diagnose than none.
    box_settings_t next = s_set;
    int changed = 0;

    char *line = body;
    while (line && *line) {
        char *nl = strchr(line, '\n');
        if (nl) *nl = 0;
        // Tolerate CRLF: a hand-run curl from Windows should work.
        size_t len = strlen(line);
        while (len > 0 && (line[len - 1] == '\r' || line[len - 1] == ' ')) line[--len] = 0;

        char *sep = strchr(line, '|');
        if (sep) {
            *sep = 0;
            if (apply_line(line, sep + 1, &next)) changed++;
        } else if (len > 0) {
            ESP_LOGW(TAG, "malformed settings line (no '|'): \"%.40s\"", line);
        }

        line = nl ? nl + 1 : NULL;
    }

    clamp_all(&next);
    // Re-checked after clamping: a value that arrived out of range and clamped
    // back to what we already had is not a change, and must not cost an NVS
    // write on every sweep.
    if (memcmp(&next, &s_set, sizeof(next)) == 0) {
        // The revision still moves. Otherwise a box that agrees with the server
        // would report an old revision forever and be re-pushed on every sweep.
        if (revision != s_revision) {
            s_revision = revision;
            persist();
        }
        return 0;
    }

    s_set = next;
    s_revision = revision;
    persist();
    ESP_LOGI(TAG, "settings rev %u applied (%d changed): silence_hold=%dms peak=%d confirm=%d "
                  "max_rec=%ds gain=%.1fdB absent=%dms",
             (unsigned)s_revision, changed, (int)s_set.silence_hold_ms, (int)s_set.silence_peak,
             (int)s_set.speech_confirm_chunks, (int)s_set.max_record_seconds,
             s_set.mic_gain_db, (int)s_set.session_absent_ms);
    return changed;
}
