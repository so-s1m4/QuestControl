"""Live preview: continuous ffmpeg MJPEG pipe (Linux) or libVLC (Windows)."""
from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from paths import ffmpeg_exe, user_data, vlc_dir

_instance = None
_instance_failed = ""


def configure_vlc_env() -> None:
    d = vlc_dir()
    if not d:
        return
    os.environ["PATH"] = str(d) + os.pathsep + os.environ.get("PATH", "")
    plug = d / "plugins"
    if plug.is_dir():
        os.environ.setdefault("VLC_PLUGIN_PATH", str(plug))


def vlc_mod():
    configure_vlc_env()
    import vlc  # type: ignore

    return vlc


def vlc_instance():
    global _instance, _instance_failed
    if _instance is not None:
        return _instance
    if _instance_failed:
        return None
    vlc = vlc_mod()
    attempts = [
        ("--intf", "dummy", "--quiet", "--rtsp-tcp", "--no-audio", "--vout=x11"),
        ("--intf", "dummy", "--quiet", "--rtsp-tcp", "--no-audio"),
        (),
    ]
    last = ""
    for args in attempts:
        try:
            inst = vlc.Instance(*args) if args else vlc.Instance()
        except Exception as exc:
            last = str(exc)
            continue
        if inst is not None:
            _instance = inst
            return _instance
        last = "Instance() returned None"
    _instance_failed = last or "libVLC unavailable"
    return None


def _attach(player, wid: int) -> None:
    if os.name == "nt":
        player.set_hwnd(wid)
        return
    if sys.platform == "darwin":
        player.set_nsobject(wid)
        return
    player.set_xwindow(wid)


def _nowin() -> int:
    return subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


class VlcPreview:
    """libVLC window embed — works best on Windows; fragile on Wayland."""

    def __init__(self) -> None:
        self.player = None
        self.url = ""
        self.hwnd = 0
        self.last_error = ""

    @property
    def running(self) -> bool:
        return self.player is not None

    def start(self, url: str, hwnd: int, cache_ms: int = 150) -> None:
        hwnd = int(hwnd or 0)
        if not url or not hwnd:
            return
        if self.player is not None and self.url == url and self.hwnd == hwnd:
            return
        self.stop()
        try:
            inst = vlc_instance()
            if inst is None:
                self.last_error = _instance_failed or "libVLC missing"
                return
            ply = inst.media_player_new()
            if ply is None:
                self.last_error = "media_player_new failed"
                return
            _attach(ply, hwnd)
            media = inst.media_new(url)
            if media is None:
                self.last_error = "media_new failed"
                return
            media.add_option(f":network-caching={cache_ms}")
            media.add_option(f":live-caching={cache_ms}")
            media.add_option(":rtsp-tcp")
            media.add_option(":no-audio")
            ply.set_media(media)
            ply.play()
            self.player = ply
            self.url = url
            self.hwnd = hwnd
            self.last_error = ""
        except Exception as exc:
            self.last_error = f"{type(exc).__name__}: {exc}"
            self.stop()

    def stop(self) -> None:
        ply = self.player
        self.player = None
        self.url = ""
        self.hwnd = 0
        if not ply:
            return
        try:
            ply.stop()
        except Exception:
            pass


