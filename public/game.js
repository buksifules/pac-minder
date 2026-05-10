'use strict';

// ─── Tile type constants (must match server.js) ───────────────────────────────
const TILE_WALL  = 1;
const TILE_EMPTY = 0;
const TILE_DOT   = 2;
const TILE_POWER = 3;

// ─── Visual constants ─────────────────────────────────────────────────────────
const BG_COLOR    = '#f9f9f9';
const WALL_COLOR  = '#000000';
const GRID_COLOR  = '#e8e8e8';
const DOT_COLOR   = '#000000';
const POWER_COLOR = '#000000';

const CHAR_FILL_FALLBACK = {
  'Marci 1': '#FFCA28',
  'Marci 2': '#FF7043',
  'Csaba 1': '#66BB6A',
};

// ─── AudioManager ─────────────────────────────────────────────────────────────
/*
 * Lazy AudioContext (satisfies browser autoplay policy — context only created
 * after first user interaction, which has already happened by game start).
 * Audio fires CLIENT-SIDE the instant a dot is collected, with zero
 * server round-trip.
 */
const AudioManager = (() => {
  let _ctx = null;

  function getCtx() {
    if (!_ctx) {
      try { _ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
    }
    return _ctx;
  }

  function beep(freq, dur, type = 'square', vol = 0.15) {
    const ctx = getCtx();
    if (!ctx) return;
    try {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(vol, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + dur + 0.02);
    } catch (e) {}
  }

  return {
    pellet_eat()  { console.log('[Audio] pellet_eat');  beep(660, 0.05, 'square',   0.10); },
    powerup_eat() { console.log('[Audio] powerup_eat'); beep(300, 0.35, 'sine',     0.20); },
    death()       { console.log('[Audio] death');       beep(180, 0.50, 'sawtooth', 0.18); },
  };
})();

// ─── Tile size (+10 % scale factor) ──────────────────────────────────────────
const SCALE_FACTOR = 1.10;
let TILE_PX    = 15;
let mapOffsetX = 0;
let mapOffsetY = 0;

function computeTileSize() {
  if (!canvas || !gameState) return;
  TILE_PX = Math.max(1, Math.floor(
    Math.min(canvas.width / gameState.cols, canvas.height / gameState.rows) * SCALE_FACTOR
  ));
  mapOffsetX = Math.floor((canvas.width  - gameState.cols * TILE_PX) / 2);
  mapOffsetY = Math.floor((canvas.height - gameState.rows * TILE_PX) / 2);
}

// ─── SVG asset loading ────────────────────────────────────────────────────────
const CHAR_ASSETS = {
  'Marci 1': '/assets/marci1.svg',
  'Marci 2': '/assets/marci2.svg',
  'Csaba 1': '/assets/csaba1.svg',
};
const charBitmaps = { 'Marci 1': null, 'Marci 2': null, 'Csaba 1': null };
let _assetsPromise = null;

function preloadAssets() {
  if (_assetsPromise) return _assetsPromise;
  _assetsPromise = Promise.allSettled(
    Object.entries(CHAR_ASSETS).map(([name, url]) =>
      new Promise(resolve => {
        const img = new Image();
        img.onload  = () => { charBitmaps[name] = img; resolve(); };
        img.onerror = () => { console.warn(`[Pac-Minder] could not load ${url}`); resolve(); };
        img.src = url;
      })
    )
  );
  return _assetsPromise;
}
preloadAssets();

// ─── Game state ───────────────────────────────────────────────────────────────
let canvas, ctx;
let gameState       = null;
let mouthAngle      = 0;
let mouthDir        = 1;
let myCurrentScore  = 0;   // score for the current life (resets on death)
let myBestScore     = 0;   // best single-run score (never decreases)
let animFrameId;
let lastFrameTs;
let lastEmitTs = 0;

// ─── Canvas bootstrap ─────────────────────────────────────────────────────────
function bootstrapCanvas() {
  document.getElementById('pm-game-canvas')?.remove();
  canvas = document.createElement('canvas');
  canvas.id = 'pm-game-canvas';
  canvas.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;z-index:2;';
  document.getElementById('canvas-container').appendChild(canvas);
  sizeCanvas();
}

function sizeCanvas() {
  const container = document.getElementById('canvas-container');
  if (!container || !canvas) return;
  canvas.width  = container.clientWidth;
  canvas.height = container.clientHeight;
  computeTileSize();
}

// ─── HUD ──────────────────────────────────────────────────────────────────────
function setScoreHUD(best, current) {
  const bestEl = document.getElementById('score-display');
  const lifeEl = document.getElementById('life-display');
  if (bestEl) bestEl.textContent    = `BEST: ${String(best).padStart(4, '0')}`;
  if (lifeEl) lifeEl.textContent    = `LIFE: ${String(current).padStart(4, '0')}`;
}

function setTimerHUD(secondsLeft) {
  const el = document.getElementById('timer-display');
  if (!el) return;
  const m = Math.floor(secondsLeft / 60);
  const s = Math.floor(secondsLeft % 60);
  el.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ─── Character drawing (no stroke/outline) ────────────────────────────────────
function drawCharacter(cx, cy, character, dir, isLocal, mouthAng) {
  const R = TILE_PX / 2;

  const hasDir    = dir && (dir[0] !== 0 || dir[1] !== 0);
  const baseAngle = hasDir ? Math.atan2(dir[0], dir[1]) : 0;
  const mouthOpen = (Math.sin(mouthAng) * 0.5 + 0.5) * 0.26 + 0.03;
  const arcStart  = baseAngle + mouthOpen * Math.PI;
  const arcEnd    = baseAngle + (2 - mouthOpen) * Math.PI;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, R, arcStart, arcEnd);
  ctx.closePath();

  const img = charBitmaps[character];
  if (img) {
    ctx.save();
    ctx.clip();
    ctx.drawImage(img, -R, -R, R * 2, R * 2);
    ctx.restore();
  } else {
    ctx.fillStyle = CHAR_FILL_FALLBACK[character] ?? '#888';
    ctx.fill();
    ctx.save();
    ctx.rotate(baseAngle);
    ctx.beginPath();
    ctx.arc(-R * 0.15, -R * 0.44, Math.max(1, R * 0.15), 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.90)';
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

// ─── Ghost drawing (no stroke/outline) ───────────────────────────────────────
/*
 * frightenTimer < 20 ticks (≈ 2 s) triggers rapid blue↔white warning flash.
 */
function drawGhost(cx, cy, color, frightened, frightenTimer) {
  const R = (TILE_PX / 2) * 0.88;

  let ghostColor;
  if (frightened) {
    ghostColor = frightenTimer < 20
      ? (Math.floor(Date.now() / 120) % 2 === 0 ? '#2979FF' : '#ffffff')
      : '#2979FF';
  } else {
    ghostColor = color || '#555';
  }

  ctx.save();
  ctx.translate(cx, cy);

  ctx.beginPath();
  ctx.arc(0, -R * 0.1, R, Math.PI, 0);
  const bumps = 4, bw = (R * 2) / bumps;
  for (let i = 0; i <= bumps; i++) {
    ctx.lineTo(R - i * bw, i % 2 === 0 ? R * 0.60 : R * 0.95);
  }
  ctx.closePath();
  ctx.fillStyle = ghostColor;
  ctx.fill();

  for (const ex of [-R * 0.33, R * 0.18]) {
    ctx.beginPath();
    ctx.arc(ex, -R * 0.22, R * 0.19, 0, Math.PI * 2);
    ctx.fillStyle = frightened ? '#001' : '#fff';
    ctx.fill();
    if (!frightened) {
      ctx.beginPath();
      ctx.arc(ex + R * 0.06, -R * 0.14, R * 0.09, 0, Math.PI * 2);
      ctx.fillStyle = '#000';
      ctx.fill();
    }
  }
  ctx.restore();
}

// ─── Render loop ──────────────────────────────────────────────────────────────
function render(ts) {
  if (!gameState || !canvas) return;
  animFrameId = requestAnimationFrame(render);

  const dt = Math.min(ts - (lastFrameTs || ts), 100);
  lastFrameTs = ts;

  updateLocalPlayer(dt);

  // Timestamp-based ghost lerp — only restarts when ghost moves to a new tile
  const nowMs = performance.now();
  for (const g of (gameState.ghosts ?? [])) {
    const elapsed = nowMs - (g.lerpStartTs ?? nowMs);
    const t = Math.min(1, elapsed / (g.lerpDurationMs ?? 400));
    g.renderR = (g.prevR ?? g.targetR ?? 0) + ((g.targetR ?? 0) - (g.prevR ?? 0)) * t;
    g.renderC = (g.prevC ?? g.targetC ?? 0) + ((g.targetC ?? 0) - (g.prevC ?? 0)) * t;
  }

  mouthAngle += dt * 0.0075 * mouthDir;
  if (mouthAngle > 1.3 || mouthAngle < 0) mouthDir *= -1;

  ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.translate(mapOffsetX, mapOffsetY);

  const { maze, dots, cols, rows } = gameState;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const px = c * TILE_PX, py = r * TILE_PX;
      if (maze[r][c] === TILE_WALL) {
        ctx.fillStyle = WALL_COLOR;
        ctx.fillRect(px, py, TILE_PX, TILE_PX);
        ctx.fillStyle = 'rgba(255,255,255,0.04)';
        ctx.fillRect(px + 1, py + 1, TILE_PX - 2, TILE_PX - 2);
      } else {
        ctx.fillStyle = GRID_COLOR;
        ctx.fillRect(px, py, TILE_PX, TILE_PX);
        const dot = dots[r][c];
        if (dot === TILE_DOT) {
          ctx.beginPath();
          ctx.arc(px + TILE_PX / 2, py + TILE_PX / 2, Math.max(1, TILE_PX * 0.10), 0, Math.PI * 2);
          ctx.fillStyle = DOT_COLOR;
          ctx.fill();
        } else if (dot === TILE_POWER) {
          const pulse = Math.sin(Date.now() / 200) * (TILE_PX * 0.04);
          ctx.beginPath();
          ctx.arc(px + TILE_PX / 2, py + TILE_PX / 2, TILE_PX * 0.22 + pulse, 0, Math.PI * 2);
          ctx.fillStyle = POWER_COLOR;
          ctx.fill();
        }
      }
    }
  }

  for (const g of (gameState.ghosts ?? [])) {
    drawGhost(
      g.renderC * TILE_PX + TILE_PX / 2,
      g.renderR * TILE_PX + TILE_PX / 2,
      g.color, g.frightened, g.frightenTimer ?? 0
    );
  }

  for (const [sid, p] of Object.entries(gameState.players)) {
    const isLocal = sid === gameState.myId;
    drawCharacter(
      p.c * TILE_PX + TILE_PX / 2,
      p.r * TILE_PX + TILE_PX / 2,
      p.character, p.dir, isLocal,
      isLocal ? mouthAngle : 0.5
    );
    if (!isLocal) {
      ctx.save();
      ctx.font      = `bold ${Math.max(7, TILE_PX - 4)}px 'Space Grotesk', sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,0.60)';
      ctx.fillText(p.name ?? '', p.c * TILE_PX + TILE_PX / 2, p.r * TILE_PX - 3);
      ctx.restore();
    }
  }

  ctx.restore();
}

// ─── Local player movement ────────────────────────────────────────────────────
/*
 * CORNER_BUFFER = 0.50: raised so a flush-wall position (exactly 0.5 tiles from
 * the last open centre) still fires an auto-turn immediately on key press.
 *
 * Wall collision — flush snap (zero bounce):
 *   Snap to the exact face of the blocking tile on the movement axis.
 *   Centre the perpendicular axis to lock the player inside the corridor.
 *
 * Pellet collection is INSTANT:
 *   Audio fires here (client-side) and a dot:collect event goes to the server
 *   immediately — no waiting for the 100 ms server tick.
 */
const PLAYER_SPEED  = 3.0;
const CORNER_BUFFER = 0.50;

const keysDown = {};
document.addEventListener('keydown', e => { keysDown[e.key] = true;  });
document.addEventListener('keyup',   e => { keysDown[e.key] = false; });

function updateLocalPlayer(dt) {
  if (!gameState) return;
  const me = gameState.players[gameState.myId];
  if (!me) return;

  const { maze, dots, cols, rows } = gameState;
  const WARP_ROW = Math.floor(rows / 2);

  // 1. Read keys → queue pending direction
  let dr = 0, dc = 0;
  if      (keysDown['ArrowUp']    || keysDown['w'] || keysDown['W']) { dr = -1; dc =  0; }
  else if (keysDown['ArrowDown']  || keysDown['s'] || keysDown['S']) { dr =  1; dc =  0; }
  else if (keysDown['ArrowLeft']  || keysDown['a'] || keysDown['A']) { dr =  0; dc = -1; }
  else if (keysDown['ArrowRight'] || keysDown['d'] || keysDown['D']) { dr =  0; dc =  1; }
  if (dr !== 0 || dc !== 0) me.pendingDir = [dr, dc];

  let [cdr, cdc] = me.dir ?? [0, 0];
  const step = PLAYER_SPEED * (dt / 1000);

  // 2. Nearest open tile centre (wall-adjusted for flush-snap positions)
  let centerR = Math.round(me.r);
  let centerC = Math.round(me.c);
  if (
    centerR >= 0 && centerR < rows && centerC >= 0 && centerC < cols &&
    maze[centerR][centerC] === TILE_WALL
  ) {
    if      (cdr > 0 && centerR > 0)        centerR--;
    else if (cdr < 0 && centerR < rows - 1) centerR++;
    if      (cdc > 0 && centerC > 0)        centerC--;
    else if (cdc < 0 && centerC < cols - 1) centerC++;
  }
  const distToCenter = Math.hypot(me.r - centerR, me.c - centerC);

  // 3. Auto-turn when within CORNER_BUFFER of tile centre
  if (me.pendingDir && distToCenter <= Math.max(step, CORNER_BUFFER)) {
    const [pdr, pdc] = me.pendingDir;
    const ntr = centerR + pdr;
    const ntc = ((centerC + pdc) + cols) % cols;
    if (ntr >= 0 && ntr < rows && maze[ntr][ntc] !== TILE_WALL) {
      me.r = centerR; me.c = centerC;
      cdr = pdr; cdc = pdc;
      me.dir = [cdr, cdc];
      me.pendingDir = null;
    }
  }

  // 4. Advance
  if (cdr !== 0 || cdc !== 0) {
    const nr = me.r + cdr * step;
    const nc = me.c + cdc * step;

    // Warp tunnel
    if (Math.round(nr) === WARP_ROW && nc < 0) {
      me.r = nr; me.c = cols - 1;
    } else if (Math.round(nr) === WARP_ROW && nc >= cols) {
      me.r = nr; me.c = 0;
    } else {
      const gr = Math.round(nr);
      const gc = Math.round(nc);

      if (gr >= 0 && gr < rows && gc >= 0 && gc < cols && maze[gr][gc] !== TILE_WALL) {
        me.r = nr; me.c = nc;

        // ── Instant pellet collection ────────────────────────────────────
        if (dots[gr][gc] === TILE_DOT || dots[gr][gc] === TILE_POWER) {
          const isPower = dots[gr][gc] === TILE_POWER;
          dots[gr][gc] = TILE_EMPTY;

          // Audio fires immediately — no server round-trip
          if (isPower) AudioManager.powerup_eat();
          else         AudioManager.pellet_eat();

          // Optimistic score update for instant HUD feedback
          myCurrentScore += isPower ? 50 : 10;
          if (myCurrentScore > myBestScore) myBestScore = myCurrentScore;
          setScoreHUD(myBestScore, myCurrentScore);

          // Tell server immediately so it awards the authoritative score
          const cs = window.getClientState?.();
          if (cs?.socket) cs.socket.emit('dot:collect', { r: gr, c: gc });
        }
      } else {
        // Flush snap to wall face — no bounce
        me.r = cdr > 0 ? gr - 0.5 : (cdr < 0 ? gr + 0.5 : Math.round(me.r));
        me.c = cdc > 0 ? gc - 0.5 : (cdc < 0 ? gc + 0.5 : Math.round(me.c));
      }
    }

    // Rate-limited position emit (~20 Hz)
    const now = performance.now();
    if (now - lastEmitTs >= 50) {
      lastEmitTs = now;
      const cs = window.getClientState?.();
      if (cs?.socket) cs.socket.emit('player:move', { r: me.r, c: me.c, dir: me.dir });
    }
  }
}

// ─── Touch / swipe-to-steer ───────────────────────────────────────────────────
function setupTouch() {
  let touchStartX = 0, touchStartY = 0;
  const MIN_SWIPE_PX = 30;

  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    const t = e.touches[0];
    touchStartX = t.clientX;
    touchStartY = t.clientY;
  }, { passive: false });

  canvas.addEventListener('touchend', e => {
    if (!gameState) return;
    e.preventDefault();
    const me = gameState.players[gameState.myId];
    if (!me) return;
    const t  = e.changedTouches[0];
    const dx = t.clientX - touchStartX;
    const dy = t.clientY - touchStartY;
    if (Math.hypot(dx, dy) < MIN_SWIPE_PX) return;
    let tdr = 0, tdc = 0;
    if (Math.abs(dx) > Math.abs(dy)) tdc = dx > 0 ? 1 : -1;
    else                              tdr = dy > 0 ? 1 : -1;
    me.pendingDir = [tdr, tdc];
  }, { passive: false });
}

// ─── Public API ───────────────────────────────────────────────────────────────

window.initGame = async function(data, clientState) {
  await preloadAssets();

  const players = {};
  for (const p of data.players) {
    players[p.sid] = { ...p, dir: [0, 0], currentScore: 0, bestScore: 0, pendingDir: null };
  }

  gameState = {
    maze:    data.maze,
    dots:    data.dots,
    cols:    data.cols,
    rows:    data.rows,
    players,
    ghosts:  [],
    myId:    clientState.myId ?? clientState.socket?.id,
    myChar:  clientState.myCharacter,
  };

  mouthAngle     = 0;
  mouthDir       = 1;
  myCurrentScore = 0;
  myBestScore    = 0;
  lastFrameTs    = null;
  lastEmitTs     = 0;

  setScoreHUD(0, 0);
  setTimerHUD(120);

  bootstrapCanvas();
  ctx = canvas.getContext('2d');
  computeTileSize();
  window.addEventListener('resize', sizeCanvas);
  setupTouch();

  if (animFrameId) cancelAnimationFrame(animFrameId);
  animFrameId = requestAnimationFrame(render);
};

window.onGameTick = function(snapshot) {
  if (!gameState) return;

  // Ghost lerp: update targets, preserve current render position
  const newGhosts = snapshot.ghosts ?? [];
  if (gameState.ghosts.length !== newGhosts.length) {
    gameState.ghosts = newGhosts.map(g => ({
      ...g,
      prevR: g.r, prevC: g.c,
      targetR: g.r, targetC: g.c,
      renderR: g.r, renderC: g.c,
      lerpStartTs:   performance.now() - 400, // already at target on first frame
      lerpDurationMs: g.frightened ? 900 : 400,
    }));
  } else {
    for (let i = 0; i < newGhosts.length; i++) {
      const ghost = gameState.ghosts[i];
      const ng    = newGhosts[i];
      // Only restart interpolation when the ghost has moved to a new tile
      if (ng.r !== ghost.targetR || ng.c !== ghost.targetC || ghost.lerpStartTs === undefined) {
        ghost.prevR        = ghost.renderR ?? ng.r;
        ghost.prevC        = ghost.renderC ?? ng.c;
        ghost.targetR      = ng.r;
        ghost.targetC      = ng.c;
        ghost.lerpStartTs  = performance.now();
        ghost.lerpDurationMs = ng.frightened ? 900 : 400;
      }
      ghost.color        = ng.color;
      ghost.frightened   = ng.frightened;
      ghost.frightenTimer = ng.frightenTimer ?? 0;
    }
  }

  for (const p of snapshot.players) {
    if (!gameState.players[p.sid]) continue;
    if (p.sid !== gameState.myId) {
      gameState.players[p.sid].r   = p.r;
      gameState.players[p.sid].c   = p.c;
      gameState.players[p.sid].dir = p.dir;
    }
    gameState.players[p.sid].currentScore = p.currentScore;
    gameState.players[p.sid].bestScore    = p.bestScore;
    gameState.players[p.sid].name         = p.name;
    gameState.players[p.sid].character    = p.character;
  }

  // Sync local scores from server (authoritative)
  const me = gameState.players[gameState.myId];
  if (me) {
    // Accept server best score if it exceeds our optimistic tally
    if ((me.bestScore ?? 0) > myBestScore) myBestScore = me.bestScore;
    myCurrentScore = me.currentScore ?? myCurrentScore;
    setScoreHUD(myBestScore, myCurrentScore);
  }

  setTimerHUD(snapshot.timeLeft);
};

window.onDotEaten = function({ r, c, sid, currentScore, bestScore }) {
  if (!gameState) return;
  // Ensure visual consistency (may already be empty from optimistic removal)
  gameState.dots[r][c] = TILE_EMPTY;

  if (sid === gameState.myId) {
    // Server score is authoritative — correct any optimistic drift
    if (currentScore !== undefined) myCurrentScore = currentScore;
    if (bestScore    !== undefined && bestScore > myBestScore) myBestScore = bestScore;
    setScoreHUD(myBestScore, myCurrentScore);
    // Audio already played optimistically in updateLocalPlayer — no duplicate here
  }
};

window.onPlayerHit = function({ currentScore, bestScore, r, c }) {
  if (!gameState) return;
  // Current life score resets; best run score is preserved
  myCurrentScore = currentScore ?? 0;
  if ((bestScore ?? 0) > myBestScore) myBestScore = bestScore ?? myBestScore;

  const me = gameState.players[gameState.myId];
  if (me) {
    me.currentScore = myCurrentScore;
    me.bestScore    = myBestScore;
    me.r = r; me.c = c;
    me.dir = [0, 0];
    me.pendingDir = null;
  }
  setScoreHUD(myBestScore, myCurrentScore);
  AudioManager.death();
};

window.onPlayerAte = function({ currentScore, bestScore }) {
  if (!gameState) return;
  if (currentScore !== undefined) myCurrentScore = currentScore;
  if (bestScore    !== undefined && bestScore > myBestScore) myBestScore = bestScore;
  const me = gameState.players[gameState.myId];
  if (me) { me.currentScore = myCurrentScore; me.bestScore = myBestScore; }
  setScoreHUD(myBestScore, myCurrentScore);
  AudioManager.powerup_eat();
};

window.onGameEnd = function() {
  if (animFrameId) cancelAnimationFrame(animFrameId);
  window.removeEventListener('resize', sizeCanvas);
  gameState = null;
};
