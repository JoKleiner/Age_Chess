// reiter.js
// Konfiguration für die Figur "Reiter": Bewegungsreichweite und die Liste
// aller aktuell existierenden Einheiten (Start-Position, Seite, Anzeige-Name).
// Neue Einheiten einfach unten in "units" ergänzen - der Rest passt sich an.

(function () {
  const HexBoardRef = (typeof module !== 'undefined' && module.exports)
    ? require('../board/hexBoard.js')
    : HexBoard; // im Browser bereits als globale Variable geladen

  const Reiter = {
    maxSteps: 4,
    radius: HexBoardRef.HEX_SIZE * 0.4,

    // chipIndex wählt das Bild media/Reiter_{Blau|Rot}{chipIndex}.png
    units: [
      { id: 'blue1', role: 'blue', label: 'Reiter 1', chipIndex: 1, start: { col: 'D', row: 3 } },
      { id: 'blue2', role: 'blue', label: 'Reiter 2', chipIndex: 2, start: { col: 'C', row: 3 } },
      { id: 'red1',  role: 'red',  label: 'Reiter 1', chipIndex: 1, start: { col: 'D', row: 8 } },
      { id: 'red2',  role: 'red',  label: 'Reiter 2', chipIndex: 2, start: { col: 'C', row: 8 } }
    ]
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Reiter;
  } else {
    window.Reiter = Reiter;
  }
})();
