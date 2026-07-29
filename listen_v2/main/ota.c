#include "ota.h"

#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <inttypes.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_app_desc.h"
#include "esp_http_client.h"
#include "esp_system.h"

#include "display.h"

static const char *TAG = "ota";

// 4KB per read: big enough that flash writes aren't dominated by call overhead,
// small enough to sit in internal RAM without competing with the mic buffers.
#define OTA_BUF_SIZE 4096

// A partial image is worse than no image, so a second push while one is running
// is refused rather than allowed to interleave writes into the same slot.
static volatile bool s_busy = false;

// Copied out of the request, because the HTTP handler's stack is long gone by
// the time the task runs.
static char s_url[256];
static char s_token[65];

static void ota_fail(const char *why)
{
    ESP_LOGE(TAG, "update aborted: %s — box keeps running the current firmware", why);
    display_status("UPDATE FAILED", "STILL RUNNING", rgb565(180, 0, 0));
}

static void ota_task(void *arg)
{
    esp_http_client_handle_t client = NULL;
    esp_ota_handle_t         handle = 0;
    bool                     writing = false;
    char                    *buf = NULL;

    const esp_partition_t *target = esp_ota_get_next_update_partition(NULL);
    if (target == NULL) {
        ota_fail("no idle app slot (is this an OTA partition table?)");
        goto done;
    }

    buf = malloc(OTA_BUF_SIZE);
    if (buf == NULL) {
        ota_fail("out of memory");
        goto done;
    }

    ESP_LOGI(TAG, "downloading %s into slot %s", s_url, target->label);
    display_status("UPDATING", "DO NOT UNPLUG", rgb565(0, 90, 160));

    esp_http_client_config_t cfg = {
        .url               = s_url,
        .timeout_ms        = 20000,
        .keep_alive_enable = true,
    };
    client = esp_http_client_init(&cfg);
    if (client == NULL) {
        ota_fail("could not create HTTP client");
        goto done;
    }
    if (s_token[0]) esp_http_client_set_header(client, "X-Fleet-Token", s_token);

    if (esp_http_client_open(client, 0) != ESP_OK) {
        ota_fail("could not reach the firmware URL");
        goto done;
    }
    int total = esp_http_client_fetch_headers(client);
    int status = esp_http_client_get_status_code(client);
    if (status != 200) {
        ESP_LOGE(TAG, "server answered HTTP %d", status);
        ota_fail("server did not return the firmware");
        goto done;
    }
    // A known length is checked up front: catching "this is a 404 page, not a
    // firmware image" here costs nothing, whereas catching it after erasing the
    // target slot wastes a flash cycle and a minute of the operator's time.
    if (total > 0 && (uint32_t)total > target->size) {
        ESP_LOGE(TAG, "image is %d bytes, slot %s holds %" PRIu32,
                 total, target->label, target->size);
        ota_fail("firmware too large for the slot");
        goto done;
    }

    // OTA_SIZE_UNKNOWN erases the whole slot. Correct for a chunked response,
    // and the only safe choice when the length isn't known in advance.
    if (esp_ota_begin(target, total > 0 ? total : OTA_SIZE_UNKNOWN, &handle) != ESP_OK) {
        ota_fail("could not open the target slot");
        goto done;
    }
    writing = true;

    int written = 0;
    int last_logged_pct = -1;
    while (total <= 0 || written < total) {
        int r = esp_http_client_read(client, buf, OTA_BUF_SIZE);
        if (r < 0) {
            ota_fail("download interrupted");
            goto done;
        }
        if (r == 0) break;   // stream ended
        if (esp_ota_write(handle, buf, r) != ESP_OK) {
            ota_fail("flash write failed");
            goto done;
        }
        written += r;

        if (total > 0) {
            int pct = (int)((int64_t)written * 100 / total);
            if (pct >= last_logged_pct + 10) {   // ~10 lines, not thousands
                last_logged_pct = pct;
                ESP_LOGI(TAG, "%d%% (%d/%d bytes)", pct, written, total);
                char sub[24];
                snprintf(sub, sizeof(sub), "%d%%", pct);
                display_status("UPDATING", sub, rgb565(0, 90, 160));
            }
        }
    }

    // A truncated image can still be a valid-looking prefix, so trust the
    // declared length over "the socket closed".
    if (total > 0 && written != total) {
        ESP_LOGE(TAG, "got %d of %d bytes", written, total);
        ota_fail("download incomplete");
        goto done;
    }
    if (written == 0) {
        ota_fail("server sent an empty image");
        goto done;
    }

    // Verifies the image's checksum and header. This is the gate that rejects a
    // corrupt or non-firmware download before it can ever be booted.
    esp_err_t err = esp_ota_end(handle);
    writing = false;
    if (err != ESP_OK) {
        ota_fail(err == ESP_ERR_OTA_VALIDATE_FAILED ? "image failed validation"
                                                    : "could not finalise the image");
        goto done;
    }
    if (esp_ota_set_boot_partition(target) != ESP_OK) {
        ota_fail("could not select the new slot for boot");
        goto done;
    }

    ESP_LOGI(TAG, "installed %d bytes into %s — rebooting into it. If it cannot "
                  "reach the server, the bootloader reverts to the previous slot.",
             written, target->label);
    display_status("UPDATED", "REBOOTING", rgb565(0, 140, 0));
    vTaskDelay(pdMS_TO_TICKS(1200));   // let the screen land before the reboot
    esp_restart();

done:
    if (writing) esp_ota_abort(handle);
    if (client) {
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
    }
    free(buf);
    s_busy = false;
    vTaskDelete(NULL);
}

