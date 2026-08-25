const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const HexBoard = require('./public/board/hexBoard.js');
const UnitTypes = require('./public/pieces/unitTypes.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const MAX_STEPS = UnitTypes.DEFAULT_MAX_STEPS;

// Alle gültigen Feld-Koordinaten einmal berechnen, um Züge serverseitig zu prüfen
const validCellKeys = new Set(
  HexBoard.generateBoardCells().map(c => HexBoard.keyOf(c.q, c.r))
);

const rooms = {};
// rooms[roomId] = {
//   sockets: { blue: socketId, red: socketId },
//   phase: 'placement' | 'playing',
//   placements: { blue: [{unitId, typeKey, q, r}, ...], red: [...] }, <- Reihenfolge = Stapel-Reihenfolge
//   ready: { blue: false, red: false },
//   units: null oder [{id, role, typeKey, chipIndex, label}, ...]  <- erst nach Spielstart
//   positions: null oder { unitId: {q,r}, ... }                     <- erst nach Spielstart
//   plans: { blue: null oder {unitId: steps[]}, red: ... }
// }

function createRoom() {
  return {
    sockets: {},
    phase: 'placement',
    placements: { blue: [], red: [] },
    ready: { blue: false, red: false },
    units: null,
    positions: null,
    plans: { blue: null, red: null }
  };
}

// Anzahl bereits platzierter Einheiten einer Art fuer eine Rolle
function countOfType(placements, typeKey) {
  return placements.filter(p => p.typeKey === typeKey).length;
}

function isValidPlacement(room, role, typeKey, q, r) {
  if (room.phase !== 'placement' || room.ready[role]) return { ok: false, reason: 'Platzierungsphase bereits beendet.' };

  const type = UnitTypes.byKey(typeKey);
  if (!type) return { ok: false, reason: 'Unbekannte Einheiten-Art.' };
  if (typeof q !== 'number' || typeof r !== 'number') return { ok: false, reason: 'Ungültiges Feld.' };
  if (!validCellKeys.has(HexBoard.keyOf(q, r))) return { ok: false, reason: 'Feld existiert nicht.' };
  if (HexBoard.zoneOf(q, r) !== role) return { ok: false, reason: 'Nur die eigene Zone ist erlaubt.' };

  const placements = room.placements[role];
  if (placements.length >= UnitTypes.MAX_UNITS_PER_PLAYER) {
    return { ok: false, reason: 'Maximale Anzahl Einheiten erreicht.' };
  }
  if (countOfType(placements, typeKey) >= type.maxPerPlayer) {
    return { ok: false, reason: `Maximale Anzahl von ${type.label} erreicht.` };
  }
  if (placements.some(p => p.q === q && p.r === r)) {
    return { ok: false, reason: 'Feld bereits belegt.' };
  }

  return { ok: true };
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
function isValidRolePlan(planByUnit, positions, unitIdsForRole) {
  if (!planByUnit || typeof planByUnit !== 'object') return false;

  const providedIds = Object.keys(planByUnit);
  if (providedIds.length !== unitIdsForRole.length) return false;

  for (const unitId of unitIdsForRole) {
    if (!(unitId in planByUnit)) return false;
    if (!isValidUnitSteps(planByUnit[unitId], positions[unitId])) return false;
  }
  return true;
}

// Baut aus den (server-validierten) Platzierungen beider Spieler die finalen
// Einheiten + Startpositionen fuer die Zugplanungsphase
function buildUnitsAndPositions(room) {
  const units = [];
  const positions = {};

  ['blue', 'red'].forEach(role => {
    room.placements[role].forEach((placement, index) => {
      const type = UnitTypes.byKey(placement.typeKey);
      const sameTypeSoFar = room.placements[role]
        .slice(0, index + 1)
        .filter(p => p.typeKey === placement.typeKey).length;

      units.push({
        id: placement.unitId,
        role,
        typeKey: placement.typeKey,
        label: `${type.label} ${sameTypeSoFar}`,
        chipIndex: sameTypeSoFar
      });
      positions[placement.unitId] = { q: placement.q, r: placement.r };
    });
  });

  return { units, positions };
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

    socket.emit('joined', { role, unitTypes: UnitTypes.TYPES, maxUnitsPerPlayer: UnitTypes.MAX_UNITS_PER_PLAYER });

    console.log(`Spieler ${socket.id} ist Raum ${roomId} als ${role} beigetreten`);

    if (room.sockets.blue && room.sockets.red) {
      io.to(roomId).emit('placementPhaseStart');
    }
  });

  // Ein Spieler platziert die naechste Einheit eines Stapels auf ein Feld
  // seiner eigenen Zone. Reihenfolge in room.placements[role] = Stapel-Reihenfolge,
  // die Instanznummer (chipIndex/label) ergibt sich daraus erst beim Spielstart.
  socket.on('placeUnit', ({ roomId, typeKey, q, r }) => {
    const room = rooms[roomId];
    if (!room) return;
    const role = socket.data.role;
    if (!role) return;

    const check = isValidPlacement(room, role, typeKey, q, r);
    if (!check.ok) {
      socket.emit('placementRejected', { reason: check.reason });
      return;
    }

    const unitId = `${role}_${typeKey}_${countOfType(room.placements[role], typeKey) + 1}`;
    room.placements[role].push({ unitId, typeKey, q, r });
    socket.emit('placementAccepted', { unitId, typeKey, q, r });
  });

  // Nimmt die zuletzt platzierte Einheit einer Art wieder vom Brett (Stapel-Pop).
  // Der Client ruft dies ggf. mehrfach auf, wenn mehrere Einheiten derselben Art
  // rueckgaengig gemacht werden (Klick auf eine nicht-oberste platzierte Einheit).
  socket.on('undoLastPlacement', ({ roomId, typeKey }) => {
    const room = rooms[roomId];
    if (!room) return;
    const role = socket.data.role;
    if (!role) return;
    if (room.phase !== 'placement' || room.ready[role]) return;

    const placements = room.placements[role];
    for (let i = placements.length - 1; i >= 0; i--) {
      if (placements[i].typeKey === typeKey) {
        placements.splice(i, 1);
        return;
      }
    }
  });

  socket.on('placementReady', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const role = socket.data.role;
    if (!role || room.phase !== 'placement') return;

    room.ready[role] = true;

    const otherRole = role === 'blue' ? 'red' : 'blue';
    const otherSocketId = room.sockets[otherRole];
    if (otherSocketId) {
      io.to(otherSocketId).emit('opponentPlacementReady');
    }

    if (room.ready.blue && room.ready.red) {
      room.phase = 'playing';
      const { units, positions } = buildUnitsAndPositions(room);
      room.units = units;
      room.positions = positions;
      io.to(roomId).emit('gameStart', { units, positions });
    }
  });

  // Bereitschaft der Platzierung zurueckziehen, solange der Gegner noch nicht bereit ist
  socket.on('cancelPlacementReady', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const role = socket.data.role;
    if (!role) return;

    room.ready[role] = false;
  });

  // Ein Spieler reicht die Pläne ALLER seiner Einheiten auf einmal ein
  socket.on('submitPlan', ({ roomId, plan }) => {
    const room = rooms[roomId];
    if (!room || room.phase !== 'playing') return;

    const role = socket.data.role;
    if (!role) return;

    const unitIdsForRole = room.units.filter(u => u.role === role).map(u => u.id);
    if (!isValidRolePlan(plan, room.positions, unitIdsForRole)) {
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
