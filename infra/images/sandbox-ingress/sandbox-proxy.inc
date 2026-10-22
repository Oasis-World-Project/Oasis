# 流式输出不能缓冲；agent 一次调用可能很久
proxy_http_version 1.1;
proxy_buffering off;
proxy_request_buffering off;
proxy_read_timeout 600s;
proxy_send_timeout 600s;
# 沙箱自己带来的 x-oasis-* 一律丢掉：付费人只由临时 Key 决定
proxy_set_header X-Oasis-User-Id "";
proxy_set_header X-Oasis-Payer-Id "";
