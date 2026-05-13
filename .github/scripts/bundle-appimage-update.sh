#!/usr/bin/env bash
# Post-build hook for Linux: turn the AppImage that `tauri build` produced
# into an updateable AppImage.
#
# Three things happen here:
#   1. Bundle `appimageupdatetool`'s inner binary into our AppImage at
#      usr/bin/. The Rust command `linux_appimage_update` shells out to it.
#   2. Repack the AppImage with `appimagetool --updateinformation`, which
#      writes a `gh-releases-zsync|...` string into the runtime's .upd_info
#      ELF section. AppImageUpdate reads this on update check to find the
#      .zsync sidecar URL.
#   3. Generate the .zsync sidecar with `zsyncmake`. Uploaded alongside the
#      .AppImage to each GitHub release so AppImageUpdate can do delta
#      downloads.
#
# Runs once per architecture (the workflow matrix has x64 and arm64). Both
# the bundled tool and `appimagetool` need to match the runner's arch.
#
# Note: rewriting the AppImage invalidates Tauri's emitted `.AppImage.sig`.
# v0.2.11+ Linux clients ignore that .sig entirely (they bypass Tauri's
# plugin-updater and use AppImageUpdate's zsync per-chunk SHA1 chain
# instead). But pre-v0.2.11 AppImage installs in the wild DO consult
# `latest.json` through Tauri's plugin-updater and need a verifying
# signature to land on v0.2.11. So when TAURI_SIGNING_PRIVATE_KEY is in
# the env (CI), we re-sign the modified AppImage; when it isn't (local
# dev / unsigned builds), we drop the stale .sig and skip. Once the
# pre-v0.2.11 cohort is gone, this re-sign step + the linux-* keys in
# make-latest-json.py can be removed.
set -euo pipefail

APPIMAGE_BUNDLE_DIR="src-tauri/target/release/bundle/appimage"
ZSYNC_REPO="skillsafe/ai-skillsafe-app"
# `gh-releases-zsync|<owner>|<repo>|<tag-prefix or "latest">|<filename pattern>`
# `latest` follows the "latest" release pointer on GitHub (the marketing-page
# semantics), so users on any version pick up the newest release without
# having to know a specific tag. The `*` in the filename matches the version
# part of `AI.SkillSafe_<version>_<arch>.AppImage`.

# Detect arch — `appimagetool` and the bundled `appimageupdatetool` must
# match the runner. Use uname -m so this works on both ubuntu-latest (x64)
# and ubuntu-24.04-arm (aarch64) GHA images.
ARCH_M=$(uname -m)
case "$ARCH_M" in
  x86_64)  APPIMAGE_ARCH="amd64"   ; TOOL_ARCH="x86_64"  ;;
  aarch64) APPIMAGE_ARCH="aarch64" ; TOOL_ARCH="aarch64" ;;
  *) echo "::error::Unsupported arch for AppImage bundle: $ARCH_M" >&2; exit 1 ;;
esac

