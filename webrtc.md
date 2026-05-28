# 화상회의(카메라·마이크) 지원 구현 계획

## 목표

로컬 PC의 카메라/마이크 스트림을 원격 webtop 컨테이너로 전달하여, 원격 브라우저에서 실행되는 화상회의 서비스(Google Meet, Zoom 웹 등)가 이를 정상적인 웹캠/마이크 장치로 인식하도록 한다.

---

## 핵심 문제

selkies의 기존 WebRTC는 컨테이너 → 브라우저 단방향(데스크톱 화면/소리)만 사용한다. 시그널링에서도 서버가 offer를 만들고 브라우저는 answer만 생성하며, 브라우저는 자신의 로컬 미디어 트랙을 전혀 보내지 않는다 (`selkies/addons/selkies-web-core/lib/webrtc.js`의 `_ontrack`은 수신 전용).

따라서 카메라/마이크는 반대 방향(브라우저 → 컨테이너) 으로 새 미디어 경로를 만들어야 하고, 도착한 스트림을 컨테이너 안의 브라우저가 표준 장치로 볼 수 있게 만들어야 한다.

---

## 전체 흐름

```
[로컬 브라우저] getUserMedia(카메라+마이크)
      │  WebRTC (별도 피어 커넥션, selkies 데스크톱 스트림과 분리)
      ▼
[auth-proxy] /camera-ws  ─ 시그널링 인증 후 중계
      ▼
[webtop 컨테이너] Python 미디어 수신 서버(aiortc)
      ├─ 영상 트랙 → v4l2loopback 가상 웹캠
      └─ 음성 트랙 → PulseAudio 가상 소스(virtual mic)
      ▼
[원격 브라우저] getUserMedia → 가상 웹캠/마이크 선택 → 화상회의 정상 동작
```

기존 인쇄 모듈(`printer.md`)이 쓰는 auth-proxy WebSocket 프록시 + 브라우저 스크립트 주입 + 컨테이너 내 s6 서비스 패턴을 그대로 재사용한다.


---

## 단계별 구현 계획

### 단계 1 — 가상 장치 준비 (Dockerfile / docker-compose)

- **가상 웹캠:** `v4l2loopback` 커널 모듈 사용. 모듈은 호스트 커널에 로드된 상태여야 하며, `docker-compose.yml`에서 `devices`로 컨테이너에 매핑
- **가상 마이크:** webtop이 이미 PulseAudio를 사용하므로, 가상 소스를 추가해 원격 브라우저가 선택 가능한 마이크로 노출.

### 단계 2 — 컨테이너 미디어 수신 서버 (aiortc)

- `aiortc` 기반 Python 서버를 추가하여 `/camera-ws`로 들어온 SDP/ICE로 피어를 수립.
- 수신한 영상 트랙 프레임을 v4l2loopback 장치에 기록, 음성 트랙을 PulseAudio 가상 소스로 출력.
- 인쇄 서버와 동일하게 s6-overlay longrun 서비스로 등록해 컨테이너 시작 시 자동 실행.

### 단계 3 — auth-proxy 시그널링 프록시

- `auth-proxy/server.js`의 `upgrade` 핸들러에 `/camera-ws` 분기를 추가해 컨테이너 내부 미디어 서버로 WebSocket을 중계 (기존 `/print-ws` 로직과 동일 패턴).
- 기존 인증 미들웨어를 그대로 적용해 인증된 세션만 접근 허용.

### 단계 4 — 브라우저 클라이언트 스크립트 주입

- `auth-proxy`가 webtop HTML의 `</body>` 앞에 스크립트를 주입하는 기존 방식에 카메라 클라이언트 스크립트를 추가.

### 단계 5 — 원격 브라우저에서 장치 선택 확인

- 원격 브라우저(컨테이너 내 Chromium)에서 화상회의 사이트 접속 → 장치 목록에 가상 웹캠/마이크가 보이는지, 영상·음성이 실시간으로 흐르는지 확인.
