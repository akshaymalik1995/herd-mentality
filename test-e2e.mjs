// Adversarial end-to-end test. Spawns its own server, tries to break it.
// Model: the room creator is the first player AND the leader (controller).
// In scoring tests the leader ("HOST") abstains (never answers) so it doesn't
// affect buckets — it just rides along in the player list with 0 points.
// Run: node test-e2e.mjs
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const PORT = 3222;
const URL = `ws://localhost:${PORT}`;
const srv = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = () => new Promise((res, rej) => {
  const w = new WebSocket(URL);
  w.states = []; w.errors = [];
  w.on("message", (b) => { const m = JSON.parse(b); if (m.t === "error") w.errors.push(m); else if (m.t === "state") w.states.push(m); });
  w.on("open", () => res(w)); w.on("error", rej);
});
const last = (w) => w.states[w.states.length - 1];
const s = (w, o) => w.send(JSON.stringify(o));
const settle = () => sleep(120);

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ✅", name); } else { fail++; console.log("  ❌", name); } }

async function createRoom(name = "HOST") { const h = await mk(); s(h, { t: "create", name }); await settle(); return [h, last(h).code]; }
async function join(code, name) { const p = await mk(); s(p, { t: "join", code, name }); await settle(); return p; }
async function round(leader, players, answers) {
  s(leader, { t: "next" }); await settle();
  players.forEach((p, i) => { if (answers[i] !== null) s(p, { t: "answer", text: answers[i] }); });
  await settle();
  s(leader, { t: "reveal" }); await settle(); // -> review
  s(leader, { t: "score" }); await settle();  // leader confirms -> scored
}
const score = (leader, name) => last(leader).scoreboard.find((p) => p.name === name);

