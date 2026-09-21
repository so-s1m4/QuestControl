# Credits

## seydx — tuya-ipc-terminal

The RTSP engine in `vendor/tuya-ipc-terminal` is **[tuya-ipc-terminal](https://github.com/seydx/tuya-ipc-terminal)** by **[seydx](https://github.com/seydx)** (MIT).

We vendor commit `d65b3e9` (“0.0.6”) and apply a small set of local patches
documented in [`vendor/tuya-ipc-terminal/UPSTREAM.md`](vendor/tuya-ipc-terminal/UPSTREAM.md).

Without that project there is no WebRTC→RTSP bridge here. Please star and
support upstream: https://github.com/seydx/tuya-ipc-terminal

## Other libraries we call (not copied)

- [tinytuya](https://github.com/jasonacox/tinytuya) — local Tuya protocol / PTZ (MIT)
- [pion](https://github.com/pion) — WebRTC stack inside the engine (MIT)
- [Eclipse Paho](https://github.com/eclipse/paho.mqtt.golang) — MQTT (EDL/EPL)
- [VideoLAN](https://www.videolan.org/) — optional preview via python-vlc (LGPL bindings; bundled Windows player is VideoLAN’s GPL zip)

Full legal text: [NOTICE.md](NOTICE.md) · licenses in [DEPENDENCIES.md](DEPENDENCIES.md).

Tuya, Smart Life, and iSmartLife are trademarks of their owners. This project
is not affiliated with Tuya Inc. or with seydx beyond using their MIT-licensed
engine with credit.
