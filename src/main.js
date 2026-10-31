/**
 * 主进程：透明悬浮窗、移动交互和本地用量快照。
 *
 * 为什么位置归主进程管：桌宠的"走动"和"被甩出去"真正移动的是窗口本身，
 * 渲染层负责贴图与气泡，主进程统一管理原生窗口位置。
 */

import { app, BrowserWindow, ipcMain, Menu, screen, Tray, nativeImage, powerMonitor, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import {
  HOME_DIR,
  loadConfig,
  loadState,
  saveState,
  saveConfig,
} from './shared/config.js';
import { normalizeQuota, readSmallJSON, writeJSON, confirmedRollovers, fetchPublicRelease, DESKTOP_RELEASES } from './shared/companion.js';
import { placeQuotaPopup } from './shared/quota-placement.js';
import { LINES } from './shared/lines.js';
import { STATES, FACE_LABELS, pickText } from './shared/states.js';

const TICK_MS = 16;
const VELOCITY_CAP = 3600;
const SELF_TEST = process.argv.includes('--selftest');
app.setName('ClaudeChanPet');
app.setPath('userData', path.join(HOME_DIR, 'electron'));
// The production companion never installs hooks or reads Claude/event data.
if (!SELF_TEST && !app.requestSingleInstanceLock()) app.exit(0);

// 桌宠是 GUI 应用，控制台看不到东西；关键事件写日志文件，出问题能翻。
const LOG_FILE = path.join(HOME_DIR, 'pet.log');
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch {
    /* 日志失败不能影响桌宠 */
  }
}

let cfg = loadConfig();
let win = null;
let petBox = { w: Math.round(cfg.pet.height * 0.86), h: cfg.pet.height }; // 宽按正面立绘 392x457 估，收到真实素材后再定死
let petBoxLocked = false;
let currentState = 'idle';
let settleTimer = null;
let whisperTimer = null;
let wanderTimer = null;
let panelWin = null;
let quotaWin = null;
let quotaReady = null;
let quotaLoaded = false;
let quotaWanted = false;
let quotaSide = 'right';
let quotaAnchor = null;
let lastPublishedQuota = '';
const QUOTA_SIZE = { width: 300, height: 260 };
let tray = null;
let quitting = false;
let systemPaused = false;
let fullscreenPaused = false;
let energyPaused = false;
let pauseReason = '';
const QUOTA_FILE = path.join(HOME_DIR, 'quota.json');
const BRIDGE_FILE = path.join(HOME_DIR, 'bridge-status.json');
const ENERGY_FILE = path.join(HOME_DIR, 'companion-state.json');
const NOTICE_FILE = path.join(HOME_DIR, 'notification-ledger.json');
const NEWS_FILE = path.join(HOME_DIR, 'public-updates.json');
let ledger = readSmallJSON(NOTICE_FILE, { seen: [], notices: [] });
let publicUpdates = readSmallJSON(NEWS_FILE, { checkedAt: null, error: null, notices: [] });
let previousQuota = null;
let updatesInFlight = false;
let lastPublishedStatus = '';
let lastRenderPreferences = '';

const motion = {
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  mode: 'idle', // idle | walk | drag | throw
  facing: 1, // 1 = 朝右，-1 = 朝左
  walkTarget: null,
  grab: { dx: 0, dy: 0 },
};

// ---------------------------------------------------------------- 几何

function displayFor(x, y) {
  return screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
}

function workArea() {
  const size = winSize();
  const d = displayFor(motion.x + size.w / 2, motion.y + size.h / 2);
  return d.workArea;
}

function groundY() {
  const a = workArea();
  return a.y + a.height - (cfg.window.groundOffsetPx || 0);
}

function winSize() {
  // 窗口宽度还要容得下最宽的动作片段：片段按 petHeight 等比缩放，
  // 窄窗口会把 1.45:1 的坐姿片段压到 185px 高，看起来像变远了。
  return {
    w: Math.max(Math.round(petBox.w + cfg.window.padX * 2), clipMaxWidth() + 12),
    h: Math.round(petBox.h + cfg.window.padTop),
  };
}

let clipWidthCache = null;
function clipMaxWidth() {
  if (clipWidthCache !== null) return clipWidthCache;
  const clips = loadClips();
  let ratio = 0;
  for (const key of Object.keys(clips)) {
    const c = clips[key];
    if (c && Number.isFinite(c.h) && c.h > 0) ratio = Math.max(ratio, c.w / c.h);
  }
  clipWidthCache = ratio > 0 ? Math.ceil(ratio * cfg.pet.height) : 0;
  return clipWidthCache;
}

function lockWindowSize(size) {
  if (!win || win.isDestroyed()) return;
  try {
    // 锁死尺寸：外部（Aero Snap / Win+方向键 / DPI 变化）就没法把窗口撑大。
    // 窗口一被撑大，宠物就不再贴窗口底部，可放置范围也会被压缩——这是实测踩到的坑。
    win.setMinimumSize(size.w, size.h);
    win.setMaximumSize(size.w, size.h);
  } catch (err) {
    log('lockWindowSize failed: ' + err.message);
  }
}

/** 把窗口尺寸拉回该有的样子。 */
function ensureWindowSize() {
  if (!win || win.isDestroyed()) return;
  const want = winSize();
  const cur = win.getBounds();
  // 2px 容差：Windows 对无边框窗口的实际尺寸常比请求值大 1~2px。
  // 不容忍就会每 2 秒"修正"一次，而"保持底边不动"的算法会把这 1px 误差逐次往下推——
  // 表现就是宠物慢慢沉到站立线以下（实测踩到）。
  if (Math.abs(cur.width - want.w) <= 2 && Math.abs(cur.height - want.h) <= 2) return;
  log(`ensureWindowSize: ${cur.width}x${cur.height} -> ${want.w}x${want.h}`);
  // 保持**底边**不动：立绘贴窗口底部，底边不动就等于宠物帧格原地不变，
  // 这次纠正对用户是"不可见"的。反过来若按顶边缩放，窗口一变大宠物就会往下沉。
  // （2px 容差保证不会像早先那样每 2 秒修正一次、把误差逐次往下推。）
  const bottom = cur.y + cur.height;
  try {
    win.setMaximumSize(100000, 100000); // 先松开上限，否则 setBounds 会被 min/max 卡住
    win.setMinimumSize(1, 1);
    resizingInternally = true;
    win.setBounds({ width: want.w, height: want.h, y: bottom - want.h });
  } catch (err) {
    log('ensureWindowSize setBounds failed: ' + err.message);
    return;
  } finally {
    resizingInternally = false;
  }
  lockWindowSize(want);
  const b = win.getBounds();
  motion.x = b.x;
  motion.y = b.y;
  syncQuotaPopup();
}

function place(x, y, save = false) {
  // 非有限值绝不能进 setPosition：那会在主进程抛异常直接把桌宠崩掉（实测踩到）
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    log(`place() refused non-finite x=${x} y=${y}; healing to initial spot`);
    const p = initialSpot();
    x = p.x;
    y = p.y;
    motion.mode = 'idle';
    motion.vx = 0;
    motion.vy = 0;
    motion.walkTarget = null;
  }
  const p = clampToArea(x, y);
  motion.x = Number.isFinite(p.x) ? p.x : 0;
  motion.y = Number.isFinite(p.y) ? p.y : 0;
  if (win && !win.isDestroyed()) {
    win.setPosition(Math.round(motion.x), Math.round(motion.y));
    syncQuotaPopup();
  }
  if (save) saveState({ x: motion.x, y: motion.y });
}

