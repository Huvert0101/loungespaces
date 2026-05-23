/**
 * CozyRooms – Server
 * Express + Socket.io + WebRTC signaling
 */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' }
});

// ─── Static files ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-memory state ─────────────────────────────────────────────────────────
/**
 * rooms = {
 *   [roomId]: {
 *     id: string,
 *     name: string,
 *     description: string,
 *     maxUsers: number,
 *     createdAt: Date,
 *     users: {
 *       [socketId]: {
 *         id: socketId,
 *         username: string,
 *         avatarSeed: string,
 *         avatarBg: string,
 *         seatIndex: number,   // which chair they occupy in the 3-D world
 *         muted: boolean
 *       }
 *     }
 *   }
 * }
 */
const rooms = {};

// Pre-seed two demo rooms so the lobby isn't empty
function createDemoRooms() {
  const r1 = uuidv4();
  rooms[r1] = {
    id: r1,
    name: 'Tertulia de Código',
    description: 'Hablando de JS, diseño y la vida.',
    maxUsers: 8,
    createdAt: new Date(),
    users: {}
  };

  const r2 = uuidv4();
  rooms[r2] = {
    id: r2,
    name: 'Lofi & Estudio',
    description: 'Micrófonos muteados, puro enfoque.',
    maxUsers: 5,
    createdAt: new Date(),
    users: {}
  };
}
createDemoRooms();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Return a public (serialisable) snapshot of a room. */
function roomSnapshot(room) {
  return {
    id:          room.id,
    name:        room.name,
    description: room.description,
    maxUsers:    room.maxUsers,
    userCount:   Object.keys(room.users).length,
    users:       Object.values(room.users)
  };
}

/** Return all rooms as public snapshots. */
function allRooms() {
  return Object.values(rooms).map(roomSnapshot);
}

/** Find the first free seat index in a room (0-based, max 7). */
function firstFreeSeat(room) {
  const taken = new Set(Object.values(room.users).map(u => u.seatIndex));
  for (let i = 0; i < room.maxUsers; i++) {
    if (!taken.has(i)) return i;
  }
  return -1; // full
}

// ─── HTTP routes ──────────────────────────────────────────────────────────────

/** REST: list all rooms (used by the lobby page on first load). */
app.get('/api/rooms', (req, res) => {
  res.json(allRooms());
});

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] connected  ${socket.id}`);

  // ── Lobby ──────────────────────────────────────────────────────────────────

  /** Client asks for the current room list. */
  socket.on('rooms:list', (cb) => {
    if (typeof cb === 'function') cb(allRooms());
  });

  /** Client creates a new room. */
  socket.on('room:create', ({ name, description, maxUsers = 8 }, cb) => {
    if (!name || !name.trim()) {
      return cb && cb({ error: 'El nombre de la sala es obligatorio.' });
    }
    const id = uuidv4();
    rooms[id] = {
      id,
      name: name.trim(),
      description: (description || '').trim(),
      maxUsers: Math.min(Math.max(Number(maxUsers) || 8, 2), 16),
      createdAt: new Date(),
      users: {}
    };
    console.log(`[room:create] "${name}" → ${id}`);
    // Tell everyone in the lobby that a new room appeared
    io.emit('rooms:updated', allRooms());
    if (typeof cb === 'function') cb({ id });
  });

  // ── Room join / leave ──────────────────────────────────────────────────────

  /**
   * Client joins a room.
   * Payload: { roomId, username, avatarSeed, avatarBg }
   */
  socket.on('room:join', ({ roomId, username, avatarSeed, avatarBg }, cb) => {
    const room = rooms[roomId];
    if (!room) return cb && cb({ error: 'Sala no encontrada.' });

    const seat = firstFreeSeat(room);
    if (seat === -1) return cb && cb({ error: 'La sala está llena.' });

    // Leave any previous room first
    leaveCurrentRoom(socket);

    const user = {
      id:        socket.id,
      username:  username || 'Anónimo',
      avatarSeed: avatarSeed || socket.id,
      avatarBg:  avatarBg  || 'ffdfbf',
      seatIndex: seat,
      muted:     false
    };

    room.users[socket.id] = user;
    socket.join(roomId);
    socket.data.roomId = roomId;

    console.log(`[room:join] ${user.username} → "${room.name}" seat ${seat}`);

    // Tell the newcomer about the room state
    if (typeof cb === 'function') cb({ room: roomSnapshot(room), you: user });

    // Tell existing members someone new arrived
    socket.to(roomId).emit('user:joined', { user, roomId });

    // Refresh lobby counters for everyone
    io.emit('rooms:updated', allRooms());
  });

  /** Client leaves a room (explicit). */
  socket.on('room:leave', (cb) => {
    leaveCurrentRoom(socket);
    if (typeof cb === 'function') cb({ ok: true });
  });

  // ── WebRTC signaling ────────────────────────────────────────────────────────
  // Peer-to-peer mesh: each pair exchanges offer/answer/ICE directly via the
  // server as a relay.  We forward the message only to the intended peer.

  /** Initiator sends an offer to a specific peer. */
  socket.on('webrtc:offer', ({ to, offer }) => {
    io.to(to).emit('webrtc:offer', { from: socket.id, offer });
  });

  /** Responder sends answer back. */
  socket.on('webrtc:answer', ({ to, answer }) => {
    io.to(to).emit('webrtc:answer', { from: socket.id, answer });
  });

  /** Both sides trickle ICE candidates. */
  socket.on('webrtc:ice', ({ to, candidate }) => {
    io.to(to).emit('webrtc:ice', { from: socket.id, candidate });
  });

  // ── Voice activity ──────────────────────────────────────────────────────────

  /** Client reports its own speaking state so avatars can animate. */
  socket.on('voice:speaking', ({ speaking }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit('voice:speaking', { userId: socket.id, speaking });
  });

  /** Client toggles its own mute. */
  socket.on('voice:mute', ({ muted }) => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;
    const user = rooms[roomId].users[socket.id];
    if (user) {
      user.muted = muted;
      io.to(roomId).emit('user:updated', { user });
    }
  });

  // ── Disconnect ──────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] disconnected ${socket.id}`);
    leaveCurrentRoom(socket);
  });
});

// ─── Helper: remove socket from its current room ──────────────────────────────
function leaveCurrentRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId || !rooms[roomId]) return;

  const room = rooms[roomId];
  const user = room.users[socket.id];
  if (user) {
    delete room.users[socket.id];
    socket.leave(roomId);
    socket.data.roomId = null;
    console.log(`[room:leave] ${user.username} ← "${room.name}"`);

    // Tell remaining members
    io.to(roomId).emit('user:left', { userId: socket.id, roomId });

    // Optionally delete empty rooms that were user-created
    // (keep the demo rooms alive even when empty)
    // if (Object.keys(room.users).length === 0) delete rooms[roomId];

    // Refresh lobby
    io.emit('rooms:updated', allRooms());
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🛋️  CozyRooms server running → http://localhost:${PORT}`);
});
