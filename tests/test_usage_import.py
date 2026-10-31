"""Manual-import tests use invented samples and temporary directories only."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

MACOS = Path(__file__).resolve().parents[1] / "macos"
sys.path.insert(0, str(MACOS))
spec = importlib.util.spec_from_file_location("usage_import", MACOS / "import-usage-snapshot.py")
usage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(usage)
from statusline_bridge import record_quota

NOW = 1800000000.0


class UsageImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "appdata"
        self.output = self.root / "quota.json"

    def tearDown(self):
        self.temp.cleanup()

    def save(self, **kwargs):
        kwargs.setdefault("now", NOW)
        return usage.import_snapshot(self.output, **kwargs)

    def read(self):
        return json.loads(self.output.read_text())

    def test_zero_and_hundred_have_unknown_reset_instant(self):
        self.assertTrue(self.save(five_hour=0, week=100,
                                  week_reset_text="Resets next week at a displayed local time"))
        value = self.read()
        self.assertEqual(set(value), {"source", "updatedAt", "windows"})
        self.assertEqual(value["source"], "claude-official-usage-page")
        self.assertEqual(value["windows"]["fiveHour"], {"usedPercent": 0, "resetsAt": None, "resetText": ""})
        self.assertEqual(value["windows"]["sevenDay"]["usedPercent"], 100)
        self.assertIsNone(value["windows"]["sevenDay"]["resetsAt"])

    def test_only_supplied_window_is_stored(self):
        self.save(week=41.5)
        self.assertEqual(set(self.read()["windows"]), {"sevenDay"})
        self.assertEqual(self.read()["windows"]["sevenDay"]["usedPercent"], 41.5)

    def test_at_least_one_percent_and_finite_range_required(self):
        invalid = [{}, {"five_hour": True}, {"five_hour": -1}, {"week": 101},
                   {"week": float("nan")}, {"five_hour": float("inf")},
                   {"five_hour": "25"}, {"week": 25, "five_reset_text": "orphan"}]
        for kwargs in invalid:
            with self.subTest(kwargs=kwargs):
                with self.assertRaises(ValueError):
                    self.save(**kwargs)
                self.assertFalse(self.output.exists())

    def test_reset_text_rejects_markup_controls_bidi_and_more_than_120(self):
        for text in ["<b>reset</b>", "＜b＞reset＜/b＞", "one\ntwo", "one\ttwo", "\u202esecret", "x" * 121]:
            with self.subTest(text=repr(text)):
                with self.assertRaises(ValueError):
                    self.save(week=23, week_reset_text=text)
        self.save(five_hour=19, five_reset_text="x" * 120)
        self.assertEqual(len(self.read()["windows"]["fiveHour"]["resetText"]), 120)

    def test_explicit_zoned_sample_time_is_retained_and_normalized(self):
        self.save(five_hour=17, sampled_at="2027-01-15T09:00:00+08:00")
        self.assertEqual(self.read()["updatedAt"], "2027-01-15T01:00:00.000Z")

    def test_future_naive_and_malformed_times_are_rejected(self):
        for sampled in [usage.iso_time(NOW + 1), "2027-01-15T09:00:00", "tomorrow", "2027-99-99T00:00:00Z"]:
            with self.subTest(sampled=sampled):
                with self.assertRaises(ValueError):
                    self.save(five_hour=17, sampled_at=sampled)
                self.assertFalse(self.output.exists())

    def test_newer_existing_sample_and_equal_time_conflict_are_preserved(self):
        self.save(five_hour=17)
        before = self.output.read_bytes()
        with self.assertRaises(ValueError):
            self.save(five_hour=9, sampled_at=usage.iso_time(NOW - 10))
        with self.assertRaises(ValueError):
            self.save(five_hour=9)
        self.assertFalse(self.save(five_hour=17))
        self.assertEqual(self.output.read_bytes(), before)

    def test_refuses_newer_other_source_and_unreadable_existing_timestamp(self):
        self.root.mkdir(parents=True)
        other = {"source": "claude-code-statusline", "updatedAt": usage.iso_time(NOW + 10), "windows": {}}
        self.output.write_text(json.dumps(other))
        with self.assertRaises(ValueError):
            self.save(week=23)
        self.assertEqual(self.read(), other)
        self.output.write_text('{"updatedAt":"unknown"}')
        with self.assertRaises(ValueError):
            self.save(week=23)
        self.assertEqual(self.output.read_text(), '{"updatedAt":"unknown"}')

    def test_atomic_replacement_is_private_and_keeps_no_snapshot_backup(self):
        self.save(five_hour=17)
        self.output.chmod(0o644)
        self.save(five_hour=18, now=NOW + 1)
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o600)
        self.assertEqual(set(p.name for p in self.root.iterdir()), {"quota.json", "usage"})
        self.assertFalse(list(self.root.rglob("*backup*")))
        self.assertFalse(list(self.root.rglob(".quota.json.*")))

    def test_symlink_output_is_refused(self):
        self.root.mkdir(parents=True)
        target = Path(self.temp.name) / "untouched.json"
        target.write_text("untouched")
        self.output.symlink_to(target)
        with self.assertRaises((ValueError, OSError)):
            self.save(five_hour=17)
        self.assertEqual(target.read_text(), "untouched")

    def test_queued_older_statusline_sample_cannot_replace_manual_snapshot(self):
        self.save(five_hour=17)
        raw = b'{"rate_limits":{"five_hour":{"used_percentage":1,"resets_at":1900000000}}}'
        self.assertFalse(record_quota(raw, self.root, received_ns=int((NOW - 1) * 1e9)))
        self.assertEqual(self.read()["source"], "claude-official-usage-page")

    def test_cli_writes_only_explicit_test_output_and_reports_no_sample_values(self):
        result = subprocess.run(["/usr/bin/python3", str(MACOS / "import-usage-snapshot.py"),
                                 "--five-hour", "17.5", "--output", str(self.output)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"imported": True,
                         "source": "claude-official-usage-page", "windowCount": 1})
        self.assertEqual(self.read()["windows"]["fiveHour"]["usedPercent"], 17.5)


if __name__ == "__main__":
    unittest.main()
