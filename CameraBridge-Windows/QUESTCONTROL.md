# QuestControl camera bridge

This directory is the reproducible Windows source for the Tuya/LSC camera
bridge used by QuestControl. Build from this directory instead of applying
one-off edits inside a running container.

## Known-good media behavior

- H.264 SPS/PPS are read from the Tuya WebRTC answer and inserted before IDR
  frames for RTSP clients.
- Outgoing video RTP sequence numbers are continuous, including inserted
  packets. This avoids the multi-second WebRTC jitter seen with duplicate RTP
  sequence numbers.
- RTCP PLI periodically requests a fresh keyframe.
- Camera audio is passed through as the empirically verified static RTP
  payload 0: G.711 PCMU at 8000 Hz. Do not byte-swap it and do not advertise it
  as L16.
- QuestControl asks go2rtc for WebRTC playback directly. MSE is not the primary
  transport for this bridge.

## Build and start on Windows

From an elevated PowerShell:

```powershell
Set-Location C:\Users\Escapers\Documents\CameraBridge-Windows
docker compose -f docker-compose.ports.yml up -d --build
```

Persistent login data is bind-mounted from `data/` and `config/`; rebuilding
the image does not remove it. Both directories are ignored by Git.

For private VPN startup at sign-in, install Docker Desktop and OpenConnect,
then run once:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\Start-CameraBridge.ps1 -Install
```

The scheduled task waits for Docker, starts OpenConnect without relying on the
unsupported Windows `--background` flag, and then starts the containers.

## Add cameras or bridge instances

Cameras discovered in the same Tuya account need no code changes. Refresh the
bridge, then run **Local bridge** synchronization in QuestControl.

For another account or another Windows host, run an independent bridge with
its own persistent `data` and `config` directories and unique host ports. Add
its API and RTSP endpoints to QuestControl through
`TUYA_BRIDGE_ACCOUNTS_JSON`; see `docs/CAMERAS.md` in the repository root.

## Verification

Before publishing engine changes:

```powershell
docker build -t tuya-rtsp-bridge:local .
docker run --rm -v "${PWD}\vendor\tuya-ipc-terminal:/src" -w /src golang:1.23-bookworm go test ./pkg/rtsp
```

Do not commit `data/`, `config/`, logs, exported credentials, or camera URLs
containing passwords.
