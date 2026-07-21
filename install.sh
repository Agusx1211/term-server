#!/bin/sh
set -eu

repository="${TERM_SERVER_REPO:-Agusx1211/term-server}"
channel="${TERM_SERVER_CHANNEL:-main}"
bin_dir="${TERM_SERVER_BIN_DIR:-${HOME:?HOME is required}/.local/bin}"
install_root="${TERM_SERVER_INSTALL_DIR:-$HOME/.local/lib/term-server}"
client_dir="$install_root/client"

case "$bin_dir:$install_root" in
  /*:/*) ;;
  *)
    echo "TERM_SERVER_BIN_DIR and TERM_SERVER_INSTALL_DIR must be absolute paths" >&2
    exit 1
    ;;
esac

if [ "$(uname -s)" != "Linux" ]; then
  echo "term-server currently provides prebuilt artifacts for Linux only." >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64 | amd64)
    architecture="x86_64"
    ;;
  aarch64 | arm64)
    architecture="aarch64"
    ;;
  *)
    echo "unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

archive="term-server-linux-${architecture}.tar.gz"
release_base="${TERM_SERVER_RELEASE_BASE_URL:-https://github.com/${repository}/releases/download/${channel}}"
temporary="$(mktemp -d "${TMPDIR:-/tmp}/term-server-install.XXXXXX")"
cleanup() {
  rm -rf -- "$temporary"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

download() {
  source_url="$1"
  destination="$2"
  if command -v curl >/dev/null 2>&1; then
    case "$source_url" in
      https://*) curl --proto '=https' --tlsv1.2 -fsSL --retry 3 --retry-delay 1 "$source_url" -o "$destination" ;;
      *) curl -fsSL --retry 3 --retry-delay 1 "$source_url" -o "$destination" ;;
    esac
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$source_url" -O "$destination"
  else
    echo "curl or wget is required" >&2
    exit 1
  fi
}

echo "Downloading term-server ${channel} for Linux ${architecture}..."
download "$release_base/$archive" "$temporary/$archive"
download "$release_base/SHA256SUMS" "$temporary/SHA256SUMS"

expected="$(awk -v name="$archive" '$2 == name { print $1; exit }' "$temporary/SHA256SUMS")"
if [ -z "$expected" ]; then
  echo "no checksum published for $archive" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$temporary/$archive" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$temporary/$archive" | awk '{ print $1 }')"
else
  echo "sha256sum or shasum is required to verify the download" >&2
  exit 1
fi

if [ "$expected" != "$actual" ]; then
  echo "checksum verification failed for $archive" >&2
  exit 1
fi

if tar -tzf "$temporary/$archive" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo "archive contains an unsafe path" >&2
  exit 1
fi

tar -xzf "$temporary/$archive" -C "$temporary"
package_dir="$temporary/term-server-linux-${architecture}"
if [ ! -x "$package_dir/term-server" ] || [ ! -f "$package_dir/client/index.html" ]; then
  echo "release archive is incomplete" >&2
  exit 1
fi

install -d "$bin_dir" "$install_root"
binary_next="$install_root/.term-server.new.$$"
client_next="$install_root/.client.new.$$"
client_previous="$install_root/.client.previous.$$"
link_next="$bin_dir/.term-server.link.$$"

install -m 0755 "$package_dir/term-server" "$binary_next"
cp -R "$package_dir/client" "$client_next"

if [ -e "$client_dir" ]; then
  mv "$client_dir" "$client_previous"
fi
if ! mv "$client_next" "$client_dir"; then
  if [ -e "$client_previous" ]; then
    mv "$client_previous" "$client_dir"
  fi
  exit 1
fi
mv "$binary_next" "$install_root/term-server"
ln -s "$install_root/term-server" "$link_next"
if [ -d "$bin_dir/term-server" ] && [ ! -L "$bin_dir/term-server" ]; then
  echo "$bin_dir/term-server is a directory; refusing to replace it" >&2
  exit 1
fi
mv "$link_next" "$bin_dir/term-server"
rm -rf -- "$client_previous"

"$bin_dir/term-server" --version
echo "Installed binary: $bin_dir/term-server"
echo "Installed client: $client_dir"
case ":${PATH:-}:" in
  *":$bin_dir:"*) ;;
  *) echo "Add $bin_dir to PATH, then run: term-server" ;;
esac
