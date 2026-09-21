# NOTICE — third-party code

This file is the attribution record required by the licenses of software
we vendor or statically link. Our own code is MIT; see LICENSE.

Nothing here implies endorsement by the original authors.

---

## 1. Vendored source — tuya-ipc-terminal

**Project:** [seydx/tuya-ipc-terminal](https://github.com/seydx/tuya-ipc-terminal)
**Author:** seydx (https://github.com/seydx)
**License:** MIT
**Upstream commit we started from:** `d65b3e9babb4829176290b4d53195d62636f00bf`
(“update version to 0.0.6”, 2025-05-31)
**Location in this repo:** `vendor/tuya-ipc-terminal/`
**Original license file:** `vendor/tuya-ipc-terminal/LICENSE`
**Patch list:** `vendor/tuya-ipc-terminal/UPSTREAM.md`

```
MIT License

Copyright (c) 2025 seydx

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The Windows binary `bin/tuya-ipc-terminal.exe` (shipped in the installer, not
in git) is a build of that tree plus the patches in UPSTREAM.md.

### Go libraries linked into that binary

Declared in `vendor/tuya-ipc-terminal/go.mod`. All OSI-approved
(MIT / BSD-style / Apache-2.0):

| Module | Typical license |
|---|---|
| github.com/eclipse/paho.mqtt.golang | EDL / EPL |
| github.com/pion/webrtc and pion/* | MIT |
| github.com/rs/zerolog | MIT |
| github.com/spf13/cobra | Apache-2.0 |
| github.com/mdp/qrterminal | MIT |
| golang.org/x/net, crypto, sys, term, sync | BSD-3 |

---

## 2. Python dependencies

On a source / Linux install they come from `pip install -r requirements.txt`.
The Windows Setup.exe ships a private CPython plus those wheels.

| Package | License |
|---|---|
| requests | Apache-2.0 |
| qrcode | BSD-3-Clause |
| pillow | HPND (historical PIL) |
| tinytuya | MIT (jasonacox/tinytuya) |
| python-vlc | LGPL-2.1+ (bindings) |

---

## 3. Redistributed with the Windows Setup.exe (v1.2+)

These are unmodified official binaries, copied next to the app. They are not
statically linked into our Python. You may replace them.

| Software | License of that binary | Notes |
|---|---|---|
| CPython 3.12 | PSF | `runtime/` — https://www.python.org |
| VideoLAN VLC 3.0.21 (official win64 zip) | GPL-2.0 (player); libVLC is LGPL-2.1+ | `vlc/COPYING.txt`. Source: https://www.videolan.org |
| ffmpeg 9.0.1 essentials (Gyan) | GPL-3.0 (`--enable-gpl --enable-version3`, includes libx264) | `bin/ffmpeg.exe` + `bin/FFMPEG-LICENSE.txt`. Source: https://ffmpeg.org and https://www.gyan.dev/ffmpeg/builds/ |

Older project text called ffmpeg “LGPL”. That was wrong for this Gyan essentials
build. The engine starts ffmpeg as a separate process. The optional preview
loads `libvlc` dynamically.

Linux packages these from the distro instead.

Inno Setup is used only to *build* the Windows installer. It is not shipped
as a library. The Inno license still allows any purpose, including commercial
applications; a paid Inno key is requested for commercial users of the
compiler, not strictly required. This project is given away (MIT, no paid
edition). See https://jrsoftware.org/isorder.php

Plain-language summary: [docs/legal.md](docs/legal.md) · [docs/rechtliches.md](docs/rechtliches.md)

---

## 4. What is original to Tuya RTSP Bridge

Desktop GUI, local HTTP API, QR login client, PTZ wrapper, watchdog,
i18n, installer script, and documentation in this repository — unless a
file says otherwise.
