import { View, div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { agents, appHome, closeOverlay, knownAgents, openOverlay, panes, props, readTextFile, run, setShared, shared, spaces, terminals, theme } from "herdr";

const STORAGE_KEY = "kanban.tasks.v1";
const AGENTS_KEY = "kanban.availableAgents.v1";
const COLUMNS = [
  { id: "staging", title: "STAGING", color: "idle", empty: "No staged tasks" },
  { id: "working", title: "WORKING", empty: "No tasks in progress" },
  { id: "done", title: "DONE", empty: "No completed tasks yet" },
];

function readCards() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter(card => card && card.id && card.title) : [];
  } catch { return []; }
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function linkedAgent(card, liveAgents) {
  const matches = liveAgents.filter(agent => agent.tab === card.agentTabId
    || (agent.tab_name === card.agentTab && !(card.priorTabIds ?? []).includes(agent.tab)));
  return matches.length === 1 ? matches[0] : null;
}

function availableAgentsKey(machine) {
  return `${AGENTS_KEY}:${machine ?? "local"}`;
}

function agentCommand(choice, folder) {
  const executable = choice.run?.[0]?.split(/[\\/]/).at(-1);
  if (!folder) return choice.run;
  if (choice.key === "codex" || executable === "codex")
    return [...choice.run, "-c", `projects={${JSON.stringify(folder)}={trust_level="trusted"}}`];
  if (choice.key === "gemini" || executable === "gemini") return [...choice.run, "--skip-trust"];
  return choice.run;
}

export default class Kanban extends View {
  init(_props, cx) {
    this.settingsMode = Boolean(props()?.settings);
    this.cards = readCards();
    this.creating = false;
    this.pickFor = null;
    this.agentChoices = [];
    this.agentLoadError = false;
    this.detectingAgents = false;
    this.agentScan = 0;
    this.formError = "";
    this.editFor = null;
    this.editError = "";
    this.doneDetailsFor = null;
    this.titleInput = InputState.new({ placeholder: "Task title" });
    this.detailsInput = TextareaState.new({ placeholder: "What should the agent do? (optional)", rows: 2 });
    this.editTitleInput = InputState.new({ placeholder: "Task title" });
    this.editDetailsInput = TextareaState.new({ placeholder: "Task details", rows: 3 });
    this.titleInput.on("submit", (_event, cx) => this.createCard(cx));
    if (this.settingsMode) this.detectAgents(cx);
    else this.completionTimer = cx.timer.every(500, cx => this.collectFinishedTasks(cx));
  }

