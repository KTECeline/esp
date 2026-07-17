// Proof-of-concept, confirmed working on hardware: probes for either a
// TT21100 (0x24) or GT911 (0x5D) touch chip — BOX-3 units ship with one or
// the other depending on hardware revision — and reads real touch data off
// whichever responds. No UI behavior is wired to it yet.
#pragma once
#include <stdbool.h>

// Returns false if no touch chip responds at either known address.
bool touch_init(void);

// Poll for a tap. Returns true ONCE per press (rising edge — a held finger
// reports a single tap, not a stream), writing DISPLAY coordinates to x/y.
// Call every ~20-50ms from the main loop. Always false if touch_init() failed.
bool touch_get_tap(int *x, int *y);
