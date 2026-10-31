// Local companion data: explicit snapshots only; no credential-based account APIs.
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

export const PUBLIC_CHANGELOG = 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md';
export const DESKTOP_RELEASES = 'https://support.claude.com/en/articles/12138966-release-notes';
export const OFFICIAL_USAGE_PAGE_SOURCE = 'claude-official-usage-page';
const SOURCE_LABELS = {
  'claude-code-statusline': 'Code 最近上报 · 未核验 Desktop 账号',
  'claude-desktop-cache': 'Claude Desktop 本地缓存 · 非官方接口',
  [OFFICIAL_USAGE_PAGE_SOURCE]: '官方用量页 · 手动快照',
};

function cleanResetText(value) {
  if (typeof value !== 'string') return '';
  // Copy only short human-readable text, never markup, controls or bidi marks.
  // NFKC also makes full-width angle brackets visible to the markup filter.
  const text = value.normalize('NFKC').replace(/<[^>]*>/g, ' ')
    .replace(/[^\p{L}\p{N} .,:;!?"'()\/+\-–—’‘“”，。：；！？（）]/gu, ' ')
    .replace(/\s+/g, ' ').trim();
  return Array.from(text).slice(0, 120).join('');
}

function officialResetTime(value) {
  // A page's weekday or local wall-clock label does not establish a date/zone.
  // Only accept an explicitly zoned ISO instant; otherwise retain resetText.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  return Date.parse(value);
}

export function normalizeQuota(input, now = Date.now()) {
  const empty = { connection: 'disconnected', source: null, label: '尚未连接账户额度', updatedAt: null, windows: {} };
  if (!input || !Object.hasOwn(SOURCE_LABELS, input.source)) return empty;
  const manualPage = input.source === OFFICIAL_USAGE_PAGE_SOURCE;
  const updated = Date.parse(input.updatedAt);
  if (!Number.isFinite(updated) || updated > now + 60000) return { ...empty, connection: 'missing' };
  const windows = {};
  for (const key of ['fiveHour', 'sevenDay']) {
    const value = input.windows?.[key];
    const reset = manualPage ? officialResetTime(value?.resetsAt) : Date.parse(value?.resetsAt);
    if (!value || !Number.isFinite(value.usedPercent) || value.usedPercent < 0 || value.usedPercent > 100 || (!manualPage && !Number.isFinite(reset))) continue;
    windows[key] = {
      usedPercent: value.usedPercent, resetsAt: Number.isFinite(reset) ? new Date(reset).toISOString() : null,
      ...(manualPage ? { resetText: cleanResetText(value.resetText) } : {}),
      status: Number.isFinite(reset) && reset <= now ? 'expired' : now - updated > 10 * 60000 ? 'stale' : 'connected',
    };
  }
  const statuses = Object.values(windows).map((x) => x.status);
  return {
    connection: !statuses.length ? 'missing' : statuses.every((s) => s === 'expired') ? 'expired' : statuses.includes('stale') ? 'stale' : 'connected',
    source: input.source,
    label: SOURCE_LABELS[input.source],
    updatedAt: new Date(updated).toISOString(), windows,
  };
}

export function readSmallJSON(file, fallback = null) {
  try {
    if (fs.statSync(file).size > 64 * 1024) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return fallback; }
}

export function writeJSON(file, value) {
  const temp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

// Only a fresh, newer account sample can confirm an elapsed window rollover.
// No countdown reaching zero, first sample, public news or duplicate can ring.
export function confirmedRollovers(previous, current, now = Date.now()) {
  // A manually observed page is a snapshot, not a reset event stream. It stays
  // silent even if the page happens to supply an exact reset timestamp.
  if (previous?.source === OFFICIAL_USAGE_PAGE_SOURCE || current?.source === OFFICIAL_USAGE_PAGE_SOURCE) return [];
  if (!previous || !current || current.connection !== 'connected' || previous.source !== current.source) return [];
  const oldSample = Date.parse(previous.updatedAt), newSample = Date.parse(current.updatedAt);
  if (!Number.isFinite(oldSample) || newSample <= oldSample || now - oldSample > 10 * 60000) return [];
  return ['fiveHour', 'sevenDay'].filter((key) => {
    const a = previous.windows?.[key], b = current.windows?.[key];
    if (!a || !b) return false;
    const oldReset = Date.parse(a.resetsAt), newReset = Date.parse(b.resetsAt);
    return oldSample < oldReset && oldReset <= now && newReset > now && newReset > oldReset && b.usedPercent < a.usedPercent;
  }).map((key) => ({
    id: `account-window:${key}:${current.windows[key].resetsAt}`,
    category: 'account-reset',
    title: `${key === 'fiveHour' ? '5 小时' : '7 天'}用量窗口已更新`,
    body: '新的账户用量快照确认该窗口已重新开始。', at: current.updatedAt,
  }));
}

export function parsePublicRelease(text, now = new Date().toISOString()) {
  const match = text.match(/^##\s+(\d+\.\d+\.\d+[^\r\n]*)/m);
  if (!match) throw new Error('官方更新格式暂不可识别');
  const version = match[1].trim().slice(0,60);
  return { id: `claude-code-release:${version}`, category: 'release', title: `Claude Code ${version}`,
    body: '官方功能更新；与账号剩余额度或重置无关。', at: now };
}

export async function fetchPublicRelease() {
  return new Promise((resolve, reject) => {
    // Public, fixed URL. No cookies, auth headers, account identifiers or redirects.
    const request = https.get(PUBLIC_CHANGELOG, { headers: { 'User-Agent': 'ClaudeChanPet/0.1.0', Accept: 'text/plain' } }, (response) => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`官方更新暂不可用 (${response.statusCode})`)); return; }
      let text = '', size = 0;
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        size += Buffer.byteLength(chunk);
        if (size > 2 * 1024 * 1024) { request.destroy(new Error('官方更新文件超出读取上限')); return; }
        text += chunk;
      });
      response.on('end', () => { try { resolve(parsePublicRelease(text)); } catch (error) { reject(error); } });
      response.on('error', reject);
    });
    request.setTimeout(15000, () => request.destroy(new Error('官方更新读取超时')));
    request.on('error', reject);
  });
}
