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
                             // - besiegte Einheiten werden hieraus entfernt (siehe removeDefeatedUnit)
let positions = {};         // unitId -> {q,r}, für ALLE (noch lebenden) Einheiten, erst ab gameStart
let hp = {};                 // unitId -> aktuelle Bataillons-HP, für ALLE Einheiten, erst ab gameStart
let myPlans = {};           // unitId -> geplante Schritte, nur für EIGENE (lebende) Einheiten
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

// Eigene Ebenen fuer Einheiten-Chips und HP-Baelken (statt direkt an <svg>
// zu haengen): SVG zeichnet in DOM-Reihenfolge, hpBarLayer liegt daher IMMER
// ueber allen Chips, unabhaengig davon, wann welche Einheit erzeugt wurde -
// sonst koennte ein spaeter erzeugter Chip einen frueher erzeugten HP-Balken
// optisch verdecken.
const unitLayer = document.createElementNS(SVG_NS, 'g');
svg.appendChild(unitLayer);
const hpBarLayer = document.createElementNS(SVG_NS, 'g');
svg.appendChild(hpBarLayer);

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

socket.on('gameStart', ({ units, positions: serverPositions, hp: serverHp }) => {
  phase = 'playing';
  unitsById = {};
  units.forEach(u => { unitsById[u.id] = u; });
  positions = serverPositions;
  hp = serverHp || {};

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
  // Geschütztes Leerzeichen (U+00A0), nicht ' ' - ein reiner
  // Whitespace-Textknoten bekommt keine Line-Box, wodurch
  // .plan-unit-label kollabiert und sich das Spielfeld minimal
  // in der Groesse aendert (siehe auch closePlanning()).
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

socket.on('executeRound', ({ ticks }) => {
  closePlanning();
  editButton.classList.add('hidden');
  animateRound(ticks);
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
  unitLayer.appendChild(el);
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
  unitLayer.appendChild(el);
  return el;
}

// Ein Chip stellt optisch weiterhin nur EINE Einheit dar, ist aber ein
// Bataillon aus UnitTypes.BATTALION_SIZE Einheiten mit eigenem HP-Pool. Der
// "HP-Balken" zeigt - nur sobald das Bataillon Schaden genommen hat - direkt
// oberhalb des Chips ein Segment pro Einheit (voll = noch am Leben, leer =
// tot); die exakte HP-Zahl bleibt nur intern (in `hp`) gespeichert.
const HP_BAR_SEGMENTS = UnitTypes.BATTALION_SIZE;
const HP_BAR_WIDTH = UNIT_CHIP_SIZE * 0.8;
const HP_BAR_HEIGHT = UNIT_CHIP_SIZE * 0.065;
const HP_BAR_SEGMENT_GAP = 0.6;
const HP_BAR_SEGMENT_WIDTH = (HP_BAR_WIDTH - (HP_BAR_SEGMENTS - 1) * HP_BAR_SEGMENT_GAP) / HP_BAR_SEGMENTS;
const HP_BAR_OFFSET = UNIT_CHIP_SIZE / 2 + HP_BAR_HEIGHT / 2 + 1;
const HP_BAR_FRAME_PADDING = 1;
const hpBarElements = {};

function createHpBar(unitId) {
  const group = document.createElementNS(SVG_NS, 'g');
  group.classList.add('hp-bar', 'hidden');

  // Rahmen hinter den Segmenten - macht den Balken als Ganzes deutlich
  // sichtbar (auch auf hellen Feldern) statt nur duenne Segment-Umrisse zu
  // haben. Umrandungsfarbe = Team-Farbe der Einheit (wie bei den Chips).
  const frame = document.createElementNS(SVG_NS, 'rect');
  frame.setAttribute('x', -HP_BAR_WIDTH / 2 - HP_BAR_FRAME_PADDING);
  frame.setAttribute('y', -HP_BAR_HEIGHT / 2 - HP_BAR_FRAME_PADDING);
  frame.setAttribute('width', HP_BAR_WIDTH + HP_BAR_FRAME_PADDING * 2);
  frame.setAttribute('height', HP_BAR_HEIGHT + HP_BAR_FRAME_PADDING * 2);
  frame.classList.add('hp-bar-frame', `hp-bar-frame-${unitsById[unitId].role}`);
  group.appendChild(frame);

  const segments = [];
  for (let i = 0; i < HP_BAR_SEGMENTS; i++) {
    const segment = document.createElementNS(SVG_NS, 'rect');
    segment.setAttribute('x', -HP_BAR_WIDTH / 2 + i * (HP_BAR_SEGMENT_WIDTH + HP_BAR_SEGMENT_GAP));
    segment.setAttribute('y', -HP_BAR_HEIGHT / 2);
    segment.setAttribute('width', HP_BAR_SEGMENT_WIDTH);
    segment.setAttribute('height', HP_BAR_HEIGHT);
    segment.classList.add('hp-bar-segment');
    group.appendChild(segment);
    segments.push(segment);
  }

  hpBarLayer.appendChild(group);
  hpBarElements[unitId] = { group, segments };
}

function positionHpBar(unitId, x, y) {
  const bar = hpBarElements[unitId];
  if (!bar) return;
  bar.group.setAttribute('transform', `translate(${x}, ${y - HP_BAR_OFFSET})`);
}

function updateHpBar(unitId) {
  const bar = hpBarElements[unitId];
  const unit = unitsById[unitId];
  if (!bar || !unit) return;

  const maxHp = UnitTypes.maxHpFor(unit.typeKey);
  const currentHp = hp[unitId];
  if (currentHp == null || currentHp >= maxHp) {
    bar.group.classList.add('hidden');
    return;
  }

  const livingUnits = UnitTypes.livingUnitsFor(unit.typeKey, currentHp);

  // Lebende Segmente bleiben immer gruen (keine Farbaenderung nach HP-Anteil).
  bar.segments.forEach((segment, i) => {
    segment.classList.remove('hp-bar-dead');
    segment.classList.toggle('hp-bar-dead', i >= livingUnits);
  });
  bar.group.classList.remove('hidden');
}

// Positioniert Chip UND HP-Balken gemeinsam - wird sowohl fuer die normale
// Zielposition (renderUnit) als auch fuer Zwischenschritte (Viertel-Bewegung
// bei Blockaden/Kaempfen) verwendet, damit der Balken dem Chip immer folgt
// statt zurueckzubleiben.
function moveUnitTo(unitId, x, y) {
  positionChipElement(unitElements[unitId], x, y);
  positionHpBar(unitId, x, y);
}

function renderUnit(unitId) {
  const pos = positions[unitId];
  if (!pos) return;
  const { x, y } = toScreen(pos.q, pos.r);
  moveUnitTo(unitId, x, y);
}

function renderAllUnitsForPlay() {
  Object.values(unitsById).forEach(unit => {
    unitElements[unit.id] = createUnitChip(unit);
    createHpBar(unit.id);
  });
  Object.keys(positions).forEach(unitId => {
    renderUnit(unitId);
    updateHpBar(unitId);
  });
}

// Entfernt ein besiegtes Bataillon endgueltig vom Spielfeld (Chip + Balken
// ausgeblendet, dann aus dem DOM entfernt) - es existiert danach nicht mehr
// und kann nicht mehr gesteuert werden.
function removeDefeatedUnit(unitId) {
  const el = unitElements[unitId];
  if (el) {
    setMoveDuration(unitId, DEFEAT_FADE_DURATION);
    el.classList.add('defeated');
    setTimeout(() => el.remove(), DEFEAT_FADE_DURATION);
  }
  const bar = hpBarElements[unitId];
  if (bar) {
    bar.group.classList.add('defeated');
    setTimeout(() => bar.group.remove(), DEFEAT_FADE_DURATION);
  }

  delete unitElements[unitId];
  delete hpBarElements[unitId];
  delete positions[unitId];
  delete hp[unitId];
  delete myPlans[unitId];
  delete unitsById[unitId];
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
  planUnitLabel.textContent = ' '; // geschütztes Leerzeichen, sonst kollabiert die Zeilenhöhe (Spielfeld "springt")
  renderPlanTable();
  clearHighlights();
  clearPath();
}

function currentUnitPlan() {
  return myPlans[selectedUnitId] || [];
}

// Maximale Anzahl ECHTER Bewegungen (Feldwechsel) fuer die ausgewaehlte
// Einheit: nur Reiter duerfen 4 Felder laufen, alle anderen Arten nur 2.
// Der Planungshorizont selbst (Anzahl Takte) ist fuer ALLE Arten gleich
// (UnitTypes.DEFAULT_MAX_STEPS) - eine langsamere Einheit kann also z.B.
// die ersten beiden Takte aussetzen ("bleibt") und erst in Takt 3+4 laufen.
function currentUnitMaxMoves() {
  if (!selectedUnitId) return UnitTypes.DEFAULT_MAX_STEPS;
  return UnitTypes.maxStepsFor(unitsById[selectedUnitId].typeKey);
}

// Zaehlt, wie viele Eintraege im Plan tatsaechliche Feldwechsel sind
// (Skip-Schritte, bei denen das Feld gleich bleibt, zaehlen nicht mit).
function countMoveSteps(plan, startPos) {
  let previous = startPos;
  let moves = 0;
  plan.forEach(step => {
    if (step.q !== previous.q || step.r !== previous.r) moves++;
    previous = step;
  });
  return moves;
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
  if (countMoveSteps(plan, positions[selectedUnitId]) >= currentUnitMaxMoves()) return;

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
  if (countMoveSteps(plan, positions[selectedUnitId]) >= currentUnitMaxMoves()) return;

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
// wahrnimmt.
const TICK_LABEL_DELAY = 500;
// Dauer fuer eine volle Feld-Distanz - muss zur CSS-transition-duration von
// .unit passen. Die einzelnen Bewegungs-Phasen (Viertel-Schritt / Rest-Weg)
// bekommen ueber setMoveDuration() eine dazu proportionale, kuerzere Dauer,
// damit die gefuehlte Geschwindigkeit ueber alle Phasen hinweg gleich bleibt.
const BASE_MOVE_DURATION = 700;
const QUARTER_MOVE_DURATION = Math.round(BASE_MOVE_DURATION * 0.25);
const REMAINDER_MOVE_DURATION = BASE_MOVE_DURATION - QUARTER_MOVE_DURATION;
// "Der Takt pausiert": alle Einheiten stehen auf ihrem Viertel-Schritt, bevor
// die Problemfaelle (Blockaden/Kaempfe) nacheinander abgehandelt werden -
// macht sichtbar, wo es diesen Takt einen Konflikt gibt.
const TICK_PAUSE_HOLD = 450;
// Wie lange das gelbe Blockade-Feld sichtbar steht, BEVOR die blockierte
// Einheit von ihrem Viertel-Schritt wieder zurueckgeht.
const BLOCK_MARK_HOLD = 500;
// Wie lange das rote Kampf-Feld sichtbar steht, BEVOR HP/Marken aktualisiert
// und unterlegene/besiegte Bataillone zurueckgeschickt bzw. entfernt werden.
const COMBAT_MARK_HOLD = 500;
// Wie lange das Ausblenden eines besiegten Bataillons dauert.
const DEFEAT_FADE_DURATION = 500;
// Pause NACH einem abgehandelten Kampf, bevor der naechste (falls mehrere
// im selben Takt) beginnt - damit jeder Kampf einzeln nachvollziehbar bleibt.
const COMBAT_GAP_DURATION = 600;
// Pause nach Abschluss eines Takts, bevor der naechste beginnt.
const TICK_PAUSE_AFTER = 400;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function samePos(a, b) {
  return a.q === b.q && a.r === b.r;
}

function pointAtFraction(fromPos, toPos, fraction) {
  const a = toScreen(fromPos.q, fromPos.r);
  const b = toScreen(toPos.q, toPos.r);
  return { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction };
}

// Ueberschreibt kurzzeitig die CSS-transition-duration von Chip UND
// HP-Balken einer Einheit fuer eine einzelne Bewegungs-Phase (Viertel-
// Schritt, Rest-Weg, Rueckzug) - beide MUESSEN dieselbe Dauer bekommen,
// sonst laeuft der Balken dem (langsamer animierenden) Chip voraus statt
// mit ihm mitzuwandern.
function setMoveDuration(unitId, ms) {
  const el = unitElements[unitId];
  if (el) el.style.transitionDuration = `${ms}ms`;
  const bar = hpBarElements[unitId];
  if (bar) bar.group.style.transitionDuration = `${ms}ms`;
}

// Animiert EINEN blockierten Bewegungsversuch: das umkaempfte Feld wird gelb
// markiert (die Einheit steht zu diesem Zeitpunkt bereits auf ihrem
// Viertel-Schritt dorthin, siehe animateRound Phase 1), kurze Pause, dann
// geht die Einheit von dort wieder auf ihr eigenes Feld zurueck. animateRound
// ruft dies fuer mehrere Blockaden desselben Takts NACHEINANDER auf (nicht
// gleichzeitig), damit jede Blockade einzeln nachvollziehbar bleibt - auch
// wenn eine Blockade eine andere Einheit erst dadurch blockiert
// (Ketten-Blockade).
async function animateBlockedAttempt(attempt) {
  const { unitId, attemptedCell } = attempt;
  const el = unitElements[unitId];
  const restPos = positions[unitId]; // bereits aufgeloeste, tatsaechliche Position
  if (!el || !restPos) return;

  const cellEl = hexElements[HexBoard.keyOf(attemptedCell.q, attemptedCell.r)];
  if (cellEl) cellEl.classList.add('blocked-cell');
  await wait(BLOCK_MARK_HOLD);

  setMoveDuration(unitId, QUARTER_MOVE_DURATION);
  renderUnit(unitId); // Transition vom Viertel-Schritt zurueck auf restPos
  await wait(QUARTER_MOVE_DURATION);

  if (cellEl) cellEl.classList.remove('blocked-cell');
  setMoveDuration(unitId, BASE_MOVE_DURATION);
}

// Animiert EINE Kampfbegegnung mit 2 bis n Teilnehmern (Multikampf): die
// umkaempften Felder (`event.cells`) werden rot markiert - alle Beteiligten
// stehen zu diesem Zeitpunkt schon auf ihrem Viertel-Schritt zu ihrem
// attemptCell (siehe animateRound Phase 1). Bei einem Platztausch-Kampf sind
// das ZWEI Felder, sonst eins. Kurze Pause, dann werden HP/HP-Balken aller
// Teilnehmer aktualisiert. Alle ausser dem Gewinner (`event.moverId`, der in
// Phase 3 auf sein Feld nachrueckt) gehen vom Viertel-Schritt zurueck auf ihr
// Ursprungsfeld; besiegte Bataillone werden danach endgueltig entfernt.
// animateRound ruft dies fuer mehrere Kaempfe desselben Takts NACHEINANDER
// auf, genau wie bei mehreren Blockaden.
async function animateCombatEvent(event) {
  const { cells, participants, moverId } = event;

  const cellEls = [...new Set(cells.map(c => hexElements[HexBoard.keyOf(c.q, c.r)]))].filter(Boolean);
  cellEls.forEach(el => el.classList.add('combat-cell'));
  await wait(COMBAT_MARK_HOLD);

  participants.forEach(p => {
    if (hp[p.unitId] == null) return;
    hp[p.unitId] = p.hpAfter;
    updateHpBar(p.unitId);
  });

  // Alle Teilnehmer ausser dem Gewinner gehen von ihrem Viertel-Schritt
  // zurueck auf ihr eigenes (unveraendertes) Feld - positions[] steht dafuer
  // noch auf dem Vor-Takt-Wert.
  const retreatIds = participants
    .filter(p => p.unitId !== moverId && !p.defeated)
    .map(p => p.unitId);
  retreatIds.forEach(id => setMoveDuration(id, QUARTER_MOVE_DURATION));
  retreatIds.forEach(id => renderUnit(id));
  if (retreatIds.length > 0) await wait(QUARTER_MOVE_DURATION);
  retreatIds.forEach(id => setMoveDuration(id, BASE_MOVE_DURATION));

  cellEls.forEach(el => el.classList.remove('combat-cell'));

  participants.forEach(p => { if (p.defeated) removeDefeatedUnit(p.unitId); });
}

async function animateRound(ticks) {
  tickDisplay.classList.remove('tick-display-invisible');

  for (let tick = 0; tick < ticks.length; tick++) {
    tickDisplay.textContent = `Takt ${tick + 1} von ${ticks.length}`;
    await wait(TICK_LABEL_DELAY);

    const { positions: tickPositions, blockedAttempts, combatEvents } = ticks[tick];

    // Einheiten, die diesen Takt bereits "behandelt" wurden (blockiert oder
    // im Kampf unterlegen/gleichstehend) und deshalb NICHT mehr in Phase 3
    // ihre Bewegung zu Ende fuehren sollen - ein Kampf-Gewinner (moverId)
    // gehoert NICHT dazu, er wird ganz normal in Phase 3 fertig bewegt.
    const handledIds = new Set(blockedAttempts.map(a => a.unitId));
    combatEvents.forEach(ev => {
      ev.participants.forEach(p => { if (p.unitId !== ev.moverId) handledIds.add(p.unitId); });
    });

    // Zielfeld dieses Takts fuer jede Einheit, die ueberhaupt etwas
    // versucht - egal ob die Bewegung am Ende gelingt, blockiert wird oder
    // im Kampf unterliegt.
    const attemptTargets = {};
    Object.entries(tickPositions).forEach(([unitId, pos]) => {
      if (!samePos(pos, positions[unitId])) attemptTargets[unitId] = pos;
    });
    blockedAttempts.forEach(({ unitId, attemptedCell }) => {
      attemptTargets[unitId] = attemptedCell;
    });
    // Ein Bataillon kann in mehreren Kampf-Ereignissen desselben Takts stehen
    // (Fall 2c: erst gegen den Stehenden, dann gegen die Nachruecker) - der
    // ERSTE Eintrag bestimmt, wohin es in Phase 1 anrueckt.
    combatEvents.forEach(ev => {
      ev.participants.forEach(p => {
        if (!(p.unitId in attemptTargets)) attemptTargets[p.unitId] = p.attemptCell;
      });
    });
    const attemptingIds = Object.keys(attemptTargets);

    if (blockedAttempts.length > 0 || combatEvents.length > 0) {
      // Es gibt diesen Takt einen Konflikt (Blockade und/oder Kampf): ALLE
      // Einheiten mit einem Bewegungsversuch ruecken erst gemeinsam ein
      // Viertel des Weges vor, dann pausiert der Takt sichtbar, bevor die
      // Problemfaelle nacheinander abgehandelt werden (siehe unten). Ohne
      // Konflikt (else-Zweig) laeuft der Takt stattdessen einfach glatt durch.

      // Phase 1: ALLE Einheiten mit einem Bewegungsversuch ruecken
      // gemeinsam ein Viertel des Weges zu ihrem jeweiligen Ziel vor.
      attemptingIds.forEach(unitId => {
        setMoveDuration(unitId, QUARTER_MOVE_DURATION);
        const quarter = pointAtFraction(positions[unitId], attemptTargets[unitId], 0.25);
        moveUnitTo(unitId, quarter.x, quarter.y);
      });
      await wait(QUARTER_MOVE_DURATION);
      await wait(TICK_PAUSE_HOLD); // Takt pausiert - Konflikte werden sichtbar

      // Phase 2: Problemfaelle (Blockaden, dann Kaempfe) nacheinander abhandeln.
      for (const attempt of blockedAttempts) {
        await animateBlockedAttempt(attempt);
      }
      for (const event of combatEvents) {
        await animateCombatEvent(event);
        await wait(COMBAT_GAP_DURATION);
      }

      // Phase 3: die verbleibenden, nicht behandelten Bewegungen (inkl.
      // siegreicher Kampf-Gewinner) vom Viertel-Schritt aus zu Ende fuehren.
      const finishers = attemptingIds.filter(id => !handledIds.has(id));
      finishers.forEach(unitId => setMoveDuration(unitId, REMAINDER_MOVE_DURATION));
      finishers.forEach(unitId => {
        positions[unitId] = tickPositions[unitId];
        renderUnit(unitId);
      });
      if (finishers.length > 0) {
        await wait(REMAINDER_MOVE_DURATION);
        finishers.forEach(unitId => setMoveDuration(unitId, BASE_MOVE_DURATION));
      }
    } else if (attemptingIds.length > 0) {
      // Keine Probleme diesen Takt - einfach glatt durchlaufen, ohne
      // Viertel-Schritt-Pause.
      attemptingIds.forEach(unitId => {
        positions[unitId] = tickPositions[unitId];
        renderUnit(unitId);
      });
      await wait(BASE_MOVE_DURATION);
    }

    // Positionsstand fuer ALLE noch existierenden Einheiten synchronisieren
    // (auch die, die diesen Takt gar nichts versucht haben - fuer sie ist
    // das ein No-Op). Diesen Takt besiegte Einheiten wurden bereits per
    // removeDefeatedUnit entfernt und duerfen hier nicht wiederbelebt werden.
    Object.entries(tickPositions).forEach(([unitId, pos]) => {
      if (!unitsById[unitId]) return;
      positions[unitId] = pos;
    });

    await wait(TICK_PAUSE_AFTER);
  }

  tickDisplay.classList.add('tick-display-invisible');
  Object.values(unitsById).filter(u => u.role === myRole).forEach(u => {
    myPlans[u.id] = [];
  });
  confirmed = false;
  confirmButton.disabled = false;
  statusEl.textContent = 'Neue Runde - klick auf eine deiner Einheiten, um Züge zu planen.';
}
