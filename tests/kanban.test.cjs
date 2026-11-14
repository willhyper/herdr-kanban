const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function element(kind) {
  const node = { kind, nodes: [], styles: {}, onClick: null };
  const proxy = new Proxy(node, {
    get(target, name) {
      if (name in target) return target[name];
      return (...args) => {
        if (name === "child") target.nodes.push(args[0]);
        else if (name === "children") target.nodes.push(...args[0]);
        else if (name === "when" && args[0]) args[1](proxy);
        else if (name === "on_click") target.onClick = args[0];
        else target.styles[name] = args.length === 1 ? args[0] : args;
        return proxy;
      };
    },
  });
  return proxy;
}

function find(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  for (const child of node.nodes ?? []) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}

function textOf(node) {
  if (typeof node === "string") return node;
  return (node?.nodes ?? []).map(textOf).join(" ");
}

function action(root, label) {
  const found = find(root, node => node.onClick && node.nodes?.includes(label));
  assert.ok(found, `Missing ${label} action`);
  return found;
}

function click(node, cx, count = 1) {
  assert.equal(typeof node.onClick, "function");
  node.onClick({ click_count: count }, cx);
}

function inputState() {
  let current = "";
  return {
    on() {},
    value: () => current,
    set_value(value) { current = value; },
    focus() {},
  };
}

function loadView(file, dependencies, className = "Kanban") {
  const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace("export default class ", "class ");
  return new Function(...Object.keys(dependencies), `${source}\nreturn ${className};`)(...Object.values(dependencies));
}

async function harness() {
  const memory = new Map();
  const commands = [];
  const results = new Map();
  const savedStatuses = [];
  const liveAgents = [];
  const tabs = [{ id: "original", name: "Board", active: true, status: null }];
  const space = { id: "space-1", active: true, folder: "/work", machine: null, tabs };
  let failNew = false;
  let nextTab = 0;
  const cx = {
    delayed: [],
    pending: [],
    notify() {},
    stop_propagation() {},
    timer: {
      every() {},
      after(ms, callback) { cx.delayed.push({ ms, callback }); },
    },
    spawn(callback) {
      const promise = Promise.resolve().then(() => callback(cx));
      cx.pending.push(promise);
      return promise;
    },
    async flush() {
      await Promise.all(cx.pending.splice(0));
    },
    fire(ms) {
      const task = cx.delayed.find(item => item.ms === ms);
      assert.ok(task, `Missing ${ms}ms timer`);
      task.callback(cx);
    },
  };
  const run = (name, args) => {
    commands.push({ name, args });
    if (name === "tab.new") {
      if (failNew) throw new Error("agent failed to launch");
      tabs.forEach(tab => { tab.active = false; });
      tabs.push({ id: `task-${++nextTab}`, name: args.name, active: true, status: null });
    }
    if (name === "tab.select") tabs.forEach(tab => { tab.active = tab.id === args.id; });
  };
  const t = {
    surface: "surface", border: "border", foreground: "foreground", muted: "muted",
    dim: "dim", background: "background", raised: "raised", hover: "hover",
    accent: "accent", accent_foreground: "accent_foreground", solid_foreground: "solid_foreground",
    idle: "idle", working: "working", done: "done", blocked: "blocked", input: "input",
  };
  const Kanban = loadView("mods/kanban/main.js", {
    View: class {}, div: () => element("div"), h_flex: () => element("row"), v_flex: () => element("column"),
    InputState: { new: inputState }, TextareaState: { new: inputState },
    Input: { new: () => element("input") }, Textarea: { new: () => element("textarea") },
    agents: () => liveAgents, appHome: () => "/app", knownAgents: async () => [],
    panes: () => [{ focused: true, cwd: "/work" }],
    readTextFile: async file => results.get(file), run, spaces: () => [space],
    terminals: () => [], theme: () => t,
    localStorage: {
      getItem: key => memory.get(key) ?? null,
      setItem(key, value) {
        memory.set(key, value);
        if (key === "kanban.tasks.v1") savedStatuses.push(JSON.parse(value).map(card => card.status));
      },
    },
  });
  const board = new Kanban();
  board.init({}, cx);
  await cx.flush();
  return {
    board, cx, commands, results, liveAgents, tabs, t, memory, savedStatuses,
    failLaunch() { failNew = true; },
    card(status = "idle") {
      const card = { id: `card-${board.cards.length + 1}`, title: "Inspect sample", details: "Check edges", status, createdAt: Date.now() };
      board.cards.push(card);
      board.saveCards();
      return card;
    },
    start(card) { board.startTask(card.id, { name: "Codex", key: "codex", run: ["codex"] }, cx); },
  };
}

