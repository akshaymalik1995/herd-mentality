import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { WebSocketServer } from "ws";
import { QUESTIONS } from "./questions.js";

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
    deck: buildDeck(), deckPos: 0,
    lastReveal: null,
  };
  rooms.set(code, room);
  return room;
}

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; }

// Play order that rotates through categories so consecutive questions stay varied
// (a plain shuffle of all questions clusters same-category ones together).
function buildDeck() {
  const byCat = new Map();
  QUESTIONS.forEach((q, i) => { if (!byCat.has(q.category)) byCat.set(q.category, []); byCat.get(q.category).push(i); });
  const queues = [...byCat.values()].map((q) => shuffle(q)); // shuffle within each category
  const deck = [];
  while (queues.some((q) => q.length)) {
    shuffle(queues);                                  // random category order each pass
    for (const q of queues) if (q.length) deck.push(q.shift());
  }
  return deck;
}

function drawQuestion(room) {
  if (room.deckPos >= room.deck.length) { room.deck = buildDeck(); room.deckPos = 0; }
  return QUESTIONS[room.deck[room.deckPos++]].question;
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

server.listen(PORT, () => console.log(`Herd Mentality on http://localhost:${PORT}`));
