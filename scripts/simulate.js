// Simulate a morning of arrivals against a running server.
//   node scripts/simulate.js [count=14] [delayMs=1500] [baseUrl=http://localhost:3000]
const [count = 14, delay = 1500, base = 'http://localhost:3000'] = process.argv.slice(2);

const first = ['Ava', 'Ben', 'Chen', 'Dara', 'Eli', 'Farah', 'Gus', 'Hana', 'Ivan', 'Jo', 'Kai', 'Lena', 'Milo', 'Nia', 'Omar', 'Priya', 'Quinn', 'Rosa', 'Sam', 'Tariq'];
const roles = [['Student', 'CS sophomore'], ['Software engineer', 'Backend at a fintech'], ['Designer', 'Product designer'], ['Data / ML', 'ML engineer'], ['Product / Business', 'PM at a startup'], ['Student', 'Bootcamp grad']];
const skills = ['Frontend / web', 'Backend / APIs', 'Mobile', 'AI / ML', 'Data', 'Design / UX', 'Hardware / IoT', 'Pitching / storytelling'];
const hobbies = ['climbing', 'cooking', 'board games', 'running', 'photography', 'gardening', 'music production', 'birding', 'cycling', 'anime'];
const ideas = ['', '', 'An app that turns fridge photos into a week of recipes', '', 'Accessible trail finder for wheelchair users', '', 'AI study buddy that quizzes you from your notes', ''];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const pickN = (a, n) => [...a].sort(() => Math.random() - 0.5).slice(0, n);

for (let i = 0; i < +count; i++) {
  const [role, roleDetail] = pick(roles);
  const idea = pick(ideas);
  const body = {
    name: `${first[i % first.length]} ${String.fromCharCode(65 + (i % 26))}.`,
    contact: `@sim${i}`,
    role, roleDetail,
    experience: pick(['first', 'some', 'some', 'veteran']),
    skills: pickN(skills, 1 + Math.floor(Math.random() * 3)),
    hobbies: pickN(hobbies, 2),
    goals: pickN(['Win a prize', 'Learn something new', 'Meet people', 'Just have fun'], 2),
    idea,
    openness: idea ? pick(['committed', 'flexible']) : 'any',
    teamPreference: Math.random() < 0.07 ? 'solo' : 'match',
    group: i === 3 || i === 4 ? 'pineapple' : '',
  };
  const r = await fetch(`${base}/api/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  console.log(r.status, body.name, body.teamPreference, body.group || '');
  await new Promise((res) => setTimeout(res, +delay));
}
