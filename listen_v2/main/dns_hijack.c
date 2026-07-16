// Captive-portal DNS: answer EVERY A-record query with the AP's own address
// (192.168.4.1). Phones probe a known URL right after joining a network; when
// the "wrong" page comes back they pop the sign-in webview — which is exactly
// how the provisioning form appears without the user typing an address.
#include "dns_hijack.h"
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/sockets.h"
#include "esp_log.h"

static const char *TAG = "dns_hijack";
static int s_sock = -1;
static volatile bool s_running = false;

static void dns_task(void *arg)
{
    uint8_t buf[512];
    while (s_running) {
        struct sockaddr_in from;
        socklen_t from_len = sizeof(from);
        int len = recvfrom(s_sock, buf, sizeof(buf) - 16, 0,
                           (struct sockaddr *)&from, &from_len);
        if (len < 12) continue;   // shorter than a DNS header (or socket closed)

        // Turn the query into a response in place: QR=1, AA=1, RA=1, RCODE=0,
        // one answer. The question section is kept verbatim; the answer uses a
        // compression pointer (0xC00C) back to the query name.
        buf[2] = 0x84; buf[3] = 0x80;                  // flags: response, AA, RA
        buf[6] = 0x00; buf[7] = 0x01;                  // ANCOUNT = 1
        buf[8] = buf[9] = buf[10] = buf[11] = 0;       // NSCOUNT/ARCOUNT = 0
        static const uint8_t answer[] = {
            0xC0, 0x0C,             // name: pointer to question
            0x00, 0x01, 0x00, 0x01, // type A, class IN
            0x00, 0x00, 0x00, 0x3C, // TTL 60s
            0x00, 0x04,             // RDLENGTH 4
            192, 168, 4, 1          // ESP-IDF's default SoftAP address
        };
        memcpy(buf + len, answer, sizeof(answer));
        sendto(s_sock, buf, len + sizeof(answer), 0,
               (struct sockaddr *)&from, from_len);
    }
    vTaskDelete(NULL);
}

esp_err_t dns_hijack_start(void)
{
    if (s_running) return ESP_OK;
    s_sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (s_sock < 0) return ESP_FAIL;
    struct sockaddr_in addr = {
        .sin_family = AF_INET, .sin_port = htons(53),
        .sin_addr.s_addr = htonl(INADDR_ANY)
    };
    if (bind(s_sock, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        close(s_sock); s_sock = -1;
        return ESP_FAIL;
    }
    s_running = true;
    xTaskCreate(dns_task, "dns_hijack", 3072, NULL, 5, NULL);
    ESP_LOGI(TAG, "captive DNS up: answering everything with 192.168.4.1");
    return ESP_OK;
}

void dns_hijack_stop(void)
{
    if (!s_running) return;
    s_running = false;
    close(s_sock);   // unblocks recvfrom; task sees s_running=false and exits
    s_sock = -1;
}
