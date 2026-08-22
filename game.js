const socket = io();

const statusEl = document.getElementById('status');
const boardEl = document.getElementById('board');
const joinButton = document.getElementById('joinButton');
const roomInput = document.getElementById('roomInput');

let myPlayerNumber = null; // 1 oder 2
let mySymbol = null;       // 'X' oder 'O'
let currentBoard = Array(9).fill(null);
let myRoomId = null;

// Raum beitreten, wenn Button geklickt wird
joinButton.addEventListener('click', () => {
  const roomId = roomInput.value.trim();
  if (!roomId) {
    alert('Bitte einen Raum-Namen eingeben');
    return;
  }
  myRoomId = roomId;
  socket.emit('joinRoom', roomId);
});

// Server bestätigt Beitritt
socket.on('joined', ({ playerNumber }) => {
  myPlayerNumber = playerNumber;
  mySymbol = playerNumber === 1 ? 'X' : 'O';
  statusEl.textContent = `Du bist Spieler ${playerNumber} (${mySymbol}). Warte auf zweiten Spieler...`;
});

socket.on('roomFull', () => {
  statusEl.textContent = 'Dieser Raum ist bereits voll. Anderen Namen wählen.';
});

// Spiel startet, sobald zwei Spieler da sind
socket.on('gameStart', ({ board }) => {
  currentBoard = board;
  statusEl.textContent = `Spiel gestartet! Du bist ${mySymbol}.`;
  renderBoard();
});

// Ein Zug wurde gemacht (von irgendeinem Spieler im Raum)
socket.on('moveMade', ({ board }) => {
  currentBoard = board;
  renderBoard();
});

socket.on('playerLeft', () => {
  statusEl.textContent = 'Der andere Spieler hat die Verbindung getrennt.';
});

// Brett zeichnen
function renderBoard() {
  boardEl.innerHTML = '';
  currentBoard.forEach((value, index) => {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.textContent = value || '';
    cell.addEventListener('click', () => handleCellClick(index));
    boardEl.appendChild(cell);
  });
}

// Klick auf ein Feld
function handleCellClick(index) {
  if (!myRoomId || !mySymbol) return;
  if (currentBoard[index] !== null) return; // Feld schon belegt

  socket.emit('makeMove', { roomId: myRoomId, index, symbol: mySymbol });
}

// Initiales leeres Brett anzeigen
renderBoard();
