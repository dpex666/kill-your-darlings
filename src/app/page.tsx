"use client";

import React, { useEffect, useMemo, useState } from "react";

type ProofType = "link" | "text";
type IdeaStatus = "backlog" | "active" | "shipped" | "killed";

type Idea = {
  id: string;
  title: string;
  createdAt: number; // ms
  deadlineAt: number; // ms
  proofType: ProofType;
  status: IdeaStatus;

  // Resolution fields
  proofValue?: string;
  killedReason?: string;
  resolvedAt?: number; // ms
};

type AppState = {
  version: 1;
  ideas: Idea[];
  settings: {
    activeLimit: number;
  };
};

const STORAGE_KEY = "kyd_state_v1";

// ---------------------------
// Storage adapter (localStorage)
// ---------------------------
function loadState(): AppState {
  if (typeof window === "undefined") {
    return { version: 1, ideas: [], settings: { activeLimit: 5 } };
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { version: 1, ideas: [], settings: { activeLimit: 5 } };

    const parsed = JSON.parse(raw) as AppState;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.ideas)) {
      return { version: 1, ideas: [], settings: { activeLimit: 5 } };
    }

    return {
      version: 1,
      ideas: parsed.ideas,
      settings: parsed.settings ?? { activeLimit: 5 },
    };
  } catch {
    return { version: 1, ideas: [], settings: { activeLimit: 5 } };
  }
}

function saveState(state: AppState) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

