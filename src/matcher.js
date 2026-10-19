// Streaming, bucketed team formation.
//
// People arrive over the morning. We don't match each person the instant they
// arrive (bad matches) nor wait for everyone (people sit idle). Instead:
//   - once `batchSize` people are waiting  -> form teams (AI may hold back <=3 for the next bucket)
//   - once anyone has waited `maxWaitMinutes` -> form teams for everyone waiting (no hold-backs)
//   - latecomers can be slotted into existing teams that still have room
// The AI proposes; this module enforces the hard rules so a bad model response
// can never produce an invalid team.
import * as store from './store.js';
import * as gemini from './gemini.js';

const { TEAM_MAX } = store;
let running = false;
let rerun = false;
let onChange = () => {};

export function setOnChange(fn) {
  onChange = fn;
}

export function minutesUntilEnd(event, now = new Date()) {
  const [h, m] = (event.endTime || '17:00').split(':').map(Number);
  const end = new Date(now);
  end.setHours(h, m || 0, 0, 0);
  return (end - now) / 60000;
}

export function hhmm(d = new Date()) {
  return d.toTimeString().slice(0, 5);
}

export function formationStatus(now = Date.now()) {
  const s = store.getState();
  const waiting = store.waitingParticipants();
  const oldest = waiting[0] ? now - Date.parse(waiting[0].arrivedAt) : 0;
  const maxWaitMs = s.settings.maxWaitMinutes * 60000;
  return {
    waiting: waiting.length,
    batchSize: s.settings.batchSize,
    nextByTimeAt: waiting[0] ? new Date(Date.parse(waiting[0].arrivedAt) + maxWaitMs).toISOString() : null,
    running,
    trigger: !s.settings.autoFormation || !waiting.length
      ? null
      : waiting.length >= s.settings.batchSize
        ? { reason: `${waiting.length} people waiting`, allowHoldBack: true }
        : oldest >= maxWaitMs
          ? { reason: `${waiting[0].name} has waited ${Math.round(oldest / 60000)} min`, allowHoldBack: false }
          : null,
  };
}

// Called on every check-in and on a timer.
export async function maybeForm() {
  if (!running) joinGroupTeams(); // a slot may have opened on a friend's team
  const { trigger } = formationStatus();
  if (trigger) await runFormation(trigger);
}

export async function runFormation({ reason = 'manual', allowHoldBack = false } = {}) {
  if (running) {
    rerun = true;
    return;
  }
  running = true;
  onChange();
  try {
    joinGroupTeams();
    const waiting = store.waitingParticipants();
    if (!waiting.length) return;
    const s = store.getState();
    const open = store.openTeams().map((t) => ({ ...t, members: t.memberIds.map((id) => s.participants[id]) }));
    const hoursLeft = minutesUntilEnd(s.event) / 60;
    store.log(`Forming teams (${reason}): ${waiting.length} waiting, ${open.length} open teams.`);

    let plan = { teams: [], holdBack: [] };
    let source = 'fallback';
    if (gemini.geminiEnabled()) {
      try {
        plan = await gemini.formTeams({ event: s.event, waiting, open, hoursLeft, nowLabel: hhmm(), allowHoldBack });
        source = 'ai';
      } catch (err) {
        store.log(`Gemini formation failed, using fallback: ${err.message}`);
      }
    }

    const result = validatePlan(plan, {
      waiting,
      open,
      allowHoldBack,
      maxWaitMs: s.settings.maxWaitMinutes * 60000,
      now: Date.now(),
      fallbackProject: (ids) => fallbackProject(ids.map((id) => s.participants[id]), s),
      source,
    });
    applyPlan(result);
    s.lastFormationAt = new Date().toISOString();
    store.log(
      `Formed ${result.ops.filter((o) => o.kind === 'new').length} new team(s), ` +
        `filled ${result.ops.filter((o) => o.kind === 'join').length} open team(s), held ${result.held.length}. ` +
        (result.notes.length ? `Fixes: ${result.notes.join('; ')}` : ''),
    );
  } finally {
    running = false;
    onChange();
    if (rerun) {
      rerun = false;
      setTimeout(maybeForm, 0);
    }
  }
}

// Participants who share a group code with an existing team join it directly.
export function joinGroupTeams() {
  let changed = false;
  const s = store.getState();
  for (const p of store.waitingParticipants()) {
    if (!p.group) continue;
    const team = Object.values(s.teams).find(
      (t) => t.memberIds.length < TEAM_MAX && t.memberIds.some((id) => s.participants[id]?.group === p.group),
    );
    if (team) {
      addToTeam(team, p);
      store.log(`${p.name} joined their group's team "${team.name}".`);
      changed = true;
    }
  }
  if (changed) onChange();
}

