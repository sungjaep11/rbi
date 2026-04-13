# RBI (Remote Browser Isolation)

원격 브라우저 격리(RBI) 연구 프로젝트입니다. 인증 프록시 서버를 통해 컨테이너화된 원격 데스크탑(WebTop) 환경에 안전하게 접근할 수 있도록 구성되어 있습니다.

## 아키텍처

```
사용자 브라우저 → auth-proxy (8080) → webtop 컨테이너 (3000)
```

- **auth-proxy**: Node.js/Express 기반 인증 서버. 로그인 처리 및 세션 관리 후 WebTop으로 리버스 프록시
- **webtop**: Ubuntu XFCE 기반 원격 데스크탑 컨테이너. 외부에 직접 노출되지 않음

## 사전 요구사항

- [Docker](https://www.docker.com/) & Docker Compose 설치
- 포트 8080이 사용 가능한 상태

## 시작하기

### 1. 저장소 클론

```bash
git clone https://github.com/sungjaep11/rbi.git
cd rbi
```

### 2. 환경 변수 설정

`.env` 파일을 프로젝트 루트에 생성합니다.

```bash
# Linux/macOS
echo "SESSION_SECRET=$(openssl rand -hex 32)" > .env

# Windows PowerShell
$secret = [System.Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Max 256 }))
"SESSION_SECRET=$secret" | Out-File -Encoding ascii .env
```

또는 직접 `.env` 파일을 만들어 아래 내용을 작성합니다.

```
SESSION_SECRET=여기에_랜덤한_긴_문자열_입력
```

### 3. 컨테이너 빌드 및 실행

```bash
docker-compose up --build -d
```

처음 실행 시 WebTop 이미지를 다운로드하므로 시간이 걸릴 수 있습니다.

### 4. 관리자 계정 생성

컨테이너가 실행된 후 관리자 계정을 생성합니다.

```bash
docker exec auth-proxy node scripts/create-admin.js <사용자명> <비밀번호> admin
```

예시:

```bash
docker exec auth-proxy node scripts/create-admin.js admin mypassword admin
```

### 5. 접속

브라우저에서 [http://localhost:8080](http://localhost:8080) 으로 접속한 뒤 생성한 계정으로 로그인합니다.

로그인 성공 시 원격 데스크탑(WebTop) 화면이 표시됩니다.

## 컨테이너 관리

```bash
# 실행 중인 컨테이너 확인
docker-compose ps

# 로그 확인
docker-compose logs -f auth-proxy

# 컨테이너 중지
docker-compose down

# 컨테이너 및 볼륨 전체 삭제
docker-compose down -v
```

## 프로젝트 구조

```
rbi/
├── .env                        # 환경 변수 (SESSION_SECRET)
├── docker-compose.yml          # Docker 서비스 구성
├── auth-proxy/
│   ├── Dockerfile              # auth-proxy 컨테이너 이미지
│   ├── package.json            # Node.js 의존성
│   ├── server.js               # Express 서버 (메인 진입점)
│   ├── public/
│   │   ├── login.html          # 로그인 페이지
│   │   └── login.css           # 로그인 페이지 스타일
│   ├── scripts/
│   │   └── create-admin.js     # 사용자 생성 CLI 스크립트
│   └── db/
│       ├── users.json          # JSON 기반 사용자 데이터베이스
│       └── sessions.json       # 활성 세션 목록
├── static-web/
│   └── selkies-dashboard/      # 대시보드 빌드 결과물 (npm run deploy로 생성)
└── selkies/
    └── addons/
        └── selkies-dashboard/  # 대시보드 소스코드 (React/Vite)
```

## API 엔드포인트

### 인증 (공개)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/login` | 로그인 페이지 |
| POST | `/login` | 로그인 처리 |
| POST | `/logout` | 로그아웃 및 WebTop 세션 초기화 |

### 사용자 API (로그인 필요)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/me` | 현재 로그인 사용자 정보 조회 |
| PATCH | `/api/me/password` | 비밀번호 변경 |
| GET | `/api/session/info` | 현재 세션 만료 시간 조회 |
| POST | `/api/session/extend` | 세션 만료 시간 연장 (+8시간) |
| GET | `/api/sessions` | 활성 세션 목록 (관리자: 전체, 일반 사용자: 본인 것만) |
| DELETE | `/api/sessions/:sessionId` | 특정 세션 강제 종료 |
| DELETE | `/api/sessions` | 현재 세션 제외 전체 세션 강제 종료 |

### 관리자 API (관리자 권한 필요)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/admin/users` | 사용자 목록 조회 |
| POST | `/admin/users` | 사용자 생성 |
| DELETE | `/admin/users/:username` | 사용자 삭제 |

### WebTop 프록시

| 메서드 | 경로 | 설명 |
|--------|------|------|
| ALL | `/*` | WebTop으로 리버스 프록시 (로그인 필요, WebSocket 지원) |

## 환경 변수

| 변수명 | 기본값 | 설명 |
|--------|--------|------|
| `SESSION_SECRET` | `change-me-in-production` | 세션 암호화 키 (반드시 변경) |
| `PORT` | `8080` | 서버 포트 |
| `WEBTOP_URL` | `http://webtop:3000` | WebTop 컨테이너 URL |

## 보안

- 비밀번호는 bcrypt(cost 12)로 해싱하여 저장
- 세션 쿠키: `httpOnly`, `sameSite=lax`, 8시간 만료
- 로그인 시 세션 재생성 (세션 고정 공격 방지)
- WebTop 컨테이너는 외부에 직접 노출되지 않음