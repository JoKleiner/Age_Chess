// game.js
// Orchestriert: Verbindung, Rollen-Zuweisung, Zeichnen ALLER Einheiten
// (aktuell 2 pro Seite), Planung pro ausgewählter eigener Einheit, und die
// gleichzeitige Ausführung aller Pläne nach beidseitiger Bestätigung.

const socket = io();

const svg = document.getElementById('board');
const statusEl = document.getElementById('status');
const joinButton = document.getElementById('joinButton');
const roomInput = document.getElementById('roomInput');
const planPanel = document.getElementById('planPanel');
const planUnitLabel = document.getElementById('planUnitLabel');
const planHeadRow = document.querySelector('#planTable thead tr');
const planBodyRow = document.querySelector('#planTable tbody tr');
const confirmButton = document.getElementById('confirmButton');
const editButton = document.getElementById('editButton');
const tickDisplay = document.getElementById('tickDisplay');

const OFFSET_X = 214;
const OFFSET_Y = 297;

let myRole = null;
let myRoomId = null;
let positions = {};        // unitId -> {q,r}, für ALLE Einheiten (beide Seiten)
let myPlans = {};          // unitId -> geplante Schritte, nur für EIGENE Einheiten
let selectedUnitId = null; // welche eigene Einheit wird gerade geplant
let confirmed = false;

// Spieler Rot bekommt das Brett um 180° gedreht angezeigt (eigene Einheiten unten
// im Bild), Farben bleiben aber echt (rot ist rot, blau ist blau).
// isFlipped() ist erst ab dem 'joined'-Event sinnvoll (wenn myRole bekannt ist).
function isFlipped() {
  return myRole === 'red';
}

// Bild-Chip einer Einheit: media/Reiter_{Blau|Rot}{chipIndex}.png
function chipImagePath(unit) {
  const colorName = unit.role === 'blue' ? 'Blau' : 'Rot';
  return `media/Reiter_${colorName}${unit.chipIndex}.png`;
}

// Wandelt Modell-Koordinaten (q,r) in Bildschirm-Pixel um, unter Berücksichtigung
// der Drehung für Spieler Rot. Das Brett ist punktsymmetrisch um (0,0), daher reicht
// es, die Pixel-Koordinaten zu negieren.
function toScreen(q, r) {
  const { x, y } = HexBoard.axialToPixel(q, r);
  const flip = isFlipped();
  return { x: (flip ? -x : x) + OFFSET_X, y: (flip ? -y : y) + OFFSET_Y };
}

// Eigene Gruppe für das Brett, damit es nach Rollen-Zuweisung (bekannt erst bei
// 'joined') neu (gedreht) gezeichnet werden kann, aber unter Pfad-Vorschau und
// Einheiten liegen bleibt (SVG-Zeichenreihenfolge = DOM-Reihenfolge).
const hexLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
svg.appendChild(hexLayer);
let hexElements = {};

function initBoard() {
  hexLayer.innerHTML = '';
  hexElements = HexBoard.render(hexLayer, {
    offsetX: OFFSET_X,
    offsetY: OFFSET_Y,
    flip: isFlipped(),
    onCellClick: handleBoardClick
  });
}

// Gruppe für die Pfad-Vorschau (Linie + Ghost-Kreis) der ausgewählten Einheit
const pathGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
svg.appendChild(pathGroup);

// ---------- Einheiten zeichnen (alle, aus reiter.js) ----------

const UNIT_CHIP_SIZE = Reiter.radius * 3.2; // Bild-Chip etwas größer als der alte Kreis

const unitElements = {};
Reiter.units.forEach(unit => {
  unitElements[unit.id] = createUnitImage(unit);
});

function createUnitImage(unit) {
  const image = document.createElementNS('http://www.w3.org/2000/svg', 'image');
  const href = chipImagePath(unit);
  image.setAttribute('href', href);
  image.setAttributeNS('http://www.w3.org/1999/xlink', 'href', href);
  image.setAttribute('width', UNIT_CHIP_SIZE);
  image.setAttribute('height', UNIT_CHIP_SIZE);
  image.classList.add('unit');
  image.style.display = 'none'; // erst sichtbar, sobald Startposition bekannt ist
  image.addEventListener('click', (event) => {
    event.stopPropagation();
    if (unit.role === myRole) selectUnit(unit.id);
  });
  svg.appendChild(image);
  return image;
}

function renderUnit(unitId) {
  const pos = positions[unitId];
  if (!pos) return;
  const { x, y } = toScreen(pos.q, pos.r);
  const image = unitElements[unitId];
  image.setAttribute('x', x - UNIT_CHIP_SIZE / 2);
  image.setAttribute('y', y - UNIT_CHIP_SIZE / 2);
  image.style.display = 'block';
}