# Find the AppImage Tauri just emitted (one per arch per build, but glob
# defensively so a future multi-bundle setup doesn't silently miss files).
mapfile -t APPIMAGES < <(find "$APPIMAGE_BUNDLE_DIR" -maxdepth 2 -name '*.AppImage' -type f 2>/dev/null || true)
if [[ ${#APPIMAGES[@]} -eq 0 ]]; then
  echo "::notice::No .AppImage found under $APPIMAGE_BUNDLE_DIR — skipping bundle step (non-Linux build?)"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- Tools ----------------------------------------------------------------

APPIMAGETOOL_URL="https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-${TOOL_ARCH}.AppImage"
APPIMAGEUPDATE_URL="https://github.com/AppImage/AppImageUpdate/releases/download/continuous/appimageupdatetool-${TOOL_ARCH}.AppImage"

echo "==> Downloading appimagetool ($TOOL_ARCH)"
curl -fsSL -o "$WORK/appimagetool.AppImage" "$APPIMAGETOOL_URL"
chmod +x "$WORK/appimagetool.AppImage"

echo "==> Downloading appimageupdatetool ($TOOL_ARCH)"
curl -fsSL -o "$WORK/appimageupdatetool.AppImage" "$APPIMAGEUPDATE_URL"
chmod +x "$WORK/appimageupdatetool.AppImage"

# Extract appimageupdatetool's payload so we get a plain ELF — nested
# AppImages don't always work (FUSE-mount-inside-FUSE-mount), and we don't
# need the runtime wrapper since we only call the tool, not launch it as a
# standalone app.
echo "==> Extracting appimageupdatetool payload"
(
  cd "$WORK"
  ./appimageupdatetool.AppImage --appimage-extract >/dev/null
  # The extract creates ./squashfs-root/ — we'll pick its inner binary below
  # and rename to keep names tidy.
  mv squashfs-root appimageupdatetool-extracted
)

# --- Process each AppImage ------------------------------------------------

ensure_zsyncmake() {
  if ! command -v zsyncmake >/dev/null 2>&1; then
    echo "==> Installing zsync (zsyncmake)"
    sudo apt-get update -qq
    sudo apt-get install -y zsync
  fi
}
ensure_zsyncmake

# `appimagetool` needs ARCH set explicitly when running on a non-native
# combination or when it can't auto-detect from the squashfs-root contents.
export ARCH="$TOOL_ARCH"
# Skip libfuse host check: it's an AppImage, of course it works on the
# runner — and we already extracted the inner content earlier.
export APPIMAGE_EXTRACT_AND_RUN=1

for APPIMAGE in "${APPIMAGES[@]}"; do
  # `find` returns the path relative to the workflow cwd, but we `cd` into a
  # tmp dir for the extract step (and possibly for `npx tauri signer sign`),
  # at which point the relative path no longer resolves. Anchor it now.
  APPIMAGE="$(realpath "$APPIMAGE")"
  echo
  echo "==> Patching $(basename "$APPIMAGE")"
  AP_DIR="$(dirname "$APPIMAGE")"
  AP_NAME="$(basename "$APPIMAGE")"

  # 1. Extract our AppImage into a working tree.
  EXTRACT_DIR="$WORK/extract-$AP_NAME"
  mkdir -p "$EXTRACT_DIR"
  (
    cd "$EXTRACT_DIR"
    "$APPIMAGE" --appimage-extract >/dev/null
  )

  # 2. Drop the appimageupdatetool binary into usr/bin/.
  TOOL_DEST="$EXTRACT_DIR/squashfs-root/usr/bin/appimageupdatetool"
  mkdir -p "$(dirname "$TOOL_DEST")"
  # Use the inner ELF if available; some AppImageUpdate builds put the real
  # binary at AppRun, others at usr/bin/. Prefer the explicit path and fall
  # back to AppRun.
  SRC_TOOL="$WORK/appimageupdatetool-extracted/usr/bin/appimageupdatetool"
  if [[ ! -f "$SRC_TOOL" ]]; then
    SRC_TOOL="$WORK/appimageupdatetool-extracted/AppRun"
  fi
  if [[ ! -f "$SRC_TOOL" ]]; then
    echo "::error::Could not locate appimageupdatetool binary inside the extracted AppImage"
    ls -la "$WORK/appimageupdatetool-extracted" || true
    ls -la "$WORK/appimageupdatetool-extracted/usr/bin" || true
    exit 1
  fi
  cp "$SRC_TOOL" "$TOOL_DEST"
  chmod +x "$TOOL_DEST"

  # The tool's own shared libs (if any) need to come along. The continuous
  # appimageupdatetool build links libcurl/libssl statically into the
  # binary, so we don't need to copy usr/lib. If a future release breaks
  # that assumption, add a copy of squashfs-root/usr/lib here.

  # 3. Repack with --updateinformation.
  UPD_INFO="gh-releases-zsync|skillsafe|ai-skillsafe-app|latest|AI.SkillSafe_*_${APPIMAGE_ARCH}.AppImage.zsync"
  echo "    upd_info = $UPD_INFO"
  OUT="$AP_DIR/$AP_NAME"
  rm -f "$OUT"
  "$WORK/appimagetool.AppImage" \
    --no-appstream \
    --updateinformation "$UPD_INFO" \
    "$EXTRACT_DIR/squashfs-root" \
    "$OUT"
  chmod +x "$OUT"

  # 4. Generate the .zsync sidecar. zsyncmake's -u sets the absolute URL
  # used to fetch the corresponding .AppImage if the local file is missing
  # (zsync's fallback path); GitHub release downloads work, so point at
  # the asset URL pattern.
  echo "==> Generating .zsync sidecar for $AP_NAME"
  (
    cd "$AP_DIR"
    zsyncmake -u "https://github.com/${ZSYNC_REPO}/releases/latest/download/${AP_NAME}" "$AP_NAME"
  )

  # 5. Re-sign for the v0.2.10 → v0.2.11 Tauri-updater bridge (see header).
  # `tauri signer sign` writes `<file>.sig` with the same format as the
  # bundler's auto-signing, picking up TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]
  # from the env. The old .sig is overwritten in place.
  rm -f "${OUT}.sig"
  if [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
    echo "==> Re-signing $AP_NAME"
    npx --no-install tauri signer sign "$OUT"
    if [[ ! -f "${OUT}.sig" ]]; then
      echo "::error::tauri signer sign did not produce ${OUT}.sig"
      exit 1
    fi
  else
    echo "::notice::TAURI_SIGNING_PRIVATE_KEY not set — leaving $AP_NAME unsigned. Pre-v0.2.11 clients will not be able to auto-update from this build."
  fi

  echo "==> Done: $OUT (+ $(basename "$OUT").zsync$( [[ -f "${OUT}.sig" ]] && echo " + .sig" ))"
done
