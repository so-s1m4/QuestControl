"""Lokales Tuya→RTSP Brücken-Tool. UI auf http://127.0.0.1:8787"""
from __future__ import annotations

import io
import json
import os
import socket
import subprocess
import sys
import threading
import time
import traceback
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import qrcode
from PIL import Image

from rtsp_manager import RtspManager
from hd_proxy import MultiHdProxy
from tuya_client import REGIONS, TuyaClient, safe_poll_text, slug
from local_ptz import LocalPtz
import services

from paths import tuya_data, user_data, web_dir
from i18n import t, load_lang

ROOT = user_data()
WEB = web_dir()
DATA = tuya_data()
HOST = "0.0.0.0"
PORT = 8787

load_lang()
client = TuyaClient(DATA)
rtsp = RtspManager(ROOT)
hd_proxy = MultiHdProxy()
sd_proxy = MultiHdProxy(copy=True)
local_ptz = LocalPtz(DATA, client)
state_lock = threading.Lock()
ui_state = {
    "phase": "idle",
    "message": t("msg_qr"),
}

client.load_latest_session()
if client.login:
    ui_state["phase"] = "logged_in"
    ui_state["message"] = t("msg_session")


def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def public_state() -> dict:
    ip = lan_ip()
    login = client.login or {}
    cameras = []
    for cam in client.cameras:
        path = cam.get("rtspPath") or f"/{cam.get('deviceId')}"
        # rtspPath is unique even when Smart Life display names are not.
        fid = slug(str(path).lstrip("/"))
        cameras.append(
            {
                **cam,
                "rtspHd": f"rtsp://{ip}:{rtsp.port}{path}/hd",
                "rtspSd": f"rtsp://{ip}:{rtsp.port}{path}/sd",
                "hlsHd": f"http://{ip}:{PORT}/live/{fid}/index.m3u8",
                "hlsSd": f"http://{ip}:{PORT}/live/{fid}/sd/index.m3u8",
                "frigateId": fid,
            }
        )
    with state_lock:
        phase = ui_state["phase"]
        message = ui_state["message"]
    return {
        "phase": phase,
        "message": message,
        "region": client.region_id,
        "regions": {k: {"host": v["host"], "label": v["label"]} for k, v in REGIONS.items()},
        "host": client.host,
        "loginUrl": f"https://{client.host}/login",
        "loggedIn": bool(client.login),
        "user": {
            "nickname": login.get("nickname") or "",
            "email": login.get("email") or login.get("username") or "",
            "uid": login.get("uid") or "",
        }
        if client.login
        else None,
        "hasQr": bool(client.token) and phase == "waiting",
        "qrId": (client.token or "")[-12:],
        "pollCount": client.poll_count,
        "lastPoll": safe_poll_text(client.last_poll),
        "cameras": cameras,
        "discovery": getattr(client, "discovery", None) or {},
        "rtsp": rtsp.status(),
        "hdProxy": hd_proxy.status(),
        "sdProxy": sd_proxy.status(),
        "lanIp": ip,
        "uiPort": PORT,
        "lang": __import__("i18n").current_lang(),
        "error": client.last_error,
        **services.status(),
        "hlsRunning": any((v or {}).get("running") for v in hd_proxy.status().values()),
    }


def apply_service_flags(body: dict) -> dict:
    flags = services.save_flags(body)
    if flags["rtsp"]:
        if not rtsp.running():
            rtsp.start()
    else:
        hd_proxy.stop()
        sd_proxy.stop()
        rtsp.stop()
    if flags["hls"] and rtsp.running():
        start_hls_proxies()
    else:
        hd_proxy.stop()
        sd_proxy.stop()
    services.set_watchdog(flags["watchdog"])
    services.set_archive(flags["archive"])
    return flags


def restart_rtsp_engine() -> None:
    hd_proxy.stop()
    sd_proxy.stop()
    rtsp.stop()
    time.sleep(0.4)
    rtsp.start()


def restart_ui_later() -> None:
    from procutil import creationflags, python_exe

    server = Path(__file__).resolve()
    exe = python_exe()
    flags = creationflags()
    if os.name == "nt":
        cmd = f'ping -n 3 127.0.0.1 >nul & "{exe}" -u "{server}"'
    else:
        cmd = f'sleep 2 && "{exe}" -u "{server}"'
    env = os.environ.copy()
    env["PYTHONPATH"] = str(server.parent) + os.pathsep + env.get("PYTHONPATH", "")
    subprocess.Popen(
        cmd,
        shell=True,
        cwd=str(user_data()),
        env=env,
        creationflags=flags,
    )
    threading.Thread(target=lambda: (time.sleep(0.5), os._exit(0)), daemon=True).start()


