// NVS-backed WiFi provisioning + SoftAP captive portal for the BOX-3.
//
// Two NVS lifecycles, deliberately separate:
//   - box_id / ap_psk: generated once on the very first boot, NEVER erased.
//     box_id is the box's identity everywhere (X-Box-Id header, AP SSID,
//     mcp-core registry key); ap_psk is the provisioning AP's WPA2 password.
//   - ssid / pass / post_url / box_name: the actual provisioning payload,
//     cleared as a unit by a WiFi reset (long BOOT press).
//
// There is intentionally NO wifi_config.h fallback: compiled-in credentials
// are the exact thing that leaked to a public repo once already. A box with
// empty NVS provisions through the portal, full stop.
#include "provisioning.h"
#include <string.h>
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "nvs.h"
#include "esp_wifi.h"
#include "esp_netif.h"
#include "dhcpserver/dhcpserver.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_http_server.h"
#include "driver/gpio.h"
#include "qrcode.h"
#include "display.h"
#include "dns_hijack.h"

static const char *TAG = "provisioning";
#define NVS_NS "prov"

#define PROV_DONE_BIT BIT0
static EventGroupHandle_t s_prov_events;
static httpd_handle_t s_portal = NULL;
static char s_ap_ssid[33];   // = box_id
static char s_ap_psk[9];

// --------------------------------------------------------------------------
// NVS storage
// --------------------------------------------------------------------------
static bool nvs_get_str_ok(nvs_handle_t h, const char *key, char *out, size_t out_len)
{
    size_t len = out_len;
    if (nvs_get_str(h, key, out, &len) != ESP_OK) { out[0] = '\0'; return false; }
    return out[0] != '\0';
}

const char *prov_ensure_box_id(char *out, size_t out_len)
{
    nvs_handle_t h;
    ESP_ERROR_CHECK(nvs_open(NVS_NS, NVS_READWRITE, &h));
    if (!nvs_get_str_ok(h, "box_id", out, out_len)) {
        // esp_read_mac reads the factory MAC from efuse — works before (and
        // without) esp_wifi being initialized, unlike esp_wifi_get_mac.
        uint8_t mac[6];
        esp_read_mac(mac, ESP_MAC_WIFI_STA);
        snprintf(out, out_len, "BOX-%02X%02X", mac[4], mac[5]);
        nvs_set_str(h, "box_id", out);
        nvs_commit(h);
        ESP_LOGI(TAG, "generated box_id %s (first boot)", out);
    }
    nvs_close(h);
    return out;
}

const char *prov_ensure_ap_psk(char *out, size_t out_len)
{
    nvs_handle_t h;
    ESP_ERROR_CHECK(nvs_open(NVS_NS, NVS_READWRITE, &h));
    if (!nvs_get_str_ok(h, "ap_psk", out, out_len)) {
        // Uppercase + digits only, ambiguous glyphs (0/O/1/I) removed: this is
        // read off the box's 5x7 uppercase-only screen font by a human.
        static const char charset[] = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        for (int i = 0; i < 8 && (size_t)i < out_len - 1; i++) {
            out[i] = charset[esp_random() % (sizeof(charset) - 1)];
        }
        out[8 < out_len - 1 ? 8 : out_len - 1] = '\0';
        nvs_set_str(h, "ap_psk", out);
        nvs_commit(h);
        ESP_LOGI(TAG, "generated provisioning AP password (first boot)");
    }
    nvs_close(h);
    return out;
}

bool prov_load_creds(char *ssid, size_t ssid_len, char *pass, size_t pass_len,
                     char *post_url, size_t url_len, char *box_name, size_t name_len)
{
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READONLY, &h) != ESP_OK) {
        ssid[0] = pass[0] = post_url[0] = box_name[0] = '\0';
        return false;
    }
    bool have_ssid = nvs_get_str_ok(h, "ssid", ssid, ssid_len);
    nvs_get_str_ok(h, "pass", pass, pass_len);
    bool have_url = nvs_get_str_ok(h, "post_url", post_url, url_len);
    nvs_get_str_ok(h, "box_name", box_name, name_len);
    nvs_close(h);
    return have_ssid && have_url;
}

