"""Synthetic media and temporary paths; no Git mutations or user data access."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'audit-publication.py'
SPEC = importlib.util.spec_from_file_location('publication_audit', SCRIPT)
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


def record(name, content):
    header = b'blob ' + str(len(content)).encode('ascii') + b'\0'
    return {'path': name, 'bytes': len(content),
            'sha256': hashlib.sha256(content).hexdigest(),
            'gitBlob': hashlib.sha1(header + content).hexdigest()}


def fixture():
    samples = {name: (b'synthetic\0media:' + name.encode('ascii')
                      if name.endswith(('.png', '.webm')) else b'{"synthetic":true}\n')
               for name in audit.EXPECTED_ASSETS}
    value = {'upstream': audit.UPSTREAM, 'revision': audit.REVISION,
             'files': [record(name, content) for name, content in sorted(samples.items())]}
    return value, samples


class PublicationAuditTests(unittest.TestCase):
    def setUp(self):
        self.value, self.samples = fixture()
        self.inventory = audit.parse_inventory(json.dumps(self.value))

    def test_exact_pinned_media_and_manifests_are_allowed(self):
        for name, content in self.samples.items():
            with self.subTest(name=name):
                self.assertEqual(audit.content_rules(name, content, self.inventory), [])

    def test_mutated_media_cannot_use_binary_exception(self):
        for name in ('assets/pet/front.png', 'assets/pet/anims/read.webm'):
            with self.subTest(name=name):
                rules = audit.content_rules(name, self.samples[name] + b'x', self.inventory)
                self.assertIn('inventory-content-mismatch', rules)
                self.assertIn('excluded-file-category', rules)
                self.assertIn('binary-content', rules)

    def test_mutated_manifest_is_rejected(self):
        name = 'assets/pet/anims/manifest.json'
        self.assertIn('inventory-content-mismatch', audit.content_rules(name, b'{}', self.inventory))

    def test_unknown_png_stays_forbidden_even_with_known_content(self):
        rules = audit.content_rules('assets/pet/extra.png', self.samples['assets/pet/front.png'], self.inventory)
        self.assertIn('excluded-file-category', rules)
        self.assertIn('binary-content', rules)

    def test_missing_inventory_never_allows_media(self):
        self.assertIn('excluded-file-category', audit.content_rules('assets/pet/front.png', b'anything', {}))

    def test_inventory_cannot_authorize_arbitrary_or_traversing_paths(self):
        for path in ('assets/pet/extra.png', '../outside.png', '/outside.png', 'assets/pet/../front.png'):
            with self.subTest(path=path):
                value = copy.deepcopy(self.value)
                value['files'][0]['path'] = path
                with self.assertRaises(ValueError):
                    audit.parse_inventory(json.dumps(value))

    def test_inventory_rejects_duplicates_missing_entries_and_wrong_provenance(self):
        duplicate = copy.deepcopy(self.value)
        duplicate['files'][0] = copy.deepcopy(duplicate['files'][1])
        missing = copy.deepcopy(self.value)
        missing['files'].pop()
        wrong_source = dict(self.value, upstream='https://example.invalid/assets')
        wrong_revision = dict(self.value, revision='0' * 40)
        for value in (duplicate, missing, wrong_source, wrong_revision):
            with self.assertRaises(ValueError):
                audit.parse_inventory(json.dumps(value))

    def test_inventory_rejects_malformed_sizes_and_hashes(self):
        for key, value in (('bytes', True), ('bytes', -1), ('sha256', 'bad'), ('gitBlob', '0' * 39)):
            invalid = copy.deepcopy(self.value)
            invalid['files'][0][key] = value
            with self.assertRaises(ValueError):
                audit.parse_inventory(json.dumps(invalid))

    def test_git_blob_digest_is_checked_independently(self):
        name = 'assets/pet/front.png'
        inventory = copy.deepcopy(self.inventory)
        inventory[name]['gitBlob'] = '0' * 40
        self.assertIn('inventory-content-mismatch', audit.content_rules(name, self.samples[name], inventory))

    def test_media_exception_does_not_skip_private_content_rules(self):
        name = 'assets/pet/front.png'
        synthetic_path = b'/Users/' + b'synthetic/private'
        content = b'\0' + synthetic_path
        inventory = {name: record(name, content)}
        self.assertIn('personal-home-path', audit.content_rules(name, content, inventory))

    def test_symlinked_inventory_or_parent_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            other = root / 'actual'
            other.mkdir()
            (other / 'ASSET-INVENTORY.json').write_text(json.dumps(self.value))
            (root / 'docs').symlink_to(other, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'inventory-symlink'):
                audit.load_inventory(root)

    def test_private_and_unrelated_artifacts_remain_forbidden(self):
        for name in ('quota.json', 'build/example.app/file', '.env', 'assets/source/source.webp', 'logs/private.log'):
            with self.subTest(name=name):
                self.assertIn('excluded-file-category', audit.content_rules(name, b'plain', self.inventory))


if __name__ == '__main__':
    unittest.main()
