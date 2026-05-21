#!/usr/bin/env bash
# cups-pdf PostProcessing hook
# 호출 형태: print-forwarder <pdf_path> <username>
# cups-pdf가 PDF 생성을 완료한 직후 실행됨.
PDF="$1"
if curl -sf -X POST --data-binary "@$PDF" http://localhost:7777/print; then
    rm -f "$PDF"
fi