function clampToArea(x, y) {
  const { w, h } = winSize();
  // Select from the requested position, not the old position, so a drag can
  // cross display boundaries. Electron bounds/workArea are already in DIP.
  const a = displayFor(x + w / 2, y + h / 2).workArea;
  return {
    x: Math.min(Math.max(x, a.x - cfg.window.padX), a.x + a.width - w + cfg.window.padX),
    y: Math.min(Math.max(y, a.y - cfg.window.padTop), a.y + a.height - (cfg.window.groundOffsetPx || 0) - h),
  };
}

/** 扫 assets/pet 里的 PNG 头，用最宽的一张定窗口宽度。
 *  只读 PNG 的 IHDR（宽高在固定偏移 16/20），不需要图像库。
 *  用文件真尺寸而不是渲染层上报，少一个可能被改来改去的环节；
 *  表情格（126x106 那种宽扁的）排除在外——它们只出现在气泡里，不该撑宽窗口。 */
function scanSpriteBox() {
  const dir = path.join(import.meta.dirname, '..', 'assets', 'pet');
  let maxAspect = 0; // 从 0 起，日志里的 widest 就能证明扫描真的读到文件了
  let widest = '(none)';
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/^(front|side|back|act-\d+)\.png$/.test(f)) continue;
      const head = Buffer.alloc(24);
      const fd = fs.openSync(path.join(dir, f), 'r');
      try {
        fs.readSync(fd, head, 0, 24, 0);
      } finally {
        fs.closeSync(fd);
      }
      if (head.toString('ascii', 1, 4) !== 'PNG') continue;
      const w = head.readUInt32BE(16);
      const h = head.readUInt32BE(20);
      if (w > 0 && h > 0 && w / h > maxAspect) {
        maxAspect = w / h;
        widest = f;
      }
    }
  } catch (err) {
    log('scanSpriteBox failed: ' + err.message);
  }
  petBox = { w: Math.round(cfg.pet.height * maxAspect), h: cfg.pet.height };
  petBoxLocked = true;
  log(`sprite scan: widest=${widest} aspect=${maxAspect.toFixed(3)} -> petBox ${petBox.w}x${petBox.h}`);
}

let lastInteractive = false;

/** 命中区控制：透明像素点击穿透到下层应用，悬停到立绘上时切成可交互。
 *  渲染层算命中（它知道立绘实际画在哪），这里只执行 + 记日志。 */
ipcMain.on('pet:interactive', (_e, on) => {
  if (SELF_TEST) return; // Automated media checks must not intercept real user clicks.
  if (!win || win.isDestroyed()) return;
  if (on === lastInteractive) return;
  lastInteractive = !!on;
  win.setIgnoreMouseEvents(!on, { forward: true });
  log(`interactive ${on ? 'on' : 'off'}`);
});

function initialSpot() {
  const a = screen.getPrimaryDisplay().workArea;
  const { w, h } = winSize();
  return {
    x: a.x + a.width - w - 24,
    y: a.y + a.height - (cfg.window.groundOffsetPx || 0) - h,
  };
}

// ---------------------------------------------------------------- 运动

function startWalk() {
  if (!cfg.wander.enabled || cfg.companion.positionLocked || energyPaused || motion.mode !== 'idle') return;
  const a = workArea();
  const dist = cfg.wander.minDist + Math.random() * (cfg.wander.maxDist - cfg.wander.minDist);
  const dir = Math.random() < 0.5 ? -1 : 1;
  const leftEdge = a.x - cfg.window.padX + cfg.wander.margin;
  const rightEdge = a.x + a.width - winSize().w + cfg.window.padX - cfg.wander.margin;
  let target = motion.x + dir * dist;
  if (target < leftEdge || target > rightEdge) target = motion.x - dir * dist;
  target = Math.min(Math.max(target, leftEdge), rightEdge);
  if (Math.abs(target - motion.x) < 12) return;
  motion.mode = 'walk';
  motion.walkTarget = target;
  motion.facing = target > motion.x ? 1 : -1;
  pushMotion(true);
  scheduleWander();
}

function scheduleWander() {
  if (wanderTimer) clearTimeout(wanderTimer);
  wanderTimer = null;
  if (!cfg.wander.enabled || cfg.companion.positionLocked || energyPaused) return;
  const { minDelaySec, maxDelaySec } = cfg.wander;
  const delay = (minDelaySec + Math.random() * (maxDelaySec - minDelaySec)) * 1000;
  wanderTimer = setTimeout(() => {
    wanderTimer = null;
    if (motion.mode === 'idle') startWalk();
    else scheduleWander();
  }, delay);
}

// setPosition 是同步的窗口移动，在 Windows 上很贵。走动/飞行时按 30ms 节流，
// 不必跟着 60fps 的物理 tick 一步步挪（那是掉帧的另一来源）。
let lastMoveAt = 0;
/** 我自己 setBounds 时置 true，让 'resized' 日志能区分"我改的"和"别人改的" */
let resizingInternally = false;
function placeThrottled() {
  const now = Date.now();
  if (now - lastMoveAt < 30) return;
  lastMoveAt = now;
  place(motion.x, motion.y);
}

let lastDragAt = 0;

function step(dt) {
  if (energyPaused) return;
  // 拖拽看门狗：指针在窗口外松开时渲染层收不到 mouseup，
  // 宠物会挂在半空不动——超时就当松手，让它按重力落回地面
  if (motion.mode === 'drag' && Date.now() - lastDragAt > 1500) {
    motion.mode = 'throw';
    motion.vx = 0;
    motion.vy = 0;
    pushMotion(true);
  }

  if (motion.mode === 'walk' && motion.walkTarget !== null) {
    const step = cfg.wander.speed * dt * motion.facing;
    motion.x += step;
    if ((motion.facing > 0 && motion.x >= motion.walkTarget) || (motion.facing < 0 && motion.x <= motion.walkTarget)) {
      motion.x = motion.walkTarget;
      motion.walkTarget = null;
      motion.mode = 'idle';
      motion.facing = 1;
      place(motion.x, motion.y);
      pushMotion(true);
      saveState({ x: motion.x, y: motion.y });
    }
    return;
  }

  if (motion.mode === 'throw') {
    const { gravity, restitution, groundFriction, ceilingBounce } = cfg.physics;
    const a = workArea();
    const { w, h } = winSize();
    const minX = a.x - cfg.window.padX;
    const maxX = a.x + a.width - w + cfg.window.padX;
    const floor = groundY() - h;
    const ceil = ceilingBounce ? a.y - cfg.window.padTop : -1e6;

    motion.vy += gravity * dt;
    motion.x += motion.vx * dt;
    motion.y += motion.vy * dt;

    if (motion.x < minX) {
      motion.x = minX;
      motion.vx = Math.abs(motion.vx) * restitution;
      motion.facing = 1;
    } else if (motion.x > maxX) {
      motion.x = maxX;
      motion.vx = -Math.abs(motion.vx) * restitution;
      motion.facing = -1;
    }
    if (motion.y > floor) {
      motion.y = floor;
      motion.vy = -Math.abs(motion.vy) * restitution;
      if (Math.abs(motion.vy) < 90) motion.vy = 0;
    } else if (motion.y < ceil) {
      motion.y = ceil;
      motion.vy = Math.abs(motion.vy) * restitution;
    }

    const onGround = motion.y >= floor - 0.5;
    if (onGround) {
      const decay = Math.exp(-groundFriction * dt);
      motion.vx *= decay;
    }

    if (onGround && Math.abs(motion.vx) < 20 && Math.abs(motion.vy) < 90) {
      motion.vx = 0;
      motion.vy = 0;
      motion.mode = 'idle';
      motion.facing = 1;
      place(motion.x, motion.y);
      pushMotion(true);
      saveState({ x: motion.x, y: motion.y });
      scheduleWander();
      return;
    }
    placeThrottled();
    pushMotion();
  }
}

