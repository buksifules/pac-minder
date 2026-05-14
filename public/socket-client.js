'use strict';

// ─── Character registry ───────────────────────────────────────────────────────
// Maps lobby HTML element ID → character name (must match server strings exactly)
const CHAR_MAP = {
  'char-1': 'Marci 1',
  'char-2': 'Marci 2',
  'char-3': 'Csaba 1',
};

// Maps character name → SVG asset URL (used in lobby + leaderboard avatars)
const CHAR_SVG = {
  'Marci 1': '/assets/marci1.svg',
  'Marci 2': '/assets/marci2.svg',
  'Csaba 1': '/assets/csaba1.svg',
};

// Maps lobby character element IDs → their avatar container IDs
const AVATAR_CONTAINER_MAP = {
  'char-1': 'avatar-container-1',
  'char-2': 'avatar-container-2',
  'char-3': 'avatar-container-3',
};

// ─── Screens ──────────────────────────────────────────────────────────────────
const ALL_SCREENS = ['menu-screen', 'lobby-screen', 'game-screen', 'end-screen'];

function showScreen(id) {
  for (const sid of ALL_SCREENS) {
    document.getElementById(sid).classList.add('hidden');
  }
  document.getElementById(id).classList.remove('hidden');
}

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  socket:      null,
  myId:        null,
  roomCode:    null,
  isHost:      false,
  myCharacter: null,
  myName:      'Player',
};

// ─── Lobby SVG injection ──────────────────────────────────────────────────────
/*
 * Replaces the placeholder <div> inside each avatar container with an <img>
 * pointing at the real SVG asset.  Uses the `pm-avatar-img` class (style.css)
 * so the image fills the rounded container correctly.
 */
function injectLobbyAvatars() {
  for (const [charElemId, containerId] of Object.entries(AVATAR_CONTAINER_MAP)) {
    const container = document.getElementById(containerId);
    if (!container) continue;

    const charName = CHAR_MAP[charElemId];
    const src      = CHAR_SVG[charName];
    if (!src) continue;

    // Wipe the placeholder div
    container.innerHTML = '';

    const img = document.createElement('img');
    img.src   = src;
    img.alt   = charName;
    img.className = 'pm-avatar-img'; // defined in style.css
    container.appendChild(img);
  }
}

// ─── Character slot locking ───────────────────────────────────────────────────
/*
 * Three visual states per slot:
 *  • FREE     – no extra classes
 *  • SELECTED – subtle background tint + hard inset outline (brutalist, no colour)
 *  • LOCKED   – `.locked` CSS class → 35 % opacity + 1 px diagonal strike-through
 *               (defined in style.css; pointer-events disabled)
 */
function updateCharacterSlots(takenCharacters) {
  const takenMap = {};
  for (const t of takenCharacters) takenMap[t.character] = t.sid;

  for (const [elemId, charName] of Object.entries(CHAR_MAP)) {
    const el = document.getElementById(elemId);
    if (!el) continue;

    // ── Reset all state ──────────────────────────────────────────────────
    el.querySelectorAll('.pm-taken-badge').forEach(n => n.remove());
    el.classList.remove('locked');
    el.style.background = '';
    el.style.boxShadow  = '';

    const takenByMe    = takenMap[charName] === state.socket?.id;
    const takenByOther = !!takenMap[charName] && takenMap[charName] !== state.socket?.id;

    if (takenByMe) {
      // ── SELECTED: yellow fill ────────────────────────────────────────
      el.style.background = '#EEBB2A';
      el.style.boxShadow  = '';

    } else if (takenByOther) {
      // ── LOCKED: .locked class handles opacity + diagonal strikethrough
      el.classList.add('locked');

      // Stamp "TAKEN" in the top-right corner for clarity
      const badge = document.createElement('span');
      badge.className = 'pm-taken-badge';
      badge.style.cssText = [
        "font-family:'Space Grotesk',sans-serif",
        'font-size:.6rem',
        'font-weight:700',
        'letter-spacing:.1em',
        'text-transform:uppercase',
        'color:#000',
        'border:1px solid #000',
        'padding:2px 6px',
        'position:absolute',
        'top:6px',
        'right:6px',
        'z-index:30',        // above the ::before stripe
        'pointer-events:none',
        'background:#f9f9f9',
      ].join(';');
      badge.textContent = 'TAKEN';
      el.appendChild(badge);
    }
  }
}

// ─── Host / Start button visibility ──────────────────────────────────────────
function syncStartButton() {
  const btn = document.getElementById('btn-start-game');
  if (!btn) return;
  btn.classList.toggle('hidden', !state.isHost);
}