esp_err_t prov_save_creds(const char *ssid, const char *pass,
                          const char *post_url, const char *box_name)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    // All four keys, then one commit: a power cut mid-write can't leave a
    // state that passes prov_load_creds with half-written values.
    if ((err = nvs_set_str(h, "ssid", ssid)) == ESP_OK &&
        (err = nvs_set_str(h, "pass", pass)) == ESP_OK &&
        (err = nvs_set_str(h, "post_url", post_url)) == ESP_OK &&
        (err = nvs_set_str(h, "box_name", box_name)) == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    return err;
}

// Update ONLY the server address, keeping WiFi credentials. Lets a box that is
// on WiFi but can't find its server be repointed over the network (POST /server)
// instead of needing a full re-provision through the QR portal — the common
// case when the server's machine moves networks or changes IP.
esp_err_t prov_save_post_url(const char *post_url)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    if ((err = nvs_set_str(h, "post_url", post_url)) == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    return err;
}

// Shared secret proving a request came from our own server. Stored separately
// from the WiFi credentials because it is delivered separately: the server
// hands it over on its first /server adopt push (trust-on-first-use on your own
// LAN), not through the provisioning portal.
//
// Trust-on-first-use is what makes this impossible to lock yourself out with:
// the box enforces ONLY once it holds a token, and the only way it got one was
// from the server — so a box that rejects you is rejecting with a secret the
// server knows. To re-key, hold BOOT 5s (wipes it with the rest) and re-provision.
// URL of the server's reverse channel (ws:// on the LAN, wss:// through a
// public relay). Delivered by the server the same way post_url is, so a box
// never has it typed in by hand.
bool prov_load_ws_url(char *out, size_t out_len)
{
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READONLY, &h) != ESP_OK) { out[0] = '\0'; return false; }
    bool have = nvs_get_str_ok(h, "ws_url", out, out_len);
    nvs_close(h);
    return have;
}

esp_err_t prov_save_ws_url(const char *url)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    if ((err = nvs_set_str(h, "ws_url", url)) == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    return err;
}

// Where the on-screen help QR points. Stored (not compiled in) so the guide can
// move hosts without reflashing a fleet — the server pushes it alongside
// post_url, exactly like ws_url.
bool prov_load_help_url(char *out, size_t out_len)
{
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READONLY, &h) != ESP_OK) { out[0] = '\0'; return false; }
    bool have = nvs_get_str_ok(h, "help_url", out, out_len);
    nvs_close(h);
    return have;
}

esp_err_t prov_save_help_url(const char *url)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    if ((err = nvs_set_str(h, "help_url", url)) == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    return err;
}

// ---- Double-reset detection -------------------------------------------------
// "Tap RST twice" is the recovery gesture, so it has to survive the way RST
// actually resets this chip. The usual trick — a flag in RTC memory — is NOT
// reliable here: RST pulls the enable pin low, which resets the RTC domain too,
// so the flag can be gone at exactly the moment it matters. NVS survives every
// reset type, at the cost of two small writes per boot (wear-levelled, and this
// runs once per boot, not in a loop).
#define DBL_RESET_WINDOW_MS 4000

static void dbl_reset_clear_task(void *arg)
{
    vTaskDelay(pdMS_TO_TICKS(DBL_RESET_WINDOW_MS));
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READWRITE, &h) == ESP_OK) {
        nvs_set_u8(h, "dblrst", 0);
        nvs_commit(h);
        nvs_close(h);
    }
    vTaskDelete(NULL);
}

bool prov_double_reset(void)
{
    nvs_handle_t h;
    uint8_t armed = 0;
    if (nvs_open(NVS_NS, NVS_READWRITE, &h) != ESP_OK) return false;
    nvs_get_u8(h, "dblrst", &armed);   // key absent on a fresh box -> stays 0

    if (armed) {
        // Second boot inside the window: consume the flag so a THIRD reset
        // starts over rather than re-triggering.
        nvs_set_u8(h, "dblrst", 0);
        nvs_commit(h);
        nvs_close(h);
        ESP_LOGI(TAG, "double reset detected — showing help screen");
        return true;
    }

    nvs_set_u8(h, "dblrst", 1);
    nvs_commit(h);
    nvs_close(h);
    // Disarm shortly after boot, so an ordinary single reset doesn't leave the
    // box primed to show help on its next unrelated restart.
    xTaskCreate(dbl_reset_clear_task, "dblrst", 2560, NULL, 3, NULL);
    return false;
}