def start_hls_proxies() -> None:
    """Nur manuell oder Flag HLS. Autostart aus — Agent nutzt RTSP."""
    if not rtsp.running() or not client.cameras:
        return
    for cam in client.cameras:
        path = cam.get("rtspPath") or f"/{cam.get('deviceId')}"
        cam_id = slug(str(path).lstrip("/"))
        url = f"rtsp://127.0.0.1:{rtsp.port}{path}/hd"
        try:
            hd_proxy.get(cam_id).start(url)
        except Exception as exc:
            set_phase("logged_in", f"HD-Proxy für {cam_id}: {exc}")


def set_phase(phase: str, message: str) -> None:
    with state_lock:
        ui_state["phase"] = phase
        ui_state["message"] = message


def qr_png_bytes() -> bytes:
    """Square QR PNG at fixed pixel size — GUI must not stretch further."""
    payload = client.qr_payload()
    # box_size picked so final image ≈ 320px after border
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=2,
    )
    qr.add_data(payload)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    # Normalize to fixed size with NEAREST (module edges stay sharp).
    target = 320
    if img.size != (target, target):
        img = img.resize((target, target), Image.Resampling.NEAREST)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def start_qr_flow(region_id: str) -> None:
    if region_id != client.region_id:
        client.set_region(region_id)
    client.generate_qr()
    gen = client.generation
    set_phase("waiting", "QR mit Smart Life / Tuya Smart scannen und bestätigen.")
    threading.Thread(target=_poll_worker, args=(gen,), daemon=True).start()


def _poll_worker(generation: int) -> None:
    try:
        while client.generation == generation:
            got = client.wait_login(timeout_s=80, interval_s=1.0, generation=generation)
            if client.generation != generation:
                return
            if got:
                client.save_session()
                set_phase("logged_in", "Login ok. Suche Kameras …")
                try:
                    cams = client.discover_cameras()
                except Exception as exc:
                    cams = []
                    client.last_error = str(exc)
                note = (getattr(client, "discovery", None) or {}).get("note")
                set_phase("logged_in", note or f"{len(cams)} Kamera(s) gefunden.")
                try:
                    rtsp.start()
                    apply_service_flags(services.load_flags())
                    set_phase("logged_in", f"{len(cams)} Kamera(s) · RTSP :{rtsp.port}")
                    local_ptz.warmup([c.get("deviceId") for c in cams if c.get("deviceId")])
                except Exception as exc:
                    set_phase("logged_in", f"{len(cams)} Kamera(s). RTSP: {exc}")
                return
            client.generate_qr()
            generation = client.generation
            set_phase("waiting", "QR erneuert — bitte erneut scannen.")
    except Exception as exc:
        client.last_error = str(exc)
        set_phase("error", str(exc))
        traceback.print_exc()