async function main() {
  await sleep(800); // server boot

  console.log("\n[1] Bad join codes");
  {
    const p = await mk();
    s(p, { t: "join", code: "ZZZZ", name: "X" }); await settle();
    ok("join nonexistent room -> error, no state", p.errors.length === 1 && p.states.length === 0);
    s(p, { t: "join", code: "", name: "X" }); await settle();
    ok("join empty code -> error", p.errors.length === 2);
  }

  console.log("\n[2] Name/answer sanitisation");
  {
    const [host, code] = await createRoom();
    const p = await join(code, "A".repeat(50));
    ok("long name truncated to 20", last(host).players.some((x) => x.name.length === 20));
    await join(code, "   ");
    ok("blank name -> 'Player'", last(host).players.some((x) => x.name === "Player"));
    s(host, { t: "next" }); await settle();
    s(p, { t: "answer", text: "  " }); await settle();
    ok("whitespace-only answer ignored", last(host).answeredCount === 0);
    s(p, { t: "answer", text: "B".repeat(200) }); await settle();
    s(host, { t: "reveal" }); await settle();
    s(host, { t: "score" }); await settle();
    ok("60+ char answer truncated to 60", last(host).reveal.groups[0].answer.length === 60);
  }

  console.log("\n[3] Out-of-phase actions are no-ops");
  {
    const [host, code] = await createRoom();
    const p = await join(code, "Ann");
    s(p, { t: "answer", text: "early" }); await settle(); // lobby, no question
    ok("answer in lobby ignored", last(host).phase === "lobby");
    s(host, { t: "reveal" }); await settle(); // reveal before asking
    ok("reveal in lobby ignored", last(host).phase === "lobby");
  }

  console.log("\n[4] Only the leader can drive the round");
  {
    const [host, code] = await createRoom();
    const p = await join(code, "Ann");
    s(p, { t: "next" }); await settle();
    ok("non-leader 'next' ignored", last(host).phase === "lobby");
    s(host, { t: "start" }); await settle();
    s(p, { t: "reveal" }); await settle();
    ok("non-leader 'reveal' ignored", last(host).phase === "asking");
  }

  console.log("\n[5] Scoring: normalisation, majority, ties");
  {
    const [host, code] = await createRoom();
    const a = await join(code, "A"), b = await join(code, "B"), c = await join(code, "C"), d = await join(code, "D");
    await round(host, [a, b, c, d], ["Banana", " banana ", "BANANA!", "Mango"]);
    ok("normalised majority of 3 each +1", score(host, "A").score === 1 && score(host, "B").score === 1 && score(host, "C").score === 1);
    ok("odd one out scores 0", score(host, "D").score === 0);
    ok("single odd-one-out gets the cow", score(host, "D").cow === true && last(host).scoreboard.filter((x) => x.cow).length === 1);
    ok("majority reported once", last(host).reveal.majority.length === 1);
  }

  console.log("\n[6] All-unique round: nobody scores, no cow handed out");
  {
    const [host, code] = await createRoom();
    const a = await join(code, "A"), b = await join(code, "B"), c = await join(code, "C");
    await round(host, [a, b, c], ["red", "green", "blue"]);
    ok("max group=1 -> nobody scores", last(host).scoreboard.every((p) => p.score === 0));
    ok("multiple lone answers -> no cow", last(host).scoreboard.every((p) => !p.cow));
    ok("reveal says no agreement", last(host).reveal.majority.length === 0);
  }

  console.log("\n[7] Tie for majority: two groups of two both score");
  {
    const [host, code] = await createRoom();
    const a = await join(code, "A"), b = await join(code, "B"), c = await join(code, "C"), d = await join(code, "D");
    await round(host, [a, b, c, d], ["cat", "cat", "dog", "dog"]);
    ok("both tied groups score", ["A", "B", "C", "D"].every((n) => score(host, n).score === 1));
    ok("tie -> two majority answers", last(host).reveal.majority.length === 2);
    ok("no lone -> nobody gets cow", last(host).scoreboard.every((p) => !p.cow));
  }

  console.log("\n[8] Answer can be changed before reveal");
  {
    const [host, code] = await createRoom();
    const a = await join(code, "A"), b = await join(code, "B");
    s(host, { t: "next" }); await settle();
    s(a, { t: "answer", text: "wrong" }); await settle();
    s(a, { t: "answer", text: "tea" }); s(b, { t: "answer", text: "tea" }); await settle();
    s(host, { t: "reveal" }); await settle();
    s(host, { t: "score" }); await settle();
    ok("latest answer used, both match", score(host, "A").score === 1 && score(host, "B").score === 1);
    ok("only one group recorded", last(host).reveal.groups.length === 1);
  }

  console.log("\n[9] Win at 8 — blocked while holding the cow");
  {
    // Points only come in pairs, so to push C to 8 alone we rotate C's partner.
    const [host, code] = await createRoom();
    const a = await join(code, "A"), b = await join(code, "B"), c = await join(code, "C"), d = await join(code, "D");
    const by = { A: a, B: b, C: c, D: d };
    const order = ["A", "B", "C", "D"];
    const playRound = (ans) => round(host, order.map((n) => by[n]), order.map((n) => ans[n]));

    await playRound({ A: "x", B: "x", D: "x", C: "lonely" }); // C is the single odd one out
    ok("C holds the cow", score(host, "C").cow === true);

    const partners = ["A", "B", "D", "A", "B", "D", "A", "B"]; // C + rotating partner say "win"
    for (let r = 0; r < partners.length; r++) {
      const p = partners[r];
      const others = ["A", "B", "D"].filter((n) => n !== p);
      await playRound({ C: "win", [p]: "win", [others[0]]: `z${r}a`, [others[1]]: `z${r}b` });
    }
    ok("C reached >=8 but still holds cow -> NO win", score(host, "C").score >= 8 && last(host).phase === "reveal" && last(host).winner === null);
    ok("no cow-free player hit 8 yet", last(host).scoreboard.filter((p) => !p.cow).every((p) => p.score < 8));

    await playRound({ A: "alone", B: "team", C: "team", D: "team" }); // A becomes lone -> cow off C
    ok("cow moved off C to A", score(host, "C").cow === false && score(host, "A").cow === true);
    ok("cow-free C now wins", last(host).phase === "won" && last(host).winner === "C");
  }

  console.log("\n[10] Disconnect + leader hand-off");
  {
    const [host, code] = await createRoom();
    const a = await join(code, "A"), b = await join(code, "B");
    ok("3 in room (leader + 2)", last(host).total === 3);
    a.close(); await settle();
    ok("player leaving updates count", last(host).total === 2);
    host.close(); await settle();
    ok("leadership handed to a remaining player", last(b).isLeader === true && last(b).total === 1);
    const late = await mk();
    s(late, { t: "join", code, name: "Z" }); await settle();
    ok("room still alive after leader left", late.errors.length === 0 && last(b).total === 2);
  }

  console.log("\n[11] Restart resets scores and cow");
  {
    const [host, code] = await createRoom();
    const a = await join(code, "A"), b = await join(code, "B");
    await round(host, [a, b], ["yes", "yes"]);
    ok("round scored", score(host, "A").score === 1);
    s(host, { t: "restart" }); await settle();
    ok("scores wiped to lobby", last(host).phase === "lobby" && last(host).scoreboard.every((p) => p.score === 0 && !p.cow) && last(host).winner === null);
  }

  console.log("\n[12] Garbage input doesn't crash the server");
  {
    const p = await mk();
    p.send("not json at all"); p.send(JSON.stringify({ t: "bogus" })); p.send("{]"); await settle();
    const [host, code] = await createRoom();
    const a = await join(code, "A");
    ok("server still alive & serving after garbage", last(host).total === 2 && a.errors.length === 0);
  }

  console.log("\n[13] Leader merge: fix a typo, regroup, then score");
  {
    const [host, code] = await createRoom();
    const a = await join(code, "A"), b = await join(code, "B"), c = await join(code, "C");
    s(host, { t: "next" }); await settle();
    s(a, { t: "answer", text: "banana" }); s(b, { t: "answer", text: "bananna" }); s(c, { t: "answer", text: "banana" }); await settle();
    s(host, { t: "reveal" }); await settle();
    ok("review phase, 2 buckets (typo split)", last(host).phase === "review" && last(host).review.length === 2);
    const ids = last(host).review.map((x) => x.id);
    s(host, { t: "merge", a: ids[0], b: ids[1] }); await settle();
    ok("after merge -> 1 bucket of 3", last(host).review.length === 1 && last(host).review[0].count === 3);
    s(host, { t: "regroup" }); await settle();
    ok("regroup undoes the merge", last(host).review.length === 2);
    const ids2 = last(host).review.map((x) => x.id);
    s(host, { t: "merge", a: ids2[0], b: ids2[1] }); await settle();
    s(host, { t: "score" }); await settle();
    ok("merged group scores all 3", ["A", "B", "C"].every((n) => score(host, n).score === 1));
    ok("no cow after merge (no lone left)", last(host).scoreboard.every((p) => !p.cow));
  }

  console.log("\n[14] Merge 3 buckets in one go");
  {
    const [host, code] = await createRoom();
    const a = await join(code, "A"), b = await join(code, "B"), c = await join(code, "C"), d = await join(code, "D");
    s(host, { t: "next" }); await settle();
    s(a, { t: "answer", text: "color" }); s(b, { t: "answer", text: "colour" }); s(c, { t: "answer", text: "kolor" }); s(d, { t: "answer", text: "red" }); await settle();
    s(host, { t: "reveal" }); await settle();
    const variants = last(host).review.filter((g) => g.label.toLowerCase() !== "red").map((g) => g.id);
    ok("3 spelling variants present", variants.length === 3);
    s(host, { t: "merge", ids: variants }); await settle(); // one-shot merge of all three
    ok("merged into a single bucket of 3", last(host).review.find((g) => g.count === 3) && last(host).review.length === 2);
    s(host, { t: "score" }); await settle();
    ok("the merged trio are the majority (+1 each)", ["A", "B", "C"].every((n) => score(host, n).score === 1) && score(host, "D").score === 0);
    ok("lone 'red' gets the cow", score(host, "D").cow === true);
  }

  console.log("\n[15] Duplicate names get auto-suffixed");
  {
    const [host, code] = await createRoom("Akshay");
    await join(code, "Akshay"); await join(code, "Akshay");
    const names = last(host).players.map((p) => p.name).sort();
    ok("three Akshays -> unique labels", JSON.stringify(names) === JSON.stringify(["Akshay", "Akshay (2)", "Akshay (3)"]));
  }

  console.log("\n[16] Auto-reveal when everyone has answered");
  {
    const [host, code] = await createRoom();
    const a = await join(code, "A"), b = await join(code, "B");
    s(host, { t: "next" }); await settle();
    s(host, { t: "answer", text: "go" }); s(a, { t: "answer", text: "go" }); await settle();
    ok("not all in yet -> still asking", last(host).phase === "asking");
    s(b, { t: "answer", text: "go" }); await settle(); // last answer
    ok("all answered -> auto-advances to review (no reveal sent)", last(host).phase === "review");
    s(host, { t: "score" }); await settle();
    ok("scoring still works after auto-reveal", score(host, "A").score === 1);
  }

  console.log(`\n${fail === 0 ? "ALL PASS ✅" : "FAILURES ❌"}  (${pass} passed, ${fail} failed)`);
  srv.kill();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
