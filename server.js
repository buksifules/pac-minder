const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ─── Map constants ────────────────────────────────────────────────────────────
const COLS = 21;
const ROWS = 31;
const TILE_WALL  = 1;
const TILE_EMPTY = 0;
const TILE_DOT   = 2;
const TILE_POWER = 3;

const WARP_ROW = Math.floor(ROWS / 2); // 15

// Ghost pen bounds (used in multiple functions)
const PEN_TOP = WARP_ROW - 5; // 10
const PEN_BOT = WARP_ROW - 2; // 13
const PEN_L   = Math.floor(COLS / 2) - 2; // 8
const PEN_R   = Math.floor(COLS / 2) + 2; // 12
const PEN_MID = Math.floor(COLS / 2);     // 10

// ─── Maze Generation ─────────────────────────────────────────────────────────
/*
 * Braided recursive-backtracker maze — zero dead ends, high visual variety.
 *
 * Steps:
 *  1. Carve a spanning tree with iterative DFS (random neighbour order).
 *  2. Remove ~28 % of remaining interior walls to punch extra loops.
 *  3. Braid pass: find dead ends (1 open neighbour), break an adjacent wall
 *     until none remain.  Iterate until stable.
 *  4. Stamp ghost pen, fix warp-tunnel access, place dots + power pellets.
 */
function generateMaze() {
  // 1. All walls
  const grid = Array.from({ length: ROWS }, () =>
    Array.from({ length: COLS }, () => TILE_WALL)
  );

  // 2. Iterative recursive backtracker on odd-indexed interior cells
  {
    const visited = new Set(['1,1']);
    const stack   = [[1, 1]];
    grid[1][1]    = TILE_EMPTY;

    while (stack.length > 0) {
      const [r, c] = stack[stack.length - 1];
      const nbrs = [[0,2],[0,-2],[2,0],[-2,0]]
        .filter(([dr, dc]) => {
          const nr = r + dr, nc = c + dc;
          return nr > 0 && nr < ROWS - 1 && nc > 0 && nc < COLS - 1 &&
                 !visited.has(`${nr},${nc}`);
        })
        .sort(() => Math.random() - 0.5);

      if (nbrs.length === 0) {
        stack.pop();
      } else {
        const [dr, dc] = nbrs[0];
        const nr = r + dr, nc = c + dc;
        visited.add(`${nr},${nc}`);
        grid[r + dr / 2][c + dc / 2] = TILE_EMPTY;
        grid[nr][nc] = TILE_EMPTY;
        stack.push([nr, nc]);
      }
    }
  }

  // 3. Extra loop-breaking: remove ~28 % of remaining interior walls
  {
    const walls = [];
    for (let r = 1; r < ROWS - 1; r++)
      for (let c = 1; c < COLS - 1; c++)
        if (grid[r][c] === TILE_WALL) walls.push([r, c]);

    for (let i = walls.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [walls[i], walls[j]] = [walls[j], walls[i]];
    }
    const removeCount = Math.floor(walls.length * 0.28);
    for (let i = 0; i < removeCount; i++)
      grid[walls[i][0]][walls[i][1]] = TILE_EMPTY;
  }

  // 4. Braid pass: eliminate dead ends (open cell with exactly 1 open neighbour)
  {
    let changed = true;
    while (changed) {
      changed = false;
      for (let r = 1; r < ROWS - 1; r++) {
        for (let c = 1; c < COLS - 1; c++) {
          if (grid[r][c] === TILE_WALL) continue;
          let openCount = 0;
          const wallCandidates = [];
          for (const [dr, dc] of [[0,1],[0,-1],[1,0],[-1,0]]) {
            const nr = r + dr, nc = c + dc;
            if (nr <= 0 || nr >= ROWS - 1 || nc <= 0 || nc >= COLS - 1) continue;
            if (grid[nr][nc] !== TILE_WALL) {
              openCount++;
            } else {
              const br = r + dr * 2, bc = c + dc * 2;
              if (br > 0 && br < ROWS - 1 && bc > 0 && bc < COLS - 1 &&
                  grid[br][bc] !== TILE_WALL) {
                wallCandidates.push([nr, nc]);
              }
            }
          }
          if (openCount === 1 && wallCandidates.length > 0) {
            const idx = Math.floor(Math.random() * wallCandidates.length);
            grid[wallCandidates[idx][0]][wallCandidates[idx][1]] = TILE_EMPTY;
            changed = true;
          }
        }
      }
    }
  }

  // 5. Ghost pen: stamp walls + opening over whatever was carved here
  for (let r = PEN_TOP; r <= PEN_BOT; r++) {
    for (let c = PEN_L; c <= PEN_R; c++) {
      const isBorder = r === PEN_TOP || r === PEN_BOT || c === PEN_L || c === PEN_R;
      grid[r][c] = isBorder ? TILE_WALL : TILE_EMPTY;
    }
  }
  grid[PEN_TOP][PEN_MID] = TILE_EMPTY;               // pen exit opening
  if (PEN_TOP > 0) grid[PEN_TOP - 1][PEN_MID] = TILE_EMPTY; // exit path above pen

  // 6. Guarantee warp-tunnel access at map edges
  grid[WARP_ROW][1]        = TILE_EMPTY;
  grid[WARP_ROW][COLS - 2] = TILE_EMPTY;

  // 7. Place dots on every passable cell
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++)
      if (grid[r][c] === TILE_EMPTY) grid[r][c] = TILE_DOT;

  // Clear dots inside the pen
  for (let r = PEN_TOP; r <= PEN_BOT; r++)
    for (let c = PEN_L; c <= PEN_R; c++)
      if (grid[r][c] === TILE_DOT) grid[r][c] = TILE_EMPTY;

  // 8. Power pellets near corners
  function placePower(startR, startC, dR, dC) {
    for (let dr = 0; dr <= 4; dr++)
      for (let dc = 0; dc <= 4; dc++) {
        const r = startR + dr * dR, c = startC + dc * dC;
        if (r >= 0 && r < ROWS && c >= 0 && c < COLS && grid[r][c] === TILE_DOT) {
          grid[r][c] = TILE_POWER;
          return;
        }
      }
  }
  placePower(1,      1,      1,  1);
  placePower(1,      COLS-2, 1, -1);
  placePower(ROWS-2, 1,     -1,  1);
  placePower(ROWS-2, COLS-2,-1, -1);

  return grid;
}

