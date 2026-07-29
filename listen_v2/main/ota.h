// Firmware updates over WiFi, so changing the software no longer means walking
// to every box with a USB cable.
//
// The safety model matters more than the download. A box lives on a network you
// may not be standing next to, so the failure that must never happen is
// "pushed an image that can't get online, box is now unreachable, fetch the
// cable". Two things prevent it:
//
//   1. Two app slots (partitions.csv). A download writes to the IDLE slot; the
//      slot currently running is untouched until the new image is complete and
//      verified, so a download that dies halfway changes nothing.
//   2. Rollback (CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE). The new image boots in
//      PENDING_VERIFY. It stays only if ota_mark_valid() is called, and the boot
//      path calls that ONLY after WiFi is up and the server has answered.
//
// So the worst case for a bad push is one reboot, not a site visit.
#pragma once
#include <stdbool.h>
#include "esp_err.h"

// Download `url` into the idle slot and reboot into it on success. Returns
// immediately — the transfer runs on its own task, because it is far slower
// than an HTTP handler should block for. `token` is sent as X-Fleet-Token so
// the firmware image is served under the same auth as everything else; pass ""
// when un-adopted.
//
// ESP_ERR_INVALID_STATE means an update is already running (a second push
// mid-download would corrupt the target slot).
esp_err_t ota_start(const char *url, const char *token);

// Confirm the running image is healthy and cancel the pending rollback. Call
// once per boot, and only after the box has proven it can reach its server —
// calling it earlier defeats the entire safety net. A no-op unless this boot is
// a freshly-installed image awaiting verification.
void ota_mark_valid(void);

// The other half of the net: give up on a freshly-installed image that can't
// get online, reverting to the previous slot and rebooting. Call on the boot
// paths that conclude the box is unusable (no WiFi, no server) BEFORE falling
// back to on-screen provisioning, which a remote box has nobody to complete.
// Does not return if a rollback happens; a no-op otherwise, so the caller
// continues to provisioning when there is nothing to roll back to.
void ota_rollback_if_pending(void);

// What this box is ACTUALLY running, reported to mcp-core on registration.
//
// Needed because a push only confirms the box accepted the job — the download,
// the reboot and the health check all happen afterwards. Worse, a box that
// rolled back comes back perfectly healthy on the OLD image, so "it registered"
// is not evidence the update stuck. Comparing these against the pushed build is
// what turns a silent revert into a visible one.
//
// All three return static strings, valid for the life of the process.
const char *ota_running_slot(void);      // "ota_0" / "ota_1" / "factory"
const char *ota_running_version(void);   // build version (git describe by default)
const char *ota_running_sha(void);       // first 4 bytes of the ELF sha256, as hex

// True while this boot is still on probation (PENDING_VERIFY) — i.e. a
// just-installed image that has not yet confirmed itself. Reported too, so an
// operator watching a rollout can tell "updated and confirmed" apart from
// "updated, still deciding".
bool ota_pending_verify(void);
