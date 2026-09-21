"""Start/stop optional services. No secrets."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from paths import tuya_data, user_data
from procutil import creationflags, kill_pids, pids_matching, python_exe

DATA = tuya_data()
FLAGS = DATA / "ui_flags.json"
SRC = Path(__file__).resolve().parent
DEFAULTS = {
    "rtsp": True,
    "watchdog": True,
    "archive": False,
    "hls": False,
}


def load_flags() -> dict[str, bool]:
    out = dict(DEFAULTS)
    if FLAGS.exists():
        try:
            raw = json.loads(FLAGS.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                for k in DEFAULTS:
                    if k in raw:
                        out[k] = bool(raw[k])
        except (OSError, json.JSONDecodeError):
            pass
    return out


def save_flags(flags: dict[str, bool]) -> dict[str, bool]:
    merged = load_flags()
    for k in DEFAULTS:
        if k in flags:
            merged[k] = bool(flags[k])
    DATA.mkdir(parents=True, exist_ok=True)
    FLAGS.write_text(json.dumps(merged, indent=2), encoding="utf-8")
    return merged


def _spawn(script: str) -> None:
    exe = python_exe()
    path = SRC / script
    if not path.exists() or not exe.exists():
        return
    import subprocess

    env = dict(**__import__("os").environ)
    env["PYTHONPATH"] = str(SRC) + __import__("os").pathsep + env.get("PYTHONPATH", "")
    subprocess.Popen(
        [str(exe), "-u", str(path)],
        cwd=str(user_data()),
        env=env,
        creationflags=creationflags(),
    )


def watchdog_running() -> bool:
    return bool(pids_matching("rtsp_watchdog.py"))


def archive_running() -> bool:
    return bool(pids_matching("archive_recorder.py"))


def set_watchdog(on: bool) -> None:
    if on:
        if not watchdog_running():
            _spawn("rtsp_watchdog.py")
        return
    kill_pids(pids_matching("rtsp_watchdog.py"))
    lock = user_data() / "rtsp_watchdog.lock"
    if lock.exists():
        try:
            lock.unlink()
        except OSError:
            pass


def set_archive(on: bool) -> None:
    if on:
        if not archive_running():
            _spawn("archive_recorder.py")
        return
    kill_pids(pids_matching("archive_recorder.py"))


def status() -> dict[str, Any]:
    flags = load_flags()
    return {
        "flags": flags,
        "watchdogRunning": watchdog_running(),
        "archiveRunning": archive_running(),
    }