bool prov_load_fleet_token(char *out, size_t out_len)
{
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READONLY, &h) != ESP_OK) { out[0] = '\0'; return false; }
    bool have = nvs_get_str_ok(h, "fleet_tok", out, out_len);
    nvs_close(h);
    return have;
}

esp_err_t prov_save_fleet_token(const char *token)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    if ((err = nvs_set_str(h, "fleet_tok", token)) == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    return err;
}

void prov_erase_creds(void)
{
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READWRITE, &h) != ESP_OK) return;
    // Only the mutable payload — box_id and ap_psk survive every reset.
    nvs_erase_key(h, "ssid");
    nvs_erase_key(h, "pass");
    nvs_erase_key(h, "post_url");
    nvs_erase_key(h, "box_name");
    // The fleet token goes too: this is the documented way out of a bad key.
    // Clearing it returns the box to trust-on-first-use so a server with a
    // different token can adopt it, instead of the box being permanently
    // unreachable by anyone who doesn't hold the old secret.
    nvs_erase_key(h, "fleet_tok");
    nvs_commit(h);
    nvs_close(h);
    ESP_LOGI(TAG, "WiFi credentials + fleet token erased (box_id kept)");
}

// --------------------------------------------------------------------------
// Form parsing (application/x-www-form-urlencoded)
// --------------------------------------------------------------------------
static int hex_val(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

// Extract + URL-decode one field from a form body. Returns false if absent.
static bool form_field(const char *body, const char *name, char *out, size_t out_len)
{
    size_t name_len = strlen(name);
    const char *p = body;
    while (p && *p) {
        if (strncmp(p, name, name_len) == 0 && p[name_len] == '=') {
            p += name_len + 1;
            size_t o = 0;
            while (*p && *p != '&' && o < out_len - 1) {
                if (*p == '+') { out[o++] = ' '; p++; }
                else if (*p == '%' && hex_val(p[1]) >= 0 && hex_val(p[2]) >= 0) {
                    out[o++] = (char)(hex_val(p[1]) * 16 + hex_val(p[2]));
                    p += 3;
                } else out[o++] = *p++;
            }
            out[o] = '\0';
            return true;
        }
        p = strchr(p, '&');
        if (p) p++;
    }
    out[0] = '\0';
    return false;
}

// --------------------------------------------------------------------------
// Portal HTTP handlers
// --------------------------------------------------------------------------
static const char PORTAL_FORM[] =
    "<!doctype html><html><head>"
    "<meta name=viewport content=\"width=device-width,initial-scale=1\">"
    "<title>Box WiFi Setup</title><style>"
    "body{font-family:sans-serif;max-width:420px;margin:24px auto;padding:0 16px}"
    "label{display:block;margin:14px 0 4px;font-weight:600}"
    "input{width:100%%;padding:10px;font-size:16px;box-sizing:border-box}"
    "button{margin-top:18px;width:100%%;padding:12px;font-size:17px;"
    "background:#0a66c2;color:#fff;border:0;border-radius:6px}"
    "small{display:block;color:#666;margin-top:4px;font-size:12px}"
    "</style></head><body><h2>Box WiFi Setup</h2>"
    "<form method=POST action=/save>"
    "<label>WiFi network</label>"
    "<input name=ssid list=ssids required maxlength=32 placeholder=\"Scanning...\">"
    "<datalist id=ssids></datalist>"
    "<label>WiFi password</label>"
    "<input name=pass type=password maxlength=63>"
    "<label>Computer address (where mcp-core runs)</label>"
    "<input name=post_url required maxlength=80 "
    "value=\"http://mcp-core.local:8000/upload\">"
    "<small>Leave as-is if mcp-core is running on your network — the box finds it "
    "automatically. Only change this if you know its exact IP address.</small>"
    "<label>Box name</label>"
    "<input name=box_name required maxlength=32 value=\"%s\">"
    "<button>Save &amp; Restart</button></form>"
    "<script>fetch('/scan').then(r=>r.json()).then(l=>{"
    "document.getElementById('ssids').innerHTML="
    "l.map(s=>'<option value=\"'+s+'\">').join('')})</script>"
    "</body></html>";

// Every unknown path — including all the OS captive-portal probe URLs
// (/generate_204, /hotspot-detect.html, /ncsi.txt, ...) — gets the form with
// status 200. Answering a probe with real content is precisely what makes the
// phone pop its "sign in to network" webview.
static esp_err_t portal_get_handler(httpd_req_t *req)
{
    char page[sizeof(PORTAL_FORM) + 64];
    snprintf(page, sizeof(page), PORTAL_FORM, s_ap_ssid);
    httpd_resp_set_type(req, "text/html");
    return httpd_resp_send(req, page, HTTPD_RESP_USE_STRLEN);
}

// Live scan for the SSID dropdown. Legal while the AP is up because the mode
// is APSTA — plain AP mode cannot scan, which is why APSTA was chosen.
static esp_err_t scan_get_handler(httpd_req_t *req)
{
    wifi_scan_config_t sc = { .show_hidden = false };
    esp_err_t err = esp_wifi_scan_start(&sc, true);
    uint16_t n = 0;
    wifi_ap_record_t *recs = NULL;
    if (err == ESP_OK) {
        esp_wifi_scan_get_ap_num(&n);
        if (n > 20) n = 20;
        recs = calloc(n ? n : 1, sizeof(wifi_ap_record_t));
        if (recs) esp_wifi_scan_get_ap_records(&n, recs);
        else n = 0;
    }

    char json[768];
    size_t o = 0;
    json[o++] = '[';
    for (int i = 0; i < n && o < sizeof(json) - 40; i++) {
        const char *ssid = (const char *)recs[i].ssid;
        if (!ssid[0] || strchr(ssid, '"') || strchr(ssid, '\\')) continue;
        bool dup = false;   // mesh nodes broadcast the same SSID repeatedly
        for (int j = 0; j < i; j++) {
            if (strcmp(ssid, (const char *)recs[j].ssid) == 0) { dup = true; break; }
        }
        if (dup) continue;
        o += snprintf(json + o, sizeof(json) - o, "%s\"%s\"", o > 1 ? "," : "", ssid);
    }
    json[o++] = ']';
    json[o] = '\0';
    free(recs);
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, json, o);
}

