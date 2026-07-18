# 보안 및 운영 원칙

## 공개되는 것

GitHub Pages는 정적 호스팅이므로 HTML, CSS, JavaScript와 배포 파일은 누구나 받을 수
있습니다. 이 프로젝트는 원문 검색 데이터와 PDF를 AES-GCM으로 암호화한 뒤 배포합니다.
암호화 매개변수와 암호문은 공개되지만 공유 비밀번호는 포함하지 않습니다.

## 비밀값 구분

### KCSC API 키

- 로컬 서비스명: `codex-kcsc-api`
- 용도: KDS·KCS 데이터 갱신
- 웹 브라우저와 GitHub Pages에는 전달하지 않음

### 서비스 공유 비밀번호

- 로컬 서비스명: `codex-facility-search-password`
- 용도: 검색 인덱스와 PDF 암호화·복호화
- 16자 이상의 강한 비밀번호 사용
- 저장소, `.env`, 문서, 빌드 로그에 기록하지 않음

### OpenAI API 키

- 로컬 서비스명: `codex-openai-api`
- 용도: AI 중계 서버에서 OpenAI Responses API 호출
- Vue 코드, GitHub Pages, 브라우저, GitHub Actions 빌드에는 전달하지 않음
- Cloudflare Workers에서는 암호화된 Secret `OPENAI_API_KEY`로 설정

### AI 접속 토큰

- 브라우저는 공유 비밀번호 자체를 보내지 않고 PBKDF2-SHA256 600,000회로 파생한 토큰만
  현재 탭의 메모리에 보관합니다.
- 중계 서버는 동일하게 파생한 토큰 또는 서버 전용 `AI_ACCESS_TOKEN`과 상수 시간 비교합니다.
- 토큰은 저장소나 Vue 빌드에 포함하지 않습니다.
- 공개 서비스에서는 HTTPS를 사용하고 공유 비밀번호 변경 시 토큰도 함께 교체합니다.

현재 배포 워크플로는 이미 암호화된 파일만 빌드하므로 GitHub Actions 비밀값이 필요하지
않습니다. 향후 GitHub Actions에서 자료 갱신과 암호화를 자동화한다면 저장소의 Actions
Secrets에 다음 이름으로 등록합니다.

- `KCSC_API_KEY`
- `APP_SHARED_PASSWORD`

## 정적 비밀번호 방식의 한계

이 구조는 평문 자료 노출과 소스 코드에 하드코딩한 비밀번호 문제를 막습니다. 그러나
서버 인증이 아니므로 다음 기능은 제공하지 않습니다.

- 사용자별 계정과 권한 회수
- 로그인 시도 횟수 제한
- 접속 기록과 감사 로그
- 공유 비밀번호 유출 시 특정 사용자만 차단

암호문은 누구나 내려받을 수 있으므로 짧은 비밀번호는 오프라인 대입 공격에 취약합니다.
비밀번호가 유출되면 `npm run secret:setup -- --rotate`로 새 값을 만들고 전체 자료를 다시
암호화한 뒤 배포합니다.

## AI 중계 서버의 보호 범위와 한계

중계 서버는 허용 출처 확인, 요청 크기 제한, 인증 토큰, IP별 분당 요청 제한을 적용하고
OpenAI 요청에 `store: false`를 지정합니다. 질문에는 검색 결과 최대 8건만 포함하며 원문
PDF 파일 전체는 보내지 않습니다.

Cloudflare 배포에서는 Rate Limiting binding으로 IP별 분당 10회를 제한합니다. 이 제한은
Cloudflare 위치별로 적용되고 비동기 집계되므로 정확한 과금 상한은 아닙니다. 브라우저의
CORS는 서버 API를 직접 호출하는 프로그램을 막는 인증 수단이 아니므로 반드시 AI 접속
토큰과 함께 사용합니다. 로컬 Node 서버의 속도 제한은 한 프로세스의 메모리에만 저장됩니다.

중계 서버는 기본적으로 클라이언트가 보낸 `X-Forwarded-For`를 신뢰하지 않습니다. 신뢰할 수
있는 호스팅 프록시가 해당 헤더를 덮어쓰는 환경에서만 `TRUST_PROXY=true`로 설정합니다. 화면의
공식 원문 링크는 `https:` 주소만 허용합니다.

브라우저는 API 호출 전에 이용료 발생 가능성을 고지하고 사용자의 세션별 확인을 요구합니다.
성공한 응답의 토큰 사용량은 현재 접속 중에만 누적 표시하며 원화 금액을 임의로 추산하지
않습니다. 이 화면 고지는 비용 통제를 대신하지 않으므로 공개 운영 시 OpenAI 프로젝트와
호스팅 서비스에도 별도의 사용 한도와 알림을 설정합니다.

## 배포 전 확인

1. `data/`, 원본 PDF, 원본 Excel, API 캐시가 웹 저장소에 없는지 확인합니다.
2. `public/vault/`에는 `manifest.json`, `index.enc`, `manual.enc`만 둡니다.
3. 빌드 결과에서 `APP_SHARED_PASSWORD`, `KCSC_API_KEY`, 키체인 서비스 값이 검색되지 않는지 확인합니다.
4. 잘못된 비밀번호로 잠금 해제가 실패하는지 확인합니다.
5. 올바른 비밀번호로 검색과 암호화 PDF 열기가 되는지 확인합니다.
6. 빌드 결과에 `OPENAI_API_KEY`, `AI_ACCESS_TOKEN`, `codex-openai-api`의 실제 값이 없는지 확인합니다.
7. AI 답변의 `[근거 N]`이 화면의 전달 근거와 일치하고, 근거가 없을 때 버튼이 비활성화되는지 확인합니다.
8. `npm run worker:test`와 Wrangler 배포 번들 검사가 통과하는지 확인합니다.
9. Cloudflare Secrets 목록에는 `OPENAI_API_KEY`, `AI_ACCESS_TOKEN` 이름만 표시되고 값은 노출되지 않는지 확인합니다.
