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

  // ---- Reihe (Nummer 1-11) <-> internes r ----
  // Reihe 1 = alte r=5, von dort hochzählen (Reihe 2 = alte r=4, usw.)
  function rFromRow(row) {
    return 6 - row;
  }

  function rowFromR(r) {
    return 6 - r;
  }

  function cellRef(col, row) {
    return { q: qFromCol(col), r: rFromRow(row) };
  }

  // Wandelt interne (q,r) zurück in die lesbare Form { col: 'A', row: 2 }
  function labelOf(q, r) {
    return { col: colFromQ(q), row: rowFromR(r) };
  }

  const REMOVED_CELLS = [];

  const ADDED_CELLS = [
    { col: 'A', row: 1 },
    { col: 'B', row: 1 },
    { col: 'A', row: 8 },
    { col: 'B', row: 9 },
    { col: 'F', row: 11 },
    { col: 'G', row: 11 },
    { col: 'F', row: 3 },
    { col: 'G', row: 4 },
  ];

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
    { col: 'A', row: 8 },
    { col: 'B', row: 8 },
    { col: 'B', row: 9 },
    { col: 'C', row: 8 },
    { col: 'C', row: 9 },
    { col: 'D', row: 9 },
    { col: 'D', row: 10 },
    { col: 'E', row: 9 },
    { col: 'E', row: 10 },
    { col: 'F', row: 10 },
    { col: 'F', row: 11 },
    { col: 'G', row: 11 },
  ];

  // ---------------------------------------------------------

  function axialToPixel(q, r) {
    const x = HEX_SIZE * 1.5 * q;
    const y = HEX_SIZE * Math.sqrt(3) * (r + q / 2);
    return { x, y };
  }

  function hexCorners(cx, cy) {
    const points = [];
    for (let i = 0; i < 6; i++) {
      const angle = Math.PI / 180 * (60 * i);
      points.push([cx + HEX_SIZE * Math.cos(angle), cy + HEX_SIZE * Math.sin(angle)]);
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
    const redKeys = new Set(RED_CELLS.map(c => {
      const { q, r } = cellRef(c.col, c.row);
      return keyOf(q, r);
    }));
    const blueKeys = new Set(BLUE_CELLS.map(c => {
      const { q, r } = cellRef(c.col, c.row);
      return keyOf(q, r);
    }));

    return cells.map(c => {
      const { x, y } = axialToPixel(c.q, c.r);
      const row = 6 - c.r; // Reihen-Nummer, siehe rFromRow

      const key = keyOf(c.q, c.r);
      let zone = 'gray';
      if (redKeys.has(key)) zone = 'red';
      else if (blueKeys.has(key)) zone = 'blue';

      // Gerade Reihen-Nummern = dunkel, ungerade = hell
      const isDark = row % 2 === 0;
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

    cells.forEach(cell => {
      const cx = (flip ? -cell.x : cell.x) + offsetX;
      const cy = (flip ? -cell.y : cell.y) + offsetY;

      const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      polygon.setAttribute('points', hexCorners(cx, cy));
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

    return hexElements;
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
