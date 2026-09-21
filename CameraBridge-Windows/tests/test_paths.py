"""Path helpers find bundled runtimes without crashing."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from paths import ffmpeg_exe, install_root, vlc_dir  # noqa: E402


def test_install_root() -> None:
    root = install_root()
    assert root.name == "tuya-rtsp-bridge" or (root / "src").is_dir()


def test_lookups_do_not_raise() -> None:
    vlc_dir()
    ffmpeg_exe()


if __name__ == "__main__":
    test_install_root()
    test_lookups_do_not_raise()
    print("paths ok", install_root())