// ─── Error toast (auto-removes after 3.5 s) ───────────────────────────────────
function showError(msg, anchorId = 'btn-join') {
  document.getElementById('pm-error-toast')?.remove();

  const toast = document.createElement('p');
  toast.id = 'pm-error-toast';
  toast.style.cssText = [
    "font-family:'Space Grotesk',sans-serif",
    'font-size:.75rem',
    'font-weight:700',
    'letter-spacing:.05em',
    'color:#000',
    'margin-top:6px',
  ].join(';');
  toast.textContent = `⚠ ${msg}`;

  document.getElementById(anchorId)?.insertAdjacentElement('afterend', toast);
  setTimeout(() => toast.remove(), 3500);
}

// ─── Countdown overlay (fullscreen, injected dynamically) ─────────────────────
function showCountdownOverlay(count) {
  let overlay = document.getElementById('pm-countdown-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'pm-countdown-overlay';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'background:#f9f9f9',
      'display:flex', 'flex-direction:column',
      'align-items:center', 'justify-content:center', 'z-index:9999',
    ].join(';');

    const num = document.createElement('div');
    num.id = 'pm-countdown-num';
    num.style.cssText = [
      "font-family:'Press Start 2P',system-ui",
      'font-size:clamp(4.5rem,20vw,8rem)',
      'color:#000', 'line-height:1',
      'transition:transform .12s ease',
    ].join(';');

    const label = document.createElement('div');
    label.style.cssText = [
      "font-family:'Space Grotesk',sans-serif",
      'font-size:.8rem', 'font-weight:700',
      'letter-spacing:.25em', 'text-transform:uppercase',
      'margin-top:1.75rem', 'color:#000',
    ].join(';');
    label.textContent = 'GET READY';

    overlay.append(num, label);
    document.body.appendChild(overlay);
  }

  const numEl = document.getElementById('pm-countdown-num');
  numEl.textContent = count;
  numEl.style.transform = 'scale(1.22)';
  setTimeout(() => { numEl.style.transform = 'scale(1)'; }, 120);
}

function hideCountdownOverlay() {
  document.getElementById('pm-countdown-overlay')?.remove();
}

// ─── Leaderboard ─────────────────────────────────────────────────────────────
/*
 * Populates #leaderboard-list with one row per player.
 * Each row uses the existing grid-cols-4 column layout from index.html:
 *   col 1 : rank label
 *   col 2–3 : avatar + name (flex inside a 2-span cell)
 *   col 4 : score (Press Start 2P)
 */
