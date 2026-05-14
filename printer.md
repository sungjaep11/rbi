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

단계 1~2(CUPS) 없이도 전송 흐름을 검증할 수 있도록 placeholder로 구현했다. `print-output/` 폴더에 PDF를 복사하면 브라우저 프린트 다이얼로그까지 테스트할 수 있다.

- `auth-proxy/package.json`: `ws` 패키지 추가
- `auth-proxy/server.js`: `printWss` WebSocket 서버 추가, 3초마다 `print-output/` 폴링하여 PDF 발견 시 바이너리 전송, `upgrade` 핸들러에 `/print-ws` 분기 추가, webtop HTML에 `PRINT_CLIENT_SCRIPT` 주입
- `docker-compose.yml`: `auth-proxy`에 `./print-output:/app/print-output` bind mount 추가

### 테스트 방법

```bash
docker compose up --build
# 브라우저에서 http://localhost:8080 로그인 후
cp 파일.pdf ./print-output/
# 3초 이내에 브라우저 프린트 다이얼로그 팝업
```

### 남은 작업

단계 1~2가 완성되면 webtop이 CUPS로 PDF를 `print-output/`에 생성하도록 연결하고, 해당 볼륨을 webtop과 auth-proxy가 공유하도록 docker-compose를 수정한다.