esp_err_t ota_start(const char *url, const char *token)
{
    if (s_busy) return ESP_ERR_INVALID_STATE;
    s_busy = true;

    strlcpy(s_url, url, sizeof(s_url));
    strlcpy(s_token, token ? token : "", sizeof(s_token));

    // 8KB: the TLS-free HTTP client plus flash writes fit comfortably, and this
    // runs below the audio tasks because an update is never time-critical.
    if (xTaskCreate(ota_task, "ota", 8192, NULL, 4, NULL) != pdPASS) {
        s_busy = false;
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

void ota_mark_valid(void)
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t state;
    if (running == NULL || esp_ota_get_state_partition(running, &state) != ESP_OK) return;
    if (state != ESP_OTA_IMG_PENDING_VERIFY) return;   // ordinary boot

    if (esp_ota_mark_app_valid_cancel_rollback() == ESP_OK) {
        ESP_LOGI(TAG, "new firmware reached the server — keeping it (rollback cancelled)");
    } else {
        ESP_LOGE(TAG, "could not cancel rollback — this image will revert on the next reboot");
    }
}

const char *ota_running_slot(void)
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    return running ? running->label : "?";
}

const char *ota_running_version(void)
{
    const esp_app_desc_t *d = esp_app_get_description();
    return d ? d->version : "?";
}

const char *ota_running_sha(void)
{
    // 4 bytes is plenty to tell two builds apart by eye, and unlike the version
    // string it changes on every rebuild — a rebuild off the same commit has an
    // identical `git describe`, so version alone can't confirm a push landed.
    static char hex[9];
    if (hex[0]) return hex;
    const esp_app_desc_t *d = esp_app_get_description();
    if (d == NULL) { strlcpy(hex, "?", sizeof(hex)); return hex; }
    snprintf(hex, sizeof(hex), "%02x%02x%02x%02x",
             d->app_elf_sha256[0], d->app_elf_sha256[1],
             d->app_elf_sha256[2], d->app_elf_sha256[3]);
    return hex;
}

bool ota_pending_verify(void)
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t state;
    if (running == NULL || esp_ota_get_state_partition(running, &state) != ESP_OK) return false;
    return state == ESP_OTA_IMG_PENDING_VERIFY;
}

void ota_rollback_if_pending(void)
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t state;
    if (running == NULL || esp_ota_get_state_partition(running, &state) != ESP_OK) return;
    if (state != ESP_OTA_IMG_PENDING_VERIFY) return;   // nothing to revert to

    ESP_LOGE(TAG, "freshly-installed firmware could not get online — reverting to the previous version");
    display_status("UPDATE BAD", "REVERTING", rgb565(180, 0, 0));
    vTaskDelay(pdMS_TO_TICKS(1500));
    esp_ota_mark_app_invalid_rollback_and_reboot();   // does not return
}
