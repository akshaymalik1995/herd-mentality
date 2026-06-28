import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { QUESTIONS, CATEGORIES } from "./questions.js";

const PORT = process.env.PORT || 3000;
const WIN_SCORE = +process.env.WIN_SCORE || 8;
const GRACE_MS = +process.env.GRACE_MS || 45000; // keep a disconnected player this long so a refresh can reconnect

// --- static file serving (just index.html + its inline assets) ---
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer(async (req, res) => {
  let path = req.url.split("?")[0]; // drop query (e.g. ?room=CODE) before resolving the file
  if (path === "/") path = "/index.html";
  try {
    const body = await readFile(new URL("./public" + path, import.meta.url));
    const ext = path.slice(path.lastIndexOf("."));
    res.writeHead(200, { "Content-Type": TYPES[ext] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

// Friendly, family-safe animal avatars — one per player per room (30 > max 20 players).
const EMOJI = ["🐮", "🐷", "🐰", "🦊", "🐱", "🐶", "🐼", "🐨", "🐯", "🦁", "🐸", "🐵", "🐔", "🐧", "🦉", "🦄", "🐢", "🐝", "🐙", "🦋", "🐳", "🐬", "🦒", "🦓", "🦔", "🐤", "🐠", "🦅", "🦜", "🐌"];

// --- game state ---
const rooms = new Map(); // code -> room
const newCode = () => {
  let c;
  do { c = Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.floor(Math.random() * 24)]).join(""); }
  while (rooms.has(c));
  return c;
};

function makeRoom() {
  const code = newCode();
  const room = {
    code, leader: null, phase: "lobby",
    players: new Map(), // id -> {id,name,ws,score,cow}
    question: null, answers: new Map(), // id -> text
    round: 0, // questions presented this game
    buckets: [], bucketSeq: 0, // host-mergeable answer groups during review
    pools: buildPools(), catWeights: new Map(CATEGORIES.map((c) => [c, 1])), recent: [], pending: null,
    lastReveal: null,
  };
  rooms.set(code, room);
  return room;
}

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; }

// --- adaptive question selection ---------------------------------------------
// Categories are slot-machine arms. Every room starts neutral; after each round we
// reward the category just played (good answer-spread = up, skipped/boring = down)
// and bias the next draw toward what THIS table enjoys. Pure in-memory per room — no
// DB. A short recency window keeps a hot category from clustering back-to-back.
const EXPLORE = 0.15; // chance to pick a random category anyway, so nothing gets stuck
const ALPHA = 0.4;    // how fast a weight moves toward the latest signal
const WFLOOR = 0.05;  // a category can dip but never die — exploration can revive it

const CAT_INDEX = (() => { // category -> its question indices, computed once
  const m = new Map();
  QUESTIONS.forEach((q, i) => { if (!m.has(q.category)) m.set(q.category, []); m.get(q.category).push(i); });
  return m;
})();

export function buildPools() {
  const m = new Map();
  for (const c of CATEGORIES) m.set(c, shuffle([...CAT_INDEX.get(c)])); // shuffled copy per category
  return m;
}

// Get a category's unused-question pool, reshuffling it when exhausted. Per-category
// refill (not global) so a small, heavily-favoured category never starves mid-game.
function poolFor(room, c) {
  let p = room.pools.get(c);
  if (!p || !p.length) { p = shuffle([...CAT_INDEX.get(c)]); room.pools.set(c, p); }
  return p;
}

function pickCategory(room) {
  const win = Math.min(2, CATEGORIES.length - 1);
  const recent = room.recent.slice(-win);
  const pool = CATEGORIES.filter((c) => !recent.includes(c)); // avoid the last couple, for variety
  const choices = pool.length ? pool : CATEGORIES;
  if (Math.random() < EXPLORE) return choices[Math.floor(Math.random() * choices.length)];
  // Square the weights so a clear favourite actually dominates the draw (1.0 vs 0.5
  // becomes 4:1, not 2:1) — the EMA stays gentle, only the *selection* is sharpened.
  const weights = choices.map((c) => (room.catWeights.get(c) ?? 1) ** 2);
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < choices.length; i++) { r -= weights[i]; if (r <= 0) return choices[i]; }
  return choices[choices.length - 1];
}

export function drawQuestion(room) {
  const cat = pickCategory(room);
  const i = poolFor(room, cat).pop();
  room.pending = { i, category: cat }; // remember what's in play, to reward it once the round resolves
  room.recent.push(cat);
  if (room.recent.length > 8) room.recent.shift(); // bounded history
  return QUESTIONS[i].question;
}

// Move the played category's weight toward `reward` (0 bad … 1 great). Skip -> 0;
// scoring -> the answer-spread reward below. No-op if nothing is pending.
export function rewardCategory(room, reward) {
  const pend = room.pending; if (!pend) return;
  const w = room.catWeights.get(pend.category) ?? 1;
  room.catWeights.set(pend.category, Math.max(WFLOOR, w * (1 - ALPHA) + ALPHA * reward));
  room.pending = null;
}

// The fun is in the spread: a clear majority with an odd-one-out (cow risk) is peak;
// everyone-identical or everyone-unique is a dud. Null when too few answered to judge.
export function spreadReward(buckets) {
  const n = buckets.reduce((s, b) => s + b.members.length, 0);
  if (n < 2) return null;
  const distinct = buckets.length;
  if (distinct === 1) return 0.25;   // one shared answer — boring, no cow at stake
  if (distinct === n) return 0.25;   // all different — no herd forms
  const lone = buckets.filter((b) => b.members.length === 1).length;
  return lone === 1 ? 1.0 : 0.8;     // majority + a lone straggler = the good stuff
}

const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "");

