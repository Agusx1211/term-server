#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

case "${1:-$(uname -m)}" in
  x86_64 | amd64)
    architecture="x86_64"
    ;;
  aarch64 | arm64)
    architecture="aarch64"
    ;;
  *)
    echo "unsupported architecture: ${1:-$(uname -m)}" >&2
    exit 1
    ;;
esac

binary="${TERM_SERVER_BINARY:-target/release/term-server}"
output_dir="${TERM_SERVER_ARTIFACT_DIR:-artifacts}"
package="term-server-linux-${architecture}"
archive="${output_dir}/${package}.tar.gz"

if [[ ! -x "$binary" ]]; then
  echo "missing release binary at $binary; run cargo build --release --locked" >&2
  exit 1
fi
if [[ ! -f dist/client/index.html ]]; then
  echo "missing browser build at dist/client; run npm run build:client" >&2
  exit 1
fi

staging="$(mktemp -d "${TMPDIR:-/tmp}/term-server-package.XXXXXX")"
trap 'rm -rf -- "$staging"' EXIT

install -d "$staging/$package/client" "$staging/$package/skills" "$output_dir"
install -m 0755 "$binary" "$staging/$package/term-server"
cp -R dist/client/. "$staging/$package/client/"
cp -R skills/term-server-artifacts "$staging/$package/skills/"
install -m 0644 LICENSE README.md "$staging/$package/"
install -m 0644 deploy/term-server.service "$staging/$package/term-server.service"
install -d "$staging/$package/docs" "$staging/$package/src/client/public"
cp -R docs/screenshots "$staging/$package/docs/"
install -m 0644 src/client/public/favicon.svg "$staging/$package/src/client/public/favicon.svg"

tar \
  --sort=name \
  --mtime="@${SOURCE_DATE_EPOCH:-0}" \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  -C "$staging" \
  -cf - "$package" \
  | gzip -n > "$archive"

echo "$archive"
