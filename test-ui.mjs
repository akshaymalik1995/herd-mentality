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
function tab(seed) {
  return new JSDOM(HTML, {
    url: `http://localhost:${PORT}/`,
    runScripts: "dangerously",
    beforeParse(window) {
      window.WebSocket = WebSocket; // give the page a real socket
      if (!window.localStorage) { // polyfill if this jsdom build lacks Storage
        const m = new Map();
        Object.defineProperty(window, "localStorage", { value: { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() } });
      }
      if (seed) window.localStorage.setItem("herd", seed); // simulate a reload that already has a session
    },
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
async function createGame(dom, name) { await waitForEl(dom, "tabCreate"); click(dom, "tabCreate"); await waitForEl(dom, "go"); setVal(dom, "name", name); click(dom, "go"); }
async function joinGame(dom, name, code) { await waitForEl(dom, "tabJoin"); click(dom, "tabJoin"); await waitForEl(dom, "go"); setVal(dom, "name", name); setVal(dom, "code", code); click(dom, "go"); }

async function main() {
  await sleep(800); // server boot

  console.log("\n[A] Landing tabs -> create -> lobby");
  const host = tab();
  await waitForEl(host, "tabJoin");
  ok("two tabs present (Join + Create)", !!$(host, "tabJoin") && !!$(host, "tabCreate"));
  ok("Join tab is default (has code field)", !!$(host, "code"));
  await createGame(host, "Akshay");
  await waitForEl(host, "start");
  ok("leader sees crown", text(host).includes("👑"));
  ok("leader sees own avatar next to name", hasAvatar(text(host), "Akshay"));
  ok("Start button present for leader", !!$(host, "start"));
  const code = host.window.document.querySelector(".code").textContent;
  ok("4-letter room code shown", /^[A-Z]{4}$/.test(code));

  console.log("\n[B] Others join (incl. a duplicate name)");
  const bob = tab(); await joinGame(bob, "Bob", code);
  const dup = tab(); await joinGame(dup, "Akshay", code); // same name as host
  await waitForText(host, "Akshay (2)");
  ok("duplicate name auto-suffixed in lobby", text(host).includes("Akshay (2)"));
  await waitForText(bob, "waiting for the host"); // bob's lobby may render a beat after he joins
  ok("non-leader sees waiting message, no Start", text(bob).toLowerCase().includes("waiting for the host") && !$(bob, "start"));

  console.log("\n[C] Start -> answering, with live-progress messaging");
  click(host, "start");
  await waitForEl(host, "ans"); await waitForEl(bob, "ans"); await waitForEl(dup, "ans");
  ok("everyone gets an answer box", !!$(host, "ans") && !!$(bob, "ans") && !!$(dup, "ans"));
  await answer(bob, "pizza");
  await waitForText(bob, "Answer locked in");
  await waitForText(bob, "answered");
  ok("answered player sees live count (not a dead end)", /\d \/ 3 answered/.test(text(bob)));

  console.log("\n[D] Everyone answered -> AUTO reveal (no manual click)");
  await answer(host, "pizza");
  await answer(dup, "pasta"); // last answer triggers auto-reveal
  await waitForEl(host, "score");
  ok("auto-advances to review once everyone answered", !!$(host, "score"));
  ok("leader sees answer cards to merge/score", host.window.document.querySelectorAll(".merge-card").length >= 1);
  await waitForText(bob, "pizza"); // EVERYONE sees the answers now, not just the host
  ok("non-leader sees the answers too", text(bob).toLowerCase().includes("pizza") && text(bob).toLowerCase().includes("pasta"));
  ok("non-leader gets discuss note, not merge controls", text(bob).toLowerCase().includes("discuss") && !$(bob, "score"));
  click(host, "score");

  console.log("\n[F] Score -> scoreboard visible to all");
  await waitForText(host, "Scores");
  await waitForText(bob, "Scores");
  ok("herd answer (pizza) reported", text(host).toLowerCase().includes("pizza"));
  ok("gainers highlighted with +N (juice)", !!host.window.document.querySelector(".row.gain") && text(host).includes("+1"));
  ok("scoreboard shows players with avatars", hasAvatar(text(bob), "Bob") && text(bob).includes("Akshay"));
  ok("leader can advance to next question", !!$(host, "next"));
  ok("non-leader waits for next", text(bob).toLowerCase().includes("waiting for the next"));

  console.log("\n[G] Typing isn't wiped when another player submits");
  await waitForEl(host, "next"); click(host, "next");
  await waitForEl(bob, "ans"); await waitForEl(dup, "ans");
  setVal(bob, "ans", "half-typed answer"); // bob is mid-typing, hasn't submitted
  await answer(host, "something"); // another player submits -> bob re-renders
  await sleep(250); // let bob process the broadcast/re-render
  ok("bob's in-progress answer survives the re-render", $(bob, "ans") && $(bob, "ans").value === "half-typed answer");

  console.log("\n[H] Refresh resumes the session; Leave ends it");
  {
    const solo = tab();
    await waitForEl(solo, "tabJoin");
    await createGame(solo, "Percy");
    await waitForEl(solo, "start");
    const session = solo.window.localStorage.getItem("herd");
    ok("session saved to localStorage", !!session && !!JSON.parse(session).token);
    const reloaded = tab(session); // a fresh page that already has the session = a refresh
    await waitForEl(reloaded, "start");
    ok("auto-resumes straight into the room", text(reloaded).includes("Percy"));
    ok("same room after resume", reloaded.window.document.querySelector(".code").textContent === JSON.parse(session).code);
    click(reloaded, "leave");
    await waitForEl(reloaded, "tabJoin");
    ok("Leave returns to the landing", !!$(reloaded, "tabJoin"));
    ok("Leave clears the saved session", !reloaded.window.localStorage.getItem("herd"));
  }

  console.log("\n[I] Resuming a dead session falls back to landing");
  {
    const ghost = tab(JSON.stringify({ code: "ZZZZ", token: "nope" }));
    await waitForEl(ghost, "tabJoin");
    ok("dead session -> landing", !!$(ghost, "tabJoin"));
    ok("shows a gentle notice (not a scary error)", text(ghost).toLowerCase().includes("previous game has ended"));
    ok("dead session cleared from storage", !ghost.window.localStorage.getItem("herd"));
  }

  console.log("\n[J] Rules sheet opens from the ? button and landing link");
  {
    const r = tab();
    await waitForEl(r, "helpBtn");
    ok("help button always present", !!$(r, "helpBtn"));
    ok("'How to play' link on landing", !!$(r, "howto"));
    ok("rules hidden by default", $(r, "rules").hidden === true);
    $(r, "helpBtn").click();
    ok("rules open on tap", $(r, "rules").hidden === false);
    const rt = $(r, "rules").textContent.toLowerCase();
    ok("rules explain cow + win condition", rt.includes("pink cow") && rt.includes("8 points") && rt.includes("majority"));
    $(r, "rulesClose").click();
    ok("rules close on ✕", $(r, "rules").hidden === true);
  }

  console.log(`\n${fail === 0 ? "ALL UI PASS ✅" : "UI FAILURES ❌"}  (${pass} passed, ${fail} failed)`);
  srv.kill();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
