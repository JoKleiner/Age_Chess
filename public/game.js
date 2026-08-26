// game.js
// Orchestriert: Verbindung, Rollen-Zuweisung, die Platzierungsphase (eigene
// Einheiten von privaten Stapeln wählen und auf dem eigenen Bereich
// platzieren), und nach beidseitiger Bereitschaft die Planung pro
// ausgewählter eigener Einheit sowie die gleichzeitige Ausführung aller
// Pläne nach beidseitiger Bestätigung.

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

const socket = io();

const svg = document.getElementById('board');
const statusEl = document.getElementById('status');
const gameAreaEl = document.getElementById('gameArea');
const joinButton = document.getElementById('joinButton');
const roomInput = document.getElementById('roomInput');
const joinAreaEl = document.getElementById('joinArea');
const planPanel = document.getElementById('planPanel');
const planUnitLabel = document.getElementById('planUnitLabel');
const planHeadRow = document.querySelector('#planTable thead tr');
const planBodyRow = document.querySelector('#planTable tbody tr');
const confirmButton = document.getElementById('confirmButton');
const editButton = document.getElementById('editButton');
const tickDisplay = document.getElementById('tickDisplay');
const sideControls = document.getElementById('sideControls');
const setupPanel = document.getElementById('setupPanel');
const setupCounter = document.getElementById('setupCounter');
const stackList = document.getElementById('stackList');
const placementReadyButton = document.getElementById('placementReadyButton');
const placementEditButton = document.getElementById('placementEditButton');

const OFFSET_X = 214;
const OFFSET_Y = 234.5;
const CHIP_RADIUS = HexBoard.HEX_SIZE * UnitTypes.CHIP_RADIUS_FACTOR;
const UNIT_CHIP_SIZE = CHIP_RADIUS * 3.2;

let myRole = null;
let myRoomId = null;
let myUnitTypes = UnitTypes.TYPES;
let maxUnitsPerPlayer = UnitTypes.MAX_UNITS_PER_PLAYER;

let phase = null;           // 'placement' | 'playing'
let placedByType = {};      // typeKey -> [{unitId, q, r}, ...] in Platzierungs-Reihenfolge (nur eigene)
let armedTypeKey = null;    // welcher Stapel ist gerade zum Platzieren ausgewählt
let placementReady = false;
let placementChipElements = {}; // unitId -> SVG-Element (Vorschau während der Platzierung, nur eigene)

let unitsById = {};         // unitId -> {id, role, typeKey, chipIndex, label}, erst ab gameStart
let positions = {};         // unitId -> {q,r}, für ALLE Einheiten (beide Seiten), erst ab gameStart
let myPlans = {};           // unitId -> geplante Schritte, nur für EIGENE Einheiten
let selectedUnitId = null;  // welche eigene Einheit wird gerade geplant
let confirmed = false;

// Spieler Rot bekommt das Brett um 180° gedreht angezeigt (eigene Einheiten unten
// im Bild), Farben bleiben aber echt (rot ist rot, blau ist blau).
// isFlipped() ist erst ab dem 'joined'-Event sinnvoll (wenn myRole bekannt ist).
function isFlipped() {
  return myRole === 'red';
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
const hexLayer = document.createElementNS(SVG_NS, 'g');
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

  // viewBox an den tatsächlichen Inhalt (inkl. Spalten-/Reihen-Beschriftung)
  // anpassen, damit nichts abgeschnitten wird, egal wie groß die Ränder
  // durch die Labels ausfallen.
  const bbox = hexLayer.getBBox();
  const padding = 4;
  svg.setAttribute(
    'viewBox',
    `${bbox.x - padding} ${bbox.y - padding} ${bbox.width + padding * 2} ${bbox.height + padding * 2}`
  );
}

// Gruppe für die Pfad-Vorschau (Linie + Ghost-Kreis) der ausgewählten Einheit
const pathGroup = document.createElementNS(SVG_NS, 'g');
svg.appendChild(pathGroup);

