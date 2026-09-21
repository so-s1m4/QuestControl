"""HEVC-HD → H.264 HLS für VLC/Browser. Eine ffmpeg-Instanz pro Kamera."""

from __future__ import annotations

import os
import subprocess
import threading
from pathlib import Path
from typing import Dict, Optional
import re

from paths import ffmpeg_exe, install_root, user_data

ROOT = user_data()
LIVE = install_root() / "web" / "live"
LOG_BASE = ROOT / "hd_proxy.log"


def find_ffmpeg() -> Optional[Path]:
    return ffmpeg_exe()


def _open_log():
    LOG_BASE.parent.mkdir(parents=True, exist_ok=True)
    return open(LOG_BASE, "a", encoding="utf-8", buffering=1)


class HdProxy:
    def __init__(self, cam_id: str, *, copy: bool = False) -> None:
        cam_id = re.sub(r"[^a-zA-Z0-9_-]+", "_", (cam_id or "").replace("\t", " ")).strip("_") or "cam"
        self.cam_id = cam_id
        self.copy = copy
        self.proc: Optional[subprocess.Popen] = None
        self.source: Optional[str] = None
        self._lock = threading.Lock()
        self._live_dir = (LIVE / cam_id / "sd") if copy else (LIVE / cam_id)

    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def playlist_ready(self) -> bool:
        m3u = self._live_dir / "index.m3u8"
        return m3u.exists() and m3u.stat().st_size > 20

    def status(self) -> dict:
        return {
            "running": self.running(),
            "ready": self.playlist_ready(),
            "source": self.source,
            "path": f"/live/{self.cam_id}/sd/index.m3u8" if self.copy else f"/live/{self.cam_id}/index.m3u8",
            "cam_id": self.cam_id,
        }

    def start(self, rtsp_url: str) -> None:
        with self._lock:
            if self.running() and self.source == rtsp_url:
                return
            self.stop_unlocked()
            ff = find_ffmpeg()
            if not ff:
                raise RuntimeError("ffmpeg not found")
            self._live_dir.mkdir(parents=True, exist_ok=True)
            for p in self._live_dir.glob("*"):
                try:
                    p.unlink()
                except OSError:
                    pass
            self.source = rtsp_url
            vcodec = ["-c:v", "copy"] if self.copy else [
                "-c:v", "libx264",
                "-preset", "ultrafast",
                "-tune", "zerolatency",
                "-pix_fmt", "yuv420p",
                "-g", "10",
                "-keyint_min", "10",
                "-bf", "0",
                "-sc_threshold", "0",
            ]
            cmd = [
                str(ff),
                "-hide_banner",
                "-loglevel",
                "warning",
                "-fflags",
                "nobuffer+genpts+discardcorrupt",
                "-flags",
                "low_delay",
                "-probesize",
                "32768",
                "-analyzeduration",
                "0",
                "-rtsp_transport",
                "tcp",
                "-i",
                rtsp_url,
                "-map",
                "0:v:0",
                *vcodec,
                "-an",
                "-f",
                "hls",
                "-hls_time",
                "1",
                "-hls_list_size",
                "3",
                "-hls_flags",
                "delete_segments+omit_endlist+independent_segments",
                "-hls_segment_filename",
                str(self._live_dir / "seg%03d.ts"),
                str(self._live_dir / "index.m3u8"),
            ]
            flags = 0
            if os.name == "nt":
                flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
            logf = _open_log()
            logf.write(f"[HD-Proxy {self.cam_id}] start {rtsp_url}\n")
            logf.flush()
            self.proc = subprocess.Popen(
                cmd,
                stdout=logf,
                stderr=subprocess.STDOUT,
                creationflags=flags,
            )

    def stop(self) -> None:
        with self._lock:
            self.stop_unlocked()

    def stop_unlocked(self) -> None:
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
            except Exception:
                pass
        self.proc = None
        self.source = None


class MultiHdProxy:
    def __init__(self, *, copy: bool = False) -> None:
        self.proxies: Dict[str, HdProxy] = {}
        self._lock = threading.Lock()
        self.copy = copy

    def get(self, cam_id: str) -> HdProxy:
        cam_id = re.sub(r"[^a-zA-Z0-9_-]+", "_", (cam_id or "").replace("\t", " ")).strip("_") or "cam"
        with self._lock:
            if cam_id not in self.proxies:
                self.proxies[cam_id] = HdProxy(cam_id, copy=self.copy)
            return self.proxies[cam_id]

    def status(self) -> dict:
        with self._lock:
            return {cam_id: proxy.status() for cam_id, proxy in self.proxies.items()}

    def stop(self, cam_id: Optional[str] = None) -> None:
        with self._lock:
            if cam_id:
                if cam_id in self.proxies:
                    self.proxies[cam_id].stop()
                    del self.proxies[cam_id]
            else:
                for proxy in list(self.proxies.values()):
                    proxy.stop()
                self.proxies.clear()