function renderAllUnits() {
  Object.keys(positions).forEach(renderUnit);
}

// ---------- Raum beitreten ----------

joinButton.addEventListener('click', () => {
  const roomId = roomInput.value.trim();
  if (!roomId) {
    alert('Bitte einen Raum-Namen eingeben');
    return;
  }
  myRoomId = roomId;
  socket.emit('joinRoom', roomId);
});

socket.on('joined', ({ role, positions: serverPositions }) => {
  myRole = role;
  positions = serverPositions;
  initBoard();
  renderAllUnits();

  // Für jede eigene Einheit einen leeren Plan vorbereiten
  Reiter.units.filter(u => u.role === myRole).forEach(u => {
    myPlans[u.id] = [];
  });

  statusEl.textContent = `Du bist Spieler ${role === 'blue' ? 'Blau' : 'Rot'}. Warte auf zweiten Spieler...`;
});

socket.on('roomFull', () => {
  statusEl.textContent = 'Dieser Raum ist bereits voll. Anderen Namen wählen.';
});

socket.on('gameStart', ({ positions: serverPositions }) => {
  positions = serverPositions;
  renderAllUnits();
  const roleName = myRole === 'blue' ? 'Blau' : 'Rot';
  statusEl.textContent = `Spiel gestartet! Du bist ${roleName}. Klick auf eine deiner Einheiten, um Züge zu planen.`;
});

socket.on('planRejected', ({ reason }) => {
  statusEl.textContent = `Zug abgelehnt: ${reason}`;
  confirmed = false;
  confirmButton.disabled = false;
  editButton.classList.add('hidden');
});

socket.on('opponentConfirmed', () => {
  if (!confirmed) {
    statusEl.textContent = 'Gegenspieler hat bereits bestätigt. Du bist noch dran.';
  }
});

socket.on('executeRound', ({ steps }) => {
  closePlanning();
  editButton.classList.add('hidden');
  animateRound(steps);
});

socket.on('playerLeft', () => {
  statusEl.textContent = 'Der andere Spieler hat die Verbindung getrennt.';
});

// ---------- Planung (pro ausgewählter eigener Einheit) ----------

function selectUnit(unitId) {
  selectedUnitId = unitId;
  planPanel.classList.remove('hidden');

  const unit = Reiter.units.find(u => u.id === unitId);
  planUnitLabel.textContent = unit.label;

  renderPlanTable();
  renderPath();
  if (!confirmed) {
    highlightNextOptions();
  } else {
    clearHighlights();
  }
}

function closePlanning() {
  selectedUnitId = null;
  planPanel.classList.add('hidden');
  clearHighlights();
  clearPath();
}

function currentUnitPlan() {
  return myPlans[selectedUnitId] || [];
}

// Tabelle horizontal: Kopfzeile = Takt-Nummern, Datenzeile = gewähltes Feld.
// Zellen anklickbar: leere (nächste) Zelle = aussetzen, gefüllte Zelle =
// diesen Schritt + alle danach rückgängig machen.
function renderPlanTable() {
  planHeadRow.innerHTML = '';
  planBodyRow.innerHTML = '';

  const plan = currentUnitPlan();

  for (let i = 0; i < Reiter.maxSteps; i++) {
    const th = document.createElement('th');
    th.textContent = `Takt ${i + 1}`;
    planHeadRow.appendChild(th);

    const td = document.createElement('td');

    if (plan[i]) {
      const previous = i === 0 ? positions[selectedUnitId] : plan[i - 1];
      const isSkip = previous.q === plan[i].q && previous.r === plan[i].r;

      if (isSkip) {
        td.textContent = 'bleibt';
        td.classList.add('skip-cell');
      } else {
        const { col, row } = HexBoard.labelOf(plan[i].q, plan[i].r);
        td.textContent = `${col},${row}`;
      }

      if (!confirmed) {
        td.classList.add('clickable-cell');
        td.title = 'Klicken: diesen Schritt und alle danach rückgängig machen';
        td.addEventListener('click', () => removeStepsFrom(i));
      }
    } else if (i === plan.length && !confirmed) {
      td.textContent = '-';
      td.classList.add('clickable-cell');
      td.title = 'Klicken: diesen Takt aussetzen (Reiter bleibt stehen)';
      td.addEventListener('click', addSkipStep);
    } else {
      td.textContent = '-';
    }

    planBodyRow.appendChild(td);
  }
}

