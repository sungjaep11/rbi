FROM lscr.io/linuxserver/webtop:ubuntu-xfce

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 python3-pip curl \
        cups cups-pdf && \
    pip3 install --no-cache-dir --break-system-packages aiohttp && \
    rm -rf /var/lib/apt/lists/*

COPY print_server.py /usr/local/bin/print_server.py
COPY print-forwarder.sh /usr/local/bin/print-forwarder

# s6-overlay v3 방식으로 서비스 직접 등록
RUN mkdir -p /etc/s6-overlay/s6-rc.d/svc-print-server \
             /etc/s6-overlay/s6-rc.d/user/contents.d
COPY custom-services.d/print-server/run /etc/s6-overlay/s6-rc.d/svc-print-server/run
RUN echo "longrun" > /etc/s6-overlay/s6-rc.d/svc-print-server/type && \
    touch /etc/s6-overlay/s6-rc.d/user/contents.d/svc-print-server && \
    chmod +x /usr/local/bin/print-forwarder \
             /etc/s6-overlay/s6-rc.d/svc-print-server/run
