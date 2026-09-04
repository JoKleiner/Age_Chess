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
const nameInput = document.getElementById('nameInput');
const joinAreaEl = document.getElementById('joinArea');
const scoreBar = document.getElementById('scoreBar');
const scoreNameBlue = document.getElementById('scoreNameBlue');
const scoreNameRed = document.getElementById('scoreNameRed');
const scoreDotsBlue = document.getElementById('scoreDotsBlue');
const scoreDotsRed = document.getElementById('scoreDotsRed');
const scoreRound = document.getElementById('scoreRound');
const roundBanner = document.getElementById('roundBanner');
const victoryOverlay = document.getElementById('victoryOverlay');
const victoryTitle = document.getElementById('victoryTitle');
const victoryName = document.getElementById('victoryName');
const victoryCountdown = document.getElementById('victoryCountdown');
const planPanel = document.getElementById('planPanel');
const planHeadRow = document.querySelector('#planTable thead tr');
const planBodyRow = document.querySelector('#planTable tbody tr');
const shotArea = document.getElementById('shotArea');
const shotControls = document.getElementById('shotControls');
const farShotButton = document.getElementById('farShotButton');
const nearShotButton = document.getElementById('nearShotButton');
const shotCrest = document.getElementById('shotCrest');
const shotCrestType = document.getElementById('shotCrestType');
const shotCrestTarget = document.getElementById('shotCrestTarget');
const shotCrestArrival = document.getElementById('shotCrestArrival');
const turnControls = document.getElementById('turnControls');
const turnButton = document.getElementById('turnButton');
const interceptControls = document.getElementById('interceptControls');
const interceptButton = document.getElementById('interceptButton');
const moveOrSelectOverlay = document.getElementById('moveOrSelectOverlay');
const choiceMoveButton = document.getElementById('choiceMoveButton');
const choiceSelectButton = document.getElementById('choiceSelectButton');
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
let shotTargeting = null;   // 'far' | 'near' | null - Feld-/Richtungswahl fuer einen Schuss laeuft gerade
let turnTargeting = false;  // true = Reiter waehlt gerade eine neue Blickrichtung (Dreh-Schritt)
let interceptTargeting = false; // true = Schwert/Speerkaempfer waehlt gerade eine gegnerische Einheit zum Abfangen
let matchScores = { blue: 0, red: 0 };
let matchNames = { blue: 'Spieler Blau', red: 'Spieler Rot' };
let facings = {};           // unitId -> Blickrichtung (0..5, Index in HexBoard.DIRECTIONS), nur Arten mit Blickrichtung
let pendingReiterPlacement = null; // { q, r, chipIndex } - Reiter platziert, wartet auf Blickrichtungs-Wahl

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
// Blickrichtungs-Dreiecke (Reiter) - ueber Chips/HP-Balken, damit sie nie
// verdeckt werden.
const facingLayer = document.createElementNS(SVG_NS, 'g');
svg.appendChild(facingLayer);
// Blickrichtungs-Auswahl-Pfeile waehrend der Platzierung.
const placementFacingLayer = document.createElementNS(SVG_NS, 'g');
svg.appendChild(placementFacingLayer);
// Fliegende Pfeile (Bogenschuetzen-Beschuss) - liegt ueber allem anderen.
const arrowLayer = document.createElementNS(SVG_NS, 'g');
svg.appendChild(arrowLayer);
const activeArrows = {}; // eventId -> { el, fromPos, toPos, angle, launchTick, arrivalTick }

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

// ---------- Blickrichtung: Dreieck-Marker (Reiter) ----------

// Bildschirm-Winkel (Grad) der Richtung `dirIndex` - abgeleitet aus der
// linearen Pixel-Abbildung, daher unabhaengig von der konkreten Position, aber
// abhaengig von der Brett-Drehung (isFlipped). 0 = rechts, +90 = unten.
function dirScreenAngleDeg(dirIndex) {
  const d = HexBoard.DIRECTIONS[((dirIndex % 6) + 6) % 6];
  const o = toScreen(0, 0);
  const p = toScreen(d.dq, d.dr);
  return Math.atan2(p.y - o.y, p.x - o.x) * 180 / Math.PI;
}

// Dreieck, das nach +X zeigt (Spitze ein Stueck ausserhalb des Chip-Rands);
// die echte Blickrichtung kommt ueber rotate() im transform dazu.
const FACING_MARKER_POINTS =
  `${CHIP_RADIUS * 2.15},0 ${CHIP_RADIUS * 1.5},${-CHIP_RADIUS * 0.5} ${CHIP_RADIUS * 1.5},${CHIP_RADIUS * 0.5}`;

const facingMarkers = {}; // unitId -> <polygon>

// Setzt Position + Rotation eines Blickrichtungs-Markers OHNE CSS-Transition
// (harter "Teleport" der Ausrichtung). Danach laeuft die naechste
// Positionsaenderung wieder animiert.
function snapFacingMarker(unitId) {
  const poly = facingMarkers[unitId];
  const pos = positions[unitId];
  if (!poly || !pos) return;
  const prev = poly.style.transition;
  poly.style.transition = 'none';
  const { x, y } = toScreen(pos.q, pos.r);
  positionFacingMarker(unitId, x, y);
  // Reflow erzwingen, damit das folgende Zuruecksetzen der Transition nicht
  // rueckwirkend die gerade gesetzte Rotation doch noch animiert.
  void poly.getBoundingClientRect();
  poly.style.transition = prev || '';
}

function createFacingMarker(unitId) {
  const unit = unitsById[unitId];
  if (!unit || !UnitTypes.hasFacing(unit.typeKey)) return;
  const poly = document.createElementNS(SVG_NS, 'polygon');
  poly.setAttribute('points', FACING_MARKER_POINTS);
  poly.classList.add('facing-marker', `facing-${unit.role}`);
  facingLayer.appendChild(poly);
  facingMarkers[unitId] = poly;
}

// Naechster fortlaufender Winkel zu `targetRaw`, ausgehend von `prev` - so dass
// die CSS-Transition IMMER den kuerzeren Weg dreht. Genau entgegengesetzt
// (180 Grad) => im Uhrzeigersinn (+180, Bildschirm-Uhrzeigersinn = wachsender
// Winkel, da y nach unten zeigt).
function continuousAngle(prev, targetRaw) {
  if (prev == null || !isFinite(prev)) return targetRaw;
  let delta = (((targetRaw - prev) % 360) + 360) % 360; // 0..360
  if (delta > 180) delta -= 360;                        // (-180 .. 180]
  return prev + delta;
}

function positionFacingMarker(unitId, x, y) {
  const poly = facingMarkers[unitId];
  if (!poly) return;
  const f = facings[unitId];
  const rawDeg = (f == null) ? 0 : dirScreenAngleDeg(f);
  const angle = continuousAngle(poly._facingAngle, rawDeg);
  poly._facingAngle = angle;
  poly.setAttribute('transform', `translate(${x}, ${y}) rotate(${angle})`);
}

function removeFacingMarker(unitId) {
  const poly = facingMarkers[unitId];
  if (poly) poly.remove();
  delete facingMarkers[unitId];
}

// Alle Blickrichtungs-Marker an die aktuelle Chip-Position + gespeicherte
// Blickrichtung setzen (nach einem Takt-Wechsel in der Wiedergabe).
function refreshFacingMarkers() {
  Object.keys(facingMarkers).forEach(unitId => {
    const pos = positions[unitId];
    if (!pos) return;
    const { x, y } = toScreen(pos.q, pos.r);
    positionFacingMarker(unitId, x, y);
  });
}

// 8-Wege-Pfeilglyphen fuer die Takt-Tabelle (Bildschirm-Ausrichtung eines
// Dreh-Schritts). 0 = rechts, im Uhrzeigersinn.
const ARROW_GLYPHS = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
function screenArrowGlyph(dirIndex) {
  const a = ((dirScreenAngleDeg(dirIndex) % 360) + 360) % 360;
  return ARROW_GLYPHS[Math.round(a / 45) % 8];
}

// ---------- Raum beitreten ----------

// Buchstaben (inkl. Umlaute/Akzente), Ziffern, Leerzeichen, gaengige
// Satzzeichen; insgesamt hoechstens 20 Zeichen. Muss zur serverseitigen
// sanitizeName passen.
function sanitizeNameClient(value) {
  return String(value || '')
    .replace(/[^A-Za-z0-9À-ſ .,!?'"()@#&+\-_/:;]/g, '')
    .slice(0, 20);
}

nameInput.addEventListener('input', () => {
  const clean = sanitizeNameClient(nameInput.value);
  if (clean !== nameInput.value) nameInput.value = clean;
});

joinButton.addEventListener('click', () => {
  const roomId = roomInput.value.trim();
  if (!roomId) {
    alert('Bitte einen Raum-Namen eingeben');
    return;
  }
  const name = sanitizeNameClient(nameInput.value).trim();
  myRoomId = roomId;
  socket.emit('joinRoom', { roomId, name });
});

[roomInput, nameInput].forEach(el => {
  el.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') joinButton.click();
  });
});

// ---------- Punkte-Anzeige (Match ueber mehrere Runden) ----------

function renderScoreDots(container, filled) {
  container.innerHTML = '';
  for (let i = 0; i < 2; i++) {
    const dot = document.createElement('span');
    dot.className = 'score-dot' + (i < filled ? ' score-dot-won' : '');
    container.appendChild(dot);
  }
}

function renderScoreBar() {
  scoreNameBlue.textContent = matchNames.blue;
  scoreNameRed.textContent = matchNames.red;
  renderScoreDots(scoreDotsBlue, matchScores.blue || 0);
  renderScoreDots(scoreDotsRed, matchScores.red || 0);
}

function setMatchState(match) {
  if (!match) return;
  if (match.scores) matchScores = match.scores;
  if (match.names) matchNames = match.names;
  if (match.round != null) scoreRound.textContent = `Runde ${match.round}`;
  renderScoreBar();
}

// ---------- Spielanleitung (Startbildschirm) ----------

const manualButtonStart = document.getElementById('manualButtonStart');
const manualButtonGame = document.getElementById('manualButtonGame');
const manualOverlay = document.getElementById('manualOverlay');
const manualContent = document.getElementById('manualContent');
const manualClose = document.getElementById('manualClose');
let manualBuilt = false;

