const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const HexBoard = require('./public/board/hexBoard.js');
const UnitTypes = require('./public/pieces/unitTypes.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Alle gültigen Feld-Koordinaten einmal berechnen, um Züge serverseitig zu prüfen
const validCellKeys = new Set(
  HexBoard.generateBoardCells().map(c => HexBoard.keyOf(c.q, c.r))
);

const rooms = {};
// rooms[roomId] = {
//   sockets: { blue: socketId, red: socketId },
//   phase: 'placement' | 'playing',
//   placements: { blue: [{unitId, typeKey, q, r}, ...], red: [...] }, <- Reihenfolge = Stapel-Reihenfolge
//   ready: { blue: false, red: false },
//   units: null oder [{id, role, typeKey, chipIndex, label}, ...]  <- erst nach Spielstart
//   positions: null oder { unitId: {q,r}, ... }                     <- erst nach Spielstart
//   hp: null oder { unitId: aktuelleBataillonsHP, ... }             <- erst nach Spielstart,
//       persistiert ueber Runden hinweg; fehlt ein unitId oder ist <= 0, ist das Bataillon besiegt
//   plans: { blue: null oder {unitId: steps[]}, red: ... }
// }

function createRoom() {
  return {
    sockets: {},
    phase: 'placement',
    placements: { blue: [], red: [] },
    ready: { blue: false, red: false },
    units: null,
    positions: null,
    hp: null,
    plans: { blue: null, red: null }
  };
}

// Anzahl bereits platzierter Einheiten einer Art fuer eine Rolle
function countOfType(placements, typeKey) {
  return placements.filter(p => p.typeKey === typeKey).length;
}

function isValidPlacement(room, role, typeKey, q, r) {
  if (room.phase !== 'placement' || room.ready[role]) return { ok: false, reason: 'Platzierungsphase bereits beendet.' };

  const type = UnitTypes.byKey(typeKey);
  if (!type) return { ok: false, reason: 'Unbekannte Einheiten-Art.' };
  if (typeof q !== 'number' || typeof r !== 'number') return { ok: false, reason: 'Ungültiges Feld.' };
  if (!validCellKeys.has(HexBoard.keyOf(q, r))) return { ok: false, reason: 'Feld existiert nicht.' };
  if (HexBoard.zoneOf(q, r) !== role) return { ok: false, reason: 'Nur die eigene Zone ist erlaubt.' };

  const placements = room.placements[role];
  if (placements.length >= UnitTypes.MAX_UNITS_PER_PLAYER) {
    return { ok: false, reason: 'Maximale Anzahl Einheiten erreicht.' };
  }
  if (countOfType(placements, typeKey) >= type.maxPerPlayer) {
    return { ok: false, reason: `Maximale Anzahl von ${type.label} erreicht.` };
  }
  if (placements.some(p => p.q === q && p.r === r)) {
    return { ok: false, reason: 'Feld bereits belegt.' };
  }

  return { ok: true };
}

// Prüft die geplanten Schritte EINER Einheit. Der Planungshorizont (Anzahl
// Takte) ist fuer alle Einheiten-Arten gleich (UnitTypes.DEFAULT_MAX_STEPS);
// wie viele davon aber ECHTE Feldwechsel sein duerfen, haengt von der Art ab
// (nur Reiter duerfen 4 Felder laufen, alle anderen Arten nur 2, siehe
// UnitTypes.maxStepsFor) - die restlichen Takte muessen "bleiben"-Schritte
// sein, koennen aber an beliebiger Stelle im Plan liegen (z.B. erst 2 Takte
// stehen bleiben und dann erst laufen).
function isValidUnitSteps(steps, startPos, typeKey) {
  if (!Array.isArray(steps) || steps.length > UnitTypes.DEFAULT_MAX_STEPS) return false;

  let previous = startPos;
  let moveCount = 0;
  for (const step of steps) {
    if (typeof step.q !== 'number' || typeof step.r !== 'number') return false;
    if (!validCellKeys.has(HexBoard.keyOf(step.q, step.r))) return false;
    const distance = HexBoard.hexDistance(previous, step);
    if (distance > 1) return false; // 0 = bleiben, 1 = bewegen
    if (distance === 1) moveCount++;
    previous = step;
  }
  if (moveCount > UnitTypes.maxStepsFor(typeKey)) return false;
  return true;
}

// Prüft den kompletten Plan EINES Spielers (alle seine Einheiten auf einmal)
function isValidRolePlan(planByUnit, positions, unitsForRole) {
  if (!planByUnit || typeof planByUnit !== 'object') return false;

  const providedIds = Object.keys(planByUnit);
  if (providedIds.length !== unitsForRole.length) return false;

  for (const unit of unitsForRole) {
    if (!(unit.id in planByUnit)) return false;
    if (!isValidUnitSteps(planByUnit[unit.id], positions[unit.id], unit.typeKey)) return false;
  }
  return true;
}

function posKeyOf(pos) {
  return HexBoard.keyOf(pos.q, pos.r);
}

function samePos(a, b) {
  return a.q === b.q && a.r === b.r;
}

// Bei einem umkaempften Feld gewinnt die Einheit mit dem hoeheren speedRank
// (Reiter > Schwert > Lanze > Schuetze); bei gleicher Art gewinnt der
// kleinere chipIndex.
function pickWinner(ids, unitsById) {
  return ids.slice().sort((a, b) => {
    const speedDiff = UnitTypes.speedRankFor(unitsById[b].typeKey) - UnitTypes.speedRankFor(unitsById[a].typeKey);
    if (speedDiff !== 0) return speedDiff;
    return unitsById[a].chipIndex - unitsById[b].chipIndex;
  })[0];
}

// Multikampf-Anteil: mit wie vielen Einheiten ein Bataillon mit `living`
// lebenden Einheiten JEDES EINZELNE von `enemyCount` gegnerischen Bataillonen
// angreift - "lebende Einheiten / Anzahl Gegner, aufgerundet, mindestens 1".
// Kein echtes Aufteilen: jeder Gegner bekommt die vollen `share` Einheiten
// des Angreifers ab (ein Bataillon mit 1 Einheit greift also 4 Gegner mit je
// 1 Einheit an).
function attackShare(living, enemyCount) {
  if (enemyCount <= 0) return 0;
  return Math.max(1, Math.ceil(living / enemyCount));
}

// Waehlt aus `ids` das Bataillon, das auf das umkaempfte Feld nachrueckt:
// hoechster im Kampf ausgeteilter Gesamtschaden (damageByUnit), bei
// Gleichstand hoeherer speedRank, dann kleinerer chipIndex. Gibt null zurueck,
// wenn `ids` leer ist oder der Beste 0 Schaden ausgeteilt hat - ein Bataillon,
// das keinen Schaden verursacht (z.B. Bogenschuetze), verdraengt nie jemanden.
function pickAdvancer(ids, damageByUnit, unitsById) {
  if (!ids.length) return null;
  const best = ids.slice().sort((a, b) => {
    const dmgDiff = (damageByUnit[b] || 0) - (damageByUnit[a] || 0);
    if (dmgDiff !== 0) return dmgDiff;
    const speedDiff = UnitTypes.speedRankFor(unitsById[b].typeKey) - UnitTypes.speedRankFor(unitsById[a].typeKey);
    if (speedDiff !== 0) return speedDiff;
    return unitsById[a].chipIndex - unitsById[b].chipIndex;
  })[0];
  return (damageByUnit[best] || 0) > 0 ? best : null;
}

// Loest die Bewegung einer eingereichten Runde Takt fuer Takt auf. Erzwingt
// dabei fuer Einheiten DESSELBEN Spielers, dass nie zwei auf demselben Feld
// landen und dass zwei eigene Einheiten nicht direkt die Plaetze tauschen
// (aneinander vorbeilaufen). Begegnungen zwischen Einheiten UNTERSCHIEDLICHER
// Spieler loesen stattdessen Kampf aus (siehe die resolve*Combat-Closures
// unten, die auch den Multikampf N-gegen-M abdecken). Alles laeuft
// takt-fuer-Takt und pro Takt iterativ bis zum Fixpunkt, weil eine Blockade
// oder ein Kampf-Ergebnis in Takt N selbst wieder ein Feld belegen und so
// eine Kettenreaktion (weitere Blockaden/Kaempfe) ausloesen kann.
function resolveRound(room, combinedPlan) {
  const unitsById = {};
  room.units.forEach(u => { unitsById[u.id] = u; });

  const totalTicks = Math.max(0, ...Object.values(combinedPlan).map(s => s.length));
  const livePositions = {};
  Object.keys(combinedPlan).forEach(id => { livePositions[id] = { ...room.positions[id] }; });

  const hp = { ...room.hp };
  const blockedUnits = new Set();
  const deadUnits = new Set(Object.keys(hp).filter(id => hp[id] <= 0));
  const ticks = [];

  // Per-Takt-Zustand - wird zu Beginn jedes Takts neu gesetzt und von den
  // Kampf-Closures unten ueber den Closure-Verweis gelesen/geschrieben.
  let desired = {};
  let combatEvents = [];
  let combatResolvedThisTick = new Set();

  const livingOf = (id) => UnitTypes.livingUnitsFor(unitsById[id].typeKey, hp[id]);
  const areEnemies = (a, b) => unitsById[a].role !== unitsById[b].role;

  // Nach einem Kampf verfallen fuer alle Beteiligten die restlichen Zuege
  // dieser Runde (blockedUnits) und sie werden diesen Takt nicht noch einmal
  // in einen Kampf gezogen (combatResolvedThisTick).
  const markFought = (ids) => ids.forEach(id => {
    combatResolvedThisTick.add(id);
    blockedUnits.add(id);
  });

  // Baut ein Kampf-Ereignis fuer die Client-Animation. `partById` liefert pro
  // Teilnehmer { from, attempt, hpAfter, defeated }. In der Animation ruecken
  // alle Teilnehmer erst ein Viertel Richtung `attempt` vor; danach zieht
  // `moverId` auf sein `attempt`-Feld nach, alle anderen weichen auf ihr
  // `from`-Feld zurueck, besiegte werden entfernt.
  const buildCombatEvent = (cells, ids, partById, moverId) => {
    combatEvents.push({
      cells: cells.map(c => ({ q: c.q, r: c.r })),
      moverId: moverId || null,
      participants: ids.map(id => ({
        unitId: id,
        fromCell: { q: partById[id].from.q, r: partById[id].from.r },
        attemptCell: { q: partById[id].attempt.q, r: partById[id].attempt.r },
        hpAfter: partById[id].hpAfter,
        defeated: !!partById[id].defeated
      }))
    });
  };

  // Fall 1: EIN stehendes Bataillon (defenderId) auf einem Feld wird im
  // selben Takt von mehreren gegnerischen Bataillonen (attackerIds) angezogen.
  // Der Verteidiger teilt seine lebenden Einheiten durch die Anzahl Angreifer
  // (aufgerundet, min. 1) und greift damit JEDEN Angreifer an; jeder Angreifer
  // teilt seinen vollen Schaden aus. Alles gleichzeitig aus den Vor-Kampf-
  // Werten. Sinkt der Verteidiger auf 0 HP, rueckt der Angreifer mit dem
  // meisten an ihm verursachten Schaden auf das Feld nach.
  const resolveDefenseCombat = (defenderId, attackerIds) => {
    const dType = unitsById[defenderId].typeKey;
    const dCell = { ...livePositions[defenderId] };
    const share = attackShare(livingOf(defenderId), attackerIds.length);

    const dmgToDefender = {};
    const dmgToAttacker = {};
    attackerIds.forEach(id => {
      dmgToDefender[id] = livingOf(id) * UnitTypes.damageOf(unitsById[id].typeKey, dType);
      dmgToAttacker[id] = share * UnitTypes.damageOf(dType, unitsById[id].typeKey);
    });

    const totalToDefender = attackerIds.reduce((s, id) => s + dmgToDefender[id], 0);
    hp[defenderId] = Math.max(0, hp[defenderId] - totalToDefender);
    attackerIds.forEach(id => { hp[id] = Math.max(0, hp[id] - dmgToAttacker[id]); });

    const defenderDefeated = hp[defenderId] <= 0;
    const moverId = defenderDefeated
      ? pickAdvancer(attackerIds.filter(id => hp[id] > 0), dmgToDefender, unitsById)
      : null;

    desired[defenderId] = { ...dCell };
    attackerIds.forEach(id => {
      desired[id] = id === moverId ? { ...dCell } : { ...livePositions[id] };
    });

    markFought([defenderId, ...attackerIds]);
    if (defenderDefeated) deadUnits.add(defenderId);
    attackerIds.forEach(id => { if (hp[id] <= 0) deadUnits.add(id); });

    const part = {
      [defenderId]: { from: dCell, attempt: dCell, hpAfter: hp[defenderId], defeated: defenderDefeated }
    };
    attackerIds.forEach(id => {
      part[id] = { from: { ...livePositions[id] }, attempt: dCell, hpAfter: hp[id], defeated: hp[id] <= 0 };
    });
    buildCombatEvent([dCell], [defenderId, ...attackerIds], part, moverId);
  };

  // Fall 3: leeres Feld, mehrere Bataillone BEIDER Seiten ziehen im selben
  // Takt darauf. Jede Seite teilt die lebenden Einheiten jedes ihrer
  // Bataillone durch die Anzahl gegnerischer Bataillone (aufgerundet, min. 1)
  // und greift damit JEDES gegnerische Bataillon an. Bataillone derselben
  // Seite fuegen sich untereinander nichts zu. Das Feld wird SEITENWEISE
  // entschieden: haben beide Seiten exakt gleich viel Gesamtschaden ausgeteilt,
  // rueckt NIEMAND nach (Feld bleibt leer). Sonst gewinnt die Seite mit mehr
  // Gesamtschaden das Feld; unter ihren Ueberlebenden rueckt das Bataillon mit
  // dem meisten selbst ausgeteilten Schaden nach (Gleichstand: hoeherer
  // speedRank, dann kleinerer chipIndex; ueberlebt keines, bleibt es leer).
  const resolveClashCombat = (moverIds) => {
    const target = { ...desired[moverIds[0]] };
    const blue = moverIds.filter(id => unitsById[id].role === 'blue');
    const red = moverIds.filter(id => unitsById[id].role === 'red');

    const shareOf = {};
    blue.forEach(id => { shareOf[id] = attackShare(livingOf(id), red.length); });
    red.forEach(id => { shareOf[id] = attackShare(livingOf(id), blue.length); });

    const incoming = {};
    const dealt = {};
    moverIds.forEach(id => { incoming[id] = 0; dealt[id] = 0; });
    const applyPair = (attackerId, defenderId) => {
      const d = shareOf[attackerId] * UnitTypes.damageOf(unitsById[attackerId].typeKey, unitsById[defenderId].typeKey);
      dealt[attackerId] += d;
      incoming[defenderId] += d;
    };
    blue.forEach(b => red.forEach(r => applyPair(b, r)));
    red.forEach(r => blue.forEach(b => applyPair(r, b)));

    moverIds.forEach(id => { hp[id] = Math.max(0, hp[id] - incoming[id]); });

    const blueTotal = blue.reduce((s, id) => s + dealt[id], 0);
    const redTotal = red.reduce((s, id) => s + dealt[id], 0);
    const winningSide = blueTotal > redTotal ? blue : redTotal > blueTotal ? red : null;
    const moverId = winningSide
      ? pickAdvancer(winningSide.filter(id => hp[id] > 0), dealt, unitsById)
      : null;

    moverIds.forEach(id => {
      desired[id] = id === moverId ? { ...target } : { ...livePositions[id] };
      if (hp[id] <= 0) deadUnits.add(id);
    });
    markFought(moverIds);

    const part = {};
    moverIds.forEach(id => {
      part[id] = { from: { ...livePositions[id] }, attempt: target, hpAfter: hp[id], defeated: hp[id] <= 0 };
    });
    buildCombatEvent([target], moverIds, part, moverId);
  };

  // Fall 2c: chargerId steht auf seinem Feld und zieht auf ein Feld, auf dem
  // ein stehendes gegnerisches Bataillon (enemyId) steht; GLEICHZEITIG ziehen
  // gegnerische Bataillone (interceptorIds) auf chargerIds Ursprungsfeld.
  //  - charger teilt enemy seinen VOLLEN Schaden zu, enemy schlaegt gleich-
  //    zeitig zurueck.
  //  - Stirbt enemy: charger rueckt (falls selbst noch am Leben) auf enemys
  //    Feld nach und entkommt dem Kampf auf seinem alten Feld komplett; die
  //    interceptorIds loesen sich ueber die normalen Regeln auf.
  //  - Ueberlebt enemy: charger bleibt auf seinem Feld. Die interceptorIds
  //    greifen ihn dort an und bekommen KEINEN Gegenschaden (charger hat
  //    seinen Schaden schon an enemy verbraucht). Stirbt charger dadurch,
  //    rueckt der interceptor mit dem meisten an ihm verursachten Schaden nach.
  const resolveChargeCombat = (chargerId, enemyId, interceptorIds) => {
    const cType = unitsById[chargerId].typeKey;
    const eType = unitsById[enemyId].typeKey;
    const chargerCell = { ...livePositions[chargerId] };
    const enemyCell = { ...livePositions[enemyId] };

    const dmgChargerToEnemy = livingOf(chargerId) * UnitTypes.damageOf(cType, eType);
    const dmgEnemyToCharger = livingOf(enemyId) * UnitTypes.damageOf(eType, cType);

    hp[enemyId] = Math.max(0, hp[enemyId] - dmgChargerToEnemy);
    const hpChargerAfterEnemy = Math.max(0, hp[chargerId] - dmgEnemyToCharger);
    const enemyDefeated = hp[enemyId] <= 0;

    markFought([chargerId, enemyId]);

    if (enemyDefeated) {
      deadUnits.add(enemyId);
      hp[chargerId] = hpChargerAfterEnemy;
      const chargerDefeated = hp[chargerId] <= 0;
      if (chargerDefeated) deadUnits.add(chargerId);
      const moverId = chargerDefeated ? null : chargerId;
      desired[chargerId] = chargerDefeated ? { ...chargerCell } : { ...enemyCell };
      desired[enemyId] = { ...enemyCell };
      buildCombatEvent([enemyCell], [chargerId, enemyId], {
        [chargerId]: { from: chargerCell, attempt: enemyCell, hpAfter: hp[chargerId], defeated: chargerDefeated },
        [enemyId]: { from: enemyCell, attempt: enemyCell, hpAfter: hp[enemyId], defeated: true }
      }, moverId);
      return;
    }

    // enemy ueberlebt -> charger bleibt auf seinem Feld stehen.
    desired[chargerId] = { ...chargerCell };
    desired[enemyId] = { ...enemyCell };

    // Stage-A-Ereignis (charger vs enemy): hpAfter des chargers ist hier nur
    // der Zwischenstand nach enemys Gegenschlag.
    buildCombatEvent([enemyCell], [chargerId, enemyId], {
      [chargerId]: { from: chargerCell, attempt: enemyCell, hpAfter: hpChargerAfterEnemy, defeated: false },
      [enemyId]: { from: enemyCell, attempt: enemyCell, hpAfter: hp[enemyId], defeated: false }
    }, null);

    if (!interceptorIds.length) {
      hp[chargerId] = hpChargerAfterEnemy;
      if (hp[chargerId] <= 0) deadUnits.add(chargerId);
      return;
    }

    // Stage B: die interceptorIds greifen den charger auf seinem Feld an, er
    // teilt keinen Gegenschaden mehr aus.
    const dmgToCharger = {};
    interceptorIds.forEach(id => {
      dmgToCharger[id] = livingOf(id) * UnitTypes.damageOf(unitsById[id].typeKey, cType);
    });
    const totalToCharger = interceptorIds.reduce((s, id) => s + dmgToCharger[id], 0);
    hp[chargerId] = Math.max(0, hpChargerAfterEnemy - totalToCharger);
    const chargerDefeated = hp[chargerId] <= 0;
    if (chargerDefeated) deadUnits.add(chargerId);

    const moverId = chargerDefeated
      ? pickAdvancer(interceptorIds.filter(id => hp[id] > 0), dmgToCharger, unitsById)
      : null;
    interceptorIds.forEach(id => {
      desired[id] = id === moverId ? { ...chargerCell } : { ...livePositions[id] };
    });
    markFought(interceptorIds);

    const part = {
      [chargerId]: { from: chargerCell, attempt: chargerCell, hpAfter: hp[chargerId], defeated: chargerDefeated }
    };
    interceptorIds.forEach(id => {
      part[id] = { from: { ...livePositions[id] }, attempt: chargerCell, hpAfter: hp[id], defeated: hp[id] <= 0 };
    });
    buildCombatEvent([chargerCell], [chargerId, ...interceptorIds], part, moverId);
  };

  // Zwei gegnerische Bataillone wollen im selben Takt die Plaetze tauschen
  // (aneinander vorbeilaufen). Standard: beide bleiben stehen; nur wenn GENAU
  // eines besiegt wird, rueckt das ueberlebende auf das frei gewordene Feld.
  const resolveSwapCombat = (id1, id2) => {
    const t1 = unitsById[id1].typeKey;
    const t2 = unitsById[id2].typeKey;
    const cell1 = { ...livePositions[id1] };
    const cell2 = { ...livePositions[id2] };
    const dmg1to2 = livingOf(id1) * UnitTypes.damageOf(t1, t2);
    const dmg2to1 = livingOf(id2) * UnitTypes.damageOf(t2, t1);
    hp[id1] = Math.max(0, hp[id1] - dmg2to1);
    hp[id2] = Math.max(0, hp[id2] - dmg1to2);
    const def1 = hp[id1] <= 0;
    const def2 = hp[id2] <= 0;
    let moverId = null;
    if (def1 && !def2) moverId = id2;
    else if (def2 && !def1) moverId = id1;
    desired[id1] = moverId === id1 ? { ...cell2 } : { ...cell1 };
    desired[id2] = moverId === id2 ? { ...cell1 } : { ...cell2 };
    markFought([id1, id2]);
    if (def1) deadUnits.add(id1);
    if (def2) deadUnits.add(id2);
    buildCombatEvent([cell1, cell2], [id1, id2], {
      [id1]: { from: cell1, attempt: cell2, hpAfter: hp[id1], defeated: def1 },
      [id2]: { from: cell2, attempt: cell1, hpAfter: hp[id2], defeated: def2 }
    }, moverId);
  };

  for (let tick = 0; tick < totalTicks; tick++) {
    desired = {};
    Object.keys(combinedPlan).forEach(unitId => {
      if (deadUnits.has(unitId)) return; // existiert nicht mehr
      if (blockedUnits.has(unitId)) {
        desired[unitId] = { ...livePositions[unitId] };
        return;
      }
      const step = combinedPlan[unitId][tick];
      desired[unitId] = step ? { q: step.q, r: step.r } : { ...livePositions[unitId] };
    });

    // In der Reihenfolge entdeckte Blockaden/Kaempfe dieses Takts, fuer die
    // "nacheinander" ablaufende Konflikt-Animation auf dem Client.
    const blockedAttempts = [];
    combatEvents = [];
    combatResolvedThisTick = new Set();

    // Verwirft die geplante Bewegung einer Einheit fuer den Rest der Runde:
    // sie bleibt auf ihrem aktuellen Feld stehen, alle weiteren Takte
    // dieser Einheit werden ignoriert (siehe blockedUnits-Check oben).
    const block = (id) => {
      blockedAttempts.push({ unitId: id, attemptedCell: desired[id] });
      desired[id] = { ...livePositions[id] };
      blockedUnits.add(id);
    };

    let changed = true;
    while (changed) {
      changed = false;

      // Ein Feld ist "umkaempft", wenn Einheiten verschiedener Spieler es im
      // selben Takt erreichen/besetzen wollen (auf dem aktuellen Stand von
      // `desired`). Fuer solche Felder wird die gleichseitige "nur die
      // schnellste darf hin"-Regel NICHT angewandt - alle eigenen Anruecker
      // gehen stattdessen gemeinsam in die Kampf-Aufloesung (Fall 1 / Fall 3),
      // die selbst dafuer sorgt, dass am Ende hoechstens eine Einheit auf dem
      // Feld steht. Wird bei Bedarf frisch ausgewertet, weil sich `desired`
      // durch die Regeln unten laufend verschiebt.
      const isEnemyContested = (key) => {
        const roles = new Set();
        room.units.forEach(u => {
          if (deadUnits.has(u.id)) return;
          const at = samePos(desired[u.id], livePositions[u.id])
            ? posKeyOf(livePositions[u.id])
            : posKeyOf(desired[u.id]);
          if (at === key) roles.add(u.role);
        });
        return roles.size >= 2;
      };

      // Phase A: gleichseitige Blockaden, die NICHT vom Ausduennen abhaengen
      // (Zielfeld von stehender eigener Einheit besetzt / eigener Platztausch).
      // Erst wenn diese fuer BEIDE Spieler durch sind, steht fest, welche
      // Felder wirklich umkaempft sind (Phase B).
      ['blue', 'red'].forEach(role => {
        const unitIds = room.units.filter(u => u.role === role && !deadUnits.has(u.id)).map(u => u.id);

        // Regel: Zielfeld ist bereits von einer in diesem Takt stehen
        // bleibenden eigenen Einheit besetzt -> Bewegung wird verworfen.
        const stationary = new Set(unitIds.filter(id => samePos(desired[id], livePositions[id])));
        unitIds.forEach(id => {
          if (stationary.has(id)) return;
          const occupied = unitIds.some(otherId =>
            otherId !== id && stationary.has(otherId) && samePos(livePositions[otherId], desired[id])
          );
          if (occupied) { block(id); changed = true; }
        });

        // Regel: zwei eigene Einheiten wollen direkt die Plaetze tauschen
        // (aneinander vorbeilaufen) - nicht erlaubt, beide bleiben stehen.
        const swapCandidates = unitIds.filter(id => !samePos(desired[id], livePositions[id]));
        for (let i = 0; i < swapCandidates.length; i++) {
          for (let j = i + 1; j < swapCandidates.length; j++) {
            const id1 = swapCandidates[i];
            const id2 = swapCandidates[j];
            if (samePos(desired[id1], livePositions[id2]) && samePos(desired[id2], livePositions[id1])) {
              block(id1);
              block(id2);
              changed = true;
            }
          }
        }
      });

      // Phase B: mehrere eigene Einheiten wollen im selben Takt auf dasselbe
      // Feld - nur die schnellste (bzw. bei gleicher Art die mit kleinerem
      // Index) bewegt sich dort hin, der Rest bleibt stehen. Umkaempfte Felder
      // sind hier ausgenommen (siehe isEnemyContested).
      ['blue', 'red'].forEach(role => {
        const unitIds = room.units.filter(u => u.role === role && !deadUnits.has(u.id)).map(u => u.id);
        const movingIds = unitIds.filter(id => !samePos(desired[id], livePositions[id]));
        const byTarget = {};
        movingIds.forEach(id => {
          const key = posKeyOf(desired[id]);
          (byTarget[key] = byTarget[key] || []).push(id);
        });
        Object.entries(byTarget).forEach(([key, ids]) => {
          if (ids.length <= 1) return;
          if (isEnemyContested(key)) return; // Kampf-Feld -> nicht gleichseitig ausduennen
          const winner = pickWinner(ids, unitsById);
          ids.forEach(id => {
            if (id !== winner) { block(id); changed = true; }
          });
        });
      });

      // ---------- Kaempfe zwischen gegnerischen Bataillonen ----------
      // Pro While-Iteration wird hoechstens EIN Kampf aufgeloest; danach
      // laeuft die Iteration neu, weil sich `desired` dadurch verschoben
      // haben kann (Kettenreaktion).
      let combatDone = false;
      const aliveIds = room.units.filter(u => !deadUnits.has(u.id)).map(u => u.id);
      const isStationary = (id) => samePos(desired[id], livePositions[id]);
      // Bataillone, die diesen Takt noch fuer einen Kampf in Frage kommen:
      // leben, ziehen tatsaechlich um, sind weder schon geblockt noch schon
      // in einen Kampf verwickelt gewesen.
      const combatMovers = () => aliveIds.filter(id =>
        !combatResolvedThisTick.has(id) && !blockedUnits.has(id) && !isStationary(id)
      );

      // (1) Platztausch zweier gegnerischer Bataillone.
      const swapPool = combatMovers();
      for (let i = 0; i < swapPool.length && !combatDone; i++) {
        for (let j = i + 1; j < swapPool.length; j++) {
          const a = swapPool[i];
          const b = swapPool[j];
          if (areEnemies(a, b) &&
              samePos(desired[a], livePositions[b]) && samePos(desired[b], livePositions[a])) {
            resolveSwapCombat(a, b);
            combatDone = true;
            changed = true;
            break;
          }
        }
      }

      // (2) Fall 2c: ein Bataillon rennt in ein stehendes gegnerisches
      //     Bataillon, waehrend gegnerische Bataillone gleichzeitig auf sein
      //     Ursprungsfeld ziehen.
      if (!combatDone) {
        for (const chargerId of combatMovers()) {
          const targetKey = posKeyOf(desired[chargerId]);
          const enemyId = aliveIds.find(id =>
            id !== chargerId && areEnemies(id, chargerId) && !combatResolvedThisTick.has(id) &&
            isStationary(id) && posKeyOf(livePositions[id]) === targetKey
          );
          if (!enemyId) continue;
          const originKey = posKeyOf(livePositions[chargerId]);
          const interceptorIds = aliveIds.filter(id =>
            id !== chargerId && areEnemies(id, chargerId) && !combatResolvedThisTick.has(id) &&
            !blockedUnits.has(id) && !isStationary(id) && posKeyOf(desired[id]) === originKey
          );
          if (!interceptorIds.length) continue; // reiner Angriff auf Stehenden -> (3)
          resolveChargeCombat(chargerId, enemyId, interceptorIds);
          combatDone = true;
          changed = true;
          break;
        }
      }

      // (3) Umkaempftes Zielfeld: Fall 1 (ein stehendes Bataillon + mehrere
      //     gegnerische Angreifer, deckt auch den 1-gegen-1-Angriff auf einen
      //     Stehenden ab) oder Fall 3 (leeres Feld, Bataillone beider Seiten).
      if (!combatDone) {
        const byTarget = {};
        combatMovers().forEach(id => {
          const key = posKeyOf(desired[id]);
          (byTarget[key] = byTarget[key] || []).push(id);
        });
        for (const [key, ids] of Object.entries(byTarget)) {
          const occupantId = aliveIds.find(id =>
            !combatResolvedThisTick.has(id) && isStationary(id) && posKeyOf(livePositions[id]) === key
          );
          if (occupantId) {
            const attackers = ids.filter(id => areEnemies(id, occupantId));
            if (!attackers.length) continue;
            resolveDefenseCombat(occupantId, attackers);
          } else {
            if (new Set(ids.map(id => unitsById[id].role)).size < 2) continue;
            resolveClashCombat(ids);
          }
          combatDone = true;
          changed = true;
          break;
        }
      }
    }

    Object.keys(desired).forEach(unitId => {
      livePositions[unitId] = desired[unitId];
    });

    ticks.push({
      positions: Object.fromEntries(Object.keys(desired).map(id => [id, { ...livePositions[id] }])),
      blockedAttempts,
      combatEvents
    });
  }

  deadUnits.forEach(id => { delete livePositions[id]; });

  return { ticks, finalPositions: livePositions, finalHp: hp };
}

// Baut aus den (server-validierten) Platzierungen beider Spieler die finalen
// Einheiten + Startpositionen + Start-HP (volles Bataillon) fuer die Zugplanungsphase
function buildUnitsAndPositions(room) {
  const units = [];
  const positions = {};
  const hp = {};

  ['blue', 'red'].forEach(role => {
    room.placements[role].forEach((placement, index) => {
      const type = UnitTypes.byKey(placement.typeKey);
      const sameTypeSoFar = room.placements[role]
        .slice(0, index + 1)
        .filter(p => p.typeKey === placement.typeKey).length;

      units.push({
        id: placement.unitId,
        role,
        typeKey: placement.typeKey,
        label: `${type.label} ${sameTypeSoFar}`,
        chipIndex: sameTypeSoFar
      });
      positions[placement.unitId] = { q: placement.q, r: placement.r };
      hp[placement.unitId] = UnitTypes.maxHpFor(placement.typeKey);
    });
  });

  return { units, positions, hp };
}

io.on('connection', (socket) => {
  console.log('Spieler verbunden:', socket.id);

  socket.on('joinRoom', (roomId) => {
    if (!rooms[roomId]) {
      rooms[roomId] = createRoom();
    }
    const room = rooms[roomId];

    let role = null;
    if (!room.sockets.blue) role = 'blue';
    else if (!room.sockets.red) role = 'red';
    else {
      socket.emit('roomFull');
      return;
    }

    room.sockets[role] = socket.id;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = role;

    socket.emit('joined', { role, unitTypes: UnitTypes.TYPES, maxUnitsPerPlayer: UnitTypes.MAX_UNITS_PER_PLAYER });

    console.log(`Spieler ${socket.id} ist Raum ${roomId} als ${role} beigetreten`);

    if (room.sockets.blue && room.sockets.red) {
      io.to(roomId).emit('placementPhaseStart');
    }
  });

  // Ein Spieler platziert die naechste Einheit eines Stapels auf ein Feld
  // seiner eigenen Zone. Reihenfolge in room.placements[role] = Stapel-Reihenfolge,
  // die Instanznummer (chipIndex/label) ergibt sich daraus erst beim Spielstart.
  socket.on('placeUnit', ({ roomId, typeKey, q, r }) => {
    const room = rooms[roomId];
    if (!room) return;
    const role = socket.data.role;
    if (!role) return;

    const check = isValidPlacement(room, role, typeKey, q, r);
    if (!check.ok) {
      socket.emit('placementRejected', { reason: check.reason });
      return;
    }

    const unitId = `${role}_${typeKey}_${countOfType(room.placements[role], typeKey) + 1}`;
    room.placements[role].push({ unitId, typeKey, q, r });
    socket.emit('placementAccepted', { unitId, typeKey, q, r });
  });

  // Nimmt die zuletzt platzierte Einheit einer Art wieder vom Brett (Stapel-Pop).
  // Der Client ruft dies ggf. mehrfach auf, wenn mehrere Einheiten derselben Art
  // rueckgaengig gemacht werden (Klick auf eine nicht-oberste platzierte Einheit).
  socket.on('undoLastPlacement', ({ roomId, typeKey }) => {
    const room = rooms[roomId];
    if (!room) return;
    const role = socket.data.role;
    if (!role) return;
    if (room.phase !== 'placement' || room.ready[role]) return;

    const placements = room.placements[role];
    for (let i = placements.length - 1; i >= 0; i--) {
      if (placements[i].typeKey === typeKey) {
        placements.splice(i, 1);
        return;
      }
    }
  });

  socket.on('placementReady', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const role = socket.data.role;
    if (!role || room.phase !== 'placement') return;

    room.ready[role] = true;

    const otherRole = role === 'blue' ? 'red' : 'blue';
    const otherSocketId = room.sockets[otherRole];
    if (otherSocketId) {
      io.to(otherSocketId).emit('opponentPlacementReady');
    }

    if (room.ready.blue && room.ready.red) {
      room.phase = 'playing';
      const { units, positions, hp } = buildUnitsAndPositions(room);
      room.units = units;
      room.positions = positions;
      room.hp = hp;
      io.to(roomId).emit('gameStart', { units, positions, hp });
    }
  });

  // Bereitschaft der Platzierung zurueckziehen, solange der Gegner noch nicht bereit ist
  socket.on('cancelPlacementReady', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const role = socket.data.role;
    if (!role || room.phase !== 'placement') return;

    room.ready[role] = false;
  });

  // Ein Spieler reicht die Pläne ALLER seiner Einheiten auf einmal ein
  socket.on('submitPlan', ({ roomId, plan }) => {
    const room = rooms[roomId];
    if (!room || room.phase !== 'playing') return;

    const role = socket.data.role;
    if (!role) return;

    // Besiegte (HP <= 0) Bataillone existieren nicht mehr und werden nicht
    // mehr eingeplant.
    const unitsForRole = room.units.filter(u => u.role === role && room.hp[u.id] > 0);
    if (!isValidRolePlan(plan, room.positions, unitsForRole)) {
      socket.emit('planRejected', { reason: 'Ungültiger Zug.' });
      return;
    }

    room.plans[role] = plan;
    socket.emit('planAccepted');

    const otherRole = role === 'blue' ? 'red' : 'blue';
    const otherSocketId = room.sockets[otherRole];
    if (otherSocketId) {
      io.to(otherSocketId).emit('opponentConfirmed');
    }

    if (room.plans.blue && room.plans.red) {
      const combinedPlan = { ...room.plans.blue, ...room.plans.red };
      const { ticks, finalPositions, finalHp } = resolveRound(room, combinedPlan);

      room.positions = finalPositions;
      room.hp = finalHp;
      io.to(roomId).emit('executeRound', { ticks });

      room.plans.blue = null;
      room.plans.red = null;
    }
  });

  // Bestätigung zurückziehen, solange der Gegner noch nicht bestätigt hat
  socket.on('cancelPlan', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const role = socket.data.role;
    if (!role) return;

    room.plans[role] = null;
  });

  socket.on('disconnect', () => {
    console.log('Spieler getrennt:', socket.id);
    const { roomId, role } = socket.data;
    if (roomId && rooms[roomId]) {
      delete rooms[roomId].sockets[role];
      io.to(roomId).emit('playerLeft');
      if (!rooms[roomId].sockets.blue && !rooms[roomId].sockets.red) {
        delete rooms[roomId];
      }
    }
  });
});

// Beim direkten Start (node server.js / Render) lauscht der Server; wird die
// Datei nur require()d (z.B. aus einem Test der reinen Rundenaufloesung),
// bleibt der Port zu und nur die Pure-Functions werden exportiert.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`Server läuft auf Port ${PORT}`);
  });
}

module.exports = { resolveRound, buildUnitsAndPositions };
