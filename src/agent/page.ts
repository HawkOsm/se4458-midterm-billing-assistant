// The chat page, served by the agent server. Kept as strings so `tsc` builds it into
// dist/ with the rest (no separate static files to copy). Script and styles are separate
// files so the page can run under a strict Content-Security-Policy (no inline code), and
// every text from the server is inserted with textContent, never as HTML.

export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Billing Assistant</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<main>
  <h1>Mobile Billing Assistant</h1>
  <form id="login">
    <p>Log in as a subscriber (demo: ayse / Demo-Ayse-2025).</p>
    <input id="username" autocomplete="username" placeholder="Username" required>
    <input id="password" type="password" autocomplete="current-password" placeholder="Password" required>
    <button>Log in</button>
    <p id="login-error" class="error"></p>
  </form>
  <section id="chat" hidden>
    <p id="who"></p>
    <div id="log"></div>
    <div id="confirm" hidden>
      <p id="confirm-text"></p>
      <button id="confirm-yes">Confirm</button>
      <button id="confirm-no">Cancel</button>
    </div>
    <form id="ask">
      <input id="message" maxlength="2000" placeholder="Ask about your bill, e.g. What is my October bill?" required>
      <button>Send</button>
    </form>
  </section>
</main>
<script src="/app.js"></script>
</body>
</html>`;

export const PAGE_CSS = `
body { font-family: system-ui, sans-serif; margin: 0; background: #f6f7f9; color: #1d2228; }
main { max-width: 760px; margin: 0 auto; padding: 16px; }
h1 { font-size: 1.4rem; }
input { padding: 8px; font-size: 1rem; }
#message { width: calc(100% - 90px); }
button { padding: 8px 14px; font-size: 1rem; cursor: pointer; }
#log { display: flex; flex-direction: column; gap: 10px; margin: 12px 0; }
.msg { padding: 10px 12px; border-radius: 8px; white-space: pre-wrap; }
.user { background: #dfe9ff; align-self: flex-end; max-width: 85%; }
.bot { background: #fff; border: 1px solid #d8dce1; max-width: 95%; }
details { margin-top: 6px; font-size: .85rem; color: #4a525c; }
pre { white-space: pre-wrap; word-break: break-word; margin: 4px 0; }
#confirm { background: #fff6dd; border: 1px solid #e6c766; padding: 10px; border-radius: 8px; }
.error { color: #b3261e; }
`;

export const PAGE_JS = `
"use strict";
const $ = (id) => document.getElementById(id);
const state = { token: sessionStorage.getItem("token"), who: sessionStorage.getItem("who"), conversationId: null, confirmationId: null };

function add(kind, text, trace) {
  const div = document.createElement("div");
  div.className = "msg " + kind;
  div.textContent = text;
  if (trace && trace.length) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Show steps (" + trace.length + " tool call" + (trace.length > 1 ? "s" : "") + ")";
    details.appendChild(summary);
    for (const t of trace) {
      const pre = document.createElement("pre");
      const status = t.confirmed === false ? " (declined)" : t.isError ? " (error)" : t.confirmed ? " (confirmed)" : "";
      pre.textContent = t.tool + status + "\\n  input:  " + JSON.stringify(t.input) + "\\n  result: " + t.result;
      details.appendChild(pre);
    }
    div.appendChild(details);
  }
  $("log").appendChild(div);
  div.scrollIntoView();
}

async function post(path, body) {
  const headers = { "Content-Type": "application/json" };
  if (state.token) headers.Authorization = "Bearer " + state.token;
  const res = await fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ error: "Unexpected response" }));
  if (res.status === 401) logout("Your session expired. Please log in again.");
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function show(result) {
  state.conversationId = result.conversationId;
  if (result.kind === "confirm") {
    state.confirmationId = result.confirmationId;
    if (result.trace.length) add("bot", "Before I continue, please confirm:", result.trace);
    $("confirm-text").textContent = result.summary;
    $("confirm").hidden = false;
    $("ask").hidden = true;
  } else {
    $("confirm").hidden = true;
    $("ask").hidden = false;
    add("bot", result.text, result.trace);
  }
}

function enter() {
  $("login").hidden = true;
  $("chat").hidden = false;
  $("who").textContent = "Logged in as subscriber " + state.who;
}

function logout(message) {
  sessionStorage.clear();
  state.token = null;
  $("chat").hidden = true;
  $("login").hidden = false;
  $("login-error").textContent = message || "";
}

$("login").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const data = await post("/api/login", { username: $("username").value, password: $("password").value });
    state.token = data.token;
    state.who = data.subscriberNo;
    sessionStorage.setItem("token", data.token);
    sessionStorage.setItem("who", data.subscriberNo);
    $("password").value = "";
    enter();
  } catch (err) {
    $("login-error").textContent = err.message;
  }
});

$("ask").addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = $("message").value.trim();
  if (!message) return;
  $("message").value = "";
  add("user", message);
  const send = $("ask").querySelector("button");
  send.disabled = true; // one message at a time
  try {
    show(await post("/api/chat", { conversationId: state.conversationId, message }));
  } catch (err) {
    add("bot", "Error: " + err.message);
  } finally {
    send.disabled = false;
  }
});

async function answer(approve) {
  $("confirm").hidden = true;
  add("user", approve ? "Confirm" : "Cancel");
  try {
    show(await post("/api/confirm", { conversationId: state.conversationId, confirmationId: state.confirmationId, approve }));
  } catch (err) {
    add("bot", "Error: " + err.message);
    $("ask").hidden = false;
  }
}
$("confirm-yes").addEventListener("click", () => answer(true));
$("confirm-no").addEventListener("click", () => answer(false));

if (state.token) enter();
`;
