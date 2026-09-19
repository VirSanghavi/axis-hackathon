#!/bin/sh
# Build the README demo assets from the recorded demo.
#
#   sh docs/make-demo-assets.sh <video.mp4> [poster_s] [gif_start] [gif_len] [crop]
#
# Defaults are measured against the shipped 200.7s cut, not guessed:
#   poster t=50   the only second holding the whole argument at once: the lock,
#                 the uchg flag on the file, the rogue write, and the refusal.
#   GIF   t=42.5 +10s   opens with the lock already taken, then ls -lO reveals
#                 uchg, echo hacked is typed, and the kernel refuses. The first
#                 two lines are identical in the first and last frame, so the
#                 loop restarts cleanly.
#   crop  1300:240:0:552   the terminal proof lines only. The shot is a
#                 full-screen terminal from about t=36 to t=52, and the burned-in
#                 captions sit at y=911..956, so this crop clears them. The
#                 seven text bands run y=559..784; starting at 552 avoids the
#                 descenders of the diff line above. Text spans x=7..1247,
#                 so the crop starts at x=0 rather than clipping the prompt glyph.
#
# Produces, next to this script:
#   docs/demo.gif         the inline preview the README shows at the top
#   docs/demo-poster.png  the still, used when the GIF is not wanted
#
# WHY CROP. GitHub renders the README image at about 832px on a desktop and
# about 358px on a phone. The source is 1920x1080 of graded desk, vignette and
# terminal, so scaling the whole frame to 900px leaves body text around 10px,
# and roughly 4px on a phone: unreadable. Passing a crop of just the terminal
# region raises the effective size enough to read. `crop` is an ffmpeg crop
# expression, w:h:x:y, in source pixels.
#
#   sh docs/make-demo-assets.sh docs/axis-demo.mp4 50 42.5 10 1300:240:0:552
#
set -eu

SRC=${1:?usage: make-demo-assets.sh <video.mp4> [poster_s] [gif_start] [gif_len] [crop]}
POSTER_AT=${2:-50}
GIF_START=${3:-42.5}
GIF_LEN=${4:-10}
CROP=${5:-1300:240:0:552}
DOCS=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

command -v ffmpeg >/dev/null || { echo "ffmpeg not found (brew install ffmpeg)"; exit 1; }
[ -f "$SRC" ] || { echo "no such file: $SRC"; exit 1; }

# Build the filter prefix once: optional crop, then scale to the README width.
if [ -n "$CROP" ]; then PRE="crop=$CROP,"; else PRE=""; fi
GIF_W=898
POSTER_W=1498
BORDER=0x8b949e   # 1px neutral edge, legible on both GitHub themes

# GIF: two-pass palette. The source is flat paper with sharp text, so dithering
# only adds noise that GIF then has to encode: dither=none with a 96 colour
# palette is visually identical here and about a third of the bytes.
ffmpeg -v error -y -ss "$GIF_START" -t "$GIF_LEN" -i "$SRC" \
  -vf "${PRE}fps=12,scale=$GIF_W:-2:flags=lanczos,pad=iw+2:ih+2:1:1:color=$BORDER,palettegen=max_colors=96:stats_mode=diff" \
  "$DOCS/.palette.png"
ffmpeg -v error -y -ss "$GIF_START" -t "$GIF_LEN" -i "$SRC" -i "$DOCS/.palette.png" \
  -lavfi "${PRE}fps=12,scale=$GIF_W:-2:flags=lanczos,pad=iw+2:ih+2:1:1:color=$BORDER[x];[x][1:v]paletteuse=dither=none" \
  "$DOCS/demo.gif"
rm -f "$DOCS/.palette.png"

# Poster: one frame, same crop, at twice the desktop display width.
ffmpeg -v error -y -ss "$POSTER_AT" -i "$SRC" -frames:v 1 \
  -vf "${PRE}scale=$POSTER_W:-2:flags=lanczos,pad=iw+2:ih+2:1:1:color=$BORDER" "$DOCS/demo-poster.png"

echo "wrote:"
ls -lh "$DOCS/demo.gif" "$DOCS/demo-poster.png"
echo
echo "Check both before committing. GitHub shows them at ~832px (desktop) and"
echo "~358px (phone); if the terminal text is not readable at 358px, crop tighter."
echo "GitHub stops animating a README GIF above about 10 MB: shorten GIF_LEN or"
echo "drop fps=12 to fps=10 if demo.gif is larger."
