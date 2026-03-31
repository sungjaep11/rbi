# 로그인 시스템 구현 가이드


## 1. Webtop 기본 로그인 시스템 구조

Webtop은 [docker-baseimage-selkies](https://github.com/linuxserver/docker-baseimage-selkies)를 기반으로 하며, 세 가지 인증 방식을 제공합니다.

```
브라우저
  └─ HTTPS (포트 3001) / HTTP (포트 3000)
       └─ NGINX (컨테이너 내부)
            ├─ [옵션 A] HTTP Basic Auth (CUSTOM_USER + PASSWORD 환경변수)
            ├─ [옵션 B] 인증 없음 (PASSWORD 미설정 시 기본값)
            └─ Selkies WebSocket 서버 (포트 8082)
                 └─ 데스크탑 세션 (XFCE / KDE / MATE 등)
```

실제 webtop 레포의 `root/` 구조는 다음과 같습니다.

```
root/
├── defaults/
│   ├── startwm.sh      # 데스크탑 환경 시작 스크립트 (XFCE 등 실행)
│   └── ...
└── usr/
    └── bin/
        └── ...         # thunar 래퍼 등 커스텀 바이너리
```

nginx, s6-overlay, Selkies 서비스 정의 같은 핵심 인프라는 Webtop 레포가 아닌 Selkies 에 있습니다.


## 2. 아키텍처 개요

역방향 프록시를 사용하면 Webtop이나 Selkies 수정 없이 로그인 페이지를 만들 수 있습니다. 

흐름: 브라우저 → Nginx 로그인 프록시(로그인 페이지 제공, 세션/토큰 검증, 사용자 DB 조회) → 인증 통과 시 Webtop 컨테이너(실제 데스크탑 스트리밍, Selkies WebRTC) → 사용자별 격리 세션


## 3. 생성이 필요한 파일 목록

로그인 기능을 위해 새로 생성하는 파일들입니다.

| 파일/디렉터리 | 역할 |
|---|---|
| `auth-proxy/Dockerfile` | 인증 프록시 서버 이미지 |
| `auth-proxy/server.js` | Node.js 인증 서버 (Express) |
| `auth-proxy/public/login.html` | 로그인 페이지 UI |
| `auth-proxy/public/login.css` | 로그인 페이지 스타일 |
| `auth-proxy/db/users.json` | 사용자 데이터 저장소 (초기에는 파일 기반) |
| `docker-compose.yml` | 전체 스택 오케스트레이션 |


## 4. 로그인 프록시 서버 구축

### 4-1. 디렉터리 구조 생성

`auth-proxy/` 하위에 `public/`과 `db/` 디렉터리를 생성하고, `express`, `express-session`, `bcryptjs`, `cookie-parser` 패키지를 설치합니다.

### 4-2. `auth-proxy/server.js`

Express 기반 인증 서버입니다.

- **미들웨어**: JSON/form 파싱, 쿠키 파서, 세션 관리
- **공개 라우트**: 로그인 페이지 렌더링(`GET /login`), 로그인 처리(`POST /login`), 로그아웃(`POST /logout`, 세션 파기)
- **인증 미들웨어**: 세션 유무를 확인하여 미인증 요청을 로그인 페이지로 리다이렉트
- **관리자 라우트**: 사용자 목록 조회, 추가, 삭제
- **Webtop 역방향 프록시**: 인증된 요청을 Webtop 컨테이너로 전달하며, WebSocket 프록시 활성화

### 4-3. `auth-proxy/Dockerfile`

Node.js 20 Alpine 이미지 기반으로, 프로덕션 의존성만 설치합니다.
