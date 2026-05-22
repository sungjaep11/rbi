# 원격 인쇄 리다이렉션 구현 계획

## 전체 흐름

컨테이너 앱에서 인쇄 요청 → CUPS 가상 프린터가 PDF로 저장 → Python 서버가 감지하여 WebSocket으로 전송 → auth-proxy가 브라우저로 중계 → 브라우저가 로컬 프린터 다이얼로그 실행

---

## 단계별 구현 계획

### 단계 1 — webtop 커스텀 이미지 구성

현재 webtop은 외부 이미지를 그대로 사용 중이므로, CUPS, cups-pdf, Python을 설치한 커스텀 이미지로 교체한다. docker-compose.yml도 이미지 직접 참조 대신 로컬 빌드 방식으로 변경한다.

### 단계 2 — CUPS 가상 프린터 설정

컨테이너 내에 PDF 프린터를 기본 프린터로 등록하고, 인쇄 시 지정된 디렉토리에 PDF 파일이 생성되도록 설정한다. CUPS 웹 관리 UI는 외부에 노출하지 않는다.

### 단계 3 — Python WebSocket 서버

PDF 출력 디렉토리를 주기적으로 감시하다가 새 파일이 생기면 바이너리 프레임으로 WebSocket에 전송한다. 전송 완료 후 임시 PDF 파일은 즉시 삭제한다. 컨테이너 시작 시 자동으로 실행되도록 구성한다.

### 단계 4 — auth-proxy WebSocket 프록시

브라우저는 auth-proxy를 통해서만 webtop에 접근하므로, `/print-ws` 경로로 들어오는 WebSocket 연결을 webtop 내부의 Python 서버로 중계하는 프록시를 추가한다. 인증된 세션만 접근할 수 있도록 기존 인증 미들웨어를 적용한다.

### 단계 5 — 브라우저 클라이언트 스크립트 주입

auth-proxy가 webtop HTML을 가로채 스크립트를 주입하는 기존 방식을 활용한다. 주입된 스크립트는 WebSocket으로 수신한 바이너리 데이터를 `application/pdf` 타입의 Blob으로 변환하고, 숨겨진 iframe에 로드한 뒤 브라우저의 로컬 프린터 다이얼로그를 실행한다.

---

## 고려사항

- **보안:** `/print-ws`는 인증된 세션만 접근할 수 있어야 한다.
- **대용량 파일:** 바이너리 전송을 사용하므로 Base64 오버헤드는 없다. 다만 대용량 PDF는 WebSocket 단일 메시지로 전송되므로 메모리에 전체를 올려야 한다.

---

## 구현 현황

단계 1~5 모두 구현 완료. webtop 앱의 인쇄 메뉴에서 곧바로 PDF 프린터로 출력하면 print-forwarder → print_server → WebSocket → 브라우저 다이얼로그까지 자동 연결된다.

- `webtop/Dockerfile`: linuxserver/webtop을 기반으로 Python3, aiohttp, curl, cups, cups-pdf, cups-client 설치. `cupsd.conf`는 sed로 `Port 631 → Listen localhost:631`, `WebInterface Yes → No`만 in-place 패치하여 외부 노출/웹 UI 차단. `cups-pdf.conf` 끝에 `PostProcessing` 훅 등 RBI override append. cupsd/print-server를 s6-overlay 서비스로 등록
- `webtop/custom-services.d/cupsd/run`: cupsd longrun 진입점. 최초 1회 cupsd를 띄워 `lpadmin -p PDF -v cups-pdf:/ -d PDF`로 PDF 가상 프린터를 기본 프린터로 등록한 뒤 `cupsd -f`로 재기동
- `webtop/print_server.py`: aiohttp 기반 내부 서버. `GET /ws`로 브라우저 WebSocket 연결을 받고, `POST /print`로 PDF를 수신하여 모든 연결된 브라우저로 전송
- `webtop/print-forwarder.sh`: cups-pdf의 `PostProcessing`이 호출. PDF를 `POST /print`로 전달하고 성공 시 임시 파일 삭제
- `webtop/custom-services.d/print-server/run`: s6-overlay 서비스로 print_server.py를 자동 실행
- `auth-proxy/server.js`: `/print-ws` WebSocket 연결을 `ws://webtop:7777/ws`로 프록시. 인증 미들웨어로 세션 검증
- `docker-compose.yml`: webtop을 `build: ./webtop`으로 변경

### 테스트 방법

end-to-end (실제 인쇄 흐름):

```bash
docker compose up --build
# 브라우저에서 http://localhost:8080 로그인
# webtop 안에서 임의의 앱(예: 텍스트 에디터, 브라우저) 인쇄 → "PDF" 프린터 선택 (기본값)
# → 로컬 브라우저의 프린트 다이얼로그가 자동으로 뜸
```

CUPS를 거치지 않고 파이프만 점검하려면:

```bash
docker exec webtop curl -sf -X POST --data-binary @/path/to/file.pdf http://localhost:7777/print
```

CUPS 상태 확인:

```bash
docker exec webtop lpstat -t            # 프린터/큐 상태
docker exec webtop lpstat -d            # 기본 프린터 확인 (system default destination: PDF)
docker exec webtop cat /etc/cups/cups-pdf.conf | tail -10  # 후처리 훅 확인
```
