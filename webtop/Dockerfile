FROM lscr.io/linuxserver/webtop:ubuntu-xfce

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 python3-pip curl \
        cups cups-pdf cups-client \
        v4l-utils ffmpeg pulseaudio-utils && \
    pip3 install --no-cache-dir --break-system-packages aiohttp && \
    rm -rf /var/lib/apt/lists/*

# cupsd hardening: 외부 인터페이스 listen 차단 + 웹 UI 비활성화
# (sed로 업스트림 기본값을 in-place 패치; 631 포트는 docker-compose에서도 노출 X)
RUN sed -i \
        -e 's|^Port 631|Listen localhost:631|' \
        -e 's|^WebInterface Yes|WebInterface No|' \
        /etc/cups/cupsd.conf

# cups-pdf: 생성된 PDF를 print-forwarder로 전달하도록 후처리 훅 등록
RUN { \
        echo ''; \
        echo '### RBI overrides ###'; \
        echo 'Out /var/spool/cups-pdf/output'; \
        echo 'AnonDirName /var/spool/cups-pdf/output'; \
        echo 'AnonUser abc'; \
        echo 'PostProcessing /usr/local/bin/print-forwarder'; \
    } >> /etc/cups/cups-pdf.conf && \
    mkdir -p /var/spool/cups-pdf/output && \
    chmod 1777 /var/spool/cups-pdf/output

COPY print_server.py /usr/local/bin/print_server.py
COPY print-forwarder.sh /usr/local/bin/print-forwarder

# s6-overlay v3: cupsd + print_server + virtmic를 longrun 서비스로 등록
RUN mkdir -p /etc/s6-overlay/s6-rc.d/svc-cupsd \
             /etc/s6-overlay/s6-rc.d/svc-print-server \
             /etc/s6-overlay/s6-rc.d/svc-virtmic \
             /etc/s6-overlay/s6-rc.d/user/contents.d
COPY custom-services.d/cupsd/run /etc/s6-overlay/s6-rc.d/svc-cupsd/run
COPY custom-services.d/print-server/run /etc/s6-overlay/s6-rc.d/svc-print-server/run
COPY custom-services.d/virtmic/run /etc/s6-overlay/s6-rc.d/svc-virtmic/run

RUN echo "longrun" > /etc/s6-overlay/s6-rc.d/svc-cupsd/type && \
    echo "longrun" > /etc/s6-overlay/s6-rc.d/svc-print-server/type && \
    echo "longrun" > /etc/s6-overlay/s6-rc.d/svc-virtmic/type && \
    touch /etc/s6-overlay/s6-rc.d/user/contents.d/svc-cupsd && \
    touch /etc/s6-overlay/s6-rc.d/user/contents.d/svc-print-server && \
    touch /etc/s6-overlay/s6-rc.d/user/contents.d/svc-virtmic && \
    # Windows 체크아웃 시 CRLF가 섞여 들어와도 shebang이 깨지지 않도록 LF로 정규화
    sed -i 's/\r$//' /usr/local/bin/print-forwarder \
                     /usr/local/bin/print_server.py \
                     /etc/s6-overlay/s6-rc.d/svc-cupsd/run \
                     /etc/s6-overlay/s6-rc.d/svc-print-server/run \
                     /etc/s6-overlay/s6-rc.d/svc-virtmic/run && \
    chmod +x /usr/local/bin/print-forwarder \
             /etc/s6-overlay/s6-rc.d/svc-cupsd/run \
             /etc/s6-overlay/s6-rc.d/svc-print-server/run \
             /etc/s6-overlay/s6-rc.d/svc-virtmic/run
