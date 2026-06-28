// Frontend end-to-end test. Loads the REAL public/index.html in jsdom, wires its
// WebSocket to the REAL server, and asserts what actually renders on screen.
// Because the rendered page talks to the live backend, this covers both layers —
// including UI-only text (the "Waiting for the herd…" bug) that the protocol
// suite (test-e2e.mjs) can't see. Run: node test-ui.mjs
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { WebSocket } from "ws";

const PORT = 3223;
const HTML = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
const srv = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ✅", name); } else { fail++; console.log("  ❌", name); } }

// Each client is a separate jsdom "tab" running the real page against the server.
function tab() {
  return new JSDOM(HTML, {
    url: `http://localhost:${PORT}/`,
    runScripts: "dangerously",
    beforeParse(window) { window.WebSocket = WebSocket; }, // give the page a real socket
  });
}
// Read only the rendered app container — NOT body, which also contains the inline
// <script> source (matching that source caused false-positive text waits).
const text = (dom) => $(dom, "app").textContent.replace(/\s+/g, " ").trim();
const $ = (dom, id) => dom.window.document.getElementById(id);
const setVal = (dom, id, v) => { $(dom, id).value = v; };
const click = (dom, id) => $(dom, id).click();
const hasAvatar = (t, name) => new RegExp(`[^\\u0000-\\u007F]\\s*${name}`).test(t); // emoji before a name
async function waitForEl(dom, id, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if ($(dom, id)) return; await sleep(20); }
  throw new Error(`timeout waiting for #${id}. body:\n${text(dom)}`);
}
async function waitForText(dom, sub, ms = 4000) {
  const t0 = Date.now(), low = sub.toLowerCase();
  while (Date.now() - t0 < ms) { if (text(dom).toLowerCase().includes(low)) return; await sleep(20); }
  throw new Error(`timeout waiting for "${sub}". body:\n${text(dom)}`);
}
async function answer(dom, ans) { await waitForEl(dom, "ans"); setVal(dom, "ans", ans); click(dom, "submit"); }

async function main() {
  await sleep(800); // server boot

  console.log("\n[A] Landing -> create -> lobby");
  const host = tab();
  await waitForEl(host, "createBtn");
  setVal(host, "name", "Akshay"); click(host, "createBtn");
  await waitForEl(host, "start");
  ok("leader sees crown", text(host).includes("👑"));
  ok("leader sees own avatar next to name", hasAvatar(text(host), "Akshay"));
  ok("Start button present for leader", !!$(host, "start"));
  const code = host.window.document.querySelector(".code").textContent;
  ok("4-letter room code shown", /^[A-Z]{4}$/.test(code));

  console.log("\n[B] Others join (incl. a duplicate name)");
  const bob = tab(); await waitForEl(bob, "joinBtn");
  setVal(bob, "name", "Bob"); setVal(bob, "code", code); click(bob, "joinBtn");
  const dup = tab(); await waitForEl(dup, "joinBtn");
  setVal(dup, "name", "Akshay"); setVal(dup, "code", code); click(dup, "joinBtn"); // same name as host
  await waitForText(host, "Akshay (2)");
  ok("duplicate name auto-suffixed in lobby", text(host).includes("Akshay (2)"));
  ok("non-leader sees waiting message, no Start", text(bob).toLowerCase().includes("waiting for the host") && !$(bob, "start"));

  console.log("\n[C] Start -> answering, with live-progress messaging");
  click(host, "start");
  await waitForEl(host, "ans"); await waitForEl(bob, "ans"); await waitForEl(dup, "ans");
  ok("everyone gets an answer box", !!$(host, "ans") && !!$(bob, "ans") && !!$(dup, "ans"));
  await answer(bob, "pizza");
  await waitForText(bob, "Answer locked in");
  await waitForText(bob, "answered");
  ok("answered player sees live count (not a dead end)", /\d \/ 3 answered/.test(text(bob)));

  console.log("\n[D] THE BUG: everyone in -> clear next-step message");
  await answer(host, "pizza");
  await answer(dup, "pasta");
  await waitForText(bob, "waiting for the host to reveal");
  ok("non-leader: 'waiting for the host to reveal'", text(bob).toLowerCase().includes("waiting for the host to reveal"));
  ok("non-leader: NOT stuck on 'Waiting for the herd'", !text(bob).includes("Waiting for the herd"));
  await waitForEl(host, "reveal");
  ok("leader prompted to reveal", text(host).includes("hit Reveal"));
  ok("leader Reveal button enabled (all answered)", $(host, "reveal") && !$(host, "reveal").disabled);

  console.log("\n[E] Reveal -> review (leader merges, others wait)");
  click(host, "reveal");
  await waitForEl(host, "score");
  ok("leader sees Score + answer cards", !!$(host, "score") && host.window.document.querySelectorAll(".merge-card").length >= 1);
  await waitForText(bob, "checking the answers");
  ok("non-leader sees 'checking the answers'", text(bob).toLowerCase().includes("checking the answers"));
  click(host, "score");

  console.log("\n[F] Score -> scoreboard visible to all");
  await waitForText(host, "Scores");
  await waitForText(bob, "Scores");
  ok("herd answer (pizza) reported", text(host).toLowerCase().includes("pizza"));
  ok("scoreboard shows players with avatars", hasAvatar(text(bob), "Bob") && text(bob).includes("Akshay"));
  ok("leader can advance to next question", !!$(host, "next"));
  ok("non-leader waits for next", text(bob).toLowerCase().includes("waiting for the next"));

  console.log(`\n${fail === 0 ? "ALL UI PASS ✅" : "UI FAILURES ❌"}  (${pass} passed, ${fail} failed)`);
  srv.kill();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
