#!/usr/bin/env bash
set -euo pipefail

dev_data_dir="$(mktemp -d "${TMPDIR:-/tmp}/term-server-dev.XXXXXX")"

cleanup() {
  if [[ "$dev_data_dir" == "${TMPDIR:-/tmp}/term-server-dev."* && -d "$dev_data_dir" ]]; then
    rm -r -- "$dev_data_dir"
  fi
}
trap cleanup EXIT

TERM_SERVER_DATA_DIR="$dev_data_dir" \
TERM_SERVER_PASSWORD=development \
  cargo run -- --no-https --no-client --host 127.0.0.1 --port 8090
