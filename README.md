# 설비 근거검색

기계설비 매뉴얼, 법령, KDS·KCS 근거를 검색하고, 선택된 근거만 OpenAI에 전달해
답변을 만드는 Vue 3 웹 앱입니다.

## 보안 구조

- GitHub Pages에는 Vue 앱과 암호화된 검색 인덱스·PDF만 배포합니다.
- 공유 비밀번호는 저장소, 빌드 결과, 브라우저 저장소에 넣지 않습니다.
- 브라우저 표준 Web Crypto API의 PBKDF2와 AES-GCM을 사용합니다.
- KCSC API 키는 macOS 키체인 `codex-kcsc-api`에만 보관합니다.
- OpenAI API 키는 macOS 키체인 `codex-openai-api`에만 보관합니다.
- 공유 비밀번호는 macOS 키체인 `codex-facility-search-password`에만 보관합니다.

상세한 한계와 운영 절차는 [SECURITY.md](SECURITY.md)를 참고하세요.

서비스 구성, 데이터 처리 방식, 이용 절차와 공개 가능한 보안 원칙은
[서비스 구조와 사용 안내](docs/서비스_구조와_사용_안내.md)를 참고하세요.

## 로컬 갱신

```sh
npm run secret:setup
npm run data:build
npm run vault:encrypt
npm run dev
```

`data/search-index.json`은 평문이므로 `.gitignore`에 포함되어 있습니다. 배포 전에는
`public/vault/`에 생성된 암호화 파일만 커밋합니다.

## 로컬 AI 실행

이 프로젝트는 nvm의 `.nvmrc`로 Node.js 22를 사용합니다. 프로젝트 폴더에서 다음 명령을
한 번 실행하면 필요한 버전을 설치하고 이후에는 `nvm use`로 전환할 수 있습니다.

```sh
nvm install
nvm use
node --version
```

Node.js 22에서 터미널 두 개를 사용합니다. 로컬 실행 시 중계 서버는 OpenAI 키와
공유 비밀번호를 macOS 키체인에서 직접 읽으므로 `.env`에 비밀값을 복사할 필요가 없습니다.

첫 번째 터미널:

```sh
npm run ai:server
```

두 번째 터미널:

```sh
npm run dev
```

검색어 또는 질문을 입력한 뒤 `비용 발생 · AI 답변 생성`을 누르면 관련도 상위 8건만 중계
서버로 전송됩니다. 중계 서버는 OpenAI Responses API에 `store: false`로 요청하며 기본
모델은 `gpt-5.6-terra`입니다.

AI 질문은 전송할 때마다 API 이용료가 발생할 수 있습니다. 사용자는 비용 안내 확인란에
동의해야 호출 버튼을 사용할 수 있으며, 성공한 질문 횟수와 입력·출력·합계 토큰은 현재
접속 세션 동안 누적 표시됩니다. 이 확인과 집계는 브라우저에 저장하지 않으므로 자료를
잠그거나 페이지를 새로 열면 초기화됩니다.

## Cloudflare Workers에 AI 중계 서버 배포

GitHub Pages는 Node.js 서버를 실행할 수 없으므로 Vue 화면과 AI 중계 서버를 나누어
배포합니다. 현재 운영 계정은 Cloudflare Workers Paid 플랜이며 Wrangler는 전역 설치하지
않고 이 프로젝트의 개발 의존성으로만 관리합니다. 월 최소 5달러의 기본요금과 별도로 포함량을
넘는 사용에는 초과 요금이 발생할 수 있습니다.

- GitHub Pages: Vue 화면과 암호화 자료
- Cloudflare Workers: `worker/index.mjs`와 암호화된 OpenAI 비밀키

처음 한 번 다음 순서로 실행합니다.

```sh
nvm use
npm ci
npx wrangler login --use-keyring
npm run worker:deploy
npm run worker:secrets
```

`worker:secrets`는 macOS 키체인의 `codex-openai-api`와
`codex-facility-search-password`를 읽어 실제 값을 출력하거나 파일에 남기지 않고
`OPENAI_API_KEY`, `AI_ACCESS_TOKEN` Cloudflare Secrets를 등록합니다. Worker에는 IP별 분당
10회의 속도 제한이 적용됩니다.

현재 배포된 Worker와 Vue에서 사용하는 중계 주소는 다음과 같습니다.

```text
https://mep-evidence-ai.ygchoi77.workers.dev/api/ask
```

이 공개 URL은 비밀값이 아닙니다. GitHub 저장소의 Actions 변수 `VITE_AI_API_URL`에도 같은
값을 등록했습니다. `main` 브랜치에 푸시하면 GitHub Pages가 해당 중계 서버 주소를 포함해
다시 배포됩니다.

코드 변경 후에는 다음 명령으로 검사하고 다시 배포합니다.

```sh
npm run worker:test
npm run worker:deploy
```

OpenAI 공식 모델 지침에 따라 비용과 품질의 균형이 필요한 이 검색 업무에는
`gpt-5.6-terra`와 `reasoning.effort: low`를 명시적으로 사용합니다. 모델은
`wrangler.jsonc`의 `OPENAI_MODEL`에서 변경할 수 있습니다.

## GitHub Pages

`main` 브랜치에 푸시하면 `.github/workflows/pages.yml`이 Vue 앱을 빌드하고 Pages에
배포합니다. 저장소의 Pages 설정에서 Source를 `GitHub Actions`로 선택해야 합니다.

## 프로젝트 전용 GitHub CLI

GitHub CLI는 Homebrew 전역 설치 대신 이 프로젝트의 `.tools/bin/gh`에 둘 수 있습니다.

```sh
./scripts/install-gh-local.sh
./scripts/gh --version
./scripts/gh auth login --hostname github.com --git-protocol https --web
```

`.tools/`는 Git에서 제외됩니다. 실행 파일은 프로젝트 단위로 관리하지만 로그인 토큰은
프로젝트 파일이 아니라 macOS 보안 저장소에 보관합니다.
