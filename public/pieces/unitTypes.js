// unitTypes.js
// Konfiguration aller Einheiten-Arten. Jede Art hat einen eigenen Stapel von
// maximal 3 Einheiten pro Spieler; ein Spieler darf insgesamt (ueber alle
// Arten hinweg) MAX_UNITS_PER_PLAYER Einheiten platzieren.
//
// "chip" beschreibt, wie eine Einheit gezeichnet wird:
//   { kind: 'image', imageBase: 'Reiter' } -> media/{imageBase}_{Blau|Rot}{n}.png
//   { kind: 'placeholder', letter: 'S' }   -> generierter Kreis-Chip mit Buchstabe
//     (fuer Arten ohne eigenes Artwork - einfach durch 'image' ersetzen, sobald
//     Bilder vorhanden sind)
//
// Neue Einheiten-IDs werden erst zur Laufzeit bei der Platzierung vergeben
// (Schema role_typeKey_instanceIndex, z.B. "blue_reiter_1").

(function () {
  const UnitTypes = {
    MAX_UNITS_PER_PLAYER: 5,
    DEFAULT_MAX_STEPS: 4,
    CHIP_RADIUS_FACTOR: 0.4, // * HexBoard.HEX_SIZE

    TYPES: [
      { key: 'reiter', label: 'Reiter', maxPerPlayer: 3, chip: { kind: 'image', imageBase: 'Reiter' } },
      { key: 'schwertkaempfer', label: 'Schwertkämpfer', maxPerPlayer: 3, chip: { kind: 'placeholder', letter: 'S' } },
      { key: 'bogenschuetze', label: 'Bogenschütze', maxPerPlayer: 3, chip: { kind: 'placeholder', letter: 'B' } },
      { key: 'katapult', label: 'Katapult', maxPerPlayer: 3, chip: { kind: 'placeholder', letter: 'K' } }
    ]
  };

  UnitTypes.byKey = function (typeKey) {
    return UnitTypes.TYPES.find(t => t.key === typeKey);
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = UnitTypes;
  } else {
    window.UnitTypes = UnitTypes;
  }
})();
