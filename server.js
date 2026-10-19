import express from 'express';
import QRCode from 'qrcode';
import * as store from './src/store.js';
import * as gemini from './src/gemini.js';
import * as matcher from './src/matcher.js';
import { fetchPageText } from './src/scrape.js';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public', { extensions: ['html'] }));

// ---------------------------------------------------------------------------
// Live updates via Server-Sent Events. Clients re-fetch state on each ping.
// ---------------------------------------------------------------------------
const clients = new Set();
let broadcastTimer = null;
function broadcast() {
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => {
    for (const res of clients) res.write(`event: update\ndata: ${Date.now()}\n\n`);
  }, 150);
}
matcher.setOnChange(broadcast);

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
});

// ---------------------------------------------------------------------------
// Public state (no contact info, no tokens)
// ---------------------------------------------------------------------------
const boardProfile = (p) => ({
  id: p.id,
  name: p.name,
  role: p.role,
  roleDetail: p.roleDetail,
  experience: p.experience,
  skills: p.skills,
  hobbies: p.hobbies,
  idea: p.idea,
  openness: p.openness,
  status: p.status,
  arrivedAt: p.arrivedAt,
});

function publicState() {
  const s = store.getState();
  const teams = Object.values(s.teams)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((t) => ({
      id: t.id,
      name: t.name,
      project: t.project,
      rationale: t.rationale,
      source: t.source,
      isSolo: t.isSolo,
      status: t.status,
      openSlots: t.isSolo || t.acceptingMembers === false ? 0 : store.TEAM_MAX - t.memberIds.length,
      members: t.memberIds.map((id) => ({ ...boardProfile(s.participants[id]), response: t.responses[id] })),
      createdAt: t.createdAt,
    }));
  return {
    event: s.event,
    settings: s.settings,
    formation: matcher.formationStatus(),
    waiting: store.waitingParticipants().map(boardProfile),
    teams,
    ideaFeed: s.ideaFeed.slice(0, 60).map((i) => ({ ...i, author: s.participants[i.participantId]?.name })),
    counts: {
      participants: Object.values(s.participants).filter((p) => p.status !== 'left').length,
      teams: teams.length,
      confirmed: teams.filter((t) => t.status === 'confirmed').length,
    },
    ai: { enabled: gemini.geminiEnabled(), model: gemini.geminiModel() },
    serverTime: new Date().toISOString(),
  };
}

app.get('/api/state', (req, res) => res.json(publicState()));

app.get('/api/config', (req, res) => {
  const { event } = store.getState();
  res.json({ name: event.name, theme: event.theme, prizeCategories: event.prizeCategories, endTime: event.endTime });
});

// ---------------------------------------------------------------------------
// Check-in
// ---------------------------------------------------------------------------
const str = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const arr = (v, max = 12) => (Array.isArray(v) ? v.map((x) => str(x, 80)).filter(Boolean).slice(0, max) : []);
const oneOf = (v, opts, dflt) => (opts.includes(v) ? v : dflt);

app.post('/api/join', async (req, res) => {
  const b = req.body || {};
  const name = str(b.name, 80);
  const contact = str(b.contact, 120);
  if (!name || !contact) return res.status(400).json({ error: 'Name and contact are required.' });

  const s = store.getState();
  const p = {
    id: store.newId('p'),
    token: store.newToken(),
    name,
    contact,
    role: str(b.role, 40),
    roleDetail: str(b.roleDetail, 120),
    experience: oneOf(b.experience, ['first', 'some', 'veteran'], 'some'),
    skills: arr(b.skills),
    hobbies: arr(b.hobbies, 2),
    goals: arr(b.goals),
    idea: str(b.idea, 1000),
    openness: oneOf(b.openness, ['committed', 'flexible', 'any'], 'any'),
    prizeInterests: arr(b.prizeInterests),
    teamPreference: oneOf(b.teamPreference, ['match', 'solo'], 'match'),
    group: str(b.group, 40).toLowerCase(),
    availableUntil: str(b.availableUntil, 5) || s.event.endTime,
    notes: str(b.notes, 500),
    arrivedAt: new Date().toISOString(),
    status: 'waiting',
    teamId: null,
  };
  s.participants[p.id] = p;
  store.log(`${p.name} checked in.`);

  if (p.teamPreference === 'solo') {
    const team = matcher.createTeam({
      name: `${p.name.split(' ')[0]} (solo)`,
      project: p.idea
        ? { title: p.idea.split(/[.\n]/)[0].slice(0, 60), pitch: p.idea, prizeCategory: p.prizeInterests[0] || '', techStack: [], firstSteps: [] }
        : { title: 'Choosing an idea', pitch: 'See your idea sparks below.', prizeCategory: '', techStack: [], firstSteps: [] },
      rationale: 'Chose to hack solo.',
      source: 'participant',
      isSolo: true,
    });
    team.memberIds.push(p.id);
    team.responses[p.id] = 'accepted';
    team.status = 'confirmed';
    p.teamId = team.id;
    p.status = 'confirmed';
  }
  store.save();
  broadcast();
  res.json({ id: p.id, token: p.token });

  // Async follow-ups: idea sparks ASAP, then see whether a bucket is ready.
  generateSparks(p).finally(broadcast);
  matcher.joinGroupTeams();
  matcher.maybeForm().catch((e) => store.log(`Formation error: ${e.message}`));
});

