#!/bin/zsh
# Only launches two local fixture apps created in this checkout's build/qa.
# Does not launch, terminate, or inspect any real Claude session.
set -eu
unsetopt bgnice
script_dir=${0:A:h}
source_dir=${script_dir:h}
qa_dir="$source_dir/build/qa/launcher"
runtime_dir="$source_dir/build/launcher-tests"
mkdir -p "$qa_dir" "$runtime_dir"
/usr/bin/swiftc -module-cache-path "$runtime_dir/swift-cache" -o "$runtime_dir/ClaudePetLauncher" "$script_dir/ClaudePetLauncher.swift"
/usr/bin/swiftc -module-cache-path "$runtime_dir/swift-cache" -o "$runtime_dir/LauncherFixture" "$script_dir/LauncherFixture.swift"
python3 - "$qa_dir" "$runtime_dir/LauncherFixture" <<'PY'
import pathlib, plistlib, shutil, sys
root = pathlib.Path(sys.argv[1])
for name, lifetime in [('host', 25.0), ('pet', 6.0)]:
    app = root / (name + '.app') / 'Contents'
    (app / 'MacOS').mkdir(parents=True, exist_ok=True)
    shutil.copy2(sys.argv[2], app / 'MacOS/LauncherFixture')
    (app / 'Info.plist').write_bytes(plistlib.dumps({
        'CFBundleIdentifier': 'local.claudechan.fixture.public.' + name,
        'CFBundleName': 'ClaudePet QA ' + name,
        'CFBundleExecutable': 'LauncherFixture',
        'CFBundlePackageType': 'APPL',
        'CFBundleShortVersionString': '1.0',
        'CFBundleVersion': '1',
        'LSUIElement': True,
        'FixtureLifetime': lifetime,
    }))
PY
args=(--test-host-bundle local.claudechan.fixture.public.host --test-host-path "$qa_dir/host.app" --pet-bundle local.claudechan.fixture.public.pet --pet-path "$qa_dir/pet.app")
"$runtime_dir/ClaudePetLauncher" --test-geometry > "$qa_dir/geometry-tests.json"
python3 - "$runtime_dir/ClaudePetLauncher" "$qa_dir" "${args[@]}" <<'PY'
import json, pathlib, subprocess, sys
launcher, qa, *args = sys.argv[1:]
state = pathlib.Path(qa) / 'companion-state.json'
before = (state.read_bytes(), state.stat().st_mtime_ns) if state.exists() else None
result = subprocess.run([launcher, '--check', *args], text=True, capture_output=True, check=True)
assert isinstance(json.loads(result.stdout)['fullscreen'], bool)
after = (state.read_bytes(), state.stat().st_mtime_ns) if state.exists() else None
assert before == after, '--check must not write companion state'
PY
"$runtime_dir/ClaudePetLauncher" "${args[@]}" > "$qa_dir/watcher.jsonl" 2> "$qa_dir/watcher.stderr" &
watcher_pid=$!
trap 'kill "$watcher_pid" 2>/dev/null || true' EXIT
python3 - "$runtime_dir/ClaudePetLauncher" "$qa_dir" "${args[@]}" <<'PY'
import datetime, json, pathlib, subprocess, sys, time
launcher, qa, *args = sys.argv[1:]
qa = pathlib.Path(qa)
def check():
    result = subprocess.run([launcher, '--check', *args], text=True, capture_output=True, check=True)
    return json.loads(result.stdout)
def wait_for(fn, label, timeout=10):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = fn()
        if value: return value
        time.sleep(.15)
    raise AssertionError(label)
def events():
    return [json.loads(line) for line in (qa / 'watcher.jsonl').read_text().splitlines()]
def companion_state():
    value = json.loads((qa / 'companion-state.json').read_text())
    assert set(value) == {'fullscreen', 'updatedAt'}, value
    assert isinstance(value['fullscreen'], bool), value
    datetime.datetime.fromisoformat(value['updatedAt'].replace('Z', '+00:00'))
    return value
wait_for(lambda: any(e['event']=='watching' for e in events()), 'watcher ready')
wait_for(lambda: (qa / 'companion-state.json').exists(), 'companion state published')
watching_at = datetime.datetime.fromisoformat(next(e['time'] for e in events() if e['event']=='watching').replace('Z', '+00:00'))
wait_for(lambda: datetime.datetime.fromisoformat(companion_state()['updatedAt'].replace('Z', '+00:00')) >= watching_at, 'fresh companion state')
initial_state_time = datetime.datetime.fromisoformat(companion_state()['updatedAt'].replace('Z', '+00:00'))
subprocess.run(['/usr/bin/open', '-g', str(qa/'host.app')], check=True)
first = wait_for(lambda: check()['petPIDs'], 'pet follows fixture host launch')
assert len(first) == 1, first
subprocess.run([launcher, '--once', *args], check=True, capture_output=True)
subprocess.run(['/usr/bin/open', '-g', str(qa/'pet.app')], check=True)
subprocess.run(['/usr/bin/open', '-g', str(qa/'pet.app')], check=True)
time.sleep(.5)
assert check()['petPIDs'] == first, 'duplicate instance created'
assert any(e.get('reason') in ['host-launched', 'host-started-poll'] and e['event']=='pet-opened' for e in events()), events()
wait_for(lambda: not check()['petPIDs'], 'fixture pet exits by own timer', 10)
time.sleep(1.5)
assert not check()['petPIDs'], 'pet should remain closed while host state is unchanged'
# A launcher starting while its host is already running must also open the pet.
initial_run = subprocess.run([launcher, '--once', *args], check=True, capture_output=True, text=True)
initial_events = [json.loads(line) for line in initial_run.stdout.splitlines()]
assert any(e['event']=='pet-opened' and e.get('reason')=='initial-check' for e in initial_events), initial_events
initial_pid = check()['petPIDs']
assert len(initial_pid) == 1 and initial_pid != first, (first, initial_pid)
wait_for(lambda: not check()['petPIDs'], 'second fixture pet exits by own timer', 10)
# Activation of the already-running fixture host should restore the pet.
subprocess.run(['/usr/bin/open', str(qa/'host.app')], check=True)
second = wait_for(lambda: check()['petPIDs'], 'pet restored on fixture host activation')
assert len(second) == 1 and second != first, (first, second)
assert any(e.get('reason') in ['host-activated', 'host-activated-poll'] and e['event']=='pet-opened' for e in events()), events()
# Repeated JSON parsing also detects any partial/non-atomic state-file writes.
def heartbeat_arrived():
    updated = datetime.datetime.fromisoformat(companion_state()['updatedAt'].replace('Z', '+00:00'))
    return (updated - initial_state_time).total_seconds() >= 30
wait_for(heartbeat_arrived, '30-second companion state heartbeat', 35)
report = {'passed': True, 'launch_follow': True, 'duplicate_prevented': True,
          'initial_host_already_running': True, 'exit_restore': True, 'manual_quit_respected': True,
          'companion_schema': True, 'companion_heartbeat': True, 'check_does_not_write': True,
          'geometry_tests': json.loads((qa/'geometry-tests.json').read_text()),
          'firstPID': first[0], 'initialCheckPID': initial_pid[0], 'restoredPID': second[0],
          'realClaudeTouched': False, 'events': events()}
(qa/'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
print(json.dumps(report, ensure_ascii=False))
PY
