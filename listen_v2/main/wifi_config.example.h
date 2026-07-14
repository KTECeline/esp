// Copy this file to wifi_config.h (same folder) and fill in your own values.
// wifi_config.h is gitignored — your real credentials never get committed.
#pragma once

#define WIFI_SSID   "YOUR_WIFI_NAME"
#define WIFI_PASS   "YOUR_WIFI_PASSWORD"
// Your PC's LAN IP running the bridge/assistant server. Find it with:
//   ifconfig | grep "inet " (Mac/Linux)  or  ipconfig (Windows)
#define POST_URL    "http://YOUR_PC_LOCAL_IP:8000/upload"
