#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
install_dir="$project_root/.tools/bin"
temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/gh-local.XXXXXX")

cleanup() {
  rm -rf "$temp_dir"
}
trap cleanup EXIT HUP INT TERM

case "$(uname -m)" in
  arm64) archive_arch="arm64" ;;
  x86_64) archive_arch="amd64" ;;
  *)
    echo "지원하지 않는 macOS 아키텍처입니다: $(uname -m)" >&2
    exit 1
    ;;
esac

release_json="$temp_dir/release.json"
curl -fsSL "https://api.github.com/repos/cli/cli/releases/latest" -o "$release_json"
version=$(sed -n 's/.*"tag_name": "v\([^"]*\)".*/\1/p' "$release_json" | head -n 1)

if [ -z "$version" ]; then
  echo "GitHub CLI 최신 버전을 확인하지 못했습니다." >&2
  exit 1
fi

archive="gh_${version}_macOS_${archive_arch}.zip"
base_url="https://github.com/cli/cli/releases/download/v${version}"

curl -fsSL "$base_url/$archive" -o "$temp_dir/$archive"
curl -fsSL "$base_url/gh_${version}_checksums.txt" -o "$temp_dir/checksums.txt"

expected=$(awk -v name="$archive" '$2 == name { print $1 }' "$temp_dir/checksums.txt")
actual=$(shasum -a 256 "$temp_dir/$archive" | awk '{ print $1 }')

if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "GitHub CLI 압축 파일의 SHA-256 검증에 실패했습니다." >&2
  exit 1
fi

unzip -q "$temp_dir/$archive" -d "$temp_dir"
mkdir -p "$install_dir"
cp "$temp_dir/gh_${version}_macOS_${archive_arch}/bin/gh" "$install_dir/gh"
chmod 0755 "$install_dir/gh"

"$install_dir/gh" --version | head -n 1
echo "설치 위치: .tools/bin/gh"
