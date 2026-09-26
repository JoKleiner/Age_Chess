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

// Baut aus der (ungeprueften) Schuss-Angabe eines Clients die kanonische,
// serverseitig verbindliche Form: { type, launchTick, arrivalTick, cells }.
// - launchTick0 ist 0-basiert (Index des Schuss-Schritts im Schritt-Array).
// - launchPos ist die Schuetzen-Position im Abschuss-Takt (= Feld des Schuss-
//   Schritts, da der Schuetze in diesem Takt stehen bleibt).
// - cells sind ABSOLUTE Felder: beim Weitschuss das eine Zielfeld, beim
//   Nahschuss das Nachbarfeld in der gewaehlten Richtung plus - falls es auf
//   dem Brett liegt - das Feld direkt dahinter.
// Gibt null zurueck, wenn irgendetwas ungueltig ist (der ganze Plan gilt dann
// als ungueltig).
function canonicalShot(rawShot, launchPos, launchTick0, typeKey) {
  if (typeKey !== 'bogenschuetze' || !rawShot || typeof rawShot !== 'object') return null;

  if (rawShot.type === 'far') {
    const cfg = UnitTypes.shotConfig('bogenschuetze', 'far');
    if (!cfg || launchTick0 > cfg.maxLaunchTick - 1) return null;
    const t = rawShot.target;
    if (!t || typeof t.q !== 'number' || typeof t.r !== 'number') return null;
    if (!validCellKeys.has(HexBoard.keyOf(t.q, t.r))) return null;
    const d = HexBoard.hexDistance(launchPos, t);
    if (d < cfg.minRange || d > cfg.maxRange) return null;
    return {
      type: 'far',
      launchTick: launchTick0,
      arrivalTick: launchTick0 + cfg.ticks - 1,
      cells: [{ q: t.q, r: t.r }]
    };
  }

  if (rawShot.type === 'near') {
    const cfg = UnitTypes.shotConfig('bogenschuetze', 'near');
    if (!cfg || launchTick0 > cfg.maxLaunchTick - 1) return null;
    const dir = rawShot.dir;
    if (!dir || !HexBoard.DIRECTIONS.some(D => D.dq === dir.dq && D.dr === dir.dr)) return null;
    const primary = { q: launchPos.q + dir.dq, r: launchPos.r + dir.dr };
    if (!validCellKeys.has(HexBoard.keyOf(primary.q, primary.r))) return null;
    const behind = { q: launchPos.q + 2 * dir.dq, r: launchPos.r + 2 * dir.dr };
    const cells = [primary];
    if (validCellKeys.has(HexBoard.keyOf(behind.q, behind.r))) cells.push(behind);
    return {
      type: 'near',
      launchTick: launchTick0,
      arrivalTick: launchTick0 + cfg.ticks - 1,
      cells
    };
  }

  return null;
}

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
    // facings: null oder { unitId: 0..5 } - Blickrichtung der Einheiten mit
    // Blickrichtung (Reiter). Persistiert wie positions/hp ueber Runden.
    facings: null,
    plans: { blue: null, red: null },
    // Match ueber mehrere Runden (best of 3): wer 2 Runden gewinnt, gewinnt.
    scores: { blue: 0, red: 0 },
    names: { blue: '', red: '' }, // gewaehlter Name, leer = "Spieler Blau/Rot"
    round: 1,
    closing: false               // Match vorbei, Raum schliesst gleich
  };
}

