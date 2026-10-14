#!/usr/bin/env bash
# Installs the pinned encoders and recorders of docs-media/ (README.md#publishing-publishpy, #terminal-tapes):
# release binaries, checked against their SHA-256, into $DOCS_MEDIA_BIN (default ~/.cache/qaboard-docs-media/bin).
# publish.py and tapes/record.py find them there; CI adds the folder to its PATH.
#   docs-media/install-tools.sh                  # everything
#   docs-media/install-tools.sh oxipng avifenc   # some
# ffmpeg comes from the distribution (Ubuntu 24.04: 6.1.1, with libx264 and libvpx): apt-get install ffmpeg
set -euo pipefail

BIN="${DOCS_MEDIA_BIN:-$HOME/.cache/qaboard-docs-media/bin}"
GH=https://github.com

# name version url sha256
TOOLS=(
  "oxipng 10.2.0 $GH/oxipng/oxipng/releases/download/v10.2.0/oxipng-10.2.0-x86_64-unknown-linux-musl.tar.gz a27ecb29faab9da1549f4a243bab12f1e43e4ed8ae6a2a2186a543dc9ffd3956"
  "avifenc 1.4.2 $GH/AOMediaCodec/libavif/releases/download/v1.4.2/linux-artifacts.zip faf58a670ffbfdc0e3559e6d37592cff277c447dd39453f1cd1d7d7f5a20b8ef"
  "cwebp 1.6.0 https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0-linux-x86-64.tar.gz 1c5ffab71efecefa0e3c23516c3a3a1dccb45cc310ae1095c6f14ae268e38067"
  # not 0.12.x: it renders with a cancelled context, so ffmpeg never runs and no video is written
  "vhs 0.11.0 $GH/charmbracelet/vhs/releases/download/v0.11.0/vhs_0.11.0_Linux_x86_64.tar.gz 99cb634587eaae0473c1ea377db80c3a048c27f99fe0a7febb1a1e8cb7ee5009"
  "ttyd 1.7.7 $GH/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55"
  "actionlint 1.7.12 $GH/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz 8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"
)

if [ "$(uname -sm)" != "Linux x86_64" ]; then
  echo "install-tools.sh: only Linux x86_64 binaries are pinned. Elsewhere, install oxipng, avifenc, cwebp, vhs and ttyd yourself." >&2
  exit 1
fi

wanted=("$@")
mkdir -p "$BIN"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

for line in "${TOOLS[@]}"; do
  read -r name version url sha256 <<< "$line"
  if [ ${#wanted[@]} -gt 0 ]; then
    case " ${wanted[*]} " in *" $name "*) ;; *) continue ;; esac
  fi
  stamp="$BIN/.$name-$version"
  if [ -f "$stamp" ] && [ -x "$BIN/$name" ]; then continue; fi
  echo "Installing $name $version" >&2
  archive="$work/$name.download"
  curl -sSfL --retry 3 -o "$archive" "$url"
  echo "$sha256  $archive" | sha256sum -c --quiet -
  dir="$work/$name"
  mkdir -p "$dir"
  case "$url" in
    *.zip) unzip -q "$archive" -d "$dir" ;;
    *.tar.gz) tar -xzf "$archive" -C "$dir" ;;
    *) cp "$archive" "$dir/$name" ;;
  esac
  case "$name" in
    cwebp) binaries=(cwebp dwebp webpinfo) ;;
    avifenc) binaries=(avifenc avifdec) ;;
    *) binaries=("$name") ;;
  esac
  for binary in "${binaries[@]}"; do
    found=$(find "$dir" -type f -name "$binary" | head -1)
    [ -n "$found" ] || { echo "install-tools.sh: $binary not found in $url" >&2; exit 1; }
    install -m 755 "$found" "$BIN/$binary"
  done
  rm -f "$BIN/.$name-"*
  touch "$stamp"
done

echo "$BIN"
