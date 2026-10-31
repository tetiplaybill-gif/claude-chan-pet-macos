#!/usr/bin/python3
"""Install the local quota bridge only when explicitly requested. Never run Claude."""
import argparse
import json
from pathlib import Path
import shlex
import sys
import time

from statusline_bridge import (SOURCE, MAX_SETTINGS_BYTES, atomic_json, atomic_write,
                              default_root, iso_time, private_directory, private_lock,
                              private_read, read_json)


def settings_data(settings):
    try:
        raw = private_read(settings, MAX_SETTINGS_BYTES)
    except FileNotFoundError:
        return None, {}
    try:
        value = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeError):
        raise ValueError("Claude settings must contain valid JSON") from None
    if not isinstance(value, dict):
        raise ValueError("Claude settings must be a JSON object")
    return raw, value


def install(settings, root):
    settings, root = Path(settings), Path(root)
    if settings.is_symlink() or settings.parent.is_symlink():
        raise ValueError("Refusing symlinked Claude settings")
    root = private_directory(root)
    usage = private_directory(root / "usage", tighten=True)
    command = shlex.join(["/usr/bin/python3", str(usage / "statusline_bridge.py")])
    with private_lock(usage / "install.lock", timeout=5):
        raw, current = settings_data(settings)
        original_file = usage / "original-statusline.json"
        try:
            saved = read_json(original_file)
        except FileNotFoundError:
            saved = None
        existing = current.get("statusLine")
        if isinstance(saved, dict) and saved.get("active", True):
            if (isinstance(existing, dict) and existing.get("type") == "command"
                    and existing.get("command") == saved.get("bridgeCommand") == command):
                atomic_json(root / "bridge-status.json", {
                    "configured": True, "source": SOURCE, "configuredAt": saved["installedAt"]})
                return {"configured": True, "alreadyConfigured": True, "command": command,
                        "backupFile": saved.get("backupFile")}
            raise ValueError("Previous bridge metadata exists; settings differ. Review before reinstalling")
        existed = "statusLine" in current
        if existed and (not isinstance(existing, dict) or existing.get("type") != "command"
                        or not isinstance(existing.get("command"), str) or not existing["command"]):
            raise ValueError("Existing statusLine is not a supported command; nothing changed")
        if isinstance(existing, dict) and existing.get("command") == command:
            raise ValueError("Bridge command exists without its original settings record")
        backup_name = None
        if raw is not None:
            backup_name = "settings-backup-" + str(time.time_ns()) + ".json"
            atomic_write(usage / backup_name, raw)
        installed_at = iso_time()
        snapshot = {"version": 1, "active": True, "settingsExisted": raw is not None,
                    "statusLineExisted": existed, "statusLine": existing if existed else None,
                    "bridgeCommand": command, "backupFile": backup_name, "installedAt": installed_at}
        source = Path(__file__).with_name("statusline_bridge.py")
        atomic_write(usage / "statusline_bridge.py", private_read(source))
        atomic_json(original_file, snapshot)
        replacement = dict(existing) if existed else {}
        replacement.update({"type": "command", "command": command})
        current["statusLine"] = replacement
        private_directory(settings.parent)
        atomic_json(settings, current)
        atomic_json(root / "bridge-status.json", {
            "configured": True, "source": SOURCE, "configuredAt": installed_at})
        return {"configured": True, "alreadyConfigured": False, "command": command,
                "backupFile": backup_name}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--settings", type=Path, default=Path.home() / ".claude/settings.json")
    parser.add_argument("--data-root", type=Path, default=default_root())
    args = parser.parse_args()
    try:
        result = install(args.settings, args.data_root)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print("StatusLine installation stopped: " + str(error), file=sys.stderr)
        return 1
    print(json.dumps({"configured": result["configured"], "alreadyConfigured": result["alreadyConfigured"],
                      "backupCreated": result["backupFile"] is not None}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
