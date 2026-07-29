// WiFi provisioning for the BOX-3: NVS-backed credentials + SoftAP captive
// portal, so a first-timer configures a box from their phone — no editing
// source, no reflashing. See ~/.claude plan "WiFi provisioning for first-timers".
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include "esp_err.h"

// ---- Immutable identity (never cleared, survives re-provisioning) ----------
// box_id: generated once from the STA MAC ("BOX-XXXX"), then persisted.
// Sent as X-Box-Id on every request; also the provisioning AP's SSID.
const char *prov_ensure_box_id(char *out, size_t out_len);
// ap_psk: 8 random chars generated once alongside box_id. WPA2 password of the
// provisioning AP — shown on the box's own screen, never needs memorizing.
const char *prov_ensure_ap_psk(char *out, size_t out_len);

// ---- Mutable credentials (cleared together by re-provisioning) -------------
// Returns false when no credentials are saved (fresh box / after WiFi reset).
bool prov_load_creds(char *ssid, size_t ssid_len, char *pass, size_t pass_len,
                     char *post_url, size_t url_len, char *box_name, size_t name_len);
esp_err_t prov_save_creds(const char *ssid, const char *pass,
                          const char *post_url, const char *box_name);
// Updates ONLY post_url, leaving WiFi credentials intact — used by POST /server
// so a box can be repointed at a moved server without re-provisioning.
esp_err_t prov_save_post_url(const char *post_url);
// Shared secret authenticating traffic between this box and its server.
// Delivered by the server's /server adopt push on first contact, then required
// on every inbound request. Returns false when none is stored (a fresh box, or
// one just factory-reset) — in which case the box accepts unauthenticated
// requests so it can be bootstrapped. Cleared by prov_erase_creds().
bool prov_load_fleet_token(char *out, size_t out_len);
esp_err_t prov_save_fleet_token(const char *token);
// Reverse-channel URL (ws:// or wss://). Empty = feature off, LAN push only.
// Pushed by the server alongside post_url, never typed in by hand.
bool prov_load_ws_url(char *out, size_t out_len);
esp_err_t prov_save_ws_url(const char *url);
// Where the on-screen help QR points. Stored rather than compiled in so the
// guide can be rehosted without reflashing; pushed by the server like ws_url.
bool prov_load_help_url(char *out, size_t out_len);
esp_err_t prov_save_help_url(const char *url);

// ---- Recovery gesture -------------------------------------------------------
// True when this boot followed the previous one closely enough to count as
// "RST tapped twice" — the gesture for "show me the setup guide". Call ONCE,
// early in app_main: it also arms the flag for the next boot and schedules its
// own disarm, so calling it twice would break the detection.
//
// Deliberately NVS-backed, not RTC-backed: RST pulls the chip enable pin low,
// which clears RTC memory, so an RTC flag would be missing exactly when needed.
bool prov_double_reset(void);

// Draw a QR of `url` with two caption lines beneath it. Returns false if the
// URL is empty or too long to encode at this screen's size (cap is QR v6),
// leaving the display untouched so the caller can fall back.
bool prov_show_url_qr(const char *url, const char *line1, const char *line2);
// Clears ssid/pass/post_url/box_name. box_id and ap_psk are NOT touched.
void prov_erase_creds(void);

// ---- Provisioning mode ------------------------------------------------------
// WPA2 SoftAP + captive portal + QR screen. Never returns: reboots after a
// successful save, otherwise alternates between a 15-minute portal window and
// an idle "tap BOOT to set up" screen. Requires the WiFi stack to be
// initialized (esp_wifi_init done, mode/state don't matter).
void start_provisioning_mode(void) __attribute__((noreturn));
