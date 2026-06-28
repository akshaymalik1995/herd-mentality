# Herd Mentality 🐄

Online multiplayer party game. Everyone answers the same question; match the
majority to score. Give a unique answer and you're stuck with the **Pink Cow** —
and you can't win while holding it. First to 8 points wins.

Host on a big screen, players join from their phones with a 4-letter room code.

## Run locally

```bash
npm install
npm start            # http://localhost:3000
```

Open the URL on a laptop/TV → **Create a room**. Players open the same URL on
their phones and enter the code.

## Test

```bash
node test-e2e.mjs    # adversarial end-to-end suite (no server needed; it spawns its own)
node bots.mjs <CODE> 6   # mock 6 players into a room you created
```

## Stack

Node `http` + `ws`, vanilla HTML/JS, in-memory game state. No database, no build
step. One server file (`server.js`), one page (`public/index.html`), questions in
`questions.js`.

## Deploy

`render.yaml` is included — connect the repo on [Render](https://render.com)
(free Web Service). Note: the free tier sleeps after ~15 min idle, so the first
visitor after a quiet spell waits ~30s for cold start.