test("new card action creates a staged task and persists it", async () => {
  const h = await harness();
  click(action(h.board.statusColumn({ id: "staging", title: "STAGING" }, [], [], h.t), "+ New card"), h.cx);
  assert.equal(h.board.creating, true);
  h.board.titleInput.set_value("Check wafer");
  h.board.detailsInput.set_value("Inspect each edge");
  click(action(h.board.render(h.cx), "Add task"), h.cx);
  assert.equal(h.board.creating, false);
  assert.equal(h.board.cards[0].status, "idle");
  assert.equal(h.board.cards[0].title, "Check wafer");
  const reloaded = new h.board.constructor();
  reloaded.init({}, h.cx);
  assert.equal(reloaded.cards[0].details, "Inspect each edge");
  await h.cx.flush();
});

test("a staged card can be edited by double click, then saved", async () => {
  const h = await harness();
  const card = h.card();
  const staged = h.board.taskCard(card, "idle", [], h.t);
  click(staged, h.cx);
  assert.equal(h.board.editFor, null);
  click(staged, h.cx, 2);
  assert.equal(h.board.editFor, card.id);
  h.board.editTitleInput.set_value("Inspect revised sample");
  h.board.editDetailsInput.set_value("Check all edges");
  click(action(h.board.taskCard(card, "idle", [], h.t), "Save"), h.cx);
  assert.equal(card.title, "Inspect revised sample");
  assert.equal(card.summary, "Check all edges");
  assert.equal(h.board.editFor, null);
});

test("starting a card goes straight to working and keeps the previous tab selected", async () => {
  const h = await harness();
  const card = h.card();
  h.board.agentChoices = [{ name: "Codex", key: "codex", run: ["codex"], installed: true }];
  click(action(h.board.taskCard(card, "idle", [], h.t), "Pick up…"), h.cx);
  assert.equal(h.board.pickFor, card.id);
  const picker = h.board.taskCard(card, "idle", [], h.t);
  const start = find(picker, node => node.kind === "row" && node.onClick && textOf(node).includes("Start"));
  click(start, h.cx);
  assert.equal(card.status, "working");
  assert.deepEqual(h.commands.map(item => item.name), ["tab.new", "tab.select"]);
  assert.equal(h.commands[0].args.name, card.title);
  assert.match(h.commands[0].args.task, /Check edges/);
  assert.equal(h.commands[1].args.id, "original");
  assert.equal(h.tabs.find(tab => tab.active)?.id, "original");
  assert.equal(h.board.pickFor, null);
});

test("a new task receives reusable results from done cards", async () => {
  const h = await harness();
  h.board.cards.push(
    { id: "fib-43", title: "fib(43)", status: "done", result: "fib(43) = 433494437" },
    { id: "fib-44", title: "fib(44)", status: "done", result: "fib(44) = 701408733" },
    { id: "unfinished", title: "fib(99)", status: "working", result: "Do not use this" },
  );
  const card = h.card();
  card.title = "fib(45)";
  h.start(card);
  const prompt = h.commands[0].args.task;
  assert.match(prompt, /fib\(43\).*433494437/);
  assert.match(prompt, /fib\(44\).*701408733/);
  assert.match(prompt, /Reuse relevant results or intermediate values/);
  assert.match(prompt, /cite the source card title/);
  assert.doesNotMatch(prompt, /fib\(99\)|Do not use this/);
});

test("only double clicking a working card focuses its agent panel", async () => {
  const h = await harness();
  const card = h.card();
  h.start(card);
  h.liveAgents.push({ tab: "task-1", tab_name: card.title, address: "terminal-1", space: "space-1", status: "working", program: { name: "Codex" } });
  h.cx.fire(6000);
  const working = h.board.taskCard(card, "working", h.liveAgents, h.t);
  const before = h.commands.length;
  click(working, h.cx);
  assert.equal(h.commands.length, before);
  click(working, h.cx, 2);
  assert.deepEqual(h.commands.slice(before).map(item => item.name), ["tab.select", "pane.focus", "terminal.show"]);
  assert.equal(h.commands[before].args.id, "task-1");
});

