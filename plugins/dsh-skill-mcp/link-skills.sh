#!/usr/bin/env bash
# Link every skill subdirectory under a source directory into the user
# skills root — the macOS/Linux counterpart of link-skills.ps1 (which uses
# NTFS junctions; POSIX gets plain symlinks). Same semantics: an existing
# link at the target is replaced, a real directory or file aborts the run.
#
# usage: link-skills.sh <source-directory> [target-directory]
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: link-skills.sh <source-directory> [target-directory]" >&2
  exit 2
fi

SOURCE=$(cd "$1" 2>/dev/null && pwd) || { echo "Source directory not found: $1" >&2; exit 1; }
TARGET="${2:-${DSH_HOME:-$HOME/.dsh}/skills}"

[ -d "$SOURCE" ] || { echo "Not a directory: $SOURCE" >&2; exit 1; }
mkdir -p "$TARGET"

shopt -s nullglob dotglob
for src in "$SOURCE"/*/; do
  name=$(basename "$src")
  link="$TARGET/$name"
  if [ -L "$link" ]; then
    rm "$link"
  elif [ -e "$link" ]; then
    echo "Target exists and is not a link: $link" >&2
    exit 1
  fi
  ln -s "${src%/}" "$link"
done
