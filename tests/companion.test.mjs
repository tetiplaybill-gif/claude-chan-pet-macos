import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizeQuota, confirmedRollovers, parsePublicRelease, OFFICIAL_USAGE_PAGE_SOURCE } from '../src/shared/companion.js';
const now = Date.parse('2026-10-30T12:00:00Z');
const sample = (updatedAt, reset, usedPercent) => normalizeQuota({ source:'claude-code-statusline', updatedAt,
  windows:{fiveHour:{usedPercent,resetsAt:reset}}, token:'MUST_NOT_PASS', session_id:'PRIVATE' }, now);
test('missing quota is never reported as 100% remaining', () => {
  assert.equal(normalizeQuota(null,now).connection,'disconnected');
  assert.deepEqual(normalizeQuota({source:'local-token-estimate'},now).windows,{});
  const value=sample('2026-10-30T11:59:00Z','2026-10-30T13:00:00Z',NaN);
  assert.equal(value.connection,'missing');
});
test('allowlist discards secrets and validates percentages', () => {
  const value=sample('2026-10-30T11:59:00Z','2026-10-30T13:00:00Z',60);
  assert.equal(value.windows.fiveHour.usedPercent,60);
  assert(!JSON.stringify(value).includes('PRIVATE')); assert(!JSON.stringify(value).includes('MUST_NOT_PASS'));
  assert.equal(sample('2026-10-30T11:59:00Z','2026-10-30T13:00:00Z',101).connection,'missing');
});
test('stale or elapsed snapshots do not imply a reset', () => {
  assert.equal(sample('2026-10-30T11:00:00Z','2026-10-30T13:00:00Z',60).connection,'stale');
  const expired=sample('2026-10-30T11:59:00Z','2026-10-30T11:59:30Z',60);
  assert.equal(expired.connection,'expired'); assert.equal(expired.windows.fiveHour.usedPercent,60);
  assert.deepEqual(confirmedRollovers(null,expired,now),[]);
});
test('each quota window expires independently', () => {
  const value = normalizeQuota({source:'claude-code-statusline', updatedAt:'2026-10-30T11:59:00Z', windows:{
    fiveHour:{usedPercent:80,resetsAt:'2026-10-30T11:59:30Z'},
    sevenDay:{usedPercent:20,resetsAt:'2026-11-03T12:00:00Z'},
  }},now);
  assert.equal(value.connection,'connected');
  assert.equal(value.windows.fiveHour.status,'expired');
  assert.equal(value.windows.sevenDay.status,'connected');
});
test('first, duplicate, future or outdated samples remain quiet', () => {
  const fresh=sample('2026-10-30T11:59:50Z','2026-10-30T17:00:00Z',2);
  assert.deepEqual(confirmedRollovers(null,fresh,now),[]);
  assert.deepEqual(confirmedRollovers(fresh,fresh,now),[]);
  const future=sample('2026-10-30T13:00:00Z','2026-10-30T17:00:00Z',2);
  assert.equal(future.connection,'missing');
});
test('only new fresh account data confirms an elapsed window rollover', () => {
  const previous=sample('2026-10-30T11:58:00Z','2026-10-30T11:59:00Z',90);
  const current=sample('2026-10-30T11:59:50Z','2026-10-30T16:59:00Z',1);
  assert.equal(confirmedRollovers(previous,current,now).length,1);
  assert.deepEqual(confirmedRollovers(current,current,now),[]);
});
test('public releases have separate IDs and never claim account reset', () => {
  const notice=parsePublicRelease('# Changelog\n## 2.1.314\n- Changes');
  assert.equal(notice.category,'release'); assert.match(notice.id,/^claude-code-release:/);
  assert.throws(()=>parsePublicRelease('garbage'));
});

const pageSample = (windows, updatedAt = '2026-10-30T11:59:00Z') => normalizeQuota({
  source: OFFICIAL_USAGE_PAGE_SOURCE, updatedAt, windows,
  account: 'DO_NOT_RETAIN', pageHTML: '<secret>DO_NOT_RETAIN</secret>',
}, now);
const visiblePageWindows = () => ({
  fiveHour: { usedPercent: 0, resetsAt: null, resetText: 'Starts with your first message' },
  sevenDay: { usedPercent: 30, resetsAt: null, resetText: 'Resets Thursday 6:00 AM' },
});

test('official visible page keeps 0/30 percentages with unknown reset instants', () => {
  const value = pageSample(visiblePageWindows());
  assert.equal(value.connection, 'connected');
  assert.equal(value.source, OFFICIAL_USAGE_PAGE_SOURCE);
  assert.equal(value.label, '官方用量页 · 手动快照');
  assert.deepEqual(value.windows.fiveHour, { usedPercent: 0, resetsAt: null,
    resetText: 'Starts with your first message', status: 'connected' });
  assert.deepEqual(value.windows.sevenDay, { usedPercent: 30, resetsAt: null,
    resetText: 'Resets Thursday 6:00 AM', status: 'connected' });
  assert(!JSON.stringify(value).includes('DO_NOT_RETAIN'));
});

