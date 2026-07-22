---
title: Install
description: Download and install Vector on macOS, Linux, or Windows.
---

## macOS

Download the latest `.dmg` from [Releases](https://github.com/avram19/vector/releases), drag Vector into `/Applications`, open it. Because the build is unsigned, Gatekeeper blocks it the first time — right-click → Open → Open, or `xattr -dr com.apple.quarantine /Applications/Vector.app`.

## Linux

Vector runs on x86_64 and aarch64 via WebKitGTK.

- **.deb (recommended):** `sudo apt install ./Vector_<ver>_amd64.deb` (apt pulls the WebKitGTK deps); launch **Vector** from your app menu.
- **AppImage:** `chmod +x Vector_<ver>_amd64.AppImage && ./Vector_<ver>_amd64.AppImage`. If a lib is missing: `sudo apt install libwebkit2gtk-4.1-0 libgtk-3-0 libayatana-appindicator3-1`.

Clipboard file-paste uses `wl-clipboard` (Wayland) or `xclip` (X11).

## Windows

Vector runs on Windows 10/11 (x64).

Download the latest `.exe` installer from [Releases](https://github.com/avram19/vector/releases) and run it. Because the build is unsigned, SmartScreen shows a "Windows protected your PC" prompt the first time — click **More info → Run anyway**. Vector installs per-user and updates in-app.

One current limitation: in a plain **shell** pane the directory shown doesn't follow `cd` live (it refreshes when you open the shell panel); agent panes track the directory normally.