class LivePipePreview:
    """Persistent ffmpeg MJPEG pipe → Tk canvas. Usable FPS without VLC embed."""

    def __init__(
        self,
        canvas,
        txt_id: int,
        cam_key: str,
        *,
        width: int = 480,
        height: int = 270,
        fps: int = 10,
        fit: str = "fixed",  # fixed | fill
    ) -> None:
        self.canvas = canvas
        self.txt_id = txt_id
        self.cam_key = cam_key
        self.width = width
        self.height = height
        self.fps = max(2, min(int(fps), 25))
        self.fit = fit
        self.url = ""
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._proc: subprocess.Popen | None = None
        self._photo = None
        self._img_id = None
        self.last_error = ""
        self.hwnd = 0

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self, url: str, hwnd: int = 0, cache_ms: int = 150) -> None:  # noqa: ARG002
        if not url:
            return
        if self.running and self.url == url:
            return
        self.stop()
        self.url = url
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, daemon=True, name=f"live-{self.cam_key[:12]}"
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self.url = ""
        self._kill_proc()
        t = self._thread
        self._thread = None
        if t and t.is_alive():
            t.join(timeout=0.4)

    def _kill_proc(self) -> None:
        p = self._proc
        self._proc = None
        if not p:
            return
        try:
            p.terminate()
        except Exception:
            pass
        try:
            p.wait(timeout=1.0)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass

    def _spawn(self, url: str) -> subprocess.Popen | None:
        ff = ffmpeg_exe()
        if not ff:
            self.last_error = "ffmpeg missing"
            return None
        # Scale + FPS limit in ffmpeg so Tk only paints ready frames.
        w, h = self._target_size()
        vf = f"fps={self.fps},scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2"
        cmd = [
            str(ff),
            "-hide_banner",
            "-loglevel",
            "error",
            "-rtsp_transport",
            "tcp",
            "-fflags",
            "nobuffer",
            "-flags",
            "low_delay",
            "-probesize",
            "32",
            "-analyzeduration",
            "0",
            "-i",
            url,
            "-an",
            "-vf",
            vf,
            "-f",
            "mjpeg",
            "-q:v",
            "5",
            "pipe:1",
        ]
        try:
            return subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                creationflags=_nowin(),
            )
        except Exception as exc:
            self.last_error = str(exc)
            return None

    def _target_size(self) -> tuple[int, int]:
        if self.fit == "fill":
            try:
                self.canvas.update_idletasks()
                w = max(320, int(self.canvas.winfo_width() or self.width))
                h = max(180, int(self.canvas.winfo_height() or self.height))
                return w, h
            except Exception:
                pass
        return self.width, self.height

    def _loop(self) -> None:
        fails = 0
        while not self._stop.is_set():
            url = self.url
            if not url:
                break
            proc = self._spawn(url)
            if not proc or not proc.stdout:
                fails += 1
                if fails >= 2:
                    self._set_text("no stream")
                self._stop.wait(2.0)
                continue
            self._proc = proc
            buf = bytearray()
            try:
                while not self._stop.is_set() and self.url == url:
                    chunk = proc.stdout.read(4096)
                    if not chunk:
                        break
                    buf.extend(chunk)
                    # drain complete JPEGs (FFD8 … FFD9)
                    while True:
                        soi = buf.find(b"\xff\xd8")
                        if soi < 0:
                            buf.clear()
                            break
                        if soi > 0:
                            del buf[:soi]
                        eoi = buf.find(b"\xff\xd9", 2)
                        if eoi < 0:
                            # keep growing but cap runaway
                            if len(buf) > 2_000_000:
                                buf.clear()
                            break
                        frame = bytes(buf[: eoi + 2])
                        del buf[: eoi + 2]
                        fails = 0
                        self.last_error = ""
                        try:
                            self.canvas.after(0, lambda f=frame: self._paint(f))
                        except Exception:
                            self._stop.set()
                            break
            finally:
                self._kill_proc()
            fails += 1
            if fails >= 3:
                self._set_text("no frame / offline")
            self._stop.wait(1.0 if fails else 0.05)

    def _set_text(self, msg: str) -> None:
        self.last_error = msg
        try:
            self.canvas.after(0, lambda: self.canvas.itemconfig(self.txt_id, text=msg))
        except Exception:
            pass

    def _paint(self, jpeg: bytes) -> None:
        if self._stop.is_set():
            return
        try:
            from io import BytesIO

            from PIL import Image, ImageTk

            im = Image.open(BytesIO(jpeg)).convert("RGB")
            # If canvas grew (fullscreen), re-letterbox via PIL once more cheaply.
            if self.fit == "fill":
                tw, th = self._target_size()
                if im.size != (tw, th):
                    im = im.resize((tw, th), Image.Resampling.BILINEAR)
            photo = ImageTk.PhotoImage(im)
            self._photo = photo
            cw = max(1, int(self.canvas.winfo_width() or im.size[0]))
            ch = max(1, int(self.canvas.winfo_height() or im.size[1]))
            x = max(0, (cw - im.size[0]) // 2)
            y = max(0, (ch - im.size[1]) // 2)
            if self._img_id is None:
                self._img_id = self.canvas.create_image(x, y, anchor="nw", image=photo)
            else:
                self.canvas.coords(self._img_id, x, y)
                self.canvas.itemconfig(self._img_id, image=photo)
            self.canvas.itemconfig(self.txt_id, text="")
            try:
                self.canvas.tag_raise(self.txt_id)
            except Exception:
                pass
        except Exception as exc:
            self.last_error = str(exc)


# Back-compat alias used by older gui imports
SnapPreview = LivePipePreview