test('only official manual pages may omit reset timestamps', () => {
  const value = pageSample({ fiveHour: { usedPercent: 0 } });
  assert.equal(value.windows.fiveHour.resetsAt, null);
  assert.equal(value.windows.fiveHour.resetText, '');
  for (const source of ['claude-code-statusline', 'claude-desktop-cache']) {
    assert.equal(normalizeQuota({ source, updatedAt: '2026-10-30T11:59:00Z',
      windows: { fiveHour: { usedPercent: 0, resetsAt: null, resetText: 'Unknown' } } }, now).connection, 'missing');
  }
  const unzoned = pageSample({ fiveHour: { usedPercent: 5, resetsAt: '2026-11-05T06:00:00', resetText: 'Resets Thursday 6:00 AM' } });
  assert.equal(unzoned.windows.fiveHour.resetsAt, null, 'no local timezone or date inference');
});

test('official page refuses invalid percentages and ignores unknown windows', () => {
  for (const usedPercent of [-1, 101, NaN, Infinity, true, '30', null]) {
    assert.equal(pageSample({ fiveHour: { usedPercent } }).connection, 'missing');
  }
  assert.equal(pageSample({}).connection, 'missing');
  assert.equal(pageSample({ unknown: { usedPercent: 0 } }).connection, 'missing');
  assert.deepEqual(Object.keys(pageSample({ ...visiblePageWindows(), unknown: { usedPercent: 0 } }).windows), ['fiveHour', 'sevenDay']);
});

test('official reset labels are short plain text and never HTML or controls', () => {
  const value = pageSample({ fiveHour: { usedPercent: 0,
    resetText: '\u202e <b>Starts</b>\nwith your first message\u0000 ' + 'x'.repeat(180) } });
  const label = value.windows.fiveHour.resetText;
  assert(label.startsWith('Starts with your first message'));
  assert(Array.from(label).length <= 120);
  assert(!/[<>\u0000-\u001f\u202a-\u202e]/.test(label));
});

test('official snapshots become stale after ten minutes without inventing resets', () => {
  assert.equal(pageSample(visiblePageWindows(), '2026-10-30T11:50:00Z').connection, 'connected');
  const old = pageSample(visiblePageWindows(), '2026-10-30T11:49:59Z');
  assert.equal(old.connection, 'stale');
  assert.equal(old.windows.fiveHour.usedPercent, 0);
  assert.equal(old.windows.sevenDay.usedPercent, 30);
  assert.equal(old.windows.fiveHour.resetsAt, null);
});

test('manual page snapshots can never produce reset notifications', () => {
  const previous = pageSample({ fiveHour: { usedPercent: 90, resetsAt: '2026-10-30T11:59:00Z' } }, '2026-10-30T11:58:00Z');
  const current = pageSample({ fiveHour: { usedPercent: 1, resetsAt: '2026-10-30T16:59:00Z' } }, '2026-10-30T11:59:50Z');
  assert.deepEqual(confirmedRollovers(null, current, now), []);
  assert.deepEqual(confirmedRollovers(previous, current, now), []);
  assert.deepEqual(confirmedRollovers(current, current, now), []);
});

test('panel shows official current-session/this-week meaning and original reset labels', () => {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { textContent: '', hidden: false, value: 0,
      classList: { toggle() {} }, setAttribute() {}, querySelector: () => element(`${id}-heading`) });
    return elements.get(id);
  };
  const source = fs.readFileSync(new URL('../src/renderer/panel.js', import.meta.url), 'utf8');
  const context = vm.createContext({ document: { getElementById: element }, window: {},
    quota: pageSample(visiblePageWindows()), Date, console });
  vm.runInContext(source.slice(0, source.indexOf('\nfunction renderNotices(')), context);
  vm.runInContext('renderQuota(quota)', context);
  assert.equal(element('five-hour-card-heading').textContent, '当前会话');
  assert.equal(element('seven-day-card-heading').textContent, '本周');
  assert.equal(element('five-hour-value').textContent, '100%');
  assert.equal(element('seven-day-value').textContent, '70%');
  assert.equal(element('five-hour-reset').textContent, 'Starts with your first message');
  assert.equal(element('seven-day-reset').textContent, 'Resets Thursday 6:00 AM');
  assert.equal(element('quota-badge').textContent, '手动快照');
  assert.equal(element('quota-source').textContent, '官方用量页 · 手动快照');
  assert(!element('quota-explanation').textContent.includes('Code'));
  context.quota = pageSample({});
  vm.runInContext('renderQuota(quota)', context);
  assert.equal(element('five-hour-value').textContent, '—');
  assert.equal(element('seven-day-value').textContent, '—');
});
