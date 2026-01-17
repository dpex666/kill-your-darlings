"use client";

import React, { useEffect, useMemo, useState } from "react";

import SupportBuild from "@/components/SupportBuild";
import {
  canSendMoreNotifications,
  defaultNotificationPrefs,
  fireNotification,
  getNotificationPermission,
  isNotificationSupported,
  isQuietHours,
  loadNotificationPrefs,
  pruneNotifyLog,
  requestNotificationPermission,
  saveNotificationPrefs,
  type NotificationPrefs,
} from "@/lib/notify";
import { sparkConstraints, sparkLibrary, type Domain } from "@/lib/sparkLibrary";
import { SUPPORT_URL } from "@/lib/support";

type ProofType = "link" | "text";

type IdeaStatus = "backlog" | "active" | "shipped" | "killed";
type KillReasonCode =
  | "TIME_EXPIRED"
  | "NO_LONGER_RELEVANT"
  | "TOO_BIG"
  | "NO_CLEAR_USER_PROBLEM"
  | "LOST_INTEREST"
  | "BLOCKED"
  | "OTHER";
type ProofAttachmentType = "url" | "github" | "note";

type Idea = {
  id: string;
  title: string;
  createdAt: number; // ms
  deadlineAt: number; // ms
  proofType: ProofType;
  status: IdeaStatus;
  problemStatement: string;
  audience: string;
  proofDefinition: string;
  killTrigger: string;
  notes: string;
  betCommitted: boolean;
  proofs: Array<{
    id: string;
    type: ProofAttachmentType;
    value: string;
  }>;

  // Resolution fields
  killReasonCode?: KillReasonCode;
  killReasonDetail?: string;
  resolvedAt?: number; // ms
};

type BoxItem = {
  id: string;
  content: string;
  domain: Domain;
  createdAt: number;
  nextRevealAt: number;
  returnCount: number;
  lastReturnedReason?: string;
  earlyUnlockDebt?: {
    reason: string;
    createdAt: number;
    resolved?: boolean;
  };
  origin?: "captured" | "expired_active";
  linkedIdeaId?: string;
};

type AppState = {
  version: 3;
  ideas: Idea[];
  box: BoxItem[];
  spark: {
    usedToday: number;
    dayKey: string;
    lastSpark?: { prompt: string; domain: Domain; createdAt: number };
    recentPromptIds: string[];
  };
  settings: {
    activeLimit: number;
  };
  domainWindows: Record<Domain, { nextOpenAt: number }>;
  lastBoxOpenAt?: number;
};

type AppStateV2 = {
  version: 2;
  ideas: Idea[];
  settings?: {
    activeLimit?: number;
  };
  lastActivationWeek?: string;
};

type AppStateV1 = {
  version: 1;
  ideas: Array<{
    id: string;
    title: string;
    createdAt: number;
    deadlineAt: number;
    proofType: ProofType;
    status: IdeaStatus;
    proofValue?: string;
    killedReason?: string;
    resolvedAt?: number;
  }>;
  settings?: {
    activeLimit?: number;
  };
};

const STORAGE_KEY = "kyd_state_v3";
const LEGACY_STORAGE_KEY = "kyd_state_v2";
const LEGACY_STORAGE_KEY_V1 = "kyd_state_v1";

const domains: Domain[] = [
  "business",
  "career",
  "relationships",
  "dating",
  "lifestyle",
  "random",
];

const domainLabels: Record<Domain, string> = {
  business: "Business",
  career: "Career",
  relationships: "Relationships",
  dating: "Dating",
  lifestyle: "Lifestyle",
  random: "Random",
};

const defaultDaysByDomain: Record<Domain, number> = {
  business: 21,
  career: 21,
  relationships: 14,
  dating: 14,
  lifestyle: 14,
  random: 7,
};

const boxKillReasons: Array<{ code: KillReasonCode; label: string }> = [
  { code: "NO_LONGER_RELEVANT", label: "No longer relevant" },
  { code: "TOO_BIG", label: "Too big" },
  { code: "NO_CLEAR_USER_PROBLEM", label: "No clear user problem" },
  { code: "LOST_INTEREST", label: "Lost interest" },
  { code: "BLOCKED", label: "Blocked" },
  { code: "OTHER", label: "Other" },
];

// ---------------------------
// Storage adapter (localStorage)
// ---------------------------
function defaultDomainWindows(now: number): AppState["domainWindows"] {
  return domains.reduce((acc, domain) => {
    acc[domain] = { nextOpenAt: now };
    return acc;
  }, {} as AppState["domainWindows"]);
}

function defaultState(): AppState {
  const now = Date.now();
  return {
    version: 3,
    ideas: [],
    box: [],
    spark: {
      usedToday: 0,
      dayKey: dayKeyLocal(),
      recentPromptIds: [],
    },
    settings: { activeLimit: 5 },
    domainWindows: defaultDomainWindows(now),
    lastBoxOpenAt: undefined,
  };
}

function migrateStateV1(data: AppStateV1): AppStateV2 {
  const ideas: Idea[] = (data.ideas ?? []).map((idea): Idea => {
    const proofValue = idea.proofValue?.trim();

    const migratedProofs: Idea["proofs"] = proofValue
      ? [
          {
            id: uid(),
            type: idea.proofType === "link" ? "url" : "note",
            value: proofValue,
          },
        ]
      : [];

    const killReasonDetail = idea.killedReason?.trim() ?? "";

    return {
      id: idea.id,
      title: idea.title,
      createdAt: idea.createdAt,
      deadlineAt: idea.deadlineAt,
      proofType: idea.proofType,
      status: idea.status,

      // v2 additions
      problemStatement: "",
      audience: "",
      proofDefinition: "",
      killTrigger: "",
      notes: "",
      betCommitted: false,
      proofs: migratedProofs,

      // resolution mapping
      killReasonCode: idea.status === "killed" ? "OTHER" : undefined,
      killReasonDetail: idea.status === "killed" ? killReasonDetail : undefined,
      resolvedAt: idea.resolvedAt,
    };
  });

  return {
    version: 2,
    ideas,
    settings: { activeLimit: data.settings?.activeLimit ?? 5 },
    lastActivationWeek: "",
  };
}

function randomDelayMs(minHours: number, maxHours: number) {
  const minMs = minHours * 60 * 60 * 1000;
  const maxMs = maxHours * 60 * 60 * 1000;
  return minMs + Math.random() * (maxMs - minMs);
}

function migrateStateV2(data: AppStateV2): AppState {
  const now = Date.now();
  const backlogItems = data.ideas.filter((idea) => idea.status === "backlog");
  const box: BoxItem[] = backlogItems.map((idea) => {
    const proofLine = idea.proofDefinition.trim()
      ? `\nSuccess: ${idea.proofDefinition.trim()}`
      : "";

    return {
      id: uid(),
      content: `${idea.title.trim()}${proofLine}`,
      domain: "random",
      createdAt: idea.createdAt,
      nextRevealAt: idea.createdAt + randomDelayMs(6, 72),
      returnCount: 0,
      origin: "captured",
    };
  });

  const ideas = data.ideas.filter((idea) => idea.status !== "backlog");

  return {
    version: 3,
    ideas,
    box,
    spark: {
      usedToday: 0,
      dayKey: dayKeyLocal(),
      recentPromptIds: [],
    },
    settings: { activeLimit: data.settings?.activeLimit ?? 5 },
    domainWindows: defaultDomainWindows(now),
    lastBoxOpenAt: undefined,
  };
}

function loadState(): AppState {
  if (typeof globalThis === "undefined") {
    return defaultState();
  }

  try {
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AppState;
      if (
        parsed &&
        parsed.version === 3 &&
        Array.isArray(parsed.ideas) &&
        Array.isArray(parsed.box)
      ) {
        const baseSpark = normalizeSpark(parsed.spark);
        return {
          version: 3,
          ideas: parsed.ideas,
          box: parsed.box,
          spark: resetSparkIfNewDay(baseSpark),
          settings: parsed.settings ?? { activeLimit: 5 },
          domainWindows: parsed.domainWindows ?? defaultDomainWindows(Date.now()),
          lastBoxOpenAt: parsed.lastBoxOpenAt,
        };
      }
    }

    const legacyRaw = globalThis.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacyRaw) {
      const legacyParsed = JSON.parse(legacyRaw) as AppStateV2;
      if (legacyParsed && legacyParsed.version === 2 && Array.isArray(legacyParsed.ideas)) {
        return migrateStateV2(legacyParsed);
      }
    }

    const legacyRawV1 = globalThis.localStorage.getItem(LEGACY_STORAGE_KEY_V1);
    if (legacyRawV1) {
      const legacyParsed = JSON.parse(legacyRawV1) as AppStateV1;
      if (legacyParsed && legacyParsed.version === 1 && Array.isArray(legacyParsed.ideas)) {
        return migrateStateV2(migrateStateV1(legacyParsed));
      }
    }

    return defaultState();
  } catch {
    return defaultState();
  }
}

