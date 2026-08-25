idf_component_register(SRCS "listen_v2.c" "display.c" "ui_font.c" "ui_font_cjk.c" "provisioning.c" "dns_hijack.c" "touch.c" "sensor.c" "ws_client.c" "ota.c"
                    INCLUDE_DIRS "."
                    REQUIRES driver esp_codec_dev esp_wifi esp_http_client esp_http_server nvs_flash esp_netif esp_event esp_lcd esp_lcd_ili9341 lwip esp_timer mdns esp_lcd_touch esp_websocket_client esp-tls app_update)
