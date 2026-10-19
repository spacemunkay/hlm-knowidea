import { GoogleGenAI, Type } from '@google/genai';

const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

export const geminiEnabled = () => Boolean(ai);
export const geminiModel = () => MODEL;

async function generateJSON({ system, prompt, schema, temperature = 0.7 }) {
  if (!ai) throw new Error('GEMINI_API_KEY not set');
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      systemInstruction: system,
      responseMimeType: 'application/json',
      responseSchema: schema,
      temperature,
    },
  });
  return JSON.parse(res.text);
}

// ---------------------------------------------------------------------------
// 1. Hackathon page -> theme + prize categories
// ---------------------------------------------------------------------------
const eventSchema = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING },
    theme: { type: Type.STRING, description: 'The overall theme / tagline in one sentence. Empty if none.' },
    summary: { type: Type.STRING, description: '2-3 sentence summary useful for ideation (judging criteria, constraints, sponsor tech).' },
    startTime: { type: Type.STRING, description: 'HH:MM 24h if stated, else empty' },
    endTime: { type: Type.STRING, description: 'HH:MM 24h if stated, else empty' },
    prizeCategories: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          description: { type: Type.STRING, description: 'What it rewards, sponsor requirements (e.g. must use X API), prize.' },
        },
        required: ['name', 'description'],
      },
    },
  },
  required: ['name', 'theme', 'summary', 'prizeCategories'],
};

export async function extractEvent(pageText, url) {
  return generateJSON({
    system:
      'You extract structured facts from hackathon web pages. Only report what the page says; do not invent prizes. ' +
      'Include sponsor/track prizes as separate categories. Exclude swag/raffles.',
    prompt: `Source URL: ${url}\n\nPage text:\n"""\n${pageText}\n"""`,
    schema: eventSchema,
    temperature: 0.1,
  });
}

// ---------------------------------------------------------------------------
// 2. Per-participant idea sparks (generated the moment someone checks in)
// ---------------------------------------------------------------------------
const ideaSchema = {
  type: Type.OBJECT,
  properties: {
    ideas: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          pitch: { type: Type.STRING, description: 'One or two sentences, concrete enough to start building.' },
          prizeCategory: { type: Type.STRING, description: 'Exact name of the best-fit prize category, or empty.' },
          neededSkills: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ['title', 'pitch', 'prizeCategory', 'neededSkills'],
      },
    },
  },
  required: ['ideas'],
};

export async function ideaSparks(participant, event, hoursLeft) {
  const out = await generateJSON({
    system: ideationSystem(event, hoursLeft),
    prompt:
      `A participant just checked in. Suggest 2 project ideas that play to their background and interests ` +
      `(if they brought their own idea, make one suggestion a sharpened, scoped version of it).\n\n` +
      JSON.stringify(publicProfile(participant), null, 2),
    schema: ideaSchema,
  });
  return out.ideas.slice(0, 2);
}

// ---------------------------------------------------------------------------
// 3. Team formation for a bucket of waiting participants
// ---------------------------------------------------------------------------
const formationSchema = {
  type: Type.OBJECT,
  properties: {
    teams: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          existingTeamId: { type: Type.STRING, description: 'Set ONLY when adding people to an existing open team; otherwise empty.' },
          memberIds: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Waiting participant ids to place on this team.' },
          teamName: { type: Type.STRING },
          project: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              pitch: { type: Type.STRING },
              prizeCategory: { type: Type.STRING },
              techStack: { type: Type.ARRAY, items: { type: Type.STRING } },
              firstSteps: { type: Type.ARRAY, items: { type: Type.STRING }, description: '3 concrete first-hour steps' },
            },
            required: ['title', 'pitch', 'prizeCategory', 'techStack', 'firstSteps'],
          },
          rationale: { type: Type.STRING, description: 'One or two sentences on why these people fit together and this project.' },
        },
        required: ['memberIds', 'teamName', 'project', 'rationale'],
      },
    },
    holdBack: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Participant ids better served by waiting for the next arrivals. Only allowed when permitted.',
    },
  },
  required: ['teams', 'holdBack'],
};

export async function formTeams({ event, waiting, open, hoursLeft, nowLabel, allowHoldBack }) {
  const prompt = [
    `Current time: ${nowLabel}. Hacking ends at ${event.endTime} (${hoursLeft.toFixed(1)}h left).`,
    '',
    'WAITING PARTICIPANTS (need a team):',
    JSON.stringify(waiting.map(publicProfile), null, 2),
    '',
    'EXISTING TEAMS WITH OPEN SLOTS (you may add waiting people to these instead of forming new teams):',
    JSON.stringify(
      open.map((t) => ({
        id: t.id,
        name: t.name,
        openSlots: 4 - t.memberIds.length,
        project: t.project,
        members: t.members.map(publicProfile),
      })),
      null,
      2,
    ),
    '',
    allowHoldBack
      ? 'You MAY hold back up to 3 participants if they would clearly be better matched with the next arrivals.'
      : 'You may NOT hold anyone back: every waiting participant must be placed on a team.',
  ].join('\n');

  return generateJSON({
    system:
      ideationSystem(event, hoursLeft) +
      `\n\nYou are also the team matchmaker. HARD RULES:
- Team size is 1 to 4 people, counting existing members. Prefer 3-4; avoid teams of 1 unless the person asked to work solo.
- Every waiting participant id appears in exactly one team (or in holdBack if allowed). Never invent ids.
- Participants with teamPreference "solo" get their own team of 1.
- Participants sharing the same "group" value MUST be on the same team.
- Never put someone on a team with anyone listed in their avoidIds.
- If someone's openness is "committed", their idea becomes the team's project; only pair them with people open to other ideas.
- Do not put two "committed" people with different ideas on one team.
SOFT GOALS (in order): complementary skills (someone who can build UI, someone backend/AI, ideally someone who can pitch/design);
align on goals (winning vs learning); mix experience so first-timers have a veteran; shared hobbies or
prize-category interests make a good project hook; respect availableUntil when scoping.
Each project must be scoped to be demoable in the hours remaining and should target a real prize category.`,
    prompt,
    schema: formationSchema,
    temperature: 0.6,
  });
}

// ---------------------------------------------------------------------------
function ideationSystem(event, hoursLeft) {
  const prizes = event.prizeCategories.map((c) => `- ${c.name}: ${c.description}`).join('\n') || '- (none listed)';
  return `You help participants at a one-day hackathon "${event.name}".
Theme: ${event.theme || '(open theme)'}
Details: ${event.summary || '(none)'}
Prize categories:
${prizes}
Teams have about ${Math.max(1, hoursLeft).toFixed(1)} hours of hacking left. Favour ideas that are small, demoable,
specific (not "an app for X"), and that use the strengths of the people involved.`;
}

// Strip private fields (contact, tokens) before anything goes to the model.
export function publicProfile(p) {
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    roleDetail: p.roleDetail,
    experience: p.experience,
    skills: p.skills,
    hobbies: p.hobbies,
    goals: p.goals,
    idea: p.idea,
    openness: p.openness,
    prizeInterests: p.prizeInterests,
    teamPreference: p.teamPreference,
    group: p.group || undefined,
    availableUntil: p.availableUntil,
    notes: p.notes,
    avoidIds: p.avoidIds?.length ? p.avoidIds : undefined,
  };
}
