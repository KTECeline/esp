// Tiny captive-portal DNS responder: answers every A query with 192.168.4.1.
#pragma once
#include "esp_err.h"

esp_err_t dns_hijack_start(void);
void dns_hijack_stop(void);
