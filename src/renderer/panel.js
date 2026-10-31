const $ = (id) => document.getElementById(id);
const api = window.petPanel;
let currentStatus = null;
let saving = false;
let feedbackTimer = null;

function safeText(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function parseDate(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const numeric = typeof value === 'number' ? value : (/^\d+(?:\.\d+)?$/.test(value) ? Number(value) : null);
  const date = new Date(numeric === null ? value : (numeric < 1e12 ? numeric * 1000 : numeric));
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatDate(value) {
  const date = parseDate(value);
  if (!date) return '未知';
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

function setBadge(id, text, tone = '') {
  const badge = $(id);
  badge.textContent = text;
  badge.className = `badge ${tone}`.trim();
}

function showFeedback(message, error = false) {
  const feedback = $('feedback');
  feedback.textContent = message;
  feedback.classList.toggle('error', error);
  feedback.hidden = false;
  if (feedbackTimer) clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => { feedback.hidden = true; }, error ? 6000 : 2400);
}

function renderQuotaWindow(prefix, data, connection, manualPage = false) {
  const value = $(`${prefix}-value`);
  const unit = $(`${prefix}-unit`);
  const progress = $(`${prefix}-progress`);
  const reset = $(`${prefix}-reset`);
  const card = $(`${prefix}-card`);
  const title = manualPage ? (prefix === 'five-hour' ? '当前会话' : '本周') : (prefix === 'five-hour' ? '5 小时窗口' : '7 天窗口');
  card.querySelector('h3').textContent = title;
  progress.setAttribute('aria-label', `${title}剩余额度`);
  const used = data?.usedPercent;
  const resetDate = parseDate(data?.resetsAt);
  const hasPercentage = typeof used === 'number' && Number.isFinite(used) && used >= 0 && used <= 100;
  const expired = connection === 'expired' || (resetDate && resetDate.getTime() <= Date.now());
  const disconnected = connection === 'disconnected' || connection === 'missing';
  const stale = connection === 'stale';
  const showValue = !disconnected && !expired && hasPercentage;
  card.classList.toggle('is-old', stale || expired);
  progress.hidden = !showValue;
  if (showValue) {
    const remaining = Math.round((100 - used) * 10) / 10;
    value.textContent = `${remaining}%`;
    unit.textContent = stale ? '上次剩余' : '剩余';
    progress.value = remaining;
    reset.textContent = resetDate ? `${formatDate(resetDate.toISOString())} 重置`
      : (manualPage && safeText(data?.resetText)) || '重置时间未知';
  } else {
    value.textContent = '—';
    unit.textContent = '';
    progress.value = 0;
    reset.textContent = expired ? '窗口已到期，等待新数据' : '暂无数据';
  }
}

function renderQuota(quota = {}) {
  const manualPage = quota.source === 'claude-official-usage-page';
  let connection = ['connected', 'stale', 'missing', 'expired'].includes(quota.connection)
    ? quota.connection : 'disconnected';
  let partiallyExpired = false;
  if (connection === 'connected') {
    const windows = [quota.windows?.fiveHour, quota.windows?.sevenDay].filter((data) =>
      typeof data?.usedPercent === 'number' && Number.isFinite(data.usedPercent) && data.usedPercent >= 0 && data.usedPercent <= 100,
    );
    const isExpired = (data) => { const reset = parseDate(data.resetsAt); return reset && reset.getTime() <= Date.now(); };
    if (!windows.length) connection = 'missing';
    else if (windows.every(isExpired)) connection = 'expired';
    else partiallyExpired = windows.some(isExpired);
  }
  const descriptions = {
    disconnected: ['未连接', '', '尚未接入账户用量；不会读取登录令牌或主动调用模型。'],
    connected: manualPage
      ? ['手动快照', 'good', '本次从官方用量页读取；仅代表读取时刻，不会自动刷新。']
      : ['已更新', 'good', '显示 Code 最近提供的用量，可能不含其它客户端的后续消耗；以账户用量页为准。'],
    stale: ['数据较旧', 'warn', manualPage
      ? '这是上次读取的官方页面快照，当前用量可能已变化；不会推算余额。'
      : '以下是上次记录，可能已变化。等待新采样，不推算当前余额。'],
    missing: ['等待数据', '', '数据来源尚未提供用量，暂时无法显示剩余额度。'],
    expired: ['等待新数据', 'warn', '上次窗口已到期；尚未确认新额度，不自动补为 100%。'],
  };
  const [label, tone, description] = descriptions[connection];
  setBadge('quota-badge', partiallyExpired ? '部分待更新' : label, partiallyExpired ? 'warn' : tone);
  $('quota-explanation').textContent = partiallyExpired ? '部分用量窗口已到期，等待新数据；不会推算重置后的余额。' : description;
  $('quota-source').textContent = safeText(quota.label) || safeText(quota.source) || '尚未连接';
  $('quota-updated').textContent = parseDate(quota.updatedAt) ? formatDate(quota.updatedAt) : '尚无采样';
  renderQuotaWindow('five-hour', quota.windows?.fiveHour, connection, manualPage);
  renderQuotaWindow('seven-day', quota.windows?.sevenDay, connection, manualPage);
}

function renderNotices(notices) {
  const list = $('notices-list');
  list.replaceChildren();
  const items = Array.isArray(notices) ? notices.filter((item) => item && typeof item === 'object').slice(0, 20) : [];
  $('notices-empty').hidden = items.length > 0;
  const categories = {
    'account-reset': '账号额度重置',
    announcement: '公告',
    release: '功能更新 · 静默',
  };
  for (const item of items) {
    const category = Object.hasOwn(categories, item.category) ? item.category : 'release';
    const li = document.createElement('li');
    li.className = 'notice';
    const top = document.createElement('div');
    top.className = 'notice-top';
    const kind = document.createElement('span');
    kind.className = `notice-kind ${category}`;
    kind.textContent = categories[category];
    const time = document.createElement('time');
    time.textContent = parseDate(item.at) ? formatDate(item.at) : '';
    if (parseDate(item.at)) time.dateTime = parseDate(item.at).toISOString();
    const title = document.createElement('h3');
    title.textContent = safeText(item.title, '新消息');
    const body = document.createElement('p');
    body.textContent = safeText(item.body);
    top.append(kind, time);
    li.append(top, title, body);
    list.append(li);
  }
}

function render(status) {
  if (!status || typeof status !== 'object') return;
  currentStatus = status;
  const mode = ['full', 'compact', 'minimal'].includes(status.settings?.displayMode) ? status.settings.displayMode : 'full';
  document.body.dataset.mode = mode;
  for (const button of document.querySelectorAll('[data-mode-value]')) {
    button.setAttribute('aria-pressed', String(button.dataset.modeValue === mode));
  }
  $('version').textContent = safeText(status.version) ? `v${status.version}` : '';
  const paused = !!status.runtime?.energyPaused;
  setBadge('runtime-badge', paused ? '休息中' : '本地伴随', paused ? 'paused' : 'good');
  const pauseReason = safeText(status.runtime?.pauseReason);
  $('runtime-copy').textContent = paused
    ? (pauseReason || '暂时收起动画，稍后继续陪伴。')
    : '普通 Chat 的工作状态尚未连接。';
  if (!saving) {
    const settings = status.settings || {};
    for (const input of document.querySelectorAll('input[data-setting]')) {
      const value = settings[input.dataset.setting];
      if (input.type === 'checkbox') input.checked = typeof value === 'boolean' ? value : input.defaultChecked;
      else if (typeof value === 'number' && Number.isFinite(value)) input.value = Math.max(160, Math.min(360, Math.round(value)));
    }
    $('pet-height-value').textContent = `${$('pet-height').value} px`;
  }
  renderQuota(status.quota);
  renderNotices(status.notices);
  const updates = status.publicUpdates || status.notices?.publicUpdates || {};
  const updateSource = safeText(updates.source, 'Claude Code 官方更新');
  $('public-update-state').textContent = updates.error
    ? `${updateSource}暂时无法检查，已有消息仍保留。`
    : (parseDate(updates.checkedAt) ? `${updateSource} · ${formatDate(updates.checkedAt)} 已检查` : `${updateSource}尚未检查。`);
}

async function refresh() {
  const status = await api.status();
  render(status);
  return status;
}

async function saveSetting(input) {
  const key = input.dataset.setting;
  const value = input.type === 'checkbox' ? input.checked : Math.round(Number(input.value));
  return savePatch(key, value);
}

async function savePatch(key, value) {
  if (!api || saving) return;
  saving = true;
  $('settings-controls').disabled = true;
  for (const button of document.querySelectorAll('[data-mode-value]')) button.disabled = true;
  $('save-state').textContent = '保存中…';
  try {
    const result = await api.updateSettings({ [key]: value });
    saving = false;
    if (result?.settings) render(result);
    else await refresh();
    $('save-state').textContent = '已保存';
  } catch {
    saving = false;
    if (currentStatus) render(currentStatus);
    $('save-state').textContent = '未保存';
    showFeedback('设置未能保存，请稍后重试。', true);
  } finally {
    saving = false;
    $('settings-controls').disabled = false;
    for (const button of document.querySelectorAll('[data-mode-value]')) button.disabled = false;
  }
}

async function performAction(action, button) {
  if (!api) return;
  button.disabled = true;
  try {
    const result = await api.action(action);
    if (result?.settings) render(result);
    else if (action === 'check-updates') await refresh();
    if (action === 'check-updates' && currentStatus?.publicUpdates?.error) {
      showFeedback('暂时无法检查公开 Code 更新，请稍后重试。', true);
      return;
    }
    const messages = {
      whisper: '听她说一句。',
      'reset-position': '已回到初始位置。',
      'check-updates': '公开更新检查已完成。',
      'open-claude-updates': '已打开 Claude Desktop 官方更新说明。',
    };
    showFeedback(messages[action] || '已完成。');
  } catch {
    showFeedback('这次操作没有完成，请稍后重试。', true);
  } finally {
    button.disabled = false;
  }
}

$('whisper-button').addEventListener('click', () => performAction('whisper', $('whisper-button')));
$('reset-button').addEventListener('click', () => performAction('reset-position', $('reset-button')));
$('check-updates-button').addEventListener('click', () => performAction('check-updates', $('check-updates-button')));
$('desktop-updates-button').addEventListener('click', () => performAction('open-claude-updates', $('desktop-updates-button')));
for (const button of document.querySelectorAll('[data-mode-value]')) {
  button.addEventListener('click', () => savePatch('displayMode', button.dataset.modeValue));
}
for (const input of document.querySelectorAll('input[data-setting]')) {
  input.addEventListener('change', () => saveSetting(input));
}
$('pet-height').addEventListener('input', () => {
  $('pet-height-value').textContent = `${$('pet-height').value} px`;
});

if (api) {
  const unsubscribe = api.onUpdate((status) => render(status));
  window.addEventListener('beforeunload', () => { if (typeof unsubscribe === 'function') unsubscribe(); });
  refresh().catch(() => showFeedback('暂时无法读取面板状态，请重新打开面板。', true));
  // Refresh time labels/expiry only; never request or infer account usage here.
  const clock = setInterval(() => { if (currentStatus) renderQuota(currentStatus.quota); }, 30000);
  window.addEventListener('beforeunload', () => clearInterval(clock));
} else {
  $('settings-controls').disabled = true;
  $('whisper-button').disabled = true;
  $('reset-button').disabled = true;
  $('check-updates-button').disabled = true;
  $('desktop-updates-button').disabled = true;
  for (const button of document.querySelectorAll('[data-mode-value]')) button.disabled = true;
}
