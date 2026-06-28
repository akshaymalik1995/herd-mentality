// Fake players for testing. Usage: node bots.mjs <ROOMCODE> [count] [host]
// Bots join a room you created in the browser and auto-answer every round.
// A shared answer pool means herds actually form (so scoring/cow look real).
import { WebSocket as WS } from "ws";

const code = (process.argv[2] || "").toUpperCase();
const count = Math.min(20, Math.max(1, parseInt(process.argv[3] || "6", 10)));
const host = process.argv[4] || "localhost:3000";
if (code.length !== 4) { console.error("Usage: node bots.mjs <ROOMCODE> [count] [host]"); process.exit(1); }

// Small pool -> bots collide often -> majorities + the odd one out happen naturally.
const POOL = ["red", "blue", "green", "samosa", "momos", "chai", "Monday", "dog", "pizza", "mango", "cricket", "Diwali"];
const NAMES = ["Aarav", "Diya", "Kabir", "Meera", "Rohan", "Saanvi", "Vivaan", "Ananya", "Ishaan", "Tara", "Arjun", "Nisha", "Dev", "Pooja", "Ved", "Riya", "Om", "Sara", "Yash", "Zoya"];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bot(name) {
  const ws = new WS(`ws://${host}`);
  let answeredFor = null;
  ws.on("open", () => ws.send(JSON.stringify({ t: "join", code, name })));
  ws.on("message", async (b) => {
    const m = JSON.parse(b);
    if (m.t === "error") { console.error(`${name}: ${m.msg}`); ws.close(); return; }
    if (m.t !== "state") return;
    if (m.phase === "asking" && answeredFor !== m.question) {
      answeredFor = m.question;
      await sleep(300 + Math.random() * 2500); // stagger like real humans
      ws.send(JSON.stringify({ t: "answer", text: pick(POOL) }));
    }
    if (m.phase === "won") console.log(`${name} sees winner: ${m.winner}`);
  });
  ws.on("close", () => {});
  return ws;
}

const names = NAMES.slice(0, count);
names.forEach((n, i) => setTimeout(() => { bot(n); console.log("joined:", n); }, i * 150));
console.log(`Spawning ${count} bots into room ${code}. Ctrl+C to stop.`);
