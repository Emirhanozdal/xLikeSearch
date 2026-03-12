import type { LikedTweet, RuntimeMessage, TweetCategory, TweetEntity, TweetSocialContext } from "./types";

const BRIDGE_SOURCE = "x-like-search-bridge";
const CONTENT_SOURCE = "x-like-search-content";
const BRIDGE_SCRIPT_ID = "x-like-search-page-bridge";

let autoImportRunning = false;
let bridgeInjected = false;
let pendingNetworkFallback:
  | {
      mode: "full" | "recent";
      knownIds: string[];
      started: boolean;
      settled: boolean;
    }
  | null = null;

const SCROLL_BURSTS = 4;
const FEED_WAIT_TIMEOUT_MS = 240;
const MAX_STALLED_BOTTOM_RETRIES = 2;
const RECENT_SYNC_IDLE_CYCLES = 3;
const DEFAULT_MAX_IDLE_CYCLES = 8;

injectPageBridge();
window.addEventListener("message", handleBridgeMessage);

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message.type === "SYNC_VISIBLE_LIKES") {
    const tweets = extractVisibleLikedTweets();
    sendResponse({ ok: true, tweets });
    return true;
  }

  if (message.type === "START_AUTO_IMPORT") {
    void runNetworkImport(message.mode ?? "full", message.knownIds ?? []).catch(async () => {
      void runAutoImport(message.mode ?? "full", message.knownIds ?? []).catch(async (error: unknown) => {
        const messageText = error instanceof Error ? error.message : "Auto-import failed.";
        await chrome.runtime.sendMessage({
          type: "IMPORT_STATE_UPDATE",
          state: {
            status: "error",
            message: messageText,
            error: messageText
          }
        } satisfies RuntimeMessage);
      });
    });
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "STOP_AUTO_IMPORT") {
    autoImportRunning = false;
    window.postMessage(
      {
        source: CONTENT_SOURCE,
        type: "XLS_STOP_NETWORK_IMPORT"
      },
      "*"
    );
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

async function runNetworkImport(mode: "full" | "recent", knownIds: string[]): Promise<void> {
  injectPageBridge();

  pendingNetworkFallback = {
    mode,
    knownIds,
    started: false,
    settled: false
  };

  await chrome.runtime.sendMessage({
    type: "IMPORT_STATE_UPDATE",
    state: {
      status: "running",
      mode,
      message: mode === "recent" ? "Refreshing recent likes via X API..." : "Importing archive via X API..."
    }
  } satisfies RuntimeMessage);

  window.postMessage(
    {
      source: CONTENT_SOURCE,
      type: "XLS_START_NETWORK_IMPORT",
      mode,
      knownIds
    },
    "*"
  );
}

function handleBridgeMessage(event: MessageEvent) {
  if (event.source !== window) {
    return;
  }

  const data = event.data as
    | {
        source?: string;
        type?: string;
        mode?: "full" | "recent";
        tweets?: LikedTweet[];
        checkpoint?: {
          seenCount: number;
          idleCycles: number;
          scrolls: number;
          lastTweetId?: string;
          lastCapturedAt?: string;
        };
        message?: string;
        metrics?: { batchSize: number; waitMs: number; happenedAt: string };
        error?: string;
      }
    | undefined;

  if (data?.source !== BRIDGE_SOURCE || !data.type) {
    return;
  }

  if (data.type === "XLS_NETWORK_IMPORT_STARTED") {
    if (pendingNetworkFallback) {
      pendingNetworkFallback.started = true;
    }
    void chrome.runtime.sendMessage({
      type: "IMPORT_STATE_UPDATE",
      state: {
        status: "running",
        mode: data.mode ?? "full",
        message:
          data.mode === "recent" ? "Refreshing recent likes via X API..." : "Importing archive via X API..."
      }
    } satisfies RuntimeMessage);
    return;
  }

  if (data.type === "XLS_NETWORK_IMPORT_BATCH" && data.tweets && data.checkpoint && data.metrics) {
    void chrome.runtime.sendMessage({
      type: "IMPORT_BATCH",
      tweets: data.tweets,
      checkpoint: data.checkpoint,
      message: data.message ?? "Imported likes from X API.",
      metrics: data.metrics
    } satisfies RuntimeMessage);
    return;
  }

  if (data.type === "XLS_NETWORK_IMPORT_DONE" && data.checkpoint) {
    if (pendingNetworkFallback) {
      pendingNetworkFallback.settled = true;
      pendingNetworkFallback = null;
    }
    void chrome.runtime.sendMessage({
      type: "IMPORT_STATE_UPDATE",
      state: {
        status: "completed",
        mode: data.mode ?? "full",
        checkpoint: data.checkpoint,
        message: data.message ?? "Network import completed."
      }
    } satisfies RuntimeMessage);
    return;
  }

  if (data.type === "XLS_NETWORK_IMPORT_ERROR") {
    const fallback = pendingNetworkFallback;
    if (fallback && !fallback.started && !fallback.settled) {
      fallback.settled = true;
      pendingNetworkFallback = null;
      void runAutoImport(fallback.mode, fallback.knownIds);
      return;
    }

    if (pendingNetworkFallback) {
      pendingNetworkFallback.settled = true;
      pendingNetworkFallback = null;
    }

    void chrome.runtime.sendMessage({
      type: "IMPORT_STATE_UPDATE",
      state: {
        status: "error",
        message: data.error ?? "Network import failed.",
        error: data.error ?? "Network import failed."
      }
    } satisfies RuntimeMessage);
  }
}

function injectPageBridge() {
  if (bridgeInjected || document.getElementById(BRIDGE_SCRIPT_ID)) {
    return;
  }

  const script = document.createElement("script");
  script.id = BRIDGE_SCRIPT_ID;
  script.src = chrome.runtime.getURL("assets/pageBridge.js");
  script.type = "module";
  script.async = false;
  (document.documentElement || document.head || document.body).appendChild(script);
  bridgeInjected = true;
}

async function runAutoImport(mode: "full" | "recent", knownIds: string[]): Promise<void> {
  if (autoImportRunning) {
    return;
  }

  autoImportRunning = true;
  const controller = createImportControllerState({
    seenIds: new Set<string>(knownIds)
  });
  let lastWaitMs = 0;
  const maxIdleCycles = mode === "recent" ? RECENT_SYNC_IDLE_CYCLES : 8;

  await chrome.runtime.sendMessage({
    type: "IMPORT_STATE_UPDATE",
    state: {
      status: "running",
      mode,
      message: mode === "recent" ? "Refreshing recent likes..." : "Scanning visible likes..."
    }
  } satisfies RuntimeMessage);

  while (autoImportRunning) {
    const visible = extractVisibleLikedTweets();
    const step = advanceImportController(controller, visible, new Date().toISOString(), maxIdleCycles);
    if (step.freshTweets.length > 0) {
      await chrome.runtime.sendMessage({
        type: "IMPORT_BATCH",
        tweets: step.freshTweets,
        checkpoint: step.checkpoint,
        message:
          mode === "recent"
            ? `Refreshed ${step.freshTweets.length} recent likes.`
            : `Imported ${step.checkpoint.seenCount} likes so far.`,
        metrics: {
          batchSize: step.freshTweets.length,
          waitMs: lastWaitMs,
          happenedAt: new Date().toISOString()
        }
      } satisfies RuntimeMessage);
    } else {
      await chrome.runtime.sendMessage({
        type: "IMPORT_STATE_UPDATE",
        state: {
          status: "running",
          mode,
          checkpoint: step.checkpoint,
          message: `No new likes detected. Retrying ${step.checkpoint.idleCycles}/${maxIdleCycles}.`
        }
      } satisfies RuntimeMessage);
    }

    if (step.status === "completed") {
      break;
    }

    lastWaitMs = await fastForwardFeed();
    registerScroll(controller);
  }

  const status = autoImportRunning ? "completed" : "paused";
  autoImportRunning = false;

  await chrome.runtime.sendMessage({
    type: "IMPORT_STATE_UPDATE",
    state: {
      status,
      checkpoint: createCheckpoint(controller),
      message:
        status === "completed"
          ? mode === "recent"
            ? "Recent sync finished after repeated content was detected."
            : "Import finished after repeated content was detected."
          : "Import paused."
    }
  } satisfies RuntimeMessage);
}

async function fastForwardFeed() {
  let stalledRetries = 0;
  const startedAt = performance.now();

  for (let burst = 0; burst < SCROLL_BURSTS; burst += 1) {
    const beforeCount = document.querySelectorAll('article[data-testid="tweet"]').length;
    const beforeHeight = document.documentElement.scrollHeight;
    const beforeOffset = window.scrollY + window.innerHeight;

    window.scrollTo(0, beforeHeight);

    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));

    const changed = await waitForFeed(beforeCount, beforeHeight);
    if (changed) {
      return Math.round(performance.now() - startedAt);
    }

    const afterOffset = window.scrollY + window.innerHeight;
    if (afterOffset >= beforeHeight - 8) {
      stalledRetries += 1;
      if (stalledRetries >= MAX_STALLED_BOTTOM_RETRIES) {
        break;
      }
    } else if (afterOffset > beforeOffset) {
      stalledRetries = 0;
    }
  }

  return Math.round(performance.now() - startedAt);
}