def frigate_yaml(state: dict) -> str:
    lines = ["mqtt:", "  enabled: false", "", "cameras:"]
    if not state["cameras"]:
        lines.append("  # no cameras yet")
        return "\n".join(lines) + "\n"
    for cam in state["cameras"]:
        cid = cam["frigateId"]
        lines += [
            f"  {cid}:",
            "    ffmpeg:",
            "      inputs:",
            f"        - path: {cam['rtspHd']}",
            "          roles: [detect, record]",
            f"        # SD: {cam['rtspSd']}",
            "",
        ]
    return "\n".join(lines)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def log_message(self, fmt: str, *args) -> None:
        msg = fmt % args
        if "/api/state" in msg:
            return
        try:
            sys.stderr.write("[ui] " + msg + "\n")
        except Exception:
            pass

    def _json(self, code: int, payload) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _text(self, code: int, text: str, ctype: str) -> None:
        raw = text.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _read_json(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return {}
        return json.loads(self.rfile.read(n).decode("utf-8") or "{}")

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            html = (WEB / "index.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(html)))
            self.end_headers()
            self.wfile.write(html)
            return
        if path == "/api/state":
            self._json(200, public_state())
            return
        if path == "/api/qr.png":
            if not client.token:
                self.send_error(404, "Kein QR")
                return
            png = qr_png_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(png)))
            self.end_headers()
            self.wfile.write(png)
            return
        if path == "/api/frigate.yaml":
            self._text(200, frigate_yaml(public_state()), "text/yaml; charset=utf-8")
            return
        return super().do_GET()

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            body = self._read_json()
            if path == "/api/ptz/move":
                device_id = body.get("deviceId")
                direction = body.get("direction")
                if not device_id or not direction:
                    self._json(400, {"error": "deviceId and direction required"})
                    return
                try:
                    res = local_ptz.move(str(device_id), str(direction))
                    self._json(200, {"status": "ok", "response": res})
                except Exception as exc:
                    self._json(500, {"error": f"PTZ: {exc}"})
                return

            if path == "/api/cloud/auth":
                # Smart Life reverse-app login (public app secrets, user password once)
                email = (body.get("email") or "").strip()
                password = body.get("password") or ""
                country = str(body.get("countryCode") or "49")
                if not password:
                    self._json(400, {"error": "password required"})
                    return
                if not email:
                    # fall back to session email
                    try:
                        lr = getattr(client, "login", None) or {}
                        email = (lr.get("email") if isinstance(lr, dict) else "") or ""
                    except Exception:
                        email = ""
                if not email:
                    self._json(400, {"error": "email required"})
                    return
                try:
                    local_ptz.cloud.set_credentials(email, password, country)
                    local_ptz.cloud.login(force=True)
                    self._json(
                        200,
                        {
                            "status": "ok",
                            "cloud": True,
                            "email": email,
                            "hasSid": bool(local_ptz.cloud._sid),
                        },
                    )
                except Exception as exc:
                    self._json(500, {"error": f"Cloud-Auth: {exc}"})
                return

            if path == "/api/qr/start":
                region = body.get("region") or "we"
                start_qr_flow(region)
                self._json(200, public_state())
                return
            if path == "/api/logout":
                hd_proxy.stop()
                sd_proxy.stop()
                rtsp.stop()
                client.logout()
                set_phase("idle", "Abgemeldet.")
                self._json(200, public_state())
                return
            if path == "/api/cameras/refresh":
                if client.login:
                    try:
                        client.save_session()
                    except Exception:
                        pass
                cams = client.discover_cameras()
                set_phase("logged_in", f"{len(cams)} Kamera(s) gefunden.")
                try:
                    restart_rtsp_engine()
                    apply_service_flags(services.load_flags())
                    set_phase("logged_in", f"{len(cams)} Kamera(s) · RTSP :{rtsp.port}")
                except Exception as exc:
                    set_phase("logged_in", f"{len(cams)} Kamera(s). RTSP: {exc}")
                self._json(200, public_state())
                return
            if path == "/api/rtsp/start":
                rtsp.start(int(body.get("port") or 8554))
                self._json(200, public_state())
                return
            if path == "/api/rtsp/stop":
                hd_proxy.stop()
                sd_proxy.stop()
                rtsp.stop()
                self._json(200, public_state())
                return
            if path == "/api/hd-proxy/start":
                start_hls_proxies()
                self._json(200, public_state())
                return
            if path == "/api/hd-proxy/stop":
                hd_proxy.stop()
                sd_proxy.stop()
                self._json(200, public_state())
                return
            if path == "/api/flags":
                apply_service_flags(body)
                self._json(200, public_state())
                return
            if path == "/api/lang":
                from i18n import save_lang
                save_lang(str(body.get("lang") or "en"))
                self._json(200, public_state())
                return
            if path == "/api/restart/rtsp":
                restart_rtsp_engine()
                self._json(200, public_state())
                return
            if path == "/api/restart/ui":
                self._json(200, {"ok": True, "restart": "ui"})
                restart_ui_later()
                return
            if path == "/api/restart/all":
                hd_proxy.stop()
                sd_proxy.stop()
                services.set_archive(False)
                restart_rtsp_engine()
                self._json(200, public_state())
                restart_ui_later()
                return
            self._json(404, {"error": "unknown"})
        except Exception as exc:
            traceback.print_exc()
            self._json(500, {"error": str(exc)})


def _attach_file_log() -> None:
    log = ROOT / "server_utf8.log"
    try:
        fh = open(log, "a", encoding="utf-8", buffering=1)
    except OSError:
        return
    tty = False
    try:
        tty = bool(sys.stdout) and sys.stdout.isatty()
    except Exception:
        tty = False
    if not tty:
        sys.stdout = fh
        sys.stderr = fh


def main() -> None:
    _attach_file_log()
    WEB.mkdir(parents=True, exist_ok=True)
    if client.login:
        try:
            # Always discover cameras when session is loaded
            cams = client.discover_cameras()
            set_phase("logged_in", f"{len(cams)} Kamera(s) gefunden.")
            client.cameras = cams
            if cams:
                try:
                    rtsp.start()
                    apply_service_flags(services.load_flags())
                    set_phase("logged_in", f"{len(cams)} Kamera(s) · RTSP :{rtsp.port}")
                    local_ptz.warmup([c.get("deviceId") for c in cams if c.get("deviceId")])
                except Exception as exc:
                    set_phase("logged_in", f"{len(cams)} Kamera(s). RTSP: {exc}")
        except Exception as exc:
            set_phase("logged_in", f"Sitzung geladen. Kamerasuche: {exc}")

    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Tuya-Brücke: http://127.0.0.1:{PORT}  (PTZ=LAN-DP 119)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        hd_proxy.stop()
        sd_proxy.stop()
        rtsp.stop()
        httpd.server_close()


if __name__ == "__main__":
    main()
