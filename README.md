# Hackathon Teamer

Live, AI-assisted team formation for a one-day hackathon. Participants scan a QR code,
fill a 2-minute phone form, and land on a live board showing project ideas and proposed
teams. The board updates as people keep arriving through the morning.

```
QR poster ──► /join (phone form) ──► /board (live: your status, teams, waiting pool, idea feed)
                       │                              ▲
                       ▼                              │ Server-Sent Events
                 Express server ── Gemini ────────────┘
                 (JSON file store)   • scrape prize categories from the event page
                                     • 2 idea sparks per person, right at check-in
                                     • team matching + project proposal per bucket
```

## Quick start

```bash
npm install
cp .env.example .env        # add GEMINI_API_KEY, set ADMIN_TOKEN and PUBLIC_URL
npm start
```

| Page | Who | What |
|---|---|---|
| `/qr` | Print or project it | QR code for `/join` (`/qr?board` for the board) |
| `/join` | Participants | Check-in form, then redirects to the board |
| `/board` | Everyone | Live teams, waiting pool, idea feed, plus a personal card with accept/decline buttons |
| `/admin` | Organizers | Scrape the event page, edit prize categories, tune batching, form teams now, confirm or dissolve teams, see the log |

Try it without real people: `npm run simulate -- 14 1500` checks in 14 fake
participants, 1.5 s apart. `npm test` runs the matcher's rule tests.

## How streaming formation works

People sit in a **waiting pool** until a bucket fires:

- **Batch trigger:** once `batchSize` (default 8) people are waiting. The AI may hold back up
  to 3 people it thinks would match better with the next arrivals.
- **Time trigger:** once anyone has waited `maxWaitMinutes` (default 15). Everyone waiting is
  placed and nobody is held back, so a quiet stretch never strands anyone.
- **Latecomers** can be slotted into existing teams with open spots (fewer than 4 members and
  not closed by an organizer).
- **Groups:** friends who enter the same group word stay together. If their team has room, a
  late friend joins it automatically.
- **Solo:** people who choose solo get a confirmed team of 1 right away.
- **Decline:** the person goes back to the pool and won't be re-paired with the people they
  just declined.

Gemini proposes the teams, but `validatePlan()` in `src/matcher.js` enforces the hard
rules: sizes 1–4, each person placed exactly once, no invented ids, groups together, no
re-pairing after a decline. Anyone the model misses (or everyone, if Gemini is down or no
key is set) is placed by a rule-based fallback that balances team sizes and mixes skills.

## Data collected

The form asks for: name, contact (shown only to teammates), current role plus detail,
hackathon experience, skills (strongest first), top 2 hobbies, goals for the day, an
optional idea, how attached they are to it (*committed* / *flexible* / *anything*), prize
categories of interest, solo or matched, group word, how long they can stay, and free-text
notes. Contact details and tokens are never sent to Gemini or shown on the public board.

## Deploying for the event

The app is a single Node process with no database, so any small VM or container
works (Fly.io, Render, Railway, a laptop + `cloudflared tunnel`). Set `PUBLIC_URL` to the
public HTTPS address before printing the QR code. State lives in `data/state.json`. Use
**Reset** in `/admin` after a dry run.