async function waitForFeed(beforeCount: number, beforeHeight: number) {
  return new Promise<boolean>((resolve) => {
    const startedAt = Date.now();
    const observer = new MutationObserver(() => {
      const currentCount = document.querySelectorAll('article[data-testid="tweet"]').length;
      const currentHeight = document.documentElement.scrollHeight;
      if (currentCount > beforeCount || currentHeight > beforeHeight) {
        observer.disconnect();
        resolve(true);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    const timer = window.setInterval(() => {
      const currentCount = document.querySelectorAll('article[data-testid="tweet"]').length;
      const currentHeight = document.documentElement.scrollHeight;

      if (currentCount > beforeCount || currentHeight > beforeHeight) {
        observer.disconnect();
        window.clearInterval(timer);
        resolve(true);
        return;
      }

      if (Date.now() - startedAt >= FEED_WAIT_TIMEOUT_MS) {
        observer.disconnect();
        window.clearInterval(timer);
        resolve(false);
      }
    }, 50);
  });
}

interface ImportCheckpointLocal {
  lastTweetId?: string;
  lastCapturedAt?: string;
  seenCount: number;
  idleCycles: number;
  scrolls: number;
}

interface ImportControllerStateLocal {
  seenIds: Set<string>;
  idleCycles: number;
  scrolls: number;
  lastTweetId?: string;
}

interface ImportStepResultLocal {
  freshTweets: LikedTweet[];
  checkpoint: ImportCheckpointLocal;
  status: "running" | "completed";
}

const CATEGORY_RULES: Record<TweetCategory, string[]> = {
  rag: ["rag", "retrieval", "vector", "embedding", "embeddings", "retriever", "knowledge base", "semantic search"],
  "fine-tuning": ["fine-tuning", "finetuning", "fine tuning", "sft", "lora", "qlora", "dpo", "alignment"],
  agents: ["agent", "agents", "tool use", "tool calling", "tool-calling", "multi-agent", "workflow", "browser use"],
  evals: ["eval", "evals", "evaluation", "benchmark", "judge", "grading", "test set", "leaderboard"],
  infra: ["latency", "gpu", "cuda", "serving", "inference", "throughput", "database", "webgpu", "onnx", "wasm"],
  product: ["growth", "pricing", "market", "launch", "distribution", "saas", "retention", "onboarding"],
  design: ["design", "ux", "ui", "prototype", "layout", "visual", "interaction", "typography"],
  uncategorized: []
};

function createImportControllerState(seed?: Partial<ImportControllerStateLocal>): ImportControllerStateLocal {
  return {
    seenIds: seed?.seenIds ?? new Set<string>(),
    idleCycles: seed?.idleCycles ?? 0,
    scrolls: seed?.scrolls ?? 0,
    lastTweetId: seed?.lastTweetId
  };
}

function advanceImportController(
  state: ImportControllerStateLocal,
  visibleTweets: LikedTweet[],
  capturedAt = new Date().toISOString(),
  maxIdleCycles = DEFAULT_MAX_IDLE_CYCLES
): ImportStepResultLocal {
  const freshTweets: LikedTweet[] = [];

  for (const tweet of visibleTweets) {
    if (state.seenIds.has(tweet.id)) {
      continue;
    }

    state.seenIds.add(tweet.id);
    freshTweets.push(tweet);
  }

  if (freshTweets.length > 0) {
    state.lastTweetId = freshTweets[freshTweets.length - 1]?.id ?? state.lastTweetId;
    state.idleCycles = 0;
  } else {
    state.idleCycles += 1;
  }

  const checkpoint = createCheckpoint(state, capturedAt);
  const status = state.idleCycles >= maxIdleCycles ? "completed" : "running";
  return { freshTweets, checkpoint, status };
}

function registerScroll(state: ImportControllerStateLocal) {
  state.scrolls += 1;
}

function createCheckpoint(state: ImportControllerStateLocal, capturedAt = new Date().toISOString()): ImportCheckpointLocal {
  return {
    lastTweetId: state.lastTweetId,
    lastCapturedAt: capturedAt,
    seenCount: state.seenIds.size,
    idleCycles: state.idleCycles,
    scrolls: state.scrolls
  };
}

function extractVisibleLikedTweets(root: ParentNode = document): LikedTweet[] {
  const articles = Array.from(root.querySelectorAll<HTMLElement>('article[data-testid="tweet"]'));
  return articles.map((article) => parseTweetArticle(article)).filter((tweet): tweet is LikedTweet => tweet !== null);
}

function parseTweetArticle(article: HTMLElement): LikedTweet | null {
  const primaryStatusLink = getPrimaryStatusLink(article);
  if (!primaryStatusLink) {
    return null;
  }

  const tweetId = extractStatusId(primaryStatusLink.href);
  if (!tweetId) {
    return null;
  }

  const quotedTweet = extractQuotedTweet(article);
  const mainText = getPrimaryTweetText(article);
  const author = extractAuthor(article, primaryStatusLink);
  const media = extractMedia(article);
  const createdAt = article.querySelector<HTMLTimeElement>("time")?.dateTime;
  const socialContext = extractSocialContext(article);

  if (!mainText) {
    return null;
  }

  const originalTweet: TweetEntity = {
    id: tweetId,
    text: mainText,
    authorName: author.name,
    authorHandle: author.handle,
    createdAt,
    url: primaryStatusLink.href,
    media
  };

  return {
    id: tweetId,
    canonicalId: quotedTweet?.id ?? tweetId,
    text: mainText,
    authorName: author.name,
    authorHandle: author.handle,
    createdAt,
    url: primaryStatusLink.href,
    media,
    originalTweet,
    quotedTweet,
    socialContext,
    categories: categorizeText([mainText, quotedTweet?.text ?? "", socialContext.label ?? ""].join("\n")),
    keywords: extractKeywords([mainText, quotedTweet?.text ?? ""].join(" ")),
    capturedAt: new Date().toISOString()
  };
}

function categorizeText(text: string): TweetCategory[] {
  const normalized = text.toLowerCase();
  const categories = Object.entries(CATEGORY_RULES)
    .filter(([category, terms]) => category !== "uncategorized" && terms.some((term) => normalized.includes(term)))
    .map(([category]) => category as TweetCategory);
  return categories.length > 0 ? categories : ["uncategorized"];
}

function extractKeywords(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, " ")
        .split(/[^a-z0-9+#.-]+/i)
        .filter((token) => token.length >= 3)
    )
  );
}

function getPrimaryStatusLink(article: HTMLElement): HTMLAnchorElement | null {
  const quoteNode = article.querySelector<HTMLElement>('[data-testid="quoteTweet"]');
  return (
    Array.from(article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]')).find(
      (link) => !quoteNode?.contains(link)
    ) ?? null
  );
}

function getPrimaryTweetText(article: HTMLElement): string {
  const quoteNode = article.querySelector<HTMLElement>('[data-testid="quoteTweet"]');
  const textNodes = Array.from(article.querySelectorAll<HTMLElement>('[data-testid="tweetText"]')).filter(
    (node) => !quoteNode?.contains(node)
  );
  return normalizeText(textNodes.map(getNodeText).find(Boolean) ?? getNodeText(article));
}

function extractQuotedTweet(article: HTMLElement): TweetEntity | undefined {
  const quote = article.querySelector<HTMLElement>('[data-testid="quoteTweet"]');
  if (!quote) {
    return undefined;
  }

  const link = quote.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
  const id = link ? extractStatusId(link.href) : null;
  const textNode = quote.querySelector<HTMLElement>('[data-testid="tweetText"]');
  const text = normalizeText(textNode ? getNodeText(textNode) : getNodeText(quote));
  if (!id || !text) {
    return undefined;
  }

  const author = extractAuthor(quote, link ?? undefined);
  return {
    id,
    text,
    authorName: author.name,
    authorHandle: author.handle,
    createdAt: quote.querySelector<HTMLTimeElement>("time")?.dateTime,
    url: link?.href ?? "",
    media: extractMedia(quote)
  };
}

function extractAuthor(container: ParentNode, statusLink?: HTMLAnchorElement | null): { name: string; handle: string } {
  const pathname = statusLink ? new URL(statusLink.href).pathname : "";
  const statusHandle = pathname.split("/").filter(Boolean)[0];
  const profileLinks = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href]')).filter((link) => {
    try {
      const url = new URL(link.href);
      return /^\/[A-Za-z0-9_]+$/.test(url.pathname);
    } catch {
      return false;
    }
  });

  const exactHandleLink =
    profileLinks.find((link) => new URL(link.href).pathname.replace("/", "") === statusHandle) ?? profileLinks[0];
  const handle = exactHandleLink
    ? new URL(exactHandleLink.href).pathname.replace("/", "")
    : statusHandle || "unknown";
  const textCandidates = profileLinks
    .map((link) => normalizeText(getNodeText(link)))
    .filter(Boolean)
    .filter((value) => value !== `@${handle}` && value !== handle);

  return {
    name: textCandidates[0] ?? handle,
    handle
  };
}

function extractSocialContext(article: HTMLElement): TweetSocialContext {
  const contextNode = Array.from(article.querySelectorAll<HTMLElement>('[data-testid], span, div'))
    .map((node) => normalizeText(getNodeText(node)))
    .find((text) => /reposted|retweeted/i.test(text));

  if (contextNode) {
    return { type: "reposted", label: contextNode };
  }

  if (article.querySelector('[data-testid="quoteTweet"]')) {
    return { type: "quoted", label: "Quoted tweet" };
  }

  return { type: "liked", label: "Liked tweet" };
}

function extractMedia(container: ParentNode): string[] {
  return Array.from(container.querySelectorAll<HTMLImageElement>("img"))
    .map((image) => image.src)
    .filter((src) => src && !src.includes("profile_images"));
}

function extractStatusId(url: string): string | null {
  return url.match(/status\/(\d+)/)?.[1] ?? null;
}

function getNodeText(node: Element): string {
  return "innerText" in node && typeof node.innerText === "string" && node.innerText
    ? node.innerText
    : node.textContent ?? "";
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