static void restart_task(void *arg)
{
    vTaskDelay(pdMS_TO_TICKS(1500));   // let the HTTP response flush first
    esp_restart();
}

static esp_err_t save_post_handler(httpd_req_t *req)
{
    char body[512];
    int len = httpd_req_recv(req, body, sizeof(body) - 1);
    if (len <= 0) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "empty body");
    body[len] = '\0';

    char ssid[33], pass[64], post_url[81], box_name[33];
    form_field(body, "ssid", ssid, sizeof(ssid));
    form_field(body, "pass", pass, sizeof(pass));
    form_field(body, "post_url", post_url, sizeof(post_url));
    form_field(body, "box_name", box_name, sizeof(box_name));

    const char *problem = NULL;
    size_t pass_len = strlen(pass);
    if (!ssid[0]) problem = "WiFi network name is required.";
    else if (pass_len > 0 && pass_len < 8) problem = "WiFi password must be 8+ characters (or empty for an open network).";
    else if (strncmp(post_url, "http://", 7) != 0 && strncmp(post_url, "https://", 8) != 0)
        problem = "Computer address must start with http:// (e.g. http://192.168.1.50:8000/upload).";
    else if (!strchr(post_url + 8, '/')) problem = "Computer address needs a path, e.g. .../upload.";
    else if (!box_name[0]) problem = "Box name is required.";

    if (problem) {
        // First-timers won't debug an HTTP error page — re-render inline.
        char page[sizeof(PORTAL_FORM) + 256];
        int o = snprintf(page, sizeof(page),
                         "<!doctype html><p style=\"color:#b00;font-family:sans-serif\">%s</p>", problem);
        snprintf(page + o, sizeof(page) - o, PORTAL_FORM, box_name[0] ? box_name : s_ap_ssid);
        httpd_resp_set_type(req, "text/html");
        return httpd_resp_send(req, page, HTTPD_RESP_USE_STRLEN);
    }

    esp_err_t err = prov_save_creds(ssid, pass, post_url, box_name);
    if (err != ESP_OK) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "flash write failed");
    }
    ESP_LOGI(TAG, "provisioned: ssid=\"%s\" post_url=\"%s\" name=\"%s\" — restarting",
             ssid, post_url, box_name);
    httpd_resp_set_type(req, "text/html");
    httpd_resp_send(req,
        "<!doctype html><body style=\"font-family:sans-serif;text-align:center;margin-top:60px\">"
        "<h2>Saved!</h2><p>The box is restarting and will connect to your WiFi now.</p>"
        "<p>You can close this page and reconnect your phone to your own network.</p></body>",
        HTTPD_RESP_USE_STRLEN);
    xEventGroupSetBits(s_prov_events, PROV_DONE_BIT);
    xTaskCreate(restart_task, "prov_restart", 2048, NULL, 5, NULL);
    return ESP_OK;
}

