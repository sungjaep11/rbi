#!/usr/bin/env bash
# CUPS PostProcessingCommand: /usr/local/bin/print-forwarder %F
# cups-pdf가 PDF를 생성한 후 호출됨; %F는 파일 경로.
exec curl -sf -X POST --data-binary "@$1" http://localhost:7777/print
