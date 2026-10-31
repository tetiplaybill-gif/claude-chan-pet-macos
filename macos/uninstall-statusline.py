#!/usr/bin/python3
"""Restore only this bridge's statusLine, preserving subsequent unrelated settings."""
import argparse
import json
from pathlib import Path
import sys

from statusline_bridge import (SOURCE, atomic_json, default_root, iso_time,
                              private_directory, private_lock, private_read, read_json)


def uninstall(settings, root):
    settings, root = Path(settings), Path(root)
    if settings.is_symlink() or settings.parent.is_symlink():
        raise ValueError("Refusing symlinked Claude settings")
    original_file = root / "usage/original-statusline.json"
    if not original_file.exists():
        return {"restored": False, "reason": "not-configured"}
    private_directory(root)
    usage = private_directory(root / "usage", tighten=True)
    with private_lock(usage / "install.lock", timeout=5):
        saved = read_json(original_file)
        if not isinstance(saved, dict) or not saved.get("active", True):
            return {"restored": False, "reason": "not-configured"}
        try:
            current = json.loads(private_read(settings).decode("utf-8"))
        except FileNotFoundError:
            current = {}
        if not isinstance(current, dict):
            raise ValueError("Claude settings must be a JSON object")
        statusline = current.get("statusLine")
        matches = (isinstance(statusline, dict) and statusline.get("type") == "command"
                   and statusline.get("command") == saved.get("bridgeCommand"))
        if matches:
            if saved.get("statusLineExisted"):
                current["statusLine"] = saved["statusLine"]
            else:
                current.pop("statusLine", None)
            if not current and not saved.get("settingsExisted"):
                settings.unlink()
            else:
                atomic_json(settings, current)
        # Never replace a command the user changed after installation.
        saved["active"] = False
        saved["uninstalledAt"] = iso_time()
        atomic_json(original_file, saved)
        atomic_json(root / "bridge-status.json", {"configured": False, "source": SOURCE,
                                                  "configuredAt": saved.get("installedAt")})
        return {"restored": matches, "reason": "restored" if matches else "settings-changed-preserved"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--settings", type=Path, default=Path.home() / ".claude/settings.json")
    parser.add_argument("--data-root", type=Path, default=default_root())
    args = parser.parse_args()
    try:
        result = uninstall(args.settings, args.data_root)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print("StatusLine removal stopped: " + str(error), file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
