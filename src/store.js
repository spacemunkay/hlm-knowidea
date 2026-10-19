// Tiny JSON-file store. A single-day event with a few hundred people fits
// comfortably in memory; we persist on every mutation so a restart loses nothing.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = path.resolve('data');
const FILE = path.join(DATA_DIR, 'state.json');

export const TEAM_MIN = 1;
export const TEAM_MAX = 4;

function defaultState() {
  return {
    event: {
      name: 'Hackathon',
      url: process.env.HACKATHON_URL || '',
      theme: '',
      summary: '',
      prizeCategories: [], // [{ name, description }]
      startTime: '09:00',
      endTime: '17:00',
      scrapedAt: null,
    },
    settings: {
      batchSize: 8, // form teams once this many people are waiting
      maxWaitMinutes: 15, // ...or once anyone has waited this long
      autoFormation: true,
    },
    participants: {}, // id -> participant
    teams: {}, // id -> team
    ideaFeed: [], // [{ id, participantId, title, pitch, prizeCategory, createdAt }]
    log: [], // [{ at, msg }]
    lastFormationAt: null,
  };
}

let state = load();

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const base = defaultState();
    return {
      ...base,
      ...raw,
      event: { ...base.event, ...raw.event },
      settings: { ...base.settings, ...raw.settings },
    };
  } catch {
    return defaultState();
  }
}

let saveTimer = null;
export function save() {
  // Coalesce bursts of writes; write atomically via rename.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, FILE);
  }, 50);
}

export function getState() {
  return state;
}

export function resetState({ keepEvent = true } = {}) {
  const fresh = defaultState();
  if (keepEvent) {
    fresh.event = state.event;
    fresh.settings = state.settings;
  }
  state = fresh;
  save();
}

export const newId = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
export const newToken = () => crypto.randomBytes(16).toString('hex');

export function log(msg) {
  state.log.unshift({ at: new Date().toISOString(), msg });
  state.log = state.log.slice(0, 200);
  console.log(`[teamer] ${msg}`);
  save();
}

export function waitingParticipants() {
  return Object.values(state.participants)
    .filter((p) => p.status === 'waiting')
    .sort((a, b) => a.arrivedAt.localeCompare(b.arrivedAt));
}

export function openTeams() {
  return Object.values(state.teams).filter(
    (t) => t.memberIds.length < TEAM_MAX && t.acceptingMembers !== false && !t.isSolo,
  );
}

// Remove a participant from their team (decline / leave). Returns them to the pool if requested.
export function detachFromTeam(p, { backToPool }) {
  const team = p.teamId && state.teams[p.teamId];
  if (team) {
    team.memberIds = team.memberIds.filter((id) => id !== p.id);
    delete team.responses[p.id];
    if (team.memberIds.length === 0) {
      delete state.teams[team.id];
    } else {
      team.status = allAccepted(team) ? 'confirmed' : 'proposed';
    }
    p.declinedTeamIds = [...new Set([...(p.declinedTeamIds || []), team.id])];
    // Their teammates are probably fine together, but avoid re-pairing immediately.
    p.avoidIds = [...new Set([...(p.avoidIds || []), ...team.memberIds])];
  }
  p.teamId = null;
  p.status = backToPool ? 'waiting' : 'left';
  if (backToPool) p.arrivedAt = new Date().toISOString(); // fresh place in the queue
  save();
}

export function allAccepted(team) {
  return team.memberIds.every((id) => team.responses[id] === 'accepted');
}
