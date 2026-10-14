#!/bin/sh
# The test invokes this immutable script through a symlink in its private root.
set -eu
fixture_root=$(dirname "$0")
case "$1 $2" in
  'plugin list') cat "$fixture_root/listing.json" ;;
  'plugin install')
    printf 'install\n' >> "$fixture_root/calls"
    mkdir -p "$fixture_root/installed"
    cp -R "$3/." "$fixture_root/installed"
    cp "$fixture_root/enabled.json" "$fixture_root/listing.json"
    ;;
  'plugin enable')
    printf 'enable\n' >> "$fixture_root/calls"
    cp "$fixture_root/enabled.json" "$fixture_root/listing.json"
    ;;
  'plugin uninstall')
    printf 'uninstall\n' >> "$fixture_root/calls"
    printf '[]' > "$fixture_root/listing.json"
    ;;
  *) exit 1 ;;
esac
