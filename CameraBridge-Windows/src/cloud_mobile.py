"""Cloud PTZ via reverse-engineered Tuya mobile API.

No IoT Platform Access ID/Secret. Flow:
  1) protect-*.ismartlife.me email+password → sid (consumer session)
  2) a1.tuya*.com tuya.m.device.dp.publish signed with public Tuya Smart
     app credentials (same class as tuya-uncover / localtuya reverse keys)

Never log sid/password/secrets.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

import requests

# Public Tuya Smart app credentials (reverse-engineered — NOT user IoT keys)
# Protect web sid validates against this app key, not Smart Life.
_APP_KEY = "3fjrekuxank9eaej3gcx"
_APP_SECRET = "aq7xvqcyqcnegvew793pqjmhv77rneqc"
_APP_SECRET2 = "vay9g59g9g99qf3rtqptmc3emhkanwkx"
_APP_CERT = (
    "93:21:9F:C2:73:E2:20:0F:4A:DE:E5:F7:19:1D:C6:56:BA:2A:2D:7B:2F:F5:D2:4C:D5:5C:4B:61:55:00:1E:40"
)
_KEY_HMAC = f"{_APP_CERT}_{_APP_SECRET2}_{_APP_SECRET}"
_TTID = "tuya"
_AUTH_FILE = "cloud_auth.json"

# protect host by region id used in tuya_client
_PROTECT_HOST = {
    "eu": "protect-eu.ismartlife.me",
    "we": "protect-we.ismartlife.me",
    "us": "protect-us.ismartlife.me",
    "ue": "protect-ue.ismartlife.me",
    "cn": "protect.ismartlife.me",
    "in": "protect-in.ismartlife.me",
}

DIR = {
    "up": "0",
    "upright": "1",
    "right": "2",
    "downright": "3",
    "down": "4",
    "downleft": "5",
    "left": "6",
    "upleft": "7",
}
PTZ_DP = "119"
STOP_DP = "116"

_VALUES_TO_SIGN = [
    "a",
    "v",
    "lat",
    "lon",
    "lang",
    "deviceId",
    "imei",
    "imsi",
    "appVersion",
    "ttid",
    "isH5",
    "h5Token",
    "os",
    "clientId",
    "postData",
    "time",
    "requestId",
    "n4h5",
    "sid",
    "sp",
    "et",
]


def _md5_hex(data: str | bytes) -> str:
    if isinstance(data, str):
        data = data.encode()
    return hashlib.md5(data).hexdigest()


def _mobile_hash(post_data: str) -> str:
    pre = _md5_hex(post_data)
    return pre[8:16] + pre[0:8] + pre[24:32] + pre[16:24]


def _rsa_pkcs1_encrypt_md5_password(password: str, pb_key_b64: str) -> str:
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import padding

    pem = pb_key_b64
    if "BEGIN" not in pem:
        pem = f"-----BEGIN PUBLIC KEY-----\n{pb_key_b64}\n-----END PUBLIC KEY-----"
    pub = serialization.load_pem_public_key(pem.encode(), backend=default_backend())
    return pub.encrypt(_md5_hex(password).encode(), padding.PKCS1v15()).hex()


class CloudMobile:
    def __init__(self, data_dir: Path, region_id: str = "eu") -> None:
        self.data_dir = data_dir
        self.region_id = region_id if region_id in _PROTECT_HOST else "eu"
        self._lock = threading.Lock()
        self._sid: Optional[str] = None
        self._endpoint = "https://a1.tuyaeu.com/api.json"
        self._email: Optional[str] = None
        self._password: Optional[str] = None
        self._country = "49"
        self._device_id = "a" * 44
        self._load()

    def _auth_path(self) -> Path:
        return self.data_dir / _AUTH_FILE

    def _protect_host(self) -> str:
        return _PROTECT_HOST.get(self.region_id, _PROTECT_HOST["eu"])

    def _load(self) -> None:
        p = self._auth_path()
        if not p.exists():
            return
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return
        if not isinstance(data, dict):
            return
        self._sid = data.get("sid") or None
        self._endpoint = data.get("endpoint") or self._endpoint
        self._email = data.get("email") or None
        self._password = data.get("password") or None
        self._country = str(data.get("countryCode") or "49")
        if data.get("deviceId"):
            self._device_id = str(data["deviceId"])
        if data.get("regionId") in _PROTECT_HOST:
            self.region_id = data["regionId"]

    def _save(self) -> None:
        out = {
            "sid": self._sid,
            "endpoint": self._endpoint,
            "email": self._email,
            "password": self._password,
            "countryCode": self._country,
            "deviceId": self._device_id,
            "regionId": self.region_id,
            "via": "protect_password_sid",
        }
        path = self._auth_path()
        path.write_text(json.dumps(out, indent=2), encoding="utf-8")
        try:
            path.chmod(0o600)
        except Exception:
            pass

    def set_credentials(
        self, email: str, password: str, country_code: str = "49"
    ) -> None:
        with self._lock:
            self._email = email.strip()
            self._password = password
            self._country = str(country_code or "49")
            self._sid = None
            self._save()

    def has_auth(self) -> bool:
        return bool(self._sid or (self._email and self._password))

    def _request(
        self,
        action: str,
        data: Optional[dict] = None,
        *,
        requires_sid: bool = True,
        version: str = "1.0",
    ) -> Any:
        pairs: dict[str, Any] = {
            "a": action,
            "deviceId": self._device_id,
            "os": "Android",
            "lang": "en",
            "v": version,
            "clientId": _APP_KEY,
            "time": int(time.time()),
            "et": "0.0.1",
            "ttid": _TTID,
            "appVersion": "3.8.5",
            "appRnVersion": "5.11",
            "platform": "Android",
            "requestId": str(uuid.uuid4()),
        }
        if data is not None:
            pairs["postData"] = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
        if requires_sid:
            if not self._sid:
                raise RuntimeError("Cloud-PTZ: kein SID")
            pairs["sid"] = self._sid
        parts: list[str] = []
        for key in sorted(pairs.keys()):
            if key not in _VALUES_TO_SIGN or pairs[key] == "":
                continue
            if key == "postData":
                parts.append(f"postData={_mobile_hash(pairs[key])}")
            else:
                parts.append(f"{key}={pairs[key]}")
        pairs["sign"] = hmac.new(
            _KEY_HMAC.encode(), "||".join(parts).encode(), hashlib.sha256
        ).hexdigest()
        resp = requests.get(self._endpoint, params=pairs, timeout=20)
        resp.raise_for_status()
        body = resp.json()
        if not body.get("success"):
            code = body.get("errorCode") or ""
            msg = body.get("errorMsg") or "API error"
            raise RuntimeError(f"Cloud-API {code}: {msg}" if code else msg)
        return body.get("result")

    def login(self, force: bool = False) -> str:
        """Protect email/password → sid; usable with Tuya-app-signed mobile API."""
        with self._lock:
            if self._sid and not force:
                return self._sid
            if not self._email or not self._password:
                raise RuntimeError(
                    "Cloud-PTZ: Smart-Life/Tuya E-Mail+Passwort nötig "
                    "(einmalig; reverse App-API, keine IoT-Keys)"
                )
            host = self._protect_host()
            sess = requests.Session()
            origin = f"https://{host}"
            headers = {
                "Content-Type": "application/json; charset=utf-8",
                "Accept": "*/*",
                "Origin": origin,
                "Referer": origin + "/login",
                "X-Requested-With": "XMLHttpRequest",
            }
            sess.get(origin + "/login", timeout=20)
            tok_body = sess.post(
                origin + "/api/login/token",
                json={
                    "countryCode": self._country,
                    "username": self._email,
                    "isUid": False,
                },
                headers=headers,
                timeout=20,
            ).json()
            if not tok_body.get("success"):
                raise RuntimeError(
                    tok_body.get("errorMsg")
                    or tok_body.get("errorCode")
                    or "Login-Token fehlgeschlagen"
                )
            tres = tok_body["result"]
            pb = tres.get("pbKey") or tres.get("publicKey")
            token = tres.get("token")
            if not pb or not token:
                raise RuntimeError("Cloud-PTZ: Login-Token unvollständig")
            enc = _rsa_pkcs1_encrypt_md5_password(self._password, pb)
            login_body = sess.post(
                origin + "/api/private/email/login",
                json={
                    "countryCode": self._country,
                    "email": self._email,
                    "passwd": enc,
                    "token": token,
                    "ifencrypt": 1,
                    "options": '{"group":1}',
                },
                headers=headers,
                timeout=20,
            ).json()
            if not login_body.get("success"):
                raise RuntimeError(
                    login_body.get("errorMsg")
                    or login_body.get("errorCode")
                    or "Cloud-Login fehlgeschlagen"
                )
            result = login_body.get("result") or {}
            sid = result.get("sid")
            if not sid:
                raise RuntimeError("Cloud-PTZ: Login ohne SID")
            domain = result.get("domain") or {}
            api = domain.get("mobileApiUrl")
            if api:
                self._endpoint = api.rstrip("/") + "/api.json"
            self._sid = sid
            self._save()
            return sid

    def ensure_session(self) -> None:
        try:
            if self._sid:
                self._request("tuya.m.location.list", {})
                return
        except Exception:
            self._sid = None
        self.login(force=True)

    def publish_dps(self, device_id: str, dps: dict) -> Any:
        self.ensure_session()
        try:
            return self._request(
                "tuya.m.device.dp.publish",
                {"devId": device_id, "dps": dps},
            )
        except RuntimeError as exc:
            msg = str(exc).upper()
            if any(x in msg for x in ("SESSION", "SID", "LOGIN", "INVALID")):
                self.login(force=True)
                return self._request(
                    "tuya.m.device.dp.publish",
                    {"devId": device_id, "dps": dps},
                )
            raise

    def move(self, device_id: str, direction: str) -> dict:
        direction = (direction or "").lower().strip()
        if direction == "stop":
            return self.stop(device_id)
        if direction not in DIR:
            raise ValueError(f"unbekannte Richtung {direction}")
        res = self.publish_dps(device_id, {PTZ_DP: DIR[direction]})
        return {
            "via": "cloud",
            "dp": PTZ_DP,
            "value": DIR[direction],
            "result": res,
        }

    def stop(self, device_id: str) -> dict:
        res = self.publish_dps(device_id, {STOP_DP: True})
        return {"via": "cloud", "dp": STOP_DP, "value": True, "result": res}

    def seed_from_session(self, login_result: dict) -> None:
        if not isinstance(login_result, dict):
            return
        email = login_result.get("email")
        if email and not self._email:
            self._email = email
        phone_code = login_result.get("phoneCode") or login_result.get("countryCode")
        if phone_code:
            self._country = str(phone_code).lstrip("+") or self._country
        # Web QR sid is a different client — do not reuse for mobile sign.
        if self._email or self._password:
            self._save()
