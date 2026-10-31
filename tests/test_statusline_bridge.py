"""Synthetic, temporary-directory tests. Never use the user's Claude configuration."""
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest

MACOS = Path(__file__).resolve().parents[1] / "macos"
sys.path.insert(0, str(MACOS))


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, MACOS / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


bridge = module("statusline_bridge", "statusline_bridge.py")
installer = module("install_statusline", "install-statusline.py")
uninstaller = module("uninstall_statusline", "uninstall-statusline.py")


def payload(five=30, week=70, reset=1900000000, **extra):
    value = {"rate_limits": {}}
    if five is not None:
        value["rate_limits"]["five_hour"] = {"used_percentage": five, "resets_at": reset}
    if week is not None:
        value["rate_limits"]["seven_day"] = {"used_percentage": week, "resets_at": reset + 86400}
    value.update(extra)
    return json.dumps(value).encode()


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        self.root = self.home / "data"
        self.settings = self.home / ".claude" / "settings.json"

    def tearDown(self):
        self.temp.cleanup()

    def read(self, name="quota.json"):
        return json.loads((self.root / name).read_text())

    def apply(self, raw, order=10):
        return bridge.record_quota(raw, self.root, received_ns=order)

    def install(self, settings=None):
        if settings is not None:
            self.settings.parent.mkdir(parents=True, exist_ok=True)
            self.settings.write_text(json.dumps(settings, indent=1) + "\n\n")
        return installer.install(self.settings, self.root)

    def test_allowlist_zero_hundred_and_no_raw_secret_on_disk(self):
        self.assertTrue(self.apply(payload(0, 100, transcript_path="SECRET", session_id="SECRET")))
        value = self.read()
        self.assertEqual(set(value), {"source", "updatedAt", "windows"})
        self.assertEqual(value["source"], "claude-code-statusline")
        self.assertEqual(value["windows"]["fiveHour"]["usedPercent"], 0)
        self.assertEqual(value["windows"]["sevenDay"]["usedPercent"], 100)
        self.assertEqual(set(value["windows"]["fiveHour"]), {"usedPercent", "resetsAt"})
        for file in self.root.rglob("*"):
            if file.is_file():
                self.assertNotIn(b"SECRET", file.read_bytes())
                self.assertEqual(file.stat().st_mode & 0o777, 0o600)

    def test_missing_windows_records_unknown(self):
        self.apply(payload())
        self.assertTrue(self.apply(b'{"unrelated":"SECRET"}', 20))
        self.assertEqual(self.read()["windows"], {})
        self.assertTrue(self.apply(payload(five=None), 30))
        self.assertEqual(set(self.read()["windows"]), {"sevenDay"})

    def test_malformed_or_oversized_does_not_replace_valid(self):
        self.apply(payload())
        before = (self.root / "quota.json").read_bytes()
        invalid = [b"{", b"[]", b"null", b'{"rate_limits": []}',
                   b'{"rate_limits":{"five_hour":{}}}',
                   payload(True), payload(-1), payload(101), payload(float("nan")),
                   payload("30"), payload(reset=True), payload(reset=float("inf")),
                   b" " * (bridge.MAX_INPUT_BYTES + 1)]
        for raw in invalid:
            with self.subTest(raw=raw[:80]):
                self.assertFalse(self.apply(raw, 20))
                self.assertEqual((self.root / "quota.json").read_bytes(), before)

    def test_expired_percentages_are_not_automatically_reset(self):
        self.apply(payload(82, 95, reset=1000))
        self.assertEqual(self.read()["windows"]["fiveHour"]["usedPercent"], 82)
        self.assertTrue(self.read()["windows"]["fiveHour"]["resetsAt"].startswith("1970-"))

    def test_repeated_payload_preserves_timestamp_and_bytes(self):
        self.apply(payload(), 10)
        before = (self.root / "quota.json").read_bytes()
        self.assertFalse(self.apply(payload(30.0, 70.0, unrelated="SECRET"), 30))
        self.assertEqual((self.root / "quota.json").read_bytes(), before)
        self.assertFalse(self.apply(payload(1, 2), 20))
        self.assertEqual((self.root / "quota.json").read_bytes(), before)

    def test_out_of_order_arrival_cannot_overwrite_newer(self):
        self.apply(payload(55), 200)
        self.assertFalse(self.apply(payload(10), 100))
        self.assertEqual(self.read()["windows"]["fiveHour"]["usedPercent"], 55)

    def test_install_absent_settings_no_fictional_backup(self):
        result = self.install()
        current = json.loads(self.settings.read_text())
        self.assertEqual(current["statusLine"]["type"], "command")
        self.assertEqual(current["statusLine"]["command"], result["command"])
        original = self.read("usage/original-statusline.json")
        self.assertFalse(original["settingsExisted"])
        self.assertFalse(original["statusLineExisted"])
        self.assertIsNone(original["backupFile"])
        self.assertFalse(list((self.root / "usage").glob("settings-backup-*")))
        self.assertTrue(self.read("bridge-status.json")["configured"])
        self.assertEqual(self.settings.stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.root / "quota.json").exists())

    def test_preserve_original_subtree_and_complete_backup(self):
        original = {"statusLine": {"type": "command", "command": "printf original", "padding": 2,
                                   "refreshInterval": 17, "custom": {"keep": True}},
                    "permissions": {"allow": ["Read"]}, "unknown": [1, 2]}
        self.settings.parent.mkdir(parents=True)
        raw = json.dumps(original, indent=1).encode() + b"\n\n"
        self.settings.write_bytes(raw)
        result = self.install()
        installed = json.loads(self.settings.read_text())
        self.assertEqual(installed["permissions"], original["permissions"])
        self.assertEqual(installed["statusLine"]["refreshInterval"], 17)
        snapshot = self.read("usage/original-statusline.json")
        self.assertEqual(snapshot["statusLine"], original["statusLine"])
        backup = self.root / "usage" / snapshot["backupFile"]
        self.assertEqual(backup.read_bytes(), raw)
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        self.assertTrue(installer.install(self.settings, self.root)["alreadyConfigured"])
        self.assertEqual(self.read("usage/original-statusline.json"), snapshot)
        self.assertEqual(result["command"], installed["statusLine"]["command"])

    def test_reject_noncommand_without_changing_settings(self):
        self.settings.parent.mkdir(parents=True)
        raw = b'{"statusLine":{"type":"other","command":"untouched"},"x":1}\n'
        self.settings.write_bytes(raw)
        with self.assertRaises(ValueError):
            self.install()
        self.assertEqual(self.settings.read_bytes(), raw)
        self.assertFalse((self.root / "bridge-status.json").exists())

    def test_original_bytes_stdout_stderr_and_exit_compatibility(self):
        original_script = self.home / "original.py"
        original_script.write_text("import sys\nsys.stdout.buffer.write(sys.stdin.buffer.read())\nsys.stderr.write('ORIGINAL STDERR')\nsys.exit(7)\n")
        command = shlex.join([sys.executable, str(original_script)])
        self.install({"statusLine": {"type": "command", "command": command}})
        raw = payload(secret="SECRET") + b"\n\n"
        run = subprocess.run([sys.executable, str(self.root / "usage/statusline_bridge.py")],
                             input=raw, capture_output=True)
        self.assertEqual(run.returncode, 7)
        self.assertEqual(run.stdout, raw)
        self.assertEqual(run.stderr, b"ORIGINAL STDERR")
        for file in self.root.rglob("*"):
            if file.is_file():
                self.assertNotIn(b"SECRET", file.read_bytes())

    def test_oversized_input_still_streams_unchanged_to_original(self):
        self.install({"statusLine": {"type": "command", "command": "/bin/cat"}})
        raw = b"x" * (bridge.MAX_INPUT_BYTES * 3)
        run = subprocess.run([sys.executable, str(self.root / "usage/statusline_bridge.py")],
                             input=raw, capture_output=True)
        self.assertEqual((run.returncode, run.stdout, run.stderr), (0, raw, b""))
        self.assertFalse((self.root / "quota.json").exists())

    def test_uninstall_restores_subtree_and_retains_later_other_changes(self):
        original = {"type": "command", "command": "printf original", "padding": 3}
        self.install({"statusLine": original, "old": True})
        current = json.loads(self.settings.read_text())
        current["later"] = {"keep": True}
        self.settings.write_text(json.dumps(current))
        self.assertTrue(uninstaller.uninstall(self.settings, self.root)["restored"])
        restored = json.loads(self.settings.read_text())
        self.assertEqual(restored, {"statusLine": original, "old": True, "later": {"keep": True}})
        self.assertFalse(self.read("bridge-status.json")["configured"])

    def test_uninstall_does_not_clobber_replaced_command(self):
        self.install()
        raw = b'{"statusLine":{"type":"command","command":"later-user-command"},"later":1}\n'
        self.settings.write_bytes(raw)
        result = uninstaller.uninstall(self.settings, self.root)
        self.assertFalse(result["restored"])
        self.assertEqual(self.settings.read_bytes(), raw)

    def test_uninstall_original_absence_preserves_later_keys(self):
        self.install()
        current = json.loads(self.settings.read_text())
        current["later"] = 1
        self.settings.write_text(json.dumps(current))
        uninstaller.uninstall(self.settings, self.root)
        self.assertEqual(json.loads(self.settings.read_text()), {"later": 1})

    def test_uninstall_returns_empty_created_settings_to_absence(self):
        self.install()
        uninstaller.uninstall(self.settings, self.root)
        self.assertFalse(self.settings.exists())

    def test_symlink_settings_refused_without_touching_target(self):
        target = self.home / "other.json"
        target.write_text('{"keep":true}')
        self.settings.parent.mkdir(parents=True)
        self.settings.symlink_to(target)
        with self.assertRaises((ValueError, OSError)):
            self.install()
        self.assertEqual(target.read_text(), '{"keep":true}')


if __name__ == "__main__":
    unittest.main()
