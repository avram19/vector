---
title: Install
description: Download and install Vector on macOS or Linux.
---

## macOS

Download the latest `.dmg` from [Releases](https://github.com/avram19/vector/releases), drag Vector into `/Applications`, open it. Because the build is unsigned, Gatekeeper blocks it the first time — right-click → Open → Open, or `xattr -dr com.apple.quarantine /Applications/Vector.app`.

## Linux

Vector runs on x86_64 and aarch64 via WebKitGTK.

- **.deb (recommended):** `sudo apt install ./Vector_<ver>_amd64.deb` (apt pulls the WebKitGTK deps); launch **Vector** from your app menu.
- **AppImage:** `chmod +x Vector_<ver>_amd64.AppImage && ./Vector_<ver>_amd64.AppImage`. If a lib is missing: `sudo apt install libwebkit2gtk-4.1-0 libgtk-3-0 libayatana-appindicator3-1`.

Clipboard file-paste uses `wl-clipboard` (Wayland) or `xclip` (X11).
