import {
  getStorageCounts,
  getImportJobState,
  getStorageStats,
  getStoredLikes,
  migrateLikesFromChromeStorage,
  saveLikes,
  saveLikesBatch,
  setStorageMode,
  setImportJobState,
  updateImportJobState
} from "./lib/db";
import type { ImportJobState, LikedTweet, RuntimeMessage, StateSnapshot, SyncContext } from "./types";
import type { ImportTelemetry } from "./types";

const DEFAULT_LIKES_URL = "https://x.com/i/liked_posts";
const IMPORT_TELEMETRY_KEY = "importTelemetry";
const LAST_LIKES_URL_KEY = "lastLikesUrl";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onStartup.addListener(() => {
  void migrateLikesFromChromeStorage();
});

async function broadcastState(snapshot: StateSnapshot) {
  await chrome.runtime.sendMessage({
    type: "STATE_SNAPSHOT",
    snapshot
  } satisfies RuntimeMessage).catch(() => undefined);
}

async function getImportTelemetry(): Promise<ImportTelemetry> {
  const result = await chrome.storage.local.get(IMPORT_TELEMETRY_KEY);
  return (
    (result[IMPORT_TELEMETRY_KEY] as ImportTelemetry | undefined) ?? {
      elapsedMs: 0,
      batches: 0,
      avgBatchSize: 0,
      likesPerMinute: 0,
      lastBatchSize: 0,
      waitMs: 0,
      waitEvents: 0,
      avgWaitMs: 0
    }
  );
}

async function setImportTelemetry(telemetry: ImportTelemetry): Promise<void> {
  await chrome.storage.local.set({
    [IMPORT_TELEMETRY_KEY]: telemetry
  });
}

async function resetImportTelemetry(startedAt: string): Promise<ImportTelemetry> {
  const telemetry: ImportTelemetry = {
    startedAt,
    elapsedMs: 0,
    batches: 0,
    avgBatchSize: 0,
    likesPerMinute: 0,
    lastBatchSize: 0,
    waitMs: 0,
    waitEvents: 0,
    avgWaitMs: 0
  };
  await setImportTelemetry(telemetry);
  return telemetry;
}

async function updateImportTelemetry(
  totalLikes: number,
  metrics: { batchSize: number; waitMs: number; happenedAt: string }
): Promise<ImportTelemetry> {
  const current = await getImportTelemetry();
  const startedAt = current.startedAt ?? metrics.happenedAt;
  const elapsedMs = Math.max(0, new Date(metrics.happenedAt).getTime() - new Date(startedAt).getTime());
  const batches = current.batches + 1;
  const waitEvents = current.waitEvents + 1;
  const totalBatchLikes = current.avgBatchSize * current.batches + metrics.batchSize;
  const totalWaitMs = current.avgWaitMs * current.waitEvents + metrics.waitMs;
  const next: ImportTelemetry = {
    startedAt,
    lastBatchAt: metrics.happenedAt,
    elapsedMs,
    batches,
    avgBatchSize: totalBatchLikes / batches,
    likesPerMinute: elapsedMs > 0 ? totalLikes / (elapsedMs / 60000) : totalLikes,
    lastBatchSize: metrics.batchSize,
    waitMs: metrics.waitMs,
    waitEvents,
    avgWaitMs: totalWaitMs / waitEvents
  };
  await setImportTelemetry(next);
  return next;
}

