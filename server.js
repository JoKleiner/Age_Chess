const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const HexBoard = require('./public/board/hexBoard.js');
const Reiter = require('./public/pieces/reiter.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const MAX_STEPS = Reiter.maxSteps;

// Startpositionen aller Einheiten (aus reiter.js), einmal in q/r umgerechnet
const START_POSITIONS = {};
Reiter.units.forEach(u => {
  START_POSITIONS[u.id] = HexBoard.cellRef(u.start.col, u.start.row);
});

// Welche Einheiten gehören zu welcher Seite
const UNIT_IDS_BY_ROLE = { blue: [], red: [] };
Reiter.units.forEach(u => UNIT_IDS_BY_ROLE[u.role].push(u.id));

// Alle gültigen Feld-Koordinaten einmal berechnen, um Züge serverseitig zu prüfen
const validCellKeys = new Set(
  HexBoard.generateBoardCells().map(c => HexBoard.keyOf(c.q, c.r))
);

const rooms = {};
// rooms[roomId] = {
//   sockets: { blue: socketId, red: socketId },
//   positions: { unitId: {q,r}, ... },              <- alle Einheiten beider Seiten
//   plans: { blue: null oder {unitId: steps[]}, red: ... }
// }

function createRoom() {
  const positions = {};
  Reiter.units.forEach(u => {
    positions[u.id] = { ...START_POSITIONS[u.id] };
  });
  return {
    sockets: {},
    positions,
    plans: { blue: null, red: null }
  };
}

// Prüft die geplanten Schritte EINER Einheit
function isValidUnitSteps(steps, startPos) {
  if (!Array.isArray(steps) || steps.length > MAX_STEPS) return false;

  let previous = startPos;
  for (const step of steps) {
    if (typeof step.q !== 'number' || typeof step.r !== 'number') return false;
    if (!validCellKeys.has(HexBoard.keyOf(step.q, step.r))) return false;
    if (HexBoard.hexDistance(previous, step) > 1) return false; // 0 = bleiben, 1 = bewegen
    previous = step;
  }
  return true;
}

// Prüft den kompletten Plan EINES Spielers (alle seine Einheiten auf einmal)
function isValidRolePlan(planByUnit, positions, role) {
  if (!planByUnit || typeof planByUnit !== 'object') return false;

  const expectedIds = UNIT_IDS_BY_ROLE[role];
  const providedIds = Object.keys(planByUnit);
  if (providedIds.length !== expectedIds.length) return false;

  for (const unitId of expectedIds) {
    if (!(unitId in planByUnit)) return false;
    if (!isValidUnitSteps(planByUnit[unitId], positions[unitId])) return false;
  }
  return true;
}

io.on('connection', (socket) => {
  console.log('Spieler verbunden:', socket.id);

  socket.on('joinRoom', (roomId) => {
    if (!rooms[roomId]) {
      rooms[roomId] = createRoom();
    }
    const room = rooms[roomId];

    let role = null;
    if (!room.sockets.blue) role = 'blue';
    else if (!room.sockets.red) role = 'red';
    else {
      socket.emit('roomFull');
      return;
    }

    room.sockets[role] = socket.id;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = role;

    socket.emit('joined', { role, positions: room.positions });

    console.log(`Spieler ${socket.id} ist Raum ${roomId} als ${role} beigetreten`);

    if (room.sockets.blue && room.sockets.red) {
      io.to(roomId).emit('gameStart', { positions: room.positions });
    }
  });

  // Ein Spieler reicht die Pläne ALLER seiner Einheiten auf einmal ein:
  // { blue1: [...Schritte], blue2: [...Schritte] } (bzw. red1/red2)
  socket.on('submitPlan', ({ roomId, plan }) => {
    const room = rooms[roomId];
    if (!room) return;

    const role = socket.data.role;
    if (!role) return;

    if (!isValidRolePlan(plan, room.positions, role)) {
      socket.emit('planRejected', { reason: 'Ungültiger Zug.' });
      return;
    }

    room.plans[role] = plan;
    socket.emit('planAccepted');

    const otherRole = role === 'blue' ? 'red' : 'blue';
    const otherSocketId = room.sockets[otherRole];
    if (otherSocketId) {
      io.to(otherSocketId).emit('opponentConfirmed');
    }

    if (room.plans.blue && room.plans.red) {
      const combinedSteps = { ...room.plans.blue, ...room.plans.red };

      Object.entries(combinedSteps).forEach(([unitId, steps]) => {
        if (steps.length > 0) {
          room.positions[unitId] = steps[steps.length - 1];
        }
      });

      io.to(roomId).emit('executeRound', { steps: combinedSteps });

      room.plans.blue = null;
      room.plans.red = null;
    }
  });

  // Bestätigung zurückziehen, solange der Gegner noch nicht bestätigt hat
  socket.on('cancelPlan', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const role = socket.data.role;
    if (!role) return;

    room.plans[role] = null;
  });

  socket.on('disconnect', () => {
    console.log('Spieler getrennt:', socket.id);
    const { roomId, role } = socket.data;
    if (roomId && rooms[roomId]) {
      delete rooms[roomId].sockets[role];
      io.to(roomId).emit('playerLeft');
      if (!rooms[roomId].sockets.blue && !rooms[roomId].sockets.red) {
        delete rooms[roomId];
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
