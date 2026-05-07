#!/usr/bin/env python3
"""Generate Tauri updater `latest.json` from .sig files in the cwd.

Inputs (env):
  REPO       — "owner/name"
  TAG        — e.g. "v0.1.3"
  PUB_DATE   — ISO-8601 UTC timestamp

The script scans the current directory for .sig files matching each platform's
updater bundle, then emits the manifest on stdout.
"""

from __future__ import annotations

import glob
import json
import os
import sys
import urllib.parse
from datetime import datetime, timezone


def first_match(pattern: str) -> str | None:
    matches = sorted(glob.glob(pattern))
    return matches[0] if matches else None


def entry(sig_filename: str | None, base: str) -> dict | None:
    if not sig_filename:
        return None
    bundle = sig_filename[: -len(".sig")]
    with open(sig_filename, "r", encoding="utf-8") as fh:
        sig = fh.read().replace("\r", "").replace("\n", "")
    return {"signature": sig, "url": f"{base}/{urllib.parse.quote(bundle)}"}


def main() -> int:
    repo = os.environ["REPO"]
    tag = os.environ["TAG"]
    version = tag[1:] if tag.startswith("v") else tag
    pub_date = os.environ.get("PUB_DATE") or datetime.now(timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    base = f"https://github.com/{repo}/releases/download/{tag}"

    # Tauri v2 (non-v1-compatible) signs each per-platform bundle directly,
    # no .tar.gz / .zip wrap (except macOS, which has to tar the .app dir):
    #   * macOS: *.app.tar.gz (universal) + .sig
    #   * Windows: *_<arch>-setup.exe + .sig (NSIS — we no longer ship MSI)
    #   * Linux:  *_<arch>.AppImage + .sig — note Tauri labels the ARM
    #     AppImage `_aarch64.AppImage` while the same-arch .deb is
    #     `_arm64.deb`. Don't "normalize" the script to one label.
    # Linux .deb installs are manual-update only: the Tauri bundler doesn't
    # auto-sign .deb (only AppImage / NSIS / MSI / app.tar.gz), so we have no
    # signed .deb to publish. Users on .deb need a one-time manual update to
    # the AppImage to start receiving auto-updates.
    mac_sig = first_match("*.app.tar.gz.sig")
    win_x64_sig = first_match("*_x64-setup.exe.sig")
    win_arm64_sig = first_match("*_arm64-setup.exe.sig")
    linux_x64_sig = first_match("*_amd64.AppImage.sig")
    linux_arm64_sig = first_match("*_aarch64.AppImage.sig")

    mac = entry(mac_sig, base)
    win_x64 = entry(win_x64_sig, base)
    win_arm64 = entry(win_arm64_sig, base)
    linux_x64 = entry(linux_x64_sig, base)
    linux_arm64 = entry(linux_arm64_sig, base)

    platforms: dict[str, dict] = {}
    if mac:
        platforms["darwin-aarch64"] = mac
        platforms["darwin-x86_64"] = mac
    if win_x64:
        platforms["windows-x86_64"] = win_x64
    if win_arm64:
        platforms["windows-aarch64"] = win_arm64
    if linux_x64:
        platforms["linux-x86_64"] = linux_x64
    if linux_arm64:
        platforms["linux-aarch64"] = linux_arm64

    if not platforms:
        print("error: no .sig files found in cwd", file=sys.stderr)
        return 1

    out = {
        "version": version,
        "notes": f"See https://github.com/{repo}/releases/tag/{tag}",
        "pub_date": pub_date,
        "platforms": platforms,
    }
    json.dump(out, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
