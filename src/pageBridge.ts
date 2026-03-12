import { parseLikesTimelineResponse } from "./lib/xApiParser";

const BRIDGE_SOURCE = "x-like-search-bridge";
const CONTENT_SOURCE = "x-like-search-content";
const PENDING_IMPORT_KEY = "xls-pending-network-import";

type ImportMode = "full" | "recent";

interface ImportTemplate {
  url: string;
  init?: RequestInit;
}

interface PendingImportIntent {
  mode: ImportMode;
  knownIds: string[];
  reloadAttempted?: boolean;
}

const nativeFetch = window.fetch.bind(window);
const NativeXHR = window.XMLHttpRequest;
let activeTemplate: ImportTemplate | null = null;
let latestPage: ReturnType<typeof parseLikesTimelineResponse> | null = null;
let running = false;
let stopRequested = false;

resumePendingImport();

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const response = await nativeFetch(input, init);

  try {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    await inspectGraphqlResponse(url, init, response);
  } catch {
    // ignore bridge errors
  }

  return response;
};

class InterceptedXHR extends NativeXHR {
  trackedUrl: string | null = null;
  trackedMethod = "GET";
  trackedHeaders = new Headers();

  open(method: string, url: string | URL, async?: boolean, username?: string | null, password?: string | null): void {
    this.trackedMethod = method;
    this.trackedUrl = typeof url === "string" ? url : url.toString();
    super.open(method, url, async ?? true, username ?? undefined, password ?? undefined);
  }

  setRequestHeader(name: string, value: string): void {
    this.trackedHeaders.set(name, value);
    super.setRequestHeader(name, value);
  }

  send(body?: Document | XMLHttpRequestBodyInit | null): void {
    this.addEventListener("load", () => {
      void inspectXhrResponse(this).catch(() => undefined);
    });
    super.send(body);
  }
}

window.XMLHttpRequest = InterceptedXHR as typeof XMLHttpRequest;

window.addEventListener("message", (event) => {
  if (event.source !== window) {
    return;
  }

  const data = event.data as
    | { source?: string; type?: string; mode?: ImportMode; knownIds?: string[] }
    | undefined;

  if (data?.source !== CONTENT_SOURCE) {
    return;
  }

  if (data.type === "XLS_START_NETWORK_IMPORT") {
    setPendingImportIntent({
      mode: data.mode ?? "full",
      knownIds: data.knownIds ?? []
    });
    void startNetworkImport(data.mode ?? "full", data.knownIds ?? []);
  }

  if (data.type === "XLS_STOP_NETWORK_IMPORT") {
    stopRequested = true;
    clearPendingImportIntent();
  }
});

async function inspectGraphqlResponse(url: string, init: RequestInit | undefined, response: Response) {
  if (!url.includes("/graphql/")) {
    return;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return;
  }

  const cloned = response.clone();
  const payload = await cloned.json();
  const parsed = parseLikesTimelineResponse(payload);
  if (!parsed || (parsed.tweets.length === 0 && !parsed.bottomCursor)) {
    return;
  }

  activeTemplate = {
    url,
    init: init ? cloneInit(init) : undefined
  };
  latestPage = parsed;
  postToContent({
    type: "XLS_NETWORK_TEMPLATE_READY",
    tweetCount: parsed.tweets.length,
    hasCursor: Boolean(parsed.bottomCursor)
  });
}

async function inspectXhrResponse(xhr: InterceptedXHR) {
  const url = xhr.responseURL || xhr.trackedUrl;
  if (!url || !url.includes("/graphql/")) {
    return;
  }

  const contentType = xhr.getResponseHeader("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return;
  }

  const responseText = typeof xhr.responseText === "string" ? xhr.responseText : "";
  if (!responseText) {
    return;
  }

  const payload = JSON.parse(responseText);
  const parsed = parseLikesTimelineResponse(payload);
  if (!parsed || (parsed.tweets.length === 0 && !parsed.bottomCursor)) {
    return;
  }

  activeTemplate = {
    url,
    init: {
      method: xhr.trackedMethod ?? "GET",
      credentials: "include",
      headers: new Headers(xhr.trackedHeaders ?? undefined)
    }
  };
  latestPage = parsed;
  postToContent({
    type: "XLS_NETWORK_TEMPLATE_READY",
    tweetCount: parsed.tweets.length,
    hasCursor: Boolean(parsed.bottomCursor)
  });
}

