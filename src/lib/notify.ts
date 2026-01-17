export type NotificationPrefs = {
  enabled: boolean;
  digestEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  lastDigestDate: string | null;
  firedEvents: Record<string, string>;
  notifyLog: number[];
  promptDismissed: boolean;
};

const PREFS_KEY = "kyd_notify_prefs_v1";

export function defaultNotificationPrefs(): NotificationPrefs {
  return {
    enabled: false,
    digestEnabled: true,
    quietStart: "22:00",
    quietEnd: "08:00",
    lastDigestDate: null,
    firedEvents: {},
    notifyLog: [],
    promptDismissed: false,
  };
}

export function loadNotificationPrefs(): NotificationPrefs {
  if (typeof globalThis === "undefined") {
    return defaultNotificationPrefs();
  }
  try {
    const raw = globalThis.localStorage.getItem(PREFS_KEY);
    if (!raw) return defaultNotificationPrefs();
    const parsed = JSON.parse(raw) as Partial<NotificationPrefs>;
    return {
      ...defaultNotificationPrefs(),
      ...parsed,
      firedEvents: parsed.firedEvents ?? {},
      notifyLog: Array.isArray(parsed.notifyLog) ? parsed.notifyLog : [],
    };
  } catch {
    return defaultNotificationPrefs();
  }
}

export function saveNotificationPrefs(prefs: NotificationPrefs) {
  if (typeof globalThis === "undefined") return;
  try {
    globalThis.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}

export function isNotificationSupported() {
  return typeof globalThis !== "undefined" && "Notification" in globalThis;
}

export function getNotificationPermission(): NotificationPermission | "unsupported" {
  if (!isNotificationSupported()) return "unsupported";
  return globalThis.Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (!isNotificationSupported()) return "unsupported";
  return globalThis.Notification.requestPermission();
}

function parseTime(value: string) {
  const [hoursRaw, minutesRaw] = value.split(":");
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return { hours: 0, minutes: 0 };
  }
  return { hours, minutes };
}

export function isQuietHours(date: Date, quietStart: string, quietEnd: string) {
  if (!quietStart || !quietEnd || quietStart === quietEnd) return false;

  const start = parseTime(quietStart);
  const end = parseTime(quietEnd);
  const currentMinutes = date.getHours() * 60 + date.getMinutes();
  const startMinutes = start.hours * 60 + start.minutes;
  const endMinutes = end.hours * 60 + end.minutes;

  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }

  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

export function pruneNotifyLog(log: number[], now: number) {
  return log.filter((timestamp) => now - timestamp < 60 * 60 * 1000);
}

export function canSendMoreNotifications(log: number[], now: number) {
  return pruneNotifyLog(log, now).length < 3;
}

export function fireNotification(title: string, options?: NotificationOptions) {
  if (!isNotificationSupported()) return false;
  if (globalThis.Notification.permission !== "granted") return false;
  try {
    new globalThis.Notification(title, options);
    return true;
  } catch {
    return false;
  }
}