function shouldRefreshStorageStats(state: ImportJobState) {
  const scrolls = state.checkpoint.scrolls;
  return scrolls === 0 || scrolls % 8 === 0;
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  void (async () => {
    await migrateLikesFromChromeStorage();

    if (message.type === "SYNC_VISIBLE_LIKES") {
      const tabId = sender.tab?.id ?? (await getActiveXTabId());
      if (!tabId) {
        sendResponse({ ok: false, error: "No active X tab found." });
        return;
      }

      const response = await chrome.tabs.sendMessage(tabId, { type: "SYNC_VISIBLE_LIKES" });
      const tweets = (response?.tweets as LikedTweet[] | undefined) ?? [];
      const stored = await saveLikes(tweets);
      await broadcastState({
        likesCount: stored.length,
        storageStats: await getStorageStats()
      });
      sendResponse({ ok: true, count: tweets.length, total: stored.length });
      return;
    }

    if (message.type === "GET_LIKES") {
      const tweets = await getStoredLikes();
      sendResponse({ ok: true, tweets });
      return;
    }

    if (message.type === "GET_SYNC_CONTEXT") {
      const context = await getSyncContext();
      sendResponse({ ok: true, context });
      return;
    }

    if (message.type === "GET_STATE_SNAPSHOT") {
      sendResponse({
        ok: true,
        snapshot: {
          importState: await getImportJobState(),
          storageStats: await getStorageStats(),
          likesCount: (await getStorageCounts()).totalLikes,
          telemetry: await getImportTelemetry()
        } satisfies StateSnapshot
      });
      return;
    }

    if (message.type === "GET_IMPORT_STATUS") {
      const state = await getImportJobState();
      sendResponse({ ok: true, state });
      return;
    }

    if (message.type === "GET_STORAGE_STATS") {
      const stats = await getStorageStats();
      sendResponse({ ok: true, stats });
      return;
    }

    if (message.type === "SET_STORAGE_MODE") {
      await setStorageMode(message.mode);
      const likes = await getStoredLikes();
      await saveLikes(likes);
      const stats = await getStorageStats();
      await broadcastState({
        storageStats: stats,
        likesCount: likes.length
      });
      sendResponse({ ok: true, stats });
      return;
    }

    if (message.type === "START_AUTO_IMPORT") {
      const startedAt = new Date().toISOString();
      const mode = message.mode ?? "full";
      const knownIds =
        message.knownIds ?? (mode === "recent" ? (await getStoredLikes()).map((tweet) => tweet.id) : []);
      const workerTab = await createImportWorkerTab(await resolveImportSourceUrl(sender.tab?.url));
      const tabId = workerTab.id as number;

      const importState = createImportState("running", {
        mode,
        activeTabId: tabId,
        startedAt,
        message:
          mode === "recent"
            ? "Opened your likes page in a background tab. Recent sync started."
            : "Opened your likes page in a background tab. Archive import started."
      });
      await setImportJobState(importState);
      const telemetry = await resetImportTelemetry(startedAt);
      await broadcastState({
        importState,
        telemetry
      });

      await waitForTabReady(tabId);
      await chrome.tabs.sendMessage(tabId, { type: "START_AUTO_IMPORT", mode, knownIds });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "STOP_AUTO_IMPORT") {
      const state = await getImportJobState();
      const tabId = state.activeTabId ?? null;
      if (tabId) {
        await chrome.tabs.sendMessage(tabId, { type: "STOP_AUTO_IMPORT" }).catch(() => undefined);
      }
      const next = await updateImportJobState({
        status: "paused",
        message: "Import paused by user."
      });
      await cleanupImportWorkerTab(next.activeTabId);
      await broadcastState({
        importState: next,
        telemetry: await getImportTelemetry()
      });
      sendResponse({ ok: true, state: next });
      return;
    }

    if (message.type === "IMPORT_BATCH") {
      const stored = await saveLikesBatch(message.tweets);
      const next = await updateImportJobState({
        status: "running",
        importedCount: stored.totalLikes,
        newCount: message.tweets.length,
        checkpoint: message.checkpoint,
        message: message.message
      });
      const counts = await getStorageCounts();
      const telemetry = await updateImportTelemetry(stored.totalLikes, message.metrics);
      await broadcastState({
        importState: next,
        likesCount: stored.totalLikes,
        telemetry,
        storageStats: shouldRefreshStorageStats(next)
          ? {
              ...(await getStorageStats()),
              totalLikes: counts.totalLikes,
              authors: counts.authors,
              embeddings: counts.embeddings,
              indexedTweets: counts.indexedTweets
            }
          : undefined
      });
      sendResponse({ ok: true, state: next });
      return;
    }

    if (message.type === "IMPORT_STATE_UPDATE") {
      const state = await updateImportJobState(message.state);
      if (state.status === "completed" || state.status === "paused" || state.status === "error") {
        await cleanupImportWorkerTab(state.activeTabId);
      }
      await broadcastState({
        importState: state,
        telemetry: await getImportTelemetry()
      });
      sendResponse({ ok: true, state });
      return;
    }

  })().catch((error: unknown) => {
    const messageText = error instanceof Error ? error.message : "Unknown error";
    sendResponse({ ok: false, error: messageText });
  });

  return true;
});

