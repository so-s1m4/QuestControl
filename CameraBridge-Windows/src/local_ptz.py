"""PTZ: LAN 6668 first, then Cloud reverse Smart-Life API. Keine Secrets loggen."""
from __future__ import annotations

import json
import socket
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

import tinytuya

from cloud_mobile import CloudMobile

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
LAN_CACHE = "lan.json"
VERS = (3.5, 3.4, 3.3)

# Interfaces that are almost never the camera LAN (VPN tunnels, docker, …)
_SKIP_IFACE_PREFIX = (
    "nordlynx",
    "wg",
    "tun",
    "tap",
    "docker",
    "br-",
    "veth",
    "virbr",
    "tailscale",
    "zt",
)


def _iface_ipv4s() -> list[tuple[str, str]]:
    """Return [(iface, ip)] for usable LAN addresses — never prefer VPN over Ethernet."""
    out: list[tuple[str, str]] = []
    try:
        import fcntl
        import struct
        import array
        import os

        # parse `ip -4 -o addr` — portable enough on Linux
        import subprocess

        text = subprocess.check_output(
            ["ip", "-4", "-o", "addr", "show", "scope", "global"],
            text=True,
            timeout=3,
        )
    except Exception:
        text = ""
    for line in text.splitlines():
        # 2: enp…    inet 192.168.2.159/24 …
        parts = line.split()
        if len(parts) < 4:
            continue
        iface = parts[1]
        if any(iface.startswith(p) for p in _SKIP_IFACE_PREFIX):
            continue
        if "inet" not in parts:
            continue
        try:
            ip = parts[parts.index("inet") + 1].split("/")[0]
        except Exception:
            continue
        if ip.startswith("127."):
            continue
        out.append((iface, ip))
    # stable preference: eth/en/wl first
    def rank(item: tuple[str, str]) -> tuple[int, str]:
        iface, ip = item
        if iface.startswith(("en", "eth", "wl", "wlan")):
            return (0, iface)
        if ip.startswith(("192.168.", "10.")) or ip.startswith("172."):
            return (1, iface)
        return (2, iface)

    out.sort(key=rank)
    return out


def _local_ipv4() -> str:
    """Best-effort LAN IP for the camera subnet (not VPN)."""
    ifaces = _iface_ipv4s()
    if ifaces:
        return ifaces[0][1]
    # last resort: old UDP trick
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def _prefixes() -> list[str]:
    """All /24 prefixes we should scan for port 6668."""
    prefs: list[str] = []
    for _, ip in _iface_ipv4s():
        parts = ip.split(".")
        if len(parts) == 4:
            p = ".".join(parts[:3]) + "."
            if p not in prefs:
                prefs.append(p)
    if not prefs:
        ip = _local_ipv4()
        parts = ip.split(".")
        if len(parts) == 4 and parts[0] != "127":
            prefs.append(".".join(parts[:3]) + ".")
    return prefs


def _scan_6668(prefix: str | None = None) -> list[str]:
    prefixes = [prefix] if prefix else _prefixes()
    found: list[str] = []

    def chk(ip: str) -> Optional[str]:
        s = socket.socket()
        s.settimeout(0.25)
        try:
            if s.connect_ex((ip, 6668)) == 0:
                return ip
        except Exception:
            return None
        finally:
            s.close()
        return None

    for pref in prefixes:
        with ThreadPoolExecutor(max_workers=64) as ex:
            ips = [f"{pref}{i}" for i in range(1, 255)]
            for ip in ex.map(chk, ips):
                if ip and ip not in found:
                    found.append(ip)
    return found