// ─── Spawn helpers ────────────────────────────────────────────────────────────

function getSpawnPoints(grid) {
  const targets = [
    { r: 1, c: 1 },
    { r: 1, c: Math.floor(COLS / 2) },
    { r: 1, c: COLS - 2 },
  ];
  const spawns = [];
  for (const { r: tr, c: tc } of targets) {
    let placed = false;
    for (let dr = 0; dr <= 5 && !placed; dr++) {
      for (let dc = -2; dc <= 2 && !placed; dc++) {
        const r = tr + dr, c = tc + dc;
        if (r >= 0 && r < ROWS && c >= 0 && c < COLS && grid[r][c] !== TILE_WALL) {
          spawns.push({ r, c });
          placed = true;
        }
      }
    }
  }
  while (spawns.length < 3) spawns.push({ r: 1, c: 1 });
  return spawns;
}

function getGhostSpawns(grid) {
  const positions = [];
  // Search pen interior rows (skip pen border rows PEN_TOP and PEN_BOT)
  for (let r = PEN_TOP + 1; r < PEN_BOT; r++) {
    for (let c = PEN_L + 1; c < PEN_R; c++) {
      if (grid[r][c] !== TILE_WALL) positions.push({ r, c });
      if (positions.length >= 5) return positions;
    }
  }
  while (positions.length < 5) positions.push({ r: PEN_TOP + 1, c: PEN_MID });
  return positions;
}

// ─── Game State ───────────────────────────────────────────────────────────────

const rooms = {};

function createRoom(code) {
  const maze        = generateMaze();
  const spawnPoints = getSpawnPoints(maze);
  const ghostSpawns = getGhostSpawns(maze);

  let totalDots = 0;
  for (const row of maze) for (const t of row) if (t === TILE_DOT || t === TILE_POWER) totalDots++;

  rooms[code] = {
    code,
    host:              null,
    players:           {},
    ghosts:            [],
    maze,
    spawnPoints,
    ghostSpawns,
    totalDots,
    dotsLeft:          totalDots,
    dots:              maze.map(row => [...row]),
    gameActive:        false,
    startTime:         null,
    gameInterval:      null,
    countdownInterval: null,
  };
  return rooms[code];
}

// ─── Ghost AI ─────────────────────────────────────────────────────────────────

