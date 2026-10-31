#!/usr/bin/env python3
"""Build a local app from source plus pinned Electron; never download or install."""
import argparse
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile

from build_support import (SOURCE, BUILD, BUNDLE_ID, ELECTRON_VERSION, ELECTRON_ARCHIVE_SHA256, ELECTRON_TREE_SHA256,
                           build_launcher, electron_runtime, require_platform)


def package_app():
    require_platform()
    runtime = electron_runtime()
    destination = BUILD / "ClaudeChanPet.app"
    if destination.exists() or destination.is_symlink():
        raise ValueError("Refusing to overwrite build/ClaudeChanPet.app; move the previous build aside first")
    # Reviewed repository-local generator; preserves existing user assets.
    subprocess.run([sys.executable, str(SOURCE / "scripts/generate-placeholder.py")], check=True)
    if not (SOURCE / "assets/pet/front.png").is_file():
        raise ValueError("Missing assets/pet/front.png after placeholder preparation")
    build_launcher()
    BUILD.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".app-build-", dir=BUILD) as temporary:
        staged = Path(temporary) / "ClaudeChanPet.app"
        shutil.copytree(runtime, staged, symlinks=True)
        contents = staged / "Contents"
        resources = contents / "Resources"
        app = resources / "app"
        app.mkdir()
        ignore = shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store", ".env", ".env.*", "*.log")
        for name in ["src", "docs"]:
            if (SOURCE / name).is_dir():
                shutil.copytree(SOURCE / name, app / name, ignore=ignore)
        shutil.copytree(SOURCE / "assets/pet", app / "assets/pet", ignore=ignore)
        for name in ["LICENSE", "README.md", "NOTICE.md", "PRIVACY.md"]:
            if (SOURCE / name).is_file():
                shutil.copy2(SOURCE / name, app / name)
        package = json.loads((SOURCE / "package.json").read_text())
        package["scripts"] = {}
        package.pop("devDependencies", None)
        (app / "package.json").write_text(json.dumps(package, ensure_ascii=False, indent=2) + "\n")
        for name in ["LICENSE", "LICENSES.chromium.html"]:
            license_file = runtime.parent / name
            if license_file.is_file():
                shutil.copy2(license_file, resources / ("Electron-" + name))
        plist_path = contents / "Info.plist"
        info = plistlib.loads(plist_path.read_bytes())
        info.update({
            "CFBundleIdentifier": BUNDLE_ID,
            "CFBundleName": "ClaudeChanPet",
            "CFBundleDisplayName": "Claude 娘桌宠",
            "CFBundleShortVersionString": "0.1.0",
            "CFBundleVersion": "1",
            "LSUIElement": True,
            "LSMinimumSystemVersion": "13.0",
            "NSHumanReadableCopyright": "MIT: Copyright (c) 2026 MushanLuo. Local macOS adaptation.",
        })
        for key in ["CFBundleURLTypes", "NSCameraUsageDescription", "NSMicrophoneUsageDescription"]:
            info.pop(key, None)
        plist_path.write_bytes(plistlib.dumps(info))
        revision = None
        if (SOURCE / ".git").exists():
            result = subprocess.run(["/usr/bin/git", "rev-parse", "HEAD"], cwd=SOURCE, text=True, capture_output=True)
            if result.returncode == 0:
                revision = result.stdout.strip()
        provenance = {
            "upstream": "https://github.com/Mushan08/claude-chan-pet",
            "source_revision": revision,
            "electron": ELECTRON_VERSION,
            "electron_archive_sha256": ELECTRON_ARCHIVE_SHA256,
            "electron_tree_sha256": ELECTRON_TREE_SHA256,
            "architecture": "arm64",
            "mode": "local source build; no credentials, model API, or automatic Code hooks",
            "artwork": "Original geometric placeholder or user-supplied local assets; see NOTICE.md and docs/ASSETS.md",
            "distribution": "Local development build, ad-hoc signed, not notarized; no bundled user data",
        }
        (resources / "LOCAL-PROVENANCE.json").write_text(json.dumps(provenance, indent=2) + "\n")
        # Normal local signing after changing app resources; never remove
        # quarantine, notarize, change Gatekeeper, or suppress macOS warnings.
        # The pinned developer runtime's nested bundles also need local seals.
        # These are local ad-hoc signatures, never a publisher/notarization claim.
        subprocess.run(["/usr/bin/codesign", "--force", "--deep", "--sign", "-",
                        "--preserve-metadata=entitlements,flags", str(staged)], check=True)
        subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(staged)], check=True)
        staged.rename(destination)
    return destination


def main():
    argparse.ArgumentParser(description=__doc__).parse_args()
    try:
        print(package_app())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print("App build stopped: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