class LocalPtz:
    def __init__(self, data_dir: Path, tuya_client) -> None:
        self.data_dir = data_dir
        self.client = tuya_client
        region = getattr(tuya_client, "region_id", None) or "eu"
        self.cloud = CloudMobile(data_dir, region_id=str(region))
        self._lock = threading.Lock()
        self._map: dict[str, dict] = {}
        self._load_cache()
        self._seed_cloud_email()

    def _seed_cloud_email(self) -> None:
        try:
            login = getattr(self.client, "login", None) or {}
            if isinstance(login, dict) and login:
                self.cloud.seed_from_session(login)
                return
            # session file fallback
            for p in self.data_dir.glob("user_*.json"):
                data = json.loads(p.read_text(encoding="utf-8"))
                lr = (data.get("sessionData") or {}).get("loginResult") or {}
                if lr:
                    self.cloud.seed_from_session(lr)
                    break
        except Exception:
            pass

    def _load_cache(self) -> None:
        p = self.data_dir / LAN_CACHE
        if not p.exists():
            return
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                self._map = {
                    k: v for k, v in data.items() if isinstance(v, dict) and v.get("ip")
                }
        except Exception:
            self._map = {}

    def _save_cache(self) -> None:
        out = {
            did: {"ip": v["ip"], "version": v["version"]}
            for did, v in self._map.items()
            if v.get("ip")
        }
        (self.data_dir / LAN_CACHE).write_text(json.dumps(out, indent=2), encoding="utf-8")

    def _local_key(self, device_id: str) -> str:
        body = self.client._post(
            "/api/jarvis/config",
            payload={"devId": device_id, "clientTraceId": "ptz"},
            referer="/playback",
        )
        key = (body.get("result") or {}).get("localKey") or ""
        if not key:
            raise RuntimeError("kein localKey")
        return key

    def _probe(self, device_id: str, ip: str, key: str, ver: float) -> bool:
        d = tinytuya.Device(device_id, ip, key, version=ver)
        d.set_socketTimeout(3)
        try:
            st = d.status()
        except Exception:
            return False
        if not isinstance(st, dict):
            return False
        if st.get("Error") or st.get("Err"):
            return False
        return "dps" in st or "DPS" in st

    def ensure(self, device_id: str) -> dict:
        with self._lock:
            hit = self._map.get(device_id)
            if hit and hit.get("ip") and hit.get("key") and hit.get("version"):
                if hit.get("key"):
                    return hit
            cached_ip = (hit or {}).get("ip")
            cached_ver = (hit or {}).get("version")
        key = self._local_key(device_id)
        # Accept any IP that still probes; don't reject just because VPN is primary.
        if cached_ip:
            vers = (cached_ver,) if cached_ver else VERS
            for ver in vers:
                if self._probe(device_id, cached_ip, key, float(ver)):
                    rec = {"ip": cached_ip, "version": float(ver), "key": key}
                    with self._lock:
                        self._map[device_id] = rec
                        self._save_cache()
                    return rec
        with self._lock:
            ips: list[str] = []
            hit = self._map.get(device_id) or {}
            if hit.get("ip"):
                ips.append(hit["ip"])
            ips.extend(
                v.get("ip")
                for v in self._map.values()
                if v.get("ip") and v.get("ip") not in ips
            )
        # Fast path for remote: only scan if we already have candidate IPs
        # or a local (non-VPN) prefix. Full /24 scan is expensive and useless off-site.
        prefs = _prefixes()
        scanned: list[str] = []
        if ips or prefs:
            # limit scan: only when local prefixes exist; still useful at home
            try:
                scanned = _scan_6668() if prefs else []
            except Exception:
                scanned = []
        for ip in scanned:
            if ip not in ips:
                ips.append(ip)
        last = ""
        for ip in ips:
            for ver in VERS:
                if self._probe(device_id, ip, key, ver):
                    rec = {"ip": ip, "version": ver, "key": key}
                    with self._lock:
                        self._map[device_id] = rec
                        self._save_cache()
                    return rec
                last = f"{ip} v{ver}"
        raise RuntimeError(
            f"Kamera {device_id} nicht auf LAN "
            f"(prefixes={prefs or ['?']}, scanned={len(scanned)}, last={last or 'none'})"
        )

    def warmup(self, device_ids: list[str]) -> None:
        def run() -> None:
            for did in device_ids:
                try:
                    self.ensure(did)
                except Exception:
                    pass

        threading.Thread(target=run, daemon=True, name="ptz-warmup").start()

    def _device(self, device_id: str):
        rec = self.ensure(device_id)
        d = tinytuya.Device(device_id, rec["ip"], rec["key"], version=rec["version"])
        d.set_socketTimeout(5)
        return d

    def move(self, device_id: str, direction: str) -> dict:
        direction = (direction or "").lower().strip()
        if direction == "stop":
            return self.stop(device_id)
        if direction not in DIR:
            raise ValueError(f"unbekannte Richtung {direction}")
        # Prefer cloud when we already have cloud auth and no LAN cache —
        # remote users shouldn't wait for a LAN scan timeout first.
        prefer_cloud = self.cloud.has_auth() and device_id not in self._map
        lan_err: Optional[str] = None
        if not prefer_cloud:
            try:
                d = self._device(device_id)
                res = d.set_value(PTZ_DP, DIR[direction])
                return {
                    "via": "lan",
                    "dp": PTZ_DP,
                    "value": DIR[direction],
                    "result": res,
                    "ip": self._map.get(device_id, {}).get("ip"),
                }
            except Exception as exc:
                lan_err = str(exc)
        try:
            out = self.cloud.move(device_id, direction)
            if lan_err:
                out["lan_error"] = lan_err
            return out
        except Exception as cloud_exc:
            if prefer_cloud and lan_err is None:
                # cloud failed first; still try LAN once
                try:
                    d = self._device(device_id)
                    res = d.set_value(PTZ_DP, DIR[direction])
                    return {
                        "via": "lan",
                        "dp": PTZ_DP,
                        "value": DIR[direction],
                        "result": res,
                        "ip": self._map.get(device_id, {}).get("ip"),
                        "cloud_error": str(cloud_exc),
                    }
                except Exception as exc:
                    lan_err = str(exc)
            raise RuntimeError(
                f"PTZ fail lan=({lan_err or 'n/a'}) cloud=({cloud_exc})"
            ) from cloud_exc

    def stop(self, device_id: str) -> dict:
        lan_err: Optional[str] = None
        try:
            rec = self.ensure(device_id)
            d = tinytuya.Device(device_id, rec["ip"], rec["key"], version=rec["version"])
            d.set_socketTimeout(2.0)
            res = d.set_value(STOP_DP, True)
            return {
                "via": "lan",
                "dp": STOP_DP,
                "value": True,
                "result": res,
                "ip": rec.get("ip"),
            }
        except Exception as exc:
            lan_err = str(exc)
        try:
            out = self.cloud.stop(device_id)
            out["lan_error"] = lan_err
            return out
        except Exception as cloud_exc:
            raise RuntimeError(
                f"PTZ stop fail lan=({lan_err or 'n/a'}) cloud=({cloud_exc})"
            ) from cloud_exc
