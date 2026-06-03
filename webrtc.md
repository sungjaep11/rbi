# 화상회의(카메라·마이크) 지원 구현 계획

## 목표

로컬 PC의 카메라/마이크 스트림을 원격 webtop 컨테이너로 전달하여, 원격 브라우저에서 실행되는 화상회의 서비스(Google Meet, Zoom 웹 등)가 이를 정상적인 웹캠/마이크 장치로 인식하도록 한다.

---

## 핵심 문제

selkies의 기존 스트리밍은 컨테이너 → 브라우저 단방향(데스크톱 화면/소리)만 사용한다. 기본 전송은 WebSocket이며(`selkies-core.js`에서 기본값이 `websockets`, WebRTC는 선택 모드), 어느 모드든 브라우저는 자신의 로컬 미디어 트랙을 컨테이너로 보내지 않는다. (WebRTC 모드의 경우에도 `selkies/addons/selkies-web-core/lib/webrtc.js`의 `_ontrack`은 수신 전용이고, 서버가 offer를 만들고 브라우저는 answer만 생성한다.)

따라서 카메라/마이크는 반대 방향(브라우저 → 컨테이너)으로 selkies와 **분리된 별도 미디어 경로**를 새로 만들어야 한다. 이 경로는 selkies의 데스크톱 전송 방식(WS/WebRTC)과 무관하게 독립적으로 동작한다. 도착한 스트림을 컨테이너 안의 브라우저가 표준 장치로 볼 수 있게 만들어야 한다.

---

## 전체 흐름

```
[로컬 브라우저] getUserMedia(카메라+마이크) → MediaStream
      │  WebRTC로 전송 (별도 피어 커넥션, selkies 데스크톱 스트림과 분리)
      │  ※ WebRTC는 "형식"이 아니라 실시간 미디어 전송 수단.
      │     v4l2loopback/PulseAudio가 받는 것은 raw 프레임/PCM이며,
      │     아래 aiortc가 WebRTC 트랙을 디코딩해 그 형식으로 변환한다.
      ▼
[auth-proxy] /camera-ws  ─ 시그널링 인증 후 중계
      ▼
[webtop 컨테이너] Python 미디어 수신 서버(aiortc)
      ├─ 영상 트랙 디코딩 → raw 프레임 → v4l2loopback 가상 웹캠
      └─ 음성 트랙 디코딩 → raw PCM → PulseAudio 가상 소스(virtual mic)
      ▼
[원격 브라우저] getUserMedia → 가상 웹캠/마이크 선택 → 화상회의 정상 동작
```

기존 인쇄 모듈(`printer.md`)이 쓰는 auth-proxy WebSocket 프록시 + 브라우저 스크립트 주입 + 컨테이너 내 s6 서비스 패턴을 그대로 재사용한다.


---

## 인쇄 모듈과의 차이

이 모듈은 인쇄 모듈(`printer.md`)의 **auth-proxy WS 프록시 + HTML 스크립트 주입 + s6 서비스** 인프라를 재사용하지만, 두 가지가 본질적으로 다르다. 구현 순서는 이 차이에서 나온다.

1. **방향·연속성:** 인쇄는 컨테이너 → 브라우저 *단발성 바이너리 푸시*. 카메라는 브라우저 → 컨테이너 *연속 실시간 스트림*.
2. **WebSocket의 역할:** 인쇄의 `/print-ws`는 PDF 자체를 실어 날랐지만, 카메라의 `/camera-ws`는 **SDP/ICE 시그널링만** 중계한다. 실제 미디어는 WebSocket이 아니라 브라우저 ↔ aiortc 간 WebRTC(SRTP/DTLS over UDP)로 별도로 흐른다.

---


## 단계별 구현 계획

### 단계 1 — 가상 장치 준비 (Dockerfile / docker-compose)

- **가상 웹캠:** `v4l2loopback`(호스트 커널에 로드, `devices`로 컨테이너 매핑).
  - **체크포인트:** `docker exec webtop ls -l /dev/video*`
- **가상 마이크:** PulseAudio `module-null-sink` + `module-remap-source`로 원격 브라우저가 선택 가능한 소스 노출.

### 단계 2 — 컨테이너 미디어 수신 서버 (aiortc)

- `/camera-ws`로 들어온 SDP/ICE로 피어를 수립.
- 영상 트랙 → rgb24로 디코딩 후 ffmpeg에 파이프해 `/dev/video10`에 yuv420p로 기록. 음성 트랙 → s16le로 리샘플 후 `pacat`로 PulseAudio 가상 소스에 주입.
- 인쇄 서버와 동일하게 s6-overlay longrun 서비스로 등록.
- **체크포인트(브라우저 없이):** 컨테이너 안에서 `ffplay /dev/video10`으로 들어온 영상 확인.

### 단계 3 — auth-proxy 시그널링 프록시

- `auth-proxy/server.js`의 `upgrade` 핸들러에 `/camera-ws` 분기를 추가해 컨테이너 내부 미디어 서버로 WebSocket을 중계 (기존 `/print-ws` 로직과 동일 패턴, `WEBTOP_CAMERA_WS` 상수 추가).
- 기존 인증 체크(세션 검증, terminated/만료)를 그대로 적용해 인증된 세션만 접근 허용.

### 단계 4 — 브라우저 클라이언트 스크립트 주입

- `auth-proxy`가 webtop HTML의 `</body>` 앞에 스크립트를 주입하는 기존 방식에 카메라 클라이언트 스크립트를 추가(`getUserMedia` → `RTCPeerConnection` → `/camera-ws` SDP/ICE 교환 → 트랙 송신, 끊기면 재연결).
- **주의:** 자동 `getUserMedia`는 사용자 제스처 없이 권한 프롬프트를 띄우고 자동재생 정책에 걸릴 수 있으므로, "카메라 연결" 토글/버튼을 두는 편이 안전.

### 단계 5 — 원격 브라우저에서 장치 선택 확인

- 원격 브라우저(컨테이너 내 Chromium)에서 화상회의 사이트 접속 → 장치 목록에 가상 웹캠/마이크가 보이는지, 영상·음성이 실시간으로 흐르는지 확인.
- **체크포인트:** `docker compose up --build` → 로컬 브라우저 로그인·카메라 토글 허용 → 컨테이너 Chromium에서 `https://webcamtests.com` 등으로 가상 웹캠 영상 확인.

### 의존성 체인

```
단계1(장치 존재?) → 단계2(aiortc→장치) → 단계3(시그널링 프록시) → 단계4(주입) → 단계5(E2E)
```