async function startNetworkImport(mode: ImportMode, knownIds: string[]) {
  if (running) {
    return;
  }

  running = true;
  stopRequested = false;

  try {
    let template = await waitForTemplate();
    if (!template) {
      const pending = getPendingImportIntent();
      if (pending && !pending.reloadAttempted) {
        setPendingImportIntent({
          ...pending,
          reloadAttempted: true
        });
        window.location.reload();
        return;
      }
    }

    if (!template) {
      throw new Error("Could not capture X likes timeline request.");
    }

    const seenIds = new Set(knownIds);
    const seenCursors = new Set<string>();
    const maxIdlePages = mode === "recent" ? 2 : 6;
    let idlePages = 0;
    let requests = 0;
    let lastTweetId: string | undefined;

    postToContent({
      type: "XLS_NETWORK_IMPORT_STARTED",
      mode
    });

    let page = latestPage;
    let cursor = page?.bottomCursor;

    while (!stopRequested && page) {
      requests += 1;
      const freshTweets = page.tweets.filter((tweet) => {
        if (seenIds.has(tweet.id)) {
          return false;
        }
        seenIds.add(tweet.id);
        lastTweetId = tweet.id;
        return true;
      });

      if (freshTweets.length > 0) {
        idlePages = 0;
        postToContent({
          type: "XLS_NETWORK_IMPORT_BATCH",
          mode,
          tweets: freshTweets,
          checkpoint: {
            seenCount: seenIds.size,
            idleCycles: idlePages,
            scrolls: requests,
            lastTweetId,
            lastCapturedAt: new Date().toISOString()
          },
          message:
            mode === "recent"
              ? `Fetched ${freshTweets.length} recent likes from X API.`
              : `Fetched ${seenIds.size} likes from X API.`,
          metrics: {
            batchSize: freshTweets.length,
            waitMs: 0,
            happenedAt: new Date().toISOString()
          }
        });
      } else {
        idlePages += 1;
      }

      if (!cursor || seenCursors.has(cursor) || idlePages >= maxIdlePages) {
        break;
      }

      seenCursors.add(cursor);
      page = await fetchNextPage(template, cursor);
      cursor = page?.bottomCursor;
    }

    postToContent({
      type: "XLS_NETWORK_IMPORT_DONE",
      mode,
      checkpoint: {
        seenCount: seenIds.size,
        idleCycles: idlePages,
        scrolls: requests,
        lastTweetId,
        lastCapturedAt: new Date().toISOString()
      },
      message:
        mode === "recent"
          ? "Recent sync finished via X network timeline."
          : "Archive import finished via X network timeline."
    });
    clearPendingImportIntent();
  } catch (error) {
    clearPendingImportIntent();
    postToContent({
      type: "XLS_NETWORK_IMPORT_ERROR",
      error: error instanceof Error ? error.message : "Network import failed."
    });
  } finally {
    running = false;
    stopRequested = false;
  }
}

async function waitForTemplate(timeoutMs = 8000): Promise<ImportTemplate | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (activeTemplate) {
      return activeTemplate;
    }

    await new Promise((resolve) => window.setTimeout(resolve, 120));
  }

  return null;
}

async function fetchNextPage(template: ImportTemplate, cursor: string) {
  const url = withCursor(template.url, cursor);
  const response = await nativeFetch(url, template.init);
  const payload = await response.json();
  return parseLikesTimelineResponse(payload);
}

function withCursor(rawUrl: string, cursor: string): string {
  const url = new URL(rawUrl, window.location.origin);
  const variables = safeJsonParse<Record<string, unknown>>(url.searchParams.get("variables")) ?? {};
  variables.cursor = cursor;
  url.searchParams.set("variables", JSON.stringify(variables));
  return url.toString();
}

function cloneInit(init: RequestInit): RequestInit {
  const cloned: RequestInit = {
    method: init.method,
    credentials: init.credentials,
    mode: init.mode,
    cache: init.cache,
    redirect: init.redirect,
    referrer: init.referrer,
    referrerPolicy: init.referrerPolicy,
    integrity: init.integrity,
    keepalive: init.keepalive
  };

  if (init.headers) {
    cloned.headers = new Headers(init.headers);
  }

  return cloned;
}

function safeJsonParse<T>(value: string | null): T | null {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function postToContent(message: Record<string, unknown>) {
  window.postMessage({
    source: BRIDGE_SOURCE,
    ...message
  }, "*");
}

function getPendingImportIntent(): PendingImportIntent | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_IMPORT_KEY);
    return raw ? (JSON.parse(raw) as PendingImportIntent) : null;
  } catch {
    return null;
  }
}

function setPendingImportIntent(intent: PendingImportIntent) {
  window.sessionStorage.setItem(PENDING_IMPORT_KEY, JSON.stringify(intent));
}

function clearPendingImportIntent() {
  window.sessionStorage.removeItem(PENDING_IMPORT_KEY);
}

function resumePendingImport() {
  const pending = getPendingImportIntent();
  if (!pending) {
    return;
  }

  window.setTimeout(() => {
    void startNetworkImport(pending.mode, pending.knownIds);
  }, 0);
}
