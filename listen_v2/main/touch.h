// Proof-of-concept, confirmed working on hardware: probes for either a
// TT21100 (0x24) or GT911 (0x5D) touch chip — BOX-3 units ship with one or
// the other depending on hardware revision — and reads real touch data off
// whichever responds. No UI behavior is wired to it yet.
#pragma once
#include <stdbool.h>

// Returns false if no touch chip responds at either known address.
bool touch_init(void);

// Call periodically (e.g. every ~50ms) from a task or the main loop. Logs
// (via ESP_LOGI) each new touch point's coordinates; does nothing when the
// panel isn't being touched. No-op if touch_init() returned false.
void touch_poll_log(void);
