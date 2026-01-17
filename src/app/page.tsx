"use client";

import React, { useEffect, useMemo, useState } from "react";

import SupportBuild from "@/components/SupportBuild";
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

type Domain =
  | "business"
  | "career"
  | "relationships"
  | "dating"
  | "lifestyle"
  | "random";

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
        const baseSpark = parsed.spark ?? { usedToday: 0, dayKey: dayKeyLocal() };
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

function resetSparkIfNewDay(spark: AppState["spark"]) {
  const today = dayKeyLocal();
  if (spark.dayKey === today) return spark;
  return {
    usedToday: 0,
    dayKey: today,
    lastSpark: spark.lastSpark,
  };
}

function consumeSpark(
  spark: AppState["spark"],
  lastSpark: { prompt: string; domain: Domain; createdAt: number }
) {
  return {
    usedToday: spark.usedToday + 1,
    dayKey: spark.dayKey,
    lastSpark,
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

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function pickRandom<T>(items: T[]) {
  return items[Math.floor(Math.random() * items.length)];
}

function buildSparkPrompt(template: { text: string; slots: Array<keyof SparkVariablePool> }, vars: SparkVariablePool) {
  let output = template.text;
  template.slots.forEach((slot) => {
    const value = pickRandom(vars[slot]);
    output = output.replaceAll(`{${slot}}`, value);
  });
  if (Math.random() < 0.4) {
    output = `${output} — ${pickRandom(sparkConstraints)}`;
  }
  return output;
}

function generateSpark(
  domainChoice: Domain | "surprise",
  lastPrompt?: string
): { domain: Domain; prompt: string } {
  const domain = domainChoice === "surprise" ? pickRandom(domains) : domainChoice;
  const vars = sparkVariablesByDomain[domain];
  let prompt = "";

  for (let i = 0; i < 5; i += 1) {
    const template = pickRandom(sparkTemplates);
    const nextPrompt = buildSparkPrompt(template, vars);
    if (!lastPrompt || nextPrompt !== lastPrompt) {
      prompt = nextPrompt;
      break;
    }
    prompt = nextPrompt;
  }

  return { domain, prompt };
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

type SparkVariablePool = {
  object: string[];
  asset: string[];
  audience: string[];
  channel: string[];
  system: string[];
  friction: string[];
  message: string[];
  nextStep: string[];
  metric: string[];
  place: string[];
  habit: string[];
  boundary: string[];
  tool: string[];
};

const sparkTemplates: Array<{ text: string; slots: Array<keyof SparkVariablePool> }> = [
  { text: "Audit your {system} and remove one {friction} step.", slots: ["system", "friction"] },
  { text: "Reduce {object} by cutting one {friction}.", slots: ["object", "friction"] },
  { text: "Decide on one {nextStep} for {object}.", slots: ["nextStep", "object"] },
  { text: "Create a {asset} that explains {object} in 5 bullets.", slots: ["asset", "object"] },
  { text: "Reach out to {audience} with a {message} via {channel}.", slots: ["audience", "message", "channel"] },
  { text: "Document your {system} as 5 steps in {channel}.", slots: ["system", "channel"] },
  { text: "Remove one {friction} from your {tool} stack.", slots: ["friction", "tool"] },
  { text: "Update your {asset} to highlight {metric}.", slots: ["asset", "metric"] },
  { text: "Draft a {message} for {audience} about {object}.", slots: ["message", "audience", "object"] },
  { text: "Pick one {habit} to try in your {place} today.", slots: ["habit", "place"] },
  { text: "Set a {boundary} around {place} for one day.", slots: ["boundary", "place"] },
  { text: "Tidy your {place} by clearing one {friction} spot.", slots: ["place", "friction"] },
];

const sparkConstraints = [
  "15 minutes only",
  "10-minute timer",
  "limit to 3 items",
  "one pass only",
  "no new tools",
  "no money spent",
  "before lunch",
  "before dinner",
  "keep it to 5 bullets",
  "no phone",
  "stop at 20 minutes",
  "do it in one sitting",
];

const sparkVariablesByDomain: Record<Domain, SparkVariablePool> = {
  business: {
    object: [
      "pricing page",
      "offer page",
      "sales deck",
      "onboarding flow",
      "lead magnet",
      "support workflow",
      "pipeline notes",
      "checkout flow",
      "trial sequence",
      "client intake form",
    ],
    asset: [
      "one-page offer doc",
      "FAQ snippet",
      "case study outline",
      "comparison table",
      "demo script",
      "value prop headline",
      "pricing note",
      "onboarding checklist",
    ],
    audience: [
      "warm lead",
      "current customer",
      "past buyer",
      "partner lead",
      "newsletter subscriber",
      "demo attendee",
    ],
    channel: ["email", "CRM", "website", "support inbox", "calendar", "Notion doc"],
    system: [
      "sales pipeline",
      "onboarding flow",
      "support triage",
      "billing workflow",
      "follow-up cadence",
      "handoff checklist",
    ],
    friction: [
      "extra approval",
      "manual step",
      "unclear CTA",
      "duplicate tool",
      "missing info",
      "slow handoff",
    ],
    message: ["two-sentence update", "short question", "quick recap", "availability note", "value reminder"],
    nextStep: ["follow-up", "price test", "mini survey", "demo invite", "trial check-in"],
    metric: ["conversion rate", "reply rate", "activation time", "time-to-first-value", "drop-off point"],
    place: ["workspace", "dashboard", "inbox", "calendar", "docs folder"],
    habit: ["daily review", "end-of-day sweep", "5-minute follow-up block"],
    boundary: ["no-meeting hour", "notification quiet window", "single-tool rule"],
    tool: ["CRM", "analytics dashboard", "support tool", "email template", "proposal doc"],
  },
  career: {
    object: [
      "resume",
      "LinkedIn summary",
      "portfolio",
      "weekly update",
      "promotion case",
      "skill gap",
      "project pitch",
      "meeting notes",
    ],
    asset: ["brag doc entry", "portfolio bullet", "impact slide", "role story", "achievement highlight"],
    audience: ["manager", "skip-level", "mentor", "recruiter", "teammate", "stakeholder"],
    channel: ["email", "Slack", "calendar", "Notion", "LinkedIn", "doc"],
    system: ["weekly review", "meeting prep", "priority list", "job search tracker", "learning plan"],
    friction: ["context switching", "unclear priority", "missing artifact", "uncapped meetings", "handoff gap"],
    message: ["status update", "feedback ask", "impact recap", "follow-up note"],
    nextStep: ["coffee chat", "skill sprint", "portfolio refresh", "stakeholder sync"],
    metric: ["impact result", "time saved", "quality bar", "delivery date"],
    place: ["desk", "calendar", "task list", "notes", "workspace"],
    habit: ["morning plan", "end-of-week review", "5-minute prep"],
    boundary: ["no-meeting focus block", "offline hour", "single-task rule"],
    tool: ["calendar", "task board", "notes doc", "presentation deck"],
  },
  relationships: {
    object: [
      "weekly check-in",
      "shared plan",
      "recurring tension",
      "upcoming decision",
      "household task",
      "shared budget",
      "communication pattern",
    ],
    asset: ["appreciation note", "shared plan", "small gesture", "clarity question", "expectation list"],
    audience: ["partner", "close friend", "family member", "roommate"],
    channel: ["text", "call", "in-person", "shared note"],
    system: ["weekly check-in", "shared calendar", "household routine", "decision log"],
    friction: ["unclear expectation", "unspoken assumption", "late response", "missed handoff", "nagging reminder"],
    message: ["check-in", "thank-you note", "boundary ask", "apology", "clarifying question"],
    nextStep: ["small reset", "shared plan", "quick call", "walk-and-talk"],
    metric: ["stress point", "recurring conflict", "missed handoff"],
    place: ["kitchen", "living room", "shared calendar", "phone-free dinner"],
    habit: ["two-minute appreciation", "weekly reset", "device-free meal"],
    boundary: ["quiet hour", "no phones at dinner", "check-in time"],
    tool: ["shared calendar", "notes app", "message thread"],
  },
  dating: {
    object: ["profile bio", "photo set", "opener", "date plan", "follow-up", "boundary note"],
    asset: ["profile tweak", "first message", "date idea", "follow-up text", "vibe check"],
    audience: ["match", "new connection"],
    channel: ["app chat", "text", "voice note"],
    system: ["dating calendar", "intro pipeline", "message queue"],
    friction: ["too-long message", "vague plan", "stale chat", "overthinking"],
    message: ["short opener", "simple plan", "light follow-up", "honest boundary"],
    nextStep: ["low-key date", "follow-up", "time check", "pause"],
    metric: ["reply rate", "response time", "comfort level"],
    place: ["coffee spot", "walk route", "bookstore", "park"],
    habit: ["one simple follow-up", "clear plan habit"],
    boundary: ["time limit", "pace check", "single date per week"],
    tool: ["calendar", "notes app", "photo album"],
  },
  lifestyle: {
    object: [
      "sleep routine",
      "meal plan",
      "workout plan",
      "budget",
      "home reset",
      "screen time",
      "inbox",
    ],
    asset: ["shopping list", "meal prep plan", "budget line", "routine checklist", "habit tracker"],
    audience: ["future you", "roommate", "partner"],
    channel: ["notes app", "calendar", "kitchen note", "text"],
    system: ["morning routine", "evening shutdown", "weekly reset", "meal prep flow", "money admin"],
    friction: ["clutter pile", "notification overload", "missing prep", "late bedtime", "decision fatigue"],
    message: ["simple reminder", "plan summary", "prep note"],
    nextStep: ["5-minute tidy", "short walk", "batch cook", "admin sweep"],
    metric: ["sleep time", "screen time", "spend limit", "steps"],
    place: ["desk", "kitchen", "bedroom", "phone home screen", "entryway"],
    habit: ["10-minute reset", "stretch block", "water reminder"],
    boundary: ["no-phone hour", "bedtime cutoff", "single-task block"],
    tool: ["timer", "calendar", "notes app", "grocery list"],
  },
  random: {
    object: ["file system", "browser tabs", "reading list", "music queue", "notes pile", "photos"],
    asset: ["quick checklist", "template note", "mini archive", "shortcut doc"],
    audience: ["future you", "yourself"],
    channel: ["notes app", "desktop", "calendar", "email draft"],
    system: ["digital tidy", "weekly review", "learning queue", "bookmark flow"],
    friction: ["duplicate file", "dead link", "unclear naming", "forgotten tab", "loose ends"],
    message: ["quick note", "tiny checklist", "short summary"],
    nextStep: ["tiny cleanup", "one new folder", "one new shortcut", "micro-adventure"],
    metric: ["time saved", "fewer clicks", "faster recall"],
    place: ["desktop", "downloads folder", "phone", "kitchen", "neighborhood"],
    habit: ["2-minute tidy", "one new shortcut"],
    boundary: ["no-new-tabs rule", "single-folder rule"],
    tool: ["file manager", "notes app", "browser bookmarks"],
  },
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

  // Persist after hydration
  useEffect(() => {
    if (!hydrated) return;
    saveState(state);
  }, [state, hydrated]);

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

  // Expiry flow: move expired actives back into the box
  useEffect(() => {
    if (!hydrated) return;
    const expired = state.ideas.filter((idea) => idea.status === "active" && now >= idea.deadlineAt);
    if (expired.length === 0) return;

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

    const { domain, prompt } = generateSpark(choice, normalizedSpark.lastSpark?.prompt);

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
      spark: consumeSpark(normalizedSpark, { prompt, domain, createdAt: Date.now() }),
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
                  <button
                    onClick={openSparkModal}
                    className="rounded-xl border border-zinc-700/80 bg-zinc-950/40 px-4 py-2 text-xs font-semibold text-zinc-100 shadow-sm hover:bg-zinc-900/50"
                  >
                    Random Spark
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

          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Active</h2>
            <p className="text-xs text-zinc-500">
              Max {state.settings.activeLimit} at once. Pressure is the point.
            </p>
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
          Mark Shipped
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
