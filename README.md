# 설비 근거검색

기계설비 매뉴얼, 법령, KDS·KCS 근거를 검색하는 Vue 3 정적 웹 앱입니다.

## 보안 구조

- GitHub Pages에는 Vue 앱과 암호화된 검색 인덱스·PDF만 배포합니다.
- 공유 비밀번호는 저장소, 빌드 결과, 브라우저 저장소에 넣지 않습니다.
- 브라우저 표준 Web Crypto API의 PBKDF2와 AES-GCM을 사용합니다.
- KCSC API 키는 macOS 키체인 `codex-kcsc-api`에만 보관합니다.
- 공유 비밀번호는 macOS 키체인 `codex-facility-search-password`에만 보관합니다.

상세한 한계와 운영 절차는 [SECURITY.md](SECURITY.md)를 참고하세요.

## 로컬 갱신

```sh
npm run secret:setup
npm run data:build
npm run vault:encrypt
npm run dev
```

`data/search-index.json`은 평문이므로 `.gitignore`에 포함되어 있습니다. 배포 전에는
`public/vault/`에 생성된 암호화 파일만 커밋합니다.

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
