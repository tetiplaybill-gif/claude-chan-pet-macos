import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const script = fs.readFileSync(new URL('../src/renderer/quota-popup.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../src/renderer/quota-popup.html', import.meta.url), 'utf8');
const now = Date.parse('2026-10-30T16:30:00Z');
class FixedDate extends Date { static now() { return now; } }

function setup({ pending = true, reject = false } = {}) {
  const elements = new Map();
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) elements.set(id, {
    textContent: '', className: '', title: '', events: {},
    classList: { toggle() {}, remove() {}, add() {} },
    addEventListener(name, fn) { this.events[name] = fn; },
    set innerHTML(_) { throw new Error('Renderer must use plain text'); },
  });
  const events = {}, actions = [];
  let notify, timer, unsubscribed = false;
  const api = {
    status: () => reject ? Promise.reject(new Error('Synthetic load failure')) : pending ? new Promise(() => {}) : Promise.resolve({ connection: 'missing' }),
    onUpdate: (callback) => { notify = callback; return () => { unsubscribed = true; }; },
    action: async (action) => { actions.push(action); },
  };
  const context = vm.createContext({
    document: { getElementById: (id) => elements.get(id) },
    window: { petQuota: api, addEventListener(name, callback) { events[name] = callback; } },
    Date: FixedDate, setInterval: (callback) => { timer = callback; return 1; }, clearInterval() {},
  });
  vm.runInContext(script, context);
  return { get: (id) => elements.get(id), update: (quota) => notify(quota), timer: () => timer(),
    events, actions, unsubscribed: () => unsubscribed };
}

const sample = (connection = 'connected', source = 'claude-code-statusline') => ({
  connection, source, label: source === 'claude-official-usage-page' ? '官方用量页 · 手动快照' : 'Code 最近上报',
  updatedAt: new Date(now - 60000).toISOString(),
  windows: {
    fiveHour: { usedPercent: 25, resetsAt: new Date(now + 3600000).toISOString() },
    sevenDay: { usedPercent: 40, resetsAt: new Date(now + 86400000).toISOString() },
  },
});

test('connected popup displays remaining percentages and sample timestamp', () => {
  const ui = setup(); ui.update(sample());
  assert.equal(ui.get('session-value').textContent, '75%');
  assert.equal(ui.get('week-value').textContent, '60%');
  assert.equal(ui.get('session-unit').textContent, '剩余');
  assert.match(ui.get('quota-time').textContent, /^采集于 /);
  assert.equal(ui.get('quota-badge').textContent, '最近采样');
});

test('manual popup retains current-session/week semantics without inferred reset time', () => {
  const ui = setup(), quota = sample('connected', 'claude-official-usage-page');
  quota.windows.fiveHour = { usedPercent: 0, resetsAt: null, resetText: 'Starts with your first message' };
  quota.windows.sevenDay = { usedPercent: 30, resetsAt: null, resetText: 'Resets Thursday 6:00 AM' };
  ui.update(quota);
  assert.equal(ui.get('session-title').textContent, '当前会话');
  assert.equal(ui.get('week-title').textContent, '本周');
  assert.equal(ui.get('session-value').textContent, '100%');
  assert.equal(ui.get('week-value').textContent, '70%');
  assert.equal(ui.get('session-reset').textContent, 'Starts with your first message');
  assert.equal(ui.get('week-reset').textContent, 'Resets Thursday 6:00 AM');
  assert.equal(ui.get('quota-source').textContent, '官方用量页 · 手动快照');
  assert.equal(ui.get('quota-badge').textContent, '手动快照');
  assert.match(ui.get('quota-note').textContent, /不会自动刷新/);
});

test('stale data is explicitly a prior remaining value', () => {
  const ui = setup(); ui.update(sample('stale'));
  assert.equal(ui.get('session-value').textContent, '75%');
  assert.equal(ui.get('session-unit').textContent, '上次剩余');
  assert.equal(ui.get('quota-badge').textContent, '数据较旧');
  const quota = sample(); quota.updatedAt = new Date(now - 11 * 60000).toISOString();
  ui.update(quota);
  assert.equal(ui.get('quota-badge').textContent, '数据较旧');
});

test('missing and disconnected data never become 100 percent', () => {
  const ui = setup();
  for (const connection of ['missing', 'disconnected']) {
    ui.update(sample(connection));
    assert.equal(ui.get('session-value').textContent, '—');
    assert.equal(ui.get('week-value').textContent, '—');
  }
});

test('expired snapshots remain empty and do not infer replenishment', () => {
  const ui = setup(); ui.update(sample('expired'));
  assert.equal(ui.get('session-value').textContent, '—');
  assert.equal(ui.get('week-value').textContent, '—');
  assert.equal(ui.get('quota-badge').textContent, '等待更新');
});

test('each window may be missing or elapsed independently', () => {
  const ui = setup(), quota = sample();
  delete quota.windows.sevenDay;
  ui.update(quota);
  assert.equal(ui.get('session-value').textContent, '75%');
  assert.equal(ui.get('week-value').textContent, '—');
  assert.equal(ui.get('quota-badge').textContent, '部分数据');
  quota.windows.sevenDay = sample().windows.sevenDay;
  quota.windows.fiveHour.resetsAt = new Date(now - 1000).toISOString();
  ui.update(quota);
  assert.equal(ui.get('session-value').textContent, '—');
  assert.equal(ui.get('week-value').textContent, '60%');
  assert.equal(ui.get('quota-badge').textContent, '部分待更新');
});

test('invalid percentages stay empty and external text stays literal', () => {
  const ui = setup(), quota = sample();
  quota.label = '<img src=x onerror=evil()>';
  for (const usedPercent of [true, '25', NaN, Infinity, -1, 101]) {
    quota.windows.fiveHour.usedPercent = usedPercent;
    ui.update(quota);
    assert.equal(ui.get('session-value').textContent, '—');
  }
  assert.equal(ui.get('quota-source').textContent, '<img src=x onerror=evil()>');
});

test('close, settings and Escape send only the documented actions', async () => {
  const ui = setup();
  await ui.get('hide-button').events.click();
  await ui.get('settings-button').events.click();
  let prevented = false;
  ui.events.keydown({ key: 'Escape', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(ui.actions, ['hide', 'settings', 'hide']);
  ui.events.beforeunload();
  assert.equal(ui.unsubscribed(), true);
});

test('load failure displays missing data and cannot claim a full balance', async () => {
  const ui = setup({ reject: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ui.get('session-value').textContent, '—');
  assert.equal(ui.get('week-value').textContent, '—');
  assert.match(ui.get('quota-note').textContent, /暂时无法读取/);
});

test('preload rejects unknown actions without invoking IPC', async () => {
  let exposed;
  const calls = [];
  const electron = { contextBridge: { exposeInMainWorld(_name, value) { exposed = value; } },
    ipcRenderer: { invoke: async (...args) => { calls.push(args); }, on() {}, removeListener() {} } };
  vm.runInNewContext(fs.readFileSync(new URL('../src/preload-quota.cjs', import.meta.url), 'utf8'), {
    require: (name) => { assert.equal(name, 'electron'); return electron; },
  });
  await assert.rejects(exposed.action('arbitrary-channel'));
  assert.deepEqual(calls, []);
  await exposed.action('hide'); await exposed.action('settings'); await exposed.status();
  assert.deepEqual(calls, [['quota:action', 'hide'], ['quota:action', 'settings'], ['quota:status']]);
});