// ---------------------------------------------------------------------------
// Validation: turn an untrusted AI plan into a set of operations that obey
// every hard rule. Pure function (no store access) so it is easy to test.
// ---------------------------------------------------------------------------
export function validatePlan(plan, { waiting, open, allowHoldBack, maxWaitMs, now, fallbackProject, source = 'ai' }) {
  const waitingById = new Map(waiting.map((p) => [p.id, p]));
  const openById = new Map(open.map((t) => [t.id, t]));
  const used = new Set();
  const notes = [];
  const ops = [];
  let leftovers = [];

  const sizeOf = (op) => op.memberIds.length + (op.kind === 'join' ? openById.get(op.teamId).memberIds.length : 0);
  const conflicts = (p, others) =>
    others.some((o) => p.avoidIds?.includes(o.id) || o.avoidIds?.includes(p.id));
  const membersOf = (op) => [
    ...(op.kind === 'join' ? openById.get(op.teamId).members : []),
    ...op.memberIds.map((id) => waitingById.get(id)),
  ];

  for (const t of plan.teams || []) {
    const ids = (t.memberIds || []).filter((id) => {
      if (!waitingById.has(id)) return notes.push(`ignored unknown id ${id}`) && false;
      if (used.has(id)) return notes.push(`${id} assigned twice`) && false;
      return true;
    });
    let op = openById.has(t.existingTeamId)
      ? ops.find((o) => o.kind === 'join' && o.teamId === t.existingTeamId) || {
          kind: 'join', teamId: t.existingTeamId, memberIds: [], rationale: t.rationale, source,
        }
      : { kind: 'new', memberIds: [], teamName: t.teamName, project: t.project, rationale: t.rationale, source };
    for (const id of ids) {
      const p = waitingById.get(id);
      used.add(id);
      if (sizeOf(op) >= TEAM_MAX) {
        notes.push(`team over ${TEAM_MAX}, moved ${p.name}`);
        leftovers.push(p);
      } else if (conflicts(p, membersOf(op))) {
        notes.push(`${p.name} paired with someone they declined`);
        leftovers.push(p);
      } else {
        op.memberIds.push(id);
      }
    }
    if (op.memberIds.length && !ops.includes(op)) ops.push(op);
  }

  // Hold-backs: only when allowed, max 3, and never someone who has already waited too long.
  const held = [];
  if (allowHoldBack) {
    for (const id of plan.holdBack || []) {
      const p = waitingById.get(id);
      if (!p || used.has(id) || held.length >= 3) continue;
      if (now - Date.parse(p.arrivedAt) >= maxWaitMs) continue;
      used.add(id);
      held.push(id);
    }
  }
  leftovers.push(...waiting.filter((p) => !used.has(p.id)));

  // Keep groups together: pull stray group members into the team holding most of their group.
  const groups = new Map();
  for (const p of waiting) if (p.group) groups.set(p.group, [...(groups.get(p.group) || []), p]);
  for (const [group, members] of groups) {
    const target = ops
      .map((op) => ({ op, n: op.memberIds.filter((id) => members.some((m) => m.id === id)).length }))
      .sort((a, b) => b.n - a.n)[0];
    if (!target?.n) continue;
    for (const m of members) {
      if (target.op.memberIds.includes(m.id)) continue;
      if (sizeOf(target.op) >= TEAM_MAX) {
        notes.push(`group "${group}" too large to keep together`);
        break;
      }
      for (const op of ops) op.memberIds = op.memberIds.filter((id) => id !== m.id);
      leftovers = leftovers.filter((l) => l.id !== m.id);
      const hi = held.indexOf(m.id);
      if (hi >= 0) held.splice(hi, 1);
      target.op.memberIds.push(m.id);
      notes.push(`kept group "${group}" together`);
    }
  }
  const nonEmpty = ops.filter((op) => op.memberIds.length);

  // Deterministic placement for anyone the model missed. Friends who arrived as a group
  // move as one unit (split into 4s only if the group itself is bigger than a team).
  if (leftovers.length) {
    if (source === 'ai') notes.push(`${leftovers.length} unplaced by AI`);
    // A single straggler with time to spare can wait for the next bucket.
    if (allowHoldBack && leftovers.length === 1 && now - Date.parse(leftovers[0].arrivedAt) < maxWaitMs) {
      held.push(leftovers[0].id);
      leftovers = [];
    }
    let units = toUnits(leftovers);
    // Fill existing open teams first (including ones the plan already touched). With only a
    // couple of stragglers, also top up the AI's new teams rather than leave someone alone.
    const fewStragglers = leftovers.length < 3;
    for (const unit of [...units]) {
      const candidates = [
        ...nonEmpty.filter((op) => op.kind === 'join' || fewStragglers),
        ...open
          .filter((t) => !nonEmpty.some((op) => op.teamId === t.id))
          .map((t) => ({ kind: 'join', teamId: t.id, memberIds: [], rationale: 'Had an open slot.', source: 'fallback' })),
      ];
      const fit = candidates.find(
        (op) => sizeOf(op) + unit.length <= TEAM_MAX && unit.every((p) => !conflicts(p, membersOf(op))),
      );
      if (fit) {
        fit.memberIds.push(...unit.map((p) => p.id));
        if (!nonEmpty.includes(fit)) nonEmpty.push(fit);
        units = units.filter((u) => u !== unit);
      }
    }
    // Then balanced new teams: n people -> ceil(n/4) teams of near-equal size. Place groups
    // first (biggest first), then singles round-robin by skill so each team gets a mix.
    const n = units.reduce((a, u) => a + u.length, 0);
    const buckets = Array.from({ length: Math.ceil(n / TEAM_MAX) }, () => []);
    const target = Math.ceil(n / Math.max(1, buckets.length));
    const place = (unit) => {
      const ok = (b) => b.length + unit.length <= TEAM_MAX && unit.every((p) => !conflicts(p, b));
      let b = buckets.filter(ok).sort((x, y) => x.length - y.length)[0];
      if (!b) buckets.push((b = []));
      b.push(...unit);
    };
    units.filter((u) => u.length > 1).sort((a, b) => b.length - a.length).forEach(place);
    const singles = diversityOrder(units.filter((u) => u.length === 1).map((u) => u[0]));
    for (const p of singles) {
      // Prefer buckets still below the balanced target, then any that fits.
      const fits = buckets.filter((b) => b.length < TEAM_MAX && !conflicts(p, b));
      const b = fits.filter((x) => x.length < target).sort((x, y) => x.length - y.length)[0] || fits[0];
      if (b) b.push(p);
      else buckets.push([p]);
    }
    for (const members of buckets.filter((b) => b.length)) {
      const ids = members.map((p) => p.id);
      nonEmpty.push({
        kind: 'new',
        memberIds: ids,
        ...fallbackProject(ids),
        rationale: 'Grouped automatically for a mix of skills.',
        source: 'fallback',
      });
    }
  }

  return { ops: nonEmpty, held, notes: [...new Set(notes)] };
}