function saveState(state: AppState) {
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

// ---------------------------
// Helpers
// ---------------------------
function dayKeyLocal(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeSpark(spark?: Partial<AppState["spark"]>): AppState["spark"] {
  return {
    usedToday: spark?.usedToday ?? 0,
    dayKey: spark?.dayKey ?? dayKeyLocal(),
    lastSpark: spark?.lastSpark,
    recentPromptIds: Array.isArray(spark?.recentPromptIds) ? spark?.recentPromptIds ?? [] : [],
  };
}

function resetSparkIfNewDay(spark: AppState["spark"]) {
  const today = dayKeyLocal();
  const safeSpark = normalizeSpark(spark);
  if (safeSpark.dayKey === today) return safeSpark;
  return {
    usedToday: 0,
    dayKey: today,
    lastSpark: safeSpark.lastSpark,
    recentPromptIds: safeSpark.recentPromptIds,
  };
}

function consumeSpark(
  spark: AppState["spark"],
  lastSpark: { prompt: string; domain: Domain; createdAt: number },
  promptId: string
) {
  const nextRecent = [...spark.recentPromptIds, promptId].slice(-25);
  return {
    usedToday: spark.usedToday + 1,
    dayKey: spark.dayKey,
    lastSpark,
    recentPromptIds: nextRecent,
  };
}

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

function fmtDurationShort(ms: number) {
  const { days, hours, minutes } = msToParts(ms);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function pickRandom<T>(items: T[]) {
  return items[Math.floor(Math.random() * items.length)];
}

function hasTimeOrLimit(text: string) {
  const timePattern =
    /\b(\d+\s?(min|mins|minute|minutes|hour|hours|hr|hrs|day|days|week|weeks)|minutes?|hours?|days?|weeks?|today|tonight|tomorrow|before|deadline|timer|limit|noon|midnight)\b/i;
  const byPattern = /\bby (end|eod|today|tonight|tomorrow)\b/i;
  return timePattern.test(text) || byPattern.test(text);
}

function maybeAddConstraint(text: string) {
  if (hasTimeOrLimit(text)) return text;
  if (Math.random() < 0.35) {
    return `${text} — ${pickRandom(sparkConstraints)}`;
  }
  return text;
}

function generateSparkCurated(
  domainChoice: Domain | "surprise",
  recentIds: string[],
  lastPromptText?: string
): { domain: Domain; prompt: string; promptId: string } {
  const domain = domainChoice === "surprise" ? pickRandom(domains) : domainChoice;
  const library = sparkLibrary[domain] ?? [];
  const fallback = {
    id: `${domain}-fallback`,
    domain,
    text: "Write down one clear next step you can take.",
  };
  const available = library.length ? library : [fallback];
  const recentSet = new Set(recentIds);
  const filtered = available.filter((prompt) => !recentSet.has(prompt.id));
  const pool = filtered.length ? filtered : available;
  const noRepeatPool = lastPromptText ? pool.filter((prompt) => prompt.text !== lastPromptText) : pool;
  const selectionPool = noRepeatPool.length ? noRepeatPool : pool;

  let chosen = pickRandom(selectionPool);
  let prompt = maybeAddConstraint(chosen.text);

  for (let i = 0; i < 4; i += 1) {
    if (!lastPromptText || prompt !== lastPromptText) {
      return { domain, prompt, promptId: chosen.id };
    }
    chosen = pickRandom(selectionPool);
    prompt = maybeAddConstraint(chosen.text);
  }

  if (prompt === lastPromptText && selectionPool.length > 1) {
    const alternate = selectionPool.find((item) => item.text !== chosen.text);
    if (alternate) {
      const alternatePrompt = maybeAddConstraint(alternate.text);
      return { domain, prompt: alternatePrompt, promptId: alternate.id };
    }
  }

  return { domain, prompt, promptId: chosen.id };
}

function pickDomainForExpired(title: string): Domain {
  const lowered = title.toLowerCase();
  const keywords = ["mvp", "ship", "launch", "release", "deploy", "scale", "growth"];
  const isBusiness = keywords.some((keyword) => lowered.includes(keyword));
  return isBusiness ? "business" : "career";
}

const killReasonLabels: Record<KillReasonCode, string> = {
  TIME_EXPIRED: "Time expired",
  NO_LONGER_RELEVANT: "No longer relevant",
  TOO_BIG: "Too big",
  NO_CLEAR_USER_PROBLEM: "No clear user problem",
  LOST_INTEREST: "Lost interest",
  BLOCKED: "Blocked",
  OTHER: "Other",
};


// ---------------------------
// Page
// ---------------------------
export default function Page() {
  const [state, setState] = useState<AppState>(() => defaultState());

  const [hydrated, setHydrated] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());
  const decisionRef = React.useRef<HTMLElement | null>(null);
  const [decisionFlash, setDecisionFlash] = useState(false);
  const [notifyPrefs, setNotifyPrefs] = useState<NotificationPrefs>(() =>
    defaultNotificationPrefs()
  );
  const [notifyReady, setNotifyReady] = useState(false);
  const [notifyPermission, setNotifyPermission] = useState<
    NotificationPermission | "unsupported"
  >("default");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [digestOpen, setDigestOpen] = useState(false);
  const [notifyPromptOpen, setNotifyPromptOpen] = useState(false);

  // Edit panel state
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDays, setEditDays] = useState<number>(14);
  const [editProofType, setEditProofType] = useState<ProofType>("link");
  const [editProblemStatement, setEditProblemStatement] = useState("");
  const [editAudience, setEditAudience] = useState("");
  const [editProofDefinition, setEditProofDefinition] = useState("");
  const [editKillTrigger, setEditKillTrigger] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editBetCommitted, setEditBetCommitted] = useState(false);

  // Box intake state
  const [boxContent, setBoxContent] = useState("");
  const [boxDomain, setBoxDomain] = useState<Domain>("random");
  const [sparkToast, setSparkToast] = useState("");

  // Spark modal state
  const [sparkOpen, setSparkOpen] = useState(false);
  const [sparkStep, setSparkStep] = useState<"pickDomain" | "showSpark" | "actNow">("pickDomain");
  const [sparkDomainChoice, setSparkDomainChoice] = useState<Domain | "surprise" | null>(null);
  const [sparkPrompt, setSparkPrompt] = useState("");
  const [sparkDomain, setSparkDomain] = useState<Domain>("random");
  const [sparkProofDefinition, setSparkProofDefinition] = useState("");
  const [sparkBetCommitted, setSparkBetCommitted] = useState(false);
  const [sparkDismissReason, setSparkDismissReason] = useState("");
  const [sparkActError, setSparkActError] = useState("");
  const [sparkExhausted, setSparkExhausted] = useState(false);

  // Box animation + open state
  const [boxOpen, setBoxOpen] = useState(false);
  const [boxDrop, setBoxDrop] = useState(false);
  const [openChooser, setOpenChooser] = useState(false);
  const [boxCinematic, setBoxCinematic] = useState(false);
  const [boxStage, setBoxStage] = useState<"idle" | "centering" | "shaking" | "lidOff">("idle");

  // Box reveal + decision state
  const [revealedItemId, setRevealedItemId] = useState<string | null>(null);
  const [revealedDomain, setRevealedDomain] = useState<Domain | null>(null);
  const [promoteTitle, setPromoteTitle] = useState("");
  const [promoteProofDefinition, setPromoteProofDefinition] = useState("");
  const [promoteBetCommitted, setPromoteBetCommitted] = useState(false);
  const [promoteDays, setPromoteDays] = useState<number>(14);
  const [promoteError, setPromoteError] = useState("");
  const [returnReason, setReturnReason] = useState("");
  const [returnError, setReturnError] = useState("");
  const [boxKillReason, setBoxKillReason] = useState<KillReasonCode | "">("");
  const [boxKillDetail, setBoxKillDetail] = useState("");

  // Early unlock
  const [earlyUnlockDomain, setEarlyUnlockDomain] = useState<Domain | null>(null);
  const [earlyUnlockReason, setEarlyUnlockReason] = useState("");

  // Accountability modal
  const [accountabilityItemId, setAccountabilityItemId] = useState<string | null>(null);
  const [accountabilityMode, setAccountabilityMode] = useState<"idle" | "respond" | "return" | "kill">(
    "idle"
  );
  const [accountabilityReturnReason, setAccountabilityReturnReason] = useState("");
  const [accountabilityKillReason, setAccountabilityKillReason] = useState<KillReasonCode | "">("");
  const [accountabilityKillDetail, setAccountabilityKillDetail] = useState("");

  // Selection panel
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdea = useMemo(
    () => state.ideas.find((i) => i.id === selectedId) ?? null,
    [selectedId, state.ideas]
  );
  const isSelectedResolved =
    selectedIdea?.status === "shipped" || selectedIdea?.status === "killed";

  const revealedItem = useMemo(
    () => state.box.find((item) => item.id === revealedItemId) ?? null,
    [revealedItemId, state.box]
  );

  // Auto-scroll + subtle flash on selection
  useEffect(() => {
    if (!selectedIdea) return;

    decisionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });

    setDecisionFlash(true);
    const t = setTimeout(() => setDecisionFlash(false), 900);
    return () => clearTimeout(t);
  }, [selectedIdea?.id]);

  // Load on mount
  useEffect(() => {
    const loaded = loadState();
    setState(loaded);
    setHydrated(true);
  }, []);

  useEffect(() => {
    const prefs = loadNotificationPrefs();
    setNotifyPrefs(prefs);
    setNotifyPermission(getNotificationPermission());
    setNotifyReady(true);
  }, []);

  // Persist after hydration
  useEffect(() => {
    if (!hydrated) return;
    saveState(state);
  }, [state, hydrated]);

  useEffect(() => {
    if (!notifyReady) return;
    saveNotificationPrefs(notifyPrefs);
  }, [notifyPrefs, notifyReady]);

  // Tick for countdowns
  useEffect(() => {
    const t = globalThis.setInterval(() => setNow(Date.now()), 1000);
    return () => globalThis.clearInterval(t);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    setState((prev) => {
      const nextSpark = resetSparkIfNewDay(prev.spark);
      if (nextSpark === prev.spark) return prev;
      return { ...prev, spark: nextSpark };
    });
  }, [hydrated, now]);

  useEffect(() => {
    if (!hydrated || !notifyReady) return;
    if (!notifyPrefs.digestEnabled) return;
    const todayKey = dayKeyLocal();
    if (notifyPrefs.lastDigestDate === todayKey) return;
    setDigestOpen(true);
    setNotifyPrefs((prev) => ({ ...prev, lastDigestDate: todayKey }));
  }, [hydrated, notifyPrefs.digestEnabled, notifyPrefs.lastDigestDate, notifyReady]);

  // Expiry flow: move expired actives back into the box
  useEffect(() => {
    if (!hydrated) return;
    const expired = state.ideas.filter((idea) => idea.status === "active" && now >= idea.deadlineAt);
    if (expired.length === 0) return;

    expired.forEach((idea) => {
      sendNotification(
        `idea-${idea.id}-expired-${idea.deadlineAt}`,
        "⚠️ Idea expired",
        `${idea.title} has expired.`,
        now
      );
    });

    setState((prev) => {
      const expiredIdeas = prev.ideas.filter(
        (idea) => idea.status === "active" && now >= idea.deadlineAt
      );
      if (expiredIdeas.length === 0) return prev;

      const nextBoxItems: BoxItem[] = expiredIdeas.map((idea) => {
        const proofLine = idea.proofDefinition.trim()
          ? `\nSuccess: ${idea.proofDefinition.trim()}`
          : "";
        return {
          id: uid(),
          content: `EXPIRED: ${idea.title.trim()}${proofLine}`,
          domain: pickDomainForExpired(idea.title),
          createdAt: now,
          nextRevealAt: now,
          returnCount: 0,
          origin: "expired_active" as const,
          linkedIdeaId: idea.id,
        };
      });

      return {
        ...prev,
        ideas: prev.ideas.filter(
          (idea) => !(idea.status === "active" && now >= idea.deadlineAt)
        ),
        box: [...nextBoxItems, ...prev.box],
      };
    });
  }, [hydrated, now, state.ideas]);

  // Accountability modal trigger
  useEffect(() => {
    if (!hydrated) return;
    if (accountabilityItemId) return;
    const unresolved = state.box.find(
      (item) => item.earlyUnlockDebt && !item.earlyUnlockDebt.resolved
    );
    if (unresolved) {
      setAccountabilityItemId(unresolved.id);
      setAccountabilityMode("respond");
    }
  }, [accountabilityItemId, hydrated, state.box]);

  const activeIdeas = useMemo(
    () =>
      state.ideas
        .filter((i) => i.status === "active")
        .sort((a, b) => a.deadlineAt - b.deadlineAt),
    [state.ideas]
  );

  const expiringSoon6h = useMemo(
    () =>
      activeIdeas.filter((idea) => {
        const remaining = idea.deadlineAt - now;
        return remaining > 0 && remaining <= 6 * 60 * 60 * 1000;
      }),
    [activeIdeas, now]
  );

  const expiringSoon1h = useMemo(
    () =>
      activeIdeas.filter((idea) => {
        const remaining = idea.deadlineAt - now;
        return remaining > 0 && remaining <= 60 * 60 * 1000;
      }),
    [activeIdeas, now]
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
    () => activeIdeas.filter((i) => now >= i.deadlineAt).length,
    [activeIdeas, now]
  );

  const shippedThisMonth = useMemo(() => {
    const start = new Date(now);
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setMonth(end.getMonth() + 1);
    return shippedIdeas.filter(
      (idea) => idea.resolvedAt && idea.resolvedAt >= start.getTime() && idea.resolvedAt < end.getTime()
    ).length;
  }, [now, shippedIdeas]);

  const killedThisMonth = useMemo(() => {
    const start = new Date(now);
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setMonth(end.getMonth() + 1);
    return killedIdeas.filter(
      (idea) => idea.resolvedAt && idea.resolvedAt >= start.getTime() && idea.resolvedAt < end.getTime()
    ).length;
  }, [now, killedIdeas]);

  const stats = useMemo(
    () => ({
      box: state.box.length,
      active: `${activeIdeas.length}/${state.settings.activeLimit}`,
      shipped: shippedIdeas.length,
      killed: killedIdeas.length,
      expired: expiredCount,
      shippedThisMonth,
      killedThisMonth,
    }),
    [
      activeIdeas.length,
      expiredCount,
      killedIdeas.length,
      killedThisMonth,
      shippedIdeas.length,
      shippedThisMonth,
      state.box.length,
      state.settings.activeLimit,
    ]
  );

  const eligibleByDomain = useMemo(() => {
    const map: Record<Domain, BoxItem[]> = {
      business: [],
      career: [],
      relationships: [],
      dating: [],
      lifestyle: [],
      random: [],
    };
    state.box.forEach((item) => {
      if (item.nextRevealAt <= now) {
        map[item.domain].push(item);
      }
    });
    return map;
  }, [state.box, now]);

  const domainStatus = useMemo(() => {
    return domains.reduce((acc, domain) => {
      const nextOpenAt = state.domainWindows[domain]?.nextOpenAt ?? now;
      const isOpenWindow = now >= nextOpenAt;
      const hasEarlyUnlockDebt = eligibleByDomain[domain].some(
        (item) => item.earlyUnlockDebt && !item.earlyUnlockDebt.resolved
      );
      acc[domain] = {
        nextOpenAt,
        isOpenWindow,
        hasEligible: eligibleByDomain[domain].length > 0,
        hasEarlyUnlockDebt,
      };
      return acc;
    }, {} as Record<Domain, { nextOpenAt: number; isOpenWindow: boolean; hasEligible: boolean; hasEarlyUnlockDebt: boolean }>);
  }, [eligibleByDomain, now, state.domainWindows]);

  const openableDomains = useMemo(
    () =>
      domains.filter((domain) => {
        const status = domainStatus[domain];
        const isOpen = status.isOpenWindow || status.hasEarlyUnlockDebt;
        return isOpen && status.hasEligible;
      }),
    [domainStatus]
  );

  const expiredToday = useMemo(() => {
    const todayKey = dayKeyLocal();
    return state.box.filter(
      (item) => item.origin === "expired_active" && dayKeyLocal(new Date(item.createdAt)) === todayKey
    );
  }, [state.box]);

  const activeIdeasRef = React.useRef(activeIdeas);
  const openableDomainsRef = React.useRef(openableDomains);

  useEffect(() => {
    activeIdeasRef.current = activeIdeas;
  }, [activeIdeas]);

  useEffect(() => {
    openableDomainsRef.current = openableDomains;
  }, [openableDomains]);

  const notificationsSupported = useMemo(() => isNotificationSupported(), []);
  const inQuietHours = useMemo(
    () => isQuietHours(new Date(now), notifyPrefs.quietStart, notifyPrefs.quietEnd),
    [now, notifyPrefs.quietEnd, notifyPrefs.quietStart]
  );

  const sendNotification = React.useCallback(
    (key: string, title: string, body: string, eventTime?: number) => {
      setNotifyPrefs((prev) => {
        const timestamp = eventTime ?? Date.now();
        if (!prev.enabled) return prev;
        if (notifyPermission !== "granted") return prev;
        if (isQuietHours(new Date(timestamp), prev.quietStart, prev.quietEnd)) return prev;
        if (prev.firedEvents[key]) return prev;

        const prunedLog = pruneNotifyLog(prev.notifyLog, timestamp);
        if (!canSendMoreNotifications(prunedLog, timestamp)) {
          return { ...prev, notifyLog: prunedLog };
        }

        const didFire = fireNotification(title, { body, tag: key });
        if (!didFire) return { ...prev, notifyLog: prunedLog };

        return {
          ...prev,
          firedEvents: { ...prev.firedEvents, [key]: dayKeyLocal(new Date(timestamp)) },
          notifyLog: [...prunedLog, timestamp],
        };
      });
    },
    [notifyPermission]
  );

  useEffect(() => {
    if (!hydrated || !notifyReady) return;

    const evaluateNotifications = () => {
      const timestamp = Date.now();
      const ideas = activeIdeasRef.current;
      ideas.forEach((idea) => {
        const remaining = idea.deadlineAt - timestamp;
        const sixHours = 6 * 60 * 60 * 1000;
        const oneHour = 60 * 60 * 1000;

        if (remaining > oneHour && remaining <= sixHours) {
          sendNotification(
            `idea-${idea.id}-warn6h-${idea.deadlineAt}`,
            "⏳ Idea nearing deadline",
            `${idea.title} has about ${fmtDurationShort(remaining)} left.`,
            timestamp
          );
        }

        if (remaining > 0 && remaining <= oneHour) {
          sendNotification(
            `idea-${idea.id}-warn1h-${idea.deadlineAt}`,
            "⏰ Almost out of time",
            `${idea.title} has about ${fmtDurationShort(remaining)} left.`,
            timestamp
          );
        }

        if (remaining <= 0) {
          sendNotification(
            `idea-${idea.id}-expired-${idea.deadlineAt}`,
            "⚠️ Idea expired",
            `${idea.title} has expired.`,
            timestamp
          );
        }
      });

      const openable = openableDomainsRef.current;
      if (openable.length > 0) {
        sendNotification(
          `box-ready-${dayKeyLocal(new Date(timestamp))}`,
          "📦 Box ready to open",
          `Openable: ${openable.map((domain) => domainLabels[domain]).join(", ")}.`,
          timestamp
        );
      }
    };

    evaluateNotifications();
    const interval = globalThis.setInterval(evaluateNotifications, 60 * 1000);
    return () => globalThis.clearInterval(interval);
  }, [hydrated, notifyReady, sendNotification]);

  // Preload edit fields when selection changes
  useEffect(() => {
    if (!selectedIdea) return;
    setEditing(false);
    setEditTitle(selectedIdea.title);
    setEditProofType(selectedIdea.proofType);
    setEditProblemStatement(selectedIdea.problemStatement);
    setEditAudience(selectedIdea.audience);
    setEditProofDefinition(selectedIdea.proofDefinition);
    setEditKillTrigger(selectedIdea.killTrigger);
    setEditNotes(selectedIdea.notes);
    setEditBetCommitted(selectedIdea.betCommitted);

    const remainingDays = Math.ceil(
      (selectedIdea.deadlineAt - Date.now()) / (24 * 60 * 60 * 1000)
    );
    setEditDays(clamp(isFinite(remainingDays) ? remainingDays : 14, 1, 90));
  }, [selectedIdea?.id]);

  useEffect(() => {
    if (!revealedItem || !revealedDomain) return;
    setPromoteTitle(revealedItem.content.split("\n")[0]?.slice(0, 120) ?? "");
    setPromoteProofDefinition("");
    setPromoteBetCommitted(false);
    setPromoteDays(defaultDaysByDomain[revealedDomain]);
    setPromoteError("");
    setReturnReason("");
    setReturnError("");
    setBoxKillReason("");
    setBoxKillDetail("");
  }, [revealedItemId, revealedDomain, revealedItem]);

  function animateBoxOpen() {
    setBoxOpen(true);
    globalThis.setTimeout(() => setBoxOpen(false), 800);
  }

  function openDigestNow() {
    setDigestOpen(true);
    setNotifyPrefs((prev) => ({ ...prev, lastDigestDate: dayKeyLocal() }));
  }

  async function handleNotificationsToggle(nextEnabled: boolean) {
    if (!notificationsSupported) return;
    if (!nextEnabled) {
      setNotifyPrefs((prev) => ({ ...prev, enabled: false }));
      return;
    }

    const permission = await requestNotificationPermission();
    setNotifyPermission(permission);

    if (permission === "granted") {
      setNotifyPrefs((prev) => ({ ...prev, enabled: true }));
      return;
    }

    setNotifyPrefs((prev) => ({ ...prev, enabled: false }));
  }

  function animateBoxDrop() {
    setBoxDrop(true);
    globalThis.setTimeout(() => setBoxDrop(false), 700);
  }

  function animateBoxOpenCinematic() {
    setBoxCinematic(true);
    setBoxStage("centering");
    globalThis.setTimeout(() => setBoxStage("shaking"), 450);
    globalThis.setTimeout(() => setBoxStage("lidOff"), 900);
  }

  function captureToBox() {
    const content = boxContent.trim();
    if (!content) return;

    const createdAt = Date.now();
    const nextRevealAt = createdAt + randomDelayMs(6, 72);

    const newItem: BoxItem = {
      id: uid(),
      content,
      domain: boxDomain,
      createdAt,
      nextRevealAt,
      returnCount: 0,
      origin: "captured",
    };

    setState((prev) => ({
      ...prev,
      box: [newItem, ...prev.box],
    }));

    animateBoxOpen();
    animateBoxDrop();

    setBoxContent("");
    setBoxDomain("random");
  }

  function resetSparkUi() {
    setSparkOpen(false);
    setSparkStep("pickDomain");
    setSparkDomainChoice(null);
    setSparkPrompt("");
    setSparkDomain("random");
    setSparkProofDefinition("");
    setSparkBetCommitted(false);
    setSparkDismissReason("");
    setSparkActError("");
    setSparkExhausted(false);
  }

  function showSparkToast(message: string) {
    setSparkToast(message);
    globalThis.setTimeout(() => setSparkToast(""), 1800);
  }

  function openSparkModal() {
    const normalizedSpark = resetSparkIfNewDay(state.spark);
    if (normalizedSpark !== state.spark) {
      setState((prev) => ({ ...prev, spark: normalizedSpark }));
    }

    setSparkPrompt("");
    setSparkDomain("random");
    setSparkProofDefinition("");
    setSparkBetCommitted(false);
    setSparkDismissReason("");
    setSparkActError("");
    setSparkDomainChoice(null);
    setSparkOpen(true);

    if (normalizedSpark.usedToday >= 3) {
      setSparkExhausted(true);
      setSparkStep("showSpark");
      return;
    }

    setSparkExhausted(false);
    setSparkStep("pickDomain");
  }

  function generateNewSpark(choice: Domain | "surprise") {
    const normalizedSpark = resetSparkIfNewDay(state.spark);
    if (normalizedSpark.usedToday >= 3) {
      setSparkExhausted(true);
      setSparkStep("showSpark");
      return;
    }

    const { domain, prompt, promptId } = generateSparkCurated(
      choice,
      normalizedSpark.recentPromptIds,
      normalizedSpark.lastSpark?.prompt
    );

    setSparkDomainChoice(choice);
    setSparkDomain(domain);
    setSparkPrompt(prompt);
    setSparkStep("showSpark");
    setSparkExhausted(false);
    setSparkProofDefinition("");
    setSparkBetCommitted(false);
    setSparkDismissReason("");
    setSparkActError("");

    setState((prev) => ({
      ...prev,
      spark: consumeSpark(normalizedSpark, { prompt, domain, createdAt: Date.now() }, promptId),
    }));
  }

  function handleSparkThrow() {
    const content = sparkPrompt.trim();
    if (!content) return;
    setBoxContent(content.slice(0, 240));
    setBoxDomain(sparkDomain);
    showSparkToast("Ready to throw into the box");
    resetSparkUi();
  }

  function handleSparkActNow() {
    const proofDefinition = sparkProofDefinition.trim();
    if (!proofDefinition || !sparkBetCommitted) {
      setSparkActError("Add a proof definition and confirm the bet to act now.");
      return;
    }
    if (!canAddToActive) {
      setSparkActError("Active list is full. Ship or kill something to free a slot.");
      return;
    }

    const createdAt = Date.now();
    const deadlineAt = createdAt + 24 * 60 * 60 * 1000;
    const title =
      sparkPrompt.split("\n")[0]?.trim().slice(0, 120) || "Random Spark";

    const newIdea: Idea = {
      id: uid(),
      title,
      createdAt,
      deadlineAt,
      proofType: "link",
      status: "active",
      problemStatement: "",
      audience: "",
      proofDefinition,
      killTrigger: "",
      notes: "",
      betCommitted: sparkBetCommitted,
      proofs: [],
    };

    setState((prev) => ({
      ...prev,
      ideas: [newIdea, ...prev.ideas],
    }));

    setSelectedId(newIdea.id);
    resetSparkUi();
  }

  function handleSparkDismiss() {
    resetSparkUi();
  }

  function openBox(domain?: Domain) {
    const options = openableDomains;
    if (options.length === 0) return;
    if (!domain && options.length > 1) {
      setOpenChooser(true);
      return;
    }

    const targetDomain = domain ?? options[0];
    const eligible = eligibleByDomain[targetDomain]
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt);

    const item = eligible[0];
    if (!item) return;

    setRevealedItemId(item.id);
    setRevealedDomain(targetDomain);
    setOpenChooser(false);

    animateBoxOpenCinematic();
    animateBoxDrop();

    setState((prev) => ({
      ...prev,
      lastBoxOpenAt: now,
    }));
  }

  function resolveEarlyUnlock(itemId: string) {
    setState((prev) => ({
      ...prev,
      box: prev.box.map((item) =>
        item.id === itemId && item.earlyUnlockDebt
          ? {
              ...item,
              earlyUnlockDebt: {
                ...item.earlyUnlockDebt,
                resolved: true,
              },
            }
          : item
      ),
    }));
  }

  function returnToBox(itemId: string, reason: string, resolveDebt = false) {
    setState((prev) => ({
      ...prev,
      box: prev.box.map((item) => {
        if (item.id !== itemId) return item;
        const nextCount = item.returnCount + 1;
        const cooldown =
          24 * 60 * 60 * 1000 * (1 + nextCount) + Math.random() * 12 * 60 * 60 * 1000;
        return {
          ...item,
          returnCount: nextCount,
          lastReturnedReason: reason.trim().slice(0, 15),
          nextRevealAt: Date.now() + cooldown,
          earlyUnlockDebt: resolveDebt && item.earlyUnlockDebt
            ? { ...item.earlyUnlockDebt, resolved: true }
            : item.earlyUnlockDebt,
        };
      }),
    }));
  }

  function killBoxItem(itemId: string, resolveDebt = false) {
    if (resolveDebt) {
      resolveEarlyUnlock(itemId);
    }
    setState((prev) => ({
      ...prev,
      box: prev.box.filter((item) => item.id !== itemId),
    }));
  }

  function promoteBoxItem(item: BoxItem) {
    const title = promoteTitle.trim();
    const proofDefinition = promoteProofDefinition.trim();

    if (!title || !proofDefinition || !promoteBetCommitted) {
      setPromoteError("Set a title, proof definition, and confirm the bet to promote.");
      return;
    }
    if (!canAddToActive) {
      setPromoteError("Active list is full. Ship or kill something to free a slot.");
      return;
    }

    const createdAt = Date.now();
    const useDays = clamp(promoteDays || defaultDaysByDomain[item.domain], 1, 90);
    const deadlineAt = createdAt + useDays * 24 * 60 * 60 * 1000;

    const newIdea: Idea = {
      id: uid(),
      title,
      createdAt,
      deadlineAt,
      proofType: "link",
      status: "active",
      problemStatement: "",
      audience: "",
      proofDefinition,
      killTrigger: "",
      notes: "",
      betCommitted: promoteBetCommitted,
      proofs: [],
    };

    setState((prev) => ({
      ...prev,
      ideas: [newIdea, ...prev.ideas],
      box: prev.box.filter((boxItem) => boxItem.id !== item.id),
      domainWindows: {
        ...prev.domainWindows,
        [item.domain]: { nextOpenAt: Date.now() + 24 * 60 * 60 * 1000 },
      },
    }));

    setSelectedId(newIdea.id);
    setRevealedItemId(null);
    setRevealedDomain(null);
    setBoxCinematic(false);
    setBoxStage("idle");

    if (!notifyPrefs.enabled && !notifyPrefs.promptDismissed) {
      setNotifyPromptOpen(true);
      setNotifyPrefs((prev) => ({ ...prev, promptDismissed: true }));
    }
  }

  function updateIdea() {
    if (!selectedIdea) return;

    if (isSelectedResolved) {
      setState((prev) => ({
        ...prev,
        ideas: prev.ideas.map((i) => (i.id === selectedIdea.id ? { ...i, notes: editNotes } : i)),
      }));
      setEditing(false);
      return;
    }

    const t = editTitle.trim();
    if (!t) return;

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
              deadlineAt: newDeadlineAt,
              problemStatement: editProblemStatement,
              audience: editAudience,
              proofDefinition: editProofDefinition,
              killTrigger: editKillTrigger,
              notes: editNotes,
              betCommitted: editBetCommitted,
            }
          : i
      ),
    }));

    setEditing(false);
  }

  function shipIdea(id: string, proofs: Idea["proofs"]) {
    if (!proofs.length || proofs.some((proof) => !proof.value.trim())) return;
    const target = state.ideas.find((idea) => idea.id === id);
    if (!target || !target.proofDefinition.trim()) return;

    setState((prev) => ({
      ...prev,
      ideas: prev.ideas.map((i) =>
        i.id === id
          ? {
              ...i,
              status: "shipped",
              proofs,
              resolvedAt: Date.now(),
            }
          : i
      ),
    }));
    setSelectedId(null);
  }

  function killIdea(id: string, code: KillReasonCode, detail: string) {
    if (!code) return;

    setState((prev) => ({
      ...prev,
      ideas: prev.ideas.map((i) =>
        i.id === id
          ? {
              ...i,
              status: "killed",
              killReasonCode: code,
              killReasonDetail: detail.trim(),
              resolvedAt: Date.now(),
            }
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
    setState(defaultState());
    setSelectedId(null);
    setEditing(false);
    setRevealedItemId(null);
    setRevealedDomain(null);
    setBoxCinematic(false);
    setBoxStage("idle");
  }

  function handleReturn() {
    if (!revealedItem) return;
    const reason = returnReason.trim();
    if (!reason) {
      setReturnError("Add a short reason (max 15 chars).");
      return;
    }
    if (reason.length > 15) {
      setReturnError("Keep it ≤ 15 chars.");
      return;
    }

    returnToBox(revealedItem.id, reason);
    setState((prev) => ({
      ...prev,
      domainWindows: {
        ...prev.domainWindows,
        [revealedItem.domain]: { nextOpenAt: Date.now() + 24 * 60 * 60 * 1000 },
      },
    }));

    setRevealedItemId(null);
    setRevealedDomain(null);
    setReturnReason("");
    setReturnError("");
    setBoxCinematic(false);
    setBoxStage("idle");
  }

  function handleKill() {
    if (!revealedItem || !boxKillReason) return;

    killBoxItem(revealedItem.id);
    setState((prev) => ({
      ...prev,
      domainWindows: {
        ...prev.domainWindows,
        [revealedItem.domain]: { nextOpenAt: Date.now() + 24 * 60 * 60 * 1000 },
      },
    }));

    setRevealedItemId(null);
    setRevealedDomain(null);
    setBoxKillReason("");
    setBoxKillDetail("");
    setBoxCinematic(false);
    setBoxStage("idle");
  }

  function handleEarlyUnlock() {
    if (!earlyUnlockDomain) return;
    const reason = earlyUnlockReason.trim();
    if (!reason || reason.length > 30) return;

    const eligible = eligibleByDomain[earlyUnlockDomain]
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt);
    const target = eligible[0];
    if (!target) return;

    setState((prev) => ({
      ...prev,
      box: prev.box.map((item) =>
        item.id === target.id
          ? {
              ...item,
              earlyUnlockDebt: {
                reason,
                createdAt: Date.now(),
              },
            }
          : item
      ),
      domainWindows: {
        ...prev.domainWindows,
        [earlyUnlockDomain]: { nextOpenAt: Date.now() + 24 * 60 * 60 * 1000 },
      },
    }));

    setEarlyUnlockDomain(null);
    setEarlyUnlockReason("");
  }

  function handleAccountabilityYes() {
    if (!accountabilityItemId) return;
    resolveEarlyUnlock(accountabilityItemId);
    setAccountabilityItemId(null);
    setAccountabilityMode("idle");
    setAccountabilityReturnReason("");
    setAccountabilityKillReason("");
    setAccountabilityKillDetail("");
  }

  function handleAccountabilityReturn() {
    if (!accountabilityItemId) return;
    const reason = accountabilityReturnReason.trim();
    if (!reason || reason.length > 15) return;

    returnToBox(accountabilityItemId, reason, true);
    setAccountabilityItemId(null);
    setAccountabilityMode("idle");
    setAccountabilityReturnReason("");
  }

  function handleAccountabilityKill() {
    if (!accountabilityItemId || !accountabilityKillReason) return;
    killBoxItem(accountabilityItemId, true);
    setAccountabilityItemId(null);
    setAccountabilityMode("idle");
    setAccountabilityKillReason("");
    setAccountabilityKillDetail("");
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

  const notificationsBlocked = notifyPermission === "denied" || notifyPermission === "unsupported";
  const digestActiveList = activeIdeas.map((idea) => ({
    ...idea,
    remainingMs: idea.deadlineAt - now,
  }));

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
  <h1 className="text-2xl font-semibold tracking-tight">
    Kill Your Darlings
  </h1>
  <p className="mt-1 text-xs text-zinc-500">
    Five actives max. Ship or kill. Proof required.
  </p>
</div>

  {/* Top-right actions */}
  <div className="flex flex-wrap items-center gap-2">
    <button
      onClick={openDigestNow}
      className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-900/40"
      title="Daily digest"
    >
      View digest
    </button>

    <button
      onClick={() => setSettingsOpen(true)}
      className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-900/40"
      title="Notifications + digest settings"
    >
      Notifications
    </button>

    <button
  onClick={openSparkModal}
  className="
    relative
    rounded-2xl
    px-4 py-2
    text-xs font-semibold
    text-zinc-900
    bg-gradient-to-r from-fuchsia-300 to-cyan-300
    shadow-md shadow-fuchsia-500/20
    hover:shadow-lg hover:shadow-fuchsia-500/30
    transition-all
  "
>
  <span className="relative z-10">✨ Random Spark</span>

  {/* subtle glow */}
  <span
    className="
      absolute inset-0
      rounded-2xl
      bg-gradient-to-r from-fuchsia-400 to-cyan-400
      opacity-20 blur-md
    "
  />
</button>


    <button
      onClick={resetAll}
      className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-900/40"
      title="Wipes local data for this site on this browser"
    >
      Reset (local)
    </button>
  </div>
</div>


          <div className="grid grid-cols-2 gap-2 md:grid-cols-7">
            <StatChip label="Box" value={stats.box} tone="backlog" />
            <StatChip label="Active" value={stats.active} tone="active" />
            <StatChip label="Shipped" value={stats.shipped} tone="shipped" />
            <StatChip label="Shipped (mo)" value={stats.shippedThisMonth} tone="shipped" />
            <StatChip label="Killed" value={stats.killed} tone="killed" />
            <StatChip label="Killed (mo)" value={stats.killedThisMonth} tone="killed" />
            <StatChip
              label="Expired"
              value={stats.expired}
              tone={expiredCount > 0 ? "danger" : "neutral"}
            />
          </div>
        </header>

        {/* Box */}
        <section className="relative mt-8 rounded-2xl border border-zinc-800/70 bg-zinc-900/20 p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.04),0_0_40px_rgba(34,211,238,0.06)] backdrop-blur">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/40 to-transparent" />

          <div className="flex flex-col gap-6 md:flex-row">
            <div className="flex-1">
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="text-lg font-semibold">The Box</h2>
                  <p className="mt-1 text-xs text-zinc-500">
                    One intake. One reveal. Domains control when you can open.
                  </p>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
  <button
    onClick={() => openBox()}
    disabled={openableDomains.length === 0}
    className="rounded-xl bg-gradient-to-r from-cyan-300 to-fuchsia-300 px-4 py-2 text-xs font-semibold text-zinc-950 shadow-sm hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-40"
  >
    Open the Box
  </button>
</div>

              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {domains.map((domain) => {
                  const status = domainStatus[domain];
                  const isOpen = status.isOpenWindow;
                  const isEarly = !isOpen && status.hasEarlyUnlockDebt;
                  const chipTone = isOpen
                    ? "border-lime-300/30 bg-lime-200/10 text-lime-200"
                    : isEarly
                    ? "border-cyan-300/40 bg-cyan-200/10 text-cyan-200"
                    : "border-zinc-800 bg-zinc-950/40 text-zinc-400";

                  return (
                    <div
                      key={domain}
                      className={cx(
                        "flex items-center gap-2 rounded-full border px-3 py-1 text-[11px]",
                        chipTone
                      )}
                    >
                      <span>{domainLabels[domain]}</span>
                      {isOpen && <span className="text-[10px] uppercase">Open</span>}
                      {!isOpen && isEarly && <span className="text-[10px] uppercase">Early</span>}
                      {!isOpen && !isEarly && (
                        <span className="text-[10px] uppercase">
                          Locked
                        </span>
                      )}
                      {!isOpen && status.hasEligible && !isEarly && (
                        <button
                          onClick={() => setEarlyUnlockDomain(domain)}
                          className="rounded-full border border-cyan-400/30 px-2 py-0.5 text-[10px] text-cyan-200"
                        >
                          Early unlock
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              {openChooser && openableDomains.length > 1 && (
                <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-950/40 p-3">
                  <div className="text-xs text-zinc-400">Choose a domain to open</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {openableDomains.map((domain) => (
                      <button
                        key={domain}
                        onClick={() => openBox(domain)}
                        className="rounded-full border border-zinc-700 bg-zinc-900/40 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-900"
                      >
                        {domainLabels[domain]}
                      </button>
                    ))}
                    <button
                      onClick={() => setOpenChooser(false)}
                      className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-400"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {boxCinematic && (
                <div className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm">
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.08),transparent_55%)]" />
                </div>
              )}

              <div
                className={cx(
                  "relative mt-6 flex items-center justify-center transition-all duration-500",
                  boxCinematic && "fixed inset-0 z-50 mt-0"
                )}
              >
                <div
                  className={cx(
                    "relative h-52 w-56 transition-transform duration-500",
                    boxCinematic && "scale-110"
                  )}
                >
                  <div
                    className={cx(
                      "relative h-full w-full",
                      boxStage === "shaking" && "animate-kyd-shake"
                    )}
                  >
                    {/* soft floor shadow */}
                    <div className="absolute inset-x-10 bottom-6 h-8 rounded-full bg-black/40 blur-xl" />

                    {/* gift base */}
                    <div
                      className={cx(
                        "absolute left-1/2 top-16 h-28 w-48 -translate-x-1/2 rounded-3xl",
                        "border border-zinc-700/60 bg-zinc-950/60 backdrop-blur",
                        "shadow-[0_0_0_1px_rgba(255,255,255,0.05),0_18px_60px_rgba(34,211,238,0.08)]",
                        "transition-transform duration-500",
                        boxCinematic
                          ? "translate-y-0"
                          : boxOpen
                          ? "translate-y-2"
                          : "translate-y-0"
                      )}
                    >
                      {/* base sheen */}
                      <div className="absolute inset-0 rounded-3xl bg-[radial-gradient(circle_at_25%_25%,rgba(34,211,238,0.18),transparent_55%),radial-gradient(circle_at_80%_30%,rgba(232,121,249,0.18),transparent_60%),linear-gradient(to_bottom,rgba(255,255,255,0.06),transparent_35%)]" />

                      {/* ribbon vertical */}
                      <div className="absolute left-1/2 top-0 h-full w-10 -translate-x-1/2 rounded-2xl bg-gradient-to-b from-fuchsia-200/55 via-cyan-200/55 to-fuchsia-200/45 opacity-80" />
                      <div className="absolute left-1/2 top-0 h-full w-10 -translate-x-1/2 rounded-2xl shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)]" />

                      {/* ribbon horizontal */}
                      <div className="absolute left-0 top-1/2 h-10 w-full -translate-y-1/2 rounded-2xl bg-gradient-to-r from-fuchsia-200/45 via-cyan-200/55 to-fuchsia-200/45 opacity-80" />
                      <div className="absolute left-0 top-1/2 h-10 w-full -translate-y-1/2 rounded-2xl shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)]" />

                      {/* little highlight edge */}
                      <div className="pointer-events-none absolute inset-x-6 top-2 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent" />
                    </div>

                    {/* lid */}
                    <div
                      className={cx(
                        "absolute left-1/2 top-10 h-14 w-52 -translate-x-1/2 rounded-3xl",
                        "border border-zinc-700/70 bg-zinc-900/70 backdrop-blur",
                        "shadow-[0_0_0_1px_rgba(255,255,255,0.05),0_12px_40px_rgba(232,121,249,0.08)]",
                        "transition-transform origin-bottom",
                        boxStage === "lidOff" ? "duration-700" : "duration-500",
                        boxCinematic
                          ? boxStage === "centering"
                            ? "-translate-y-3 rotate-[-6deg]"
                            : boxStage === "shaking"
                            ? "-translate-y-5 rotate-[-10deg]"
                            : boxStage === "lidOff"
                            ? "translate-x-16 -translate-y-16 rotate-[18deg]"
                            : "translate-y-0 rotate-0"
                          : boxOpen
                          ? "-translate-y-6 rotate-[-14deg]"
                          : "translate-y-0 rotate-0"
                      )}
                    >
                      {/* lid sheen */}
                      <div className="absolute inset-0 rounded-3xl bg-[radial-gradient(circle_at_25%_30%,rgba(34,211,238,0.14),transparent_60%),radial-gradient(circle_at_80%_35%,rgba(232,121,249,0.14),transparent_65%),linear-gradient(to_bottom,rgba(255,255,255,0.07),transparent_40%)]" />

                      {/* ribbon on lid */}
                      <div className="absolute left-1/2 top-0 h-full w-10 -translate-x-1/2 rounded-2xl bg-gradient-to-b from-fuchsia-200/55 via-cyan-200/55 to-fuchsia-200/45 opacity-85" />
                      <div className="absolute left-1/2 top-0 h-full w-10 -translate-x-1/2 rounded-2xl shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)]" />
                    </div>

                    {/* bow */}
                    <div
                      className={cx(
                        "absolute left-1/2 top-7 -translate-x-1/2",
                        "transition-transform",
                        boxStage === "lidOff" ? "duration-700" : "duration-500",
                        boxCinematic
                          ? boxStage === "centering"
                            ? "-translate-y-4 rotate-[-4deg]"
                            : boxStage === "shaking"
                            ? "-translate-y-6 rotate-[-8deg]"
                            : boxStage === "lidOff"
                            ? "translate-x-14 -translate-y-16 rotate-[16deg]"
                            : "translate-y-0 rotate-0"
                          : boxOpen
                          ? "-translate-y-7 rotate-[-8deg]"
                          : "translate-y-0 rotate-0"
                      )}
                    >
                      <div className="relative h-12 w-28">
                        {/* knot */}
                        <div className="absolute left-1/2 top-5 h-4 w-4 -translate-x-1/2 rounded-full bg-gradient-to-br from-fuchsia-200/70 to-cyan-200/70 shadow-[0_0_0_1px_rgba(255,255,255,0.18)]" />

                        {/* left loop */}
                        <div
                          className={cx(
                            "absolute left-2 top-4 h-7 w-12 rounded-full",
                            "bg-gradient-to-br from-fuchsia-200/55 to-cyan-200/55",
                            "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)]",
                            boxDrop ? "animate-bounce" : ""
                          )}
                          style={{ transform: "rotate(-18deg)" }}
                        />
                        {/* right loop */}
                        <div
                          className={cx(
                            "absolute right-2 top-4 h-7 w-12 rounded-full",
                            "bg-gradient-to-br from-cyan-200/55 to-fuchsia-200/55",
                            "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)]",
                            boxDrop ? "animate-bounce" : ""
                          )}
                          style={{ transform: "rotate(18deg)" }}
                        />

                        {/* tails */}
                        <div
                          className="absolute left-10 top-9 h-8 w-3 rounded-full bg-gradient-to-b from-fuchsia-200/55 to-cyan-200/35"
                          style={{ transform: "rotate(18deg)" }}
                        />
                        <div
                          className="absolute right-10 top-9 h-8 w-3 rounded-full bg-gradient-to-b from-cyan-200/55 to-fuchsia-200/35"
                          style={{ transform: "rotate(-18deg)" }}
                        />
                      </div>
                    </div>

                    {/* sparkle drop when capturing/opening */}
                    {boxDrop && (
                      <>
                        <div className="absolute left-1/2 top-2 h-2 w-2 -translate-x-1/2 rounded-full bg-cyan-200/80 blur-[0.5px] animate-bounce" />
                        <div className="absolute left-[46%] top-6 h-1.5 w-1.5 rounded-full bg-fuchsia-200/70 blur-[0.5px] animate-bounce" />
                        <div className="absolute left-[54%] top-7 h-1.5 w-1.5 rounded-full bg-lime-200/60 blur-[0.5px] animate-bounce" />
                      </>
                    )}

                    {/* outer glow */}
                    <div className="pointer-events-none absolute inset-6 rounded-[32px] border border-cyan-300/10 opacity-70 blur-xl" />
                  </div>
                </div>
              </div>


              <div className="mt-3 text-center text-xs text-zinc-500">
                {openableDomains.length === 0
                  ? "No domains are open with eligible items yet."
                  : "Open when at least one domain is ready."}
              </div>
            </div>

            <div className="flex-1">
              <div className="rounded-2xl border border-zinc-800/70 bg-zinc-950/30 p-4">
                <div className="text-sm font-semibold">Capture into the box</div>
                <div className="mt-1 text-xs text-zinc-500">
                  Everything goes in. You can’t browse, only reveal when the box opens.
                </div>

                <div className="mt-4">
                  <label className="text-xs text-zinc-400">What are you throwing in?</label>
                  <textarea
                    value={boxContent}
                    onChange={(e) => setBoxContent(e.target.value)}
                    placeholder="Raw thought, idea, impulse..."
                    className="mt-1 h-24 w-full resize-none rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-3 text-sm outline-none placeholder:text-zinc-600 focus:border-zinc-600"
                    maxLength={240}
                  />
                  <div className="mt-1 text-[11px] text-zinc-500">{boxContent.length}/240</div>
                </div>

                <div className="mt-4">
                  <label className="text-xs text-zinc-400">Domain</label>
                  <select
                    value={boxDomain}
                    onChange={(e) => setBoxDomain(e.target.value as Domain)}
                    className="mt-1 h-11 w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 text-sm outline-none focus:border-zinc-600"
                  >
                    {domains.map((domain) => (
                      <option key={domain} value={domain}>
                        {domainLabels[domain]}
                      </option>
                    ))}
                  </select>
                </div>

                <button
                  onClick={captureToBox}
                  disabled={!boxContent.trim()}
                  className="mt-4 h-11 w-full rounded-xl bg-gradient-to-r from-cyan-300 to-fuchsia-300 text-sm font-semibold text-zinc-950 shadow-[0_10px_30px_rgba(34,211,238,0.10)] hover:opacity-95 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Throw into Box
                </button>
                {sparkToast && (
                  <div className="mt-2 rounded-xl border border-cyan-300/20 bg-cyan-200/10 px-3 py-2 text-xs text-cyan-100">
                    {sparkToast}
                  </div>
                )}
              </div>
            </div>
          </div>

        </section>

        {/* Active */}
        <section className="relative mt-8 rounded-2xl border border-zinc-800/70 bg-zinc-900/15 p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.04)] backdrop-blur">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/30 to-transparent" />

          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">Active</h2>
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              {expiringSoon6h.length > 0 && (
                <span className="rounded-full border border-rose-400/30 bg-rose-500/10 px-3 py-1 text-[11px] text-rose-200">
                  {expiringSoon6h.length} expiring soon
                </span>
              )}
              <span>Max {state.settings.activeLimit} at once. Pressure is the point.</span>
            </div>
          </div>

          {activeIdeas.length === 0 ? (
            <EmptyCard text="No active ideas. Promote something from the box." />
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
                      selectedId === idea.id && "border-cyan-400/40 bg-zinc-950/50",
                      expired
                        ? "border-rose-500/30 shadow-[0_0_40px_rgba(244,63,94,0.06)]"
                        : "border-zinc-800/70"
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

                      {idea.proofDefinition.trim() && (
                        <div className="text-xs text-zinc-500">
                          Success:{" "}
                          <span className="text-zinc-300 line-clamp-1">
                            {idea.proofDefinition}
                          </span>
                        </div>
                      )}

                      {expired && (
                        <div className="text-xs text-rose-200/80">
                          Time’s up. It will return to the box for a new decision.
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* Detail panel */}
        {selectedIdea && (
          <section
            ref={decisionRef}
            className={cx(
              "relative mt-8 rounded-2xl border border-zinc-800/70 bg-zinc-900/20 p-5 shadow-[0_0_0_1px_rgba(255,255,255,0.04)] backdrop-blur transition",
              decisionFlash && "ring-1 ring-cyan-400/40 shadow-[0_0_60px_rgba(34,211,238,0.08)]"
            )}
          >
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
                      disabled={isSelectedResolved}
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
                      disabled={isSelectedResolved}
                      className="mt-1 h-12 w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 text-sm outline-none focus:border-zinc-600"
                      placeholder="e.g. 14"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-zinc-400">Proof</label>
                    <select
                      value={editProofType}
                      onChange={(e) => setEditProofType(e.target.value as ProofType)}
                      disabled={isSelectedResolved}
                      className="mt-1 h-12 w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 text-sm outline-none focus:border-zinc-600"
                    >
                      <option value="link">Link</option>
                      <option value="text">Text</option>
                    </select>
                  </div>

                  <div className="md:col-span-2">
                    <label className="text-xs text-zinc-400">Problem statement</label>
                    <textarea
                      value={editProblemStatement}
                      onChange={(e) => setEditProblemStatement(e.target.value)}
                      disabled={isSelectedResolved}
                      maxLength={140}
                      className="mt-1 w-full resize-none rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-3 text-sm outline-none focus:border-zinc-600"
                      rows={2}
                    />
                    <div className="mt-1 text-[11px] text-zinc-500">
                      {editProblemStatement.length}/140 · What’s the core pain?
                    </div>
                  </div>

                  <div>
                    <label className="text-xs text-zinc-400">Audience</label>
                    <input
                      value={editAudience}
                      onChange={(e) => setEditAudience(e.target.value)}
                      disabled={isSelectedResolved}
                      className="mt-1 h-12 w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 text-sm outline-none focus:border-zinc-600"
                      placeholder="Who is this for?"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-zinc-400">Proof definition</label>
                    <input
                      value={editProofDefinition}
                      onChange={(e) => setEditProofDefinition(e.target.value)}
                      disabled={isSelectedResolved}
                      className="mt-1 h-12 w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 text-sm outline-none focus:border-zinc-600"
                      placeholder="What counts as success?"
                    />
                    <div className="mt-1 text-[11px] text-zinc-500">Required before activation.</div>
                  </div>

                  <div>
                    <label className="text-xs text-zinc-400">Kill trigger</label>
                    <input
                      value={editKillTrigger}
                      onChange={(e) => setEditKillTrigger(e.target.value)}
                      disabled={isSelectedResolved}
                      className="mt-1 h-12 w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 text-sm outline-none focus:border-zinc-600"
                      placeholder="When would you stop?"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-zinc-400">Bet commitment</label>
                    <label className="mt-1 flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950/30 px-3 py-3 text-xs text-zinc-300">
                      <input
                        type="checkbox"
                        checked={editBetCommitted}
                        onChange={(e) => setEditBetCommitted(e.target.checked)}
                        disabled={isSelectedResolved}
                        className="h-4 w-4 accent-zinc-100"
                      />
                      I’d bet $100 this ships on time
                    </label>
                  </div>

                  <div className="md:col-span-2">
                    <label className="text-xs text-zinc-400">Notes</label>
                    <textarea
                      value={editNotes}
                      onChange={(e) => setEditNotes(e.target.value)}
                      className="mt-1 w-full resize-none rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-3 text-sm outline-none focus:border-zinc-600"
                      rows={3}
                      placeholder="Freeform notes (editable after resolution)"
                    />
                  </div>
                </div>

                <div className="mt-4 flex gap-2">
                  <button
                    onClick={updateIdea}
                    disabled={!isSelectedResolved && !editTitle.trim()}
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

            {selectedIdea.status === "active" && (
              <DecisionActions
                idea={selectedIdea}
                onShip={(proofs) => shipIdea(selectedIdea.id, proofs)}
                onKill={(code, detail) => killIdea(selectedIdea.id, code, detail)}
              />
            )}
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
                    {i.proofs.length > 0 && (
                      <div className="mt-2 text-sm text-zinc-200">
                        <div className="text-xs uppercase tracking-wide text-zinc-500">Proofs</div>
                        <ul className="mt-2 space-y-1 text-sm text-zinc-300">
                          {i.proofs.map((proof) => (
                            <li key={proof.id} className="flex flex-col">
                              <span className="text-[11px] uppercase tracking-wide text-zinc-500">
                                {proof.type === "url" ? "Link" : proof.type === "github" ? "GitHub" : "Note"}
                              </span>
                              {proof.type === "note" ? (
                                <span>{proof.value}</span>
                              ) : (
                                <a className="underline" href={proof.value} target="_blank" rel="noreferrer">
                                  {proof.value}
                                </a>
                              )}
                            </li>
                          ))}
                        </ul>
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
                    {i.killReasonCode && (
                      <div className="mt-2 text-sm text-zinc-300">
                        Reason: {killReasonLabels[i.killReasonCode]}
                        {i.killReasonDetail ? ` · ${i.killReasonDetail}` : ""}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <footer className="mt-10 text-xs text-zinc-500">
          <div>Run max 5. Ship or kill. Proof required.</div>
          <SupportBuild href={SUPPORT_URL} projectName="Kill Your Darlings" />
        </footer>
      </div>

      {revealedItem && revealedDomain && (!boxCinematic || boxStage === "lidOff") && (
        <Modal onClose={() => {}} showClose={false} size="2xl">

          <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="text-sm font-semibold">The box revealed</div>
              <div className="mt-1 text-sm text-zinc-200 whitespace-pre-line">
                {revealedItem.content}
              </div>
              <div className="mt-2 text-xs text-zinc-500">
                Domain: <span className="text-zinc-300">{domainLabels[revealedDomain]}</span>
              </div>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-400">
              Return count: {revealedItem.returnCount}
            </div>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-zinc-800/70 bg-zinc-950/40 p-4">
              <div className="text-sm font-semibold">Promote</div>
              <div className="mt-1 text-xs text-zinc-500">
                Title + proof required. Pick your deadline and commit the bet.
              </div>

              <div className="mt-3 space-y-2">
                <input
                  value={promoteTitle}
                  onChange={(e) => setPromoteTitle(e.target.value)}
                  placeholder="Title"
                  className="h-10 w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 text-xs outline-none placeholder:text-zinc-600 focus:border-zinc-600"
                  maxLength={120}
                />
                <input
                  value={promoteProofDefinition}
                  onChange={(e) => setPromoteProofDefinition(e.target.value)}
                  placeholder="Proof definition (required)"
                  className="h-10 w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 text-xs outline-none placeholder:text-zinc-600 focus:border-zinc-600"
                />
                <label className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950/30 px-3 py-2 text-xs text-zinc-300">
                  <input
                    type="checkbox"
                    checked={promoteBetCommitted}
                    onChange={(e) => setPromoteBetCommitted(e.target.checked)}
                    className="h-4 w-4 accent-zinc-100"
                  />
                  I’d bet $100 this ships on time
                </label>
                <div>
                  <label className="text-[11px] text-zinc-500">Deadline (days)</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={promoteDays === 0 ? "" : String(promoteDays)}
                    onChange={(e) => {
                      const val = e.target.value.replace(/\D/g, "");
                      if (val === "") {
                        setPromoteDays(0);
                        return;
                      }
                      setPromoteDays(clamp(Number(val), 1, 90));
                    }}
                    onBlur={() => {
                      if (!promoteDays || promoteDays < 1) {
                        setPromoteDays(defaultDaysByDomain[revealedDomain]);
                      }
                    }}
                    className="mt-1 h-10 w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 text-xs outline-none focus:border-zinc-600"
                  />
                </div>
              </div>

              <button
                onClick={() => revealedItem && promoteBoxItem(revealedItem)}
                className="mt-3 w-full rounded-xl bg-gradient-to-r from-cyan-300 to-fuchsia-300 px-3 py-2 text-xs font-semibold text-zinc-950 shadow-sm hover:opacity-95"
              >
                Promote to Active
              </button>

              {promoteError && (
                <div className="mt-2 text-xs text-rose-200/80">{promoteError}</div>
              )}

              {!canAddToActive && (
                <div className="mt-2 text-[11px] text-zinc-500">Active list full.</div>
              )}
            </div>

            <div className="rounded-2xl border border-zinc-800/70 bg-zinc-950/40 p-4">
              <div className="text-sm font-semibold">Return</div>
              <div className="mt-1 text-xs text-zinc-500">
                Toss it back with a micro-reason. It’ll cool down before resurfacing.
              </div>

              <input
                value={returnReason}
                onChange={(e) => setReturnReason(e.target.value.slice(0, 15))}
                placeholder="Reason (≤15 chars)"
                className="mt-3 h-10 w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 text-xs outline-none placeholder:text-zinc-600 focus:border-zinc-600"
                maxLength={15}
              />
              <div className="mt-1 text-[11px] text-zinc-500">
                {returnReason.length}/15
              </div>

              <button
                onClick={handleReturn}
                className="mt-3 w-full rounded-xl border border-zinc-800 bg-transparent px-3 py-2 text-xs font-semibold text-zinc-100 hover:bg-zinc-900/40"
              >
                Return to Box
              </button>

              {returnError && <div className="mt-2 text-xs text-rose-200/80">{returnError}</div>}
            </div>

            <div className="rounded-2xl border border-zinc-800/70 bg-zinc-950/40 p-4">
              <div className="text-sm font-semibold">Kill</div>
              <div className="mt-1 text-xs text-zinc-500">Cut it now. No graveyard for box items.</div>

              <select
                value={boxKillReason}
                onChange={(e) => setBoxKillReason(e.target.value as KillReasonCode)}
                className="mt-3 h-10 w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 text-xs outline-none focus:border-zinc-600"
              >
                <option value="">Select a reason</option>
                {boxKillReasons.map((reason) => (
                  <option key={reason.code} value={reason.code}>
                    {reason.label}
                  </option>
                ))}
              </select>

              <textarea
                value={boxKillDetail}
                onChange={(e) => setBoxKillDetail(e.target.value)}
                placeholder="Optional detail"
                className="mt-2 h-20 w-full resize-none rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs outline-none placeholder:text-zinc-600 focus:border-zinc-600"
                rows={3}
              />

              <button
                onClick={handleKill}
                disabled={!boxKillReason}
                className="mt-3 w-full rounded-xl border border-zinc-800 bg-transparent px-3 py-2 text-xs font-semibold text-zinc-100 hover:bg-zinc-900/40 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Kill it
              </button>
            </div>
          </div>
        </Modal>
      )}

      {sparkOpen && (
        <Modal onClose={resetSparkUi} className="max-w-3xl">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold">Random Spark</div>
                <div className="mt-1 text-xs text-zinc-500">
                  {sparkExhausted ? "No sparks left today." : "Curated prompts only. One spark at a time."}
                </div>
                {sparkDomainChoice && !sparkExhausted && sparkStep !== "pickDomain" && (
                  <div className="mt-1 text-[11px] text-zinc-500">
                    Choice:{" "}
                    <span className="text-zinc-300">
                      {sparkDomainChoice === "surprise"
                        ? "Surprise me"
                        : domainLabels[sparkDomainChoice]}
                    </span>
                  </div>
                )}
              </div>
              <div className="rounded-full border border-zinc-800 bg-zinc-950/40 px-3 py-1 text-[11px] text-zinc-400">
                Sparks left: {Math.max(0, 3 - state.spark.usedToday)}
              </div>
            </div>

            {sparkExhausted ? (
              <div className="rounded-2xl border border-zinc-800/70 bg-zinc-950/40 p-4 text-sm text-zinc-200">
                No sparks left today. Come back tomorrow.
                <div className="mt-4">
                  <button
                    onClick={resetSparkUi}
                    className="rounded-xl border border-zinc-800 bg-transparent px-4 py-2 text-xs text-zinc-300"
                  >
                    Close
                  </button>
                </div>
              </div>
            ) : sparkStep === "pickDomain" ? (
              <div className="rounded-2xl border border-zinc-800/70 bg-zinc-950/40 p-4">
                <div className="text-xs text-zinc-400">Pick a domain</div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {domains.map((domain) => (
                    <button
                      key={domain}
                      onClick={() => generateNewSpark(domain)}
                      className="rounded-full border border-zinc-700 bg-zinc-900/40 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-900"
                    >
                      {domainLabels[domain]}
                    </button>
                  ))}
                  <button
                    onClick={() => generateNewSpark("surprise")}
                    className="rounded-full border border-cyan-300/40 bg-cyan-200/10 px-3 py-1 text-xs text-cyan-100"
                  >
                    Surprise me
                  </button>
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border border-zinc-800/70 bg-zinc-950/40 p-4">
                <div className="text-sm leading-relaxed text-zinc-200 whitespace-pre-line">
                  {sparkPrompt}
                </div>
                <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-zinc-700 bg-zinc-900/40 px-3 py-1 text-[11px] text-zinc-300">
                  <span>{domainLabels[sparkDomain]}</span>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    onClick={handleSparkThrow}
                    className="rounded-xl bg-gradient-to-r from-cyan-300 to-fuchsia-300 px-4 py-2 text-xs font-semibold text-zinc-950 shadow-sm hover:opacity-95"
                  >
                    Throw into Box
                  </button>
                  {sparkStep === "showSpark" && (
                    <button
                      onClick={() => generateNewSpark(sparkDomainChoice ?? "surprise")}
                      className="rounded-xl border border-zinc-700 bg-zinc-950/40 px-4 py-2 text-xs font-semibold text-zinc-100 hover:bg-zinc-900/50"
                    >
                      Another one
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setSparkStep("actNow");
                      setSparkActError("");
                    }}
                    disabled={!canAddToActive || sparkStep === "actNow"}
                    className="rounded-xl border border-zinc-700 bg-zinc-950/40 px-4 py-2 text-xs font-semibold text-zinc-100 hover:bg-zinc-900/50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Act Now (24h)
                  </button>
                  <button
                    onClick={handleSparkDismiss}
                    className="rounded-xl border border-zinc-800 bg-transparent px-4 py-2 text-xs text-zinc-300"
                  >
                    Dismiss
                  </button>
                </div>

                {!canAddToActive && (
                  <div className="mt-2 text-[11px] text-zinc-500">Active list full.</div>
                )}

                {sparkStep === "showSpark" && (
                  <div className="mt-3">
                    <label className="text-[11px] text-zinc-500">
                      Dismiss reason (optional, ≤15 chars)
                    </label>
                    <input
                      value={sparkDismissReason}
                      onChange={(e) => setSparkDismissReason(e.target.value.slice(0, 15))}
                      className="mt-1 h-9 w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-600"
                      placeholder="Optional reason"
                      maxLength={15}
                    />
                  </div>
                )}

                {sparkStep === "actNow" && (
                  <div className="mt-4 rounded-2xl border border-zinc-800/70 bg-zinc-950/50 p-4">
                    <div className="text-xs text-zinc-500">
                      Deadline locks at 24 hours from now. Proof + bet required.
                    </div>
                    <input
                      value={sparkProofDefinition}
                      onChange={(e) => setSparkProofDefinition(e.target.value)}
                      placeholder="Proof definition (required)"
                      className="mt-3 h-10 w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 text-xs outline-none placeholder:text-zinc-600 focus:border-zinc-600"
                    />
                    <label className="mt-3 flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950/30 px-3 py-2 text-xs text-zinc-300">
                      <input
                        type="checkbox"
                        checked={sparkBetCommitted}
                        onChange={(e) => setSparkBetCommitted(e.target.checked)}
                        className="h-4 w-4 accent-zinc-100"
                      />
                      I’d bet $100 this ships in 24 hours
                    </label>
                    {sparkActError && (
                      <div className="mt-2 text-xs text-rose-200/80">{sparkActError}</div>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        onClick={handleSparkActNow}
                        className="rounded-xl bg-gradient-to-r from-cyan-300 to-fuchsia-300 px-4 py-2 text-xs font-semibold text-zinc-950"
                      >
                        Confirm Act Now
                      </button>
                      <button
                        onClick={() => setSparkStep("showSpark")}
                        className="rounded-xl border border-zinc-800 bg-transparent px-4 py-2 text-xs text-zinc-300"
                      >
                        Back
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </Modal>
      )}

      {earlyUnlockDomain && (
        <Modal onClose={() => setEarlyUnlockDomain(null)}>
          <div className="text-sm font-semibold">Early unlock {domainLabels[earlyUnlockDomain]}</div>
          <div className="mt-1 text-xs text-zinc-500">
            Enter a short reason (≤30 chars). This applies debt to the next reveal.
          </div>
          <input
            value={earlyUnlockReason}
            onChange={(e) => setEarlyUnlockReason(e.target.value.slice(0, 30))}
            placeholder="Reason"
            className="mt-3 h-10 w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 text-xs outline-none placeholder:text-zinc-600 focus:border-zinc-600"
            maxLength={30}
          />
          <div className="mt-1 text-[11px] text-zinc-500">{earlyUnlockReason.length}/30</div>
          <div className="mt-4 flex gap-2">
            <button
              onClick={handleEarlyUnlock}
              disabled={!earlyUnlockReason.trim()}
              className="rounded-xl bg-gradient-to-r from-cyan-300 to-fuchsia-300 px-4 py-2 text-xs font-semibold text-zinc-950 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Unlock
            </button>
            <button
              onClick={() => setEarlyUnlockDomain(null)}
              className="rounded-xl border border-zinc-800 bg-transparent px-4 py-2 text-xs text-zinc-300"
            >
              Cancel
            </button>
          </div>
        </Modal>
      )}

      {accountabilityItemId && (
        <Modal onClose={() => {}}>
          <div className="text-sm font-semibold">You unlocked early.</div>
          <div className="mt-1 text-xs text-zinc-500">Did you act on what you took?</div>

          {accountabilityMode === "respond" && (
            <div className="mt-4 flex gap-2">
              <button
                onClick={handleAccountabilityYes}
                className="rounded-xl bg-gradient-to-r from-lime-200 to-cyan-200 px-4 py-2 text-xs font-semibold text-zinc-950"
              >
                Yes
              </button>
              <button
                onClick={() => setAccountabilityMode("return")}
                className="rounded-xl border border-zinc-800 bg-transparent px-4 py-2 text-xs text-zinc-300"
              >
                No — return
              </button>
              <button
                onClick={() => setAccountabilityMode("kill")}
                className="rounded-xl border border-zinc-800 bg-transparent px-4 py-2 text-xs text-zinc-300"
              >
                No — kill
              </button>
            </div>
          )}

          {accountabilityMode === "return" && (
            <div className="mt-4">
              <input
                value={accountabilityReturnReason}
                onChange={(e) => setAccountabilityReturnReason(e.target.value.slice(0, 15))}
                placeholder="Return reason (≤15 chars)"
                className="h-10 w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 text-xs outline-none"
                maxLength={15}
              />
              <div className="mt-1 text-[11px] text-zinc-500">
                {accountabilityReturnReason.length}/15
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={handleAccountabilityReturn}
                  disabled={!accountabilityReturnReason.trim()}
                  className="rounded-xl bg-gradient-to-r from-cyan-300 to-fuchsia-300 px-4 py-2 text-xs font-semibold text-zinc-950 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Return item
                </button>
                <button
                  onClick={() => setAccountabilityMode("respond")}
                  className="rounded-xl border border-zinc-800 bg-transparent px-4 py-2 text-xs text-zinc-300"
                >
                  Back
                </button>
              </div>
            </div>
          )}

          {accountabilityMode === "kill" && (
            <div className="mt-4">
              <select
                value={accountabilityKillReason}
                onChange={(e) => setAccountabilityKillReason(e.target.value as KillReasonCode)}
                className="h-10 w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 text-xs outline-none"
              >
                <option value="">Select a reason</option>
                {boxKillReasons.map((reason) => (
                  <option key={reason.code} value={reason.code}>
                    {reason.label}
                  </option>
                ))}
              </select>
              <textarea
                value={accountabilityKillDetail}
                onChange={(e) => setAccountabilityKillDetail(e.target.value)}
                placeholder="Optional detail"
                className="mt-2 h-20 w-full resize-none rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs outline-none"
                rows={3}
              />
              <div className="mt-3 flex gap-2">
                <button
                  onClick={handleAccountabilityKill}
                  disabled={!accountabilityKillReason}
                  className="rounded-xl bg-gradient-to-r from-rose-300 to-amber-200 px-4 py-2 text-xs font-semibold text-zinc-950 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Kill item
                </button>
                <button
                  onClick={() => setAccountabilityMode("respond")}
                  className="rounded-xl border border-zinc-800 bg-transparent px-4 py-2 text-xs text-zinc-300"
                >
                  Back
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}

      {settingsOpen && (
        <Modal onClose={() => setSettingsOpen(false)} size="lg">
          <div className="flex flex-col gap-4">
            <div>
              <div className="text-sm font-semibold">Notifications + Digest</div>
              <div className="mt-1 text-xs text-zinc-500">
                Everything stays local. Preferences are stored only in your browser.
              </div>
            </div>

            <div className="rounded-2xl border border-zinc-800/70 bg-zinc-950/40 p-4">
              <div className="text-xs uppercase tracking-wide text-zinc-500">Notifications</div>
              <div className="mt-3 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm text-zinc-200">Enable notifications</div>
                  <div className="text-xs text-zinc-500">
                    Alerts for expiring actives and when the box is ready.
                  </div>
                </div>
                <label className="flex items-center gap-2 text-xs text-zinc-300">
                  <input
                    type="checkbox"
                    checked={notifyPrefs.enabled}
                    onChange={(e) => handleNotificationsToggle(e.target.checked)}
                    disabled={notificationsBlocked}
                    className="h-4 w-4 accent-zinc-100"
                  />
                  {notifyPrefs.enabled ? "On" : "Off"}
                </label>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <div>
                  <label className="text-xs text-zinc-400">Quiet hours start</label>
                  <input
                    type="time"
                    value={notifyPrefs.quietStart}
                    onChange={(e) =>
                      setNotifyPrefs((prev) => ({ ...prev, quietStart: e.target.value }))
                    }
                    disabled={notificationsBlocked}
                    className="mt-1 h-10 w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 text-xs outline-none focus:border-zinc-600 disabled:opacity-50"
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-400">Quiet hours end</label>
                  <input
                    type="time"
                    value={notifyPrefs.quietEnd}
                    onChange={(e) =>
                      setNotifyPrefs((prev) => ({ ...prev, quietEnd: e.target.value }))
                    }
                    disabled={notificationsBlocked}
                    className="mt-1 h-10 w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 text-xs outline-none focus:border-zinc-600 disabled:opacity-50"
                  />
                </div>
              </div>

              {notificationsBlocked && (
                <div className="mt-3 rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                  {notifyPermission === "unsupported"
                    ? "Browser notifications are not supported here."
                    : "Notification permission was denied. Enable it in your browser settings to turn this on."}
                </div>
              )}

              {!notificationsBlocked && notifyPrefs.enabled && inQuietHours && (
                <div className="mt-3 text-xs text-zinc-500">
                  Quiet hours are active right now. Alerts will resume when quiet hours end.
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-zinc-800/70 bg-zinc-950/40 p-4">
              <div className="text-xs uppercase tracking-wide text-zinc-500">Daily digest</div>
              <div className="mt-3 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm text-zinc-200">Show daily digest</div>
                  <div className="text-xs text-zinc-500">
                    Appears once per day on first open.
                  </div>
                </div>
                <label className="flex items-center gap-2 text-xs text-zinc-300">
                  <input
                    type="checkbox"
                    checked={notifyPrefs.digestEnabled}
                    onChange={(e) =>
                      setNotifyPrefs((prev) => ({ ...prev, digestEnabled: e.target.checked }))
                    }
                    className="h-4 w-4 accent-zinc-100"
                  />
                  {notifyPrefs.digestEnabled ? "On" : "Off"}
                </label>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  onClick={openDigestNow}
                  className="rounded-xl border border-zinc-700 bg-zinc-900/40 px-4 py-2 text-xs font-semibold text-zinc-100 hover:bg-zinc-900/60"
                >
                  View now
                </button>
                <button
                  onClick={() => setSettingsOpen(false)}
                  className="rounded-xl border border-zinc-800 bg-transparent px-4 py-2 text-xs text-zinc-300"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {digestOpen && (
        <Modal onClose={() => setDigestOpen(false)} size="lg">
          <div className="flex flex-col gap-4">
            <div>
              <div className="text-sm font-semibold">Daily Digest</div>
              <div className="mt-1 text-xs text-zinc-500">
                Snapshot for {new Date(now).toLocaleDateString()}.
              </div>
            </div>

            <div className="rounded-2xl border border-zinc-800/70 bg-zinc-950/40 p-4">
              <div className="text-xs uppercase tracking-wide text-zinc-500">Active ideas</div>
              <div className="mt-2 text-sm text-zinc-200">
                {digestActiveList.length} active
              </div>
              {digestActiveList.length === 0 ? (
                <div className="mt-2 text-xs text-zinc-500">Nothing active right now.</div>
              ) : (
                <ul className="mt-3 space-y-2 text-xs text-zinc-300">
                  {digestActiveList.map((idea) => (
                    <li key={idea.id} className="flex items-center justify-between gap-2">
                      <span className="text-zinc-200">{idea.title}</span>
                      <span className="text-zinc-500">
                        {idea.remainingMs <= 0 ? "Expired" : `${fmtDurationShort(idea.remainingMs)} left`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-zinc-800/70 bg-zinc-950/40 p-4">
                <div className="text-xs uppercase tracking-wide text-zinc-500">Expiring soon</div>
                <div className="mt-2 text-xs text-zinc-400">
                  ≤6h: {expiringSoon6h.length} · ≤1h: {expiringSoon1h.length}
                </div>
                {expiringSoon6h.length === 0 ? (
                  <div className="mt-2 text-xs text-zinc-500">No urgent expirations.</div>
                ) : (
                  <ul className="mt-3 space-y-2 text-xs text-zinc-300">
                    {expiringSoon6h.map((idea) => (
                      <li key={idea.id} className="flex items-center justify-between gap-2">
                        <span className="text-zinc-200">{idea.title}</span>
                        <span className="text-zinc-500">
                          {fmtDurationShort(idea.deadlineAt - now)} left
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="rounded-2xl border border-zinc-800/70 bg-zinc-950/40 p-4">
                <div className="text-xs uppercase tracking-wide text-zinc-500">Expired</div>
                {expiredToday.length === 0 ? (
                  <div className="mt-2 text-xs text-zinc-500">No expirations logged today.</div>
                ) : (
                  <ul className="mt-3 space-y-2 text-xs text-zinc-300">
                    {expiredToday.map((item) => (
                      <li key={item.id} className="text-zinc-200">
                        {item.content.split("\n")[0]?.replace(/^EXPIRED:\s*/, "") ?? "Expired idea"}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-zinc-800/70 bg-zinc-950/40 p-4">
              <div className="text-xs uppercase tracking-wide text-zinc-500">Box ready</div>
              {openableDomains.length === 0 ? (
                <div className="mt-2 text-xs text-zinc-500">
                  No domains are openable yet.
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-zinc-200">
                  {openableDomains.map((domain) => (
                    <span
                      key={domain}
                      className="rounded-full border border-cyan-300/30 bg-cyan-200/10 px-3 py-1 text-[11px] text-cyan-100"
                    >
                      {domainLabels[domain]}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Modal>
      )}

      {notifyPromptOpen && (
        <Modal onClose={() => setNotifyPromptOpen(false)} size="lg">
          <div className="flex flex-col gap-3">
            <div>
              <div className="text-sm font-semibold">Stay in the loop?</div>
              <div className="mt-1 text-xs text-zinc-500">
                Enable notifications to catch expirations and box openings even when you’re away.
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => {
                  handleNotificationsToggle(true);
                  setNotifyPromptOpen(false);
                }}
                className="rounded-xl bg-gradient-to-r from-cyan-300 to-fuchsia-300 px-4 py-2 text-xs font-semibold text-zinc-950"
              >
                Enable notifications
              </button>
              <button
                onClick={() => setNotifyPromptOpen(false)}
                className="rounded-xl border border-zinc-800 bg-transparent px-4 py-2 text-xs text-zinc-300"
              >
                Not now
              </button>
            </div>
            {notificationsBlocked && (
              <div className="text-xs text-amber-200/80">
                Notifications aren’t available here. You can still use the daily digest.
              </div>
            )}
          </div>
        </Modal>
      )}

      <style>{`
        @keyframes kyd-shake {
          0% { transform: translateX(0); }
          20% { transform: translateX(-6px) rotate(-1deg); }
          40% { transform: translateX(6px) rotate(1deg); }
          60% { transform: translateX(-4px) rotate(-0.5deg); }
          80% { transform: translateX(4px) rotate(0.5deg); }
          100% { transform: translateX(0); }
        }
        .animate-kyd-shake {
          animation: kyd-shake 0.35s ease-in-out;
        }
      `}</style>
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

function Modal({
  children,
  onClose,
  showClose = true,
  className,
  size = "md",
}: {
  children: React.ReactNode;
  onClose: () => void;
  showClose?: boolean;
  className?: string;
  size?: "md" | "lg" | "xl" | "2xl";
}) {
  const sizeClass =
    size === "md"
      ? "max-w-md"
      : size === "lg"
      ? "max-w-2xl"
      : size === "xl"
      ? "max-w-4xl"
      : "max-w-6xl";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div
        className={cx(
          "relative w-full rounded-2xl border border-zinc-800/80 bg-zinc-950/90 p-5 shadow-[0_0_40px_rgba(0,0,0,0.5)]",
          sizeClass,
          className
        )}
      >
        {showClose && (
          <button
            onClick={onClose}
            className="absolute right-3 top-3 text-xs text-zinc-500 hover:text-zinc-200"
          >
            Close
          </button>
        )}
        {children}
      </div>
    </div>
  );
}


function DecisionActions({
  idea,
  onShip,
  onKill,
}: {
  idea: Idea;
  onShip: (proofs: Idea["proofs"]) => void;
  onKill: (code: KillReasonCode, detail: string) => void;
}) {
  const [proofs, setProofs] = useState<Idea["proofs"]>([]);
  const [proofType, setProofType] = useState<ProofAttachmentType>("url");
  const [proofValue, setProofValue] = useState("");
  const [killReason, setKillReason] = useState<KillReasonCode | "">("");
  const [killDetail, setKillDetail] = useState("");

  useEffect(() => {
    setProofs([]);
    setProofType("url");
    setProofValue("");
    setKillReason("");
    setKillDetail("");
  }, [idea.id]);

  const canShip =
    idea.proofDefinition.trim().length > 0 &&
    proofs.length > 0 &&
    proofs.every((proof) => proof.value.trim().length > 0);

  function addProof() {
    const value = proofValue.trim();
    if (!value) return;
    setProofs((prev) => [
      ...prev,
      { id: uid(), type: proofType, value },
    ]);
    setProofValue("");
  }

  function removeProof(id: string) {
    setProofs((prev) => prev.filter((proof) => proof.id !== id));
  }

  return (
    <div className="mt-5 grid gap-4 md:grid-cols-2">
      <div className="relative rounded-2xl border border-zinc-800/70 bg-zinc-950/30 p-4">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-lime-300/20 to-transparent" />
        <div className="text-sm font-semibold">Ship it</div>
        <div className="mt-1 text-xs text-zinc-500">
          Add at least one proof and mark as shipped.
        </div>

        <div className="mt-3 grid gap-2">
          <div className="flex gap-2">
            <select
              value={proofType}
              onChange={(e) => setProofType(e.target.value as ProofAttachmentType)}
              className="h-10 w-28 rounded-xl border border-zinc-800 bg-zinc-950/60 px-2 text-xs outline-none focus:border-zinc-600"
            >
              <option value="url">URL</option>
              <option value="github">GitHub</option>
              <option value="note">Note</option>
            </select>

            {proofType === "note" ? (
              <textarea
                value={proofValue}
                onChange={(e) => setProofValue(e.target.value)}
                placeholder="Short proof note"
                className="h-10 flex-1 resize-none rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs outline-none placeholder:text-zinc-600 focus:border-zinc-600"
                rows={1}
              />
            ) : (
              <input
                value={proofValue}
                onChange={(e) => setProofValue(e.target.value)}
                placeholder="https://..."
                className="h-10 flex-1 rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 text-xs outline-none placeholder:text-zinc-600 focus:border-zinc-600"
              />
            )}

            <button
              onClick={addProof}
              className="h-10 rounded-xl border border-zinc-800 bg-zinc-900/40 px-3 text-xs text-zinc-200 hover:bg-zinc-900/60"
            >
              Add
            </button>
          </div>

          {proofs.length > 0 && (
            <div className="space-y-2">
              {proofs.map((proof) => (
                <div
                  key={proof.id}
                  className="flex items-start justify-between gap-2 rounded-xl border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-300"
                >
                  <div className="flex flex-col">
                    <span className="text-[10px] uppercase tracking-wide text-zinc-500">
                      {proof.type === "url" ? "Link" : proof.type === "github" ? "GitHub" : "Note"}
                    </span>
                    <span className="break-all">{proof.value}</span>
                  </div>
                  <button
                    onClick={() => removeProof(proof.id)}
                    className="text-[11px] text-zinc-400 hover:text-zinc-200"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {!idea.proofDefinition.trim() && (
          <div className="mt-3 text-xs text-rose-200/80">Add a proof definition before shipping.</div>
        )}

        <button
          onClick={() => onShip(proofs)}
          disabled={!canShip}
          className="mt-3 w-full rounded-xl bg-gradient-to-r from-lime-200 to-cyan-200 px-4 py-3 text-sm font-semibold text-zinc-950 shadow-sm hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Mark Completed
        </button>
      </div>

      <div className="relative rounded-2xl border border-zinc-800/70 bg-zinc-950/30 p-4">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber-300/20 to-transparent" />
        <div className="text-sm font-semibold">Kill it</div>
        <div className="mt-1 text-xs text-zinc-500">Give a reason. Killing is part of taste. Be honest.</div>

        <div className="mt-3 grid gap-2">
          <select
            value={killReason}
            onChange={(e) => setKillReason(e.target.value as KillReasonCode)}
            className="h-10 w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 text-xs outline-none focus:border-zinc-600"
          >
            <option value="">Select a reason</option>
            <option value="NO_LONGER_RELEVANT">No longer relevant</option>
            <option value="TOO_BIG">Too big</option>
            <option value="NO_CLEAR_USER_PROBLEM">No clear user problem</option>
            <option value="LOST_INTEREST">Lost interest</option>
            <option value="BLOCKED">Blocked</option>
            <option value="OTHER">Other</option>
          </select>

          <textarea
            value={killDetail}
            onChange={(e) => setKillDetail(e.target.value)}
            placeholder="Optional detail"
            className="w-full resize-none rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-3 text-sm outline-none placeholder:text-zinc-600 focus:border-zinc-600"
            rows={3}
          />
        </div>

        <button
          onClick={() => onKill(killReason as KillReasonCode, killDetail)}
          disabled={!killReason}
          className="mt-3 w-full rounded-xl border border-zinc-800 bg-transparent px-4 py-3 text-sm font-semibold text-zinc-100 hover:bg-zinc-900/40 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Kill Idea
        </button>
      </div>
    </div>
  );
}