async function generateSparks(p) {
  if (!gemini.geminiEnabled()) return;
  const s = store.getState();
  try {
    const ideas = await gemini.ideaSparks(p, s.event, matcher.minutesUntilEnd(s.event) / 60);
    for (const idea of ideas) {
      s.ideaFeed.unshift({ id: store.newId('idea'), participantId: p.id, ...idea, createdAt: new Date().toISOString() });
    }
    s.ideaFeed = s.ideaFeed.slice(0, 300);
    const team = p.teamId && s.teams[p.teamId];
    if (team?.isSolo && !p.idea && ideas[0]) {
      team.project = { ...team.project, title: ideas[0].title, pitch: ideas[0].pitch, prizeCategory: ideas[0].prizeCategory };
    }
    store.save();
  } catch (e) {
    store.log(`Idea generation failed for ${p.name}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Participant's own view: teammates' contact info + accept/decline
// ---------------------------------------------------------------------------
function byToken(req, res) {
  const token = req.get('x-participant-token') || req.query.token;
  const p = Object.values(store.getState().participants).find((x) => x.token === token);
  if (!p) res.status(404).json({ error: 'Unknown participant' });
  return p;
}

app.get('/api/me', (req, res) => {
  const p = byToken(req, res);
  if (!p) return;
  const s = store.getState();
  const team = p.teamId && s.teams[p.teamId];
  res.json({
    id: p.id,
    name: p.name,
    status: p.status,
    teamId: p.teamId,
    myResponse: team?.responses[p.id] || null,
    sparks: s.ideaFeed.filter((i) => i.participantId === p.id),
    // Contact details are only shared once you're on a team together.
    teammates: team ? team.memberIds.filter((id) => id !== p.id).map((id) => ({ name: s.participants[id].name, contact: s.participants[id].contact, response: team.responses[id] })) : [],
  });
});

app.post('/api/me/respond', (req, res) => {
  const p = byToken(req, res);
  if (!p) return;
  const s = store.getState();
  const team = p.teamId && s.teams[p.teamId];
  const action = req.body?.action;
  if (action === 'accept' && team) {
    team.responses[p.id] = 'accepted';
    p.status = 'confirmed';
    if (store.allAccepted(team)) {
      team.status = 'confirmed';
      store.log(`Team "${team.name}" confirmed.`);
    }
    store.save();
  } else if (action === 'decline' && team) {
    store.log(`${p.name} declined "${team.name}" and returned to the pool.`);
    store.detachFromTeam(p, { backToPool: true });
    matcher.maybeForm().catch(() => {});
  } else if (action === 'leave') {
    store.log(`${p.name} left the event.`);
    store.detachFromTeam(p, { backToPool: false });
  } else {
    return res.status(400).json({ error: 'Invalid action' });
  }
  broadcast();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// QR code for the check-in form
// ---------------------------------------------------------------------------
app.get('/qr.svg', async (req, res) => {
  const target = req.query.to === 'board' ? `${PUBLIC_URL}/board` : `${PUBLIC_URL}/join`;
  res.type('image/svg+xml').send(await QRCode.toString(target, { type: 'svg', margin: 1, width: 600 }));
});
app.get('/api/public-url', (req, res) => res.json({ url: PUBLIC_URL }));

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
const admin = express.Router();
admin.use((req, res, next) => (req.get('x-admin-token') === ADMIN_TOKEN ? next() : res.status(401).json({ error: 'Bad admin token' })));

admin.get('/state', (req, res) => {
  const s = store.getState();
  res.json({ ...publicState(), log: s.log.slice(0, 80), participants: Object.values(s.participants).map(({ token, ...p }) => p) });
});

admin.post('/scrape', async (req, res) => {
  const s = store.getState();
  const url = str(req.body?.url, 500) || s.event.url;
  const pasted = str(req.body?.text, 60000);
  if (!url && !pasted) return res.status(400).json({ error: 'Provide a URL or pasted page text.' });
  if (!gemini.geminiEnabled()) return res.status(400).json({ error: 'GEMINI_API_KEY is not set; edit the event details manually.' });
  try {
    const text = pasted || (await fetchPageText(url));
    const ev = await gemini.extractEvent(text, url || '(pasted)');
    s.event = {
      ...s.event,
      url,
      name: ev.name || s.event.name,
      theme: ev.theme,
      summary: ev.summary,
      prizeCategories: ev.prizeCategories,
      startTime: ev.startTime || s.event.startTime,
      endTime: ev.endTime || s.event.endTime,
      scrapedAt: new Date().toISOString(),
    };
    store.log(`Scraped event page: ${ev.prizeCategories.length} prize categories.`);
    broadcast();
    res.json(s.event);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

admin.put('/event', (req, res) => {
  const s = store.getState();
  const b = req.body || {};
  s.event = {
    ...s.event,
    name: str(b.name, 120) || s.event.name,
    theme: str(b.theme, 500),
    summary: str(b.summary, 2000),
    startTime: str(b.startTime, 5) || s.event.startTime,
    endTime: str(b.endTime, 5) || s.event.endTime,
    prizeCategories: Array.isArray(b.prizeCategories)
      ? b.prizeCategories.map((c) => ({ name: str(c.name, 120), description: str(c.description, 600) })).filter((c) => c.name)
      : s.event.prizeCategories,
  };
  store.save();
  broadcast();
  res.json(s.event);
});

admin.put('/settings', (req, res) => {
  const s = store.getState();
  const b = req.body || {};
  const clamp = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : d);
  s.settings = {
    batchSize: clamp(b.batchSize, 2, 40, s.settings.batchSize),
    maxWaitMinutes: clamp(b.maxWaitMinutes, 1, 120, s.settings.maxWaitMinutes),
    autoFormation: typeof b.autoFormation === 'boolean' ? b.autoFormation : s.settings.autoFormation,
  };
  store.save();
  broadcast();
  matcher.maybeForm().catch(() => {});
  res.json(s.settings);
});

admin.post('/form-now', async (req, res) => {
  await matcher.runFormation({ reason: 'organizer', allowHoldBack: false });
  broadcast();
  res.json({ ok: true });
});

admin.post('/team/:id/:action', (req, res) => {
  const s = store.getState();
  const team = s.teams[req.params.id];
  if (!team) return res.status(404).json({ error: 'No such team' });
  if (req.params.action === 'confirm') {
    for (const id of team.memberIds) {
      team.responses[id] = 'accepted';
      s.participants[id].status = 'confirmed';
    }
    team.status = 'confirmed';
  } else if (req.params.action === 'toggle-open') {
    team.acceptingMembers = team.acceptingMembers === false;
  } else if (req.params.action === 'dissolve') {
    for (const id of [...team.memberIds]) store.detachFromTeam(s.participants[id], { backToPool: true });
  } else return res.status(400).json({ error: 'Unknown action' });
  store.log(`Organizer: ${req.params.action} "${team.name}".`);
  store.save();
  broadcast();
  res.json({ ok: true });
});

admin.post('/participant/:id/remove', (req, res) => {
  const p = store.getState().participants[req.params.id];
  if (!p) return res.status(404).json({ error: 'No such participant' });
  store.detachFromTeam(p, { backToPool: false });
  store.log(`Organizer removed ${p.name}.`);
  broadcast();
  res.json({ ok: true });
});

admin.post('/reset', (req, res) => {
  store.resetState({ keepEvent: true });
  store.log('Event data reset (event details kept).');
  broadcast();
  res.json({ ok: true });
});

app.use('/api/admin', admin);

// Friendly routes
app.get('/', (req, res) => res.redirect('/board'));

// Time-based bucket trigger.
setInterval(() => matcher.maybeForm().catch((e) => store.log(`Formation error: ${e.message}`)), 20000);
setInterval(broadcast, 60000); // keep countdowns fresh

app.listen(PORT, () => {
  console.log(`Hackathon teamer on ${PUBLIC_URL}`);
  console.log(`  Check-in:  ${PUBLIC_URL}/join`);
  console.log(`  Board:     ${PUBLIC_URL}/board`);
  console.log(`  QR poster: ${PUBLIC_URL}/qr`);
  console.log(`  Admin:     ${PUBLIC_URL}/admin   (ADMIN_TOKEN${ADMIN_TOKEN === 'change-me' ? ' is the default — change it!' : ' set'})`);
  console.log(`  AI:        ${gemini.geminiEnabled() ? `Gemini (${gemini.geminiModel()})` : 'disabled — set GEMINI_API_KEY (fallback matching in use)'}`);

  // First boot with HACKATHON_URL set: scrape it once so the form shows prize categories.
  const { event } = store.getState();
  if (event.url && !event.scrapedAt && gemini.geminiEnabled()) {
    fetchPageText(event.url)
      .then((text) => gemini.extractEvent(text, event.url))
      .then((ev) => {
        Object.assign(event, { ...ev, startTime: ev.startTime || event.startTime, endTime: ev.endTime || event.endTime, scrapedAt: new Date().toISOString() });
        store.log(`Scraped ${event.url}: ${ev.prizeCategories.length} prize categories.`);
        broadcast();
      })
      .catch((e) => store.log(`Initial scrape failed: ${e.message}`));
  }
});
