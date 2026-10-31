// Read-only local snapshot display. No account requests or inferred balances.
const $ = (id) => document.getElementById(id);
const api = window.petQuota;
const MANUAL_PAGE = 'claude-official-usage-page';
let snapshot = null;
let pushedUpdates = 0;

function shortText(value, fallback = '') {
  return typeof value === 'string' ? Array.from(value).slice(0, 160).join('') : fallback;
}

function dateValue(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const numeric = typeof value === 'number' ? value : (/^\d+(?:\.\d+)?$/.test(value) ? Number(value) : null);
  const date = new Date(numeric === null ? value : numeric < 1e12 ? numeric * 1000 : numeric);
  return Number.isFinite(date.getTime()) ? date : null;
}

function dateLabel(value) {
  const date = dateValue(value);
  return date ? date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
}

function validPercentage(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function windowState(value, connection, stale) {
  if (connection === 'disconnected' || connection === 'missing' || !validPercentage(value?.usedPercent)) return 'missing';
  const reset = dateValue(value.resetsAt);
  if (connection === 'expired' || value.status === 'expired' || (reset && reset.getTime() <= Date.now())) return 'expired';
  return stale || value.status === 'stale' ? 'stale' : 'connected';
}

function renderWindow(prefix, data, state, manualPage) {
  const title = manualPage ? (prefix === 'session' ? '当前会话' : '本周') : (prefix === 'session' ? '5 小时窗口' : '7 天窗口');
  $(`${prefix}-title`).textContent = title;
  $(`${prefix}-card`).classList.toggle('old', state === 'stale' || state === 'expired');
  const value = $(`${prefix}-value`), unit = $(`${prefix}-unit`), reset = $(`${prefix}-reset`);
  if (state === 'connected' || state === 'stale') {
    value.textContent = `${Math.round((100 - data.usedPercent) * 10) / 10}%`;
    unit.textContent = state === 'stale' ? '上次剩余' : '剩余';
    reset.textContent = dateValue(data.resetsAt) ? `${dateLabel(data.resetsAt)} 重置`
      : (manualPage && shortText(data.resetText)) || '重置时间未知';
  } else {
    value.textContent = '—';
    unit.textContent = '';
    reset.textContent = state === 'expired' ? '已到期，等待新数据' : '暂无数据';
  }
  reset.title = reset.textContent;
}

function renderQuota(quota) {
  snapshot = quota && typeof quota === 'object' ? quota : {};
  const manualPage = snapshot.source === MANUAL_PAGE;
  const connection = ['connected', 'stale', 'missing', 'expired'].includes(snapshot.connection) ? snapshot.connection : 'disconnected';
  const updated = dateValue(snapshot.updatedAt);
  const stale = connection === 'stale' || (updated && Date.now() - updated.getTime() > 10 * 60000);
  const first = snapshot.windows?.fiveHour, second = snapshot.windows?.sevenDay;
  const firstState = windowState(first, connection, stale), secondState = windowState(second, connection, stale);
  renderWindow('session', first, firstState, manualPage);
  renderWindow('week', second, secondState, manualPage);

  const states = [firstState, secondState];
  let badge = manualPage ? '手动快照' : '最近采样';
  let tone = 'good';
  let note = manualPage ? '本次页面快照，不会自动刷新。' : '仅代表最近采样，以账户用量页为准。';
  if (states.every((state) => state === 'missing')) {
    badge = connection === 'disconnected' ? '未连接' : '等待数据'; tone = '';
    note = '没有可用采样，不估算余额。';
  } else if (states.every((state) => state === 'expired' || state === 'missing')) {
    badge = '等待更新'; tone = 'old'; note = '窗口已到期，等待新的用量数据。';
  } else if (states.includes('stale')) {
    badge = '数据较旧'; tone = 'old'; note = '上次读取的快照，不代表当前余额。';
  } else if (states.includes('expired')) {
    badge = '部分待更新'; tone = 'old'; note = '部分窗口已到期，不推算重置后的余额。';
  } else if (states.includes('missing')) {
    badge = '部分数据'; tone = '';
  }
  $('quota-badge').textContent = badge;
  $('quota-badge').className = `badge ${tone}`.trim();
  $('quota-source').textContent = shortText(snapshot.label) || (manualPage ? '官方用量页 · 手动快照' : shortText(snapshot.source)) || '尚未连接账户额度';
  $('quota-source').title = $('quota-source').textContent;
  $('quota-time').textContent = updated ? `采集于 ${dateLabel(snapshot.updatedAt)}` : '尚无采样';
  $('quota-note').textContent = note;
  $('quota-note').classList.remove('error');
}

async function act(action) {
  if (!api) return;
  try { await api.action(action); }
  catch {
    $('quota-note').textContent = '操作未完成，请稍后重试。';
    $('quota-note').classList.add('error');
  }
}

$('hide-button').addEventListener('click', () => act('hide'));
$('settings-button').addEventListener('click', () => act('settings'));
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { event.preventDefault(); act('hide'); }
});

if (api) {
  const unsubscribe = api.onUpdate((quota) => { pushedUpdates++; renderQuota(quota); });
  api.status().then((quota) => { if (!pushedUpdates) renderQuota(quota); }).catch(() => {
    if (pushedUpdates) return;
    renderQuota({ connection: 'missing' });
    $('quota-note').textContent = '暂时无法读取额度，重新打开可重试。';
    $('quota-note').classList.add('error');
  });
  // Time/expiry display only: this does not fetch data or refresh a snapshot.
  const clock = setInterval(() => { if (snapshot) renderQuota(snapshot); }, 30000);
  window.addEventListener('beforeunload', () => { clearInterval(clock); if (typeof unsubscribe === 'function') unsubscribe(); });
} else {
  renderQuota({ connection: 'missing' });
  $('hide-button').disabled = true;
  $('settings-button').disabled = true;
}
