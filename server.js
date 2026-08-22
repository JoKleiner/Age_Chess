const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Statische Dateien (index.html, game.js, style.css) ausliefern
app.use(express.static(__dirname));

// Speichert aktive Spiele: { roomId: { players: [socketId1, socketId2], board: [...] } }
const rooms = {};

io.on('connection', (socket) => {
  console.log('Spieler verbunden:', socket.id);

  // Spieler tritt einem Raum bei (oder erstellt einen neuen)
  socket.on('joinRoom', (roomId) => {
    if (!rooms[roomId]) {
      rooms[roomId] = { players: [], board: Array(9).fill(null) };
    }

    const room = rooms[roomId];

    if (room.players.length >= 2) {
      socket.emit('roomFull');
      return;
    }

    room.players.push(socket.id);
    socket.join(roomId);

    const playerNumber = room.players.length; // 1 oder 2
    socket.emit('joined', { playerNumber, roomId });

    console.log(`Spieler ${socket.id} ist Raum ${roomId} als Spieler ${playerNumber} beigetreten`);

    // Wenn zwei Spieler da sind, Spiel starten
    if (room.players.length === 2) {
      io.to(roomId).emit('gameStart', { board: room.board });
    }
  });

  // Ein Spieler macht einen Zug
  socket.on('makeMove', ({ roomId, index, symbol }) => {
    const room = rooms[roomId];
    if (!room) return;

    room.board[index] = symbol;

    // Zug an BEIDE Spieler im Raum weiterleiten (inkl. Absender, damit UI konsistent bleibt)
    io.to(roomId).emit('moveMade', { index, symbol, board: room.board });
  });

  socket.on('disconnect', () => {
    console.log('Spieler getrennt:', socket.id);
    // Spieler aus allen Räumen entfernen
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const idx = room.players.indexOf(socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        io.to(roomId).emit('playerLeft');
        if (room.players.length === 0) {
          delete rooms[roomId];
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