// Group answers by normalised text into buckets the host can then merge by hand.
function buildBuckets(room) {
  room.bucketSeq = 0;
  room.buckets = [];
  const map = new Map(); // normKey -> bucket
  for (const [id, text] of room.answers) {
    const k = norm(text);
    let b = map.get(k);
    if (!b) { b = { id: room.bucketSeq++, members: [] }; map.set(k, b); room.buckets.push(b); }
    b.members.push({ playerId: id, text: text.trim() });
  }
}
const bucketLabel = (b) => [...new Set(b.members.map((m) => m.text))].join(", ");

// Score from the (possibly host-merged) buckets, assign the cow, check for a win.
function scoreFromBuckets(room) {
  const groups = room.buckets;
  const max = Math.max(0, ...groups.map((g) => g.members.length));
  const winners = [];
  if (max >= 2) {
    for (const g of groups) {
      if (g.members.length === max) {
        winners.push(bucketLabel(g));
        for (const m of g.members) { const p = room.players.get(m.playerId); if (p) p.score++; }
      }
    }
  }
  // pink cow: exactly one lone (unique) answer this round
  const lone = groups.filter((g) => g.members.length === 1);
  if (lone.length === 1) {
    for (const p of room.players.values()) p.cow = false;
    const p = room.players.get(lone[0].members[0].playerId);
    if (p) p.cow = true;
  }
  room.lastReveal = {
    question: room.question,
    groups: groups.map((g) => ({ answer: bucketLabel(g), count: g.members.length, names: g.members.map((m) => tag(room, m.playerId)).filter(Boolean) }))
      .sort((a, b) => b.count - a.count),
    majority: winners,
  };
  const sr = spreadReward(room.buckets); if (sr !== null) rewardCategory(room, sr); // feed the adaptive selector
  // win check: >= WIN_SCORE and not holding the cow
  const champ = [...room.players.values()].find((p) => p.score >= WIN_SCORE && !p.cow);
  room.phase = champ ? "won" : "reveal";
  room.winner = champ ? champ.name : null;
}