// ---------- Chip-Zeichnung (gemeinsam für Platzierungs-Vorschau & Spiel-Einheiten) ----------

// Erzeugt ein <image> (Einheiten-Art mit echtem Artwork) oder einen generierten
// Kreis-Chip mit Buchstabe (Platzhalter-Arten ohne Artwork).
function createChipElement(role, typeKey, chipIndex) {
  const type = UnitTypes.byKey(typeKey);
  let el;

  if (type.chip.kind === 'image') {
    const colorName = role === 'blue' ? 'Blau' : 'Rot';
    const href = `media/${type.chip.imageFolder}/${type.chip.imageBase}_${colorName}${chipIndex}.png`;
    el = document.createElementNS(SVG_NS, 'image');
    el.setAttribute('href', href);
    el.setAttributeNS(XLINK_NS, 'href', href);
    el.setAttribute('width', UNIT_CHIP_SIZE);
    el.setAttribute('height', UNIT_CHIP_SIZE);
  } else {
    el = document.createElementNS(SVG_NS, 'g');
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', UNIT_CHIP_SIZE / 2);
    circle.setAttribute('cy', UNIT_CHIP_SIZE / 2);
    circle.setAttribute('r', UNIT_CHIP_SIZE / 2);
    circle.classList.add('chip-circle', `chip-${role}`);
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', UNIT_CHIP_SIZE / 2);
    text.setAttribute('y', UNIT_CHIP_SIZE / 2);
    text.classList.add('chip-label');
    text.textContent = `${type.chip.letter}${chipIndex}`;
    el.appendChild(circle);
    el.appendChild(text);
  }

  el.classList.add('unit');
  return el;
}

// Positionierung einheitlich über "transform" (statt x/y-Attribute beim
// <image>-Tag), damit die CSS-Transition auf .unit für beide Chip-Arten
// gleichermaßen greift und Bewegungen weich statt sprunghaft wirken.
function positionChipElement(el, x, y) {
  el.setAttribute('transform', `translate(${x - UNIT_CHIP_SIZE / 2}, ${y - UNIT_CHIP_SIZE / 2})`);
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

roomInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    joinButton.click();
  }
});

socket.on('joined', ({ role, unitTypes, maxUnitsPerPlayer: maxUnits }) => {
  myRole = role;
  myUnitTypes = unitTypes || UnitTypes.TYPES;
  maxUnitsPerPlayer = maxUnits || UnitTypes.MAX_UNITS_PER_PLAYER;
  phase = 'placement';
  placedByType = {};

  joinAreaEl.classList.add('hidden');
  statusEl.classList.remove('hidden');
  gameAreaEl.classList.remove('hidden');
  setupPanel.classList.remove('hidden');
  initBoard();
  highlightOwnZone();
  renderStackList();
  statusEl.textContent = `Du bist Spieler ${role === 'blue' ? 'Blau' : 'Rot'}. Wähle deine Einheiten aus und platziere sie auf deinem Bereich.`;
});

socket.on('roomFull', () => {
  statusEl.classList.remove('hidden');
  statusEl.textContent = 'Dieser Raum ist bereits voll. Anderen Namen wählen.';
});

socket.on('placementPhaseStart', () => {
  if (!placementReady) {
    statusEl.textContent = 'Gegenspieler ist da. Wähle deine Einheiten aus und platziere sie auf deinem Bereich.';
  }
});

socket.on('placementAccepted', () => {
  // Optimistisch bereits lokal übernommen; nichts weiter zu tun.
});

socket.on('placementRejected', ({ reason }) => {
  // Letzte optimistisch platzierte Einheit dieser Art wieder entfernen.
  if (armedTypeKey && placedByType[armedTypeKey] && placedByType[armedTypeKey].length > 0) {
    const removed = placedByType[armedTypeKey].pop();
    removePlacementChip(removed.unitId);
  }
  statusEl.textContent = `Platzierung abgelehnt: ${reason}`;
  renderStackList();
  highlightOwnZone();
});