// --------------------------------------------------------------------------
// QR screen
// --------------------------------------------------------------------------
// espressif/qrcode's display callback has no user-context argument, so the
// module bitmap is captured through file statics into display_qr().
static void qr_display_cb(esp_qrcode_handle_t qrcode)
{
    int size = esp_qrcode_get_size(qrcode);
    static uint8_t modules[41 * 41];   // up to QR version 6, plenty for our payload
    if (size > 41) { ESP_LOGW(TAG, "QR too large to render (%d)", size); return; }
    for (int y = 0; y < size; y++) {
        for (int x = 0; x < size; x++) {
            modules[y * size + x] = esp_qrcode_get_module(qrcode, x, y) ? 1 : 0;
        }
    }
    display_qr(modules, size, s_ap_ssid, s_ap_psk);
}

// Same renderer, arbitrary captions — used by the help screen, which encodes a
// URL rather than WiFi credentials.
static const char *s_qr_l1 = "";
static const char *s_qr_l2 = "";

static void qr_url_display_cb(esp_qrcode_handle_t qrcode)
{
    int size = esp_qrcode_get_size(qrcode);
    static uint8_t modules[41 * 41];
    if (size > 41) { ESP_LOGW(TAG, "help QR too large to render (%d)", size); return; }
    for (int y = 0; y < size; y++) {
        for (int x = 0; x < size; x++) {
            modules[y * size + x] = esp_qrcode_get_module(qrcode, x, y) ? 1 : 0;
        }
    }
    display_qr(modules, size, s_qr_l1, s_qr_l2);
}

bool prov_show_url_qr(const char *url, const char *line1, const char *line2)
{
    if (!url || !url[0]) return false;
    s_qr_l1 = line1 ? line1 : "";
    s_qr_l2 = line2 ? line2 : "";
    esp_qrcode_config_t cfg = ESP_QRCODE_CONFIG_DEFAULT();
    cfg.display_func = qr_url_display_cb;
    if (esp_qrcode_generate(&cfg, url) != ESP_OK) {
        ESP_LOGW(TAG, "could not encode help URL as QR");
        return false;
    }
    return true;
}

static void show_qr_screen(void)
{
    // Standard WiFi QR URI — stock camera apps offer "join this network"
    // directly. Both fields are self-generated (uppercase alnum + hyphen), so
    // no ;/,/: escaping can ever be needed.
    char payload[80];
    snprintf(payload, sizeof(payload), "WIFI:S:%s;T:WPA;P:%s;;", s_ap_ssid, s_ap_psk);
    esp_qrcode_config_t cfg = ESP_QRCODE_CONFIG_DEFAULT();
    cfg.display_func = qr_display_cb;
    if (esp_qrcode_generate(&cfg, payload) != ESP_OK) {
        // Encoder failure shouldn't strand the user — plain text still works.
        display_status(s_ap_ssid, s_ap_psk, COL_INFO);
    }
}

// --------------------------------------------------------------------------
// Provisioning mode
// --------------------------------------------------------------------------
#define PORTAL_WINDOW_MS (15 * 60 * 1000)