function ghostAI(room) {
  const ALL_DIRS   = [[0,1],[0,-1],[1,0],[-1,0]];
  const playerList = Object.values(room.players);

  for (const ghost of room.ghosts) {
    if (ghost.frightened) {
      ghost.frightenTimer = (ghost.frightenTimer || 0) - 1;
      if (ghost.frightenTimer <= 0) ghost.frightened = false;
    }

    ghost.moveTimer = (ghost.moveTimer || 0) + 1;
    // Normal: 4 ticks = 400 ms/tile; Frightened: 9 ticks = 900 ms/tile
    if (ghost.moveTimer < (ghost.frightened ? 9 : 4)) continue;
    ghost.moveTimer = 0;

    const gr      = Math.round(ghost.r);
    const gc      = Math.round(ghost.c);
    const lastDir = ghost.dir || [0, 0];

    const allValid = ALL_DIRS.filter(([dr, dc]) => {
      const nr = gr + dr, nc = gc + dc;
      return nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS &&
             room.maze[nr][nc] !== TILE_WALL;
    });
    if (allValid.length === 0) continue;

    const noUTurn    = allValid.filter(([dr, dc]) => !(dr === -lastDir[0] && dc === -lastDir[1]));
    const candidates = noUTurn.length > 0 ? noUTurn : allValid;

    let chosen = candidates[Math.floor(Math.random() * candidates.length)];

    if (!ghost.frightened) {
      let nearestPlayer = null, nearestDist = Infinity;
      for (const p of playerList) {
        const d = Math.hypot(gr - p.r, gc - p.c);
        if (d < nearestDist) { nearestDist = d; nearestPlayer = p; }
      }
      if (nearestPlayer) {
        let best = Infinity;
        for (const [dr, dc] of candidates) {
          const d = Math.hypot(gr + dr - nearestPlayer.r, gc + dc - nearestPlayer.c);
          if (d < best) { best = d; chosen = [dr, dc]; }
        }
      }
    }

    ghost.r   = gr + chosen[0];
    ghost.c   = gc + chosen[1];
    ghost.dir = chosen;
  }
}

// ─── Scoring helpers ──────────────────────────────────────────────────────────

function addScore(player, points) {
  player.currentLifeScore += points;
  if (player.currentLifeScore > player.bestRunScore) {
    player.bestRunScore = player.currentLifeScore;
  }
}

function resetLifeScore(player) {
  player.currentLifeScore = 0;
  // bestRunScore is intentionally preserved
}

// ─── Dot collection (shared by both dot:collect and checkCollisions backup) ───

function processDot(room, player, sid, pr, pc) {
  const tile = room.dots[pr][pc];
  if (tile !== TILE_DOT && tile !== TILE_POWER) return;

  room.dots[pr][pc] = TILE_EMPTY;
  room.dotsLeft--;

  const isPower = tile === TILE_POWER;
  addScore(player, isPower ? 50 : 10);

  if (isPower) {
    player.powered    = true;
    player.powerTimer = 80; // 80 × 100 ms = 8 s
    for (const ghost of room.ghosts) {
      ghost.frightened    = true;
      ghost.frightenTimer = 80;
    }
  }

  io.to(room.code).emit('dot:eaten', {
    r: pr, c: pc, sid,
    currentScore: player.currentLifeScore,
    bestScore:    player.bestRunScore,
    power:        isPower || undefined,
  });
}

// ─── Collision detection ──────────────────────────────────────────────────────