let lastTick = Date.now();
function tickMotion() {
  const now = Date.now();
  const dt = Math.min((now - lastTick) / 1000, 0.05);
  lastTick = now;
  try {
    // 每帧自净：任何一条非有限值都不许活着进 setPosition（那会崩整个主进程）
    if (!Number.isFinite(motion.x) || !Number.isFinite(motion.y)) {
      log(`motion non-finite (x=${motion.x} y=${motion.y}); healing`);
      const p = initialSpot();
      motion.x = p.x;
      motion.y = p.y;
    }
    if (!Number.isFinite(motion.vx)) motion.vx = 0;
    if (!Number.isFinite(motion.vy)) motion.vy = 0;
    if (!Number.isFinite(motion.walkTarget)) motion.walkTarget = null;
    step(dt);
  } catch (err) {
    log('tick error: ' + (err && err.stack ? err.stack : String(err)));
    motion.mode = 'idle';
    motion.vx = 0;
    motion.vy = 0;
    motion.walkTarget = null;
  }
}
let motionInterval = setInterval(tickMotion, TICK_MS);

// 兜底：桌宠是常驻小工具，绝不能因为一个未捕获异常弹崩溃框然后消失
process.on('uncaughtException', (err) => {
  log('uncaughtException: ' + (err && err.stack ? err.stack : String(err)));
});

let lastPush = 0;
function pushMotion(force = false) {
  if (!win || win.isDestroyed()) return;
  const now = Date.now();
  if (!force && now - lastPush < 80) return; // 60fps 的物理没必要 60 次/秒 往渲染层灌
  lastPush = now;
  win.webContents.send('pet:motion', {
    vx: motion.vx,
    vy: motion.vy,
    mode: motion.mode,
    facing: motion.facing,
  });
}

// ---------------------------------------------------------------- 状态

function setState(name, extra = {}) {
  const next = STATES[name] ? name : 'idle';
  currentState = next;
  if (!win || win.isDestroyed()) return;
  win.webContents.send('pet:state', {
    state: next,
    pose: STATES[next].pose,
    face: extra.face ?? cfg.stateFaces[next] ?? null,
    text: extra.text ?? pickText(next),
  });
  if (settleTimer) clearTimeout(settleTimer);
  // 有状态变化（要冒气泡）时顺手抬到最前：用户这会儿正要看它
  if (win && !win.isDestroyed() && cfg.window.alwaysOnTop) win.moveTop();
  if (next !== 'idle' && next !== 'sleep' && cfg.work.settleSec > 0) {
    settleTimer = setTimeout(() => setState('idle', { text: null }), cfg.work.settleSec * 1000);
  }
}

let lastWhisperText = null;

function whisperNow() {
  const pool = Array.isArray(cfg.lines) && cfg.lines.length ? cfg.lines : LINES;
  let text = pool[Math.floor(Math.random() * pool.length)];
  // 连着念同一句很出戏，最多重抽 5 次
  for (let i = 0; i < 5 && pool.length > 1 && text === lastWhisperText; i++) {
    text = pool[Math.floor(Math.random() * pool.length)];
  }
  lastWhisperText = text;
  // 表情也随机：每次碎碎念随机挑一张胸像，不再固定 10 号
  const face = 1 + Math.floor(Math.random() * 10);
  log(`whisper face=${face} ${text}`);
  if (win && !win.isDestroyed()) {
    win.webContents.send('pet:state', {
      state: 'whisper',
      pose: 'front',
      face,
      text,
      transient: true,
    });
  }
  return text;
}

// Code hooks and event-file readers are deliberately absent in this build.

function startWhisper() {
  if (whisperTimer) clearTimeout(whisperTimer);
  if (!cfg.whisper.enabled || systemPaused || (cfg.companion.fullscreenPause && fullscreenPaused) || !cfg.companion.petVisible) return;
  const minSec = Math.max(15, cfg.whisper.minSec ?? cfg.whisper.intervalSec ?? 60);
  const maxSec = Math.max(minSec, cfg.whisper.maxSec ?? minSec);
  const arm = () => {
    // 随机间隔，别像定时闹钟一样准点
    const wait = (minSec + Math.random() * (maxSec - minSec)) * 1000;
    whisperTimer = setTimeout(() => {
      whisperNow();
      arm();
    }, wait);
  };
  arm();
}

// ---------------------------------------------------------------- 菜单

function panelStatus() {
  let quota = normalizeQuota(readSmallJSON(QUOTA_FILE));
  if (quota.connection === 'disconnected' && readSmallJSON(BRIDGE_FILE)?.configured === true) {
    quota = { ...quota, connection: 'missing', source: 'claude-code-statusline', label: 'Code 桥已配置 · 尚未收到用量采样' };
  }
  return {
    version: app.getVersion(), mode: '本地伴随模式', runtime: { energyPaused, pauseReason },
    settings: { petHeight: cfg.pet.height, whisperEnabled: cfg.whisper.enabled,
      wanderEnabled: cfg.wander.enabled, ...cfg.companion },
    quota,
    notices: [...(ledger.notices || []), ...(publicUpdates.notices || [])].slice(0, 20),
    publicUpdates: { checkedAt: publicUpdates.checkedAt, error: publicUpdates.error, source: 'Claude Code 官方更新' },
  };
}

function publishStatus() {
  const status = panelStatus();
  if (panelWin && !panelWin.isDestroyed()) {
    const serialized = JSON.stringify(status);
    if (serialized !== lastPublishedStatus) { lastPublishedStatus = serialized; panelWin.webContents.send('panel:updated', status); }
  }
  if (quotaWin && !quotaWin.isDestroyed() && quotaLoaded) {
    const serialized = JSON.stringify(status.quota);
    if (serialized !== lastPublishedQuota) { lastPublishedQuota = serialized; quotaWin.webContents.send('quota:updated', status.quota); }
  }
}

function petAnchorBounds() {
  const bounds = win.getBounds();
  const anchor = quotaAnchor || { x: (bounds.width - petBox.w) / 2,
    y: bounds.height - cfg.pet.height, width: petBox.w, height: cfg.pet.height };
  return { x: bounds.x + anchor.x, y: bounds.y + anchor.y, width: anchor.width, height: anchor.height };
}

function syncQuotaPopup() {
  if (!quotaWin || quotaWin.isDestroyed() || !quotaLoaded || !win || win.isDestroyed()) return;
  const visible = quotaWanted && cfg.companion.petVisible && win.isVisible() && !systemPaused && !(cfg.companion.fullscreenPause && fullscreenPaused);
  if (!visible) { if (quotaWin.isVisible()) quotaWin.hide(); return; }
  let placement;
  try { placement = placeQuotaPopup(petAnchorBounds(), QUOTA_SIZE, screen.getAllDisplays(), quotaSide); }
  catch { quotaWin.hide(); return; } // A monitor can disappear during hot-plug.
  quotaSide = placement.side;
  const next = { x: placement.x, y: placement.y, width: placement.width, height: placement.height };
  const current = quotaWin.getBounds();
  if (Object.keys(next).some((key) => current[key] !== next[key])) quotaWin.setBounds(next, false);
  if (!quotaWin.isVisible()) quotaWin.showInactive();
}

