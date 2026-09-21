"""Tuya IPC-Terminal Web-API (QR-Login, Kameras, Session)."""
from __future__ import annotations

import json
import random
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import requests

REGIONS = {
    "eu": {
        "key": "eu-central",
        "host": "protect-eu.ismartlife.me",
        "label": "Western Europe (EU)",
    },
    "we": {
        "key": "eu-east",
        "host": "protect-we.ismartlife.me",
        "label": "Eastern Europe (WE)",
    },
    "us": {
        "key": "us-west",
        "host": "protect-us.ismartlife.me",
        "label": "USA West",
    },
    "ue": {
        "key": "us-east",
        "host": "protect-ue.ismartlife.me",
        "label": "USA East",
    },
    "cn": {
        "key": "china",
        "host": "protect.ismartlife.me",
        "label": "China",
    },
    "in": {
        "key": "india",
        "host": "protect-in.ismartlife.me",
        "label": "India",
    },
}

CAMERA_CATEGORIES = {
    "sp",
    "dghsxj",
    "videolock",
    "wfcon",
    "sp_wnq",
    "sp_dpc",
    "hpsj",
    "sj",
    "cat1",
    "ipc",
    "camera",
}
QR_PAYLOAD_PREFIX = "tuyaSmart--qrLogin?token="


def _utc_iso(ts: Optional[float] = None) -> str:
    if ts is None:
        return datetime.now(timezone.utc).isoformat()
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def _user_key(region_key: str, email: str) -> str:
    safe = email.replace("@", "_at_").replace(".", "_")
    return f"{region_key}_{safe}"


def _rtsp_path(name: str, device_id: str) -> str:
    # Collapse tabs/newlines from Smart Life names; keep unicode for path match with engine.
    clean = " ".join((name or "").replace("\t", " ").split())
    safe = re.sub(r"[\s/\\]+", "_", clean).strip("_")
    if not safe:
        safe = device_id
    return f"/{safe}"


def _clean_name(name: str, device_id: str) -> str:
    s = " ".join((name or device_id or "").replace("\t", " ").split())
    return s or device_id or "camera"


def as_dict_list(result: Any) -> list[dict]:
    """homeList/roomList sometimes wrap the array in an object."""
    if isinstance(result, list):
        return [x for x in result if isinstance(x, dict)]
    if isinstance(result, dict):
        for key in ("homeList", "homes", "roomList", "rooms", "list", "result"):
            inner = result.get(key)
            if isinstance(inner, list):
                return [x for x in inner if isinstance(x, dict)]
    return []


def home_gid(home: dict) -> Any:
    for key in ("gid", "groupId", "id", "homeId"):
        val = home.get(key)
        if val is not None and val != "":
            return val
    return None


def room_devices(room: dict) -> list[dict]:
    if not isinstance(room, dict):
        return []
    for key in ("deviceList", "devices", "deviceInfoList"):
        inner = room.get(key)
        if isinstance(inner, list):
            return [x for x in inner if isinstance(x, dict)]
    return []


def looks_like_camera(device: dict) -> bool:
    """sp/dghsxj are the common IPC codes; doorbells and p2p devices too."""
    if not isinstance(device, dict):
        return False
    cat = str(device.get("category") or "")
    if cat in CAMERA_CATEGORIES or cat.startswith("sp") or "video" in cat.lower():
        return True
    if device.get("p2pType") or device.get("supportCloudStorage"):
        return True
    return False


def extra_homes(login: Any) -> list[dict]:
    """Some accounts only put the home id on login extras, not in homeList."""
    if not isinstance(login, dict):
        return []
    extras = login.get("extras") if isinstance(login.get("extras"), dict) else {}
    out: list[dict] = []
    for key in ("homeId", "gid", "groupId"):
        val = extras.get(key)
        if val not in (None, ""):
            out.append({"gid": val, "homeId": val, "name": "extras"})
            break
    return out


def safe_poll_text(raw: Any) -> str:
    """Never put session cookies / sid into the UI log."""
    text = "" if raw is None else str(raw)
    if not text:
        return ""
    lowered = text.lower()
    if any(k in lowered for k in ('"sid"', "fast-sid", "s-sid", "ecode", "localkey")):
        return "Login ok (session details hidden)."
    return text[:400]


