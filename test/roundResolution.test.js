// Zufalls-Test der Rundenaufloesung (resolveRound): spielt viele zufaellige,
// gueltige Plaene durch und prueft, dass keine gewaehlte Aktion
// stillschweigend verschwindet und der Spielzustand konsistent bleibt.
// Start: `npm test` (oder `node test/roundResolution.test.js [anzahl] [seed]`).

const { resolveRound, isValidUnitSteps } = require('../server.js');
const HexBoard = require('../public/board/hexBoard.js');
const UnitTypes = require('../public/pieces/unitTypes.js');

const ROUNDS = Number(process.argv[2]) || 3000;
let seed = Number(process.argv[3]) || 12345;
function rand() { // deterministisch (mulberry32), damit Fehler reproduzierbar sind
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const cells = HexBoard.generateBoardCells().map(c => ({ q: c.q, r: c.r }));
const cellKeys = new Set(cells.map(c => HexBoard.keyOf(c.q, c.r)));
const key = (p) => HexBoard.keyOf(p.q, p.r);
const same = (a, b) => a.q === b.q && a.r === b.r;
const neighbors = (p) => HexBoard.DIRECTIONS
  .map(d => ({ q: p.q + d.dq, r: p.r + d.dr }))
  .filter(c => cellKeys.has(key(c)));
const TYPES = ['reiter', 'schwertkaempfer', 'lanze', 'bogenschuetze'];

// Kleiner Bereich um ein zufaelliges Zentrum -> viele Begegnungen.
function makeRoom() {
  const center = pick(cells);
  const area = cells.filter(c => HexBoard.hexDistance(c, center) <= 3);
  const free = area.slice();
  const room = { units: [], positions: {}, hp: {}, facings: {} };
  ['blue', 'red'].forEach(role => {
    const n = 2 + Math.floor(rand() * 4);
    const counts = {};
    for (let i = 0; i < n && free.length; i++) {
      const typeKey = pick(TYPES);
      counts[typeKey] = (counts[typeKey] || 0) + 1;
      const id = `${role}_${typeKey}_${counts[typeKey]}`;
      const pos = free.splice(Math.floor(rand() * free.length), 1)[0];
      room.units.push({ id, role, typeKey, chipIndex: counts[typeKey], label: id });
      room.positions[id] = pos;
      // teils schon angeschlagen, damit auch Besiegte vorkommen
      room.hp[id] = Math.max(1, Math.round(UnitTypes.maxHpFor(typeKey) * (0.2 + rand() * 0.8)));
      if (UnitTypes.hasFacing(typeKey)) room.facings[id] = Math.floor(rand() * 6);
    }
  });
  return room;
}

function randomSteps(unit, start, facing, enemyIds) {
  const steps = [];
  let pos = start;
  const len = 1 + Math.floor(rand() * UnitTypes.DEFAULT_MAX_STEPS);
  for (let i = 0; i < len; i++) {
    const roll = rand();
    if (unit.typeKey === 'bogenschuetze' && roll < 0.35) {
      const shot = rand() < 0.5
        ? { type: 'near', dir: pick(HexBoard.DIRECTIONS) }
        : { type: 'far', target: pick(cells) };
      steps.push({ q: pos.q, r: pos.r, shot });
    } else if (UnitTypes.canIntercept(unit.typeKey) && roll < 0.35 && enemyIds.size) {
      steps.push({ q: pos.q, r: pos.r, intercept: pick([...enemyIds]) });
    } else if (UnitTypes.hasFacing(unit.typeKey) && roll < 0.2) {
      steps.push({ q: pos.q, r: pos.r, turn: Math.floor(rand() * 6) });
    } else if (roll < 0.8) {
      pos = pick(neighbors(pos));
      steps.push({ q: pos.q, r: pos.r });
    } else {
      steps.push({ q: pos.q, r: pos.r });
    }
  }
  return steps;
}

function makePlan(room) {
  const plan = {};
  room.units.forEach(u => {
    const enemyIds = new Set(room.units.filter(o => o.role !== u.role).map(o => o.id));
    let steps = [];
    for (let attempt = 0; attempt < 40; attempt++) {
      const s = randomSteps(u, room.positions[u.id], room.facings[u.id], enemyIds);
      if (isValidUnitSteps(s, room.positions[u.id], u.typeKey, room.facings[u.id], enemyIds)) { steps = s; break; }
    }
    plan[u.id] = steps;
  });
  return plan;
}

function check(room, plan) {
  const errors = [];
  const { ticks, finalPositions, finalHp } = resolveRound(room, plan);
  const unitsById = Object.fromEntries(room.units.map(u => [u.id, u]));
  let pos = { ...room.positions };
  const hp = { ...room.hp };
  const dead = new Set();
  const dropped = new Set(); // Restzug verfallen (Blockade/Kampf)
  const launched = new Set();
  const impacted = new Set();
  const shotSkipped = new Set();
  const seenInCombat = new Set(); // in einem Kampf-Ereignis sichtbar beteiligt

  ticks.forEach((t, tick) => {
    const skip = t.skippedActions || [];
    skip.forEach(s => {
      if (s.kind === 'shot') shotSkipped.add(s.unitId);
      if (s.reason === 'fought' && !seenInCombat.has(s.unitId)) {
        errors.push(`T${tick}: ${s.unitId} gilt als "hat gekaempft", war aber in keinem sichtbaren Kampf`);
      }
      if (!unitsById[s.unitId]) errors.push(`T${tick}: Meldung fuer unbekannte Einheit ${s.unitId}`);
    });
    t.arrowEvents.forEach(ev => {
      if (ev.kind === 'launch') launched.add(ev.id);
      if (ev.kind === 'impact') {
        if (!launched.has(ev.id)) errors.push(`T${tick}: Einschlag ${ev.id} ohne Abschuss`);
        impacted.add(ev.id);
      }
      if (ev.deferred) return; // wird im Kampf-Ereignis (arrowImpact) gezeigt
      (ev.hits || []).forEach(h => {
        if (h.hpAfter > hp[h.unitId]) errors.push(`T${tick}: HP von ${h.unitId} gestiegen`);
        hp[h.unitId] = h.hpAfter;
        if (h.defeated) dead.add(h.unitId);
      });
    });

    const inConflict = new Set(t.blockedAttempts.map(a => a.unitId));
    t.combatEvents.forEach(ev => {
      ev.participants.forEach(p => {
        inConflict.add(p.unitId);
        seenInCombat.add(p.unitId);
        if (p.hpAfter > hp[p.unitId]) errors.push(`T${tick}: HP von ${p.unitId} gestiegen`);
        if (p.hpAfter < 0) errors.push(`T${tick}: negative HP ${p.unitId}`);
        hp[p.unitId] = p.hpAfter;
        if (p.defeated) dead.add(p.unitId);
      });
      const ai = ev.arrowImpact;
      if (ai) {
        const deferredEv = t.arrowEvents.find(a => a.id === ai.arrowId && a.deferred);
        if (!deferredEv) errors.push(`T${tick}: arrowImpact ${ai.arrowId} ohne verzoegerten Einschlag`);
        if (!launched.has(ai.arrowId)) errors.push(`T${tick}: arrowImpact ${ai.arrowId} ohne Abschuss`);
        if (ai.hpBefore !== hp[ai.unitId]) errors.push(`T${tick}: arrowImpact hpBefore passt nicht`);
        if (ai.hpAfter > ai.hpBefore) errors.push(`T${tick}: HP durch Pfeil gestiegen`);
        hp[ai.unitId] = ai.hpAfter;
        if (ai.defeated) dead.add(ai.unitId);
      }
    });
    const interceptors = new Set(t.interceptors || []);

    // Jede geplante Aktion dieses Takts: findet statt ODER ist erklaert.
    Object.entries(plan).forEach(([id, steps]) => {
      const step = steps[tick];
      if (!step || dead.has(id) && !inConflict.has(id)) return;
      const wasDropped = dropped.has(id);
      const explained = wasDropped || inConflict.has(id) ||
        skip.some(s => s.unitId === id) || dead.has(id);
      if (step.intercept != null) {
        if (!wasDropped && !interceptors.has(id) && !explained) {
          errors.push(`T${tick}: Abfangen von ${id} fand nicht statt und wurde nicht gemeldet`);
        }
      } else if (step.turn != null) {
        if (!explained && t.facings[id] !== step.turn) {
          errors.push(`T${tick}: Drehung von ${id} fand nicht statt und wurde nicht gemeldet`);
        }
      } else if (step.shot == null) {
        // Schritte gelten relativ zum vorigen Planfeld (siehe resolveRound).
        const prev = tick > 0 && steps[tick - 1] ? steps[tick - 1] : room.positions[id];
        const target = { q: pos[id].q + step.q - prev.q, r: pos[id].r + step.r - prev.r };
        const arrived = t.positions[id] && same(t.positions[id], target);
        if (!same(target, pos[id]) && !arrived && !explained) {
          errors.push(`T${tick}: Zug von ${id} nach ${key(target)} fand nicht statt und wurde nicht gemeldet`);
        }
      }
    });

    // Konsistenz der Positionen nach dem Takt.
    const occupied = {};
    Object.entries(t.positions).forEach(([id, p]) => {
      if (dead.has(id)) return;
      if (!cellKeys.has(key(p))) errors.push(`T${tick}: ${id} auf ungueltigem Feld ${key(p)}`);
      if (HexBoard.hexDistance(p, pos[id]) > 1) errors.push(`T${tick}: ${id} ist mehr als 1 Feld gesprungen`);
      if (occupied[key(p)]) errors.push(`T${tick}: Doppelbelegung ${key(p)} (${occupied[key(p)]}, ${id})`);
      occupied[key(p)] = id;
    });
    pos = { ...pos, ...t.positions };

    // Wer diesen Takt blockiert wurde / gekaempft hat, verliert den Restzug.
    inConflict.forEach(id => dropped.add(id));
  });

  // Jeder geplante Schuss: abgefeuert, gemeldet verfallen, oder Schuetze vorher besiegt.
  Object.entries(plan).forEach(([id, steps]) => {
    const i = steps.findIndex(s => s && s.shot != null);
    if (i < 0) return;
    const shotId = `${id}#${i}`;
    if (launched.has(shotId)) {
      if (!impacted.has(shotId)) errors.push(`Schuss ${shotId} abgefeuert, aber nie eingeschlagen`);
    } else if (!shotSkipped.has(id) && !dead.has(id)) {
      errors.push(`Schuss von ${id} (Takt ${i + 1}) fand nicht statt und wurde nicht gemeldet`);
    }
  });

  Object.values(finalHp).forEach(v => { if (v < 0) errors.push('negative End-HP'); });
  Object.keys(finalPositions).forEach(id => {
    if (!unitsById[id]) errors.push(`End-Position fuer unbekannte Einheit ${id}`);
  });
  return errors;
}

let failures = 0;
const startSeed = seed;

// ---------- Feste Regressions-Faelle ----------
function fixedRoom(units) {
  const room = { units: [], positions: {}, hp: {}, facings: {} };
  units.forEach(([id, role, typeKey, pos]) => {
    room.units.push({ id, role, typeKey, chipIndex: 1, label: id });
    room.positions[id] = pos;
    room.hp[id] = UnitTypes.maxHpFor(typeKey);
    if (UnitTypes.hasFacing(typeKey)) room.facings[id] = 0;
  });
  return room;
}
function expect(name, cond) {
  if (!cond) { failures++; console.log(`Regressions-Fall fehlgeschlagen: ${name}`); }
}
{
  // Gegner zieht auf A, eigene Figur zieht von B auf A, eigener Abfaenger auf
  // C (grenzt an A und B) faengt den Gegner ab -> zieht mit auf A und kaempft mit.
  const A = { q: 0, r: 0 };
  const room = fixedRoom([
    ['red_lanze_1', 'red', 'lanze', { q: -1, r: 0 }],
    ['blue_schwertkaempfer_1', 'blue', 'schwertkaempfer', { q: 1, r: 0 }],
    ['blue_lanze_1', 'blue', 'lanze', { q: 1, r: -1 }]
  ]);
  const { ticks } = resolveRound(room, {
    red_lanze_1: [A],
    blue_schwertkaempfer_1: [A],
    blue_lanze_1: [{ q: 1, r: -1, intercept: 'red_lanze_1' }]
  });
  const ev = ticks[0].combatEvents.find(e => e.cells.some(c => same(c, A)));
  expect('Abfaenger kaempft auf dem Kampf-Feld mit',
    ev && ev.participants.some(p => p.unitId === 'blue_lanze_1' && same(p.attemptCell, A)));
}
{
  // Schuetze macht Nahschuss auf den Angreifer und stirbt im selben Takt ->
  // der Pfeil trifft im Kampf-Ereignis (nach dem Verschwinden des Schuetzen).
  const room = fixedRoom([
    ['blue_bogenschuetze_1', 'blue', 'bogenschuetze', { q: 0, r: 0 }],
    ['red_reiter_1', 'red', 'reiter', { q: 1, r: 0 }]
  ]);
  room.hp.blue_bogenschuetze_1 = 1;
  const { ticks } = resolveRound(room, {
    blue_bogenschuetze_1: [{ q: 0, r: 0, shot: { type: 'near', dir: { dq: 1, dr: 0 } } }],
    red_reiter_1: [{ q: 0, r: 0 }]
  });
  const ev = ticks[0].combatEvents[0];
  const ai = ev && ev.arrowImpact;
  const reiter = ev && ev.participants.find(p => p.unitId === 'red_reiter_1');
  expect('Pfeil-Einschlag steckt im Kampf-Ereignis', ai && ai.unitId === 'red_reiter_1');
  expect('Kampf-Ereignis zeigt HP vor dem Pfeil', ai && reiter && reiter.hpAfter === ai.hpBefore && ai.hpAfter < ai.hpBefore);
  expect('Einschlag ist als verzoegert markiert',
    ticks[0].arrowEvents.some(a => a.kind === 'impact' && a.deferred));
}
for (let n = 0; n < ROUNDS; n++) {
  const roundSeed = seed;
  const room = makeRoom();
  const plan = makePlan(room);
  let errors;
  try {
    errors = check(room, plan);
  } catch (e) {
    errors = [`Absturz: ${e.stack}`];
  }
  if (errors.length) {
    failures++;
    if (failures <= 5) {
      console.log(`\n--- Fehler in Runde ${n} (Seed ${roundSeed}) ---`);
      errors.slice(0, 6).forEach(e => console.log('  ' + e));
      console.log('  Positionen:', JSON.stringify(room.positions));
      console.log('  Plan:', JSON.stringify(plan));
    }
  }
}
console.log(`\n${ROUNDS} Zufallsrunden (Start-Seed ${startSeed}): ${failures ? failures + ' mit Fehlern' : 'alle OK'}`);
process.exit(failures ? 1 : 0);
