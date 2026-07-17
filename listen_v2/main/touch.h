// Proof-of-concept only: the BOX-3's TT21100 touch panel is already probed
// (display.c) to detect the LCD type, but nothing reads actual touches yet.
// This wires up the driver and logs raw coordinates — no UI behavior change.
#pragma once
#include <stdbool.h>

// Returns false if the touch chip didn't respond (e.g. this unit's panel
// variant doesn't have one wired, or the probe in display.c already found
// nothing at that address).
bool touch_init(void);

// Call periodically (e.g. every ~50ms) from a task or the main loop. Logs
// (via ESP_LOGI) each new touch point's coordinates; does nothing when the
// panel isn't being touched. No-op if touch_init() returned false.
void touch_poll_log(void);