function toUnits(people) {
  const units = [];
  const byGroup = new Map();
  for (const p of people) {
    if (!p.group) units.push([p]);
    else byGroup.set(p.group, [...(byGroup.get(p.group) || []), p]);
  }
  for (const g of byGroup.values()) for (let i = 0; i < g.length; i += TEAM_MAX) units.push(g.slice(i, i + TEAM_MAX));
  return units;
}

// Interleave people by primary skill so round-robin bucketing spreads skills out.
function diversityOrder(people) {
  const bySkill = new Map();
  for (const p of people) {
    const k = p.skills?.[0] || 'other';
    bySkill.set(k, [...(bySkill.get(k) || []), p]);
  }
  const lanes = [...bySkill.values()];
  const out = [];
  while (lanes.some((l) => l.length)) for (const l of lanes) if (l.length) out.push(l.shift());
  return out;
}

function fallbackProject(members, s) {
  const pitcher = members.find((m) => m.idea && m.openness !== 'any') || members.find((m) => m.idea);
  const spark = s.ideaFeed.find((i) => members.some((m) => m.id === i.participantId));
  const names = members.map((m) => m.name.split(' ')[0]);
  if (pitcher) {
    return {
      teamName: `Team ${names[0]}`,
      project: {
        title: pitcher.idea.split(/[.\n]/)[0].slice(0, 60),
        pitch: pitcher.idea,
        prizeCategory: pitcher.prizeInterests?.[0] || '',
        techStack: [],
        firstSteps: ['Agree on the smallest demoable version', 'Split work by skill', 'Check in at lunch'],
      },
    };
  }
  return {
    teamName: `Team ${names[0]}`,
    project: spark
      ? { title: spark.title, pitch: spark.pitch, prizeCategory: spark.prizeCategory, techStack: [], firstSteps: [] }
      : { title: 'Pick an idea together', pitch: 'Browse the idea feed and choose one that fits everyone.', prizeCategory: '', techStack: [], firstSteps: [] },
  };
}

function addToTeam(team, p) {
  team.memberIds.push(p.id);
  team.responses[p.id] = 'pending';
  team.status = 'proposed';
  p.teamId = team.id;
  p.status = 'proposed';
  store.save();
}

export function applyPlan({ ops }) {
  const s = store.getState();
  for (const op of ops) {
    if (op.kind === 'join') {
      const team = s.teams[op.teamId];
      for (const id of op.memberIds) addToTeam(team, s.participants[id]);
      team.history = [...(team.history || []), `${hhmm()} added ${op.memberIds.map((id) => s.participants[id].name).join(', ')}: ${op.rationale}`];
    } else {
      const team = createTeam({
        name: op.teamName || `Team ${s.participants[op.memberIds[0]].name.split(' ')[0]}`,
        project: op.project,
        rationale: op.rationale,
        source: op.source,
      });
      for (const id of op.memberIds) addToTeam(team, s.participants[id]);
    }
  }
  store.save();
}

export function createTeam({ name, project, rationale, source, isSolo = false }) {
  const s = store.getState();
  const id = store.newId('team');
  s.teams[id] = {
    id,
    name,
    project,
    rationale,
    source,
    isSolo,
    memberIds: [],
    responses: {},
    status: 'proposed',
    acceptingMembers: true,
    createdAt: new Date().toISOString(),
    history: [],
  };
  return s.teams[id];
}