static void portal_up(void)
{
    // The box may arrive here with WiFi running in STA mode (failed connect)
    // or not started at all (fresh box) — normalize: stop, reconfigure, start.
    esp_wifi_stop();   // ESP_ERR_WIFI_NOT_STARTED is fine

    wifi_config_t ap = { 0 };
    strlcpy((char *)ap.ap.ssid, s_ap_ssid, sizeof(ap.ap.ssid));
    strlcpy((char *)ap.ap.password, s_ap_psk, sizeof(ap.ap.password));
    ap.ap.ssid_len = strlen(s_ap_ssid);
    // WPA2, never open: an open AP + unauthenticated /save would let anyone in
    // radio range point this box's microphone uploads at their own server.
    ap.ap.authmode = WIFI_AUTH_WPA2_PSK;
    ap.ap.channel = 6;
    ap.ap.max_connection = 4;
    // APSTA (not AP): the /scan endpoint needs the STA interface for scanning.
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_APSTA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap));
    ESP_ERROR_CHECK(esp_wifi_start());

    // ESP-IDF's DHCP server does NOT offer a DNS server by default (OFFER_DNS
    // is opt-in) — without this, a phone never even queries the hijacked DNS
    // resolver, so no captive-portal popup can ever trigger no matter how
    // correct dns_hijack.c is. Must be set after esp_wifi_start() creates the
    // AP's DHCP server instance.
    esp_netif_t *ap_netif = esp_netif_get_handle_from_ifkey("WIFI_AP_DEF");
    esp_netif_dns_info_t dns = { 0 };
    dns.ip.type = ESP_IPADDR_TYPE_V4;
    dns.ip.u_addr.ip4.addr = ESP_IP4TOADDR(192, 168, 4, 1);
    esp_netif_set_dns_info(ap_netif, ESP_NETIF_DNS_MAIN, &dns);
    dhcps_offer_t dns_offer = OFFER_DNS;
    esp_netif_dhcps_option(ap_netif, ESP_NETIF_OP_SET,
                           ESP_NETIF_DOMAIN_NAME_SERVER, &dns_offer, sizeof(dns_offer));

    dns_hijack_start();

    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.uri_match_fn = httpd_uri_match_wildcard;   // for the catch-all route
    cfg.max_uri_handlers = 4;
    cfg.stack_size = 8192;
    ESP_ERROR_CHECK(httpd_start(&s_portal, &cfg));
    // Order matters with wildcard matching: specific routes first.
    httpd_uri_t scan = { .uri = "/scan", .method = HTTP_GET, .handler = scan_get_handler };
    httpd_register_uri_handler(s_portal, &scan);
    httpd_uri_t save = { .uri = "/save", .method = HTTP_POST, .handler = save_post_handler };
    httpd_register_uri_handler(s_portal, &save);
    httpd_uri_t all = { .uri = "/*", .method = HTTP_GET, .handler = portal_get_handler };
    httpd_register_uri_handler(s_portal, &all);

    show_qr_screen();
    ESP_LOGI(TAG, "portal up: join WPA2 AP \"%s\" (password on box screen)", s_ap_ssid);
}

static void portal_down(void)
{
    if (s_portal) { httpd_stop(s_portal); s_portal = NULL; }
    dns_hijack_stop();
    esp_wifi_stop();
}

static void wait_for_boot_tap(void)
{
    // Provisioning can start before app_main ever configures the button, so
    // configure it here too (idempotent).
    gpio_config_t btn = {
        .pin_bit_mask = 1ULL << 0, .mode = GPIO_MODE_INPUT, .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    gpio_config(&btn);
    while (gpio_get_level(0) != 0) vTaskDelay(pdMS_TO_TICKS(50));
    while (gpio_get_level(0) == 0) vTaskDelay(pdMS_TO_TICKS(50));   // wait release
}

void start_provisioning_mode(void)
{
    if (!s_prov_events) s_prov_events = xEventGroupCreate();
    prov_ensure_box_id(s_ap_ssid, sizeof(s_ap_ssid));
    prov_ensure_ap_psk(s_ap_psk, sizeof(s_ap_psk));

    for (;;) {
        portal_up();
        EventBits_t bits = xEventGroupWaitBits(s_prov_events, PROV_DONE_BIT,
                                               pdFALSE, pdTRUE,
                                               pdMS_TO_TICKS(PORTAL_WINDOW_MS));
        if (bits & PROV_DONE_BIT) {
            // Saved — the /save handler's restart_task reboots us shortly.
            vTaskDelay(portMAX_DELAY);
        }
        // Nobody provisioned within the window. Don't leave the AP (even a
        // WPA2 one) broadcasting forever on an abandoned box — tear it down
        // and wait for a human to ask for it again.
        portal_down();
        ESP_LOGI(TAG, "portal window expired — AP down, tap BOOT to reopen");
        display_status("WIFI SETUP", "TAP BOOT TO START", COL_ACCENT);
        wait_for_boot_tap();
        // Same PSK on re-entry by design: it's read off the screen, not memorized.
    }
}