function checkCollisions(room) {
  // Tick down player power timers
  for (const player of Object.values(room.players)) {
    if (player.powered) {
      player.powerTimer = (player.powerTimer || 0) - 1;
      if (player.powerTimer <= 0) player.powered = false;
    }
  }

  for (const [sid, player] of Object.entries(room.players)) {
    const pr = Math.round(player.r), pc = Math.round(player.c);

    // ── Ghost collision (mercy zone: hitbox shrunk 15 %) ─────────────────────
    for (const ghost of room.ghosts) {
      const gr = Math.round(ghost.r), gc = Math.round(ghost.c);
      if (Math.abs(pr - gr) < 0.85 && Math.abs(pc - gc) < 0.85) {
        if (ghost.frightened) {
          ghost.frightened    = false;
          ghost.frightenTimer = 0;
          addScore(player, 200);
          io.to(room.code).emit('dot:eaten', {
            r: gr, c: gc, sid,
            currentScore: player.currentLifeScore,
            bestScore:    player.bestRunScore,
          });
        } else {
          resetLifeScore(player);
          const sp = room.spawnPoints[player.spawnIndex] || { r: 1, c: 1 };
          player.r = sp.r; player.c = sp.c;
          io.to(sid).emit('player:hit', {
            currentScore: 0,
            bestScore:    player.bestRunScore,
            r: player.r, c: player.c,
          });
        }
      }
    }

    // ── Dot fallback (catches any dot missed by dot:collect) ──────────────────
    if (pr >= 0 && pr < ROWS && pc >= 0 && pc < COLS) {
      processDot(room, player, sid, pr, pc);
    }
  }

  // ── PvP: powered player eats another ─────────────────────────────────────
  const eaten = new Set();
  for (const [sidA, pA] of Object.entries(room.players)) {
    if (!pA.powered || eaten.has(sidA)) continue;
    for (const [sidB, pB] of Object.entries(room.players)) {
      if (sidA === sidB || eaten.has(sidB)) continue;
      if (Math.abs(pA.r - pB.r) < 0.85 && Math.abs(pA.c - pB.c) < 0.85) {
        eaten.add(sidB);
        addScore(pA, 200);
        resetLifeScore(pB);
        const sp = room.spawnPoints[pB.spawnIndex] || { r: 1, c: 1 };
        pB.r = sp.r; pB.c = sp.c;
        io.to(sidB).emit('player:hit', {
          currentScore: 0, bestScore: pB.bestRunScore,
          r: pB.r, c: pB.c,
        });
        io.to(sidA).emit('player:ate', {
          currentScore: pA.currentLifeScore, bestScore: pA.bestRunScore, target: sidB,
        });
      }
    }
  }
}

// ─── Game lifecycle ───────────────────────────────────────────────────────────

function endGame(room) {
  if (!room.gameActive) return;
  room.gameActive = false;
  clearInterval(room.gameInterval);

  const leaderboard = Object.values(room.players)
    .map(p => ({
      name:      p.name,
      character: p.character,
      score:     p.bestRunScore,   // best single run wins
      sid:       p.sid,
    }))
    .sort((a, b) => b.score - a.score);

  io.to(room.code).emit('game:end', { leaderboard });
}

function startGame(room) {
  const playerCount = Object.keys(room.players).length;
  const ghostCount  = playerCount === 1 ? 3 : playerCount === 2 ? 4 : 5;

  room.ghosts = Array.from({ length: ghostCount }, (_, i) => ({
    r:            room.ghostSpawns[i % room.ghostSpawns.length].r,
    c:            room.ghostSpawns[i % room.ghostSpawns.length].c,
    dir:          [0, 1],
    moveTimer:    Math.floor(Math.random() * 4),
    frightenTimer: 0,
    color: ['#FF5252','#FF4081','#7C4DFF','#00B0FF','#64DD17'][i],
  }));

  room.dots     = room.maze.map(row => [...row]);
  room.dotsLeft = room.totalDots;

  let i = 0;
  for (const player of Object.values(room.players)) {
    player.currentLifeScore = 0;
    player.bestRunScore     = 0;
    player.powered          = false;
    player.powerTimer       = 0;
    const sp = room.spawnPoints[i % room.spawnPoints.length];
    player.r = sp.r; player.c = sp.c;
    player.spawnIndex = i++;
  }

  room.gameActive = true;
  room.startTime  = Date.now();

  const TICK = 100;
  room.gameInterval = setInterval(() => {
    if (!room.gameActive) return;

    ghostAI(room);
    checkCollisions(room);

    const elapsed = (Date.now() - room.startTime) / 1000;
    io.to(room.code).emit('game:tick', {
      ghosts: room.ghosts.map(g => ({
        r: g.r, c: g.c,
        color:        g.color,
        frightened:   !!g.frightened,
        frightenTimer: g.frightenTimer || 0,
      })),
      players: Object.values(room.players).map(p => ({
        sid:          p.sid,
        r:            p.r,
        c:            p.c,
        currentScore: p.currentLifeScore,
        bestScore:    p.bestRunScore,
        name:         p.name,
        character:    p.character,
        dir:          p.dir,
      })),
      timeLeft: Math.max(0, 120 - elapsed),
    });

    if (elapsed >= 120 || room.dotsLeft <= 0) endGame(room);
  }, TICK);
}

