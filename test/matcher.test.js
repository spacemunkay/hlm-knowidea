import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from '../src/matcher.js';

const now = Date.parse('2026-10-19T10:00:00Z');
const mk = (id, extra = {}) => ({ id, name: id.toUpperCase(), skills: ['Backend / APIs'], arrivedAt: new Date(now - 60000).toISOString(), ...extra });
const opts = (waiting, open = [], more = {}) => ({
  waiting, open, allowHoldBack: false, maxWaitMs: 15 * 60000, now,
  fallbackProject: () => ({ teamName: 'FB', project: { title: 'fallback' } }), ...more,
});
const placed = (r) => r.ops.flatMap((o) => o.memberIds);
const sizes = (r, open = []) => r.ops.map((o) => o.memberIds.length + (o.kind === 'join' ? open.find((t) => t.id === o.teamId).memberIds.length : 0));

test('everyone placed exactly once, teams within 1..4', () => {
  const w = 'abcdefghij'.split('').map((c) => mk(c));
  const plan = { teams: [{ memberIds: ['a', 'b', 'c', 'd', 'e', 'f'], teamName: 'Too big', project: {} }, { memberIds: ['a', 'zz'], project: {} }], holdBack: [] };
  const r = validatePlan(plan, opts(w));
  assert.deepEqual(placed(r).sort(), w.map((p) => p.id).sort());
  for (const n of sizes(r)) assert.ok(n >= 1 && n <= 4, `size ${n}`);
});

test('model failure (empty plan) -> balanced fallback teams', () => {
  const w = Array.from({ length: 9 }, (_, i) => mk('p' + i));
  const r = validatePlan({ teams: [], holdBack: [] }, opts(w));
  assert.deepEqual(sizes(r).sort(), [3, 3, 3]);
});

test('hold-back only when allowed, max 3, never long waiters', () => {
  const w = [mk('a'), mk('b'), mk('c', { arrivedAt: new Date(now - 20 * 60000).toISOString() }), mk('d'), mk('e')];
  const plan = { teams: [{ memberIds: [], project: {} }], holdBack: ['a', 'b', 'c', 'd', 'e'] };
  const r1 = validatePlan(plan, opts(w, [], { allowHoldBack: true }));
  assert.equal(r1.held.length, 3);
  assert.ok(!r1.held.includes('c'));
  const r2 = validatePlan(plan, opts(w));
  assert.equal(r2.held.length, 0);
  assert.equal(placed(r2).length, 5);
});

test('existing team capacity respected', () => {
  const open = [{ id: 't1', memberIds: ['x', 'y', 'z'], members: [mk('x'), mk('y'), mk('z')] }];
  const w = [mk('a'), mk('b')];
  const r = validatePlan({ teams: [{ existingTeamId: 't1', memberIds: ['a', 'b'], project: {} }], holdBack: [] }, opts(w, open));
  assert.deepEqual(sizes(r, open).sort(), [1, 4]);
});

test('groups kept together', () => {
  const w = [mk('a', { group: 'g' }), mk('b', { group: 'g' }), mk('c'), mk('d')];
  const plan = { teams: [{ memberIds: ['a', 'c'], project: {} }, { memberIds: ['b', 'd'], project: {} }], holdBack: [] };
  const r = validatePlan(plan, opts(w));
  const team = r.ops.find((o) => o.memberIds.includes('a'));
  assert.ok(team.memberIds.includes('b'));
  assert.deepEqual(placed(r).sort(), ['a', 'b', 'c', 'd']);
});

test('declined pairs not re-matched', () => {
  const w = [mk('a', { avoidIds: ['b'] }), mk('b'), mk('c'), mk('d'), mk('e')];
  const plan = { teams: [{ memberIds: ['a', 'b', 'c'], project: {} }, { memberIds: ['d', 'e'], project: {} }], holdBack: [] };
  const r = validatePlan(plan, opts(w));
  const ta = r.ops.find((o) => o.memberIds.includes('a'));
  assert.ok(!ta.memberIds.includes('b'));
  assert.equal(placed(r).length, 5);
});

test('fallback keeps groups together and stays balanced', () => {
  const w = [mk('a'), mk('b'), mk('c'), mk('d', { group: 'g' }), mk('e', { group: 'g' }), mk('f'), mk('g'), mk('h')];
  const r = validatePlan({ teams: [], holdBack: [] }, opts(w));
  const team = r.ops.find((o) => o.memberIds.includes('d'));
  assert.ok(team.memberIds.includes('e'));
  assert.deepEqual(sizes(r).sort(), [4, 4]);
});

test('fallback: 5 people -> 3+2, not 4+1', () => {
  const r = validatePlan({ teams: [], holdBack: [] }, opts(Array.from({ length: 5 }, (_, i) => mk('q' + i))));
  assert.deepEqual(sizes(r).sort(), [2, 3]);
});
