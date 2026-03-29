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

Express 기반 인증 서버입니다. 주요 기능은 다음과 같습니다.

- **미들웨어**: JSON/form 파싱, 쿠키 파서, 세션 관리
- **공개 라우트**: 로그인 페이지 렌더링(`GET /login`), 로그인 처리(`POST /login`), 로그아웃(`POST /logout`, 세션 파기)
- **인증 미들웨어**: 세션 유무를 확인하여 미인증 요청을 로그인 페이지로 리다이렉트
- **관리자 라우트**: 사용자 목록 조회, 추가, 삭제
- **Webtop 역방향 프록시**: 인증된 요청을 Webtop 컨테이너로 전달하며, WebSocket 프록시 활성화

### 4-3. `auth-proxy/Dockerfile`

Node.js 20 Alpine 이미지 기반으로, 프로덕션 의존성만 설치합니다.

### 4-4. 구조

```
rbi/
├── docker-compose.yml
├── .env
└── auth-proxy/
    ├── Dockerfile
    ├── server.js
    ├── public/
    │   ├── login.html
    │   └── login.css
    ├── scripts/
    │   └── create-admin.js
    └── db/                    ← .gitignore 처리
        └── users.json
```

프론트엔드를 먼저 한다면 `login.html` 과 `login.css` 만 수정하면 될 것 같습니다. 

## 5. 사용자 관리 시스템 구현

### 5-1. 초기 관리자 계정 생성 스크립트

`auth-proxy/scripts/create-admin.js`는 CLI 인자로 사용자명, 비밀번호, 역할(기본값 `admin`)을 받아 bcrypt 해시 후 `db/users.json`에 추가합니다. 컨테이너 기동 후 `docker exec`으로 실행하여 사용자를 등록합니다.

```bash
# 컨테이너 실행 후 관리자 계정 생성
docker exec auth-proxy node scripts/create-admin.js admin <strong-password> admin
```

### 5-2. 관리자 대시보드 페이지

`auth-proxy/public/admin.html`은 다크 테마 테이블 UI로 전체 사용자 목록(이름, 역할 배지, 생성일, 삭제 버튼)을 표시합니다. 상단 폼에서 사용자명·비밀번호·역할을 입력해 신규 사용자를 추가할 수 있으며, 삭제 시 확인 다이얼로그가 뜹니다. 모든 작업은 `/admin/users` REST API를 fetch로 호출합니다.


## 6. Docker Compose 설정

두 개의 서비스로 구성됩니다.

**`auth-proxy`**: `./auth-proxy`에서 빌드하며 호스트의 8080 포트를 컨테이너의 8080 포트로 매핑합니다. `WEBTOP_URL`과 `SESSION_SECRET` 환경변수를 주입하고, `./auth-proxy/db`를 볼륨으로 마운트해 사용자 DB를 저장합니다.


## 7. 테스트 및 검증

### 7-1. 로컬 빌드 및 실행

레포를 클론한 뒤 `.env`에 `SESSION_SECRET`을 설정하고, `docker compose up --build -d`로 빌드 및 실행합니다.

### 7-2. 사용자 추가 테스트

`docker exec`으로 컨테이너 내부의 `create-admin.js` 스크립트를 실행해 테스트 사용자를 추가합니다.

### 7-3. 동작 확인 체크리스트

- `https://localhost` 접속 시 로그인 페이지로 리다이렉트
- 잘못된 비밀번호 입력 시 오류 메시지 표시
- 올바른 로그인 후 Webtop 데스크탑 화면 진입
- 로그아웃 후 로그인 페이지로 리다이렉트
- `/admin/users` 에서 관리자만 사용자 목록 조회 가능