function renderLeaderboard(leaderboard) {
  const list = document.getElementById('leaderboard-list');
  list.innerHTML = '';

  const RANK_LABELS = ['#1', '#2', '#3'];

  leaderboard.forEach((entry, i) => {
    const row = document.createElement('div');
    row.className = 'grid grid-cols-4 py-4 px-2 border-b border-primary items-center';
    if (i === 0) row.style.background = 'rgba(0,0,0,0.04)';

    const avatarSrc = CHAR_SVG[entry.character] ?? '';
    const avatarHtml = avatarSrc
      ? `<img src="${avatarSrc}" alt="${escHtml(cleanDisplayName(entry.character))}"
              class="pm-avatar-img"
              style="width:2rem;height:2rem;border-radius:9999px;border:1px solid #000;flex-shrink:0;"/>`
      : `<div style="width:2rem;height:2rem;border-radius:9999px;border:1px solid #000;background:#e0e0e0;flex-shrink:0;"></div>`;

    row.innerHTML = `
      <div class="col-span-1 text-left font-bold text-[13px]"
           style="font-family:'Space Grotesk',sans-serif;">
        ${RANK_LABELS[i] ?? `#${i + 1}`}
      </div>
      <div class="col-span-2 flex items-center gap-2">
        ${avatarHtml}
        <span class="font-bold text-[13px] truncate"
              style="font-family:'Space Grotesk',sans-serif;">
          ${escHtml(cleanDisplayName(entry.name))}
        </span>
      </div>
      <div class="col-span-1 text-right font-bold text-[12px]"
           style="font-family:'Press Start 2P',system-ui; word-break:break-all;">
        ${entry.score}
      </div>
    `;
    list.appendChild(row);
  });
}

// ─── Confetti (monochrome, Brutalist palette) ─────────────────────────────────
function runConfetti() {
  let cv = document.getElementById('pm-confetti-canvas');
  if (!cv) {
    cv = document.createElement('canvas');
    cv.id = 'pm-confetti-canvas';
    cv.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9990;';
    document.body.appendChild(cv);
  }
  cv.width  = window.innerWidth;
  cv.height = window.innerHeight;
  const ctx = cv.getContext('2d');

  const TONES = ['#EEBB2A', '#25432B'];
  const pieces = Array.from({ length: 90 }, () => ({
    x:         Math.random() * cv.width,
    y:         Math.random() * -cv.height * 0.5,
    r:         Math.random() * 6 + 3,
    d:         Math.random() * 60 + 20,
    tone:      TONES[Math.floor(Math.random() * TONES.length)],
    tiltAngle: Math.random() * Math.PI * 2,
    tiltSpeed: Math.random() * .07 + .04,
    tilt:      0,
  }));

  let frame = 0;
  (function draw() {
    ctx.clearRect(0, 0, cv.width, cv.height);
    frame++;
    for (const p of pieces) {
      p.tiltAngle += p.tiltSpeed;
      p.y    += Math.cos(frame / 18 + p.d) + 2.0;
      p.x    += Math.sin(frame / 30) * 0.5;
      p.tilt  = Math.sin(p.tiltAngle) * 11;
      if (p.y > cv.height) { p.x = Math.random() * cv.width; p.y = -8; }
      ctx.beginPath();
      ctx.lineWidth   = p.r;
      ctx.strokeStyle = p.tone;
      ctx.moveTo(p.x + p.tilt + p.r / 2, p.y);
      ctx.lineTo(p.x + p.tilt,            p.y + p.tilt + p.r / 2);
      ctx.stroke();
    }
    if (frame < 380) requestAnimationFrame(draw);
    else { ctx.clearRect(0, 0, cv.width, cv.height); cv.remove(); }
  })();
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function cleanDisplayName(name) {
  return String(name ?? '').replace(/\s*\d+\s*$/, '').trim();
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Ambient menu animation ───────────────────────────────────────────────────
/*
 * Runs only while #menu-screen is visible.
 * Canvas is position:fixed (full viewport) but lives inside #menu-ambient-bg,
 * so it's automatically hidden when menu-screen gets display:none.
 * Scene is rotated 35° for an isometric feel; characters drift and eat dots.
 */
const _ambient = {
  rafId:     null,
  canvas:    null,
  resizeFn:  null,

  start() {
    this.stop();
    const container = document.getElementById('menu-ambient-bg');
    if (!container) return;

    const cv = document.createElement('canvas');
    cv.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:1;';
    cv.width  = window.innerWidth;
    cv.height = window.innerHeight;
    container.innerHTML = '';
    container.appendChild(cv);
    this.canvas = cv;

    this.resizeFn = () => { cv.width = window.innerWidth; cv.height = window.innerHeight; };
    window.addEventListener('resize', this.resizeFn);

    const ctx  = cv.getContext('2d');
    const GRID = 42;
    const R    = 18; // character radius

    // Preload SVG assets — start animation only after all settle
    const charKeys = ['Marci 1', 'Marci 2', 'Csaba 1'];
    const charImgs = {};
    const loadPromises = charKeys.map(key => new Promise(resolve => {
      const img = new Image();
      img.onload = img.onerror = resolve;
      img.src = CHAR_SVG[key];
      charImgs[key] = img;
    }));

    // Dot grid (individual dots respawn after being eaten)
    const dots = [];
    for (let x = GRID; x < cv.width  + GRID * 2; x += GRID)
      for (let y = GRID; y < cv.height + GRID * 2; y += GRID)
        if (Math.random() > 0.38) dots.push({ x, y, on: true });

    // 3 characters with axis-aligned velocities (px/s)
    const chars = [
      { key: 'Marci 1', x: cv.width * 0.28, y: cv.height * 0.38, vx:  58, vy:   0, mouth: 0,   mDir:  1 },
      { key: 'Marci 2', x: cv.width * 0.65, y: cv.height * 0.55, vx:   0, vy:  46, mouth: 0.7, mDir:  1 },
      { key: 'Csaba 1', x: cv.width * 0.50, y: cv.height * 0.22, vx: -52, vy:   0, mouth: 1.1, mDir: -1 },
    ];

    let prev = null;
    const frame = ts => {
      if (!this.canvas) return;
      this.rafId = requestAnimationFrame(frame);

      const dt = Math.min(ts - (prev ?? ts), 80);
      prev = ts;

      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.save();
      ctx.globalAlpha = 0.14;

      // Rotate entire scene 35° around viewport centre
      ctx.translate(cv.width / 2, cv.height / 2);
      ctx.rotate(35 * Math.PI / 180);
      ctx.translate(-cv.width / 2, -cv.height / 2);

      // Draw dots
      ctx.fillStyle = '#000';
      for (const d of dots) {
        if (!d.on) continue;
        ctx.beginPath();
        ctx.arc(d.x, d.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }

      // Update and draw each character
      for (const ch of chars) {
        const spd = Math.hypot(ch.vx, ch.vy);

        // Mouth oscillation
        ch.mouth += dt * 0.007 * ch.mDir;
        if (ch.mouth > 1.3 || ch.mouth < 0) ch.mDir *= -1;

        // Move
        ch.x += ch.vx * (dt / 1000);
        ch.y += ch.vy * (dt / 1000);

        // Wrap around viewport edges
        if (ch.x < -R * 3) ch.x = cv.width  + R;
        if (ch.x > cv.width  + R * 3) ch.x = -R;
        if (ch.y < -R * 3) ch.y = cv.height + R;
        if (ch.y > cv.height + R * 3) ch.y = -R;

        // Random 90° turn (avg ~once per 4 s)
        if (Math.random() < dt / 4000) {
          const ang  = Math.atan2(ch.vy, ch.vx);
          const turn = Math.random() < 0.5 ? Math.PI / 2 : -Math.PI / 2;
          ch.vx = Math.round(Math.cos(ang + turn)) * spd;
          ch.vy = Math.round(Math.sin(ang + turn)) * spd;
        }

        // Eat nearby dots
        for (const d of dots) {
          if (d.on && Math.hypot(ch.x - d.x, ch.y - d.y) < R + 4) {
            d.on = false;
            setTimeout(() => { d.on = true; }, 3500 + Math.random() * 5000);
          }
        }

        // Draw: SVG clipped to the mouth-opening pac-shape
        const ang = Math.atan2(ch.vy, ch.vx);
        const mo  = (Math.sin(ch.mouth) * 0.5 + 0.5) * 0.28 + 0.03;
        const img = charImgs[ch.key];

        ctx.save();
        ctx.translate(ch.x, ch.y);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, R, ang + mo * Math.PI, ang + (2 - mo) * Math.PI);
        ctx.closePath();

        if (img.complete && img.naturalWidth > 0) {
          ctx.save();
          ctx.clip();
          ctx.drawImage(img, -R, -R, R * 2, R * 2);
          ctx.restore();
        } else {
          ctx.fillStyle = '#000';
          ctx.fill();
        }
        ctx.restore();
      }

      ctx.restore();
    };

    // Start RAF only after all images have settled (loaded or errored)
    Promise.allSettled(loadPromises).then(() => {
      if (this.canvas) this.rafId = requestAnimationFrame(frame);
    });
  },

  stop() {
    if (this.rafId)   { cancelAnimationFrame(this.rafId); this.rafId = null; }
    if (this.resizeFn){ window.removeEventListener('resize', this.resizeFn); this.resizeFn = null; }
    if (this.canvas)  { this.canvas.remove(); this.canvas = null; }
  },
};

// ─── Reset on "New Game" ──────────────────────────────────────────────────────
function resetClientState() {
  state.myCharacter = null;
  state.isHost      = false;
  state.roomCode    = null;

  document.getElementById('input-room-code').value   = '';
  document.getElementById('input-player-name').value  = '';

  for (const elemId of Object.keys(CHAR_MAP)) {
    const el = document.getElementById(elemId);
    if (!el) continue;
    el.querySelectorAll('.pm-taken-badge').forEach(n => n.remove());
    el.classList.remove('locked');
    el.style.background = '';
    el.style.boxShadow  = '';
  }

  if (state.socket) { state.socket.disconnect(); state.socket = null; }
  connectSocket();
}

// ─── Socket setup ─────────────────────────────────────────────────────────────
function connectSocket() {
  if (state.socket) return;
  state.socket = io();

  state.socket.on('connect', () => { state.myId = state.socket.id; });

  // ── Room events ────────────────────────────────────────────────────────────
  state.socket.on('room:created', ({ code, isHost }) => {
    state.roomCode = code;
    state.isHost   = isHost;
    document.getElementById('display-room-code').textContent = code;
    _ambient.stop();
    showScreen('lobby-screen');
    syncStartButton();
    state.socket.emit('player:join_lobby', { name: state.myName, code });
  });

  state.socket.on('room:joined', ({ code, isHost }) => {
    state.roomCode = code;
    state.isHost   = isHost;
    document.getElementById('display-room-code').textContent = code;
    _ambient.stop();
    showScreen('lobby-screen');
    syncStartButton();
    state.socket.emit('player:join_lobby', { name: state.myName, code });
  });

  state.socket.on('room:error', ({ msg }) => showError(msg, 'btn-join'));

  // ── Lobby sync ─────────────────────────────────────────────────────────────
  state.socket.on('lobby:update', (lobbyData) => {
    if (lobbyData.host === state.socket.id) {
      state.isHost = true;
      syncStartButton();
    }
    updateCharacterSlots(lobbyData.takenCharacters);

    // Render player list with cleaned names
    const playerListEl = document.getElementById('lobby-player-list');
    if (playerListEl && lobbyData.players) {
      playerListEl.innerHTML = '';
      for (const p of lobbyData.players) {
        const li = document.createElement('li');
        li.textContent = cleanDisplayName(p.name);
        playerListEl.appendChild(li);
      }
    }
  });

  state.socket.on('host:changed', ({ newHost }) => {
    if (newHost === state.socket.id) { state.isHost = true; syncStartButton(); }
  });

  // ── Countdown + start ─────────────────────────────────────────────────────
  state.socket.on('game:countdown', ({ count }) => showCountdownOverlay(count));

  state.socket.on('game:start', (data) => {
    hideCountdownOverlay();
    showScreen('game-screen');
    if (window.initGame) window.initGame(data, state);
  });

  // ── In-game (forwarded to game.js) ────────────────────────────────────────
  state.socket.on('game:tick',   s => { if (window.onGameTick)  window.onGameTick(s);  });
  state.socket.on('dot:eaten',  d => { if (window.onDotEaten)  window.onDotEaten(d);  });
  state.socket.on('player:hit', d => { if (window.onPlayerHit) window.onPlayerHit(d); });
  state.socket.on('player:ate', d => { if (window.onPlayerAte) window.onPlayerAte(d); });

  // ── Game end ───────────────────────────────────────────────────────────────
  state.socket.on('game:end', ({ leaderboard }) => {
    if (window.onGameEnd) window.onGameEnd(leaderboard);
    renderLeaderboard(leaderboard);
    showScreen('end-screen');
    runConfetti();

    // [MAIN MENU] button appears after 5 s
    const btn = document.getElementById('btn-new-game');
    btn.classList.add('hidden');
    setTimeout(() => btn.classList.remove('hidden'), 5000);
  });
}

// ─── DOM wiring ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Inject SVG images into lobby avatar containers immediately
  injectLobbyAvatars();

  // Start ambient animation immediately (menu is visible on load)
  _ambient.start();

  connectSocket();

  // HOST GAME ─────────────────────────────────────────────────────────────────
  document.getElementById('btn-host').addEventListener('click', () => {
    state.myName = 'Player';
    state.socket.emit('room:create', { name: state.myName });
  });

  // JOIN GAME ─────────────────────────────────────────────────────────────────
  document.getElementById('btn-join').addEventListener('click', () => {
    const code = document.getElementById('input-room-code').value.trim().toUpperCase();
    if (code.length !== 4) { showError('Enter a valid 4-digit code.', 'btn-join'); return; }
    state.socket.emit('room:join', { code, name: state.myName });
  });

  document.getElementById('input-room-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-join').click();
  });

  // PLAYER NAME ───────────────────────────────────────────────────────────────
  document.getElementById('input-player-name').addEventListener('input', e => {
    state.myName = e.target.value.trim() || 'Player';
    if (state.socket && state.roomCode) {
      state.socket.emit('player:set_name', { name: state.myName });
    }
  });

  // CHARACTER SELECTION ───────────────────────────────────────────────────────
  for (const [elemId, charName] of Object.entries(CHAR_MAP)) {
    document.getElementById(elemId).addEventListener('click', () => {
      // .locked adds pointer-events:none via CSS, but guard here too
      if (document.getElementById(elemId).classList.contains('locked')) return;

      state.myCharacter = charName;
      state.socket.emit('player:select_character', { character: charName });
    });
  }

  // START GAME ────────────────────────────────────────────────────────────────
  document.getElementById('btn-start-game').addEventListener('click', () => {
    if (!state.isHost) return;
    state.socket.emit('game:start_request');
  });

  // MAIN MENU (end screen) ────────────────────────────────────────────────────
  document.getElementById('btn-new-game').addEventListener('click', () => {
    resetClientState();
    showScreen('menu-screen');
    _ambient.start();
  });
});

// Exposed for game.js
window.getClientState = () => state;
