#!/usr/bin/env python3
"""Check tracked publication files without printing potentially sensitive content.

SPDX-License-Identifier: MIT
This is a focused guard, not a guarantee that every possible secret is detected.
It examines only this repository's tracked files and optional reachable history.
"""
from pathlib import Path
import argparse
import hashlib
import json
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PATTERNS = {
    'personal-home-path': re.compile(rb'/(?:Users|home)/[A-Za-z0-9_.-]+/'),
    'windows-user-path': re.compile(rb'[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]', re.I),
    'private-key': re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----'),
    'provider-secret': re.compile(rb'(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:ant-)?[A-Za-z0-9_-]{30,})'),
    'credential-in-url': re.compile(rb'https?://[^\s/:]+:[^\s/@]+@'),
}
FORBIDDEN_DIRS = {'.claude', '.codex', 'node_modules', 'build', 'qa', 'out', 'runtime', 'downloads', '__pycache__'}
FORBIDDEN_NAMES = {'HANDOFF.md', 'MACOS_PLAN.md', 'LOCAL_MACOS.md', 'quota.json', 'settings.json', 'config.json', 'state.json', 'original-statusline.json', 'bridge-status.json', '.env'}
FORBIDDEN_SUFFIXES = {'.png', '.webp', '.webm', '.ico', '.dmg', '.zip', '.pkg', '.pyc', '.log', '.bak', '.pem', '.key'}
INVENTORY_PATH = 'docs/ASSET-INVENTORY.json'
UPSTREAM = 'https://github.com/Mushan08/claude-chan-pet'
REVISION = '7573579a5a7ade4a853c38144f664b3abf11bbba'
EXPECTED_ASSETS = frozenset(
    ['assets/pet/' + pose + '.png' for pose in ('front', 'side', 'back')]
    + ['assets/pet/face-%02d.png' % number for number in range(1, 11)]
    + ['assets/pet/anims/' + clip + '.webm' for clip in ('hug', 'love', 'read', 'think', 'wave')]
    + ['assets/pet/manifest.json', 'assets/pet/anims/manifest.json']
)


def parse_inventory(content):
    """The inventory can pin this fixed upstream pack, never authorize new paths."""
    try:
        value = json.loads(content)
    except (ValueError, UnicodeError):
        raise ValueError('invalid-inventory-json') from None
    if not isinstance(value, dict) or set(value) != {'upstream', 'revision', 'files'}:
        raise ValueError('invalid-inventory-schema')
    if value['upstream'] != UPSTREAM or value['revision'] != REVISION:
        raise ValueError('unexpected-inventory-source')
    if not isinstance(value['files'], list) or len(value['files']) != len(EXPECTED_ASSETS):
        raise ValueError('invalid-inventory-file-count')
    entries = {}
    for entry in value['files']:
        if not isinstance(entry, dict) or set(entry) != {'path', 'bytes', 'sha256', 'gitBlob'}:
            raise ValueError('invalid-inventory-entry')
        name = entry['path']
        if not isinstance(name, str) or name not in EXPECTED_ASSETS or name in entries:
            raise ValueError('invalid-inventory-path')
        if type(entry['bytes']) is not int or entry['bytes'] <= 0:
            raise ValueError('invalid-inventory-size')
        if not isinstance(entry['sha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', entry['sha256']):
            raise ValueError('invalid-inventory-sha256')
        if not isinstance(entry['gitBlob'], str) or not re.fullmatch(r'[a-f0-9]{40}', entry['gitBlob']):
            raise ValueError('invalid-inventory-git-blob')
        entries[name] = entry
    if set(entries) != EXPECTED_ASSETS:
        raise ValueError('incomplete-inventory')
    return entries


def has_symlink(root, name):
    path = Path(name)
    return any((root.joinpath(*path.parts[:i])).is_symlink() for i in range(1, len(path.parts) + 1))


def load_inventory(root):
    if has_symlink(root, INVENTORY_PATH):
        raise ValueError('inventory-symlink')
    return parse_inventory((root / INVENTORY_PATH).read_bytes())


def content_rules(name, content, inventory):
    """Apply identical path and digest checks to working files and historical blobs."""
    rules = []
    path = Path(name)
    entry = inventory.get(name) if name in EXPECTED_ASSETS else None
    approved_media = False
    if entry is not None:
        git_blob = hashlib.sha1(b'blob ' + str(len(content)).encode('ascii') + b'\0' + content).hexdigest()
        matches = (len(content) == entry['bytes']
                   and hashlib.sha256(content).hexdigest() == entry['sha256']
                   and git_blob == entry['gitBlob'])
        if not matches:
            rules.append('inventory-content-mismatch')
        approved_media = matches and path.suffix in {'.png', '.webm'}
    if (path.is_absolute() or '..' in path.parts
            or any(part in FORBIDDEN_DIRS or part.endswith('.app') for part in path.parts)
            or path.name in FORBIDDEN_NAMES
            or (path.suffix.lower() in FORBIDDEN_SUFFIXES and not approved_media)):
        rules.append('excluded-file-category')
    if b'\0' in content and not approved_media:
        rules.append('binary-content')
    for rule, pattern in PATTERNS.items():
        if pattern.search(content):
            rules.append(rule)
    return rules


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--history', action='store_true', help='Also scan every reachable commit tree')
    args=parser.parse_args()
    tracked=[p.decode('utf-8') for p in git('ls-files','-z').split(b'\0') if p]
    if not tracked:
        raise SystemExit('No tracked files; stage the publication allowlist first.')
    findings=[]
    inventory = {}
    try:
        inventory = load_inventory(ROOT)
    except (OSError, ValueError) as error:
        # Do not include exception text, which can contain a local absolute path.
        findings.append({'file': INVENTORY_PATH, 'rule': 'invalid-or-missing-inventory'})
    for name in sorted(EXPECTED_ASSETS | {INVENTORY_PATH}):
        if name not in tracked:
            findings.append({'file': name, 'rule': 'required-asset-not-tracked'})
    for name in tracked:
        path=Path(name)
        full=ROOT/path
        if has_symlink(ROOT, name):
            findings.append({'file':name,'rule':'symlink'})
            continue
        try:
            content=full.read_bytes()
        except OSError:
            findings.append({'file':name,'rule':'unreadable-file'})
            continue
        findings.extend({'file':name,'rule':rule} for rule in content_rules(name, content, inventory))
    history_blobs=0
    if args.history:
        seen=set(); blobs=set()
        for commit in git('rev-list','--all').splitlines():
            for line in git('ls-tree','-rz',commit.decode()).split(b'\0'):
                if not line: continue
                metadata,_,name=line.partition(b'\t')
                mode,kind,blob=metadata.split()
                if kind!=b'blob' or (name, blob) in seen: continue
                seen.add((name, blob)); blobs.add(blob)
                label = {'historyBlob':blob.decode(),'file':name.decode('utf-8')}
                if mode == b'120000':
                    findings.append({**label, 'rule':'symlink'})
                    continue
                content=git('cat-file','blob',blob.decode())
                findings.extend({**label,'rule':rule} for rule in content_rules(name.decode('utf-8'), content, inventory))
        history_blobs=len(blobs)
    print(json.dumps({'files':len(tracked),'historyBlobs':history_blobs,'findings':findings},ensure_ascii=False,indent=2))
    return bool(findings)


if __name__=='__main__': sys.exit(main())