async function ensureQuotaPopup() {
  if (quotaReady) return quotaReady;
  quotaReady = (async () => {
    quotaWin = new BrowserWindow({ ...QUOTA_SIZE, title: 'Claude 娘 · 额度', frame: false,
      show: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: cfg.window.alwaysOnTop,
      webPreferences: { preload: path.join(import.meta.dirname, 'preload-quota.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    lockDownContents(quotaWin.webContents);
    if (cfg.window.alwaysOnTop) quotaWin.setAlwaysOnTop(true, 'floating');
    quotaWin.on('close', (event) => { if (!quitting) { event.preventDefault(); quotaWanted = false; quotaWin.hide(); } });
    quotaWin.on('closed', () => { quotaWin = null; quotaReady = null; quotaLoaded = false; });
    await quotaWin.loadFile(path.join(import.meta.dirname, 'renderer', 'quota-popup.html'));
    quotaLoaded = true;
    lastPublishedQuota = '';
    publishStatus();
    syncQuotaPopup();
  })().catch((error) => {
    quotaWanted = false; quotaReady = null; quotaLoaded = false;
    if (quotaWin && !quotaWin.isDestroyed()) quotaWin.destroy();
    log('quota popup failed', error.message);
    throw error;
  });
  return quotaReady;
}

async function toggleQuotaPopup() {
  quotaWanted = !quotaWanted;
  if (quotaWanted) await ensureQuotaPopup();
  syncQuotaPopup();
  publishStatus();
}

function syncEnergy() {
  const hidden = !cfg.companion.petVisible;
  const full = cfg.companion.fullscreenPause && fullscreenPaused;
  const next = systemPaused || full || hidden || !cfg.companion.animationsEnabled;
  pauseReason = systemPaused ? '锁屏或休眠' : full ? '全屏节能' : hidden ? '人物已隐藏' : !cfg.companion.animationsEnabled ? '动画已暂停' : '';
  const changed = next !== energyPaused;
  energyPaused = next;
  lastTick = Date.now();
  if (win && !win.isDestroyed()) {
    if (hidden || full || systemPaused) win.hide();
    else if (!win.isVisible()) win.showInactive();
    const preferences = { petHeight: cfg.pet.height, animationsEnabled: cfg.companion.animationsEnabled, energyPaused };
    const serialized = JSON.stringify(preferences);
    if (serialized !== lastRenderPreferences) { lastRenderPreferences = serialized; win.webContents.send('pet:preferences', preferences); }
  }
  syncQuotaPopup();
  if (changed) {
    if (energyPaused) { clearInterval(motionInterval); motionInterval = null; }
    else if (!motionInterval) motionInterval = setInterval(tickMotion, TICK_MS);
    startWhisper(); scheduleWander(); publishStatus();
  }
}

function resizePanel() {
  if (!panelWin || panelWin.isDestroyed()) return;
  const size = { full: [430, 680], compact: [430, 320], minimal: [340, 190] }[cfg.companion.displayMode] || [430, 680];
  panelWin.setMinimumSize(300, 160);
  panelWin.setSize(...size);
}

function syncPreferences() {
  syncEnergy();
  startWhisper();
  scheduleWander();
  if (tray) tray.setContextMenu(buildPetMenu());
  resizePanel();
  publishStatus();
}

function applySettings(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('无效设置');
  for (const key of ['animationsEnabled', 'fullscreenPause', 'petVisible', 'positionLocked', 'resetSoundEnabled', 'publicUpdatesEnabled']) {
    if (typeof patch[key] === 'boolean') cfg.companion[key] = patch[key];
  }
  if (typeof patch.whisperEnabled === 'boolean') cfg.whisper.enabled = patch.whisperEnabled;
  if (typeof patch.wanderEnabled === 'boolean') cfg.wander.enabled = patch.wanderEnabled;
  if (['full', 'compact', 'minimal'].includes(patch.displayMode)) cfg.companion.displayMode = patch.displayMode;
  if (Number.isFinite(patch.petHeight)) {
    cfg.pet.height = Math.round(Math.max(160, Math.min(360, patch.petHeight)));
    clipWidthCache = null; scanSpriteBox(); ensureWindowSize(); place(motion.x, motion.y);
  }
  if (cfg.companion.positionLocked || !cfg.wander.enabled) {
    motion.mode = 'idle'; motion.vx = motion.vy = 0; motion.walkTarget = null;
  }
  saveConfig(cfg);
  syncPreferences();
  return panelStatus();
}

function lockDownContents(contents) {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
  contents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_details, callback) => callback({ cancel: true }));
}

async function showPanel(activate = true) {
  if (!panelWin || panelWin.isDestroyed()) {
    panelWin = new BrowserWindow({ width: 430, height: 680, title: 'Claude 娘 · 控制面板',
      show: false, backgroundColor: '#fff9f1', minimizable: true, fullscreenable: false,
      webPreferences: { preload: path.join(import.meta.dirname, 'preload-panel.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    lockDownContents(panelWin.webContents);
    panelWin.on('close', (event) => { if (!quitting) { event.preventDefault(); panelWin.hide(); } });
    await panelWin.loadFile(path.join(import.meta.dirname, 'renderer', 'panel.html'));
  }
  resizePanel();
  activate ? panelWin.show() : panelWin.showInactive();
  publishStatus();
}

function requirePanel(event) {
  if (!panelWin || event.sender !== panelWin.webContents) throw new Error('不支持的调用来源');
}
ipcMain.handle('panel:status', (event) => { requirePanel(event); return panelStatus(); });
ipcMain.handle('panel:update-settings', (event, patch) => { requirePanel(event); return applySettings(patch); });
ipcMain.handle('panel:action', async (event, action) => {
  requirePanel(event);
  if (action === 'whisper') whisperNow();
  else if (action === 'reset-position') { const p = initialSpot(); motion.mode = 'idle'; place(p.x, p.y, true); }
  else if (action === 'check-updates') await checkPublicUpdates();
  else if (action === 'open-claude-updates') await shell.openExternal(DESKTOP_RELEASES);
  else throw new Error('不支持的操作');
  return panelStatus();
});

function requireQuotaPopup(event) {
  if (!quotaWin || event.sender !== quotaWin.webContents) throw new Error('不支持的调用来源');
}
ipcMain.handle('quota:status', (event) => { requireQuotaPopup(event); return panelStatus().quota; });
ipcMain.handle('quota:action', async (event, action) => {
  requireQuotaPopup(event);
  if (action === 'hide') { quotaWanted = false; syncQuotaPopup(); }
  else if (action === 'settings') await showPanel();
  else throw new Error('不支持的操作');
  return panelStatus().quota;
});

async function checkPublicUpdates() {
  if (updatesInFlight) return;
  updatesInFlight = true;
  try {
    const notice = await fetchPublicRelease();
    publicUpdates = { checkedAt: new Date().toISOString(), error: null, notices: [notice] };
    writeJSON(NEWS_FILE, publicUpdates);
    // Public feature releases are always silent, including first and repeated fetches.
  } catch (error) { publicUpdates.error = error.message; }
  finally { updatesInFlight = false; publishStatus(); }
}

function pollLocalCompanionState() {
  const energy = readSmallJSON(ENERGY_FILE);
  const at = Date.parse(energy?.updatedAt);
  fullscreenPaused = energy?.fullscreen === true && Number.isFinite(at) && Date.now() - at < 60000;
  syncEnergy();
  const quota = normalizeQuota(readSmallJSON(QUOTA_FILE));
  if (quota.connection === 'disconnected') { previousQuota = null; publishStatus(); return; }
  const fresh = confirmedRollovers(previousQuota, quota).filter((notice) => !(ledger.seen || []).includes(notice.id));
  if (fresh.length) {
    const next = { seen: [...(ledger.seen || []), ...fresh.map((n) => n.id)].slice(-1000), notices: [...fresh, ...(ledger.notices || [])].slice(0, 20) };
    try {
      writeJSON(NOTICE_FILE, next); ledger = next;
      if (cfg.companion.resetSoundEnabled) shell.beep();
    } catch (error) { log('notice persistence failed; silent', error.message); }
  }
  previousQuota = quota;
  publishStatus();
}

function buildPetMenu() {
  const faces = Array.from({ length: 10 }, (_, i) => i + 1);
  const clipItem = (label, name) => ({
    id: `clip-${name}`,
    label,
    enabled: Boolean(loadClips()[name]),
    click: () => win && !win.isDestroyed() && win.webContents.send('pet:play-clip', name),
  });
  const template = [
    { id: 'panel', label: '打开控制面板', click: () => showPanel() },
    { label: cfg.companion.petVisible ? '隐藏人物' : '显示人物', click: () => applySettings({ petVisible: !cfg.companion.petVisible }) },
    { label: '锁定人物位置', type: 'checkbox', checked: cfg.companion.positionLocked, click: (item) => applySettings({ positionLocked: item.checked }) },
    { type: 'separator' },
    { id: 'whisper', label: '碎碎念一句', click: () => whisperNow() },
    {
      label: '换个表情',
      submenu: faces.map((n) => ({
        label: `表情 ${n} · ${FACE_LABELS[n - 1] ?? ''}`.trim(),
        id: `face-${n}`,
        click: () => setState(currentState, { face: n, text: null }),
      })),
    },
    {
      label: '动作',
      enabled: !energyPaused,
      submenu: [
        clipItem('抱玩偶', 'hug'),
        clipItem('招手', 'wave'),
        clipItem('比心', 'love'),
        clipItem('看书', 'read'),
        clipItem('想到办法', 'think'),
      ],
    },
    { type: 'separator' },
    {
      label: '回到初始位置',
      id: 'reset-position',
      click: () => {
        const p = initialSpot();
        motion.mode = 'idle';
        motion.walkTarget = null;
        place(p.x, p.y, true);
      },
    },
    {
      label: '重载配置',
      click: () => {
        cfg = loadConfig();
        syncPreferences();
        setState('idle', { text: '配置已重载。' });
      },
    },
    { type: 'separator' },
    { label: '本地伴随模式 · 未连接聊天 / Code hooks', enabled: false },
    { label: '退出', click: () => app.quit() },
  ];
  return Menu.buildFromTemplate(template);
}

function popupMenu() { buildPetMenu().popup({ window: win }); }

// ---------------------------------------------------------------- 窗口

/** Isolated rendering and interaction checks; never read real account data. */
async function runSelfTest() {
  const { default: assert } = await import('node:assert/strict');
  assert(process.env.CLAUDE_CHAN_PET_HOME, 'Self-test requires an explicit isolated CLAUDE_CHAN_PET_HOME');
  const outDir = process.env.CLAUDE_CHAN_PET_QA || path.join(import.meta.dirname, '..', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const report = { mode: 'local-only; no hooks', electron: process.versions.electron, screenshots: [], clips: [], checks: [] };
  const shot = async (name) => {
    const img = await win.capturePage();
    const bitmap = img.toBitmap();
    let clear = 0, visible = 0;
    for (let i = 3; i < bitmap.length; i += 4) {
      if (bitmap[i] === 0) clear++;
      if (bitmap[i] > 100) visible++;
    }
    const size = img.getSize();
    const pixels = bitmap.length / 4;
    assert(visible > pixels * 0.015, `${name}: foreground missing`);
    assert(clear > pixels * 0.1, `${name}: alpha transparency missing`);
    fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
    report.screenshots.push({ name, ...size, transparentFraction: clear / pixels, visibleFraction: visible / pixels });
  };
  const inspect = () => win.webContents.executeJavaScript(`(() => {
    const v = document.getElementById('anim');
    const b = document.getElementById('body');
    return { videoWidth: v.videoWidth, videoHeight: v.videoHeight, time: v.currentTime,
      paused: v.paused, error: v.error?.message || null, clip: document.getElementById('pet').classList.contains('clip'),
      spriteWidth: b.naturalWidth, spriteHeight: b.naturalHeight,
      bubble: document.getElementById('bubble-text').textContent,
      faceShown: !document.getElementById('bubble-face').hidden };
  })()`);
  await sleep(1200);
  assert((await inspect()).spriteWidth > 0, 'sprite loaded');
  await shot('idle');
  const menu = buildPetMenu();
  menu.getMenuItemById('whisper').click();
  await sleep(250);
  assert((await inspect()).bubble.length > 0, 'local whisper');
  await shot('whisper');
  menu.getMenuItemById('face-1').click();
  await sleep(250);
  assert((await inspect()).faceShown, 'expression');
  await shot('face');
  const availableClips = loadClips();
  report.omittedMedia = ['hug', 'wave', 'love', 'read', 'think'].filter((name) => !availableClips[name]);
  for (const name of ['hug', 'wave', 'love', 'read', 'think'].filter((name) => availableClips[name])) {
    menu.getMenuItemById(`clip-${name}`).click();
    await sleep(750);
    const first = await inspect();
    assert(first.videoWidth > 0 && !first.paused && !first.error && first.clip, `${name}: playback`);
    await sleep(250);
    const second = await inspect();
    assert(second.time > first.time, `${name}: frames advance`);
    report.clips.push({ name, first, laterTime: second.time });
    await shot(`clip-${name}`);
  }
  setState('error', { text: '本地交互自检' });
  setState('idle', { text: null });
  await sleep(250);
  const center = await win.webContents.executeJavaScript(`(() => {
    const r = document.getElementById('body').getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  const before = win.getBounds();
  // Electron synthetic input on macOS reports screenX/Y=0. Supply global
  // coordinates to the actual renderer handlers, then verify native bounds.
  const mouse = (type, dx = 0, dy = 0) => win.webContents.executeJavaScript(
    `window.dispatchEvent(new MouseEvent(${JSON.stringify(type)}, {
      clientX: ${center.x + dx}, clientY: ${center.y + dy},
      screenX: ${before.x + center.x + dx}, screenY: ${before.y + center.y + dy}, button: 0, buttons: ${type === 'mouseup' ? 0 : 1}
    }))`,
  );
  await mouse('mousemove');
  await mouse('mousedown');
  await sleep(80);
  assert.equal(motion.mode, 'drag', 'renderer-to-main drag start');
  await mouse('mousemove', -55, -25);
  await sleep(100);
  const moved = win.getBounds();
  assert(Math.abs(moved.x - before.x) >= 40, 'drag moves actual window');
  await sleep(250);
  await mouse('mouseup', -55, -25);
  await sleep(150);
  assert.notEqual(motion.mode, 'drag', 'release ends drag');
  assert.equal(quotaWanted, false, 'drag release never opens quota');
  menu.getMenuItemById('reset-position').click();
  await sleep(100);
  assert.equal(loadState().x, motion.x, 'position persisted');
  assert.equal(win.webContents.getLastWebPreferences().sandbox, true);
  applySettings({ positionLocked: true });
  const locked = win.getBounds();
  await mouse('mousedown'); await mouse('mousemove', -80, -40); await mouse('mouseup', -80, -40);
  await sleep(100);
  assert.equal(win.getBounds().x, locked.x, 'position lock');
  applySettings({ positionLocked: false });

  setState('working', { text: '节能自检' });
  await sleep(600);
  writeJSON(ENERGY_FILE, { fullscreen: true, updatedAt: new Date().toISOString() });
  pollLocalCompanionState();
  await sleep(150);
  const paused = await inspect();
  assert(energyPaused && !win.isVisible() && paused.paused, 'fullscreen hides and pauses decoding');
  await sleep(250);
  assert.equal((await inspect()).time, paused.time, 'fullscreen preserves current video frame');
  writeJSON(ENERGY_FILE, { fullscreen: false, updatedAt: new Date().toISOString() });
  pollLocalCompanionState();
  await sleep(700);
  const resumed = await inspect();
  assert(!energyPaused && win.isVisible() && (!availableClips.read || !resumed.paused), `fullscreen exit restores playback: ${JSON.stringify({ energyPaused, visible: win.isVisible(), resumed })}`);
  writeJSON(ENERGY_FILE, { fullscreen: true, updatedAt: new Date(Date.now() - 120000).toISOString() });
  pollLocalCompanionState();
  assert.equal(energyPaused, false, 'stale fullscreen state cannot keep pet hidden');
  writeJSON(ENERGY_FILE, { fullscreen: false, updatedAt: new Date().toISOString() });
  setState('idle', { text: null });

  writeJSON(BRIDGE_FILE, { configured: false }); // isolated QA directory only
  await showPanel(false);
  await sleep(300);
  assert.equal((await panelWin.webContents.executeJavaScript('window.petPanel.status()')).quota.connection, 'disconnected');
  const gesture = async (events) => {
    const origin = win.getBounds();
    const point = await win.webContents.executeJavaScript(`(() => { const r=document.getElementById('body').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    for (const [type, dx = 0, dy = 0, button = 0] of events) {
      await win.webContents.executeJavaScript(`window.dispatchEvent(new MouseEvent(${JSON.stringify(type)}, {
        clientX:${point.x}, clientY:${point.y}, screenX:${origin.x + point.x + dx}, screenY:${origin.y + point.y + dy},
        button:${button}, buttons:${type === 'mouseup' ? 0 : 1}
      }))`);
      await sleep(45);
    }
    await sleep(100);
    if (quotaWanted) await ensureQuotaPopup();
  };
  await gesture([['mousedown'], ['mouseup']]);
  assert(quotaWanted && quotaWin.isVisible(), 'click opens quota next to pet');
  assert.equal((await quotaWin.webContents.executeJavaScript('window.petQuota.status()')).connection, 'disconnected');
  fs.writeFileSync(path.join(outDir, 'quota-missing.png'), (await quotaWin.capturePage()).toPNG());
  await gesture([['mousedown'], ['mouseup']]);
  assert(!quotaWanted && !quotaWin.isVisible(), 'repeat click hides quota');
  writeJSON(BRIDGE_FILE, { configured: true, source: 'claude-code-statusline', configuredAt: new Date().toISOString() });
  publishStatus();
  assert.equal((await panelWin.webContents.executeJavaScript('window.petPanel.status()')).quota.connection, 'missing');
  // Synthetic input is confined to SELF_TEST's isolated home, never production.
  writeJSON(QUOTA_FILE, { source: 'claude-official-usage-page', updatedAt: new Date().toISOString(), windows: {
    fiveHour: { usedPercent: 25, resetsAt: null, resetText: 'Starts with your first message' },
    sevenDay: { usedPercent: 40, resetsAt: null, resetText: 'Resets Thursday 6:00 AM' },
  } });
  publishStatus();
  for (const mode of ['full', 'compact', 'minimal']) {
    await panelWin.webContents.executeJavaScript(`window.petPanel.updateSettings({displayMode: '${mode}'})`);
    await sleep(200);
    const image = await panelWin.capturePage();
    fs.writeFileSync(path.join(outDir, `panel-${mode}.png`), image.toPNG());
    const overflow = await panelWin.webContents.executeJavaScript('document.documentElement.scrollWidth > innerWidth');
    assert.equal(overflow, false, `panel ${mode}: horizontal overflow`);
    const quotaText = await panelWin.webContents.executeJavaScript(`({ five: document.getElementById('five-hour-value').textContent, seven: document.getElementById('seven-day-value').textContent, source: document.getElementById('quota-source').textContent, reset: document.getElementById('five-hour-reset').textContent })`);
    assert.equal(quotaText.five, '75%');
    assert.equal(quotaText.seven, '60%');
    assert.match(quotaText.source, /官方.*手动快照/);
    assert.match(quotaText.reset, /first message/);
  }
  await panelWin.webContents.executeJavaScript('window.petPanel.updateSettings({displayMode:"full",whisperEnabled:false})');
  assert.equal(cfg.whisper.enabled, false, 'panel settings IPC');
  await panelWin.webContents.executeJavaScript('window.petPanel.updateSettings({whisperEnabled:true})');
  await panelWin.webContents.executeJavaScript('window.scrollTo(0, document.documentElement.scrollHeight)');
  await sleep(150);
  fs.writeFileSync(path.join(outDir, 'panel-settings.png'), (await panelWin.capturePage()).toPNG());
  assert.equal(panelWin.webContents.getLastWebPreferences().sandbox, true);
  panelWin.hide();
  await gesture([['mousedown'], ['mouseup']]);
  assert(quotaWanted && quotaWin.isVisible(), 'reopen quota with one click');
  const popupValue = await quotaWin.webContents.executeJavaScript(`({first:document.getElementById('session-value').textContent,second:document.getElementById('week-value').textContent,overflow:document.documentElement.scrollWidth>innerWidth||document.documentElement.scrollHeight>innerHeight})`);
  assert.equal(popupValue.first, '75%'); assert.equal(popupValue.second, '60%');
  assert.equal(popupValue.overflow, false, 'quota content fits small window');
  fs.writeFileSync(path.join(outDir, 'quota-snapshot.png'), (await quotaWin.capturePage()).toPNG());
  const assertAnchored = () => {
    const q = quotaWin.getBounds(), anchor = petAnchorBounds();
    const placement = placeQuotaPopup(anchor, QUOTA_SIZE, screen.getAllDisplays(), quotaSide);
    const area = screen.getAllDisplays().find((d) => d.id === placement.displayId).workArea;
    assert(q.x >= area.x && q.y >= area.y && q.x + q.width <= area.x + area.width && q.y + q.height <= area.y + area.height, 'quota stays within display work area');
    return { pet: win.getBounds(), anchor, quota: q, side: quotaSide, workArea: area };
  };
  const initialQuota = assertAnchored();
  await gesture([['mousedown'], ['mousemove', -55, -15], ['mouseup', -55, -15]]);
  assert(quotaWanted && quotaWin.isVisible(), 'drag does not toggle open quota');
  const movedQuota = assertAnchored();
  assert.notDeepEqual(movedQuota.quota, initialQuota.quota, 'quota follows actual drag');
  await gesture([['mousedown'], ['mousemove', 25], ['mousemove', 0], ['mouseup']]);
  assert.equal(quotaWanted, true, 'out-and-back drag cannot become click');
  await gesture([['mousedown'], ['mousemove', 3, 2], ['mouseup', 3, 2]]);
  assert.equal(quotaWanted, false, 'small pointer jitter remains a click');
  await gesture([['mousedown'], ['mouseup']]);
  await win.webContents.executeJavaScript('window.pet.toggleQuota(); window.pet.toggleQuota();');
  await sleep(80);
  assert(quotaWanted && quotaWin.isVisible(), 'rapid pair of toggles preserves final intent');
  assert.equal(BrowserWindow.getAllWindows().filter((w) => w === quotaWin).length, 1, 'single quota window');
  const area = workArea(), savedHeight = cfg.pet.height;
  const positions = [];
  motion.mode = 'idle'; motion.vx = motion.vy = 0;
  for (const x of [area.x, area.x + area.width - winSize().w]) {
    place(x, area.y + area.height - winSize().h);
    await sleep(80);
    positions.push(assertAnchored());
  }
  assert.notEqual(positions[0].side, positions[1].side, 'edges choose opposite available sides');
  const beforeWalk = quotaWin.getBounds();
  motion.mode = 'walk'; motion.facing = -1; motion.walkTarget = motion.x - 20;
  step(.2); placeThrottled(); await sleep(80);
  assert.notDeepEqual(quotaWin.getBounds(), beforeWalk, 'quota follows walking');
  motion.mode = 'idle'; motion.walkTarget = null;
  applySettings({ petHeight: 180 }); await sleep(120); assertAnchored();
  applySettings({ petHeight: savedHeight }); await sleep(120); assertAnchored();
  applySettings({ petVisible: false });
  assert(!quotaWin.isVisible() && quotaWanted, 'hiding pet also hides quota without losing intent');
  applySettings({ petVisible: true });
  assert(quotaWin.isVisible(), 'showing pet restores anchored quota');
  fullscreenPaused = true; syncEnergy(); assert(!quotaWin.isVisible(), 'fullscreen hides quota');
  fullscreenPaused = false; syncEnergy(); assert(quotaWin.isVisible(), 'fullscreen exit restores quota');
  applySettings({ positionLocked: true });
  await gesture([['mousedown'], ['mouseup']]); assert.equal(quotaWanted, false, 'locked pet still toggles quota');
  applySettings({ positionLocked: false });
  await gesture([['mousedown'], ['mouseup']]);
  await quotaWin.webContents.executeJavaScript(`window.petQuota.action('hide')`);
  assert(!quotaWanted && !quotaWin.isVisible(), 'popup close button action hides it');
  report.quotaPopup = { initial: initialQuota, moved: movedQuota, edges: positions, displays: screen.getAllDisplays().map(({id,bounds,workArea,scaleFactor}) => ({id,bounds,workArea,scaleFactor})) };
  report.checks.push('click/repeat/jitter/drag-out-and-back/rapid-toggle quota gestures', 'quota follows dragging, walking and resizing', 'quota edge switching and work area limits', 'quota pet-hide/fullscreen recovery', 'quota missing state and real renderer percentages');
  report.checks.push('position lock', 'fullscreen pause/frame preservation/resume', 'stale fullscreen recovery', 'disconnected and configured-awaiting-data quota panel', 'official usage page snapshot with unknown reset times', 'three panel layouts', 'settings IPC');
  report.checks.push('sprite', 'transparent canvas', `${report.clips.length} supplied animated clips; missing media explicitly skipped`, 'menu callbacks', 'local whisper', 'expression', 'renderer mouse drag and release', 'position persistence', 'sandbox');
  report.drag = { before, moved, restored: win.getBounds() };
  report.networkAndHooks = 'HTTP/WebSocket requests denied; no event tail or hook execution';
  fs.writeFileSync(path.join(outDir, 'selftest-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ result: 'PASS', screenshots: report.screenshots.length, clips: report.clips.length, outDir }));
  app.quit();
}

async function createWindow() {
  const saved = loadState();
  const spot = initialSpot();
  // 只恢复横向位置：纵坐标一律回到"站在地面"，
  // 免得上次异常退出（或拖拽没收到 mouseup）留下的半空坐标被复现
  scanSpriteBox();
  motion.x = Number.isFinite(saved.x) ? saved.x : spot.x;
  motion.y = spot.y;
  const { w, h } = winSize();

  win = new BrowserWindow({
    x: Math.round(motion.x),
    y: Math.round(motion.y),
    width: w,
    height: h,
    frame: false,
    transparent: cfg.pet.transparent,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: cfg.window.alwaysOnTop,
    opacity: cfg.pet.opacity,
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
  win.webContents.session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_details, callback) => callback({ cancel: true }),
  );
  win.webContents.on('console-message', (details) => {
    if (details.level === 'error') log('renderer-error', details.message);
  });
  win.webContents.on('render-process-gone', (_event, details) => log('renderer-gone', details.reason));

  if (cfg.window.alwaysOnTop) win.setAlwaysOnTop(true, 'floating');
  // 三重锁：不允许缩放/最大化/最小化。实测拖窗口边缘会把窗口拉大，
  // 而窗口一变大，宠物就不再贴窗口底部——可放置范围被压缩、站立线也会算错。
  win.setResizable(false);
  win.setMaximizable(false);
  win.setMinimizable(false);
  // min=max 也挡不住鼠标抓边框改尺寸（实测日志里窗口被拉到 343x412 过），
  // 所以在 will-resize 里直接拒掉，这是最后一道。
  win.on('will-resize', (event) => {
    event.preventDefault();
    log('will-resize blocked');
  });
  // 诊断：窗口尺寸被改时记录是谁改的。我自己只会通过 setBounds 改，
  // 所以只要出现"没经过 ensureWindowSize 的 resized"，就是外部在动它。
  win.on('resized', () => {
    const b = win.getBounds();
    log(`resized -> ${b.width}x${b.height} (internal=${resizingInternally})`);
    if (!resizingInternally) {
      // 被外部或 Chromium 改过尺寸时，**置顶会丢**。丢了桌宠就掉到别的窗口下面
      // （实测用户看到 Claude 应用的文字压在角色上面）。所以这里必须立刻重申，
      // 只靠那个 5 秒的 flag 重申抢不过。
      win.setAlwaysOnTop(true, 'screen-saver');
      win.moveTop();
    }
  });
  // 透明窗口里，非宠物身体的部分要点击穿透到下层应用；渲染层按悬停命中翻回来
  for (const event of ['move', 'resize', 'show', 'hide']) win.on(event, syncQuotaPopup);
  win.setIgnoreMouseEvents(true, { forward: !SELF_TEST });
  await win.loadFile(path.join(import.meta.dirname, 'renderer', 'index.html'));
  const b = win.getBounds();
  log(`window created ${b.width}x${b.height} at ${b.x},${b.y} (workArea ${JSON.stringify(workArea())})`);
  lockWindowSize(winSize());
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

ipcMain.on('pet:sprite-size', (_e, { w, h }) => {
  // 窗口尺寸现在由主进程扫 PNG 头决定（scanSpriteBox），这里只留一行日志做对照
  log(`renderer reports sprite ${w}x${h} (window size comes from scanSpriteBox)`);
});

ipcMain.on('pet:drag-start', (_e, payload = {}) => {
  if (cfg.companion.positionLocked) return;
  const { screenX, screenY } = payload;
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) {
    log(`drag-start ignored: bad payload ${JSON.stringify(payload)}`);
    return;
  }
  motion.mode = 'drag';
  motion.walkTarget = null;
  motion.grab = { dx: motion.x - screenX, dy: motion.y - screenY };
  lastDragAt = Date.now();
  log(`drag-start cursor=${Math.round(screenX)},${Math.round(screenY)} win=${Math.round(motion.x)},${Math.round(motion.y)}`);
});

ipcMain.on('pet:drag-move', (_e, payload = {}) => {
  if (cfg.companion.positionLocked) return;
  const { screenX, screenY } = payload;
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return;
  if (motion.mode !== 'drag') {
    // drag-start 没到就地补一个：实测出过"drag-end 一直有、drag-start 一条都没有"
    // 的情况（渲染层在两者之间抛了异常）。用第一个 drag-move 的坐标 + 当前窗口位置
    // 反推 grab 偏移，与正常的 drag-start 完全等价，不再依赖那条消息。
    motion.mode = 'drag';
    motion.walkTarget = null;
    motion.grab = { dx: motion.x - screenX, dy: motion.y - screenY };
    log(`drag-start (inferred from drag-move) cursor=${Math.round(screenX)},${Math.round(screenY)}`);
  }
  lastDragAt = Date.now();
  place(screenX + motion.grab.dx, screenY + motion.grab.dy);
});

ipcMain.on('pet:drag-end', (_e, payload = {}) => {
  log(`drag-end mode=${motion.mode} v=${Math.round(payload.vx || 0)},${Math.round(payload.vy || 0)}`);
  if (motion.mode !== 'drag') return;
  const vx = Number.isFinite(payload.vx) ? payload.vx : 0;
  const vy = Number.isFinite(payload.vy) ? payload.vy : 0;
  const speed = Math.hypot(vx, vy);
  if (speed < (cfg.physics.dropThresholdPx ?? 140)) {
    // 温柔放下：原地停住，不启动重力。
    // 这一条是把宠物放到桌面任意位置的前提——否则每次松手都被重力拽回底线。
    motion.mode = 'idle';
    motion.vx = 0;
    motion.vy = 0;
    motion.facing = 1;
    pushMotion(true);
    saveState({ x: motion.x, y: motion.y });
    scheduleWander();
    log(`drop in place at ${Math.round(motion.x)},${Math.round(motion.y)} (speed ${Math.round(speed)})`);
    return;
  }
  const p = cfg.physics.throwPower ?? 1;
  const cap = (v) => Math.max(-VELOCITY_CAP, Math.min(VELOCITY_CAP, v * p));
  motion.vx = cap(vx);
  motion.vy = cap(vy);
  motion.mode = 'throw';
  motion.vx !== 0 && (motion.facing = motion.vx > 0 ? 1 : -1);
  pushMotion(true);
  log(`throw v=${Math.round(vx)},${Math.round(vy)}`);
});

ipcMain.on('pet:menu', () => popupMenu());
ipcMain.on('pet:toggle-quota', (event) => {
  if (!win || event.sender !== win.webContents) return;
  toggleQuotaPopup().catch(() => {}); // Failure is logged at the window creation boundary.
});
ipcMain.on('pet:anchor', (event, anchor) => {
  if (!win || event.sender !== win.webContents || !anchor || typeof anchor !== 'object') return;
  const bounds = win.getBounds();
  if (!['x', 'y', 'width', 'height'].every((key) => Number.isFinite(anchor[key])) ||
      anchor.width <= 0 || anchor.height <= 0 || anchor.width > bounds.width + 20 || anchor.height > bounds.height + 20 ||
      anchor.x < -10 || anchor.y < -10 || anchor.x + anchor.width > bounds.width + 10 || anchor.y + anchor.height > bounds.height + 10) return;
  quotaAnchor = { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height };
  syncQuotaPopup();
});
ipcMain.on('pet:frames', (_e, stats) => {
  log(
    `frames[${stats.label}] n=${stats.frames} p50=${stats.p50}ms p95=${stats.p95}ms worst=${stats.worst}ms over32ms=${stats.over32}`,
  );
});
ipcMain.handle('pet:whisper', () => whisperNow());
function loadClips() {
  // 动作片段由 scripts/make-emote-clips.py 生成，manifest 不存在就当作没有
  try {
    const file = path.join(import.meta.dirname, '..', 'assets', 'pet', 'anims', 'manifest.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')).clips ?? {};
  } catch {
    return {};
  }
}

ipcMain.handle('pet:config', () => ({
  petHeight: cfg.pet.height,
  whisperEnabled: cfg.whisper.enabled,
  clips: loadClips(),
  animationsEnabled: cfg.companion.animationsEnabled,
  energyPaused,
}));

app.on('second-instance', () => {
  log('second-instance suppressed');
  if (win && !win.isDestroyed()) win.showInactive();
});
app.on('activate', () => {
  if (win && !win.isDestroyed()) win.showInactive();
});

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock.hide();
  Menu.setApplicationMenu(null);
  await createWindow();
  if (SELF_TEST) {
    try { await runSelfTest(); }
    catch (err) { log('selftest failed', err.stack); console.error(err); app.exit(1); }
    return;
  }
  log('local companion ready; event bridge disabled');
  const icon = nativeImage.createFromPath(path.join(import.meta.dirname, '..', 'assets', 'pet', 'front.png')).resize({ width: 20, height: 23 });
  tray = new Tray(icon);
  tray.setToolTip('Claude 娘桌宠');
  tray.on('click', () => showPanel());
  syncPreferences();
  for (const event of ['suspend', 'lock-screen']) powerMonitor.on(event, () => { systemPaused = true; syncEnergy(); });
  for (const event of ['resume', 'unlock-screen']) powerMonitor.on(event, () => { systemPaused = false; syncEnergy(); });
  setInterval(pollLocalCompanionState, 1000);
  pollLocalCompanionState();
  if (cfg.companion.publicUpdatesEnabled) checkPublicUpdates();
  setInterval(() => { if (cfg.companion.publicUpdatesEnabled) checkPublicUpdates(); }, 6 * 60 * 60 * 1000);
  startWhisper();
  scheduleWander();
  if (cfg.window.alwaysOnTop && cfg.window.topmostWatchdog) {
    setInterval(() => {
      if (!win || win.isDestroyed()) return;
      ensureWindowSize();
      // 必须带 moveTop()：实测窗口被改尺寸时**置顶会丢**，而那次改尺寸连 Electron 的
      // 'resized' 事件都不触发（所以不能只挂在事件上）。只重申 flag 不够，得真的抬 z 序。
      win.setAlwaysOnTop(true, 'screen-saver');
      win.moveTop();
    }, 8000);
  }
  for (const event of ['display-metrics-changed', 'display-added', 'display-removed']) {
    screen.on(event, () => { place(motion.x, motion.y, true); syncQuotaPopup(); });
  }
});

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => app.quit());