// --- view (everyone is a player; the leader also gets the round controls) ---
function playerView(room, p) {
  const isLeader = room.leader === p.id;
  return {
    role: "player", isLeader, code: room.code, phase: room.phase, you: p.name, youEmoji: p.emoji, token: p.token,
    score: p.score, cow: p.cow, answered: room.answers.has(p.id),
    question: room.phase === "lobby" ? null : room.question,
    round: room.round,
    players: [...room.players.values()].map((x) => ({ name: x.name, emoji: x.emoji, answered: room.answers.has(x.id) })),
    answeredCount: room.answers.size, total: room.players.size,
    // everyone sees the grouped answers during review (so the whole group can argue merges)
    review: room.phase === "review" ? room.buckets.map((b) => ({ id: b.id, label: bucketLabel(b), count: b.members.length, names: b.members.map((m) => tag(room, m.playerId)).filter(Boolean) })) : null,
    scoreboard: scoreboard(room), reveal: room.phase === "reveal" || room.phase === "won" ? room.lastReveal : null,
    winner: room.winner || null,
  };
}
const scoreboard = (room) => [...room.players.values()].map((p) => ({ name: p.name, emoji: p.emoji, score: p.score, cow: p.cow })).sort((a, b) => b.score - a.score);
const tag = (room, id) => { const p = room.players.get(id); return p ? `${p.emoji} ${p.name}` : null; }; // "🐮 Aarav"

function broadcast(room) {
  for (const p of room.players.values()) if (p.ws && p.ws.readyState === 1) send(p.ws, "state", playerView(room, p));
}
const send = (ws, t, d) => ws.send(JSON.stringify({ t, ...d }));

// --- websocket wiring ---
const wss = new WebSocketServer({ server });
let nextId = 1;
wss.on("connection", (ws) => {
  ws.meta = null; // {room, role, id}
  ws.on("message", (buf) => {
    let m; try { m = JSON.parse(buf); } catch { return; }
    handle(ws, m);
  });
  ws.on("close", () => {
    const meta = ws.meta;
    if (!meta) return;
    const room = rooms.get(meta.room);
    if (!room) return;
    const p = room.players.get(meta.id);
    if (!p || p.ws !== ws) return; // already gone, or a resumed socket superseded this one
    p.online = false; p.ws = null;
    // keep leadership with them while away — a refresh reconnects in ~1s and should not lose control.
    // If they never come back, removePlayer (below) hands it off when the grace window elapses.
    p.leaveTimer = setTimeout(() => removePlayer(room, meta.id), GRACE_MS);
    broadcast(room);
  });
});

// Once everyone has answered, jump straight to the review/scoring step (no need
// for the leader to press Reveal). The manual Reveal button still covers the case
// where someone never answers.
function maybeAutoReveal(room) {
  if (room.phase === "asking" && room.players.size > 0 && room.answers.size >= room.players.size) {
    buildBuckets(room);
    room.phase = "review";
  }
}

function addPlayer(room, ws, rawName) {
  const base = (rawName || "").trim().slice(0, 20) || "Player";
  const taken = new Set([...room.players.values()].map((p) => p.name));
  let name = base, n = 2;
  while (taken.has(name)) name = `${base} (${n++})`; // keep names unique for humans
  const usedEmoji = new Set([...room.players.values()].map((p) => p.emoji));
  const emoji = EMOJI.find((e) => !usedEmoji.has(e)) || "🐾";
  const id = nextId++;
  room.players.set(id, { id, name, emoji, ws, score: 0, cow: false, token: crypto.randomUUID(), online: true, leaveTimer: null });
  ws.meta = { room: room.code, role: "player", id };
  return id;
}

// Remove a player for good (explicit leave, or grace window elapsed after a disconnect).
function removePlayer(room, id) {
  const p = room.players.get(id);
  if (!p) return;
  if (p.leaveTimer) clearTimeout(p.leaveTimer);
  room.players.delete(id);
  room.answers.delete(id);
  if (room.players.size === 0) { rooms.delete(room.code); return; }
  if (room.leader === id) { const o = [...room.players.values()].find((p) => p.online); room.leader = (o || room.players.values().next().value).id; } // prefer an online player
  maybeAutoReveal(room);
  broadcast(room);
}