test("a completed agent result moves the card directly to done and closes its tab", async () => {
  const h = await harness();
  const card = h.card();
  h.start(card);
  const afterStart = h.savedStatuses.length;
  h.liveAgents.push({ tab: "task-1", tab_name: card.title, address: "terminal-1", space: "space-1", status: "working", program: { name: "Codex" } });
  h.cx.fire(6000);
  h.board.collectFinishedTasks(h.cx);
  h.results.set(card.resultPath, "Edges are clean.\nNo defects found.");
  h.board.readCardResults(h.cx);
  await h.cx.flush();
  assert.equal(card.summary, "Edges are clean. No defects found.");
  card.startedAt = Date.now() - 12_000;
  h.liveAgents[0].status = "done";
  h.board.collectFinishedTasks(h.cx);
  assert.equal(card.status, "done");
  assert.ok(card.durationMs >= 12_000);
  assert.ok(h.commands.some(item => item.name === "tab.close" && item.args.id === "task-1"));
  assert.equal(card.agentTab, undefined);
  assert.deepEqual([...new Set(h.savedStatuses.slice(afterStart).map(statuses => statuses[0]))], ["working", "done"]);
});

test("launch errors and failed initialization return a card to staging", async () => {
  const launch = await harness();
  const first = launch.card();
  launch.failLaunch();
  launch.start(first);
  assert.equal(first.status, "idle");
  assert.match(launch.board.formError, /agent failed to launch/);

  const init = await harness();
  const second = init.card();
  init.start(second);
  assert.equal(second.status, "working");
  init.cx.fire(6000);
  assert.equal(second.status, "idle");
  assert.equal(second.agentTab, undefined);
});

test("aborting working kills its terminal and returns it to staging", async () => {
  const h = await harness();
  const card = h.card();
  h.start(card);
  h.liveAgents.push({ tab: "task-1", tab_name: card.title, address: "terminal-1", space: "space-1", status: "working", program: { name: "Codex" } });
  click(action(h.board.taskCard(card, "working", h.liveAgents, h.t), "Abort"), h.cx);
  assert.equal(card.status, "idle");
  assert.ok(h.commands.some(item => item.name === "terminal.kill" && item.args.terminal === "terminal-1"));
});

test("done cards show result and duration, expand on double click, and can be trashed", async () => {
  const h = await harness();
  const card = h.card("done");
  card.result = "No defects found.";
  card.summary = "No defects found.";
  card.durationMs = 14_000;
  const done = h.board.taskCard(card, "done", [], h.t);
  assert.match(textOf(done), /No defects found/);
  assert.match(textOf(done), /Took 14s/);
  assert.doesNotMatch(textOf(done), /Pick up/);
  click(done, h.cx);
  assert.equal(h.board.doneDetailsFor, null);
  click(done, h.cx, 2);
  assert.equal(h.board.doneDetailsFor, card.id);
  click(action(h.board.taskCard(card, "done", [], h.t), "🗑"), h.cx);
  assert.equal(h.board.cards.length, 0);
  assert.equal(JSON.parse(h.memory.get("kanban.tasks.v1")).length, 0);
});

test("staging, working, and done render two, one, and three cards per row", async () => {
  const h = await harness();
  const column = (id, count) => h.board.statusColumn({ id, title: id.toUpperCase() },
    Array.from({ length: count }, (_, i) => ({ card: { id: `${id}-${i}`, title: `${id} ${i}` }, status: id === "staging" ? "idle" : id })), [], h.t);
  const staging = column("staging", 3);
  const working = column("working", 2);
  const done = column("done", 4);
  assert.deepEqual([staging.styles.flex_grow, working.styles.flex_grow, done.styles.flex_grow], [2, 1, 3]);
  assert.equal(staging.nodes[1].nodes[0].nodes.length, 2);
  assert.equal(working.nodes[1].nodes.length, 2);
  assert.equal(done.nodes[1].nodes[0].nodes.length, 3);
  assert.match(textOf(staging.nodes[1].nodes[1]), /staging 2/);
  assert.match(textOf(done.nodes[1].nodes[1]), /done 3/);
});

test("a named task tab appears as the pane title", () => {
  const tab = { id: "task-tab", name: "Inspect sample", named: true };
  const pane = { pane: "pane-1", tab: tab.id, cwd: "/work", program: { name: "Codex" } };
  const KanbanPane = loadView("mods/kanban-pane/main.js", {
    View: class {}, div: () => element("div"), image: () => element("image"), svg: () => element("svg"),
    h_flex: () => element("row"), panes: () => [pane], props: () => ({ pane: pane.pane }),
    run() {}, spaces: () => [{ tabs: [tab] }], theme: () => ({ background: "background", border: "border", foreground: "foreground", dim: "dim" }),
  }, "KanbanPane");
  assert.match(textOf(new KanbanPane().render()), /Inspect sample/);
});