// ---------------------------
// Helpers
// ---------------------------
function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function fmtDate(ms: number) {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function msToParts(ms: number) {
  const clamped = Math.max(0, ms);
  const totalSeconds = Math.floor(clamped / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return { days, hours, minutes, seconds };
}

function isExpired(idea: Idea, now: number) {
  return idea.status === "active" && now >= idea.deadlineAt;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

// ---------------------------
// Page
// ---------------------------
export default function Page() {
  const [state, setState] = useState<AppState>(() => ({
    version: 1,
    ideas: [],
    settings: { activeLimit: 5 },
  }));

  const [hydrated, setHydrated] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());

  // Edit panel state
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDays, setEditDays] = useState<number>(14);
  const [editProofType, setEditProofType] = useState<ProofType>("link");
  const [editStatus, setEditStatus] = useState<"backlog" | "active">("backlog");

  // Backlog collapse state
  const [backlogOpen, setBacklogOpen] = useState(false);

  // New idea form
  const [title, setTitle] = useState("");
  const [days, setDays] = useState<number>(14);
  const [proofType, setProofType] = useState<ProofType>("link");
  const [addAsActive, setAddAsActive] = useState(false);

  // Selection panel
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdea = useMemo(
    () => state.ideas.find((i) => i.id === selectedId) ?? null,
    [selectedId, state.ideas]
  );

  // Load on mount
  useEffect(() => {
    const loaded = loadState();
    setState(loaded);
    setHydrated(true);
  }, []);

  // Persist after hydration
  useEffect(() => {
    if (!hydrated) return;
    saveState(state);
  }, [state, hydrated]);

  // Tick for countdowns
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const activeIdeas = useMemo(
    () =>
      state.ideas
        .filter((i) => i.status === "active")
        .sort((a, b) => a.deadlineAt - b.deadlineAt),
    [state.ideas]
  );

  const backlogIdeas = useMemo(
    () =>
      state.ideas
        .filter((i) => i.status === "backlog")
        .sort((a, b) => b.createdAt - a.createdAt),
    [state.ideas]
  );

  const shippedIdeas = useMemo(
    () =>
      state.ideas
        .filter((i) => i.status === "shipped")
        .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0)),
    [state.ideas]
  );

  const killedIdeas = useMemo(
    () =>
      state.ideas
        .filter((i) => i.status === "killed")
        .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0)),
    [state.ideas]
  );

  const canAddToActive = activeIdeas.length < state.settings.activeLimit;

  const expiredCount = useMemo(
    () => activeIdeas.filter((i) => isExpired(i, now)).length,
    [activeIdeas, now]
  );

  const stats = useMemo(
    () => ({
      backlog: backlogIdeas.length,
      active: `${activeIdeas.length}/${state.settings.activeLimit}`,
      shipped: shippedIdeas.length,
      killed: killedIdeas.length,
      expired: expiredCount,
    }),
    [
      backlogIdeas.length,
      activeIdeas.length,
      shippedIdeas.length,
      killedIdeas.length,
      expiredCount,
      state.settings.activeLimit,
    ]
  );

  // Preload edit fields when selection changes
  useEffect(() => {
    if (!selectedIdea) return;
    setEditing(false);
    setEditTitle(selectedIdea.title);
    setEditProofType(selectedIdea.proofType);
    setEditStatus(selectedIdea.status === "active" ? "active" : "backlog");

    const remainingDays = Math.ceil(
      (selectedIdea.deadlineAt - Date.now()) / (24 * 60 * 60 * 1000)
    );
    setEditDays(clamp(isFinite(remainingDays) ? remainingDays : 14, 1, 90));
  }, [selectedIdea?.id]);

  function updateIdea() {
    if (!selectedIdea) return;

    const t = editTitle.trim();
    if (!t) return;

    const movingToActive =
      editStatus === "active" && selectedIdea.status !== "active";
    if (movingToActive && !canAddToActive) return;

    const useDays = clamp(editDays || 14, 1, 90);
    const newDeadlineAt = Date.now() + useDays * 24 * 60 * 60 * 1000;

    setState((prev) => ({
      ...prev,
      ideas: prev.ideas.map((i) =>
        i.id === selectedIdea.id
          ? {
              ...i,
              title: t,
              proofType: editProofType,
              status: editStatus,
              deadlineAt: newDeadlineAt,
            }
          : i
      ),
    }));

    setEditing(false);

    if (editStatus === "active") setBacklogOpen(false);
    if (editStatus === "backlog") setSelectedId(null);
  }

  function addIdea() {
    const t = title.trim();
    if (!t) return;

    const createdAt = Date.now();
    const useDays = clamp(days || 14, 1, 90);
    const deadlineAt = createdAt + useDays * 24 * 60 * 60 * 1000;

    const wantActive = addAsActive && canAddToActive;

    const newIdea: Idea = {
      id: uid(),
      title: t,
      createdAt,
      deadlineAt,
      proofType,
      status: wantActive ? "active" : "backlog",
    };

    setState((prev) => ({
      ...prev,
      ideas: [newIdea, ...prev.ideas],
    }));

    setTitle("");
    setAddAsActive(false);

    if (newIdea.status === "active") {
      setSelectedId(newIdea.id);
    }
  }

  function promoteToActive(id: string) {
    if (!canAddToActive) return;

    setState((prev) => ({
      ...prev,
      ideas: prev.ideas.map((i) =>
        i.id === id && i.status === "backlog" ? { ...i, status: "active" } : i
      ),
    }));

    setBacklogOpen(false);
  }

  function shipIdea(id: string, proofValue: string) {
    const val = proofValue.trim();
    if (!val) return;

    setState((prev) => ({
      ...prev,
      ideas: prev.ideas.map((i) =>
        i.id === id
          ? { ...i, status: "shipped", proofValue: val, resolvedAt: Date.now() }
          : i
      ),
    }));
    setSelectedId(null);
  }

  function killIdea(id: string, reason: string) {
    const r = reason.trim();
    if (!r) return;

    setState((prev) => ({
      ...prev,
      ideas: prev.ideas.map((i) =>
        i.id === id
          ? { ...i, status: "killed", killedReason: r, resolvedAt: Date.now() }
          : i
      ),
    }));
    setSelectedId(null);
  }

  function deleteIdea(id: string) {
    setState((prev) => ({
      ...prev,
      ideas: prev.ideas.filter((i) => i.id !== id),
    }));
    if (selectedId === id) setSelectedId(null);
  }

  function resetAll() {
    setState({ version: 1, ideas: [], settings: { activeLimit: 5 } });
    setSelectedId(null);
    setBacklogOpen(false);
    setEditing(false);
  }

  if (!hydrated) {
    return (
      <main className="min-h-screen bg-zinc-950 text-zinc-100">
        <div className="mx-auto max-w-5xl px-4 py-10 text-sm text-zinc-400">
          Loading…
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen text-zinc-100">
      {/* Background (dark, non-retro, readable) */}
      <div className="fixed inset-0 -z-10 bg-[#070A14]">
        <div className="absolute inset-0 bg-[radial-gradient(60%_50%_at_15%_10%,rgba(255,255,255,0.08),transparent_60%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(55%_45%_at_85%_15%,rgba(255,255,255,0.06),transparent_65%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(70%_55%_at_45%_90%,rgba(255,255,255,0.05),transparent_65%)]" />
        <div className="absolute inset-0 opacity-[0.12] mix-blend-overlay bg-[radial-gradient(circle_at_18%_28%,rgba(34,211,238,0.40),transparent_44%),radial-gradient(circle_at_82%_22%,rgba(232,121,249,0.30),transparent_52%),radial-gradient(circle_at_55%_84%,rgba(190,242,100,0.22),transparent_58%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_bottom,rgba(0,0,0,0.35),transparent_30%,rgba(0,0,0,0.55))]" />
      </div>

      <div className="mx-auto max-w-5xl px-4 py-10">
        {/* Header */}
        <header className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-3">
  {/* Tiny brand mark */}
  <div className="h-9 w-9 rounded-2xl border border-zinc-800 bg-zinc-950/40 backdrop-blur">
    <div className="h-full w-full rounded-2xl bg-[radial-gradient(circle_at_30%_30%,rgba(34,211,238,0.55),transparent_55%),radial-gradient(circle_at_70%_70%,rgba(232,121,249,0.45),transparent_60%)]" />
  </div>

  <div>
    <h1 className="relative text-3xl font-semibold tracking-tight">
      {/* soft glow */}
      <span className="pointer-events-none absolute -inset-x-3 -inset-y-2 -z-10 blur-2xl opacity-40 bg-[radial-gradient(circle_at_30%_40%,rgba(34,211,238,0.35),transparent_55%),radial-gradient(circle_at_70%_40%,rgba(232,121,249,0.30),transparent_60%)]" />
      {/* gradient title */}
      <span className="bg-gradient-to-r from-cyan-200 via-zinc-100 to-fuchsia-200 bg-clip-text text-transparent">
        Kill Your Darlings
      </span>
    </h1>

    <p className="mt-1 text-sm text-zinc-400">
      Run <span className="text-zinc-200">max 5</span>. Ship or kill.{" "}
      <span className="text-zinc-200">Proof required.</span>
    </p>
  </div>
</div>

            </div>

            <button
              onClick={resetAll}
              className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-900/40"
              title="Wipes local data for this site on this browser"
            >
              Reset (local)
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
            <StatChip label="Backlog" value={stats.backlog} tone="backlog" />
            <StatChip label="Active" value={stats.active} tone="active" />
            <StatChip label="Shipped" value={stats.shipped} tone="shipped" />
            <StatChip label="Killed" value={stats.killed} tone="killed" />
            <StatChip
              label="Expired"
              value={stats.expired}
              tone={expiredCount > 0 ? "danger" : "neutral"}
            />
          </div>
        </header>

        {/* Add Idea (stacked) */}
        <section className="relative mt-8 rounded-2xl border border-zinc-800/70 bg-zinc-900/20 p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.04),0_0_40px_rgba(34,211,238,0.06)] backdrop-blur">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/40 to-transparent" />

          <div className="flex flex-col gap-4">
            <div>
              <label className="text-xs text-zinc-400">Idea</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Ship the MVP landing page"
                className="mt-1 h-12 w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 text-sm outline-none placeholder:text-zinc-600 focus:border-zinc-600"
                maxLength={120}
              />
              <div className="mt-1 text-[11px] text-zinc-500">{title.length}/120</div>
            </div>

            <div>
              <label className="text-xs text-zinc-400">Deadline (days)</label>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={days === 0 ? "" : String(days)}
                onChange={(e) => {
                  const val = e.target.value.replace(/\D/g, "");
                  if (val === "") {
                    setDays(0);
                    return;
                  }
                  setDays(clamp(Number(val), 1, 90));
                }}
                onBlur={() => {
                  if (!days || days < 1) setDays(14);
                }}
                className="mt-1 h-12 w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 text-sm outline-none focus:border-zinc-600"
                placeholder="e.g. 14"
              />
              <div className="mt-1 text-[11px] text-zinc-500">
                Tip: keep it tight. 7–21 days is the sweet spot.
              </div>
            </div>

            <div>
              <label className="text-xs text-zinc-400">Proof</label>
              <select
                value={proofType}
                onChange={(e) => setProofType(e.target.value as ProofType)}
                className="mt-1 h-12 w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 text-sm outline-none focus:border-zinc-600"
              >
                <option value="link">Link</option>
                <option value="text">Text</option>
              </select>

              <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950/30 px-3 py-2">
                <div className="flex items-center gap-2">
                  <input
                    id="addAsActive"
                    type="checkbox"
                    checked={addAsActive}
                    onChange={(e) => setAddAsActive(e.target.checked)}
                    disabled={!canAddToActive}
                    className="h-4 w-4 accent-zinc-100"
                  />
                  <label htmlFor="addAsActive" className="text-xs text-zinc-300">
                    Add as Active (uses a slot)
                  </label>
                </div>

                {!canAddToActive && <span className="text-[11px] text-zinc-500">Active full</span>}
              </div>
            </div>

            <div className="pt-1">
              <button
                onClick={addIdea}
                disabled={!title.trim()}
                className="h-12 w-full rounded-xl bg-gradient-to-r from-cyan-300 to-fuchsia-300 text-sm font-semibold text-zinc-950 shadow-[0_10px_30px_rgba(34,211,238,0.10)] hover:opacity-95 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {addAsActive && canAddToActive ? "Add to Active" : "Add to Backlog"}
              </button>

              {!canAddToActive && (
                <div className="mt-2 rounded-xl border border-zinc-800 bg-zinc-950/30 p-3 text-xs text-zinc-400">
                  Active is full. Add to backlog now, then promote the winner later.
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Active */}
        <section className="relative mt-8 rounded-2xl border border-zinc-800/70 bg-zinc-900/15 p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.04)] backdrop-blur">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/30 to-transparent" />

          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Active</h2>
            <p className="text-xs text-zinc-500">
              Max {state.settings.activeLimit} at once. Pressure is the point.
            </p>
          </div>

          {activeIdeas.length === 0 ? (
            <EmptyCard text="No active ideas. Promote something from backlog or add as active." />
          ) : (
            <div className="grid gap-3">
              {activeIdeas.map((idea) => {
                const remaining = idea.deadlineAt - now;
                const expired = remaining <= 0;
                const { days, hours, minutes, seconds } = msToParts(remaining);

                return (
                  <button
                    key={idea.id}
                    onClick={() => setSelectedId(idea.id)}
                    className={cx(
                      "w-full rounded-2xl border p-4 text-left transition",
                      "bg-zinc-950/30 hover:bg-zinc-950/40",
                      expired ? "border-rose-500/30 shadow-[0_0_40px_rgba(244,63,94,0.06)]" : "border-zinc-800/70"
                    )}
                  >
                    <div className="flex flex-col gap-2">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium">{idea.title}</div>
                          <div className="mt-1 text-xs text-zinc-500">
                            Created {fmtDate(idea.createdAt)} · Deadline {fmtDate(idea.deadlineAt)}
                          </div>
                        </div>

                        <div
                          className={cx(
                            "shrink-0 rounded-full border px-3 py-1 text-xs",
                            expired
                              ? "border-rose-500/30 bg-rose-950/20 text-rose-200"
                              : "border-zinc-800 bg-zinc-950/40 text-zinc-200"
                          )}
                        >
                          {expired ? (
                            <span>Expired</span>
                          ) : (
                            <span>
                              {days}d {hours}h {minutes}m {seconds}s
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="text-xs text-zinc-500">
                        Proof: <span className="text-zinc-300">{idea.proofType}</span>
                      </div>

                      {expired && (
                        <div className="text-xs text-rose-200/80">
                          Time’s up. Open this and ship proof or kill it.
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* Backlog (collapsed by default) */}
        <section className="relative mt-6 rounded-2xl border border-zinc-800/70 bg-zinc-900/15 p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.04)] backdrop-blur">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-fuchsia-400/25 to-transparent" />

          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">
                Backlog{" "}
                <span className="ml-2 rounded-full border border-zinc-800 bg-zinc-950/30 px-2 py-0.5 text-xs text-zinc-300">
                  {backlogIdeas.length}
                </span>
              </h2>
              <p className="mt-1 text-xs text-zinc-500">Capture freely. Promote only the winners.</p>
            </div>

            <button
              onClick={() => setBacklogOpen((v) => !v)}
              className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-900/40"
            >
              {backlogOpen ? "Hide" : "Show"}
            </button>
          </div>

          {backlogOpen && (
            <div className="mt-4">
              {backlogIdeas.length === 0 ? (
                <EmptyCard text="No backlog ideas yet. Dump ideas here freely, then promote the winners." />
              ) : (
                <div className="grid gap-3">
                  {backlogIdeas.map((idea) => (
                    <div
                      key={idea.id}
                      className="rounded-2xl border border-zinc-800/70 bg-zinc-950/30 p-4 transition hover:bg-zinc-950/40"
                    >
                      <div className="flex flex-col gap-3">
                        <div>
                          <div className="text-sm font-medium">{idea.title}</div>
                          <div className="mt-1 text-xs text-zinc-500">
                            Captured {fmtDate(idea.createdAt)} · Default deadline {fmtDate(idea.deadlineAt)} · Proof{" "}
                            <span className="text-zinc-300">{idea.proofType}</span>
                          </div>
                        </div>

                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => promoteToActive(idea.id)}
                            disabled={!canAddToActive}
                            className="rounded-xl bg-gradient-to-r from-cyan-300 to-fuchsia-300 px-3 py-2 text-xs font-semibold text-zinc-950 shadow-sm hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            Promote to Active
                          </button>

                          <button
                            onClick={() => deleteIdea(idea.id)}
                            className="rounded-xl border border-zinc-800 bg-transparent px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-900/40"
                          >
                            Delete
                          </button>

                          {!canAddToActive && (
                            <span className="self-center text-[11px] text-zinc-500">Active full</span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

        {/* Detail panel */}
        {selectedIdea && (
          <section className="relative mt-8 rounded-2xl border border-zinc-800/70 bg-zinc-900/20 p-5 shadow-[0_0_0_1px_rgba(255,255,255,0.04)] backdrop-blur">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-lime-300/20 to-transparent" />

            <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
              <div>
                <h3 className="text-base font-semibold">Decision time</h3>
                <div className="mt-1 text-sm text-zinc-300">{selectedIdea.title}</div>
                <div className="mt-1 text-xs text-zinc-500">
                  Deadline {fmtDate(selectedIdea.deadlineAt)} · Proof type{" "}
                  <span className="text-zinc-200">{selectedIdea.proofType}</span>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => setEditing((v) => !v)}
                  className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-900/40"
                >
                  {editing ? "Close edit" : "Edit"}
                </button>

                <button
                  onClick={() => setSelectedId(null)}
                  className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-900/40"
                >
                  Close
                </button>

                <button
                  onClick={() => deleteIdea(selectedIdea.id)}
                  className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-900/40"
                  title="Remove completely"
                >
                  Delete
                </button>
              </div>
            </div>

            {/* Edit panel */}
            {editing && (
              <div className="mt-4 rounded-2xl border border-zinc-800/70 bg-zinc-950/30 p-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="md:col-span-2">
                    <label className="text-xs text-zinc-400">Title</label>
                    <input
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      className="mt-1 h-12 w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 text-sm outline-none focus:border-zinc-600"
                      maxLength={120}
                    />
                    <div className="mt-1 text-[11px] text-zinc-500">{editTitle.length}/120</div>
                  </div>

                  <div>
                    <label className="text-xs text-zinc-400">Deadline (days from today)</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={editDays === 0 ? "" : String(editDays)}
                      onChange={(e) => {
                        const val = e.target.value.replace(/\D/g, "");
                        if (val === "") return setEditDays(0);
                        setEditDays(clamp(Number(val), 1, 90));
                      }}
                      onBlur={() => {
                        if (!editDays || editDays < 1) setEditDays(14);
                      }}
                      className="mt-1 h-12 w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 text-sm outline-none focus:border-zinc-600"
                      placeholder="e.g. 14"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-zinc-400">Proof</label>
                    <select
                      value={editProofType}
                      onChange={(e) => setEditProofType(e.target.value as ProofType)}
                      className="mt-1 h-12 w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 text-sm outline-none focus:border-zinc-600"
                    >
                      <option value="link">Link</option>
                      <option value="text">Text</option>
                    </select>
                  </div>

                  <div className="md:col-span-2">
                    <label className="text-xs text-zinc-400">Status</label>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {(["backlog", "active"] as const).map((s) => {
                        const disabled =
                          s === "active" && selectedIdea.status !== "active" && !canAddToActive;

                        return (
                          <button
                            key={s}
                            onClick={() => !disabled && setEditStatus(s)}
                            className={cx(
                              "rounded-xl border px-3 py-2 text-xs",
                              editStatus === s
                                ? "border-zinc-600 bg-zinc-900/40 text-zinc-100"
                                : "border-zinc-800 bg-zinc-950/30 text-zinc-300 hover:bg-zinc-900/30",
                              disabled && "cursor-not-allowed opacity-40"
                            )}
                          >
                            {s === "backlog" ? "Backlog" : "Active"}
                          </button>
                        );
                      })}

                      {selectedIdea.status !== "active" && !canAddToActive && (
                        <span className="self-center text-[11px] text-zinc-500">
                          Active full (ship/kill to free a slot)
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex gap-2">
                  <button
                    onClick={updateIdea}
                    disabled={
                      !editTitle.trim() ||
                      (editStatus === "active" && selectedIdea.status !== "active" && !canAddToActive)
                    }
                    className="rounded-xl bg-gradient-to-r from-cyan-300 to-fuchsia-300 px-4 py-2 text-sm font-semibold text-zinc-950 shadow-sm hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Save changes
                  </button>

                  <button
                    onClick={() => setEditing(false)}
                    className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-900/40"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            <DecisionActions
              idea={selectedIdea}
              onShip={(proof) => shipIdea(selectedIdea.id, proof)}
              onKill={(reason) => killIdea(selectedIdea.id, reason)}
            />
          </section>
        )}

        {/* Shipped + Graveyard */}
        <section className="mt-10 grid gap-6 md:grid-cols-2">
          <div className="relative rounded-2xl border border-zinc-800/70 bg-zinc-900/15 p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.04)] backdrop-blur">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-lime-300/25 to-transparent" />
            <h2 className="mb-3 text-lg font-semibold">Shipped</h2>
            {shippedIdeas.length === 0 ? (
              <EmptyCard text="Nothing shipped yet. Start small and finish something." />
            ) : (
              <div className="grid gap-3">
                {shippedIdeas.map((i) => (
                  <div key={i.id} className="rounded-2xl border border-zinc-800/70 bg-zinc-950/30 p-4">
                    <div className="text-sm font-medium">{i.title}</div>
                    <div className="mt-1 text-xs text-zinc-500">
                      Resolved {i.resolvedAt ? fmtDate(i.resolvedAt) : ""}
                    </div>
                    {i.proofValue && (
                      <div className="mt-2 text-sm text-zinc-200">
                        Proof:{" "}
                        {i.proofType === "link" ? (
                          <a className="underline" href={i.proofValue} target="_blank" rel="noreferrer">
                            {i.proofValue}
                          </a>
                        ) : (
                          <span className="text-zinc-300">{i.proofValue}</span>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="relative rounded-2xl border border-zinc-800/70 bg-zinc-900/15 p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.04)] backdrop-blur">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber-300/20 to-transparent" />
            <h2 className="mb-3 text-lg font-semibold">Graveyard</h2>
            {killedIdeas.length === 0 ? (
              <EmptyCard text="Nothing killed yet. That’s fine. Killing bad ideas early is a skill." />
            ) : (
              <div className="grid gap-3">
                {killedIdeas.map((i) => (
                  <div key={i.id} className="rounded-2xl border border-zinc-800/70 bg-zinc-950/30 p-4">
                    <div className="text-sm font-medium">{i.title}</div>
                    <div className="mt-1 text-xs text-zinc-500">
                      Killed {i.resolvedAt ? fmtDate(i.resolvedAt) : ""}
                    </div>
                    {i.killedReason && <div className="mt-2 text-sm text-zinc-300">Reason: {i.killedReason}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <footer className="mt-10 text-xs text-zinc-500">
          Run max 5. Ship or kill. Proof required.
        </footer>
      </div>
    </main>
  );
}

// ---------------------------
// UI Helpers
// ---------------------------
function StatChip({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  tone?: "neutral" | "active" | "backlog" | "shipped" | "killed" | "danger";
}) {
  const toneClass =
    tone === "active"
      ? "border-cyan-400/30 shadow-[0_0_0_1px_rgba(34,211,238,0.15),0_0_24px_rgba(34,211,238,0.06)]"
      : tone === "backlog"
      ? "border-fuchsia-400/25 shadow-[0_0_0_1px_rgba(232,121,249,0.12),0_0_24px_rgba(232,121,249,0.05)]"
      : tone === "shipped"
      ? "border-lime-300/25 shadow-[0_0_0_1px_rgba(190,242,100,0.10),0_0_24px_rgba(190,242,100,0.05)]"
      : tone === "killed"
      ? "border-amber-300/25 shadow-[0_0_0_1px_rgba(252,211,77,0.10),0_0_24px_rgba(252,211,77,0.05)]"
      : tone === "danger"
      ? "border-rose-400/30 shadow-[0_0_0_1px_rgba(251,113,133,0.14),0_0_24px_rgba(251,113,133,0.06)]"
      : "border-zinc-800/70 shadow-[0_0_0_1px_rgba(255,255,255,0.04)]";

  const valueClass =
    tone === "active"
      ? "text-cyan-200"
      : tone === "backlog"
      ? "text-fuchsia-200"
      : tone === "shipped"
      ? "text-lime-200"
      : tone === "killed"
      ? "text-amber-200"
      : tone === "danger"
      ? "text-rose-200"
      : "text-zinc-100";

  return (
    <div className={cx("rounded-2xl border bg-zinc-900/15 px-4 py-3 backdrop-blur", toneClass)}>
      <div className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={cx("mt-1 text-lg font-semibold", valueClass)}>{value}</div>
    </div>
  );
}

function EmptyCard({ text }: { text: string }) {
  return (
    <div className="rounded-2xl border border-zinc-800/70 bg-zinc-950/20 p-6 text-sm text-zinc-400">
      {text}
    </div>
  );
}

function DecisionActions({
  idea,
  onShip,
  onKill,
}: {
  idea: Idea;
  onShip: (proof: string) => void;
  onKill: (reason: string) => void;
}) {
  const [proof, setProof] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    setProof("");
    setReason("");
  }, [idea.id]);

  return (
    <div className="mt-5 grid gap-4 md:grid-cols-2">
      <div className="relative rounded-2xl border border-zinc-800/70 bg-zinc-950/30 p-4">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-lime-300/20 to-transparent" />
        <div className="text-sm font-semibold">Ship it</div>
        <div className="mt-1 text-xs text-zinc-500">
          Provide {idea.proofType === "link" ? "a link" : "a short proof note"} and mark as shipped.
        </div>

        <textarea
          value={proof}
          onChange={(e) => setProof(e.target.value)}
          placeholder={idea.proofType === "link" ? "https://..." : "What did you ship?"}
          className="mt-3 w-full resize-none rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-3 text-sm outline-none placeholder:text-zinc-600 focus:border-zinc-600"
          rows={3}
        />

        <button
          onClick={() => onShip(proof)}
          disabled={!proof.trim()}
          className="mt-3 w-full rounded-xl bg-gradient-to-r from-lime-200 to-cyan-200 px-4 py-3 text-sm font-semibold text-zinc-950 shadow-sm hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Mark Shipped
        </button>
      </div>

      <div className="relative rounded-2xl border border-zinc-800/70 bg-zinc-950/30 p-4">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber-300/20 to-transparent" />
        <div className="text-sm font-semibold">Kill it</div>
        <div className="mt-1 text-xs text-zinc-500">Give a reason. Killing is part of taste. Be honest.</div>

        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Not differentiated enough / too much effort for low upside / wrong timing"
          className="mt-3 w-full resize-none rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-3 text-sm outline-none placeholder:text-zinc-600 focus:border-zinc-600"
          rows={3}
        />

        <button
          onClick={() => onKill(reason)}
          disabled={!reason.trim()}
          className="mt-3 w-full rounded-xl border border-zinc-800 bg-transparent px-4 py-3 text-sm font-semibold text-zinc-100 hover:bg-zinc-900/40 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Kill Idea
        </button>
      </div>
    </div>
  );
}
