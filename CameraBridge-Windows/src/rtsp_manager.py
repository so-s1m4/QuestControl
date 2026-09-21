"""Baut und steuert tuya-ipc-terminal als RTSP-Brücke."""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import threading
import time
from pathlib import Path
from typing import Optional

from paths import bin_dir, engine_exe, engine_src, install_root
from procutil import creationflags, kill_engine

ROOT = install_root()
TOOLS = ROOT / "tools"
BIN = bin_dir()
GO_ROOT = TOOLS / "go"
GO_EXE = GO_ROOT / "bin" / ("go.exe" if os.name == "nt" else "go")
SRC = engine_src()
EXE = engine_exe()


class RtspManager:
    def __init__(self, cwd: Path):
        self.cwd = cwd
        self.proc: Optional[subprocess.Popen] = None
        self.port = 8554
        self.log: list[str] = []
        self._lock = threading.Lock()

    def _log(self, line: str) -> None:
        with self._lock:
            self.log.append(line.rstrip())
            if len(self.log) > 400:
                self.log = self.log[-400:]

    def running(self) -> bool:
        if self.proc is not None and self.proc.poll() is None:
            return True
        s = socket.socket()
        s.settimeout(0.4)
        try:
            return s.connect_ex(("127.0.0.1", self.port)) == 0
        except Exception:
            return False
        finally:
            s.close()

    def status(self) -> dict:
        return {
            "running": self.running(),
            "port": self.port,
            "binary": str(EXE) if EXE.exists() else None,
            "go": str(GO_EXE) if GO_EXE.exists() else None,
            "log": self.log[-40:],
        }

    def ensure_binary(self) -> Path:
        if EXE.exists():
            return EXE
        go = shutil.which("go")
        if not go and GO_EXE.exists():
            go = str(GO_EXE)
        if not go:
            raise RuntimeError("tuya-ipc-terminal missing and no Go compiler on PATH.")
        if not SRC.exists():
            raise RuntimeError(f"engine source missing: {SRC}")
        BIN.mkdir(parents=True, exist_ok=True)
        env = os.environ.copy()
        env["CGO_ENABLED"] = "0"
        self._log("Building tuya-ipc-terminal …")
        proc = subprocess.run(
            [go, "build", "-o", str(EXE), "."],
            cwd=str(SRC),
            env=env,
            capture_output=True,
            text=True,
            timeout=300,
        )
        if proc.returncode != 0:
            self._log((proc.stderr or "")[-2000:])
            raise RuntimeError("Build failed. See log.")
        if not EXE.exists():
            raise RuntimeError("Build produced no binary.")
        self._log("Binary ready.")
        return EXE

    def start(self, port: int = 8554) -> None:
        if self.running():
            return
        exe = self.ensure_binary()
        self.port = port
        self._log(f"Starte RTSP auf Port {port} …")
        flags = creationflags()
        self.proc = subprocess.Popen(
            [str(exe), "rtsp", "start", "--port", str(port)],
            cwd=str(self.cwd),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            creationflags=flags,
        )
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self) -> None:
        if not self.proc or not self.proc.stdout:
            return
        for line in self.proc.stdout:
            self._log(line)
        code = self.proc.poll()
        self._log(f"RTSP-Prozess beendet ({code}).")

    def stop(self) -> None:
        self._log("Stoppe RTSP …")
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.proc = None
        kill_engine()
        for _ in range(10):
            if not self.running():
                break
            time.sleep(0.3)
