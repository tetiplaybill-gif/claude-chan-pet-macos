#!/usr/bin/env python3
"""Explicitly install a local build into ~/Applications; never launch an app."""
import argparse
from datetime import datetime, timezone
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from build_support import BUILD, BUNDLE_ID, app_info, require_arm64, require_platform


def install_app(source, backup_existing=False):
    require_platform()
    source = Path(source).expanduser().resolve(strict=True)
    info = app_info(source)
    if info.get("CFBundleIdentifier") != BUNDLE_ID:
        raise ValueError("Source is not this project's built app")
    require_arm64(source / "Contents/MacOS" / info["CFBundleExecutable"])
    subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(source)], check=True)
    applications = Path.home() / "Applications"
    target = applications / "ClaudeChanPet.app"
    if applications.is_symlink() or target.is_symlink():
        raise ValueError("Refusing a symlinked installation destination")
    if target.exists():
        if not backup_existing:
            raise ValueError("App exists. Close it, then explicitly use --backup-existing to retain a rollback copy")
        if app_info(target).get("CFBundleIdentifier") != BUNDLE_ID:
            raise ValueError("Existing destination has a different bundle identifier; nothing changed")
    applications.mkdir(parents=True, exist_ok=True)
    backup = None
    with tempfile.TemporaryDirectory(prefix=".ClaudeChanPet-install-", dir=applications) as temporary:
        staged = Path(temporary) / "ClaudeChanPet.app"
        shutil.copytree(source, staged, symlinks=True)
        subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(staged)], check=True)
        if target.exists():
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
            backup = target.with_name(target.name + ".backup-" + stamp)
            target.rename(backup)
        try:
            staged.rename(target)
        except OSError:
            if backup is not None and not target.exists():
                backup.rename(target)
            raise
    return target, backup


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, default=BUILD / "ClaudeChanPet.app")
    parser.add_argument("--backup-existing", action="store_true", help="explicitly preserve an existing app as a timestamped sibling backup")
    args = parser.parse_args()
    try:
        target, backup = install_app(args.app, args.backup_existing)
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print("App installation stopped: " + str(error), file=sys.stderr)
        return 1
    print("Installed (not launched): " + str(target))
    if backup is not None:
        print("Rollback copy retained: " + str(backup))
    return 0


if __name__ == "__main__":
    sys.exit(main())
