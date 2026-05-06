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

    mac_sig = first_match("*.app.tar.gz.sig")
    linux_sig = first_match("*_amd64.AppImage.sig")
    # Tauri v2 windows targets expect *.nsis.zip / *.msi.zip (updater bundles),
    # not the raw setup.exe. Prefer NSIS; fall back to MSI. Per-arch matching
    # keeps x64 and ARM64 entries distinct so each Windows host downloads its
    # native bundle (Prism emulation works for x64 binaries on ARM64 but adds
    # overhead and trips up some native API calls).
    win_x64_sig = (
        first_match("*_x64-setup.nsis.zip.sig")
        or first_match("*_x64_en-US.msi.zip.sig")
    )
    win_arm64_sig = (
        first_match("*_arm64-setup.nsis.zip.sig")
        or first_match("*_arm64_en-US.msi.zip.sig")
    )

    mac = entry(mac_sig, base)
    linux = entry(linux_sig, base)
    win_x64 = entry(win_x64_sig, base)
    win_arm64 = entry(win_arm64_sig, base)

    platforms: dict[str, dict] = {}
    if mac:
        platforms["darwin-aarch64"] = mac
        platforms["darwin-x86_64"] = mac
    if linux:
        platforms["linux-x86_64"] = linux
    if win_x64:
        platforms["windows-x86_64"] = win_x64
    if win_arm64:
        platforms["windows-aarch64"] = win_arm64

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