  detectAgents(cx) {
    const request = ++this.agentScan;
    const space = spaces().find(item => item.active);
    this.agentMachine = space?.machine;
    this.agentChoices = [];
    this.agentLoadError = false;
    this.detectingAgents = true;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const choices = await knownAgents({ on: space?.machine });
        if (request !== this.agentScan) return;
        const saved = shared(availableAgentsKey(space?.machine));
        const selected = new Map(Array.isArray(saved) ? saved.map(agent => [agent.key, agent.selected !== false]) : []);
        this.agentChoices = choices.filter(agent => agent.installed)
          .map(({ key, name, run }) => ({ key, name, run, installed: true, selected: selected.get(key) ?? true }));
        setShared(availableAgentsKey(space?.machine), this.agentChoices);
      } catch {
        if (request !== this.agentScan) return;
        this.agentLoadError = true;
      }
      this.detectingAgents = false;
      cx.notify();
    });
  }

  toggleAgent(key, cx) {
    this.agentChoices = this.agentChoices.map(agent => agent.key === key
      ? { ...agent, selected: agent.selected === false }
      : agent);
    setShared(availableAgentsKey(this.agentMachine), this.agentChoices);
    cx.notify();
  }

  collectFinishedTasks(cx) {
    const live = agents();
    let changed = false;
    for (const card of this.cards) {
      if (card.status !== "working" || !card.agentTab) continue;
      const owner = spaces().find(space => space.id === card.agentSpace) || spaces().find(space => space.active);
      const named = linkedAgent(card, live);
      const sameAgent = live.filter(agent => agent.space === owner?.id
        && (agent.program?.name === card.assignee || agent.program?.key === card.agentProgramKey));
      const observed = named || (sameAgent.length === 1 && !(card.priorTabIds ?? []).includes(sameAgent[0].tab) ? sameAgent[0] : null);
      if (observed && !card.agentTabId) {
        card.agentTabId = observed.tab;
        card.agentAddress = observed.address;
        card.agentTab = observed.tab_name;
        card.agentSpace = observed.space;
        changed = true;
      }
      if (observed?.status === "working" && !card.agentSeenWorking) {
        card.agentSeenWorking = true;
        changed = true;
      }
      if (card.result && (observed?.status === "done" || (observed?.status === "idle" && card.agentSeenWorking))) {
        this.finishTask(card, observed);
        changed = true;
        continue;
      }
      // Some agents disappear from the live list as soon as they exit.
      if (!observed && card.agentSeenWorking && card.result) {
        const priorTab = spaces().flatMap(space => space.tabs ?? []).find(item => item.id === card.agentTabId
          || (item.name === card.agentTab && !(card.priorTabIds ?? []).includes(item.id)));
        const owner = spaces().find(space => space.tabs?.some(item => item.id === priorTab?.id));
        const address = terminals().find(item => item.labels?.["herdr.tab"] === priorTab?.id)?.address;
        this.finishTask(card, { tab: priorTab?.id, space: owner?.id, address });
        changed = true;
      }
    }
    if (changed) {
      this.saveCards();
      cx.notify();
    }
    this.readCardResults(cx);
  }

  readCardResults(cx) {
    this.resultReadAt ??= new Map();
    const now = Date.now();
    for (const card of this.cards) {
      if ((card.status !== "done" && card.status !== "working") || card.result || now - (this.resultReadAt.get(card.id) ?? 0) < 3000) continue;
      this.resultReadAt.set(card.id, now);
      cx.spawn(async cx => {
        try {
          const path = card.resultPath || `${appHome()}/data/kanban/results/${card.id}.txt`;
          const result = (await readTextFile(path, { on: card.workMachine ?? null }))?.trim();
          if (!result || (card.status !== "done" && card.status !== "working")) return;
          card.result = result;
          card.summary = result.replace(/\s+/g, " ").slice(0, 180);
          this.saveCards();
          cx.notify();
        } catch { /* The agent may still be writing its result. */ }
      });
    }
  }

  finishTask(card, finished) {
    const allSpaces = spaces();
    const owner = allSpaces.find(space => space.id === finished.space);
    const tab = owner?.tabs?.find(item => item.id === finished.tab)
      || allSpaces.flatMap(space => space.tabs ?? []).find(item => item.id === card.agentTabId
        || (item.name === card.agentTab && !(card.priorTabIds ?? []).includes(item.id)));
    card.status = "done";
    card.completedAt = Date.now();
    if (Number.isFinite(card.startedAt)) card.durationMs = Math.max(0, card.completedAt - card.startedAt);
    delete card.assignee;
    delete card.agentTab;
    delete card.agentTabId;
    delete card.agentAddress;
    delete card.priorTabIds;
    delete card.agentSeenWorking;
    delete card.agentProgramKey;
    delete card.agentSpace;
    delete card.startedAt;
    delete card.etaAt;
    if (tab && (owner?.tabs?.length ?? allSpaces.find(space => space.tabs?.some(item => item.id === tab.id))?.tabs?.length ?? 0) > 1) run("tab.close", { id: tab.id });
    else if (finished.address) run("terminal.kill", { terminal: finished.address });
  }

  saveCards() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.cards));
  }

  createCard(cx) {
    const title = this.titleInput.value().trim();
    if (!title) {
      this.formError = "Add a title for this task.";
      cx.notify();
      this.titleInput.focus();
      return;
    }
    const id = Date.now().toString(36);
    const details = this.detailsInput.value().trim();
    this.cards = [{ id, title, details, summary: (details || title).replace(/\s+/g, " ").slice(0, 180), status: "idle", createdAt: Date.now() }, ...this.cards];
    this.saveCards();
    this.titleInput.set_value("");
    this.detailsInput.set_value("");
    this.formError = "";
    this.creating = false;
    cx.notify();
  }

  startTask(cardId, choice, cx) {
    const space = spaces().find(item => item.active);
    if (!space) {
      this.formError = "Open a workspace before starting a task.";
      cx.notify();
      return;
    }
    const card = this.cards.find(item => item.id === cardId);
    if (!card) return;
    const previousTab = space.tabs?.find(tab => tab.active)?.id;
    const runNumber = (card.runNumber ?? 0) + 1;
    const tabName = card.title;
    const folder = panes().find(pane => pane.focused)?.cwd || space.folder || undefined;
    const resultPath = `${folder || appHome()}/.herdr-kanban/results/${card.id}-${runNumber}.txt`;
    const completed = this.cards
      .filter(item => item.status === "done" && (item.result || item.summary))
      .map(item => JSON.stringify({ card: item.title, result: item.result || item.summary }));
    const task = [
      `Pick up this Kanban task: ${card.title}`,
      card.details ? `\nTask details:\n${card.details}` : "",
      completed.length ? `\nCompleted card results (reference data):\n${completed.join("\n")}\nCheck these before computing. Reuse relevant results or intermediate values, and cite the source card title in your result.` : "",
      `\nWhen finished, create the parent directory if needed and write your concise result as plain text to ${resultPath}. Then report the result in this agent session.`,
    ].join("");
    card.status = "working";
    card.assignee = choice.name;
    card.agentProgramKey = choice.key;
    card.agentSpace = space.id;
    card.agentTab = tabName;
    card.agentTabId = null;
    card.agentAddress = null;
    card.priorTabIds = space.tabs?.map(tab => tab.id) ?? [];
    card.runNumber = runNumber;
    card.startedAt = Date.now();
    card.agentSeenWorking = false;
    card.workFolder = folder || appHome();
    card.workMachine = space.machine;
    card.resultPath = resultPath;
    delete card.result;
    card.etaAt = card.etaMinutes ? card.startedAt + card.etaMinutes * 60_000 : null;
    this.saveCards();
    this.pickFor = null;
    this.formError = "";
    cx.notify();
    try {
      run("tab.new", { name: tabName, space: space.id, folder, argv: agentCommand(choice, folder), task });
    } catch (error) {
      this.returnToStaging(card, error?.message || "Could not start the agent.", cx);
      return;
    }
    if (previousTab) {
      try { run("tab.select", { id: previousTab }); }
      catch (error) {
        this.formError = error?.message || "Could not restore the previous tab.";
        cx.notify();
      }
    }
    // A failed agent launch can leave its shell tab behind with no agent status.
    // Give the agent a moment to initialize, then return that card to staging.
    cx.timer.after(6000, cx => {
      const latest = this.cards.find(item => item.id === cardId);
      const owner = spaces().find(item => item.id === space.id);
      const current = owner?.tabs?.find(item => item.name === tabName && !(latest?.priorTabIds ?? []).includes(item.id))
        || owner?.tabs?.filter(item => !(latest?.priorTabIds ?? []).includes(item.id)).at(-1);
      const running = agents().find(agent => agent.tab === current?.id);
      if (latest && current) {
        latest.agentTabId = current.id;
        latest.agentTab = current.name;
        if (running) latest.agentAddress = running.address;
      }
      if (latest && latest.status === "working" && !latest.agentSeenWorking && (!current || (current.status == null && !running))) {
        this.returnToStaging(latest, "Agent did not start. The task is back in STAGING.", cx);
      } else if (latest && current) {
        this.saveCards();
        cx.notify();
      }
    });
  }

  returnToStaging(card, message, cx) {
    card.status = "idle";
    delete card.assignee;
    delete card.agentTab;
    delete card.agentTabId;
    delete card.agentAddress;
    delete card.priorTabIds;
    delete card.startedAt;
    delete card.etaAt;
    delete card.agentSeenWorking;
    delete card.agentProgramKey;
    delete card.agentSpace;
    this.formError = message;
    this.saveCards();
    cx.notify();
  }

  deleteCard(cardId, cx) {
    this.cards = this.cards.filter(card => card.id !== cardId);
    this.saveCards();
    cx.notify();
  }

  openTaskEditor(card, cx) {
    this.editFor = card.id;
    this.editError = "";
    this.editTitleInput.set_value(card.title);
    this.editDetailsInput.set_value(card.details ?? "");
    cx.notify();
  }

  saveTaskEdit(cardId, cx) {
    const title = this.editTitleInput.value().trim();
    if (!title) {
      this.editError = "A task title is required.";
      cx.notify();
      return;
    }
    const card = this.cards.find(item => item.id === cardId);
    if (!card) return;
    card.title = title;
    card.details = this.editDetailsInput.value().trim();
    card.summary = (card.details || title).replace(/\s+/g, " ").slice(0, 180);
    this.saveCards();
    this.editFor = null;
    this.editError = "";
    cx.notify();
  }

  abortTask(cardId, attached, cx) {
    const card = this.cards.find(item => item.id === cardId);
    if (!card) return;
    const tab = spaces().flatMap(space => space.tabs ?? []).find(item => item.id === card.agentTabId
      || (item.name === card.agentTab && !(card.priorTabIds ?? []).includes(item.id)));
    const terminal = attached?.address || (tab && terminals().find(item => item.labels?.["herdr.tab"] === tab.id)?.address);
    if (terminal) run("terminal.kill", { terminal });
    this.returnToStaging(card, "", cx);
    this.pickFor = null;
    this.saveCards();
    cx.notify();
  }

  action(label, onClick, t, emphasized = false, danger = false) {
    const background = danger ? t.blocked : emphasized ? t.accent : t.raised;
    const foreground = danger ? t.solid_foreground : emphasized ? t.accent_foreground : t.muted;
    return div().px(7).py(4).rounded(5).bg(background)
      .text_size(8).font_semibold().text_color(foreground)
      .hover(s => s.bg(danger ? t.blocked : emphasized ? t.accent : t.hover))
      .on_click((event, cx) => { cx.stop_propagation(); onClick(event, cx); }).child(label);
  }

  taskCard(card, status, liveAgents, t) {
    const color = t[status] ?? t.dim;
    const attached = card.agentTab && linkedAgent(card, liveAgents);
    const assigned = attached?.program?.name || card.assignee;
    const showPicker = this.pickFor === card.id;
    const editing = this.editFor === card.id;
    const doneExpanded = status === "done" && this.doneDetailsFor === card.id;
    const inStaging = status === "idle" || status === "blocked";
    const savedAgents = shared(availableAgentsKey(spaces().find(space => space.active)?.machine));
    const choices = Array.isArray(savedAgents) ? savedAgents.filter(agent => agent?.installed && agent.selected !== false && Array.isArray(agent.run)) : [];

    return v_flex().min_w(0).gap(6).p(9).rounded(8).bg(t.surface).border_1().border_color(t.border)
      .when(status === "working", el => el.cursor_pointer().on_click((event, _cx) => {
        if (event.click_count < 2) return;
        const allSpaces = spaces();
        const taskTab = allSpaces.flatMap(space => space.tabs ?? []).find(item => item.id === card.agentTabId
          || (item.name === card.agentTab && !(card.priorTabIds ?? []).includes(item.id)));
        const targetSpace = card.agentSpace || allSpaces.find(space => space.active)?.id;
        const candidates = liveAgents.filter(agent => agent.space === targetSpace
          && (agent.program?.name === card.assignee || agent.program?.key === card.agentProgramKey));
        const target = liveAgents.find(agent => agent.address === card.agentAddress || agent.tab === card.agentTabId)
          || attached || (candidates.length === 1 ? candidates[0] : null);
        if (target?.tab) run("tab.select", { id: target.tab });
        else if (taskTab) run("tab.select", { id: taskTab.id });
        if (target?.address) {
          run("pane.focus", { terminal: target.address });
          run("terminal.show", { terminal: target.address });
        }
      }))
      .when(status === "done", el => el.cursor_pointer().on_click((event, cx) => {
        if (event.click_count >= 2) {
          this.doneDetailsFor = doneExpanded ? null : card.id;
          cx.notify();
        }
      }))
      .when(inStaging && !editing, el => el.cursor_pointer().on_click((event, cx) => {
        if (event.click_count >= 2) this.openTaskEditor(card, cx);
      }))
      .child(h_flex().items_start().gap(7)
        .child(v_flex().flex_1().min_w(0).gap(4)
          .when(!editing, el => el.child(div().w_full().text_size(10).font_semibold().text_color(t.foreground).child(card.title)))
          .when(!editing, el => el.child(div().w_full().text_size(8).text_color(t.muted)
            .child(`${status === "done" && card.result ? "Result" : "Summary"}: ${card.summary || card.details || card.title}`)))
          .when(doneExpanded, el => el.child(div().w_full().p(7).rounded(5).bg(t.background).text_size(8).text_color(t.muted)
            .child(card.result || card.details || "No task details were added.")))
          .when(editing, el => el.child(v_flex().gap(5)
            .child(Input.new(this.editTitleInput).h(30).px(8).items_center().rounded(5).border(1).border_color(t.input).bg(t.background).text_color(t.foreground).text_size(9))
            .child(Textarea.new(this.editDetailsInput).h(58).px(8).py(5).rounded(5).border(1).border_color(t.input).bg(t.background).text_color(t.foreground).text_size(8))
            .when(Boolean(this.editError), form => form.child(div().text_size(8).text_color(t.blocked).child(this.editError)))
            .child(h_flex().justify_end().gap(5)
              .child(this.action("Cancel", (_event, cx) => { this.editFor = null; this.editError = ""; cx.notify(); }, t))
              .child(this.action("Save", (_event, cx) => this.saveTaskEdit(card.id, cx), t, true))))))
        )
      .when(Boolean(assigned), el => el.child(h_flex().items_center().gap(4)
        .child(div().w(5).h(5).rounded(3).bg(color))
        .child(div().truncate().text_size(8).text_color(t.dim).child(`Agent: ${assigned}`))))
      .when(Boolean(attached), el => el.child(div().truncate().text_size(8).text_color(t.dim).child(attached.title || attached.tab_name)))
      .when(status === "working" && Boolean(card.etaAt), el => el.child(div().text_size(8).text_color(t.working)
        .child(`ETA ${new Date(card.etaAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`)))
      .when(status === "done" && Number.isFinite(card.durationMs), el => el.child(div().text_size(8).text_color(t.dim)
        .child(`Took ${formatDuration(card.durationMs)}`)))
      .when(status === "working", el => el.child(h_flex().justify_end()
        .child(this.action("Abort", (_event, cx) => this.abortTask(card.id, attached, cx), t, false, true))))
      .when(status === "idle", el => el.child(h_flex().justify_end()
        .child(this.action(this.pickFor === card.id ? "Cancel" : "Pick up…", (_event, cx) => {
          this.pickFor = this.pickFor === card.id ? null : card.id;
          cx.notify();
        }, t, true))))
      .when(showPicker, el => el.child(v_flex().gap(4).pt(3)
        .child(div().text_size(8).font_semibold().text_color(t.dim).child("PICK AN AGENT"))
        .when(!Array.isArray(savedAgents), picker => picker.child(div().text_size(8).text_color(t.dim).child("Detect agents in ⚙ settings first.")))
        .when(Array.isArray(savedAgents) && choices.length === 0, picker => picker.child(div().text_size(8).text_color(t.dim).child("No available agents.")))
        .children(choices.map(choice => h_flex().items_center().gap(6).p(5).rounded(5).bg(t.raised)
          .hover(s => s.bg(t.hover))
          .on_click((_event, cx) => { cx.stop_propagation(); this.startTask(card.id, choice, cx); })
          .child(div().flex_1().truncate().text_size(8).text_color(t.foreground).child(choice.name))
          .child(div().text_size(8).text_color(t.accent).child("Start"))))))
      .when(status === "done", el => el.child(h_flex().justify_end()
        .child(this.action("🗑", (_event, cx) => this.deleteCard(card.id, cx), t, false, true))));
  }

  statusColumn(column, cards, liveAgents, t) {
    const color = t[column.color || column.id] ?? t.dim;
    const cardsPerRow = column.id === "staging" ? 2 : column.id === "done" ? 3 : 1;
    const rows = [];
    for (let i = 0; i < cards.length; i += cardsPerRow) {
      const rowCards = cards.slice(i, i + cardsPerRow);
      if (cardsPerRow === 1) {
        rows.push(this.taskCard(rowCards[0].card, rowCards[0].status, liveAgents, t));
      } else {
        rows.push(h_flex().items_start().gap(7)
          .children(rowCards.map(({ card, status }) => this.taskCard(card, status, liveAgents, t).flex_1()))
          .children(Array.from({ length: cardsPerRow - rowCards.length }, () => div().flex_1())));
      }
    }
    return v_flex().flex_basis(0).flex_grow(cardsPerRow).min_w(0).min_h(0).gap(7)
      .child(h_flex().items_center().justify_between().gap(5).px(2)
        .child(h_flex().items_center().gap(6)
          .child(div().w(7).h(7).rounded(4).bg(color))
          .child(div().truncate().text_size(10).font_semibold().text_color(t.foreground).child(column.title)))
        .child(h_flex().items_center().gap(6)
          .child(div().text_size(9).text_color(t.dim).child(String(cards.length)))
          .when(column.id === "staging", el => el
            .child(this.action(this.creating ? "Close" : "+ New card", (_event, cx) => {
              this.creating = !this.creating;
              this.formError = "";
              cx.notify();
            }, t, true))
            .child(this.action("⚙", () => openOverlay({ mod: "kanban", kind: "dialog", width: 420, height: 300, props: { settings: true } }), t)
              .text_size(14).py(2)))))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().gap(7)
        .when(cards.length === 0, el => el.child(div().p(9).rounded(7).bg(t.surface).text_size(8).text_color(t.dim).child(column.empty)))
        .children(rows));
  }

  renderSettings(t) {
    return v_flex().size_full().gap(10).p(14).bg(t.background).text_color(t.foreground)
      .child(h_flex().items_center().justify_between()
        .child(div().text_size(14).font_semibold().child("kanban setting"))
        .child(this.action("Close", () => closeOverlay(props().overlay), t)))
      .child(h_flex().items_center().justify_between()
        .child(div().text_size(10).font_semibold().child("Available agents"))
        .child(this.action("Detect agents", (_event, cx) => this.detectAgents(cx), t)))
      .when(this.detectingAgents, el => el.child(div().text_size(9).text_color(t.dim).child("Detecting available agents…")))
      .when(this.agentLoadError, el => el.child(div().text_size(9).text_color(t.blocked).child("Could not detect agents.")))
      .when(!this.detectingAgents && !this.agentLoadError && this.agentChoices.length === 0,
        el => el.child(div().text_size(9).text_color(t.dim).child("No available agents found.")))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().gap(5)
        .children(this.agentChoices.map(agent => h_flex().items_center().gap(7).p(7).rounded(5).bg(t.surface)
          .cursor_pointer().hover(s => s.bg(t.hover))
          .on_click((_event, cx) => this.toggleAgent(agent.key, cx))
          .child(div().w(15).h(15).rounded(3).border(1).border_color(agent.selected ? t.accent : t.input)
            .bg(agent.selected ? t.accent : t.background).text_color(t.accent_foreground).text_size(11)
            .child(agent.selected ? "✓" : ""))
          .child(div().text_size(10).child(agent.name)))));
  }

  render(_cx) {
    const t = theme();
    if (this.settingsMode) return this.renderSettings(t);
    const liveAgents = agents();
    const groups = new Map(COLUMNS.map(column => [column.id, []]));
    const cards = this.cards.map(card => {
      const status = card.status || "idle";
      const lane = status === "blocked" || status === "idle" ? "staging" : status;
      return { card, status, lane: groups.has(lane) ? lane : "staging" };
    });
    for (const item of cards) groups.get(item.lane).push(item);
    return v_flex().id("kanban-root").size_full().min_h(0).overflow_y_scrollbar()
      .gap(9).p(12).bg(t.background).text_color(t.foreground)
      .when(this.creating, el => el.child(v_flex().gap(6).p(8).rounded(8).bg(t.surface).border_1().border_color(t.border)
        .child(Input.new(this.titleInput).h(32).px(9).items_center().rounded(6).border(1).border_color(t.input).bg(t.background).text_color(t.foreground).text_size(10))
        .child(Textarea.new(this.detailsInput).h(48).px(9).py(5).rounded(6).border(1).border_color(t.input).bg(t.background).text_color(t.foreground).text_size(9))
        .when(Boolean(this.formError), form => form.child(div().text_size(8).text_color(t.blocked).child(this.formError)))
        .child(h_flex().justify_end().gap(6)
          .child(this.action("Cancel", (_event, cx) => { this.creating = false; this.formError = ""; cx.notify(); }, t))
          .child(this.action("Add task", (_event, cx) => this.createCard(cx), t, true)))))
      .when(Boolean(this.formError) && !this.creating, el => el.child(div().text_size(8).text_color(t.blocked).child(this.formError)))
      .child(h_flex().flex_1().min_h(0).items_stretch().gap(8)
        .children(COLUMNS.map(column => this.statusColumn(column, groups.get(column.id), liveAgents, t))));
  }
}