function currentPlanEndPosition() {
  const plan = currentUnitPlan();
  if (plan.length === 0) return positions[selectedUnitId];
  return plan[plan.length - 1];
}

function clearHighlights() {
  Object.values(hexElements).forEach(el => el.classList.remove('selectable'));
}

function highlightNextOptions() {
  clearHighlights();
  if (!selectedUnitId) return;

  const plan = currentUnitPlan();
  if (plan.length >= Reiter.maxSteps) return;

  const from = currentPlanEndPosition();
  HexBoard.DIRECTIONS.forEach(({ dq, dr }) => {
    const key = HexBoard.keyOf(from.q + dq, from.r + dr);
    if (hexElements[key]) {
      hexElements[key].classList.add('selectable');
    }
  });
}

// ---------- Pfad-Vorschau: Linie + Ghost-Kreis für die ausgewählte Einheit ----------

function clearPath() {
  pathGroup.innerHTML = '';
}

function renderPath() {
  clearPath();
  if (!selectedUnitId) return;

  const plan = currentUnitPlan();
  if (plan.length === 0) return;

  const startPos = positions[selectedUnitId];
  const points = [startPos, ...plan].map(p => {
    const { x, y } = toScreen(p.q, p.r);
    return `${x},${y}`;
  });

  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', points.join(' '));
  line.classList.add('path-line', `path-${myRole}`);
  pathGroup.appendChild(line);

  const last = plan[plan.length - 1];
  const { x, y } = toScreen(last.q, last.r);
  const ghost = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  ghost.setAttribute('cx', x);
  ghost.setAttribute('cy', y);
  ghost.setAttribute('r', Reiter.radius);
  ghost.classList.add(`ghost-${myRole}`);
  pathGroup.appendChild(ghost);
}

function addSkipStep() {
  if (!selectedUnitId || confirmed) return;
  const plan = currentUnitPlan();
  if (plan.length >= Reiter.maxSteps) return;

  const from = currentPlanEndPosition();
  plan.push({ q: from.q, r: from.r });
  renderPlanTable();
  renderPath();
  highlightNextOptions();
}

function removeStepsFrom(index) {
  if (confirmed || !selectedUnitId) return;
  myPlans[selectedUnitId] = currentUnitPlan().slice(0, index);
  renderPlanTable();
  renderPath();
  highlightNextOptions();
}

function handleBoardClick(q, r) {
  if (!selectedUnitId || confirmed) return;

  const plan = currentUnitPlan();
  if (plan.length >= Reiter.maxSteps) return;

  const from = currentPlanEndPosition();
  const distance = HexBoard.hexDistance(from, { q, r });
  if (distance !== 1) return; // nur direkte Nachbarn erlaubt

  plan.push({ q, r });
  renderPlanTable();
  renderPath();
  highlightNextOptions();
}

confirmButton.addEventListener('click', () => {
  if (confirmed || !myRoomId || !myRole) return;
  confirmed = true;
  confirmButton.disabled = true;
  editButton.classList.remove('hidden');
  clearHighlights();
  statusEl.textContent = 'Züge bestätigt. Warte auf Gegenspieler...';
  socket.emit('submitPlan', { roomId: myRoomId, plan: myPlans });
});

editButton.addEventListener('click', () => {
  if (!confirmed || !myRoomId) return;
  confirmed = false;
  confirmButton.disabled = false;
  editButton.classList.add('hidden');
  statusEl.textContent = 'Zug wird wieder bearbeitet.';
  socket.emit('cancelPlan', { roomId: myRoomId });
  renderPlanTable();
  highlightNextOptions();
});

// ---------- Gleichzeitige Ausführung (bis zu 4 Takte, alle Einheiten) ----------

function animateRound(stepsByUnit) {
  const totalTicks = Math.max(0, ...Object.values(stepsByUnit).map(s => s.length));
  let tick = 0;
  tickDisplay.classList.remove('hidden');

  function nextTick() {
    if (tick >= totalTicks) {
      tickDisplay.classList.add('hidden');
      Reiter.units.filter(u => u.role === myRole).forEach(u => {
        myPlans[u.id] = [];
      });
      confirmed = false;
      confirmButton.disabled = false;
      statusEl.textContent = 'Neue Runde - klick auf eine deiner Einheiten, um Züge zu planen.';
      return;
    }

    tickDisplay.textContent = `Takt ${tick + 1} von ${totalTicks}`;

    Object.entries(stepsByUnit).forEach(([unitId, steps]) => {
      if (steps[tick]) {
        positions[unitId] = steps[tick];
        renderUnit(unitId);
      }
    });

    tick++;
    setTimeout(nextTick, 800);
  }

  nextTick();
}