function createImportState(status: ImportJobState["status"], partial: Partial<ImportJobState>): ImportJobState {
  return {
    status,
    mode: partial.mode ?? "full",
    startedAt: partial.startedAt,
    updatedAt: new Date().toISOString(),
    importedCount: partial.importedCount ?? 0,
    newCount: partial.newCount ?? 0,
    checkpoint: partial.checkpoint ?? {
      seenCount: 0,
      idleCycles: 0,
      scrolls: 0
    },
    message: partial.message ?? "",
    activeTabId: partial.activeTabId,
    error: partial.error
  };
}

async function getActiveXTabId(): Promise<number | null> {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true,
    url: ["https://x.com/*", "https://twitter.com/*"]
  });

  return tabs[0]?.id ?? null;
}

async function getSyncContext(): Promise<SyncContext> {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  const url = tab?.url;
  const isXTab = Boolean(url && /https:\/\/(x|twitter)\.com\//.test(url));
  const isLikesPage = Boolean(url && /\/likes(\/)?$/.test(new URL(url).pathname));

  if (url && isLikesPage) {
    await chrome.storage.local.set({
      [LAST_LIKES_URL_KEY]: url
    });
  }

  return {
    isXTab,
    isLikesPage,
    tabTitle: tab?.title,
    url
  };
}

async function createImportWorkerTab(sourceUrl?: string): Promise<chrome.tabs.Tab> {
  const targetUrl = normalizeLikesUrl(sourceUrl);
  const tab = await chrome.tabs.create({
    url: targetUrl,
    active: false
  });

  if (!tab.id) {
    throw new Error("Failed to create import worker tab.");
  }

  return tab;
}

async function resolveImportSourceUrl(sourceUrl?: string): Promise<string | undefined> {
  const candidates: Array<string | undefined> = [sourceUrl];

  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  candidates.push(activeTab?.url);

  const stored = await chrome.storage.local.get(LAST_LIKES_URL_KEY);
  candidates.push(stored[LAST_LIKES_URL_KEY] as string | undefined);

  for (const candidate of candidates) {
    const inferred = inferLikesUrl(candidate);
    if (inferred) {
      return inferred;
    }
  }

  return undefined;
}

function normalizeLikesUrl(sourceUrl?: string): string {
  return inferLikesUrl(sourceUrl) ?? DEFAULT_LIKES_URL;
}

function inferLikesUrl(sourceUrl?: string): string | undefined {
  if (!sourceUrl) {
    return undefined;
  }

  try {
    const parsed = new URL(sourceUrl);
    if (!/^https:\/\/(x|twitter)\.com\//.test(parsed.href)) {
      return undefined;
    }

    if (/\/likes\/?$/.test(parsed.pathname)) {
      return parsed.href;
    }

    const [firstSegment] = parsed.pathname.split("/").filter(Boolean);
    if (!firstSegment) {
      return undefined;
    }

    const reserved = new Set([
      "home",
      "explore",
      "search",
      "notifications",
      "messages",
      "compose",
      "i",
      "settings",
      "communities"
    ]);
    if (reserved.has(firstSegment.toLowerCase())) {
      return undefined;
    }

    return `${parsed.origin}/${firstSegment}/likes`;
  } catch {
    return undefined;
  }
}

async function waitForTabReady(tabId: number): Promise<void> {
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete") {
    return;
  }

  await new Promise<void>((resolve) => {
    const listener = (updatedTabId: number, changeInfo: { status?: string }) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") {
        return;
      }

      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function cleanupImportWorkerTab(tabId?: number): Promise<void> {
  if (!tabId) {
    return;
  }

  await chrome.tabs.remove(tabId).catch(() => undefined);
}