// Erlaubt Buchstaben (inkl. deutscher Umlaute), Ziffern, Leerzeichen und
// gaengige Satzzeichen; insgesamt hoechstens 20 Zeichen.
function sanitizeName(name) {
  if (typeof name !== 'string') return '';
  return name
    .replace(/[^A-Za-z0-9À-ſ .,!?'"()@#&+\-_/:;]/g, '')
    .slice(0, 20)
    .trim();
}

function displayName(room, role) {
  return room.names[role] || (role === 'blue' ? 'Spieler Blau' : 'Spieler Rot');
}

function matchStatePayload(room) {
  return {
    scores: { ...room.scores },
    round: room.round,
    names: { blue: displayName(room, 'blue'), red: displayName(room, 'red') }
  };
}

// Setzt den Raum fuer die naechste Runde zurueck in die Platzierungsphase
// (Scores/Namen bleiben erhalten).
function resetRoomForNextRound(room) {
  room.phase = 'placement';
  room.placements = { blue: [], red: [] };
  room.ready = { blue: false, red: false };
  room.units = null;
  room.positions = null;
  room.hp = null;
  room.facings = null;
  room.plans = { blue: null, red: null };
  room.round += 1;
}

// Standard-Blickrichtung eines frisch platzierten Reiters, falls der Spieler
// keine waehlt: Richtung Gegner (Index in HexBoard.DIRECTIONS - Blau blickt
// nach Norden, Rot nach Sueden; das Brett wird fuer Rot ohnehin gedreht).
function defaultFacingFor(role) {
  return role === 'blue' ? 2 : 5;
}

function sanitizeFacing(value, role) {
  return Number.isInteger(value) && value >= 0 && value < 6
    ? value : defaultFacingFor(role);
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
function isValidUnitSteps(steps, startPos, typeKey, startFacing, enemyIds) {
  if (!Array.isArray(steps) || steps.length > UnitTypes.DEFAULT_MAX_STEPS) return false;

  const hasFacing = UnitTypes.hasFacing(typeKey);
  const canIntercept = UnitTypes.canIntercept(typeKey);
  let previous = startPos;
  let facing = Number.isInteger(startFacing) ? ((startFacing % 6) + 6) % 6 : 0;
  let moveCount = 0;
  let shotCount = 0;
  let sawIntercept = false;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || typeof step.q !== 'number' || typeof step.r !== 'number') return false;
    if (!validCellKeys.has(HexBoard.keyOf(step.q, step.r))) return false;
    const distance = HexBoard.hexDistance(previous, step);
    if (distance > 1) return false; // 0 = bleiben, 1 = bewegen

    if (step.intercept != null) {
      // Abfang-Schritt: nur Schwert/Speerkaempfer, kein Feldwechsel im Plan (das Feld
      // rechnet der Server im Ausfuehrungstakt), Ziel muss eine lebende
      // gegnerische Einheit sein. Zaehlt als eine Bewegung. Danach duerfen nur
      // noch weitere Abfang-Schritte oder "bleiben" folgen (die tatsaechliche
      // Position nach dem Abfangen kennt der Client nicht).
      if (!canIntercept) return false;
      if (distance !== 0) return false;
      if (step.shot != null || step.turn != null) return false;
      if (!enemyIds || !enemyIds.has(step.intercept)) return false;
      sawIntercept = true;
      moveCount++;
      previous = step;
      continue;
    }
    // Nach einem Abfang-Schritt ist kein echter Feldwechsel/Schuss/Dreh mehr
    // planbar (nur "bleiben").
    if (sawIntercept && (distance === 1 || step.shot != null || step.turn != null)) return false;

    if (step.turn != null) {
      // Dreh-Schritt (nur Arten mit Blickrichtung): kein Feldwechsel, kostet
      // aber den ganzen Takt und setzt die Blickrichtung auf einen beliebigen
      // Index 0..5.
      if (!hasFacing) return false;
      if (distance !== 0) return false;
      if (step.shot != null) return false;
      if (!Number.isInteger(step.turn) || step.turn < 0 || step.turn > 5) return false;
      facing = step.turn;
      previous = step;
      continue;
    }

    if (distance === 1) {
      if (hasFacing) {
        // Reiter darf nur in seinen Front-Bogen laufen und blickt danach in
        // die gelaufene Richtung.
        const dir = HexBoard.dirBetween(previous, step);
        if (dir < 0 || !HexBoard.frontArc(facing).includes(dir)) return false;
        facing = dir;
      }
      moveCount++;
    }

    if (step.shot != null) {
      // Ein Bogenschuetzen-Schuss haengt als Zusatz an einem "bleibt"-Schritt
      // (im Abschuss-Takt steht der Schuetze). Geometrie/Takt werden hier
      // mitgeprueft (canonicalShot == null -> ungueltiger Plan).
      if (distance !== 0) return false;
      if (!canonicalShot(step.shot, step, i, typeKey)) return false;
      shotCount++;
    }
    previous = step;
  }
  if (shotCount > 1) return false; // hoechstens 1 Schuss pro Runde
  // Wer schiesst, darf hoechstens 1 Feld laufen; sonst gilt das normale Limit
  // der Art (Reiter 4, sonst 2).
  const moveCap = shotCount > 0 ? 1 : UnitTypes.maxStepsFor(typeKey);
  if (moveCount > moveCap) return false;
  return true;
}

// Prüft den kompletten Plan EINES Spielers (alle seine Einheiten auf einmal)
function isValidRolePlan(planByUnit, positions, unitsForRole, facings = {}, enemyIds = null) {
  if (!planByUnit || typeof planByUnit !== 'object') return false;

  const providedIds = Object.keys(planByUnit);
  if (providedIds.length !== unitsForRole.length) return false;

  for (const unit of unitsForRole) {
    if (!(unit.id in planByUnit)) return false;
    if (!isValidUnitSteps(planByUnit[unit.id], positions[unit.id], unit.typeKey, facings[unit.id], enemyIds)) return false;
  }
  return true;
}

// Wie isValidRolePlan, liefert aber die erste fehlerhafte Einheit (fuer eine
// verstaendliche Fehlermeldung) - null, wenn alles gueltig ist.
function findInvalidRolePlanUnit(planByUnit, positions, unitsForRole, facings = {}, enemyIds = null) {
  if (!planByUnit || typeof planByUnit !== 'object') return { label: null };
  for (const unit of unitsForRole) {
    if (!(unit.id in planByUnit) ||
        !isValidUnitSteps(planByUnit[unit.id], positions[unit.id], unit.typeKey, facings[unit.id], enemyIds)) {
      return unit;
    }
  }
  return { label: null }; // z.B. Einheiten zu viel/zu wenig im Plan
}

function posKeyOf(pos) {
  return HexBoard.keyOf(pos.q, pos.r);
}

function samePos(a, b) {
  return a.q === b.q && a.r === b.r;
}

// Zielfeld eines Abfang-Schritts: von `from` (aktuelle Position des Abfaengers)
// aus das Nachbarfeld - oder Stehenbleiben - mit der kleinsten Hex-Distanz zu
// einem der `aims` (der Reihe nach versucht: zuerst das Feld, auf das die
// Zieleinheit in diesem Takt zieht; danach - falls dort ALLE gleich nahen
// Felder von einem Verbuendeten belegt/beansprucht sind und es keine gleich
// nahe freie Alternative gibt - das AKTUELLE Feld der Zieleinheit als
// Ausweich-Ziel. So laeuft der Abfaenger nicht sinnlos in einen belegten
// eigenen Kollegen (und wird dort vom Doppelbelegungs-Sicherheitsnetz nur
// wirkungslos zurueckgeschickt), sondern greift die Zieleinheit stattdessen
// an ihrem Ursprungsfeld an. Bei mehreren gleich kurzen freien Feldern
// entscheidet der kleinste Richtungsindex (deterministisch). Bleiben wirklich
// ALLE versuchten Ziele durchgehend belegt, wird das beste Feld des LETZTEN
// Versuchs genommen (bestmoeglicher Kompromiss statt gar keiner Bewegung).
function computeInterceptCell(unitId, from, aims, desired, livePositions, unitsById, fightCell = null) {
  const role = unitsById[unitId].role;
  const options = [{ q: from.q, r: from.r }]; // Stehenbleiben ist erlaubt
  HexBoard.DIRECTIONS.forEach(d => {
    const c = { q: from.q + d.dq, r: from.r + d.dr };
    if (validCellKeys.has(HexBoard.keyOf(c.q, c.r))) options.push(c);
  });

  // `fightCell`: Feld, auf das die Zieleinheit diesen Takt zieht. Will dort
  // auch ein Verbuendeter HIN (nicht: steht dort), gibt es auf diesem Feld
  // ohnehin einen Kampf gegen das Ziel - der Abfaenger zieht dann mit dorthin
  // und kaempft mit, statt auszuweichen.
  const allyClaims = (c) => Object.keys(desired).some(other => {
    if (other === unitId) return false;
    if (unitsById[other].role !== role) return false;
    if (samePos(livePositions[other], c)) return true;
    if (!samePos(desired[other], c)) return false;
    return !(fightCell && samePos(c, fightCell));
  });

  const bestCellsFor = (aim) => {
    let bestDist = Infinity;
    options.forEach(c => {
      const dist = HexBoard.hexDistance(c, aim);
      if (dist < bestDist) bestDist = dist;
    });
    return options.filter(c => HexBoard.hexDistance(c, aim) === bestDist);
  };

  const pickClosestDir = (cells) => cells.slice().sort((a, b) => {
    const ia = HexBoard.dirBetween(from, a); // -1 fuer Stehenbleiben -> zuerst
    const ib = HexBoard.dirBetween(from, b);
    return ia - ib;
  })[0];

  let lastBest = null;
  for (const aim of aims) {
    const best = bestCellsFor(aim);
    lastBest = best;
    const free = best.filter(c => !allyClaims(c));
    if (free.length > 0) return pickClosestDir(free);
  }
  const fallback = pickClosestDir(lastBest);
  return { q: fallback.q, r: fallback.r };
}

// Bei einem umkaempften Feld gewinnt die Einheit mit dem hoeheren speedRank
// (Reiter > Schwert > Speerkaempfer > Schuetze); bei gleicher Art gewinnt der
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

  const livePositions = {};
  Object.keys(combinedPlan).forEach(id => { livePositions[id] = { ...room.positions[id] }; });

  // Blickrichtung je Einheit durch die Runde mitfuehren: aendert sich, wenn die
  // Einheit laeuft (neue Richtung = gelaufene Richtung) oder einen Dreh-Schritt
  // ausfuehrt. Wird pro Takt an den Client geschickt (Dreieck-Marker).
  const liveFacing = {};
  Object.keys(combinedPlan).forEach(id => {
    if (!UnitTypes.hasFacing(unitsById[id].typeKey)) return;
    liveFacing[id] = (room.facings && room.facings[id] != null) ? room.facings[id] : 0;
  });

  const hp = { ...room.hp };
  const blockedUnits = new Set();
  // Bataillone, die in dieser Runde schon in einem KAMPF waren (persistiert
  // ueber Takte). Ein Bogenschuetze, der gekaempft hat, feuert danach nicht
  // mehr ab; im Abschuss-Takt selbst wird aber "zuerst gefeuert, dann
  // gekaempft" (der Abschuss laeuft im Takt-Kopf vor jeder Kampf-Aufloesung).
  const foughtUnits = new Set();
  const deadUnits = new Set(Object.keys(hp).filter(id => hp[id] <= 0));
  const ticks = [];

  // Bogenschuetzen-Schuesse aus den Plaenen ziehen (hoechstens einer pro
  // Einheit). type / Takte / cells stehen bereits fest - cells sind absolute
  // Felder, unabhaengig davon, wo der Schuetze im Abschuss-Takt am Ende
  // wirklich steht.
  const pendingShots = [];
  Object.keys(combinedPlan).forEach(unitId => {
    const steps = combinedPlan[unitId];
    for (let i = 0; i < steps.length; i++) {
      if (steps[i] && steps[i].shot != null) {
        const canon = canonicalShot(steps[i].shot, steps[i], i, unitsById[unitId].typeKey);
        if (canon) {
          pendingShots.push({
            unitId, fired: false, resolved: false, cancelled: false,
            livingAtLaunch: 0, raw: steps[i].shot, ...canon
          });
        }
        break;
      }
    }
  });

  // Der Rundenhorizont muss lang genug sein, dass jeder Pfeil noch ankommt -
  // auch wenn der Schuetze selbst nur 2 Takte plant.
  let totalTicks = Math.max(0, ...Object.values(combinedPlan).map(s => s.length));
  pendingShots.forEach(s => { totalTicks = Math.max(totalTicks, s.arrivalTick + 1); });

  // Per-Takt-Zustand - wird zu Beginn jedes Takts neu gesetzt und von den
  // Kampf-Closures unten ueber den Closure-Verweis gelesen/geschrieben.
  let desired = {};
  let combatEvents = [];
  let combatResolvedThisTick = new Set();
  let arrowEvents = [];

  const livingOf = (id) => UnitTypes.livingUnitsFor(unitsById[id].typeKey, hp[id]);
  const areEnemies = (a, b) => unitsById[a].role !== unitsById[b].role;

  // Nach einem Kampf verfallen fuer alle Beteiligten die restlichen Zuege
  // dieser Runde (blockedUnits) und sie werden diesen Takt nicht noch einmal
  // in einen Kampf gezogen (combatResolvedThisTick).
  const markFought = (ids) => ids.forEach(id => {
    combatResolvedThisTick.add(id);
    blockedUnits.add(id);
    foughtUnits.add(id);
  });

  // Baut ein Kampf-Ereignis fuer die Client-Animation. `partById` liefert pro
  // Teilnehmer { from, attempt, hpAfter, defeated }. In der Animation ruecken
  // alle Teilnehmer erst ein Viertel Richtung `attempt` vor; danach zieht
  // `moverId` auf sein `attempt`-Feld nach, alle anderen weichen auf ihr
  // `from`-Feld zurueck, besiegte werden entfernt.
  const buildCombatEvent = (cells, ids, partById, moverId, arrowImpact = null) => {
    combatEvents.push({
      cells: cells.map(c => ({ q: c.q, r: c.r })),
      moverId: moverId || null,
      arrowImpact,
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
  // teilt seinen vollen Schaden aus. Sinkt der Verteidiger auf 0 HP, rueckt der
  // Angreifer mit dem meisten an ihm verursachten Schaden auf das Feld nach.
  //
  // interceptorsByAttacker (optional): { angreiferId: [verbuendeteDesVerteidigers, ...] }
  // - Verbuendete des Verteidigers, die im selben Takt auf das URSPRUNGSFELD
  //   eines Angreifers ziehen und diesen damit angreifen. Sie teilen ihren
  //   vollen Schaden ZUSAETZLICH zum Verteidiger-Anteil auf diesen einen
  //   Angreifer aus und bekommen KEINEN Gegenschaden (der Angreifer verbraucht
  //   seinen Schlag am Verteidiger). Alles gleichzeitig aus den Vor-Kampf-
  //   Werten - erst DANACH wird entschieden, wer wohin nachrueckt: Stirbt der
  //   Angreifer, rueckt der staerkste ueberlebende Interceptor auf dessen frei
  //   gewordenes Ursprungsfeld nach; ueberlebt der Angreifer (auch wenn er
  //   selbst siegreich vorrueckt), bleibt sein Feld leer und die Interceptor
  //   haben nur gekaempft (Rest-Zug verwirkt).
  const resolveDefenseCombat = (defenderId, attackerIds, interceptorsByAttacker = {}) => {
    const dType = unitsById[defenderId].typeKey;
    const dCell = { ...livePositions[defenderId] };
    const share = attackShare(livingOf(defenderId), attackerIds.length);

    const interceptorsOf = (aid) => interceptorsByAttacker[aid] || [];
    const allInterceptors = [];
    attackerIds.forEach(aid => interceptorsOf(aid).forEach(iid => allInterceptors.push(iid)));

    const dmgToDefender = {};
    const dmgToAttacker = {};
    const dmgByInterceptor = {}; // interceptorId -> Schaden am angegriffenen Angreifer
    attackerIds.forEach(id => {
      dmgToDefender[id] = livingOf(id) * UnitTypes.damageOf(unitsById[id].typeKey, dType);
      dmgToAttacker[id] = share * UnitTypes.damageOf(dType, unitsById[id].typeKey);
      interceptorsOf(id).forEach(iid => {
        dmgByInterceptor[iid] = livingOf(iid) * UnitTypes.damageOf(unitsById[iid].typeKey, unitsById[id].typeKey);
        dmgToAttacker[id] += dmgByInterceptor[iid];
      });
    });

    const totalToDefender = attackerIds.reduce((s, id) => s + dmgToDefender[id], 0);
    hp[defenderId] = Math.max(0, hp[defenderId] - totalToDefender);
    attackerIds.forEach(id => { hp[id] = Math.max(0, hp[id] - dmgToAttacker[id]); });
    // Interceptor bekommen keinen Gegenschaden.

    const defenderDefeated = hp[defenderId] <= 0;
    let moverId = defenderDefeated
      ? pickAdvancer(attackerIds.filter(id => hp[id] > 0), dmgToDefender, unitsById)
      : null;

    // Nahschuss-Sonderfall: vernichtet der Angreifer aus der Schuss-Richtung
    // (primary-Feld) den Schuetzen und wuerde auf dessen Feld nachruecken,
    // schlaegt der Pfeil JETZT - noch VOR dem Nachruecken, in diesem selben
    // Takt - bei ihm ein, statt erst im eigentlich geplanten Einschlag-Takt.
    // Kommt der Nachruecker stattdessen aus dem behind-Feld oder von woanders,
    // bleibt es beim normalen (spaeteren) Einschlag. Stirbt der primary-
    // Angreifer durch den Pfeil, rueckt niemand auf das Schuetzen-Feld nach.
    // Fuer die Anzeige: der Pfeil trifft im Kampf-Ereignis NACH dem
    // Verschwinden des Schuetzen (siehe arrowImpact), deshalb zeigt das
    // Kampf-Ereignis beim Getroffenen die HP VOR dem Pfeil.
    let arrowImpact = null;
    if (defenderDefeated && moverId) {
      const shot = pendingShots.find(s =>
        s.unitId === defenderId && s.type === 'near' && s.fired && !s.cancelled && !s.resolved
      );
      if (shot && samePos(livePositions[moverId], shot.cells[0])) {
        shot.resolved = true;
        const hitUnitId = moverId;
        const hpBeforeArrow = hp[hitUnitId];
        const dmg = shot.livingAtLaunch * UnitTypes.rangedDamageOf('bogenschuetze', unitsById[hitUnitId].typeKey);
        hp[hitUnitId] = Math.max(0, hp[hitUnitId] - dmg);
        const defeated = hp[hitUnitId] <= 0;
        if (defeated) moverId = null;
        // Pfeil ist jetzt verbraucht - Einschlag-Ereignis SOFORT senden, damit
        // der Pfeil beim Klienten in diesem Takt verschwindet, statt bis zum
        // eigentlich geplanten (jetzt hinfaelligen) Einschlag-Takt weiterzufliegen.
        // `deferred`: der Client zeigt diesen Einschlag NICHT am Takt-Anfang,
        // sondern innerhalb des Kampf-Ereignisses (arrowImpact).
        arrowEvents.push({
          id: shot.unitId + '#' + shot.launchTick,
          kind: 'impact',
          deferred: true,
          shotType: shot.type,
          cells: shot.cells.map(c => ({ q: c.q, r: c.r })),
          impactCell: { ...dCell },
          hits: [{ unitId: hitUnitId, hpAfter: hp[hitUnitId], defeated }]
        });
        arrowImpact = {
          arrowId: shot.unitId + '#' + shot.launchTick,
          unitId: hitUnitId, hpBefore: hpBeforeArrow, hpAfter: hp[hitUnitId], defeated
        };
      }
    }

    desired[defenderId] = { ...dCell };
    attackerIds.forEach(id => {
      desired[id] = id === moverId ? { ...dCell } : { ...livePositions[id] };
    });

    // Interceptor: nur wenn "ihr" Angreifer faellt, rueckt der staerkste
    // ueberlebende von ihnen auf dessen Ursprungsfeld nach - sonst bleiben sie
    // stehen.
    const interceptorMover = {}; // angreiferId -> nachrueckender interceptorId
    attackerIds.forEach(aid => {
      const list = interceptorsOf(aid);
      if (!list.length) return;
      const advancer = hp[aid] <= 0
        ? pickAdvancer(list.filter(id => hp[id] > 0), dmgByInterceptor, unitsById)
        : null;
      const originCell = { ...livePositions[aid] };
      list.forEach(id => {
        desired[id] = id === advancer ? { ...originCell } : { ...livePositions[id] };
      });
      if (advancer) interceptorMover[aid] = advancer;
    });

    markFought([defenderId, ...attackerIds, ...allInterceptors]);
    if (defenderDefeated) deadUnits.add(defenderId);
    attackerIds.forEach(id => { if (hp[id] <= 0) deadUnits.add(id); });

    // Ereignis fuer das Verteidiger-Feld. Angreifer MIT Interceptor werden
    // hier noch als nicht besiegt gefuehrt - ihr Ausscheiden zeigt das
    // jeweilige Interceptor-Ereignis unten.
    const mainPart = {
      [defenderId]: { from: dCell, attempt: dCell, hpAfter: hp[defenderId], defeated: defenderDefeated }
    };
    attackerIds.forEach(id => {
      const hasIntercept = interceptorsOf(id).length > 0;
      const arrowHit = arrowImpact && arrowImpact.unitId === id;
      mainPart[id] = {
        from: { ...livePositions[id] }, attempt: dCell,
        hpAfter: arrowHit ? arrowImpact.hpBefore : hp[id],
        defeated: (hasIntercept || arrowHit) ? false : hp[id] <= 0
      };
    });
    buildCombatEvent([dCell], [defenderId, ...attackerIds], mainPart, moverId, arrowImpact);

    // Je ein Ereignis pro Angreifer-Ursprungsfeld mit Interceptor - IMMER,
    // auch wenn der Angreifer ueberlebt und selbst siegreich vorrueckt: sonst
    // haetten die Interceptor unsichtbar gekaempft (Zug + evtl. spaeterer
    // Schuss verfallen ohne Anzeige). Der Client laesst einen Sieger eines
    // anderen Ereignisses dabei nicht zurueckweichen.
    attackerIds.forEach(aid => {
      const list = interceptorsOf(aid);
      if (!list.length) return;
      const advancer = interceptorMover[aid] || null;
      const originCell = { ...livePositions[aid] };
      const part = {
        [aid]: { from: originCell, attempt: dCell, hpAfter: hp[aid], defeated: hp[aid] <= 0 }
      };
      list.forEach(id => {
        part[id] = { from: { ...livePositions[id] }, attempt: originCell, hpAfter: hp[id], defeated: false };
      });
      buildCombatEvent([originCell], [aid, ...list], part, advancer);
    });
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
  //
  // interceptorsByMover (optional): { moverId: [gegnerBataillone, ...] } - wie
  // bei resolveDefenseCombat. Bataillone, die im selben Takt auf das
  // Ursprungsfeld eines Clash-Teilnehmers ziehen, greifen diesen dort an
  // (voller Schaden zusaetzlich, kein Gegenschaden). KEIN Fliehen: das trifft
  // den Teilnehmer auch dann, wenn er den Clash gewinnt und auf das leere Feld
  // vorrueckt. Der Interceptor-Schaden zaehlt NICHT zum Seiten-Gesamtschaden
  // fuers Feld. Stirbt der Teilnehmer, rueckt der staerkste ueberlebende
  // Interceptor auf dessen Ursprungsfeld nach; ueberlebt er, bleibt es leer.
  const resolveClashCombat = (moverIds, interceptorsByMover = {}) => {
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

    // Interceptor-Schaden auf "ihren" Clash-Teilnehmer drauf (kein Gegenschaden).
    const interceptorsOfMover = (mid) => interceptorsByMover[mid] || [];
    const allInterceptors = [];
    const dmgByInterceptor = {};
    moverIds.forEach(mid => {
      interceptorsOfMover(mid).forEach(iid => {
        allInterceptors.push(iid);
        dmgByInterceptor[iid] = livingOf(iid) * UnitTypes.damageOf(unitsById[iid].typeKey, unitsById[mid].typeKey);
        incoming[mid] += dmgByInterceptor[iid];
      });
    });

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

    // Interceptor ruecken nur nach, wenn "ihr" Clash-Teilnehmer faellt.
    const interceptorMover = {};
    moverIds.forEach(mid => {
      const list = interceptorsOfMover(mid);
      if (!list.length) return;
      const advancer = hp[mid] <= 0
        ? pickAdvancer(list.filter(id => hp[id] > 0), dmgByInterceptor, unitsById)
        : null;
      const originCell = { ...livePositions[mid] };
      list.forEach(id => {
        desired[id] = id === advancer ? { ...originCell } : { ...livePositions[id] };
      });
      if (advancer) interceptorMover[mid] = advancer;
    });

    markFought([...moverIds, ...allInterceptors]);

    const mainPart = {};
    moverIds.forEach(id => {
      const hasIntercept = interceptorsOfMover(id).length > 0;
      mainPart[id] = {
        from: { ...livePositions[id] }, attempt: target, hpAfter: hp[id],
        defeated: hasIntercept ? false : hp[id] <= 0
      };
    });
    buildCombatEvent([target], moverIds, mainPart, moverId);

    // Je ein Ereignis pro Clash-Teilnehmer-Ursprungsfeld mit Interceptor -
    // IMMER (siehe resolveDefenseCombat).
    moverIds.forEach(mid => {
      const list = interceptorsOfMover(mid);
      if (!list.length) return;
      const advancer = interceptorMover[mid] || null;
      const originCell = { ...livePositions[mid] };
      const part = {
        [mid]: { from: originCell, attempt: target, hpAfter: hp[mid], defeated: hp[mid] <= 0 }
      };
      list.forEach(id => {
        part[id] = { from: { ...livePositions[id] }, attempt: originCell, hpAfter: hp[id], defeated: false };
      });
      buildCombatEvent([originCell], [mid, ...list], part, advancer);
    });
  };

  // Zwei gegnerische Bataillone wollen im selben Takt die Plaetze tauschen
  // (aneinander vorbeilaufen). Beide teilen sich gegenseitig ihren VOLLEN
  // Schaden zu. Standard: beide bleiben stehen; nur wenn GENAU eines besiegt
  // wird, rueckt das ueberlebende auf das frei gewordene Feld.
  //
  // interceptorsById (optional): { id1: [...], id2: [...] } - gegnerische
  // Bataillone, die im selben Takt auf das Ursprungsfeld von id1 bzw. id2
  // ziehen und dieses dort ZUSAETZLICH angreifen (voller Schaden, KEIN
  // Gegenschaden - der Tauschende verbraucht seinen Schlag am Tausch-Gegner).
  // Alles gleichzeitig aus den Vor-Kampf-Werten; erst DANACH wird nachgerueckt.
  // Ein Ursprungsfeld wird nur frei, wenn seine Figur faellt; es geht dann an
  // den Anruecker mit dem meisten an dieser Figur verursachten Schaden (erst
  // bei Gleichstand: hoeherer speedRank, dann kleinerer chipIndex). Tausch-
  // Partner und Interceptor der gefallenen Figur sind dabei gleichrangig - der
  // Tausch-Partner hat KEINEN Vorrang.
  const resolveSwapCombat = (id1, id2, interceptorsById = {}) => {
    const t1 = unitsById[id1].typeKey;
    const t2 = unitsById[id2].typeKey;
    const cell1 = { ...livePositions[id1] };
    const cell2 = { ...livePositions[id2] };

    const interceptorsOfSwapper = (id) => interceptorsById[id] || [];
    const allInterceptors = [...interceptorsOfSwapper(id1), ...interceptorsOfSwapper(id2)];

    const dmg1to2 = livingOf(id1) * UnitTypes.damageOf(t1, t2);
    const dmg2to1 = livingOf(id2) * UnitTypes.damageOf(t2, t1);

    const dmgByInterceptor = {}; // interceptorId -> Schaden am angegriffenen Tauschenden
    const interceptDmgTo = { [id1]: 0, [id2]: 0 };
    [id1, id2].forEach(mid => {
      interceptorsOfSwapper(mid).forEach(iid => {
        dmgByInterceptor[iid] = livingOf(iid) * UnitTypes.damageOf(unitsById[iid].typeKey, unitsById[mid].typeKey);
        interceptDmgTo[mid] += dmgByInterceptor[iid];
      });
    });

    hp[id1] = Math.max(0, hp[id1] - dmg2to1 - interceptDmgTo[id1]);
    hp[id2] = Math.max(0, hp[id2] - dmg1to2 - interceptDmgTo[id2]);
    // Interceptor bekommen keinen Gegenschaden.
    const def1 = hp[id1] <= 0;
    const def2 = hp[id2] <= 0;

    if (def1) deadUnits.add(id1);
    if (def2) deadUnits.add(id2);

    // Nachruecken. Ein Ursprungsfeld wird NUR frei, wenn seine Figur faellt.
    // Es geht dann an den Anruecker mit dem meisten an dieser gefallenen Figur
    // verursachten Schaden; erst bei Gleichstand entscheidet der hoehere
    // speedRank ("schneller"), dann der kleinere chipIndex. Gleichrangige
    // Kandidaten sind der ueberlebende Tausch-Partner UND die ueberlebenden
    // Interceptor dieser Figur - der Tausch-Partner hat KEINEN Vorrang.
    const advanceInto = {}; // unitId -> Zielzelle
    [
      { deadId: id1, otherId: id2, originCell: cell1, swapDmg: dmg2to1 },
      { deadId: id2, otherId: id1, originCell: cell2, swapDmg: dmg1to2 }
    ].forEach(({ deadId, otherId, originCell, swapDmg }) => {
      if (hp[deadId] > 0) return; // lebt noch -> Feld bleibt besetzt
      const dmgToDead = {};
      const contenders = [];
      if (hp[otherId] > 0) { contenders.push(otherId); dmgToDead[otherId] = swapDmg; }
      interceptorsOfSwapper(deadId).forEach(iid => {
        if (hp[iid] > 0) { contenders.push(iid); dmgToDead[iid] = dmgByInterceptor[iid]; }
      });
      const winner = pickAdvancer(contenders, dmgToDead, unitsById);
      if (winner) advanceInto[winner] = { ...originCell };
    });

    const finalCell = (id, home) => advanceInto[id] ? { ...advanceInto[id] } : { ...home };
    desired[id1] = finalCell(id1, cell1);
    desired[id2] = finalCell(id2, cell2);
    allInterceptors.forEach(iid => { desired[iid] = finalCell(iid, livePositions[iid]); });

    markFought([id1, id2, ...allInterceptors]);

    // Rueckt einer der beiden Tauschenden (nach Schaden) auf das gegnerische
    // Tausch-Feld vor, ist er der "moverId" der Haupt-Animation.
    const swapMover = advanceInto[id1] ? id1 : advanceInto[id2] ? id2 : null;

    // Hauptereignis (Tausch-Feld <-> Tausch-Feld). Tauschende MIT Interceptor
    // werden hier noch als nicht besiegt gefuehrt - ihr Ausscheiden zeigt das
    // jeweilige Interceptor-Ereignis unten.
    const mainPart = {};
    [[id1, cell1, cell2], [id2, cell2, cell1]].forEach(([id, from, attempt]) => {
      const hasIntercept = interceptorsOfSwapper(id).length > 0;
      mainPart[id] = {
        from, attempt, hpAfter: hp[id],
        defeated: hasIntercept ? false : hp[id] <= 0
      };
    });
    buildCombatEvent([cell1, cell2], [id1, id2], mainPart, swapMover);

    // Je ein Ereignis pro Ursprungsfeld mit Interceptor - IMMER (siehe
    // resolveDefenseCombat).
    [[id1, cell1, cell2], [id2, cell2, cell1]].forEach(([mid, originCell, attempt]) => {
      const list = interceptorsOfSwapper(mid);
      if (!list.length) return;
      const advancer = list.find(id => advanceInto[id]) || null;
      const part = {
        [mid]: { from: originCell, attempt, hpAfter: hp[mid], defeated: hp[mid] <= 0 }
      };
      list.forEach(id => {
        part[id] = { from: { ...livePositions[id] }, attempt: originCell, hpAfter: hp[id], defeated: false };
      });
      buildCombatEvent([originCell], [mid, ...list], part, advancer);
    });
  };

  // Geplante Aktionen, die NICHT stattfinden (mit Grund) - pro Takt an den
  // Client, damit nichts stillschweigend verschwindet. Restzug-Verfall wird
  // pro Einheit nur einmal gemeldet.
  let skippedActions = [];
  const reportedDropped = new Set();

  for (let tick = 0; tick < totalTicks; tick++) {
    arrowEvents = [];
    skippedActions = [];

    // --- Bogenschuetzen-Schuesse: Abschuesse dieses Takts ---
    // "Zuerst gefeuert, dann angegriffen": der Schaden wird JETZT - vor jeder
    // Kampf-Aufloesung dieses Takts - aus den aktuell lebenden Schuetzen-
    // Einheiten eingefroren. Verfall, wenn der Schuetze in einem FRUEHEREN
    // Takt gekaempft hat oder nicht mehr existiert.
    pendingShots.forEach(shot => {
      if (shot.fired || shot.cancelled || shot.launchTick !== tick) return;
      shot.fired = true;
      if (deadUnits.has(shot.unitId)) { shot.cancelled = true; return; }
      if (foughtUnits.has(shot.unitId)) {
        shot.cancelled = true;
        skippedActions.push({ unitId: shot.unitId, kind: 'shot', reason: 'fought' });
        return;
      }
      shot.livingAtLaunch = UnitTypes.livingUnitsFor(unitsById[shot.unitId].typeKey, hp[shot.unitId]);
      if (shot.livingAtLaunch <= 0) { shot.cancelled = true; return; }
      // Der Schuetze steht evtl. nicht dort, wo er den Schuss geplant hat
      // (z.B. vorher blockiert): Nahschuss-Richtung von der TATSAECHLICHEN
      // Position aus anwenden; beim Weitschuss bleibt das gewaehlte Zielfeld,
      // sofern es von hier aus noch in Reichweite ist (sonst das Original).
      const actual = canonicalShot(shot.raw, livePositions[shot.unitId], shot.launchTick, unitsById[shot.unitId].typeKey);
      if (actual) shot.cells = actual.cells;
      arrowEvents.push({
        id: shot.unitId + '#' + shot.launchTick,
        kind: 'launch',
        shotType: shot.type,
        from: { ...livePositions[shot.unitId] },
        cells: shot.cells.map(c => ({ q: c.q, r: c.r })),
        launchTick: shot.launchTick,
        arrivalTick: shot.arrivalTick
      });
    });

    // --- Bogenschuetzen-Schuesse: Einschlaege dieses Takts ---
    // Schaden VOR Bewegungen/Nahkampf. Getroffen wird, wer JETZT (Stand Ende
    // Vor-Takt) auf dem Feld steht - auch wenn er diesen Takt wegziehen wollte;
    // wer diesen Takt erst hinzieht, wird nicht getroffen. Nahschuss: das
    // erste besetzte Feld der Linie faengt den vollen Schaden, dahinter kommt
    // nichts mehr an. Sinkt ein Bataillon auf 0 HP, ist es sofort raus (das
    // Feld ist damit fuer die Bewegungen dieses Takts frei).
    pendingShots.forEach(shot => {
      if (shot.cancelled || shot.resolved || shot.arrivalTick !== tick) return;
      shot.resolved = true;
      const hits = [];
      let impactCell = null;
      for (const cell of shot.cells) {
        const key = HexBoard.keyOf(cell.q, cell.r);
        const victim = room.units.find(u => !deadUnits.has(u.id) && posKeyOf(livePositions[u.id]) === key);
        if (!victim) continue;
        impactCell = { q: cell.q, r: cell.r };
        const dmg = shot.livingAtLaunch * UnitTypes.rangedDamageOf('bogenschuetze', victim.typeKey);
        hp[victim.id] = Math.max(0, hp[victim.id] - dmg);
        const defeated = hp[victim.id] <= 0;
        if (defeated) deadUnits.add(victim.id);
        hits.push({ unitId: victim.id, hpAfter: hp[victim.id], defeated });
        break;
      }
      arrowEvents.push({
        id: shot.unitId + '#' + shot.launchTick,
        kind: 'impact',
        shotType: shot.type,
        cells: shot.cells.map(c => ({ q: c.q, r: c.r })),
        impactCell,
        hits
      });
    });

    desired = {};
    // Abfang-Schritte dieses Takts sammeln und ERST NACH allen anderen
    // aufloesen: sie laufen auf das Feld zu, auf das ihre Zieleinheit in diesem
    // Takt zieht (desired des Ziels).
    const interceptStepsThisTick = [];
    Object.keys(combinedPlan).forEach(unitId => {
      if (deadUnits.has(unitId)) return; // existiert nicht mehr
      if (blockedUnits.has(unitId)) {
        desired[unitId] = { ...livePositions[unitId] };
        const dropped = combinedPlan[unitId][tick];
        // Schuss-Schritte zaehlen nicht: der Schuss selbst feuert trotzdem
        // (eigene Verfalls-Meldung oben, falls nicht).
        const isAction = dropped && dropped.shot == null && (dropped.intercept != null ||
          dropped.turn != null || !samePos(dropped, livePositions[unitId]));
        if (isAction && !reportedDropped.has(unitId)) {
          reportedDropped.add(unitId);
          skippedActions.push({
            unitId, kind: 'rest',
            reason: foughtUnits.has(unitId) ? 'fought' : 'blocked'
          });
        }
        return;
      }
      const step = combinedPlan[unitId][tick];
      if (step && step.intercept != null) {
        interceptStepsThisTick.push({ unitId, targetId: step.intercept });
        desired[unitId] = { ...livePositions[unitId] }; // vorlaeufig stehen
        return;
      }
      // Schritte sind im Plan absolute Felder, gemeint ist aber "bleiben" bzw.
      // "ein Feld in Richtung X" - relativ zum vorigen geplanten Feld auf die
      // TATSAECHLICHE Position anwenden. Sonst wuerde eine Einheit, die nach
      // einem Abfang-Schritt woanders steht als geplant, beim folgenden
      // "bleiben"-Schritt auf ihr altes Planfeld zurueckspringen.
      if (!step) {
        desired[unitId] = { ...livePositions[unitId] };
        return;
      }
      const prevPlanned = tick > 0 && combinedPlan[unitId][tick - 1]
        ? combinedPlan[unitId][tick - 1]
        : room.positions[unitId];
      const next = {
        q: livePositions[unitId].q + (step.q - prevPlanned.q),
        r: livePositions[unitId].r + (step.r - prevPlanned.r)
      };
      desired[unitId] = validCellKeys.has(HexBoard.keyOf(next.q, next.r))
        ? next
        : { ...livePositions[unitId] };
    });

    // Determinstische Reihenfolge, damit der Verbuendeten-Tie-Break (ein
    // frueher aufgeloester Abfaenger belegt schon ein Feld) reproduzierbar ist.
    interceptStepsThisTick.sort((a, b) => (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0));
    const interceptorIds = [];
    interceptStepsThisTick.forEach(({ unitId, targetId }) => {
      const targetAlive = !deadUnits.has(targetId)
        && livePositions[targetId] && hp[targetId] > 0;
      if (!targetAlive) {
        desired[unitId] = { ...livePositions[unitId] }; // Ziel weg -> stehen bleiben
        skippedActions.push({ unitId, kind: 'intercept', reason: 'targetGone' });
        return;
      }
      // Zuerst dorthin, wo die Zieleinheit diesen Takt hinzieht; steht dort
      // (nur) ein Verbuendeter im Weg, ersatzweise ans aktuelle Feld der
      // Zieleinheit - dort greift der Abfaenger sie stattdessen an, statt
      // sinnlos gegen die eigene Kollegen-Blockade zu laufen.
      const primaryAim = desired[targetId] || livePositions[targetId];
      const aims = [primaryAim];
      if (livePositions[targetId] && !samePos(livePositions[targetId], primaryAim)) {
        aims.push(livePositions[targetId]);
      }
      // Zieht das Ziel wirklich um, ist sein Zielfeld ein Kampf-Feld.
      const fightCell = desired[targetId] && !samePos(desired[targetId], livePositions[targetId])
        ? desired[targetId]
        : null;
      desired[unitId] = computeInterceptCell(unitId, livePositions[unitId], aims, desired, livePositions, unitsById, fightCell);
      interceptorIds.push(unitId);
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
          // Ein noch handlungsfaehiges gegnerisches Bataillon, das AKTUELL auf
          // `key` steht, macht das Feld umkaempft - auch wenn es diesen Takt
          // wegzieht: sein Wegzug kann in einem Kampf (Platztausch/Interceptor)
          // steckenbleiben. Sonst wuerde die gleichseitige "nur der Schnellste
          // rueckt nach"-Regel unten einen Angreifer/Interceptor zurueck-
          // schicken, bevor der Kampf ueberhaupt aufgeloest ist.
          if (!blockedUnits.has(u.id) && posKeyOf(livePositions[u.id]) === key) {
            roles.add(u.role);
          }
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

      // "Interceptor" von unitId: gegnerische Bataillone, die im selben Takt
      // auf DAS URSPRUNGSFELD von unitId ziehen und es damit dort angreifen,
      // waehrend unitId selbst in einen Kampf verwickelt ist. Kein Fliehen:
      // dieser Angriff trifft unitId immer (auch wenn unitId seinen eigenen
      // Kampf gewinnt und wegzieht). `exclude` haelt die schon als
      // Kern-Kaempfer erfassten Bataillone heraus.
      const interceptorsOf = (unitId, exclude) => {
        const originKey = posKeyOf(livePositions[unitId]);
        return aliveIds.filter(id =>
          id !== unitId && !exclude.has(id) && areEnemies(id, unitId) &&
          !combatResolvedThisTick.has(id) && !blockedUnits.has(id) &&
          !isStationary(id) && posKeyOf(desired[id]) === originKey
        );
      };

      // (1) Platztausch zweier gegnerischer Bataillone - inkl. dem Sonderfall,
      //     dass gleichzeitig Verbuendete auf die Ursprungsfelder der beiden
      //     Tauschenden ziehen und sie dort zusaetzlich angreifen (Interceptor,
      //     wie bei Fall 1 / Fall 3). Der Kampf laeuft komplett aus den
      //     Vor-Kampf-Werten; erst danach wird nachgerueckt.
      const swapPool = combatMovers();
      for (let i = 0; i < swapPool.length && !combatDone; i++) {
        for (let j = i + 1; j < swapPool.length; j++) {
          const a = swapPool[i];
          const b = swapPool[j];
          if (areEnemies(a, b) &&
              samePos(desired[a], livePositions[b]) && samePos(desired[b], livePositions[a])) {
            const exclude = new Set([a, b]);
            const interceptorsById = {};
            [a, b].forEach(id => {
              const list = interceptorsOf(id, exclude);
              if (list.length) interceptorsById[id] = list;
            });
            resolveSwapCombat(a, b, interceptorsById);
            combatDone = true;
            changed = true;
            break;
          }
        }
      }

      // (2) Umkaempftes Zielfeld: Fall 1 (ein stehendes Bataillon + ein oder
      //     mehrere gegnerische Angreifer - inkl. dem Sonderfall, dass ein
      //     Verbuendeter des Verteidigers gleichzeitig auf das Ursprungsfeld
      //     eines Angreifers zieht und diesen angreift) oder Fall 3 (leeres
      //     Feld, Bataillone beider Seiten). WICHTIG: Der Kampf wird KOMPLETT
      //     ausgetragen (alle Angreifer gegen den Stehenden, plus die
      //     Interceptor gegen ihre Angreifer, alles gleichzeitig aus den
      //     Vor-Kampf-Werten) und ERST DANACH entschieden, wer auf welches
      //     Feld nachrueckt.
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
            const exclude = new Set([occupantId, ...attackers]);
            const interceptorsByAttacker = {};
            attackers.forEach(aid => {
              const list = interceptorsOf(aid, exclude);
              if (list.length) interceptorsByAttacker[aid] = list;
            });
            resolveDefenseCombat(occupantId, attackers, interceptorsByAttacker);
          } else {
            if (new Set(ids.map(id => unitsById[id].role)).size < 2) continue;
            const exclude = new Set(ids);
            const interceptorsByMover = {};
            ids.forEach(mid => {
              const list = interceptorsOf(mid, exclude);
              if (list.length) interceptorsByMover[mid] = list;
            });
            resolveClashCombat(ids, interceptorsByMover);
          }
          combatDone = true;
          changed = true;
          break;
        }
      }

      // (3) Sicherheitsnetz gegen Doppelbelegung. Wurde in diesem Takt eine
      // Bewegung durch eine Blockade oder einen Kampf zurueckgenommen, kann
      // eine Einheit auf ihr Feld zurueckgefallen sein, auf das gleichzeitig
      // eine andere - bereits freigegebene - Einheit ziehen wollte (das
      // umkaempfte Feld galt zum Pruefzeitpunkt als "wird geraeumt"). Erst
      // wenn diese Iteration keinen Kampf mehr ausgeloest hat, steht `desired`
      // fest genug: pro Feld darf hoechstens eine Einheit landen. Es bleibt,
      // wer schon dort steht, sonst die schnellste (bzw. kleinster Index,
      // siehe pickWinner); alle anderen verlieren ihren Rest-Zug. Laeuft in
      // der Fixpunkt-Schleife mit, damit Ketten sauber auslaufen.
      if (!combatDone) {
        const byCell = {};
        aliveIds.forEach(id => {
          const key = posKeyOf(desired[id]);
          (byCell[key] = byCell[key] || []).push(id);
        });
        Object.values(byCell).forEach(ids => {
          if (ids.length <= 1) return;
          // Wer bleibt: zuerst eine Einheit, die auf ihrem eigenen Feld steht
          // (nie gezogen oder nach einem Kampf/einer Blockade dorthin zurueck-
          // gefallen) - eine bereits besetzte Zelle darf niemand betreten;
          // sonst eine Einheit, die diesen Takt schon gekaempft hat / geblockt
          // ist und gerade nachrueckt (Ziel steht fest, z.B. Platztausch-
          // Sieger); sonst die schnellste (bzw. kleinster Index, pickWinner).
          const keep =
            ids.find(id => isStationary(id)) ||
            ids.find(id => blockedUnits.has(id) || combatResolvedThisTick.has(id)) ||
            pickWinner(ids, unitsById);
          ids.forEach(id => {
            if (id === keep) return;
            if (!blockedUnits.has(id)) {
              block(id);
              changed = true;
            } else if (!samePos(desired[id], livePositions[id])) {
              desired[id] = { ...livePositions[id] };
              changed = true;
            }
          });
        });
      }
    }

    Object.keys(desired).forEach(unitId => {
      const prev = livePositions[unitId];
      const next = desired[unitId];
      if (liveFacing[unitId] != null) {
        if (prev && next && !samePos(prev, next)) {
          // Gelaufen: Blickrichtung = gelaufene Richtung.
          const d = HexBoard.dirBetween(prev, next);
          if (d >= 0) liveFacing[unitId] = d;
        } else if (!blockedUnits.has(unitId)) {
          // Stehen geblieben: falls dieser Takt ein Dreh-Schritt geplant war
          // (und die Einheit nicht blockiert ist), Blickrichtung uebernehmen.
          const step = combinedPlan[unitId] && combinedPlan[unitId][tick];
          if (step && step.turn != null) liveFacing[unitId] = step.turn;
        }
      }
      livePositions[unitId] = next;
    });

    ticks.push({
      positions: Object.fromEntries(Object.keys(desired).map(id => [id, { ...livePositions[id] }])),
      facings: { ...liveFacing },
      interceptors: interceptorIds,
      blockedAttempts,
      combatEvents,
      arrowEvents,
      skippedActions
    });
  }

  deadUnits.forEach(id => { delete livePositions[id]; });

  return { ticks, finalPositions: livePositions, finalHp: hp, finalFacings: liveFacing };
}

// Baut aus den (server-validierten) Platzierungen beider Spieler die finalen
// Einheiten + Startpositionen + Start-HP (volles Bataillon) fuer die Zugplanungsphase
function buildUnitsAndPositions(room) {
  const units = [];
  const positions = {};
  const hp = {};
  const facings = {};

  ['blue', 'red'].forEach(role => {
    room.placements[role].forEach((placement, index) => {
      const type = UnitTypes.byKey(placement.typeKey);
      const sameTypeSoFar = room.placements[role]
        .slice(0, index + 1)
        .filter(p => p.typeKey === placement.typeKey).length;

      const facing = UnitTypes.hasFacing(placement.typeKey)
        ? sanitizeFacing(placement.facing, role)
        : null;

      units.push({
        id: placement.unitId,
        role,
        typeKey: placement.typeKey,
        label: `${type.label} ${sameTypeSoFar}`,
        chipIndex: sameTypeSoFar,
        facing
      });
      positions[placement.unitId] = { q: placement.q, r: placement.r };
      hp[placement.unitId] = UnitTypes.maxHpFor(placement.typeKey);
      if (facing != null) facings[placement.unitId] = facing;
    });
  });

  return { units, positions, hp, facings };
}

io.on('connection', (socket) => {
  console.log('Spieler verbunden:', socket.id);

  socket.on('joinRoom', (payload) => {
    const roomId = typeof payload === 'string' ? payload : (payload && payload.roomId);
    const rawName = typeof payload === 'object' && payload ? payload.name : '';
    if (!roomId) return;

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
    room.names[role] = sanitizeName(rawName);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = role;

    socket.emit('joined', {
      role,
      unitTypes: UnitTypes.TYPES,
      maxUnitsPerPlayer: UnitTypes.MAX_UNITS_PER_PLAYER,
      match: matchStatePayload(room)
    });

    console.log(`Spieler ${socket.id} ist Raum ${roomId} als ${role} beigetreten`);

    if (room.sockets.blue && room.sockets.red) {
      io.to(roomId).emit('placementPhaseStart');
      io.to(roomId).emit('matchState', matchStatePayload(room));
    }
  });

  // Ein Spieler platziert die naechste Einheit eines Stapels auf ein Feld
  // seiner eigenen Zone. Reihenfolge in room.placements[role] = Stapel-Reihenfolge,
  // die Instanznummer (chipIndex/label) ergibt sich daraus erst beim Spielstart.
  socket.on('placeUnit', ({ roomId, typeKey, q, r, facing }) => {
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
    const entry = { unitId, typeKey, q, r };
    if (UnitTypes.hasFacing(typeKey)) entry.facing = sanitizeFacing(facing, role);
    room.placements[role].push(entry);
    socket.emit('placementAccepted', { unitId, typeKey, q, r });
  });

  // Blickrichtung einer bereits platzierten Einheit aendern (nur solange die
  // Platzierungsphase laeuft und der Spieler noch nicht bereit ist).
  socket.on('setPlacementFacing', ({ roomId, unitId, facing }) => {
    const room = rooms[roomId];
    if (!room) return;
    const role = socket.data.role;
    if (!role || room.phase !== 'placement' || room.ready[role]) return;

    const entry = room.placements[role].find(p => p.unitId === unitId);
    if (entry && UnitTypes.hasFacing(entry.typeKey)) {
      entry.facing = sanitizeFacing(facing, role);
    }
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
      const { units, positions, hp, facings } = buildUnitsAndPositions(room);
      room.units = units;
      room.positions = positions;
      room.hp = hp;
      room.facings = facings;
      io.to(roomId).emit('gameStart', { units, positions, hp, facings });
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
    if (!room || room.phase !== 'playing' || room.closing) return;

    const role = socket.data.role;
    if (!role) return;

    // Besiegte (HP <= 0) Bataillone existieren nicht mehr und werden nicht
    // mehr eingeplant.
    const unitsForRole = room.units.filter(u => u.role === role && room.hp[u.id] > 0);
    const enemyRole = role === 'blue' ? 'red' : 'blue';
    const enemyIds = new Set(
      room.units.filter(u => u.role === enemyRole && room.hp[u.id] > 0).map(u => u.id)
    );
    if (!isValidRolePlan(plan, room.positions, unitsForRole, room.facings || {}, enemyIds)) {
      const bad = findInvalidRolePlanUnit(plan, room.positions, unitsForRole, room.facings || {}, enemyIds);
      socket.emit('planRejected', {
        reason: bad.label ? `Ungültiger Zug für ${bad.label}.` : 'Ungültiger Zug.'
      });
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
      const { ticks, finalPositions, finalHp, finalFacings } = resolveRound(room, combinedPlan);

      room.positions = finalPositions;
      room.hp = finalHp;
      room.facings = { ...(room.facings || {}), ...finalFacings };
      room.plans.blue = null;
      room.plans.red = null;

      // Runde entschieden, sobald eine Seite keine Figuren mehr auf dem Feld
      // hat. Beide gleichzeitig leer = Unentschieden (beide bekommen einen Punkt).
      const aliveOf = (r) => room.units.filter(u => u.role === r && room.hp[u.id] > 0).length;
      const blueAlive = aliveOf('blue');
      const redAlive = aliveOf('red');
      let roundWinner = null; // 'blue' | 'red' | 'draw' | null
      if (blueAlive === 0 && redAlive === 0) roundWinner = 'draw';
      else if (blueAlive === 0) roundWinner = 'red';
      else if (redAlive === 0) roundWinner = 'blue';

      let roundResult = null;
      let matchResult = null;

      if (roundWinner) {
        if (roundWinner === 'draw') { room.scores.blue += 1; room.scores.red += 1; }
        else room.scores[roundWinner] += 1;

        roundResult = {
          winner: roundWinner,
          round: room.round,
          ...matchStatePayload(room) // scores nach dem Punkt, names, round
        };

        if (room.scores.blue >= 2 || room.scores.red >= 2) {
          const matchWinner = (room.scores.blue >= 2 && room.scores.red >= 2)
            ? 'draw'
            : (room.scores.blue >= 2 ? 'blue' : 'red');
          matchResult = {
            winner: matchWinner,
            winnerName: matchWinner === 'draw' ? null : displayName(room, matchWinner)
          };
          room.closing = true;
        } else {
          resetRoomForNextRound(room);
        }
      }

      // Bei Match-Ende KEIN serverseitiger Reload-Timer: der Server weiss
      // nicht, wie lange die Runden-Animation beim Client noch laeuft, und
      // wuerde sonst mitten in der Animation oder vor der Sieg-Anzeige neu
      // laden lassen. Der Client laedt sich nach seinem eigenen 5s-Countdown
      // (siehe showEndOverlay) selbst neu; das trennt dabei seinen Socket,
      // und der Raum wird ganz normal ueber den disconnect-Handler unten
      // aufgeraeumt, sobald beide Spieler weg sind.
      io.to(roomId).emit('executeRound', { ticks, roundResult, matchResult });
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
    const room = rooms[roomId];
    if (!room) return;

    delete room.sockets[role];

    if (!room.sockets.blue && !room.sockets.red) {
      delete rooms[roomId];
      return;
    }

    // Match ist bereits (regulaer) zu Ende und die Rueckkehr zum Start laeuft
    // schon (siehe matchResult oben) - keine zweite Meldung noetig.
    if (room.closing) return;
    room.closing = true;

    // Verbleibender Spieler bekommt die Meldung wie beim Sieg-Overlay und
    // laedt sich nach seinem eigenen 5s-Countdown selbst neu (siehe
    // showEndOverlay im Client). Kein serverseitiger Timer noetig: sobald
    // dieser letzte Socket ebenfalls die Verbindung trennt, greift oben der
    // "beide Spieler weg" -Zweig und raeumt den Raum auf.
    io.to(roomId).emit('playerLeft');
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

module.exports = { resolveRound, buildUnitsAndPositions, isValidUnitSteps };
