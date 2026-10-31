#!/usr/bin/env python3
"""Explicitly install this pet's user launcher; --enable also loads it now."""
import argparse
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
from build_support import BUILD, BUNDLE_ID, app_info, require_arm64, require_platform

LABEL = "io.github.mushan08.claude-chan-pet.launcher"


def install_launcher(enable=False):
    require_platform()
    home = Path.home()
    installed_app = home / "Applications/ClaudeChanPet.app"
    if app_info(installed_app).get("CFBundleIdentifier") != BUNDLE_ID:
        raise ValueError("Install this project's app into ~/Applications first")
    source = BUILD / "ClaudePetLauncher"
    require_arm64(source)
    support = home / "Library/Application Support/ClaudeChanPet"
    target = support / "ClaudePetLauncher"
    agent = home / "Library/LaunchAgents" / (LABEL + ".plist")
    if support.is_symlink() or agent.parent.is_symlink():
        raise ValueError("Refusing a symlinked launcher directory")
    if any(p.exists() or p.is_symlink() for p in [target, agent, agent.with_name(agent.name + ".disabled")]):
        raise ValueError("Launcher already exists; refusing to overwrite. Use enable-autostart.sh to restore a disabled installation")
    support.mkdir(parents=True, exist_ok=True, mode=0o700)
    agent.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    target.chmod(0o700)
    temporary = None
    try:
        data = plistlib.dumps({
            "Label": LABEL,
            "ProgramArguments": [str(target)],
            "RunAtLoad": True,
            "KeepAlive": True,
            "ThrottleInterval": 10,
            "LimitLoadToSessionType": "Aqua",
            "ProcessType": "Background",
            "StandardOutPath": str(support / "launcher.log"),
            "StandardErrorPath": str(support / "launcher-error.log"),
        })
        with tempfile.NamedTemporaryFile(dir=agent.parent, prefix=".claude-pet-launcher-", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.chmod(0o644)
        os.replace(temporary, agent)
    except OSError:
        target.unlink(missing_ok=True)
        if temporary is not None:
            temporary.unlink(missing_ok=True)
        raise
    if enable:
        result = subprocess.run(["/bin/launchctl", "bootstrap", "gui/" + str(os.getuid()), str(agent)])
        if result.returncode:
            print("Files were installed, but activation failed. Inspect the launchctl error; disable-autostart.sh reverses the startup entry", file=sys.stderr)
            return agent, False
    return agent, True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--enable", action="store_true", help="also activate the user LaunchAgent now; otherwise it starts at the next login")
    args = parser.parse_args()
    try:
        agent, success = install_launcher(args.enable)
    except (OSError, ValueError, KeyError) as error:
        print("Launcher installation stopped: " + str(error), file=sys.stderr)
        return 1
    print(agent)
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
