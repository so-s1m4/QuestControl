"""Camera discovery helpers — no network."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from tuya_client import (  # noqa: E402
    as_dict_list,
    extra_homes,
    home_gid,
    looks_like_camera,
    room_devices,
    safe_poll_text,
)


def test_looks_like_camera() -> None:
    assert looks_like_camera({"category": "sp", "deviceId": "a"})
    assert looks_like_camera({"category": "dghsxj", "deviceId": "a"})
    assert looks_like_camera({"category": "videolock", "deviceId": "a"})
    assert looks_like_camera({"category": "sp_wnq", "deviceId": "a"})
    assert looks_like_camera({"category": "kg", "p2pType": 1, "deviceId": "a"})
    assert looks_like_camera({"category": "kg", "supportCloudStorage": True, "deviceId": "a"})
    assert not looks_like_camera({"category": "kg", "deviceId": "a"})
    assert not looks_like_camera({"category": "cz", "deviceId": "a"})


def test_as_dict_list_wrap() -> None:
    assert as_dict_list([{"gid": 1}]) == [{"gid": 1}]
    assert as_dict_list({"homeList": [{"gid": 2}]}) == [{"gid": 2}]
    assert as_dict_list("nope") == []
    assert as_dict_list(None) == []


def test_home_gid() -> None:
    assert home_gid({"gid": 9}) == 9
    assert home_gid({"groupId": 3}) == 3
    assert home_gid({"homeId": "abc"}) == "abc"
    assert home_gid({}) is None


def test_room_devices() -> None:
    d = {"deviceId": "x", "category": "sp"}
    assert room_devices({"deviceList": [d]}) == [d]
    assert room_devices({"devices": [d]}) == [d]
    assert room_devices({}) == []


def test_extra_homes() -> None:
    assert extra_homes(None) == []
    assert extra_homes({"extras": {"homeId": "202072031"}}) == [
        {"gid": "202072031", "homeId": "202072031", "name": "extras"}
    ]


def test_safe_poll_text() -> None:
    assert "hidden" in safe_poll_text('{"sid":"eu-secret","email":"x@y.z"}')
    assert safe_poll_text("QR erzeugt, warte auf Scan …") == "QR erzeugt, warte auf Scan …"


if __name__ == "__main__":
    test_looks_like_camera()
    test_as_dict_list_wrap()
    test_home_gid()
    test_room_devices()
    test_extra_homes()
    test_safe_poll_text()
    print("discover helpers ok")
