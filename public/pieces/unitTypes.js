// unitTypes.js
// Konfiguration aller Einheiten-Arten. Jede Art hat einen eigenen Stapel von
// maximal 3 Einheiten pro Spieler; ein Spieler darf insgesamt (ueber alle
// Arten hinweg) MAX_UNITS_PER_PLAYER Einheiten platzieren.
//
// "chip" beschreibt, wie eine Einheit gezeichnet wird:
//   { kind: 'image', imageFolder: 'Reiter', imageBase: 'Reiter' }
//     -> media/{imageFolder}/{imageBase}_{Blau|Rot}{n}.png
//     (imageBase kann vom Ordnernamen abweichen, z.B. Ordner "Schuetze" mit
//     Dateien "Schütze_...")
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

    // Ein Chip ist optisch eine Einheit, stellt aber ein Bataillon aus
    // BATTALION_SIZE einzelnen Einheiten dar. hp ist die HP EINER einzelnen
    // Einheit dieser Art (Bataillons-HP = hp * BATTALION_SIZE). damage[X] ist
    // der Schaden, den EINE einzelne Einheit dieser Art an einer einzelnen
    // Einheit der Art X verursacht - der Gesamtschaden im Kampf ist dann
    // (noch lebende Einheiten im Bataillon) * damage[gegnerische Art].
    BATTALION_SIZE: 10,

    // speedRank bestimmt sowohl, welche Einheit bei einem Zusammenstoss auf
    // dasselbe Feld gewinnt (hoeherer Rang gewinnt), als auch implizit die
    // Reihenfolge Reiter > Schwert > Lanze > Schuetze aus den Bewegungsregeln.
    TYPES: [
      {
        key: 'reiter', label: 'Reiter', maxPerPlayer: 3, maxSteps: 4, speedRank: 4,
        chip: { kind: 'image', imageFolder: 'Reiter', imageBase: 'Reiter' },
        hp: 15, damage: { reiter: 6, bogenschuetze: 10, schwertkaempfer: 9, lanze: 4 }
      },
      {
        key: 'schwertkaempfer', label: 'Schwertkämpfer', maxPerPlayer: 3, maxSteps: 2, speedRank: 3,
        chip: { kind: 'image', imageFolder: 'Schild', imageBase: 'Schild' },
        hp: 15, damage: { reiter: 6, bogenschuetze: 9, schwertkaempfer: 6, lanze: 9 }
      },
      {
        key: 'lanze', label: 'Lanze', maxPerPlayer: 3, maxSteps: 2, speedRank: 2,
        chip: { kind: 'image', imageFolder: 'Lanze', imageBase: 'Lanze' },
        hp: 15, damage: { reiter: 12, bogenschuetze: 5, schwertkaempfer: 4, lanze: 6 }
      },
      {
        key: 'bogenschuetze', label: 'Bogenschütze', maxPerPlayer: 3, maxSteps: 2, speedRank: 1,
        chip: { kind: 'image', imageFolder: 'Schuetze', imageBase: 'Schütze' },
        hp: 10, damage: { reiter: 0, bogenschuetze: 0, schwertkaempfer: 0, lanze: 0 }
      }
    ]
  };

  UnitTypes.byKey = function (typeKey) {
    return UnitTypes.TYPES.find(t => t.key === typeKey);
  };

  // Maximale Anzahl Takte, die eine Einheit dieser Art pro Runde planen darf.
  UnitTypes.maxStepsFor = function (typeKey) {
    const type = UnitTypes.byKey(typeKey);
    return type ? type.maxSteps : UnitTypes.DEFAULT_MAX_STEPS;
  };

  // Vergleichs-Rang fuer Zusammenstoesse zwischen eigenen Einheiten:
  // hoeherer Rang gewinnt ein umkaempftes Feld (Reiter > Schwert > Lanze > Schuetze).
  UnitTypes.speedRankFor = function (typeKey) {
    const type = UnitTypes.byKey(typeKey);
    return type ? type.speedRank : 0;
  };

  // Volle Bataillons-HP eines frisch aufgestellten Bataillons dieser Art.
  UnitTypes.maxHpFor = function (typeKey) {
    const type = UnitTypes.byKey(typeKey);
    return type ? type.hp * UnitTypes.BATTALION_SIZE : 0;
  };

  // Schaden, den EIN Bataillon der Art attackerTypeKey an EINER einzelnen
  // Einheit der Art defenderTypeKey verursacht (noch mit der Anzahl lebender
  // Einheiten im angreifenden Bataillon zu multiplizieren, siehe livingUnitsFor).
  UnitTypes.damageOf = function (attackerTypeKey, defenderTypeKey) {
    const type = UnitTypes.byKey(attackerTypeKey);
    return type && type.damage[defenderTypeKey] != null ? type.damage[defenderTypeKey] : 0;
  };

  // Anzahl noch lebender Einheiten in einem Bataillon dieser Art bei
  // gegebenem HP-Stand - wird rueckwaerts von der HP-Zahl berechnet (die
  // "vorderste" Einheit kann dabei bereits angeschlagen/nicht bei voller
  // HP sein).
  UnitTypes.livingUnitsFor = function (typeKey, currentHp) {
    const type = UnitTypes.byKey(typeKey);
    if (!type || currentHp <= 0) return 0;
    return Math.min(UnitTypes.BATTALION_SIZE, Math.ceil(currentHp / type.hp));
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = UnitTypes;
  } else {
    window.UnitTypes = UnitTypes;
  }
})();
