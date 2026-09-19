#!/bin/sh
# Axis installer.
#
#   gh api repos/VirSanghavi/axis-hackathon/contents/install.sh -H "Accept: application/vnd.github.raw" | sh
#
# Downloads the single `axis` binary for this machine from the latest GitHub
# release, verifies its SHA-256, and puts it on your PATH. Works with `gh`
# (private repo), a GITHUB_TOKEN, or plain curl once the repo is public.
#
#   AXIS_VERSION=v2.0.0   install a specific release instead of the latest
#   AXIS_INSTALL_DIR=...  where to put the binary (default ~/.axis/bin)
#   AXIS_KERNEL=1         also install the kernel-tier enforcer (asks for sudo once)
set -eu

REPO="VirSanghavi/axis-hackathon"
DIR="${AXIS_INSTALL_DIR:-$HOME/.axis/bin}"
TAG="${AXIS_VERSION:-latest}"

say() { printf '%s\n' "$*"; }
fail() { printf 'axis install: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "unsupported OS $(uname -s). Axis runs on macOS and Linux." ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "unsupported CPU $(uname -m)." ;;
esac
asset="axis-$os-$arch"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Fetch the binary and the checksum file with whatever credentials are available.
fetched=""
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  if [ "$TAG" = latest ]; then set -- ; else set -- "$TAG"; fi
  if gh release download "$@" --repo "$REPO" --pattern "$asset" --pattern SHA256SUMS --dir "$tmp" 2>/dev/null; then fetched=gh; fi
fi
if [ -z "$fetched" ]; then
  command -v curl >/dev/null 2>&1 || fail "need curl (or the GitHub CLI, gh) to download Axis."
  auth=""
  [ -n "${GITHUB_TOKEN:-}" ] && auth="Authorization: Bearer $GITHUB_TOKEN"
  api="https://api.github.com/repos/$REPO/releases/$([ "$TAG" = latest ] && echo latest || echo "tags/$TAG")"
  release="$(curl -fsSL ${auth:+-H "$auth"} "$api" 2>/dev/null)" ||
    fail "cannot read $REPO releases. The repo is private: run 'gh auth login' (or set GITHUB_TOKEN) and retry."
  for name in "$asset" SHA256SUMS; do
    # Asset objects list their API "url" before their "name".
    url="$(printf '%s' "$release" | tr ',' '\n' | awk -v want="$name" '
      /"url": *"https:\/\/api\.github\.com\/repos\/[^"]*\/releases\/assets\// { match($0, /https:[^"]*/); u = substr($0, RSTART, RLENGTH) }
      /"name": *"/ { n = $0; sub(/.*"name": *"/, "", n); sub(/".*/, "", n); if (n == want && u != "") { print u; exit } }')"
    [ -n "$url" ] || fail "the release has no $name."
    curl -fsSL ${auth:+-H "$auth"} -H "Accept: application/octet-stream" -o "$tmp/$name" "$url" || fail "download of $name failed."
  done
  fetched=curl
fi

expected="$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)"
[ -n "$expected" ] || fail "SHA256SUMS has no entry for $asset."
if command -v shasum >/dev/null 2>&1; then actual="$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)"; else actual="$(sha256sum "$tmp/$asset" | cut -d' ' -f1)"; fi
[ "$expected" = "$actual" ] || fail "checksum mismatch for $asset (expected $expected, got $actual). Not installing."

mkdir -p "$DIR"
chmod 755 "$tmp/$asset"
[ "$os" = darwin ] && xattr -d com.apple.quarantine "$tmp/$asset" 2>/dev/null || true
mv -f "$tmp/$asset" "$DIR/axis"
say "✓ axis $("$DIR/axis" --version) installed to $DIR/axis (verified sha256, via $fetched)"

# Apps launched from the Dock do not read shell rc files; a link in a standard bin dir
# lets every agent host find `axis`. Never replace a different program of the same name.
for d in /opt/homebrew/bin /usr/local/bin; do
  if [ -d "$d" ] && [ -w "$d" ]; then
    if [ ! -e "$d/axis" ] || [ "$(readlink "$d/axis" 2>/dev/null)" = "$DIR/axis" ]; then
      ln -sf "$DIR/axis" "$d/axis" && say "  linked $d/axis"
    fi
    break
  fi
done

# Put it on PATH for future shells, once.
case ":$PATH:" in
  *":$DIR:"*) ;;
  *)
    line="export PATH=\"$DIR:\$PATH\""
    for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
      [ -f "$rc" ] || continue
      grep -qF "$DIR" "$rc" 2>/dev/null || printf '\n# axis\n%s\n' "$line" >>"$rc"
    done
    if [ -d "$HOME/.config/fish" ]; then
      mkdir -p "$HOME/.config/fish/conf.d"
      printf 'fish_add_path %s\n' "$DIR" >"$HOME/.config/fish/conf.d/axis.fish"
    fi
    say "  added $DIR to PATH (open a new shell, or: export PATH=\"$DIR:\$PATH\")"
    ;;
esac

if [ "${AXIS_KERNEL:-}" = 1 ]; then "$DIR/axis" enforcer install; fi

say ""
say "Next, in your repo:"
say "  axis init              set up this repo (or: axis join <invite> to join a teammate's)"
say "  axis doctor            prove locked files are enforced on this machine"
say "  axis enforcer install  optional: kernel tier, so even root-less tools cannot unseal"