socket.on('opponentPlacementReady', () => {
  if (!placementReady) {
    statusEl.textContent = 'Gegenspieler ist mit der Platzierung fertig. Du bist noch dran.';
  }
});

socket.on('gameStart', ({ units, positions: serverPositions }) => {
  phase = 'playing';
  unitsById = {};
  units.forEach(u => { unitsById[u.id] = u; });
  positions = serverPositions;

  Object.values(placementChipElements).forEach(el => el.remove());
  placementChipElements = {};
  setupPanel.classList.add('hidden');
  clearHighlights();
  sideControls.classList.remove('hidden');

  renderAllUnitsForPlay();

  Object.values(unitsById).filter(u => u.role === myRole).forEach(u => {
    myPlans[u.id] = [];
  });

  // Plan-Panel bleibt ab jetzt permanent im Layout (nur unsichtbar, wenn keine
  // Einheit ausgewählt ist), damit das Spielfeld beim Ein-/Ausblenden der
  // Tabelle nicht die Größe ändert.
  planPanel.classList.remove('hidden');
  planPanel.classList.add('plan-panel-invisible');
  planUnitLabel.textContent = ' ';
  renderPlanTable();

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

// ---------- Platzierungsphase ----------

function isOwnZoneCell(q, r) {
  return HexBoard.zoneOf(q, r) === myRole;
}

function highlightOwnZone() {
  clearHighlights();
  Object.entries(hexElements).forEach(([key, el]) => {
    const [q, r] = key.split(',').map(Number);
    if (isOwnZoneCell(q, r) && !isOwnCellOccupied(q, r)) {
      el.classList.add(armedTypeKey ? 'selectable' : 'own-zone');
    }
  });
}

function isOwnCellOccupied(q, r) {
  return Object.values(placedByType).some(list => list.some(p => p.q === q && p.r === r));
}

function totalPlacedCount() {
  return Object.values(placedByType).reduce((sum, list) => sum + list.length, 0);
}

function renderStackList() {
  stackList.innerHTML = '';
  setupCounter.textContent = `${totalPlacedCount()} / ${maxUnitsPerPlayer} Einheiten platziert`;

  myUnitTypes.forEach(type => {
    const placed = placedByType[type.key] || [];
    const nextIndex = placed.length + 1;
    const exhausted = placed.length >= type.maxPerPlayer;
    const capReached = totalPlacedCount() >= maxUnitsPerPlayer;

    const card = document.createElement('div');
    card.classList.add('stack-card');
    if (type.key === armedTypeKey) card.classList.add('armed');
    if (exhausted || capReached) card.classList.add('disabled');

    const preview = document.createElement('div');
    preview.classList.add('stack-chip-preview');
    if (exhausted) {
      preview.textContent = '—';
      preview.classList.add('stack-chip-empty');
    } else if (type.chip.kind === 'image') {
      const img = document.createElement('img');
      const colorName = myRole === 'blue' ? 'Blau' : 'Rot';
      img.src = `media/${type.chip.imageFolder}/${type.chip.imageBase}_${colorName}${nextIndex}.png`;
      img.alt = type.label;
      preview.appendChild(img);
    } else {
      preview.classList.add(`chip-${myRole}`);
      preview.textContent = `${type.chip.letter}${nextIndex}`;
    }

    const label = document.createElement('div');
    label.classList.add('stack-label');
    label.textContent = type.label;

    const count = document.createElement('div');
    count.classList.add('stack-count');
    count.textContent = `${placed.length} / ${type.maxPerPlayer}`;

    card.appendChild(preview);
    card.appendChild(label);
    card.appendChild(count);

    if (!exhausted && !capReached && !placementReady) {
      card.addEventListener('click', () => armType(type.key));
    }

    stackList.appendChild(card);
  });
}

function armType(typeKey) {
  if (placementReady) return;
  armedTypeKey = armedTypeKey === typeKey ? null : typeKey;
  renderStackList();
  highlightOwnZone();
}

function createPlacementChip(unitId, typeKey, chipIndex, q, r) {
  const el = createChipElement(myRole, typeKey, chipIndex);
  const { x, y } = toScreen(q, r);
  positionChipElement(el, x, y);
  el.addEventListener('click', (event) => {
    event.stopPropagation();
    handlePlacementChipClick(unitId, typeKey);
  });
  svg.appendChild(el);
  placementChipElements[unitId] = el;
}

function removePlacementChip(unitId) {
  const el = placementChipElements[unitId];
  if (el) {
    el.remove();
    delete placementChipElements[unitId];
  }
}

function handlePlacementChipClick(unitId, typeKey) {
  if (placementReady) return;
  const list = placedByType[typeKey] || [];
  const clickedIndex = list.findIndex(p => p.unitId === unitId);
  if (clickedIndex === -1) return;

  // Klick auf eine platzierte Einheit nimmt sie und alle danach platzierten
  // Einheiten derselben Art zurück auf den Stapel (Stapel-Reihenfolge bleibt
  // lückenlos, siehe removeStepsFrom-Muster bei der Zugplanung).
  const removedCount = list.length - clickedIndex;
  const removed = list.splice(clickedIndex);
  removed.forEach(p => removePlacementChip(p.unitId));

  for (let i = 0; i < removedCount; i++) {
    socket.emit('undoLastPlacement', { roomId: myRoomId, typeKey });
  }

  renderStackList();
  highlightOwnZone();
}

function handlePlacementClick(q, r) {
  if (!armedTypeKey || placementReady) return;
  if (!isOwnZoneCell(q, r) || isOwnCellOccupied(q, r)) return;

  const type = UnitTypes.byKey(armedTypeKey);
  const list = placedByType[armedTypeKey] || (placedByType[armedTypeKey] = []);
  if (list.length >= type.maxPerPlayer || totalPlacedCount() >= maxUnitsPerPlayer) return;

  const chipIndex = list.length + 1;
  const unitId = `${myRole}_${armedTypeKey}_${chipIndex}`;
  list.push({ unitId, q, r });
  createPlacementChip(unitId, armedTypeKey, chipIndex, q, r);
  socket.emit('placeUnit', { roomId: myRoomId, typeKey: armedTypeKey, q, r });

  // Nach jeder Platzierung wird die Auswahl wieder gelöst - der Spieler muss
  // den Stapel erneut anklicken, um die nächste Einheit zu platzieren.
  armedTypeKey = null;
  renderStackList();
  highlightOwnZone();
}

placementReadyButton.addEventListener('click', () => {
  if (placementReady || !myRoomId) return;
  placementReady = true;
  armedTypeKey = null;
  placementReadyButton.disabled = true;
  placementEditButton.classList.remove('hidden');
  clearHighlights();
  statusEl.textContent = 'Platzierung bestätigt. Warte auf Gegenspieler...';
  renderStackList();
  socket.emit('placementReady', { roomId: myRoomId });
});

placementEditButton.addEventListener('click', () => {
  if (!placementReady || !myRoomId) return;
  placementReady = false;
  placementReadyButton.disabled = false;
  placementEditButton.classList.add('hidden');
  statusEl.textContent = 'Platzierung wird wieder bearbeitet.';
  socket.emit('cancelPlacementReady', { roomId: myRoomId });
  renderStackList();
  highlightOwnZone();
});

// ---------- Einheiten zeichnen (Spielphase, alle Einheiten) ----------

const unitElements = {};

function createUnitChip(unit) {
  const el = createChipElement(unit.role, unit.typeKey, unit.chipIndex);
  el.addEventListener('click', (event) => {
    event.stopPropagation();
    if (unit.role === myRole) selectUnit(unit.id);
  });
  svg.appendChild(el);
  return el;
}

function renderUnit(unitId) {
  const pos = positions[unitId];
  if (!pos) return;
  const { x, y } = toScreen(pos.q, pos.r);
  positionChipElement(unitElements[unitId], x, y);
}

function renderAllUnitsForPlay() {
  Object.values(unitsById).forEach(unit => {
    unitElements[unit.id] = createUnitChip(unit);
  });
  Object.keys(positions).forEach(renderUnit);
}

// ---------- Planung (pro ausgewählter eigener Einheit) ----------

function selectUnit(unitId) {
  selectedUnitId = unitId;
  planPanel.classList.remove('plan-panel-invisible');

  const unit = unitsById[unitId];
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
  planPanel.classList.add('plan-panel-invisible');
  planUnitLabel.textContent = ' ';
  renderPlanTable();
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

  for (let i = 0; i < UnitTypes.DEFAULT_MAX_STEPS; i++) {
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
      td.title = 'Klicken: diesen Takt aussetzen (Einheit bleibt stehen)';
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
  Object.values(hexElements).forEach(el => el.classList.remove('selectable', 'own-zone'));
}

function highlightNextOptions() {
  clearHighlights();
  if (!selectedUnitId) return;

  const plan = currentUnitPlan();
  if (plan.length >= UnitTypes.DEFAULT_MAX_STEPS) return;

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

  const line = document.createElementNS(SVG_NS, 'polyline');
  line.setAttribute('points', points.join(' '));
  line.classList.add('path-line', `path-${myRole}`);
  pathGroup.appendChild(line);

  const last = plan[plan.length - 1];
  const { x, y } = toScreen(last.q, last.r);
  const ghost = document.createElementNS(SVG_NS, 'circle');
  ghost.setAttribute('cx', x);
  ghost.setAttribute('cy', y);
  ghost.setAttribute('r', CHIP_RADIUS);
  ghost.classList.add(`ghost-${myRole}`);
  pathGroup.appendChild(ghost);
}

function addSkipStep() {
  if (!selectedUnitId || confirmed) return;
  const plan = currentUnitPlan();
  if (plan.length >= UnitTypes.DEFAULT_MAX_STEPS) return;

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
  if (phase === 'placement') {
    handlePlacementClick(q, r);
    return;
  }

  if (!selectedUnitId || confirmed) return;

  const plan = currentUnitPlan();
  if (plan.length >= UnitTypes.DEFAULT_MAX_STEPS) return;

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

// Zeit, die die Takt-Anzeige sichtbar ist, BEVOR sich die Einheiten für
// diesen Takt bewegen (auch beim allerersten Takt) - sonst würde der erste
// Zug sofort beim Bestätigen ausgeführt, ohne dass man die Anzeige noch
// wahrnimmt. TICK_MOVE_DURATION muss zur CSS-transition-duration von .unit
// passen, damit die Bewegung bis zum nächsten Takt sichtbar abgeschlossen ist.
const TICK_LABEL_DELAY = 500;
const TICK_MOVE_DURATION = 700;
const TICK_PAUSE_AFTER = 400;

function animateRound(stepsByUnit) {
  const totalTicks = Math.max(0, ...Object.values(stepsByUnit).map(s => s.length));
  let tick = 0;
  tickDisplay.classList.remove('hidden');

  function nextTick() {
    if (tick >= totalTicks) {
      tickDisplay.classList.add('hidden');
      Object.values(unitsById).filter(u => u.role === myRole).forEach(u => {
        myPlans[u.id] = [];
      });
      confirmed = false;
      confirmButton.disabled = false;
      statusEl.textContent = 'Neue Runde - klick auf eine deiner Einheiten, um Züge zu planen.';
      return;
    }

    tickDisplay.textContent = `Takt ${tick + 1} von ${totalTicks}`;

    setTimeout(() => {
      Object.entries(stepsByUnit).forEach(([unitId, steps]) => {
        if (steps[tick]) {
          positions[unitId] = steps[tick];
          renderUnit(unitId);
        }
      });

      tick++;
      setTimeout(nextTick, TICK_MOVE_DURATION + TICK_PAUSE_AFTER);
    }, TICK_LABEL_DELAY);
  }

  nextTick();
}
