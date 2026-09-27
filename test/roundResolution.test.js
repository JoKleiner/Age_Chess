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

    // Einzeltreffer (hits) muessen - aufsummiert ueber alle Kampf-Ereignisse
    // des Takts - genau den gemeldeten HP-Endstand ergeben (der Client zeigt
    // damit den temporaeren Balken).
    {
      const temp = { ...hp };
      const expected = {};
      // Jede Figur teilt pro Takt nur EINMAL Schaden aus - ihre Treffer
      // duerfen also nur aus einem einzigen Kampf-Ereignis stammen.
      const strikeEvent = {};
      t.combatEvents.forEach((ev, evIndex) => {
        (ev.hits || []).forEach(h => {
          if (strikeEvent[h.from] != null && strikeEvent[h.from] !== evIndex) {
            errors.push(`T${tick}: ${h.from} teilt in mehreren Kaempfen Schaden aus`);
          }
          strikeEvent[h.from] = evIndex;
        });
      });
      t.combatEvents.forEach(ev => {
        (ev.hits || []).forEach(h => {
          if (!(h.damage > 0)) errors.push(`T${tick}: Treffer ohne Schaden ${h.from}->${h.to}`);
          if (unitsById[h.from].role === unitsById[h.to].role) errors.push(`T${tick}: Treffer auf eigene Figur ${h.from}->${h.to}`);
          temp[h.to] = Math.max(0, temp[h.to] - h.damage);
        });
        ev.participants.forEach(p => { expected[p.unitId] = p.hpAfter; });
        const ai = ev.arrowImpact;
        if (ai) {
          temp[ai.unitId] = Math.max(0, temp[ai.unitId] - (ai.hpBefore - ai.hpAfter));
          expected[ai.unitId] = ai.hpAfter;
        }
      });
      Object.entries(expected).forEach(([id, v]) => {
        if (temp[id] !== v) errors.push(`T${tick}: Treffer-Summe fuer ${id} ergibt ${temp[id]}, gemeldet ${v}`);
      });
    }

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
{
  // Eigene Figur steht auf dem einzigen naeheren Feld -> Abfaenger laeuft
  // drum herum statt blockiert zu werden (und seinen Restzug zu verlieren).
  const room = fixedRoom([
    ['blue_schwertkaempfer_1', 'blue', 'schwertkaempfer', { q: 1, r: 2 }],
    ['blue_bogenschuetze_1', 'blue', 'bogenschuetze', { q: 1, r: 1 }],
    ['red_lanze_1', 'red', 'lanze', { q: 1, r: -2 }]
  ]);
  const I = { q: 1, r: 2, intercept: 'red_lanze_1' };
  const { ticks } = resolveRound(room, {
    blue_schwertkaempfer_1: [I, I], blue_bogenschuetze_1: [], red_lanze_1: []
  });
  expect('Abfaenger wird nicht von eigener Figur blockiert',
    ticks.every(t => t.blockedAttempts.length === 0));
  // Start-Abstand 4: Takt 1 seitlich ausweichen, Takt 2 ein Feld naeher.
  expect('Abfaenger kommt um die eigene Figur herum naeher',
    HexBoard.hexDistance(ticks[1].positions.blue_schwertkaempfer_1, { q: 1, r: -2 }) === 3);
}
{
  // Zwei benachbarte Figuren fangen sich gegenseitig ab -> beide ziehen auf
  // das Feld des anderen (Platztausch-Kampf), unabhaengig von der Farbe.
  const room = fixedRoom([
    ['red_lanze_1', 'red', 'lanze', { q: 0, r: 0 }],
    ['blue_schwertkaempfer_1', 'blue', 'schwertkaempfer', { q: 1, r: 0 }]
  ]);
  const { ticks } = resolveRound(room, {
    red_lanze_1: [{ q: 0, r: 0, intercept: 'blue_schwertkaempfer_1' }],
    blue_schwertkaempfer_1: [{ q: 1, r: 0, intercept: 'red_lanze_1' }]
  });
  const ev = ticks[0].combatEvents[0];
  const part = (id) => ev && ev.participants.find(p => p.unitId === id);
  expect('Gegenseitiges Abfangen: Rot zieht auf das blaue Feld',
    part('red_lanze_1') && same(part('red_lanze_1').attemptCell, { q: 1, r: 0 }));
  expect('Gegenseitiges Abfangen: Blau zieht auf das rote Feld',
    part('blue_schwertkaempfer_1') && same(part('blue_schwertkaempfer_1').attemptCell, { q: 0, r: 0 }));
}
{
  // Nutzer-Fall 2026-09-27: Rot F1 zieht E5->E6, Blau F2/F3/F4 fangen F1 ab,
  // Rot F5/F6 fangen F2 ab. Erwartet: F2 folgt auf E5 (F1 raeumt es), F3/F4
  // verteilen sich auf D5/F6 (Ursprungsfelder von F5/F6), F5+F6 ziehen auf E5
  // -> Kampf auf E5, F3/F4 treffen F5/F6 dort ohne Gegenschaden.
  const E5 = { q: 1, r: 0 }, E6 = { q: 1, r: -1 }, E4 = { q: 1, r: 1 };
  const D4 = { q: 0, r: 1 }, F5 = { q: 2, r: 0 }, D5 = { q: 0, r: 0 }, F6 = { q: 2, r: -1 };
  const room = fixedRoom([
    ['red_lanze_1', 'red', 'lanze', E5],
    ['blue_schwertkaempfer_1', 'blue', 'schwertkaempfer', E4],
    ['blue_schwertkaempfer_2', 'blue', 'schwertkaempfer', D4],
    ['blue_lanze_1', 'blue', 'lanze', F5],
    ['red_schwertkaempfer_1', 'red', 'schwertkaempfer', D5],
    ['red_schwertkaempfer_2', 'red', 'schwertkaempfer', F6]
  ]);
  const I = (pos, t) => ({ q: pos.q, r: pos.r, intercept: t });
  const { ticks } = resolveRound(room, {
    red_lanze_1: [E6],
    blue_schwertkaempfer_1: [I(E4, 'red_lanze_1')],
    blue_schwertkaempfer_2: [I(D4, 'red_lanze_1')],
    blue_lanze_1: [I(F5, 'red_lanze_1')],
    red_schwertkaempfer_1: [I(D5, 'blue_schwertkaempfer_1')],
    red_schwertkaempfer_2: [I(F6, 'blue_schwertkaempfer_1')]
  });
  const evs = ticks[0].combatEvents;
  const at = (cell) => evs.find(e => e.cells.length === 1 && same(e.cells[0], cell));
  const e5 = at(E5);
  expect('Kampf auf E5 mit F2, F5, F6',
    e5 && ['blue_schwertkaempfer_1', 'red_schwertkaempfer_1', 'red_schwertkaempfer_2']
      .every(id => e5.participants.some(p => p.unitId === id && same(p.attemptCell, E5))));
  expect('F3 greift F5 auf D5 an', at(D5) && at(D5).participants.some(p => p.unitId === 'blue_schwertkaempfer_2'));
  expect('F4 greift F6 auf F6 an', at(F6) && at(F6).participants.some(p => p.unitId === 'blue_lanze_1'));
  expect('F1 zieht ungestoert nach E6', same(ticks[0].positions.red_lanze_1, E6));
}
{
  // Nutzer-Fall 2026-09-27 (6 Schwerter): bS1 kaempft erst als Abfaenger im
  // Platztausch bS3<->rS1 mit und bleibt stehen. rS2 + rS3 fangen bS1 ab und
  // muessen ihn danach im SELBEN Takt noch auf seinem Feld angreifen (vorher
  // liefen sie "ins Leere" gegeneinander und wurden nur zurueckgeschickt).
  const B = 'blue_schwertkaempfer_', R = 'red_schwertkaempfer_';
  const pos = {
    [B + 1]: { q: 0, r: 0 }, [B + 2]: { q: -1, r: 1 }, [B + 3]: { q: 1, r: 0 },
    [R + 1]: { q: 1, r: -1 }, [R + 2]: { q: 0, r: -1 }, [R + 3]: { q: -1, r: 0 }
  };
  const tgt = { [B + 1]: R + 1, [B + 2]: R + 3, [B + 3]: R + 1, [R + 1]: B + 3, [R + 2]: B + 1, [R + 3]: B + 1 };
  const room = fixedRoom(Object.keys(pos).map(id =>
    [id, id.startsWith('blue') ? 'blue' : 'red', 'schwertkaempfer', pos[id]]));
  room.hp[B + 3] = 40; // stirbt im Platztausch, rS1 rueckt nach
  const plan = {};
  Object.keys(pos).forEach(id => {
    const s = { q: pos[id].q, r: pos[id].r, intercept: tgt[id] };
    plan[id] = [s, s];
  });
  const { ticks } = resolveRound(room, plan);
  const ev = ticks[0].combatEvents.find(e => e.cells.length === 1 && same(e.cells[0], pos[B + 1]));
  const has = (id) => ev && ev.participants.some(p => p.unitId === id);
  expect('rS2 und rS3 greifen bS1 auf seinem Feld an', has(B + 1) && has(R + 2) && has(R + 3));
  expect('Keine Blockade statt Kampf', ticks[0].blockedAttempts.length === 0);
  // bS1 hat als Abfaenger schon zugeschlagen -> schlaegt nicht mehr zurueck.
  expect('bS1 schlaegt kein zweites Mal zu', ev && !ev.hits.some(h => h.from === B + 1));
  const part = (id) => ev && ev.participants.find(p => p.unitId === id);
  expect('rS2/rS3 bekommen keinen Gegenschaden von bS1',
    part(R + 2) && part(R + 2).hpAfter === 150);
}
{
  // Nutzer-Fall 2026-09-27 (stehendes Ziel): rS1/rS2/rS3 fangen die STEHENDE
  // bS2 auf D5 ab -> alle drei greifen sie dort GEMEINSAM an (vorher wichen
  // rS2/rS3 dem "vom Kollegen beanspruchten" Feld aus, liefen in bS3 bzw.
  // wurden blockiert). bS3 faengt rS1 ab und trifft es auf dessen Ursprung.
  const B = 'blue_schwertkaempfer_', R = 'red_schwertkaempfer_';
  const D5 = { q: 0, r: 0 };
  const pos = {
    [B + 1]: { q: -1, r: 1 }, [B + 2]: D5, [B + 3]: { q: 1, r: 0 },
    [R + 1]: { q: 1, r: -1 }, [R + 2]: { q: 0, r: -1 }, [R + 3]: { q: -1, r: 0 }
  };
  const tgt = { [B + 1]: R + 3, [B + 3]: R + 1, [R + 1]: B + 2, [R + 2]: B + 2, [R + 3]: B + 2 };
  const room = fixedRoom(Object.keys(pos).map(id =>
    [id, id.startsWith('blue') ? 'blue' : 'red', 'schwertkaempfer', pos[id]]));
  room.hp[B + 2] = 40;
  const plan = {};
  Object.keys(pos).forEach(id => {
    const s = { q: pos[id].q, r: pos[id].r, intercept: tgt[id] };
    plan[id] = tgt[id] ? [s, s] : [];
  });
  const { ticks } = resolveRound(room, plan);
  const t0 = ticks[0];
  const ev = t0.combatEvents.find(e => e.cells.length === 1 && same(e.cells[0], D5));
  const attackers = ev ? ev.participants.filter(p => p.unitId !== B + 2).map(p => p.unitId).sort() : [];
  expect('Alle drei roten greifen die stehende bS2 an', attackers.join() === [R + 1, R + 2, R + 3].join());
  expect('Keine Blockaden', t0.blockedAttempts.length === 0);
  expect('rS1 rueckt auf D5 nach', same(t0.positions[R + 1], D5));
  expect('bS3 trifft rS1', t0.combatEvents.some(e => e.hits.some(h => h.from === B + 3 && h.to === R + 1)));
}
{
  // Nutzer-Fall 2026-09-27 (kein Ausweichen im Kampf): alle Blauen fangen
  // rS2 ab, alle Roten bS2. bS1 kaempft als Abfaenger gegen rS2 und rueckt
  // nach D5 vor; rS3 zieht auf bS1s Ursprung C4 -> trifft bS1 dort (kein
  // Gegenschaden) und zieht auf das frei gewordene C4. Stirbt bS1 dabei,
  // rueckt NIEMAND statt ihm auf D5 nach.
  const B = 'blue_schwertkaempfer_', R = 'red_schwertkaempfer_';
  const C4 = { q: -1, r: 1 }, D5 = { q: 0, r: 0 };
  const pos = {
    [B + 1]: C4, [B + 2]: { q: 0, r: 1 }, [B + 3]: { q: 1, r: 0 },
    [R + 1]: { q: 1, r: -1 }, [R + 2]: D5, [R + 3]: { q: -1, r: 0 }
  };
  const tgt = { [B + 1]: R + 2, [B + 2]: R + 2, [B + 3]: R + 2, [R + 1]: B + 2, [R + 2]: B + 2, [R + 3]: B + 2 };
  const build = (hpOf) => {
    const room = fixedRoom(Object.keys(pos).map(id =>
      [id, id.startsWith('blue') ? 'blue' : 'red', 'schwertkaempfer', pos[id]]));
    Object.keys(pos).forEach((id, i) => {
      room.units.find(u => u.id === id).chipIndex = Number(id.slice(-1));
      room.hp[id] = hpOf(id);
    });
    const plan = {};
    Object.keys(pos).forEach(id => {
      const s = { q: pos[id].q, r: pos[id].r, intercept: tgt[id] };
      plan[id] = [s, s];
    });
    return resolveRound(room, plan).ticks[0];
  };

  const t = build(() => 90);
  expect('bS1 rueckt nach D5 vor', same(t.positions[B + 1], D5));
  expect('rS3 trifft bS1 ohne Gegenschaden',
    t.combatEvents.some(e => e.hits.some(h => h.from === R + 3 && h.to === B + 1) &&
      !e.hits.some(h => h.from === B + 1 && h.to === R + 3)));
  expect('rS3 zieht auf das frei gewordene C4', same(t.positions[R + 3], C4));

  const t2 = build(id => ([B + 1, B + 2, B + 3, R + 2].includes(id) ? 30 : 90));
  const ev = t2.combatEvents.find(e => e.cells.length === 1 && same(e.cells[0], D5));
  expect('bS1 ist als Nachruecker gewaehlt', ev && ev.moverId === B + 1);
  expect('bS1 stirbt durch rS3', t2.combatEvents.some(e => e.participants.some(p => p.unitId === B + 1 && p.defeated)));
  expect('Niemand rueckt statt bS1 auf D5 nach',
    !Object.entries(t2.positions).some(([id, p]) => id !== B + 1 && id !== R + 2 && same(p, D5)));
  expect('rS3 zieht auf C4', same(t2.positions[R + 3], C4));
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