function handle(ws, m) {
  if (m.t === "create") { // creator is the first player AND the leader
    const room = makeRoom();
    room.leader = addPlayer(room, ws, m.name);
    broadcast(room);
    return;
  }
  if (m.t === "join") {
    const room = rooms.get((m.code || "").toUpperCase());
    if (!room) return send(ws, "error", { msg: "No room with that code." });
    addPlayer(room, ws, m.name);
    broadcast(room);
    return;
  }
  if (m.t === "resume") { // reconnect after a refresh/drop, keeping identity + score
    const room = rooms.get((m.code || "").toUpperCase());
    if (!room) return send(ws, "error", { msg: "That game has ended.", resume: true });
    const p = [...room.players.values()].find((x) => x.token === m.token);
    if (!p) return send(ws, "error", { msg: "Your session expired.", resume: true });
    if (p.leaveTimer) { clearTimeout(p.leaveTimer); p.leaveTimer = null; }
    p.ws = ws; p.online = true;
    ws.meta = { room: room.code, role: "player", id: p.id };
    broadcast(room);
    return;
  }
  const meta = ws.meta;
  if (!meta) return;
  const room = rooms.get(meta.room);
  if (!room) return;

  if (m.t === "leave") { removePlayer(room, meta.id); return; } // explicit end-session

  // anyone can answer
  if (m.t === "answer" && room.phase === "asking") {
    const text = (m.text || "").trim().slice(0, 60);
    if (text) room.answers.set(meta.id, text);
    maybeAutoReveal(room);
    broadcast(room);
    return;
  }
  // only the leader drives the round
  if (room.leader !== meta.id) return;
  if (m.t === "start" || m.t === "next") {
    if (room.players.size < 1) return;
    room.question = drawQuestion(room);
    room.answers.clear();
    room.round = m.t === "start" ? 1 : room.round + 1; // skip doesn't advance the count
    room.phase = "asking";
    broadcast(room);
  } else if (m.t === "skip") {
    if (room.phase !== "asking") return;
    rewardCategory(room, 0); // a skip is a strong down-vote for that category
    room.question = drawQuestion(room); // swap in a fresh question, same round
    room.answers.clear();
    broadcast(room);
  } else if (m.t === "reveal") {
    if (room.phase !== "asking") return;
    buildBuckets(room);
    room.phase = "review"; // leader curates groups before scoring
    broadcast(room);
  } else if (m.t === "merge") {
    if (room.phase !== "review") return;
    const ids = Array.isArray(m.ids) ? m.ids : [m.a, m.b]; // accept a list or a pair
    const idxs = [...new Set(ids.map((id) => room.buckets.findIndex((b) => b.id === id)).filter((i) => i >= 0))];
    if (idxs.length < 2) return;
    const target = Math.min(...idxs);
    const rest = idxs.filter((i) => i !== target).sort((a, b) => b - a); // splice high->low
    for (const i of rest) room.buckets[target].members.push(...room.buckets[i].members);
    for (const i of rest) room.buckets.splice(i, 1);
    broadcast(room);
  } else if (m.t === "regroup") {
    if (room.phase !== "review") return;
    buildBuckets(room); // undo all merges
    broadcast(room);
  } else if (m.t === "score") {
    if (room.phase !== "review") return;
    scoreFromBuckets(room);
    broadcast(room);
  } else if (m.t === "restart") {
    for (const p of room.players.values()) { p.score = 0; p.cow = false; }
    room.phase = "lobby"; room.question = null; room.answers.clear(); room.winner = null; room.lastReveal = null; room.round = 0;
    broadcast(room);
  }
}

// Only listen when run directly (`node server.js`); stays importable for unit tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) server.listen(PORT, () => console.log(`Herd Mentality on http://localhost:${PORT}`));
