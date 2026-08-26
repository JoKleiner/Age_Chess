// hexBoard.js
// Alles, was mit dem Hex-Raster selbst zu tun hat: Koordinaten, Nachbarschaft,
// Feld-Erzeugung und Zeichnen. Kennt nichts von Figuren, Spielern oder Netzwerk.

const HexBoard = (function () {

  const HEX_SIZE = 36;       // Abstand Mittelpunkt -> Ecke
  const BOARD_RADIUS = 4;    // Zeilen-Ausdehnung je Spalte (Hex-Radius, unverändert)
  const COL_RADIUS = 3;      // Sichtbare Spalten: 7 Spalten (A-G), A und I entfernt

  // ---- Spalte (Buchstabe) <-> internes q ----
  // A = -3, B = -2, ... D = 0 (Mitte), ... G = 3
  function qFromCol(col) {
    return col.toUpperCase().charCodeAt(0) - 'A'.charCodeAt(0) - COL_RADIUS;
  }

  function colFromQ(q) {
    return String.fromCharCode('A'.charCodeAt(0) + q + COL_RADIUS);
  }

  // ---- Reihe (Nummer 1-9) <-> internes r ----
  function rFromRow(row) {
    return 5 - row;
  }

  function rowFromR(r) {
    return 5 - r;
  }

  function cellRef(col, row) {
    return { q: qFromCol(col), r: rFromRow(row) };
  }

  // Wandelt interne (q,r) zurück in die lesbare Form { col: 'A', row: 2 }
  function labelOf(q, r) {
    return { col: colFromQ(q), row: rowFromR(r) };
  }

  // Letzte Reihe an beiden Enden entfernt (Brett war zu groß): die alten
  // ADDED_CELLS-Ecken (A1,B1,F3,G4 oben / A8,B9,F11,G11 unten) fallen komplett
  // weg, die restlichen Rand-Zellen werden aus der natürlichen Grundform entfernt.
  const REMOVED_CELLS = [
    { col: 'C', row: 1 },
    { col: 'D', row: 1 },
    { col: 'E', row: 2 },
    { col: 'C', row: 8 },
    { col: 'D', row: 9 },
    { col: 'E', row: 9 },
  ];

  const ADDED_CELLS = [];

  // Zonen um 1 Reihe Richtung Mitte verschoben (an den neuen Rand angepasst).
  const BLUE_CELLS = [
    { col: 'A', row: 1 },
    { col: 'B', row: 1 },
    { col: 'B', row: 2 },
    { col: 'C', row: 2 },
    { col: 'C', row: 3 },
    { col: 'D', row: 2 },
    { col: 'D', row: 3 },
    { col: 'E', row: 3 },
    { col: 'E', row: 4 },
    { col: 'F', row: 3 },
    { col: 'F', row: 4 },
    { col: 'G', row: 4 },
  ];

  const RED_CELLS = [
    { col: 'A', row: 6 },
    { col: 'B', row: 6 },
    { col: 'B', row: 7 },
    { col: 'C', row: 6 },
    { col: 'C', row: 7 },
    { col: 'D', row: 7 },
    { col: 'D', row: 8 },
    { col: 'E', row: 7 },
    { col: 'E', row: 8 },
    { col: 'F', row: 8 },
    { col: 'F', row: 9 },
    { col: 'G', row: 9 },
  ];

  // ---------------------------------------------------------

  const redZoneKeys = new Set(RED_CELLS.map(c => {
    const { q, r } = cellRef(c.col, c.row);
    return keyOf(q, r);
  }));
  const blueZoneKeys = new Set(BLUE_CELLS.map(c => {
    const { q, r } = cellRef(c.col, c.row);
    return keyOf(q, r);
  }));

  // Liefert 'red', 'blue' oder 'gray' fuer eine Zelle - genutzt sowohl beim
  // Zeichnen (computeLayout) als auch serverseitig, um Platzierungen auf die
  // eigene Zone zu beschraenken.
  function zoneOf(q, r) {
    const key = keyOf(q, r);
    if (redZoneKeys.has(key)) return 'red';
    if (blueZoneKeys.has(key)) return 'blue';
    return 'gray';
  }

  function axialToPixel(q, r) {
    const x = HEX_SIZE * 1.5 * q;
    const y = HEX_SIZE * Math.sqrt(3) * (r + q / 2);
    return { x, y };
  }

  function hexCorners(cx, cy, size = HEX_SIZE) {
    const points = [];
    for (let i = 0; i < 6; i++) {
      const angle = Math.PI / 180 * (60 * i);
      points.push([cx + size * Math.cos(angle), cy + size * Math.sin(angle)]);
    }
    return points.map(p => p.join(',')).join(' ');
  }

  // Die 6 Nachbar-Richtungen in Axial-Koordinaten
  const DIRECTIONS = [
    { dq: 1, dr: 0 }, { dq: 1, dr: -1 }, { dq: 0, dr: -1 },
    { dq: -1, dr: 0 }, { dq: -1, dr: 1 }, { dq: 0, dr: 1 }
  ];

  function hexDistance(a, b) {
    const dq = a.q - b.q;
    const dr = a.r - b.r;
    return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
  }

  function keyOf(q, r) {
    return q + ',' + r;
  }

  // Erzeugt alle Felder des Bretts (Sechseck-Grundform),
  // abzüglich REMOVED_CELLS, zuzüglich ADDED_CELLS (siehe oben).
  function generateBoardCells() {
    const cells = [];

    for (let q = -COL_RADIUS; q <= COL_RADIUS; q++) {
      const rMin = Math.max(-BOARD_RADIUS, -q - BOARD_RADIUS);
      const rMax = Math.min(BOARD_RADIUS, -q + BOARD_RADIUS);
      for (let r = rMin; r <= rMax; r++) {
        cells.push({ q, r });
      }
    }

    // Manuell entfernte Felder rausfiltern
    const removedKeys = new Set(REMOVED_CELLS.map(c => {
      const { q, r } = cellRef(c.col, c.row);
      return keyOf(q, r);
    }));
    const filtered = cells.filter(c => !removedKeys.has(keyOf(c.q, c.r)));

    // Manuell hinzugefügte Felder ergänzen (falls nicht schon vorhanden)
    const existingKeys = new Set(filtered.map(c => keyOf(c.q, c.r)));
    ADDED_CELLS.forEach(({ col, row }) => {
      const { q, r } = cellRef(col, row);
      const key = keyOf(q, r);
      if (!existingKeys.has(key)) {
        filtered.push({ q, r });
        existingKeys.add(key);
      }
    });

    return filtered;
  }

  // Berechnet für jede Zelle Pixel-Position, Zeilen-Nummer, Zone und Hell/Dunkel.
  function computeLayout(cells) {
    return cells.map(c => {
      const { x, y } = axialToPixel(c.q, c.r);
      const row = rowFromR(c.r);
      const zone = zoneOf(c.q, c.r);

      // Schachbrett-Schattierung ist an die interne r-Koordinate gekoppelt
      // (nicht an die Anzeige-Reihennummer), damit sich das Muster nicht
      // verschiebt, wenn sich nur die Beschriftung ändert.
      const isDark = c.r % 2 === 0;
      const shadeName = `${zone}-${isDark ? 'dark' : 'light'}`;

      return { ...c, x, y, row, zone, shadeName };
    });
  }

  // Zeichnet das Brett in das übergebene <svg>-Element und gibt eine Map
  // key -> <polygon> zurück, damit andere Module (game.js) darauf reagieren können.
  // flip: dreht nur die Darstellung um 180° (für Spieler Rot) - Zonenfarben bleiben
  // unverändert (rot ist rot, blau ist blau). Das Brett ist punktsymmetrisch um (0,0),
  // daher genügt es, die berechneten Pixel-Koordinaten zu negieren
  // (axialToPixel(-q,-r) === -axialToPixel(q,r)); die echten q/r-Modellwerte im
  // dataset bleiben unverändert, Klicks landen also weiterhin auf der richtigen Zelle.
  function render(svgElement, { offsetX, offsetY, flip, onCellClick }) {
    const cells = computeLayout(generateBoardCells());
    const hexElements = {};

    // Bildschirm-Koordinaten (nach Flip) vorab je Zelle merken, damit die
    // Spalten-/Reihen-Beschriftungen unten unabhängig von der Drehung immer
    // am tatsächlich sichtbaren Rand landen.
    const screenCells = cells.map(cell => ({
      ...cell,
      cx: (flip ? -cell.x : cell.x) + offsetX,
      cy: (flip ? -cell.y : cell.y) + offsetY
    }));

    screenCells.forEach(cell => {
      const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      polygon.setAttribute('points', hexCorners(cell.cx, cell.cy));
      polygon.classList.add('hex', cell.shadeName);
      polygon.dataset.q = cell.q;
      polygon.dataset.r = cell.r;
      polygon.dataset.col = colFromQ(cell.q);
      polygon.dataset.row = cell.row;

      if (onCellClick) {
        polygon.addEventListener('click', () => onCellClick(cell.q, cell.r));
      }

      svgElement.appendChild(polygon);
      hexElements[keyOf(cell.q, cell.r)] = polygon;
    });

    renderBoardLabels(svgElement, screenCells, { offsetX, offsetY, flip });

    return hexElements;
  }

  // Beschriftung als kleine Sechsecke, die selbst wie eine Fortsetzung des
  // Hex-Rasters wirken:
  // - Reihen-Zahlen (1-9): je ein kleines Sechseck knapp außerhalb der
  //   linkesten Zelle ihrer Zeile, in Richtung der echten Nachbar-Position
  //   (dq=∓1, abhängig von der Drehung, damit es bei Rot nicht ins Brett
  //   hinein statt nach außen zeigt). Zwischen den beiden jeweils
  //   nächstgelegenen Ecken von Zahlen-Sechseck und Feld-Sechseck wird ein
  //   Viereck in der Farbe der Zeile eingefärbt, das die Lücke schließt und
  //   die Zuordnung eindeutig macht. Das Zahlen-Sechseck selbst bekommt
  //   dieselbe Hell/Dunkel-Schattierung wie die Zeile.
  // - Spalten-Buchstaben (A-G): je ein kleines Sechseck unterhalb der Spalte,
  //   aber alle auf gleicher Höhe (eine Raster-Reihe unter dem insgesamt
  //   tiefsten Punkt des Bretts), damit sie nicht "im Zickzack" stehen.
  const LABEL_HEX_SIZE = HEX_SIZE * 0.55;
  // Etwas näher an die reale Nachbar-Zelle heranziehen als der volle (für
  // gleich große Sechsecke gedachte) Rasterabstand.
  const ROW_LABEL_PULL = 0.85;

  function hexCornerPoint(cx, cy, size, index) {
    const angle = Math.PI / 180 * (60 * index);
    return { x: cx + size * Math.cos(angle), y: cy + size * Math.sin(angle) };
  }

  function renderBoardLabels(svgElement, screenCells, { offsetX, offsetY, flip }) {
    const toScreen = (q, r) => {
      const { x, y } = axialToPixel(q, r);
      return { cx: (flip ? -x : x) + offsetX, cy: (flip ? -y : y) + offsetY };
    };

    // Reihen-Zahlen
    const leftByRow = {};
    screenCells.forEach(cell => {
      const left = leftByRow[cell.row];
      if (!left || cell.cx < left.cx) leftByRow[cell.row] = cell;
    });

    // dq=-1 verschiebt die Bildschirm-Position im Original nach außen
    // (links); bei gedrehter Darstellung (Rot) muss stattdessen dq=+1
    // verwendet werden, damit die Beschriftung weiterhin nach außen statt
    // zurück ins Brett zeigt.
    const outwardDq = flip ? 1 : -1;

    Object.values(leftByRow).forEach(cell => {
      const full = toScreen(cell.q + outwardDq, cell.r);
      const cx = cell.cx + (full.cx - cell.cx) * ROW_LABEL_PULL;
      const cy = cell.cy + (full.cy - cell.cy) * ROW_LABEL_PULL;

      // Die dem Feld-Sechseck am nächsten liegenden Ecken beider Sechsecke
      // spannen ein Viereck auf (Ecke 1 = unten rechts, 0 = rechts beim
      // Zahlen-Sechseck; Ecke 3 = links, 4 = oben links beim Feld-Sechseck).
      // Die Sechseck-Form wird durch das Spiegeln des Mittelpunkts nicht
      // mitgedreht, daher gelten dieselben Ecken-Indizes unabhängig von der
      // Drehung. In der Farbe der Zeile eingefärbt schließt es die Lücke.
      const numberCorner0 = hexCornerPoint(cx, cy, LABEL_HEX_SIZE, 0);
      const numberCorner1 = hexCornerPoint(cx, cy, LABEL_HEX_SIZE, 1);
      const boardCorner3 = hexCornerPoint(cell.cx, cell.cy, HEX_SIZE, 3);
      const boardCorner4 = hexCornerPoint(cell.cx, cell.cy, HEX_SIZE, 4);
      appendBridgeQuad(svgElement, [numberCorner0, numberCorner1, boardCorner3, boardCorner4], cell.shadeName);

      const isDark = cell.r % 2 === 0;
      appendLabelHex(svgElement, cx, cy, cell.row, isDark ? 'label-dark' : 'label-light');
    });

    // Spalten-Buchstaben, alle auf einer gemeinsamen Höhe
    let maxCy = -Infinity;
    screenCells.forEach(cell => { if (cell.cy > maxCy) maxCy = cell.cy; });
    const letterCy = maxCy + HEX_SIZE * Math.sqrt(3);

    const xByCol = {};
    screenCells.forEach(cell => { xByCol[cell.q] = cell.cx; });

    Object.entries(xByCol).forEach(([q, cx]) => {
      appendLabelHex(svgElement, cx, letterCy, colFromQ(Number(q)), 'label-neutral');
    });
  }

  // Viereck, das die Lücke zwischen Zahlen-Sechseck und Feld-Sechseck
  // schließt - bekommt dieselben CSS-Klassen wie die echten Feld-Sechsecke,
  // damit exakt dieselbe Zonen-/Schattierungsfarbe verwendet wird.
  function appendBridgeQuad(svgElement, points, shadeName) {
    const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    polygon.setAttribute('points', points.map(p => `${p.x},${p.y}`).join(' '));
    polygon.classList.add('hex', shadeName, 'label-bridge');
    svgElement.appendChild(polygon);
  }

  function appendLabelHex(svgElement, cx, cy, content, shadeClass) {
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.classList.add('label-hex-group');

    const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    polygon.setAttribute('points', hexCorners(cx, cy, LABEL_HEX_SIZE));
    polygon.classList.add('label-hex', shadeClass);
    group.appendChild(polygon);

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', cx);
    text.setAttribute('y', cy);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    text.classList.add('board-label');
    text.textContent = content;
    group.appendChild(text);

    svgElement.appendChild(group);
  }

  return {
    HEX_SIZE,
    BOARD_RADIUS,
    COL_RADIUS,
    DIRECTIONS,
    qFromCol,
    colFromQ,
    rFromRow,
    rowFromR,
    cellRef,
    labelOf,
    zoneOf,
    axialToPixel,
    hexCorners,
    hexDistance,
    keyOf,
    generateBoardCells,
    computeLayout,
    render
  };

})();

// Macht HexBoard auch in Node.js (server.js) nutzbar, ohne den Browser-Gebrauch
// zu stören (dort existiert "module" schlicht nicht, der Check greift dann nicht).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = HexBoard;
}
