"""OS helpers. Windows and Linux; no secrets."""
from __future__ import annotations

import os
import signal
import subprocess
import sys
from pathlib import Path


def creationflags() -> int:
    if os.name == "nt":
        return subprocess.CREATE_NO_WINDOW
    return 0


def python_exe() -> Path:
    exe = Path(sys.executable)
    if os.name == "nt":
        pw = exe.with_name("pythonw.exe")
        if pw.exists():
            return pw
    return exe


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        out = subprocess.run(
            ["tasklist.exe", "/FI", f"PID eq {pid}", "/NH"],
            capture_output=True,
            text=True,
            creationflags=creationflags(),
        )
        return str(pid) in (out.stdout or "")
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def pids_matching(needle: str) -> list[int]:
    me = os.getpid()
    if os.name == "nt":
        try:
            raw = subprocess.check_output(
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-Command",
                    "Get-CimInstance Win32_Process | "
                    f"Where-Object {{ $_.CommandLine -like '*{needle}*' }} | "
                    "Select-Object -ExpandProperty ProcessId",
                ],
                text=True,
                timeout=12,
                creationflags=creationflags(),
            )
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
            return []
        return [int(p) for p in raw.split() if p.isdigit() and int(p) > 4 and int(p) != me]
    try:
        raw = subprocess.check_output(["pgrep", "-f", needle], text=True, timeout=8)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return []
    return [int(p) for p in raw.split() if p.isdigit() and int(p) != me]


def kill_pids(pids: list[int]) -> None:
    for pid in pids:
        if os.name == "nt":
            subprocess.run(
                ["taskkill.exe", "/F", "/PID", str(pid)],
                capture_output=True,
                creationflags=creationflags(),
            )
            continue
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass


def kill_engine() -> None:
    if os.name == "nt":
        subprocess.run(
            ["taskkill.exe", "/F", "/IM", "tuya-ipc-terminal.exe"],
            capture_output=True,
            creationflags=creationflags(),
        )
        return
    subprocess.run(["pkill", "-f", "tuya-ipc-terminal"], capture_output=True)
    kill_pids(pids_matching("tuya-ipc-terminal"))