function openManual() {
  if (!manualBuilt) { buildManual(); manualBuilt = true; }
  manualOverlay.classList.remove('hidden');
}
manualButtonStart.addEventListener('click', openManual);
manualButtonGame.addEventListener('click', openManual);
manualClose.addEventListener('click', () => manualOverlay.classList.add('hidden'));
manualOverlay.addEventListener('click', (e) => {
  if (e.target === manualOverlay) manualOverlay.classList.add('hidden');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !manualOverlay.classList.contains('hidden')) {
    manualOverlay.classList.add('hidden');
  }
});

function mEl(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

// Absatz mit fettem Label direkt in der Textzeile, z.B. "Bewegung: ...".
function labeledP(label, text) {
  const p = mEl('p');
  p.appendChild(mEl('strong', null, `${label}: `));
  p.appendChild(document.createTextNode(text));
  return p;
}

// Kleines schematisches Hex-Feld (gleiche Ausrichtung wie das echte Brett).
// spec: { radius, highlights:{'q,r':'hl-*'}, chips:[{q,r,role,label}],
//         facing:{q,r,dir}, arrows:[{from:{q,r},to:{q,r}}] }
function miniHex(spec) {
  const S = 20;
  const rad = spec.radius || 2;
  const px = (q, r) => ({ x: 1.5 * S * q, y: Math.sqrt(3) * S * (r + q / 2) });
  const corners = (cx, cy) => {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 180 * (60 * i);
      pts.push(`${(cx + S * Math.cos(a)).toFixed(2)},${(cy + S * Math.sin(a)).toFixed(2)}`);
    }
    return pts.join(' ');
  };

  const cells = [];
  for (let q = -rad; q <= rad; q++) {
    for (let r = -rad; r <= rad; r++) {
      if (Math.abs(q + r) > rad) continue;
      cells.push({ q, r });
    }
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  cells.forEach(c => {
    const p = px(c.q, c.r);
    minX = Math.min(minX, p.x - S); maxX = Math.max(maxX, p.x + S);
    minY = Math.min(minY, p.y - S); maxY = Math.max(maxY, p.y + S);
  });
  const pad = 4;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('manual-hex');
  svg.setAttribute('viewBox', `${minX - pad} ${minY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}`);

  cells.forEach(c => {
    const p = px(c.q, c.r);
    const poly = document.createElementNS(SVG_NS, 'polygon');
    poly.setAttribute('points', corners(p.x, p.y));
    poly.classList.add('manual-hex-cell');
    const hl = spec.highlights && spec.highlights[`${c.q},${c.r}`];
    if (hl) poly.classList.add(hl);
    svg.appendChild(poly);
  });

  (spec.arrows || []).forEach(ar => {
    const a = px(ar.from.q, ar.from.r);
    const b = px(ar.to.q, ar.to.r);
    const ln = document.createElementNS(SVG_NS, 'line');
    ln.setAttribute('x1', a.x); ln.setAttribute('y1', a.y);
    ln.setAttribute('x2', b.x); ln.setAttribute('y2', b.y);
    ln.classList.add(ar.cls || 'manual-hex-arrow');
    svg.appendChild(ln);
  });

  (spec.chips || []).forEach(ch => {
    const p = px(ch.q, ch.r);
    const circ = document.createElementNS(SVG_NS, 'circle');
    circ.setAttribute('cx', p.x); circ.setAttribute('cy', p.y);
    circ.setAttribute('r', S * 0.58);
    circ.classList.add('manual-hex-chip', `manual-hex-chip-${ch.role}`);
    svg.appendChild(circ);
    if (ch.label) {
      const t = document.createElementNS(SVG_NS, 'text');
      t.setAttribute('x', p.x); t.setAttribute('y', p.y);
      t.classList.add('manual-hex-chip-label');
      t.textContent = ch.label;
      svg.appendChild(t);
    }
  });

  if (spec.facing) {
    const p = px(spec.facing.q, spec.facing.r);
    const d = HexBoard.DIRECTIONS[spec.facing.dir];
    const n = px(spec.facing.q + d.dq, spec.facing.r + d.dr);
    const ang = Math.atan2(n.y - p.y, n.x - p.x) * 180 / Math.PI;
    const tri = document.createElementNS(SVG_NS, 'polygon');
    tri.setAttribute('points', `${S * 1.15},0 ${S * 0.5},${-S * 0.42} ${S * 0.5},${S * 0.42}`);
    tri.setAttribute('transform', `translate(${p.x}, ${p.y}) rotate(${ang})`);
    tri.classList.add('manual-hex-facing');
    svg.appendChild(tri);
  }

  return svg;
}

function figure(svg, caption) {
  const fig = mEl('div', 'manual-figure');
  fig.appendChild(svg);
  fig.appendChild(document.createTextNode(caption));
  return fig;
}

// Nachbar-Zellen des Ursprungs als "erreichbar" markieren.
const RING1 = {};
HexBoard.DIRECTIONS.forEach(d => { RING1[`${d.dq},${d.dr}`] = 'hl-reach'; });

// Eine gemeinsame Tabelle fuer Nahkampf- UND Beschuss-Schaden: Zeile =
// Angreifer, Spalte = getroffene Art. Der Bogenschuetze bekommt ZWEI Zeilen -
// seinen (immer 0) Nahkampf-Schaden und separat seinen Schuss-Schaden -, weil
// er als einzige Art beide Werte unabhaengig voneinander hat.
function buildHpTable() {
  const wrap = mEl('div', 'manual-table-wrap');
  const table = mEl('table', 'manual-dmg-table');

  const thead = mEl('thead');
  const hr = mEl('tr');
  hr.appendChild(mEl('th', null, 'Einheit'));
  hr.appendChild(mEl('th', null, 'Einzel-HP'));
  hr.appendChild(mEl('th', null, 'Gesamt-HP (Bataillon)'));
  thead.appendChild(hr);
  table.appendChild(thead);

  const tb = mEl('tbody');
  ['reiter', 'schwertkaempfer', 'lanze', 'bogenschuetze'].forEach(k => {
    const type = UnitTypes.byKey(k);
    const tr = mEl('tr');
    tr.appendChild(mEl('th', null, type.label));
    tr.appendChild(mEl('td', null, String(type.hp)));
    tr.appendChild(mEl('td', null, String(type.hp * UnitTypes.BATTALION_SIZE)));
    tb.appendChild(tr);
  });
  table.appendChild(tb);
  wrap.appendChild(table);
  return wrap;
}

function buildDamageTable() {
  const order = ['reiter', 'schwertkaempfer', 'lanze', 'bogenschuetze'];
  const wrap = mEl('div', 'manual-table-wrap');
  const table = mEl('table', 'manual-dmg-table');

  const thead = mEl('thead');
  const hr = mEl('tr');
  hr.appendChild(mEl('th', 'manual-dmg-corner', 'Angreifer \\ Ziel'));
  order.forEach(k => hr.appendChild(mEl('th', k === 'reiter' ? 'manual-dmg-col-wide' : null, UnitTypes.byKey(k).label)));
  thead.appendChild(hr);
  table.appendChild(thead);

  const tb = mEl('tbody');

  order.filter(a => a !== 'bogenschuetze').forEach(a => {
    const tr = mEl('tr');
    tr.appendChild(mEl('th', null, UnitTypes.byKey(a).label));
    order.forEach(d => {
      const v = UnitTypes.byKey(a).damage[d];
      tr.appendChild(mEl('td', v === 0 ? 'manual-dmg-zero' : null, String(v)));
    });
    tb.appendChild(tr);
  });

  const bow = UnitTypes.byKey('bogenschuetze');

  const meleeRow = mEl('tr');
  meleeRow.appendChild(mEl('th', null, `${bow.label} (Nahkampf)`));
  order.forEach(d => meleeRow.appendChild(mEl('td', 'manual-dmg-zero', String(bow.damage[d]))));
  tb.appendChild(meleeRow);

  const shotRow = mEl('tr');
  shotRow.appendChild(mEl('th', null, `${bow.label} (Schuss)`));
  order.forEach(d => {
    const v = bow.rangedDamage[d];
    shotRow.appendChild(mEl('td', v === 0 ? 'manual-dmg-zero' : null, String(v)));
  });
  tb.appendChild(shotRow);

  table.appendChild(tb);
  wrap.appendChild(table);
  return wrap;
}

// Bewegungsdiagramm "alle 6 Nachbarfelder" - von Schwertkaempfer, Speerkaempfer
// und Bogenschuetze gleichermassen benutzt.
function neighborMoveDiagrams() {
  return [
    figure(miniHex({
      radius: 1,
      highlights: Object.assign({ '0,0': 'hl-center' }, RING1),
      chips: [{ q: 0, r: 0, role: 'blue' }]
    }), 'Bewegung: alle 6 Nachbarfelder (bis zu 2× pro Runde)')
  ];
}

// "Abfangen"-Text und -Diagramm sind fuer Schwertkaempfer und Speerkaempfer
// identisch - beide fuehren dieselbe Spezialaktion aus.
const INTERCEPT_TEXT = 'Statt ein Feld zu wählen, wird eine gegnerische Einheit als Ziel bestimmt – die Figur läuft ihr im Ausführungstakt automatisch entgegen bzw. in den Weg (das kürzeste Feld zum Zielfeld des Gegners). Wer sich in dieser Runde noch nicht bewegt hat, kann Abfangen 2× hintereinander einsetzen.';
function interceptDiagrams() {
  return [
    figure(miniHex({
      radius: 3,
      highlights: { '-2,2': 'hl-center' },
      chips: [{ q: -2, r: 2, role: 'blue' }, { q: 2, r: -2, role: 'red', label: '?' }],
      arrows: [{ from: { q: -2, r: 2 }, to: { q: 2, r: -2 } }]
    }), 'Abfangen: läuft dem gewählten Gegner entgegen')
  ];
}

// Diagramme fuer die 3 Multikampf-Faelle. Zeigen jeweils nur das Zentrum +
// die 6 echten Nachbarfelder: die beteiligten Figuren stehen auf Nachbar-
// feldern und ziehen von dort auf das mittlere Feld.
const MULTI_DIRS = HexBoard.DIRECTIONS;
const multiCell = (i) => ({ q: MULTI_DIRS[i].dq, r: MULTI_DIRS[i].dr });

// Fall 1: V bleibt stehen, A und B greifen gleichzeitig an - V teilt seine
// Einheiten auf beide auf und schlaegt gegen beide zurueck.
function fall1Diagrams() {
  const a = multiCell(1), b = multiCell(4);
  return [
    figure(miniHex({
      radius: 1,
      highlights: { '0,0': 'hl-center' },
      chips: [
        { q: 0, r: 0, role: 'blue', label: 'V' },
        { q: a.q, r: a.r, role: 'red', label: 'A' },
        { q: b.q, r: b.r, role: 'red', label: 'B' }
      ],
      arrows: [
        { from: a, to: { q: 0, r: 0 } },
        { from: b, to: { q: 0, r: 0 } }
      ]
    }), 'V bleibt stehen, A und B greifen gleichzeitig an - V teilt sich auf und wehrt sich gegen beide')
  ];
}

// Fall 2: V bleibt stehen, greift aber gezielt (z.B. per Abfangen) nur A an -
// volle Staerke gegen A (hervorgehobene Linie), B trifft ungehindert.
function fall2Diagrams() {
  const a = multiCell(1), b = multiCell(4);
  return [
    figure(miniHex({
      radius: 1,
      highlights: { '0,0': 'hl-center' },
      chips: [
        { q: 0, r: 0, role: 'blue', label: 'V' },
        { q: a.q, r: a.r, role: 'red', label: 'A' },
        { q: b.q, r: b.r, role: 'red', label: 'B' }
      ],
      arrows: [
        { from: a, to: { q: 0, r: 0 }, cls: 'manual-hex-arrow-focus' },
        { from: b, to: { q: 0, r: 0 } }
      ]
    }), 'V greift gezielt nur A mit voller Stärke an (rote Linie) - B trifft ungehindert, ohne Gegenwehr')
  ];
}

// Fall 3: leeres Feld, 2 verbuendete (blau) gegen 3 gegnerische (rot) Figuren.
function fall3Diagrams() {
  const a = multiCell(0), b = multiCell(3), c = multiCell(1), d = multiCell(2), e = multiCell(5);
  return [
    figure(miniHex({
      radius: 1,
      highlights: { '0,0': 'hl-center' },
      chips: [
        { q: a.q, r: a.r, role: 'blue', label: 'A' },
        { q: b.q, r: b.r, role: 'blue', label: 'B' },
        { q: c.q, r: c.r, role: 'red', label: 'C' },
        { q: d.q, r: d.r, role: 'red', label: 'D' },
        { q: e.q, r: e.r, role: 'red', label: 'E' }
      ],
      arrows: [
        { from: a, to: { q: 0, r: 0 } },
        { from: b, to: { q: 0, r: 0 } },
        { from: c, to: { q: 0, r: 0 } },
        { from: d, to: { q: 0, r: 0 } },
        { from: e, to: { q: 0, r: 0 } }
      ]
    }), '2 verbündete (A, B) gegen 3 gegnerische Figuren (C, D, E) ziehen gleichzeitig auf das leere Feld')
  ];
}

const MANUAL_UNITS = [
  {
    key: 'reiter',
    sections: [
      {
        heading: 'Bewegung',
        text: 'Bis zu 4 Felder pro Runde – aber nur in den Front-Bogen der Blickrichtung: geradeaus und die beiden 60°-Nachbarn (3 Felder). Nach jedem Schritt zeigt „vorne" in die gelaufene Richtung. Die Start-Blickrichtung wird beim Platzieren gewählt und als Dreieck angezeigt.',
        diagrams: () => [
          figure(miniHex({
            radius: 1,
            highlights: { '0,0': 'hl-center', '1,-1': 'hl-reach', '0,-1': 'hl-reach', '-1,0': 'hl-reach' },
            chips: [{ q: 0, r: 0, role: 'blue' }],
            facing: { q: 0, r: 0, dir: 2 }
          }), 'Front-Bogen: nur die 3 Felder vor der Blickrichtung')
        ]
      },
      {
        heading: 'Angriff',
        text: 'Nur Nahkampf. Stark gegen Bogenschütze (10) und Schwertkämpfer (9), schwach gegen den Speerkämpfer (4).'
      },
      {
        heading: 'Reiter-Spezial: Drehen',
        text: 'Der Button „Drehen" kostet 1 Takt und richtet den Reiter neu aus – in jede beliebige Richtung, ohne dass er sich dabei ein Feld bewegt.'
      }
    ]
  },
  {
    key: 'schwertkaempfer',
    sections: [
      {
        heading: 'Bewegung',
        text: 'Bis zu 2 Felder pro Runde in jede der 6 Richtungen.',
        diagrams: neighborMoveDiagrams
      },
      {
        heading: 'Angriff',
        text: 'Nahkampf, ausgeglichen; besonders gut gegen Bogenschütze (9) und den Speerkämpfer (9).'
      },
      {
        heading: 'Schwertkämpfer-Spezial: Abfangen',
        text: INTERCEPT_TEXT,
        diagrams: interceptDiagrams
      }
    ]
  },
  {
    key: 'lanze',
    sections: [
      {
        heading: 'Bewegung',
        text: 'Bis zu 2 Felder pro Runde in jede der 6 Richtungen.',
        diagrams: neighborMoveDiagrams
      },
      {
        heading: 'Angriff',
        text: 'Nahkampf. Sehr stark gegen den Reiter (12), sonst mittel bis schwach.'
      },
      {
        heading: 'Speerkämpfer-Spezial: Abfangen',
        text: INTERCEPT_TEXT,
        diagrams: interceptDiagrams
      }
    ]
  },
  {
    key: 'bogenschuetze',
    sections: [
      {
        heading: 'Bewegung',
        text: 'Bis zu 2 Felder pro Runde in jede der 6 Richtungen. Wer in dieser Runde schießt, darf höchstens 1 Feld laufen.',
        diagrams: neighborMoveDiagrams
      },
      {
        heading: 'Nahkampfangriff',
        text: 'Im Nahkampf 0 Schaden – verliert jeden Nahkampf und verdrängt nie eine Figur.'
      },
      {
        heading: 'Schuss-Schaden',
        text: 'Der Schaden wird beim Abschuss "eingefroren" – die Pfeile treffen auch dann noch mit voller Wirkung, wenn das Bataillon bis zum Einschlag dezimiert oder zerstört wurde.'
      },
      {
        heading: 'Weitschuss',
        text: 'Trifft ein frei gewähltes Feld in 2–3 Feldern Entfernung. Der Pfeil schlägt 3 Takte nach dem Abschuss ein.',
        diagrams: () => {
          const far = { '0,0': 'hl-center' };
          for (let q = -3; q <= 3; q++) {
            for (let r = -3; r <= 3; r++) {
              if (Math.abs(q + r) > 3) continue;
              const d = (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;
              if (d >= 2 && d <= 3) far[`${q},${r}`] = 'hl-far';
            }
          }
          return [
            figure(miniHex({ radius: 3, highlights: far, chips: [{ q: 0, r: 0, role: 'blue' }] }),
              'Weitschuss: jedes Feld in 2–3 Feldern Abstand')
          ];
        }
      },
      {
        heading: 'Nahschuss',
        text: 'Trifft in eine gewählte Nachbar-Richtung das Nachbarfeld oder, falls dieses leer ist, das Feld dahinter. Der Pfeil verursacht nur einmal Schaden – steht auf dem Nachbarfeld eine Figur, kommt beim Feld dahinter nichts mehr an. Der Pfeil schlägt 2 Takte nach dem Abschuss ein.',
        diagrams: () => {
          const near = { '0,0': 'hl-center', '0,-1': 'hl-near', '0,-2': 'hl-near' };
          return [
            figure(miniHex({
              radius: 2, highlights: near, chips: [{ q: 0, r: 0, role: 'blue' }],
              arrows: [{ from: { q: 0, r: 0 }, to: { q: 0, r: -2 } }]
            }), 'Nahschuss: Nachbarfeld + Feld dahinter')
          ];
        }
      }
    ]
  }
];

function buildManual() {
  const c = manualContent;
  c.innerHTML = '';

  c.appendChild(mEl('h2', null, 'Ziel des Spiels'));
  c.appendChild(mEl('p', null,
    'Wer am Ende einer Runde noch Figuren auf dem Feld hat, gewinnt die Runde. Zwei Sieg-Runden gewinnen das Match (Best of 3). Verlieren beide Spieler in derselben Runde ihre letzten Figuren, bekommen beide einen Punkt.'));

  c.appendChild(mEl('h2', null, 'Ablauf einer Runde'));
  const ul = mEl('ul');
  [
    'Beide Spieler planen gleichzeitig – pro Figur bis zu 4 Takte',
    'In jedem Takt kann eine Bewegung auf ein Nachbarfeld, eine Spezialaktion der Figur oder „bleiben" gewählt werden.',
    'Wenn beide Spieler ihren Zug bestätigen, laufen alle Pläne Takt für Takt gleichzeitig ab.',
    'Wollen sich zwei eigene Figuren auf das selbe Feld bewegen, läuft nur die „schnellere" Figur: Reiter > Schwertkämpfer > Speerkämpfer > Bogenschütze.',
    'Die „langsamere" Figur bleibt stehen und verliert den Rest ihrer Planung für diese Runde.',
    'Treffen Figuren gegnerischer Spieler aufeinander, kämpfen sie. Wer kämpft, verliert ebenfalls den Rest seiner Planung für diese Runde.'
  ].forEach(t => ul.appendChild(mEl('li', null, t)));
  c.appendChild(ul);

  c.appendChild(mEl('h2', null, 'Bataillone & Schaden'));
  c.appendChild(mEl('p', null, 'Jede Figur ist ein Bataillon aus 10 Einzel-Einheiten mit gemeinsamem HP-Vorrat.'));
  c.appendChild(buildHpTable());
  c.appendChild(mEl('p', null,
    'Der Kampf-Schaden ist der Tabellenwert × noch lebende Einheiten im angreifenden Bataillon (bis zu 10). Der Bogenschütze macht im Nahkampf immer 0.'));
  c.appendChild(mEl('h3', null, 'Schaden pro Einheit'));
  c.appendChild(buildDamageTable());
  c.appendChild(mEl('div', 'manual-note', 'Gesamtschaden Bogenschütze = Schuss-Schaden × beim Abschuss lebende Schützen-Einheiten.'));

  c.appendChild(mEl('h2', null, 'Die Einheiten'));
  MANUAL_UNITS.forEach(u => {
    const box = mEl('div', 'manual-unit');
    box.appendChild(mEl('h3', null, UnitTypes.byKey(u.key).label));

    // Alle Diagramme der Einheit zusammen in einer Reihe (wie vorher) -
    // egal aus welchem Unterpunkt sie stammen.
    const diag = mEl('div', 'manual-diagrams');
    u.sections.forEach(sec => { if (sec.diagrams) sec.diagrams().forEach(fig => diag.appendChild(fig)); });
    if (diag.childNodes.length) box.appendChild(diag);

    // Unterpunkte als fette Label direkt in der Textzeile (wie vorher
    // "Bewegung: ..." / "Angriff: ..."), nicht als eigene Ueberschriften.
    u.sections.forEach(sec => box.appendChild(labeledP(sec.heading, sec.text)));

    c.appendChild(box);
  });

  const legend = mEl('div', 'manual-legend');
  [['lg-center', 'eigenes Feld'], ['lg-reach', 'erreichbar'], ['lg-far', 'Weitschuss-Ziel'], ['lg-near', 'Nahschuss']]
    .forEach(([cls, txt]) => legend.appendChild(mEl('span', cls, txt)));
  c.appendChild(legend);

  c.appendChild(mEl('h2', null, 'Sonderfälle'));

  const bleibenBox = mEl('div', 'manual-unit');
  bleibenBox.appendChild(mEl('h3', null, 'Bleiben'));
  bleibenBox.appendChild(mEl('p', null,
    'Jede Figur kann in einem Takt statt einer Bewegung oder Aktion auch „bleiben" wählen. So lässt sich taktisch abwarten – der eigentliche Zug wird dann erst in einem späteren Takt derselben Runde ausgeführt.'));
  c.appendChild(bleibenBox);

  const multiBox = mEl('div', 'manual-unit');
  multiBox.appendChild(mEl('h3', null, 'Multikämpfe'));
  multiBox.appendChild(mEl('p', null,
    'Kämpfen mehr als zwei Bataillone gleichzeitig um dasselbe Feld, unterscheidet das Spiel drei Fälle:'));





    // Fall 1: stehender Verteidiger, teilt sich auf alle Angreifer auf.
          const fall1Diag = mEl('div', 'manual-diagrams');
    fall1Diagrams().forEach(fig => fall1Diag.appendChild(fig));
  multiBox.appendChild(fall1Diag);
  multiBox.appendChild(labeledP('Fall 1',
    'Eine Figur bleibt in der Mitte stehen und wird von 2 gegnerischen Figuren gleichzeitig angegriffen. Die Figur in der Mitte teilt ihre lebenden Einheiten durch die Anzahl der Angreifer (aufgerundet) und schlägt mit dieser Stärke gegen jeden der beiden Angreifer zurück.'));
  multiBox.appendChild(labeledP('Beispiel',
    'Ein Speerkämpfer mit 5 lebenden Einheiten wird gleichzeitig von 2 Schwertkämpfern angegriffen. Er teilt seine 5 Einheiten durch die 2 Angreifer (aufgerundet: 3) und schlägt mit 3 Einheiten gegen jeden der beiden Schwertkämpfer zurück. Beide Angreifer teilen ihm gleichzeitig ihren vollen Schaden aus.'));


  // Fall 2: stehender Verteidiger, konzentriert sich auf EINEN Angreifer.
    const fall2Diag = mEl('div', 'manual-diagrams');
    fall2Diagrams().forEach(fig => fall2Diag.appendChild(fig));
  multiBox.appendChild(fall2Diag);
  multiBox.appendChild(labeledP('Fall 2',
    'Eine Figur befindet sich in der Mitte, greift aber gezielt einen der beiden Angreifer an. Ihre Einheiten teilen sich dabei nicht auf – sie kämpft mit voller Stärke nur gegen die gewählte Figur; der andere Angreifer trifft sie ungehindert, ohne Gegenwehr.'));
  multiBox.appendChild(labeledP('Beispiel',
    'Der Speerkämpfer mit 5 lebenden Einheiten wird von 2 Schwertkämpfern angegriffen, wehrt sich diesmal aber gezielt gegen einen von ihnen. Er greift mit allen 5 Einheiten nur diesen einen Schwertkämpfer an.'));


  // Fall 3: leeres Feld, Bataillone beider Seiten treffen aufeinander.
      const fall3Diag = mEl('div', 'manual-diagrams');
  fall3Diagrams().forEach(fig => fall3Diag.appendChild(fig));
  multiBox.appendChild(fall3Diag);
  multiBox.appendChild(labeledP('Fall 3',
    'Mehrere verbündete Figuren und mehrere gegnerische Figuren ziehen gleichzeitig auf ein leeres Feld in der Mitte. Jede Figur greift dabei jede gegnerische Figur an – ihre lebenden Einheiten werden durch die Anzahl gegnerischer Figuren geteilt (aufgerundet) und gegen jede von ihnen eingesetzt. Die Seite mit dem höheren Gesamtschaden gewinnt das Feld; aus ihren Überlebenden rückt die Figur mit dem meisten selbst ausgeteilten Schaden auf das Feld nach. Bei einem Gleichstand bleibt das Feld leer.'));
  multiBox.appendChild(labeledP('Beispiel',
    '2 Speerkämpfer und 3 gegnerische Schwertkämpfer ziehen auf dasselbe leere Feld. Jeder Speerkämpfer teilt seine Einheiten durch die 3 Gegner (aufgerundet) und greift damit alle drei Schwertkämpfer an; jeder Schwertkämpfer teilt seine Einheiten entsprechend durch die 2 Speerkämpfer und greift beide an.'));

  c.appendChild(multiBox);
}

socket.on('joined', ({ role, unitTypes, maxUnitsPerPlayer: maxUnits, match }) => {
  myRole = role;
  myUnitTypes = unitTypes || UnitTypes.TYPES;
  maxUnitsPerPlayer = maxUnits || UnitTypes.MAX_UNITS_PER_PLAYER;
  phase = 'placement';
  placedByType = {};

  joinAreaEl.classList.add('hidden');
  statusEl.classList.remove('hidden');
  gameAreaEl.classList.remove('hidden');
  setupPanel.classList.remove('hidden');
  setMatchState(match || { scores: { blue: 0, red: 0 }, names: matchNames, round: 1 });
  scoreBar.classList.remove('hidden');
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

socket.on('gameStart', ({ units, positions: serverPositions, hp: serverHp, facings: serverFacings }) => {
  phase = 'playing';
  unitsById = {};
  units.forEach(u => { unitsById[u.id] = u; });
  positions = serverPositions;
  hp = serverHp || {};
  facings = serverFacings ? { ...serverFacings } : {};

  Object.values(placementChipElements).forEach(el => el.remove());
  placementChipElements = {};
  Object.keys(placementFacingMarkers).forEach(id => delete placementFacingMarkers[id]);
  placementFacingLayer.innerHTML = '';
  facingLayer.innerHTML = '';
  pendingReiterPlacement = null;
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
  renderPlanTable();
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

socket.on('matchState', (match) => {
  setMatchState(match);
});

socket.on('executeRound', ({ ticks, roundResult, matchResult }) => {
  closePlanning();
  editButton.classList.add('hidden');
  animateRound(ticks).then(async () => {
    if (roundResult) setMatchState(roundResult); // Punktestand + Namen aktualisieren
    if (matchResult) {
      showVictory(matchResult);
    } else if (roundResult) {
      await showRoundBanner(roundResult);
      enterPlacementAgain(roundResult.round + 1);
    }
  });
});

socket.on('returnToStart', () => {
  // Sauberster Weg zurueck auf den Startbildschirm.
  location.reload();
});

socket.on('playerLeft', () => {
  showEndOverlay('Verbindung getrennt', 'Der andere Spieler hat den Raum verlassen');
});

// Kurzes Banner nach einer entschiedenen Runde (kein Match-Ende).
function showRoundBanner(roundResult) {
  const { winner, round } = roundResult;
  roundBanner.textContent = winner === 'draw'
    ? `Runde ${round}: Unentschieden – beide erhalten einen Punkt`
    : `Runde ${round} gewonnen: ${matchNames[winner]}`;
  roundBanner.classList.remove('hidden');
  return new Promise(resolve => {
    setTimeout(() => {
      roundBanner.classList.add('hidden');
      resolve();
    }, 2600);
  });
}

// Gemeinsames Overlay fuer "Match vorbei" (Sieg) UND "Gegner hat den Raum
// verlassen" - beide Male mit 5s-Countdown, danach schickt der Server
// 'returnToStart'.
function showEndOverlay(title, name) {
  victoryTitle.textContent = title;
  victoryName.textContent = name;
  victoryOverlay.classList.remove('hidden');
  let n = 5;
  victoryCountdown.textContent = String(n);
  const iv = setInterval(() => {
    n -= 1;
    victoryCountdown.textContent = String(Math.max(0, n));
    if (n <= 0) clearInterval(iv);
  }, 1000);
}

function showVictory({ winner, winnerName }) {
  showEndOverlay('Sieg', winner === 'draw' ? 'Unentschieden' : (winnerName || ''));
}

// Zuruecksetzen fuer die naechste Runde (Scores/Namen bleiben, alles andere
// wird wie ein frischer Platzierungs-Start aufgebaut).
function enterPlacementAgain(nextRound) {
  phase = 'placement';
  placedByType = {};
  placementReady = false;
  selectedUnitId = null;
  confirmed = false;
  shotTargeting = null;
  turnTargeting = false;
  interceptTargeting = false;
  closeMoveOrSelectPrompt();
  myPlans = {};
  pendingReiterPlacement = null;

  Object.keys(unitElements).forEach(id => { unitElements[id].remove(); delete unitElements[id]; });
  Object.keys(hpBarElements).forEach(id => { hpBarElements[id].group.remove(); delete hpBarElements[id]; });
  Object.keys(facingMarkers).forEach(id => removeFacingMarker(id));
  Object.keys(placementFacingMarkers).forEach(id => delete placementFacingMarkers[id]);
  Object.values(placementChipElements).forEach(el => el.remove());
  placementChipElements = {};
  unitsById = {};
  positions = {};
  hp = {};
  facings = {};
  pathGroup.innerHTML = '';
  arrowLayer.innerHTML = '';
  facingLayer.innerHTML = '';
  placementFacingLayer.innerHTML = '';

  planPanel.classList.add('hidden');
  planPanel.classList.remove('plan-panel-invisible');
  sideControls.classList.add('hidden');
  editButton.classList.add('hidden');
  confirmButton.disabled = false;
  tickDisplay.classList.remove('tick-visible');
  placementReadyButton.disabled = false;
  placementReadyButton.classList.remove('hidden');
  placementEditButton.classList.add('hidden');
  setupPanel.classList.remove('hidden');

  if (nextRound != null) scoreRound.textContent = `Runde ${nextRound}`;

  initBoard();
  highlightOwnZone();
  renderStackList();
  statusEl.textContent = `Runde ${nextRound}. Wähle deine Einheiten und platziere sie.`;
}

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
  if (pendingReiterPlacement) cancelPendingReiterPlacement();
  armedTypeKey = armedTypeKey === typeKey ? null : typeKey;
  renderStackList();
  highlightOwnZone();
}

const placementFacingMarkers = {}; // unitId -> <polygon> (Blickrichtung platzierter Reiter, Platzierungsphase)

function createPlacementChip(unitId, typeKey, chipIndex, q, r, facing) {
  const el = createChipElement(myRole, typeKey, chipIndex);
  const { x, y } = toScreen(q, r);
  positionChipElement(el, x, y);
  el.addEventListener('click', (event) => {
    event.stopPropagation();
    handlePlacementChipClick(unitId, typeKey);
  });
  unitLayer.appendChild(el);
  placementChipElements[unitId] = el;

  if (UnitTypes.hasFacing(typeKey) && facing != null) {
    const poly = document.createElementNS(SVG_NS, 'polygon');
    poly.setAttribute('points', FACING_MARKER_POINTS);
    poly.setAttribute('transform', `translate(${x}, ${y}) rotate(${dirScreenAngleDeg(facing)})`);
    poly.classList.add('facing-marker', `facing-${myRole}`);
    facingLayer.appendChild(poly);
    placementFacingMarkers[unitId] = poly;
  }
}

function removePlacementChip(unitId) {
  const el = placementChipElements[unitId];
  if (el) {
    el.remove();
    delete placementChipElements[unitId];
  }
  const marker = placementFacingMarkers[unitId];
  if (marker) {
    marker.remove();
    delete placementFacingMarkers[unitId];
  }
}

// Sechs anklickbare Pfeile um das eben gewaehlte Feld - der Spieler bestimmt
// damit die Start-Blickrichtung des Reiters.
function showPlacementFacingChooser(q, r) {
  clearPlacementFacingArrows();
  const c = toScreen(q, r);
  HexBoard.DIRECTIONS.forEach((d, i) => {
    const n = toScreen(q + d.dq, r + d.dr);
    const ux = n.x - c.x;
    const uy = n.y - c.y;
    const arrow = document.createElementNS(SVG_NS, 'polygon');
    const M = CHIP_RADIUS;
    arrow.setAttribute('points', `${M * 1.75},0 ${M * 0.22},${-M * 0.9} ${M * 0.22},${M * 0.9}`);
    arrow.setAttribute('transform',
      `translate(${c.x + ux * 0.55}, ${c.y + uy * 0.55}) rotate(${Math.atan2(uy, ux) * 180 / Math.PI})`);
    arrow.classList.add('placement-facing-arrow');
    arrow.addEventListener('click', (event) => {
      event.stopPropagation();
      finalizeReiterPlacement(i);
    });
    placementFacingLayer.appendChild(arrow);
  });
}

function clearPlacementFacingArrows() {
  placementFacingLayer.innerHTML = '';
}

function finalizeReiterPlacement(facingIndex) {
  if (!pendingReiterPlacement) return;
  const { q, r, chipIndex } = pendingReiterPlacement;
  const list = placedByType['reiter'] || (placedByType['reiter'] = []);
  const unitId = `${myRole}_reiter_${chipIndex}`;
  list.push({ unitId, q, r, facing: facingIndex });
  createPlacementChip(unitId, 'reiter', chipIndex, q, r, facingIndex);
  socket.emit('placeUnit', { roomId: myRoomId, typeKey: 'reiter', q, r, facing: facingIndex });

  pendingReiterPlacement = null;
  clearPlacementFacingArrows();
  armedTypeKey = null;
  renderStackList();
  highlightOwnZone();
}

function cancelPendingReiterPlacement() {
  pendingReiterPlacement = null;
  clearPlacementFacingArrows();
  highlightOwnZone();
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
  if (placementReady) return;

  // Ein Klick aufs Brett bricht eine offene Reiter-Blickrichtungs-Wahl ab.
  if (pendingReiterPlacement) {
    cancelPendingReiterPlacement();
    return;
  }

  if (!armedTypeKey) return;
  if (!isOwnZoneCell(q, r) || isOwnCellOccupied(q, r)) return;

  const type = UnitTypes.byKey(armedTypeKey);
  const list = placedByType[armedTypeKey] || (placedByType[armedTypeKey] = []);
  if (list.length >= type.maxPerPlayer || totalPlacedCount() >= maxUnitsPerPlayer) return;

  const chipIndex = list.length + 1;

  // Reiter: erst Feld waehlen, dann Blickrichtung - erst danach wird platziert.
  if (UnitTypes.hasFacing(armedTypeKey)) {
    pendingReiterPlacement = { q, r, chipIndex };
    showPlacementFacingChooser(q, r);
    statusEl.textContent = 'Reiter: Blickrichtung waehlen.';
    return;
  }

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
  if (pendingReiterPlacement) cancelPendingReiterPlacement();
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
    if (interceptTargeting && unit.role !== myRole) {
      handleInterceptTargetClick(unit.id);
      return;
    }
    const pos = positions[unit.id];
    if (unit.role !== myRole) {
      // Gegnerische Figur: Klick zaehlt wie ein Klick auf ihr Feld (Bewegung
      // dorthin/Angriff, Schuss-/Dreh-Ziel), damit man nicht daneben klicken muss.
      if (pos) handleBoardClick(pos.q, pos.r);
      return;
    }
    // Eigene (verbuendete) Figur: bei der bereits ausgewaehlten Einheit
    // selbst bleibt es beim reinen Auswaehlen (kein Bewegen-Vorschlag auf
    // das eigene Feld).
    if (unit.id === selectedUnitId) {
      selectUnit(unit.id);
      return;
    }
    if (pos && canPlanMoveStep(pos.q, pos.r)) {
      promptFieldOrSelect('move', pos.q, pos.r, unit.id);
    } else if (pos && canPlanTurnStep(pos.q, pos.r)) {
      promptFieldOrSelect('turn', pos.q, pos.r, unit.id);
    } else {
      selectUnit(unit.id);
    }
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
  positionFacingMarker(unitId, x, y);
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
    createFacingMarker(unit.id);
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

  removeFacingMarker(unitId);

  delete unitElements[unitId];
  delete hpBarElements[unitId];
  delete positions[unitId];
  delete hp[unitId];
  delete myPlans[unitId];
  delete unitsById[unitId];
  delete facings[unitId];
}

// ---------- Planung (pro ausgewählter eigener Einheit) ----------

function selectUnit(unitId) {
  selectedUnitId = unitId;
  shotTargeting = null;
  turnTargeting = false;
  interceptTargeting = false;
  setInterceptTargetsHighlight(false);
  planPanel.classList.remove('plan-panel-invisible');

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
  shotTargeting = null;
  turnTargeting = false;
  interceptTargeting = false;
  setInterceptTargetsHighlight(false);
  planPanel.classList.add('plan-panel-invisible');
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
  const base = UnitTypes.maxStepsFor(unitsById[selectedUnitId].typeKey);
  // Wer in dieser Runde schiesst, darf hoechstens 1 Feld laufen.
  if (findShotStep(currentUnitPlan())) return Math.min(base, 1);
  return base;
}

// Sucht den (hoechstens einen) Schuss-Schritt im Plan.
function findShotStep(plan) {
  for (let i = 0; i < plan.length; i++) {
    if (plan[i] && plan[i].shot != null) return { step: plan[i], index: i };
  }
  return null;
}

// Anzeige-Form eines geplanten Schusses (nur Client - fuer Marker + Nebentabelle).
// Absolute Felder werden - wie serverseitig in canonicalShot - aus der
// Schuetzen-Position im Abschuss-Takt (= Feld des Schuss-Schritts) und der
// Richtung berechnet.
function shotDisplay(shotStep, index) {
  const shot = shotStep.shot;
  const launch = { q: shotStep.q, r: shotStep.r };
  if (shot.type === 'far') {
    const cfg = UnitTypes.shotConfig('bogenschuetze', 'far');
    return { type: 'far', cells: [{ q: shot.target.q, r: shot.target.r }], launchTick: index, arrivalTick: index + cfg.ticks - 1 };
  }
  const cfg = UnitTypes.shotConfig('bogenschuetze', 'near');
  const primary = { q: launch.q + shot.dir.dq, r: launch.r + shot.dir.dr };
  const behind = { q: launch.q + 2 * shot.dir.dq, r: launch.r + 2 * shot.dir.dr };
  const cells = [primary];
  if (hexElements[HexBoard.keyOf(behind.q, behind.r)]) cells.push(behind);
  return { type: 'near', cells, launchTick: index, arrivalTick: index + cfg.ticks - 1 };
}

// Ob die gerade gewaehlte Einheit eine Blickrichtung hat (Reiter).
function selectedHasFacing() {
  return !!(selectedUnitId && UnitTypes.hasFacing(unitsById[selectedUnitId].typeKey));
}

// Blickrichtung (0..5) der gewaehlten Einheit nach den ersten `upto` Schritten
// ihres Plans (upto weggelassen = ganzer Plan). Startwert ist die persistente
// Blickrichtung; jeder Lauf-Schritt setzt sie auf die gelaufene Richtung, jeder
// Dreh-Schritt auf step.turn.
function planFacingAt(plan, upto) {
  let facing = facings[selectedUnitId];
  if (facing == null) facing = 0;
  let prev = positions[selectedUnitId];
  const n = (upto == null) ? plan.length : upto;
  for (let i = 0; i < n; i++) {
    const s = plan[i];
    if (!s) break;
    if (s.turn != null) {
      facing = s.turn;
    } else if (s.q !== prev.q || s.r !== prev.r) {
      const d = HexBoard.dirBetween(prev, s);
      if (d >= 0) facing = d;
    }
    prev = s;
  }
  return facing;
}

function currentPlanFacing() {
  return planFacingAt(currentUnitPlan());
}

// Zaehlt, wie viele Eintraege im Plan als Bewegung zaehlen: echte Feldwechsel
// UND Abfang-Schritte (die im Plan am Ursprungsfeld haengen, aber als eine
// Bewegung zaehlen). Skip-Schritte zaehlen nicht mit.
function countMoveSteps(plan, startPos) {
  let previous = startPos;
  let moves = 0;
  plan.forEach(step => {
    if (step.intercept != null || step.q !== previous.q || step.r !== previous.r) moves++;
    previous = step;
  });
  return moves;
}

// Ob die gerade gewaehlte Einheit den Abfangen-Schritt planen kann.
function selectedCanIntercept() {
  return !!(selectedUnitId && UnitTypes.canIntercept(unitsById[selectedUnitId].typeKey));
}

// Index des (hoechstens einen) Abfang-Schritts im Plan, sonst -1.
function planInterceptIndex(plan) {
  return plan.findIndex(s => s && s.intercept != null);
}

// Kurzform der Art-Namen fuer die Takt-Tabelle (Abfangen-Ziel) - dort ist
// wenig Platz, die vollen Namen (z.B. "Schwertkämpfer") wuerden die Spalte
// sprengen.
const INTERCEPT_TARGET_SHORT_LABEL = {
  reiter: 'Reiter',
  bogenschuetze: 'Schütze',
  lanze: 'Speer',
  schwertkaempfer: 'Schwert'
};

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

      if (plan[i].shot != null) {
        const cfg = UnitTypes.shotConfig('bogenschuetze', plan[i].shot.type);
        td.textContent = `🏹 ${cfg ? cfg.label : ''}`;
        td.classList.add('shot-cell');
      } else if (plan[i].turn != null) {
        td.textContent = `⟳ ${screenArrowGlyph(plan[i].turn)}`;
        td.classList.add('turn-cell');
      } else if (plan[i].intercept != null) {
        const tgt = unitsById[plan[i].intercept];
        const shortLabel = tgt ? (INTERCEPT_TARGET_SHORT_LABEL[tgt.typeKey] || tgt.label) : null;
        td.textContent = `🎯 ${tgt ? `${shortLabel} ${tgt.chipIndex}` : '?'}`;
        td.classList.add('intercept-cell');
      } else if (isSkip) {
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

  refreshShotUI();
}

// ---------- Bogenschuetzen-Schuss: Buttons, Nebentabelle, Feld-Marker ----------

// Baut Buttons/Nebentabelle/Marker fuer die aktuell gewaehlte Einheit neu auf.
// Wird am Ende jedes renderPlanTable()-Durchlaufs aufgerufen.
function refreshShotUI() {
  Object.values(hexElements).forEach(el =>
    el.classList.remove('shot-target', 'shot-target-2'));

  const unit = selectedUnitId && unitsById[selectedUnitId];
  const isArcher = unit && unit.typeKey === 'bogenschuetze';
  const isFacer = unit && UnitTypes.hasFacing(unit.typeKey);
  const isInterceptor = unit && UnitTypes.canIntercept(unit.typeKey);

  // Der Bereich unter der Takt-Tabelle behaelt IMMER seine Hoehe (min-height in
  // CSS). .is-hidden blendet nur den Inhalt aus - so aendert das Spielfeld weder
  // beim Auswaehlen einer Einheit noch beim Planen einer Aktion die Groesse.
  shotArea.classList.toggle('is-hidden', !(isArcher || isFacer || isInterceptor));
  shotControls.classList.toggle('hidden', !isArcher);
  turnControls.classList.toggle('hidden', !isFacer);
  interceptControls.classList.toggle('hidden', !isInterceptor);
  shotCrest.classList.toggle('hidden', !isArcher);

  if (isFacer) refreshTurnUI();
  if (isInterceptor) refreshInterceptUI();
  if (!isInterceptor && interceptTargeting) {
    interceptTargeting = false;
    setInterceptTargetsHighlight(false);
  }

  if (!isArcher) {
    shotCrest.classList.add('is-hidden');
    shotTargeting = null;
    return;
  }

  const plan = currentUnitPlan();
  const existing = findShotStep(plan);

  if (confirmed) {
    shotTargeting = null;
    farShotButton.disabled = true;
    nearShotButton.disabled = true;
    farShotButton.classList.remove('arming');
    nearShotButton.classList.remove('arming');
  } else {
    const moves = countMoveSteps(plan, positions[selectedUnitId]);
    const nextTick = plan.length; // 0-basierter Index des gerade geplanten Takts
    const canArm = !existing && plan.length < UnitTypes.DEFAULT_MAX_STEPS && moves <= 1;
    const farCfg = UnitTypes.shotConfig('bogenschuetze', 'far');
    const nearCfg = UnitTypes.shotConfig('bogenschuetze', 'near');
    farShotButton.disabled = !(canArm && nextTick <= farCfg.maxLaunchTick - 1);
    nearShotButton.disabled = !(canArm && nextTick <= nearCfg.maxLaunchTick - 1);
    farShotButton.classList.toggle('arming', shotTargeting === 'far');
    nearShotButton.classList.toggle('arming', shotTargeting === 'near');
  }

  if (existing) {
    const disp = shotDisplay(existing.step, existing.index);
    const p = hexElements[HexBoard.keyOf(disp.cells[0].q, disp.cells[0].r)];
    if (p) p.classList.add('shot-target');
    if (disp.cells[1]) {
      const s = hexElements[HexBoard.keyOf(disp.cells[1].q, disp.cells[1].r)];
      if (s) s.classList.add('shot-target-2');
    }
    fillShotCrest(disp);
    shotCrest.classList.remove('is-hidden');
  } else {
    shotCrest.classList.add('is-hidden');
  }
}

// Fuellt das Wappen: Kuerzel (WS/NS), Ziel-Feld(er) und Ankunfts-Takt.
function fillShotCrest(disp) {
  const label = (c) => {
    const l = HexBoard.labelOf(c.q, c.r);
    return `${l.col},${l.row}`;
  };
  shotCrestType.textContent = disp.type === 'far' ? 'WS' : 'NS';
  shotCrestType.title = disp.type === 'far' ? 'Weitschuss' : 'Nahschuss';
  shotCrestTarget.textContent = disp.cells.map(label).join(' → ');
  shotCrestArrival.textContent = `Takt ${disp.arrivalTick + 1}`;
}

// ---------- Reiter: Dreh-Schritt (Blickrichtung aendern, kostet 1 Takt) ----------

function refreshTurnUI() {
  const plan = currentUnitPlan();
  const slotFree = plan.length < UnitTypes.DEFAULT_MAX_STEPS;
  turnButton.disabled = confirmed || (!slotFree && !turnTargeting);
  turnButton.classList.toggle('arming', turnTargeting);
}

function enterTurnTargeting() {
  if (!selectedUnitId || confirmed || !selectedHasFacing()) return;
  if (!turnTargeting && currentUnitPlan().length >= UnitTypes.DEFAULT_MAX_STEPS) return;

  turnTargeting = !turnTargeting;
  shotTargeting = null;
  clearHighlights();
  if (turnTargeting) {
    highlightTurnTargets();
    statusEl.textContent = 'Drehen: neue Blickrichtung waehlen (kostet 1 Takt).';
  } else {
    highlightNextOptions();
  }
  refreshShotUI();
}

function highlightTurnTargets() {
  clearHighlights();
  const from = currentPlanEndPosition();
  const facing = currentPlanFacing();
  HexBoard.DIRECTIONS.forEach((d, i) => {
    if (i === facing) return; // aktuelle Blickrichtung waehlen bringt nichts
    const el = hexElements[HexBoard.keyOf(from.q + d.dq, from.r + d.dr)];
    if (el) el.classList.add('shot-selectable');
  });
}

function handleTurnTargetClick(q, r) {
  const el = hexElements[HexBoard.keyOf(q, r)];
  if (!el || !el.classList.contains('shot-selectable')) return;

  const from = currentPlanEndPosition();
  const dir = HexBoard.dirBetween(from, { q, r });
  if (dir < 0) return;

  currentUnitPlan().push({ q: from.q, r: from.r, turn: dir });
  turnTargeting = false;
  clearHighlights();
  renderPlanTable();
  renderPath();
  highlightNextOptions();
}

// ---------- Schwert/Speerkaempfer: Abfangen (Ziel = gegnerische Einheit) ----------

function refreshInterceptUI() {
  const plan = currentUnitPlan();
  const slotFree = plan.length < UnitTypes.DEFAULT_MAX_STEPS;
  const movesLeft = countMoveSteps(plan, positions[selectedUnitId]) < currentUnitMaxMoves();
  // Abfang-Schritte zaehlen als Bewegung: solange noch Bewegungs-Budget frei ist
  // (z.B. wer sich noch nicht bewegt hat, kann 2x abfangen). Sie muessen aber am
  // Ende des Plans stehen - nach einem Abfang-Schritt ist kein Feldzug mehr
  // moeglich (die Position danach ist serverseitig).
  interceptButton.disabled = confirmed || !slotFree || !movesLeft;
  interceptButton.classList.toggle('arming', interceptTargeting);
}

function setInterceptTargetsHighlight(on) {
  Object.entries(unitElements).forEach(([id, el]) => {
    const u = unitsById[id];
    if (u && u.role !== myRole) el.classList.toggle('intercept-selectable', !!on);
  });
}

function enterInterceptTargeting() {
  if (!selectedUnitId || confirmed || !selectedCanIntercept()) return;
  if (!interceptTargeting && interceptButton.disabled) return;

  interceptTargeting = !interceptTargeting;
  shotTargeting = null;
  turnTargeting = false;
  clearHighlights();
  setInterceptTargetsHighlight(interceptTargeting);
  if (interceptTargeting) {
    statusEl.textContent = 'Abfangen: eine gegnerische Einheit anklicken.';
  } else {
    highlightNextOptions();
  }
  refreshShotUI();
}

function handleInterceptTargetClick(enemyId) {
  if (!interceptTargeting || !selectedUnitId || confirmed) return;
  if (!unitsById[enemyId] || unitsById[enemyId].role === myRole) return;

  const from = currentPlanEndPosition();
  currentUnitPlan().push({ q: from.q, r: from.r, intercept: enemyId });
  interceptTargeting = false;
  setInterceptTargetsHighlight(false);
  clearHighlights();
  renderPlanTable();
  renderPath();
  highlightNextOptions();
  statusEl.textContent = `Abfangen: Ziel ${unitsById[enemyId].label}.`;
}

// Schaltet die Feld-/Richtungswahl fuer eine Schussart an (oder wieder aus,
// wenn schon aktiv). Wird von den beiden Schuss-Buttons aufgerufen.
function enterShotTargeting(type) {
  if (!selectedUnitId || confirmed) return;
  const btn = type === 'far' ? farShotButton : nearShotButton;
  if (btn.disabled && shotTargeting !== type) return;

  shotTargeting = (shotTargeting === type) ? null : type;
  clearHighlights();
  if (shotTargeting) {
    highlightShotTargets();
    statusEl.textContent = shotTargeting === 'far'
      ? 'Weitschuss: Zielfeld waehlen (2-3 Felder entfernt).'
      : 'Nahschuss: eine der 6 Nachbar-Richtungen waehlen.';
  } else {
    highlightNextOptions();
  }
  refreshShotUI();
}

function highlightShotTargets() {
  clearHighlights();
  const from = currentPlanEndPosition();
  if (shotTargeting === 'far') {
    const cfg = UnitTypes.shotConfig('bogenschuetze', 'far');
    Object.entries(hexElements).forEach(([key, el]) => {
      const [q, r] = key.split(',').map(Number);
      const d = HexBoard.hexDistance(from, { q, r });
      if (d >= cfg.minRange && d <= cfg.maxRange) el.classList.add('shot-selectable');
    });
  } else if (shotTargeting === 'near') {
    HexBoard.DIRECTIONS.forEach(({ dq, dr }) => {
      const el = hexElements[HexBoard.keyOf(from.q + dq, from.r + dr)];
      if (el) el.classList.add('shot-selectable');
    });
  }
}

function handleShotTargetClick(q, r) {
  const el = hexElements[HexBoard.keyOf(q, r)];
  if (!el || !el.classList.contains('shot-selectable')) return;

  const from = currentPlanEndPosition();
  let shot;
  if (shotTargeting === 'far') {
    shot = { type: 'far', target: { q, r } };
  } else {
    shot = { type: 'near', dir: { dq: q - from.q, dr: r - from.r } };
  }
  currentUnitPlan().push({ q: from.q, r: from.r, shot });
  shotTargeting = null;
  clearHighlights();
  renderPlanTable();
  renderPath();
  highlightNextOptions();
}

function currentPlanEndPosition() {
  const plan = currentUnitPlan();
  if (plan.length === 0) return positions[selectedUnitId];
  return plan[plan.length - 1];
}

function clearHighlights() {
  Object.values(hexElements).forEach(el => el.classList.remove('selectable', 'own-zone', 'shot-selectable'));
}

function highlightNextOptions() {
  clearHighlights();
  if (!selectedUnitId) return;

  const plan = currentUnitPlan();
  if (plan.length >= UnitTypes.DEFAULT_MAX_STEPS) return;
  if (planInterceptIndex(plan) !== -1) return; // nach einem Abfang-Schritt kein Feldzug mehr
  if (countMoveSteps(plan, positions[selectedUnitId]) >= currentUnitMaxMoves()) return;

  const from = currentPlanEndPosition();
  // Reiter darf nur in seinen Front-Bogen (Blickrichtung +/- 60 Grad) laufen.
  const allowed = selectedHasFacing()
    ? HexBoard.frontArc(currentPlanFacing())
    : HexBoard.DIRECTIONS.map((_, i) => i);
  allowed.forEach(i => {
    const d = HexBoard.DIRECTIONS[i];
    const key = HexBoard.keyOf(from.q + d.dq, from.r + d.dr);
    if (hexElements[key]) hexElements[key].classList.add('selectable');
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

  // Reiter: geplante End-Blickrichtung als Dreieck am Ziel-Ghost.
  if (selectedHasFacing()) {
    const tri = document.createElementNS(SVG_NS, 'polygon');
    tri.setAttribute('points', FACING_MARKER_POINTS);
    tri.setAttribute('transform', `translate(${x}, ${y}) rotate(${dirScreenAngleDeg(currentPlanFacing())})`);
    tri.classList.add('facing-marker', `facing-${myRole}`, 'facing-ghost');
    pathGroup.appendChild(tri);
  }
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

// Ob die gerade ausgewaehlte Einheit ihren Plan aktuell um einen Bewegungs-
// Schritt auf (q, r) erweitern koennte - reine Pruefung, ohne etwas zu
// veraendern. Wird sowohl fuer den direkten Feld-Klick als auch fuer den
// Bewegen-Vorschlag beim Klick auf eine verbuendete Figur benutzt.
function canPlanMoveStep(q, r) {
  if (!selectedUnitId || confirmed) return false;
  if (shotTargeting || turnTargeting || interceptTargeting) return false;

  const plan = currentUnitPlan();
  if (plan.length >= UnitTypes.DEFAULT_MAX_STEPS) return false;
  if (planInterceptIndex(plan) !== -1) return false; // Abfang-Schritt ist der letzte
  if (countMoveSteps(plan, positions[selectedUnitId]) >= currentUnitMaxMoves()) return false;

  const from = currentPlanEndPosition();
  const distance = HexBoard.hexDistance(from, { q, r });
  if (distance !== 1) return false; // nur direkte Nachbarn erlaubt

  // Reiter: nur in den Front-Bogen der aktuellen (geplanten) Blickrichtung.
  if (selectedHasFacing()) {
    const dir = HexBoard.dirBetween(from, { q, r });
    if (dir < 0 || !HexBoard.frontArc(currentPlanFacing()).includes(dir)) return false;
  }

  return true;
}

function planMoveStep(q, r) {
  currentUnitPlan().push({ q, r });
  renderPlanTable();
  renderPath();
  highlightNextOptions();
}

// Ob die gerade ausgewaehlte Einheit (im Drehen-Modus) das Feld (q, r) als
// neue Blickrichtung waehlen koennte - reine Pruefung, analog zu
// canPlanMoveStep. Wird fuer den Bewegen/Drehen-oder-Auswaehlen-Vorschlag
// beim Klick auf eine verbuendete Figur benutzt.
function canPlanTurnStep(q, r) {
  if (!turnTargeting) return false;
  const el = hexElements[HexBoard.keyOf(q, r)];
  if (!el || !el.classList.contains('shot-selectable')) return false;
  const from = currentPlanEndPosition();
  return HexBoard.dirBetween(from, { q, r }) >= 0;
}

function handleBoardClick(q, r) {
  if (phase === 'placement') {
    handlePlacementClick(q, r);
    return;
  }

  if (!selectedUnitId || confirmed) return;

  if (shotTargeting) {
    handleShotTargetClick(q, r);
    return;
  }
  if (turnTargeting) {
    handleTurnTargetClick(q, r);
    return;
  }
  if (interceptTargeting) return; // Ziel wird per Klick auf einen Gegner-Chip gewaehlt

  if (canPlanMoveStep(q, r)) planMoveStep(q, r);
}

// ---------- Klick auf verbuendete Figur: Aktion-oder-Auswaehlen-Abfrage ----------
// Deckt sowohl "auf ihr Feld bewegen" als auch (im Drehen-Modus des Reiters)
// "in ihre Richtung drehen" ab - derselbe Dialog, nur mit anderer Aktion.

let pendingFieldAction = null; // { action: 'move' | 'turn', q, r, unitId }

function promptFieldOrSelect(action, q, r, unitId) {
  pendingFieldAction = { action, q, r, unitId };
  choiceMoveButton.textContent = action === 'turn' ? 'Dorthin drehen' : 'Auf das Feld bewegen';
  moveOrSelectOverlay.classList.remove('hidden');
}

function closeMoveOrSelectPrompt() {
  pendingFieldAction = null;
  moveOrSelectOverlay.classList.add('hidden');
}

choiceMoveButton.addEventListener('click', () => {
  if (!pendingFieldAction) return;
  const { action, q, r } = pendingFieldAction;
  closeMoveOrSelectPrompt();
  if (action === 'turn') {
    if (canPlanTurnStep(q, r)) handleTurnTargetClick(q, r);
  } else if (canPlanMoveStep(q, r)) {
    planMoveStep(q, r);
  }
});

choiceSelectButton.addEventListener('click', () => {
  if (!pendingFieldAction) return;
  const { unitId } = pendingFieldAction;
  closeMoveOrSelectPrompt();
  selectUnit(unitId);
});

moveOrSelectOverlay.addEventListener('click', (event) => {
  if (event.target === moveOrSelectOverlay) closeMoveOrSelectPrompt();
});

farShotButton.addEventListener('click', () => enterShotTargeting('far'));
nearShotButton.addEventListener('click', () => enterShotTargeting('near'));
turnButton.addEventListener('click', () => enterTurnTargeting());
interceptButton.addEventListener('click', () => enterInterceptTargeting());

confirmButton.addEventListener('click', () => {
  if (confirmed || !myRoomId || !myRole) return;
  confirmed = true;
  confirmButton.disabled = true;
  editButton.classList.remove('hidden');
  shotTargeting = null;
  turnTargeting = false;
  interceptTargeting = false;
  setInterceptTargetsHighlight(false);
  clearHighlights();
  refreshShotUI();
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
// Kurzer Vorlauf: das Reiter-Dreieck "teleportiert" in die Bewegungsrichtung
// und steht einen Moment sichtbar so da, BEVOR sich der Reiter losbewegt.
const FACING_SNAP_LEAD = 160;
// Pause zwischen dem Viertel-Schritt aller anderen Einheiten und dem
// Viertel-Schritt der Abfaenger (Schwert/Speerkaempfer), damit die Reihenfolge
// "erst die anderen, dann die Abfaenger" sichtbar wird.
const INTERCEPT_STAGE_GAP = 220;
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
  const marker = facingMarkers[unitId];
  if (marker) marker.style.transitionDuration = `${ms}ms`;
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

// ---------- Fliegende Pfeile (Bogenschuetzen-Beschuss) ----------

const ARROW_RADIUS = Math.max(3, CHIP_RADIUS * 0.38);

// Kleine Pfeil-Silhouette (Spitze + Widerhaken + Schaft), zeigt nach +X;
// die tatsaechliche Flugrichtung kommt ueber rotate() im transform dazu.
const ARROW_POINTS = [
  [1.5, 0], [0.2, -0.95], [0.5, -0.22], [-1.5, -0.22],
  [-1.5, 0.22], [0.5, 0.22], [0.2, 0.95]
].map(([x, y]) => `${(x * ARROW_RADIUS).toFixed(2)},${(y * ARROW_RADIUS).toFixed(2)}`).join(' ');

function setArrowTransform(a, x, y) {
  a.el.setAttribute('transform', `translate(${x}, ${y}) rotate(${a.angle})`);
}

// Anteil des Wegs zum Ziel, um den der Pfeil VOR dem Schuetzen-Feld startet -
// er soll nicht direkt auf dem Schuetzen "erscheinen", sondern schon ein Stueck
// in Flugrichtung. fromPos wird entsprechend verschoben, damit auch die
// weitere Flugbahn (advanceArrows) von diesem Punkt aus interpoliert.
const ARROW_SPAWN_LEAD = 0.12;

// Kurzer, deutlicher "Abschuss-Blitz" am Startpunkt des Pfeils.
function spawnArrowBurst(x, y) {
  const ring = document.createElementNS(SVG_NS, 'circle');
  ring.setAttribute('cx', x);
  ring.setAttribute('cy', y);
  ring.setAttribute('r', ARROW_RADIUS);
  ring.classList.add('arrow-burst');
  arrowLayer.appendChild(ring);
  setTimeout(() => ring.remove(), 500);
}

// Neuen Pfeil erzeugen: kleine Pfeil-Form kurz vor dem Schuetzen-Feld, in
// Flugrichtung gedreht, mit Abschuss-Blitz. Das Zielfeld wird waehrend des
// Flugs NICHT markiert - wo der Pfeil einschlaegt, zeigt erst der Einschlag.
function spawnArrow(ev) {
  if (activeArrows[ev.id]) return;
  const to = ev.cells[ev.cells.length - 1]; // Linienende (Nahschuss: Feld dahinter)
  const from = {
    q: ev.from.q + (to.q - ev.from.q) * ARROW_SPAWN_LEAD,
    r: ev.from.r + (to.r - ev.from.r) * ARROW_SPAWN_LEAD
  };
  const p = toScreen(from.q, from.r);
  const t = toScreen(to.q, to.r);
  const angle = Math.atan2(t.y - p.y, t.x - p.x) * 180 / Math.PI;

  const arrow = document.createElementNS(SVG_NS, 'polygon');
  arrow.setAttribute('points', ARROW_POINTS);
  arrow.classList.add('arrow-shot');
  arrowLayer.appendChild(arrow);

  const entry = {
    el: arrow, fromPos: from, toPos: to, angle,
    launchTick: ev.launchTick, arrivalTick: ev.arrivalTick
  };
  setArrowTransform(entry, p.x, p.y);
  spawnArrowBurst(p.x, p.y);
  activeArrows[ev.id] = entry;
}

// Alle fliegenden Pfeile auf ihren Bruchteil des Wegs fuer diesen Takt setzen.
function advanceArrows(tick) {
  Object.values(activeArrows).forEach(a => {
    if (a.arrivalTick === tick) return; // Einschlag positioniert selbst
    const span = Math.max(1, a.arrivalTick - a.launchTick);
    const frac = Math.max(0, Math.min(1, (tick - a.launchTick) / span));
    const pt = pointAtFraction(a.fromPos, a.toPos, frac);
    a.el.style.transitionDuration = `${BASE_MOVE_DURATION}ms`;
    setArrowTransform(a, pt.x, pt.y);
  });
}

function clearArrows() {
  Object.values(activeArrows).forEach(a => a.el.remove());
  Object.keys(activeArrows).forEach(k => delete activeArrows[k]);
}

// Einschlag: an die Einschlagstelle ziehen, Feld markieren, HP/Marken der
// Getroffenen aktualisieren, besiegte Bataillone entfernen. animateRound ruft
// dies fuer die Einschlaege eines Takts NACHEINANDER auf, vor dem
// Bewegungs-/Kampf-Ablauf (der Server rechnet den Pfeilschaden zuerst).
async function animateArrowImpact(ev) {
  const a = activeArrows[ev.id];
  const landing = ev.impactCell || ev.cells[ev.cells.length - 1];

  if (a) {
    const pt = toScreen(landing.q, landing.r);
    a.el.style.transitionDuration = `${QUARTER_MOVE_DURATION}ms`;
    setArrowTransform(a, pt.x, pt.y);
    await wait(QUARTER_MOVE_DURATION);
  }

  let impactEl = null;
  if (ev.impactCell) {
    impactEl = hexElements[HexBoard.keyOf(ev.impactCell.q, ev.impactCell.r)];
    if (impactEl) impactEl.classList.add('arrow-impact-cell');
  }
  await wait(COMBAT_MARK_HOLD);

  ev.hits.forEach(h => {
    if (hp[h.unitId] == null) return;
    hp[h.unitId] = h.hpAfter;
    updateHpBar(h.unitId);
  });
  await wait(200);
  ev.hits.forEach(h => { if (h.defeated) removeDefeatedUnit(h.unitId); });

  if (impactEl) impactEl.classList.remove('arrow-impact-cell');
  if (a) {
    a.el.remove();
    delete activeArrows[ev.id];
  }
}

async function animateRound(ticks) {
  tickDisplay.classList.add('tick-visible');

  for (let tick = 0; tick < ticks.length; tick++) {
    tickDisplay.textContent = `Takt ${tick + 1} von ${ticks.length}`;
    await wait(TICK_LABEL_DELAY);

    const { positions: tickPositions, facings: tickFacings, blockedAttempts, combatEvents, arrowEvents = [] } = ticks[tick];

    // Reiter, die sich diesen Takt bewegen: Blickrichtung SOFORT (ohne
    // Transition) auf die Bewegungsrichtung "teleportieren" - danach gleiten
    // Chip UND Dreieck 100% synchron aufs naechste Feld (setMoveDuration setzt
    // beiden dieselbe Transition-Dauer). Reine Dreh-Schritte ohne Feldwechsel
    // bleiben ausgenommen und drehen sich am Takt-Ende sanft in der CSS-Transition.
    let snappedAny = false;
    if (tickFacings) {
      Object.keys(facingMarkers).forEach(unitId => {
        const to = tickPositions[unitId];
        const from = positions[unitId];
        if (!to || !from || tickFacings[unitId] == null) return;
        if (samePos(to, from)) return;
        if (facings[unitId] !== tickFacings[unitId]) {
          facings[unitId] = tickFacings[unitId];
          snapFacingMarker(unitId);
          snappedAny = true;
        }
      });
    }
    // Dreieck-Ausrichtung kurz sacken lassen, bevor die Bewegung startet.
    if (snappedAny) await wait(FACING_SNAP_LEAD);

    // Reine Dreh-Schritte (Figur bleibt auf ihrem Feld, "Drehen"-Aktion) sollen
    // sich zum SELBEN Zeitpunkt drehen wie sich andere Figuren diesen Takt
    // bewegen - nicht erst ganz am Takt-Ende. Sanfte CSS-Transition-Drehung
    // (kein Snap, da hier keine Bewegung folgt, die synchron dazu laufen muss).
    if (tickFacings) {
      let turnedInPlace = false;
      Object.keys(facingMarkers).forEach(unitId => {
        const to = tickPositions[unitId];
        const from = positions[unitId];
        if (!to || !from || tickFacings[unitId] == null) return;
        if (!samePos(to, from)) return; // bewegt sich - oben schon behandelt
        if (facings[unitId] !== tickFacings[unitId]) {
          facings[unitId] = tickFacings[unitId];
          turnedInPlace = true;
        }
      });
      if (turnedInPlace) refreshFacingMarkers();
    }

    // Pfeile: neue abschiessen, fliegende weiterbewegen, Einschlaege zuerst
    // abhandeln (Server rechnet Pfeilschaden VOR Bewegung/Nahkampf des Takts).
    arrowEvents.forEach(ev => { if (ev.kind === 'launch') spawnArrow(ev); });
    advanceArrows(tick);
    // Alle Einschlaege dieses Takts GLEICHZEITIG: die Pfeile sollen zusammen
    // ankommen, nicht nacheinander.
    await Promise.all(
      arrowEvents
        .filter(ev => ev.kind === 'impact')
        .map(ev => animateArrowImpact(ev))
    );

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
    const interceptorSet = new Set(ticks[tick].interceptors || []);
    const hasConflict = blockedAttempts.length > 0 || combatEvents.length > 0;

    if (hasConflict || interceptorSet.size > 0) {
      // Konflikt-Takt ODER Abfang-Takt: gestufte Vor-Bewegung. Reihenfolge -
      // erst ruecken ALLE Nicht-Abfaenger einen Viertel-Schritt vor, DANN die
      // Abfaenger (Schwert/Speerkaempfer) einen Viertel-Schritt auf ihr serverseitig
      // berechnetes Feld; erst danach folgen Begegnungen + Rest-Bewegungen.
      const others = attemptingIds.filter(id => !interceptorSet.has(id));
      const interceptors = attemptingIds.filter(id => interceptorSet.has(id));

      // Phase 1a: alle Nicht-Abfaenger einen Viertel-Schritt vor.
      others.forEach(unitId => {
        setMoveDuration(unitId, QUARTER_MOVE_DURATION);
        const quarter = pointAtFraction(positions[unitId], attemptTargets[unitId], 0.25);
        moveUnitTo(unitId, quarter.x, quarter.y);
      });
      if (others.length > 0) await wait(QUARTER_MOVE_DURATION);

      // Phase 1b: erst DANACH die Abfaenger einen Viertel-Schritt vor.
      if (interceptors.length > 0) {
        await wait(INTERCEPT_STAGE_GAP);
        interceptors.forEach(unitId => {
          setMoveDuration(unitId, QUARTER_MOVE_DURATION);
          const quarter = pointAtFraction(positions[unitId], attemptTargets[unitId], 0.25);
          moveUnitTo(unitId, quarter.x, quarter.y);
        });
        await wait(QUARTER_MOVE_DURATION);
      }

      if (hasConflict) await wait(TICK_PAUSE_HOLD); // Takt pausiert - Konflikte werden sichtbar

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

    // Blickrichtungen dieses Takts uebernehmen und die Dreieck-Marker drehen
    // (Lauf-Richtung bzw. ausgefuehrter Dreh-Schritt).
    if (tickFacings) {
      Object.entries(tickFacings).forEach(([unitId, f]) => {
        if (unitsById[unitId]) facings[unitId] = f;
      });
      refreshFacingMarkers();
    }

    await wait(TICK_PAUSE_AFTER);
  }

  tickDisplay.classList.remove('tick-visible');
  clearArrows();
  Object.values(unitsById).filter(u => u.role === myRole).forEach(u => {
    myPlans[u.id] = [];
  });
  confirmed = false;
  shotTargeting = null;
  turnTargeting = false;
  interceptTargeting = false;
  setInterceptTargetsHighlight(false);
  confirmButton.disabled = false;
  statusEl.textContent = 'Neue Runde - klick auf eine deiner Einheiten, um Züge zu planen.';
}
