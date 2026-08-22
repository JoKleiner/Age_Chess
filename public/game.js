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

const OFFSET_X = 480;
const OFFSET_Y = 410;

let myRole = null;
let myRoomId = null;
let positions = {};        // unitId -> {q,r}, für ALLE Einheiten (beide Seiten)
let myPlans = {};          // unitId -> geplante Schritte, nur für EIGENE Einheiten
let selectedUnitId = null; // welche eigene Einheit wird gerade geplant
let confirmed = false;

const hexElements = HexBoard.render(svg, {
  offsetX: OFFSET_X,
  offsetY: OFFSET_Y,
  onCellClick: handleBoardClick
});

// Gruppe für die Pfad-Vorschau (Linie + Ghost-Kreis) der ausgewählten Einheit
const pathGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
svg.appendChild(pathGroup);

// ---------- Einheiten zeichnen (alle, aus reiter.js) ----------

const unitCircles = {};
Reiter.units.forEach(unit => {
  unitCircles[unit.id] = createUnitCircle(unit);
});

function createUnitCircle(unit) {
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('r', Reiter.radius);
  circle.classList.add('unit', `unit-${unit.role}`);
  circle.style.display = 'none'; // erst sichtbar, sobald Startposition bekannt ist
  circle.addEventListener('click', (event) => {
    event.stopPropagation();
    if (unit.role === myRole) selectUnit(unit.id);
  });
  svg.appendChild(circle);
  return circle;
}

function renderUnit(unitId) {
  const pos = positions[unitId];
  if (!pos) return;
  const { x, y } = HexBoard.axialToPixel(pos.q, pos.r);
  unitCircles[unitId].setAttribute('cx', x + OFFSET_X);
  unitCircles[unitId].setAttribute('cy', y + OFFSET_Y);
  unitCircles[unitId].style.display = 'block';
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
    const { x, y } = HexBoard.axialToPixel(p.q, p.r);
    return `${x + OFFSET_X},${y + OFFSET_Y}`;
  });

  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', points.join(' '));
  line.classList.add('path-line', `path-${myRole}`);
  pathGroup.appendChild(line);

  const last = plan[plan.length - 1];
  const { x, y } = HexBoard.axialToPixel(last.q, last.r);
  const ghost = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  ghost.setAttribute('cx', x + OFFSET_X);
  ghost.setAttribute('cy', y + OFFSET_Y);
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