class TuyaClient:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.session = requests.Session()
        self.region_id = "eu"
        self.host = REGIONS["eu"]["host"]
        self.region_key = REGIONS["eu"]["key"]
        self.token: Optional[str] = None
        self.login: Optional[dict] = None
        self.cameras: list[dict] = []
        self.discovery: dict[str, Any] = {}
        self.last_error: Optional[str] = None
        self.last_poll: Optional[str] = None
        self.poll_count = 0
        self.generation = 0

    def set_region(self, region_id: str) -> None:
        if region_id not in REGIONS:
            raise ValueError(f"Unbekannte Region: {region_id}")
        info = REGIONS[region_id]
        self.region_id = region_id
        self.host = info["host"]
        self.region_key = info["key"]
        self.session = requests.Session()
        self.token = None
        self.login = None
        self.cameras = []

    def _url(self, path: str) -> str:
        return f"https://{self.host}{path}"

    def _headers(self, referer: str = "/login") -> dict:
        origin = f"https://{self.host}"
        return {
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "*/*",
            "Origin": origin,
            "Referer": origin + referer,
            "X-Requested-With": "XMLHttpRequest",
        }

    def _post(self, path: str, payload: Any = None, referer: str = "/login") -> dict:
        data = None if payload is None else json.dumps(payload)
        resp = self.session.post(
            self._url(path),
            data=data,
            headers=self._headers(referer),
            timeout=30,
        )
        # Auto-relogin once on expired protect session when cloud_auth password exists.
        if resp.status_code in (401, 403) or (
            resp.status_code == 200
            and "USER_SESSION_INVALID" in (resp.text or "")
        ):
            if self._try_password_relogin():
                resp = self.session.post(
                    self._url(path),
                    data=data,
                    headers=self._headers(referer),
                    timeout=30,
                )
        resp.raise_for_status()
        body = resp.json()
        if not body.get("success"):
            msg = body.get("errorMsg") or body.get("msg") or "Tuya-API-Fehler"
            if "USER_SESSION_INVALID" in str(msg) and self._try_password_relogin():
                resp = self.session.post(
                    self._url(path),
                    data=data,
                    headers=self._headers(referer),
                    timeout=30,
                )
                resp.raise_for_status()
                body = resp.json()
                if body.get("success"):
                    return body
            raise RuntimeError(msg)
        return body

    def _cloud_auth_path(self) -> Path:
        return self.data_dir / "cloud_auth.json"

    def _load_cloud_password(self) -> tuple[Optional[str], Optional[str], str]:
        p = self._cloud_auth_path()
        if not p.exists():
            return None, None, "49"
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return None, None, "49"
        if not isinstance(data, dict):
            return None, None, "49"
        email = (data.get("email") or "").strip() or None
        password = data.get("password") or None
        country = str(data.get("countryCode") or "49")
        return email, password, country

    def password_login(
        self, email: str, password: str, country_code: str = "49"
    ) -> dict:
        """Protect email/password login → cookies + loginResult (no QR)."""
        import hashlib

        from cryptography.hazmat.backends import default_backend
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import padding

        email = (email or "").strip()
        if not email or not password:
            raise RuntimeError("Email und Passwort nötig")
        origin = f"https://{self.host}"
        headers = self._headers("/login")
        # fresh jar for login
        self.session = requests.Session()
        self.session.get(origin + "/login", timeout=20)
        tok = self.session.post(
            origin + "/api/login/token",
            json={"countryCode": str(country_code), "username": email, "isUid": False},
            headers=headers,
            timeout=20,
        ).json()
        if not tok.get("success"):
            raise RuntimeError(
                tok.get("errorMsg") or tok.get("errorCode") or "Login-Token fehlgeschlagen"
            )
        tres = tok["result"]
        pb = tres.get("pbKey") or ""
        token = tres.get("token")
        pem = pb if "BEGIN" in pb else f"-----BEGIN PUBLIC KEY-----\n{pb}\n-----END PUBLIC KEY-----"
        pub = serialization.load_pem_public_key(pem.encode(), backend=default_backend())
        enc = pub.encrypt(
            hashlib.md5(password.encode()).hexdigest().encode(), padding.PKCS1v15()
        ).hex()
        body = self.session.post(
            origin + "/api/private/email/login",
            json={
                "countryCode": str(country_code),
                "email": email,
                "passwd": enc,
                "token": token,
                "ifencrypt": 1,
                "options": '{"group":1}',
            },
            headers=headers,
            timeout=20,
        ).json()
        if not body.get("success"):
            raise RuntimeError(
                body.get("errorMsg") or body.get("errorCode") or "Passwort-Login fehlgeschlagen"
            )
        login = body.get("result")
        if not isinstance(login, dict) or not login.get("sid"):
            raise RuntimeError("Passwort-Login ohne SID")
        self.login = login
        self.token = None
        self.save_session()
        return login

    def _try_password_relogin(self) -> bool:
        email, password, country = self._load_cloud_password()
        if not email or not password:
            # try session email + stored password only
            return False
        try:
            self.password_login(email, password, country)
            return True
        except Exception as exc:
            self.last_error = f"relogin: {exc}"
            return False

    def ensure_session(self) -> None:
        """Validate protect session; password-relogin from cloud_auth if needed."""
        if not self.login and not self.load_latest_session():
            email, password, country = self._load_cloud_password()
            if email and password:
                self.password_login(email, password, country)
            else:
                raise RuntimeError("Nicht eingeloggt")
        try:
            self._post("/api/customized/web/app/info", payload=None, referer="/playback")
        except Exception:
            if not self._try_password_relogin():
                raise

    def generate_qr(self) -> str:
        self.session.get(self._url("/login"), timeout=20)
        body = self._post("/api/login/security/QCtoken", payload=None)
        token = body.get("result")
        if not token or not isinstance(token, str):
            raise RuntimeError("Kein QR-Token erhalten")
        self.token = token
        self.login = None
        self.last_error = None
        self.last_poll = "QR erzeugt, warte auf Scan …"
        self.poll_count = 0
        self.generation += 1
        return token

    def qr_payload(self) -> str:
        if not self.token:
            raise RuntimeError("Kein QR-Token")
        return QR_PAYLOAD_PREFIX + self.token

    def _as_login(self, result) -> Optional[dict]:
        if isinstance(result, str):
            try:
                result = json.loads(result)
            except Exception:
                return None
        if isinstance(result, dict) and (
            result.get("uid")
            or result.get("sid")
            or result.get("ecode")
            or result.get("username")
            or result.get("email")
        ):
            return result
        return None

    def fetch_user_info(self) -> Optional[dict]:
        for path, payload in (
            ("/api/common/user/info", {}),
            ("/api/customized/web/app/info", None),
        ):
            try:
                body = self._post(path, payload=payload, referer="/playback")
            except Exception:
                continue
            login = self._as_login(body.get("result"))
            if login:
                return login
        return None

    def poll_once(self) -> Optional[dict]:
        if not self.token:
            return None
        url = self._url("/api/login/poll")
        resp = self.session.post(
            url,
            data=json.dumps({"token": self.token}),
            headers=self._headers("/login"),
            timeout=30,
        )
        raw = resp.text
        self.poll_count += 1
        self.last_poll = safe_poll_text(raw)
        resp.raise_for_status()
        body = resp.json()
        login = self._as_login(body.get("result"))
        if login:
            self.login = login
            return login
        if body.get("success"):
            via_session = self.fetch_user_info()
            if via_session:
                self.login = via_session
                return via_session
        return None

    def wait_login(self, timeout_s: int = 300, interval_s: float = 1.0, generation: Optional[int] = None) -> Optional[dict]:
        deadline = time.time() + timeout_s
        gen = self.generation if generation is None else generation
        while time.time() < deadline:
            if self.generation != gen:
                return None
            try:
                got = self.poll_once()
            except Exception as exc:
                self.last_error = str(exc)
                self.last_poll = f"poll-fehler: {exc}"
                time.sleep(interval_s)
                continue
            if got:
                return got
            time.sleep(interval_s)
        return None

    def _cookie_dump(self) -> list[dict]:
        out = []
        for c in self.session.cookies:
            rest = getattr(c, "rest", None) or getattr(c, "_rest", None) or {}
            if not isinstance(rest, dict):
                rest = {}
            expires = "0001-01-01T00:00:00Z"
            if getattr(c, "expires", None):
                try:
                    expires = _utc_iso(float(c.expires))
                except Exception:
                    pass
            out.append(
                {
                    "name": getattr(c, "name", ""),
                    "value": getattr(c, "value", ""),
                    "domain": getattr(c, "domain", None) or self.host,
                    "path": getattr(c, "path", None) or "/",
                    "expires": expires,
                    "secure": bool(getattr(c, "secure", False)),
                    "httpOnly": bool(rest.get("HttpOnly") or rest.get("httponly")),
                }
            )
        return out

    def save_session(self) -> Path:
        if not self.login:
            raise RuntimeError("Nicht eingeloggt")
        email = self.login.get("email") or self.login.get("username") or self.login.get("uid")
        try:
            cookies = self._cookie_dump()
        except Exception:
            cookies = []
        session = {
            "region": self.region_key,
            "email": email,
            "lastRefresh": _utc_iso(),
            "userKey": _user_key(self.region_key, email),
            "sessionData": {
                "loginResult": self.login,
                "cookies": cookies,
                "lastValidated": _utc_iso(),
                "serverHost": self.host,
                "region": self.region_key,
                "userEmail": email,
            },
        }
        path = self.data_dir / f"user_{session['userKey']}.json"
        path.write_text(json.dumps(session, indent=2, ensure_ascii=False), encoding="utf-8")
        return path

    def load_latest_session(self) -> bool:
        files = sorted(self.data_dir.glob("user_*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not files:
            return False
        data = json.loads(files[0].read_text(encoding="utf-8"))
        sd = data.get("sessionData") or {}
        host = sd.get("serverHost")
        if not host:
            return False
        self.host = host
        self.region_key = data.get("region") or sd.get("region") or self.region_key
        for rid, info in REGIONS.items():
            if info["host"] == host or info["key"] == self.region_key:
                self.region_id = rid
                break
        self.login = sd.get("loginResult")
        self.session = requests.Session()
        for c in sd.get("cookies") or []:
            self.session.cookies.set(
                c.get("name", ""),
                c.get("value", ""),
                domain=(c.get("domain") or host).lstrip("."),
                path=c.get("path") or "/",
            )
        cam_file = self.data_dir / "cameras.json"
        if cam_file.exists():
            registry = json.loads(cam_file.read_text(encoding="utf-8"))
            self.cameras = registry.get("cameras") or []
        return bool(self.login)

    def discover_cameras(self) -> list[dict]:
        self.ensure_session()
        if not self.login:
            raise RuntimeError("Nicht eingeloggt")
        self._post("/api/customized/web/app/info", payload=None, referer="/playback")
        devices: list[dict] = []
        seen: set[str] = set()
        skipped: dict[str, int] = {}
        errors: list[str] = []
        homes_n = 0

        try:
            homes_body = self._post("/api/new/common/homeList", payload=None, referer="/playback")
        except Exception as exc:
            homes_body = {"result": []}
            errors.append(f"homeList: {exc}")

        homes = as_dict_list(homes_body.get("result"))
        seen_gids = {str(home_gid(h)) for h in homes if home_gid(h) is not None}
        for extra in extra_homes(self.login):
            gid = home_gid(extra)
            if gid is not None and str(gid) not in seen_gids:
                homes.append(extra)
                seen_gids.add(str(gid))
        homes_n = len(homes)
        for home in homes:
            gid = home_gid(home)
            if gid is None:
                continue
            try:
                rooms_body = self._post(
                    "/api/new/common/roomList",
                    payload={"homeId": str(gid)},
                    referer="/playback",
                )
            except Exception as exc:
                errors.append(f"roomList {gid}: {exc}")
                continue
            for room in as_dict_list(rooms_body.get("result")):
                for device in room_devices(room):
                    did = device.get("deviceId")
                    if not did or did in seen:
                        continue
                    if looks_like_camera(device):
                        seen.add(did)
                        devices.append(device)
                    else:
                        cat = str(device.get("category") or "?")
                        skipped[cat] = skipped.get(cat, 0) + 1

        try:
            shared = self._post("/api/new/playback/shareList", payload=None, referer="/playback")
        except Exception as exc:
            shared = {}
            errors.append(f"shareList: {exc}")
        share_root = shared.get("result")
        share_homes = []
        if isinstance(share_root, dict):
            share_homes = share_root.get("securityWebCShareInfoList") or []
        elif isinstance(share_root, list):
            share_homes = share_root
        for sh in share_homes:
            if not isinstance(sh, dict):
                continue
            for device in sh.get("deviceInfoList") or room_devices(sh):
                did = device.get("deviceId") if isinstance(device, dict) else None
                if not did or did in seen:
                    continue
                if looks_like_camera(device):
                    seen.add(did)
                    devices.append(device)
                else:
                    cat = str(device.get("category") or "?")
                    skipped[cat] = skipped.get(cat, 0) + 1

        email = self.login.get("email") or self.login.get("username") or self.login.get("uid")
        user_key = _user_key(self.region_key, email)
        cameras = []
        for device in devices:
            did = device["deviceId"]
            skill = ""
            try:
                cfg = self._post(
                    "/api/jarvis/config",
                    payload={
                        "devId": did,
                        "clientTraceId": f"{random.randrange(1 << 62):x}",
                    },
                    referer="/playback",
                )
                skill = (cfg.get("result") or {}).get("skill") or ""
            except Exception as exc:
                errors.append(f"jarvis {did[-6:]}: {type(exc).__name__}")
            name = _clean_name(device.get("deviceName") or "", did)
            cameras.append(
                {
                    "userKey": user_key,
                    "deviceId": did,
                    "deviceName": name,
                    "category": device.get("category") or "",
                    "rtspPath": _rtsp_path(name, did),
                    "productId": device.get("productId") or "",
                    "uuid": device.get("uuid") or "",
                    "skill": skill,
                }
            )
        # Smart Life permits two different devices to have the same display
        # name. A name-only RTSP path would then make both cameras serve the
        # same stream. Keep ordinary paths readable, but disambiguate every
        # colliding path with a stable suffix derived from the device ID.
        path_counts: dict[str, int] = {}
        for camera in cameras:
            path = str(camera["rtspPath"])
            path_counts[path] = path_counts.get(path, 0) + 1
        for camera in cameras:
            path = str(camera["rtspPath"])
            if path_counts[path] > 1:
                suffix = re.sub(r"[^A-Za-z0-9]", "", str(camera["deviceId"]))[-8:]
                camera["rtspPath"] = f"{path}_{suffix}"
        self.cameras = cameras
        note = f"{len(cameras)} camera(s) from {homes_n} home(s)."
        if not cameras:
            bits = [f"homes={homes_n}", f"candidates={len(devices)}"]
            if skipped:
                bits.append("skipped=" + ",".join(f"{k}:{v}" for k, v in sorted(skipped.items())))
            if errors:
                bits.append("errors=" + "; ".join(errors[:4]))
            note = (
                "No cameras. "
                + " ".join(bits)
                + " Try Refresh cameras, or the other EU/WE region."
            )
        self.discovery = {
            "homes": homes_n,
            "candidates": len(devices),
            "cameras": len(cameras),
            "skipped": skipped,
            "errors": errors[:8],
            "note": note,
        }
        registry = {"cameras": cameras, "lastUpdated": _utc_iso(), "discovery": self.discovery}
        (self.data_dir / "cameras.json").write_text(
            json.dumps(registry, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        return cameras

    def logout(self) -> None:
        for f in self.data_dir.glob("user_*.json"):
            f.unlink(missing_ok=True)
        cam = self.data_dir / "cameras.json"
        if cam.exists():
            cam.unlink()
        self.session = requests.Session()
        self.token = None
        self.login = None
        self.cameras = []
        self.discovery = {}
        self.last_error = None


def slug(name: str) -> str:
    s = (name or "").replace("\t", " ").replace("\r", " ").replace("\n", " ").strip()
    s = re.sub(r"[^a-zA-Z0-9_-]+", "_", s)
    return s.strip("_") or "kamera"
