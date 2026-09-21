"""Restart RTSP engine if HD streams go silent. Camera list from /api/state."""
from __future__ import annotations

import json
import os
import socket
import subprocess
import time
import urllib.request
from pathlib import Path

from paths import engine_exe, ffmpeg_exe, user_data
from procutil import creationflags, kill_engine, pid_alive

LOCK = user_data() / "rtsp_watchdog.lock"
LOG = user_data() / "rtsp_watchdog.log"
EXE = engine_exe()
INTERVAL = 75


def log(msg: str) -> None:
    with LOG.open("a", encoding="utf-8") as f:
        f.write(time.strftime("%H:%M:%S ") + msg + "\n")


def already_running() -> bool:
    if not LOCK.exists():
        return False
    try:
        pid = int(LOCK.read_text(encoding="utf-8").strip())
    except ValueError:
        return False
    if pid == os.getpid():
        return False
    return pid_alive(pid)


def port_up() -> bool:
    s = socket.socket()
    s.settimeout(0.5)
    try:
        return s.connect_ex(("127.0.0.1", 8554)) == 0
    except OSError:
        return False
    finally:
        s.close()


def cameras() -> list[str]:
    try:
        st = json.loads(urllib.request.urlopen("http://127.0.0.1:8787/api/state", timeout=5).read())
    except Exception:
        return []
    out = []
    for cam in st.get("cameras") or []:
        url = cam.get("rtspHd") or ""
        if "/hd" in url:
            name = url.rsplit("/", 2)[-2]
            if name:
                out.append(name)
    return out


def ffmpeg() -> Path | None:
    return ffmpeg_exe()


def cam_bytes(ff: Path, cam: str) -> int:
    """Probe SD first (H.264, reliable byte count), fall back to HD."""
    dest = user_data() / "tmp" / f"wd_{cam}.ts"
    dest.parent.mkdir(parents=True, exist_ok=True)
    flags = creationflags()
    for stream in ("sd", "hd"):
        if dest.exists():
            dest.unlink()
        try:
            subprocess.run(
                [
                    str(ff), "-hide_banner", "-loglevel", "error",
                    "-rtsp_transport", "tcp", "-timeout", "8000000", "-t", "3",
                    "-i", f"rtsp://127.0.0.1:8554/{cam}/{stream}",
                    "-an", "-c", "copy", "-y", str(dest),
                ],
                capture_output=True,
                timeout=16,
                creationflags=flags,
            )
        except Exception:
            continue
        n = dest.stat().st_size if dest.exists() else 0
        if dest.exists():
            dest.unlink()
        if n > 5000:
            return n
    return 0


def restart_engine() -> None:
    flags = creationflags()
    kill_engine()
    time.sleep(2)
    try:
        req = urllib.request.Request(
            "http://127.0.0.1:8787/api/rtsp/start",
            data=b"{}",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=20).read()
        return
    except Exception as exc:
        log(f"api start fail {exc}")
    if EXE.exists():
        subprocess.Popen(
            [str(EXE), "rtsp", "start", "--port", "8554"],
            cwd=str(user_data()),
            creationflags=flags,
        )


def tick() -> None:
    if not port_up():
        log("8554 down → restart")
        restart_engine()
        return
    ff = ffmpeg()
    cams = cameras()
    if not ff or len(cams) < 1:
        return
    ok = 0
    for cam in cams:
        n = cam_bytes(ff, cam)
        if n > 5000:
            ok += 1
    need = 1  # never require majority — offline/low-power cams must not thrash restarts
    log(f"probe cams={len(cams)} ok={ok}")
    if ok < need:
        log("media dead → restart")
        restart_engine()
    elif ok < len(cams):
        log(f"partial ok={ok}/{len(cams)} (no restart)")


def main() -> None:
    if already_running():
        return
    LOCK.write_text(str(os.getpid()), encoding="utf-8")
    log("watchdog start")
    try:
        while True:
            try:
                tick()
            except Exception as exc:
                log(f"tick {type(exc).__name__} {exc}")
            time.sleep(INTERVAL)
    finally:
        try:
            if LOCK.exists() and LOCK.read_text(encoding="utf-8").strip() == str(os.getpid()):
                LOCK.unlink()
        except OSError:
            pass


if __name__ == "__main__":
    main()
