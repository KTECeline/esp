// Outbound WebSocket to the server — the box's "reverse channel".
//
// Pushes normally go server -> box over the LAN, which only works while both
// share a network. This dials the other way and holds the connection open, so
// the server can reach the box from anywhere without the box running a VPN or
// any cryptography of its own (plain TLS via the standard CA bundle).
#pragma once
#include <stdbool.h>

// Non-blocking: connects in the background and auto-reconnects for the lifetime
// of the program. `url` is ws:// or wss:// (empty/NULL = feature off, LAN push
// only). Identity and the shared secret are sent as headers on the HTTP
// upgrade, so the socket is authenticated once at connect.
// Returns false only if the client could not be created/started at all.
bool ws_client_start(const char *url, const char *box_id, const char *fleet_token);

bool ws_client_connected(void);