// ─── Socket Events ────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  socket.on('room:create', ({ name }) => {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const room = createRoom(code);
    room.host = socket.id;
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.name = name || 'Player';
    socket.emit('room:created', { code, isHost: true });
  });

  socket.on('room:join', ({ code, name }) => {
    const room = rooms[code];
    if (!room) return socket.emit('room:error', { msg: 'Room not found.' });
    if (Object.keys(room.players).length >= 3) return socket.emit('room:error', { msg: 'Room is full.' });
    if (room.gameActive) return socket.emit('room:error', { msg: 'Game in progress.' });
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.name = name || 'Player';
    socket.emit('room:joined', { code, isHost: room.host === socket.id });
    io.to(code).emit('lobby:update', buildLobbyState(room));
  });

  socket.on('player:join_lobby', ({ name, code }) => {
    const room = rooms[code];
    if (!room) return;
    room.players[socket.id] = {
      sid:              socket.id,
      name:             name || 'Player',
      character:        null,
      currentLifeScore: 0,
      bestRunScore:     0,
      powered:          false,
      powerTimer:       0,
      r: 1, c: 1,
      dir: [0, 1],
      spawnIndex: 0,
    };
    io.to(code).emit('lobby:update', buildLobbyState(room));
  });

  socket.on('player:select_character', ({ character }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return;
    for (const [sid, p] of Object.entries(room.players)) {
      if (sid !== socket.id && p.character === character) return;
    }
    if (room.players[socket.id]) {
      room.players[socket.id].character = character;
      io.to(code).emit('lobby:update', buildLobbyState(room));
    }
  });

  socket.on('player:set_name', ({ name }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].name = name;
    io.to(code).emit('lobby:update', buildLobbyState(room));
  });

  socket.on('game:start_request', () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    if (Object.keys(room.players).length === 0) return;

    let count = 5;
    io.to(code).emit('game:countdown', { count });
    room.countdownInterval = setInterval(() => {
      count--;
      if (count > 0) {
        io.to(code).emit('game:countdown', { count });
      } else {
        clearInterval(room.countdownInterval);
        io.to(code).emit('game:start', {
          maze:    room.maze,
          dots:    room.dots,
          players: Object.values(room.players).map(p => ({
            sid: p.sid, name: p.name, character: p.character, r: p.r, c: p.c,
          })),
          cols: COLS,
          rows: ROWS,
        });
        startGame(room);
      }
    }, 1000);
  });

  // ── Instant dot collection (no 100 ms tick wait) ───────────────────────────
  socket.on('dot:collect', ({ r, c }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || !room.gameActive || !room.players[socket.id]) return;
    const player = room.players[socket.id];
    const pr = Math.round(r), pc = Math.round(c);
    if (pr < 0 || pr >= ROWS || pc < 0 || pc >= COLS) return;
    // Validate proximity: client must be within 1.5 tiles of the claimed dot
    if (Math.abs(player.r - pr) > 1.5 || Math.abs(player.c - pc) > 1.5) return;
    processDot(room, player, socket.id, pr, pc);
  });

  socket.on('player:move', ({ r, c, dir }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || !room.gameActive || !room.players[socket.id]) return;
    const player = room.players[socket.id];
    const dr = Math.abs(r - player.r), dc = Math.abs(c - player.c);
    const onWarpRow  = Math.round(r) === WARP_ROW && Math.round(player.r) === WARP_ROW;
    const isWarpMove = onWarpRow && (Math.round(c) === 0 || Math.round(c) === COLS - 1);
    if (isWarpMove || (dr <= 1.5 && dc <= 1.5)) {
      const nr = Math.round(r), nc = Math.round(c);
      if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS && room.maze[nr][nc] !== TILE_WALL) {
        player.r = r; player.c = c; player.dir = dir;
      }
    }
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    delete room.players[socket.id];

    if (room.host === socket.id) {
      const remaining = Object.keys(room.players);
      if (remaining.length > 0) {
        room.host = remaining[0];
        io.to(code).emit('host:changed', { newHost: room.host });
      } else {
        clearInterval(room.gameInterval);
        clearInterval(room.countdownInterval);
        delete rooms[code];
        return;
      }
    }

    if (room.gameActive && Object.keys(room.players).length === 0) endGame(room);
    io.to(code).emit('lobby:update', buildLobbyState(room));
  });
});

function buildLobbyState(room) {
  return {
    code: room.code,
    host: room.host,
    players: Object.values(room.players).map(p => ({
      sid: p.sid, name: p.name, character: p.character,
    })),
    takenCharacters: Object.values(room.players)
      .filter(p => p.character)
      .map(p => ({ character: p.character, sid: p.sid })),
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Pac-Minder running on port ${PORT}`));
