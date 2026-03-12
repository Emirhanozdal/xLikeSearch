import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, ChevronUp, Download, Pause, Play, RefreshCcw, Search, Twitter } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Input } from "../components/ui/input";
import type {
  ImportJobState,
  ImportTelemetry,
  LikedTweet,
  SearchResult,
  SemanticIndexState,
  StateSnapshot,
  StorageMode,
  StorageStats,
  SyncContext,
  TweetCategory
} from "../types";
import { parseSearchQuery } from "../lib/search";

const CATEGORY_OPTIONS: TweetCategory[] = [
  "rag",
  "fine-tuning",
  "agents",
  "evals",
  "infra",
  "product",
  "business",
  "marketing",
  "finance",
  "career",
  "writing",
  "health",
  "design",
  "uncategorized"
];

interface SavedView {
  id: string;
  name: string;
  query: string;
  categories: TweetCategory[];
}

const PRESET_QUERIES: Array<{ label: string; query: string; categories: TweetCategory[] }> = [
  { label: "Career", query: "career", categories: ["career"] },
  { label: "Finance", query: "finance", categories: ["finance"] },
  { label: "Health", query: "health", categories: ["health"] },
  { label: "Writing", query: "writing", categories: ["writing"] },
  { label: "Design", query: "design", categories: ["design"] },
  { label: "Product", query: "product", categories: ["product"] }
];

type SemanticModule = typeof import("../lib/semantic");
let semanticModulePromise: Promise<SemanticModule> | null = null;

async function getSemanticModule(): Promise<SemanticModule> {
  if (!semanticModulePromise) {
    semanticModulePromise = import("../lib/semantic");
  }

  return semanticModulePromise;
}

async function runtimeRequest<T>(message: object): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

const DEFAULT_IMPORT_STATE: ImportJobState = {
  status: "idle",
  mode: "full",
  updatedAt: new Date().toISOString(),
  importedCount: 0,
  newCount: 0,
  checkpoint: {
    seenCount: 0,
    idleCycles: 0,
    scrolls: 0
  },
  message: "Import has not started yet."
};

const DEFAULT_STORAGE_STATS: StorageStats = {
  totalLikes: 0,
  authors: 0,
  embeddings: 0,
  indexedTweets: 0,
  approxBytes: 0,
  mode: "compact"
};

const DEFAULT_TELEMETRY: ImportTelemetry = {
  elapsedMs: 0,
  batches: 0,
  avgBatchSize: 0,
  likesPerMinute: 0,
  lastBatchSize: 0,
  waitMs: 0,
  waitEvents: 0,
  avgWaitMs: 0
};

type SortOption = "relevance" | "newest" | "oldest" | "captured-newest" | "captured-oldest" | "author";
const SORT_STORAGE_KEY = "x-like-search-sort";
const SAVED_VIEWS_STORAGE_KEY = "x-like-search-saved-views";

export function App() {
  const [tweets, setTweets] = useState<LikedTweet[]>([]);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [query, setQuery] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<TweetCategory[]>([]);
  const [syncContext, setSyncContext] = useState<SyncContext | null>(null);
  const [semanticState, setSemanticState] = useState<SemanticIndexState>({
    model: "Xenova/all-MiniLM-L6-v2",
    totalTweets: 0,
    indexedTweets: 0,
    pendingTweets: 0,
    ready: false,
    device: "wasm"
  });
  const [isSearching, setIsSearching] = useState(false);
  const [importState, setImportState] = useState<ImportJobState>(DEFAULT_IMPORT_STATE);
  const [storageStats, setStorageStats] = useState<StorageStats>(DEFAULT_STORAGE_STATS);
  const [telemetry, setTelemetry] = useState<ImportTelemetry>(DEFAULT_TELEMETRY);
  const [status, setStatus] = useState("Open your X likes page, then sync visible tweets.");
  const [sortBy, setSortBy] = useState<SortOption>(() => {
    const stored = window.localStorage.getItem(SORT_STORAGE_KEY) as SortOption | null;
    return stored ?? "relevance";
  });
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [askQuery, setAskQuery] = useState("");
  const [askAnswer, setAskAnswer] = useState("");
  const [askCitations, setAskCitations] = useState<SearchResult[]>([]);
  const [isAsking, setIsAsking] = useState(false);
  const [askAnswerSource, setAskAnswerSource] = useState<"model" | "fallback" | null>(null);
  const [savedViews, setSavedViews] = useState<SavedView[]>(() => {
    const stored = window.localStorage.getItem(SAVED_VIEWS_STORAGE_KEY);
    return stored ? (JSON.parse(stored) as SavedView[]) : [];
  });
  const autoSyncStartedRef = useRef(false);
  const importHeadline = useMemo(
    () => buildImportHeadline(importState, semanticState, storageStats.totalLikes),
    [importState, semanticState, storageStats.totalLikes]
  );

  useEffect(() => {
    void loadLikes();
    void loadSyncContext();
    void loadStateSnapshot();

    const listener = (message: unknown) => {
      const runtimeMessage = message as { type?: string; snapshot?: StateSnapshot };
      if (runtimeMessage.type !== "STATE_SNAPSHOT" || !runtimeMessage.snapshot) {
        return;
      }

      hydrateSnapshot(runtimeMessage.snapshot);
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, []);

  const visibleTweets = useMemo(() => {
    if (!query.trim() && selectedCategories.length === 0) {
      return tweets.map((tweet) => ({ ...tweet, score: 1, lexicalScore: 0, semanticScore: 0 }));
    }

    return results;
  }, [query, results, selectedCategories, tweets]);

  const sortedTweets = useMemo(() => sortResults(visibleTweets, sortBy), [sortBy, visibleTweets]);

  const stats = useMemo(() => {
    const categoryCounts = new Map<TweetCategory, number>();
    for (const tweet of tweets) {
      for (const category of tweet.categories) {
        categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
      }
    }

    return {
      total: tweets.length,
      filtered: visibleTweets.length,
      topCategories: Array.from(categoryCounts.entries())
        .sort((left, right) => right[1] - left[1])
        .slice(0, 6)
    };
  }, [tweets, visibleTweets]);

  useEffect(() => {
    window.localStorage.setItem(SORT_STORAGE_KEY, sortBy);
  }, [sortBy]);

  useEffect(() => {
    window.localStorage.setItem(SAVED_VIEWS_STORAGE_KEY, JSON.stringify(savedViews));
  }, [savedViews]);

  function hydrateSnapshot(snapshot: StateSnapshot) {
    if (snapshot.importState) {
      setImportState(snapshot.importState);
    }

    if (snapshot.storageStats) {
      setStorageStats(snapshot.storageStats);
    }

    if (snapshot.telemetry) {
      setTelemetry(snapshot.telemetry);
    }
  }

  async function loadStateSnapshot() {
    const response = await runtimeRequest<{ ok: boolean; snapshot: StateSnapshot; error?: string }>({
      type: "GET_STATE_SNAPSHOT"
    });

    if (!response.ok) {
      return;
    }

    hydrateSnapshot(response.snapshot);
  }

  async function loadLikes() {
    const response = await runtimeRequest<{ ok: boolean; tweets: LikedTweet[]; error?: string }>({
      type: "GET_LIKES"
    });

    if (!response.ok) {
      setStatus(response.error ?? "Failed to load likes.");
      return;
    }

    setTweets(response.tweets);
    setResults(response.tweets.map((tweet) => ({ ...tweet, score: 1 })));
    if (response.tweets.length > 0) {
      void warmSemanticIndex(response.tweets);
    }
  }

  async function loadSyncContext() {
    const response = await runtimeRequest<{ ok: boolean; context: SyncContext; error?: string }>({
      type: "GET_SYNC_CONTEXT"
    });

    if (!response.ok) {
      setStatus(response.error ?? "Failed to read active tab.");
      return;
    }

    setSyncContext(response.context);
  }

  async function syncVisibleLikes() {
    setStatus("Syncing visible liked tweets...");
    const response = await runtimeRequest<{ ok: boolean; count?: number; total?: number; error?: string }>({
      type: "SYNC_VISIBLE_LIKES"
    });

    if (!response.ok) {
      setStatus(response.error ?? "Sync failed.");
      return;
    }

    setStatus(`Captured ${response.count ?? 0} tweets. Archive size: ${response.total ?? 0}.`);
    await loadLikes();
    await loadSyncContext();
    await loadStateSnapshot();
  }

  async function startAutoImport() {
    setStatus("Starting background archive import...");
    const response = await runtimeRequest<{ ok: boolean; error?: string }>({
      type: "START_AUTO_IMPORT",
      mode: "full"
    });

    if (!response.ok) {
      setStatus(response.error ?? "Failed to start import.");
      return;
    }

    await loadStateSnapshot();
    setStatus("Archive import running in the background.");
  }

  async function refreshRecentLikes() {
    setStatus("Refreshing recent likes...");
    const response = await runtimeRequest<{ ok: boolean; error?: string }>({
      type: "START_AUTO_IMPORT",
      mode: "recent"
    });

    if (!response.ok) {
      setStatus(response.error ?? "Failed to refresh recent likes.");
      return;
    }

    await loadStateSnapshot();
    setStatus("Recent sync running in the background.");
  }

  async function stopAutoImport() {
    const response = await runtimeRequest<{ ok: boolean; state?: ImportJobState; error?: string }>({
      type: "STOP_AUTO_IMPORT"
    });

    if (!response.ok) {
      setStatus(response.error ?? "Failed to stop import.");
      return;
    }

    if (response.state) {
      setImportState(response.state);
    }
    await loadStateSnapshot();
    setStatus("Import paused.");
  }

  async function setStorageMode(mode: StorageMode) {
    const response = await runtimeRequest<{
      ok: boolean;
      stats: StorageStats;
      error?: string;
    }>({
      type: "SET_STORAGE_MODE",
      mode
    });

    if (!response.ok) {
      setStatus(response.error ?? "Failed to update storage mode.");
      return;
    }

    setStorageStats(response.stats);
    setStatus(`Storage mode set to ${mode}.`);
    await loadLikes();
  }

  async function warmSemanticIndex(input: LikedTweet[]) {
    try {
      const semantic = await getSemanticModule();
      const nextState = await semantic.warmSemanticQueue(input, (state) => {
        setSemanticState(state);
        setStatus(`Semantic queue: ${state.indexedTweets} indexed, ${state.pendingTweets} pending.`);
      });

      setSemanticState(nextState);
      setStatus((current) =>
        current.startsWith("Semantic queue:") ? `Semantic ready on ${nextState.device}.` : current
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Semantic index failed.";
      setStatus(message);
    }
  }

  async function search() {
    setIsSearching(true);

    try {
      const semantic = await getSemanticModule();
      const parsedQuery = parseSearchQuery(query, selectedCategories);
      const { results: nextResults, semanticState: nextState } = await semantic.hybridSearchLikes(tweets, parsedQuery);
      setResults(nextResults);
      setSemanticState(nextState);
      setStatus(
        parsedQuery.text.trim() || (parsedQuery.authorHandles?.length ?? 0) > 0 || parsedQuery.dateFrom || parsedQuery.dateTo
          ? `${nextResults.length} results ranked.`
          : `${nextResults.length} items available.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Search failed.";
      setStatus(message);
    } finally {
      setIsSearching(false);
    }
  }

  async function askArchive() {
    const normalized = askQuery.trim();
    if (!normalized) {
      setAskAnswer("");
      setAskCitations([]);
      return;
    }

    setIsAsking(true);
    try {
      const semantic = await getSemanticModule();
      const parsedQuery = parseSearchQuery(askQuery, selectedCategories);
      const { answer, citations, semanticState: nextState, answerSource } = await semantic.askLikes(tweets, {
        text: parsedQuery.text || normalized,
        categories: parsedQuery.categories,
        authorHandles: parsedQuery.authorHandles,
        dateFrom: parsedQuery.dateFrom,
        dateTo: parsedQuery.dateTo
      });
      setSemanticState(nextState);
      setAskAnswer(answer);
      setAskCitations(citations);
      setAskAnswerSource(answerSource);
      setStatus(`Answered from ${citations.length} retrieved likes.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Ask mode failed.";
      setAskAnswer(message);
      setAskCitations([]);
      setAskAnswerSource(null);
      setStatus(message);
    } finally {
      setIsAsking(false);
    }
  }

  useEffect(() => {
    if (tweets.length === 0 && selectedCategories.length === 0 && !query.trim()) {
      return;
    }

    const timer = window.setTimeout(() => {
      void search();
    }, query.trim() ? 220 : 0);

    return () => window.clearTimeout(timer);
  }, [query, selectedCategories, tweets]);

  useEffect(() => {
    if (autoSyncStartedRef.current) {
      return;
    }

    if (!syncContext?.isLikesPage) {
      return;
    }

    if (importState.status === "running") {
      return;
    }

    autoSyncStartedRef.current = true;
    void syncVisibleLikes();
  }, [importState.status, syncContext?.isLikesPage]);

  function toggleCategory(category: TweetCategory) {
    setSelectedCategories((current) =>
      current.includes(category) ? current.filter((item) => item !== category) : [...current, category]
    );
  }

  function exportTweets(scope: "current" | "full", format: "json" | "csv") {
    const exportSet = scope === "current" ? sortedTweets : sortResults(tweets.map((tweet) => ({ ...tweet, score: 1 })), sortBy);
    const content = format === "json" ? toJsonExport(exportSet) : toCsvExport(exportSet);
    const mime = format === "json" ? "application/json" : "text/csv;charset=utf-8";
    const filename = `x-like-archive-${scope}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${format}`;
    downloadText(content, mime, filename);
    setStatus(`Exported ${exportSet.length} likes as ${format.toUpperCase()}.`);
  }

  function applyPreset(queryValue: string, categories: TweetCategory[]) {
    setQuery(queryValue);
    setSelectedCategories(categories);
  }

  function saveCurrentView() {
    const trimmed = query.trim();
    if (!trimmed && selectedCategories.length === 0) {
      setStatus("Add a query or category before saving a view.");
      return;
    }

    const nextView: SavedView = {
      id: crypto.randomUUID(),
      name: trimmed || selectedCategories.join(", "),
      query: query,
      categories: selectedCategories
    };
    setSavedViews((current) => [nextView, ...current].slice(0, 8));
    setStatus(`Saved view: ${nextView.name}`);
  }

  function loadSavedView(view: SavedView) {
    setQuery(view.query);
    setSelectedCategories(view.categories);
    setStatus(`Loaded saved view: ${view.name}`);
  }

  function removeSavedView(id: string) {
    setSavedViews((current) => current.filter((view) => view.id !== id));
  }

  return (
    <main className="min-h-screen bg-[#f3f4f6] p-3 text-[#111827]">
      <div className="mx-auto flex max-w-4xl flex-col gap-3">
        <section className="rounded-xl border border-[#d1d5db] bg-white">
          <div className="border-b border-[#e5e7eb] px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h1 className="text-sm font-semibold tracking-[0.12em] text-[#374151] uppercase">X Like Archive</h1>
                <p className="mt-1 text-xs text-[#6b7280]">{importHeadline ?? status}</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={syncContext?.isLikesPage ? "accent" : "outline"}>
                  {syncContext?.isLikesPage ? "likes page" : "wrong page"}
                </Badge>
                <Badge
                  variant={
                    importState.status === "running"
                      ? "accent"
                      : importState.status === "completed"
                        ? "secondary"
                        : "outline"
                  }
                >
                  {importState.status}
                </Badge>
              </div>
            </div>
          </div>

          <div className="grid gap-3 px-4 py-3 md:grid-cols-[1.2fr_0.8fr]">
            <div className="space-y-3">
              <div className="grid grid-cols-4 gap-2">
                <MetricTile label="likes" value={storageStats.totalLikes.toString()} />
                <MetricTile label="results" value={stats.filtered.toString()} />
                <MetricTile label="authors" value={storageStats.authors.toString()} />
                <MetricTile label="size" value={formatBytes(storageStats.approxBytes)} />
              </div>

              <div className="rounded-lg border border-[#e5e7eb] bg-[#fafafa] p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    onClick={() => void syncVisibleLikes()}
                    disabled={!syncContext?.isLikesPage}
                    variant="secondary"
                    size="sm"
                  >
                    <RefreshCcw className="h-4 w-4" />
                    Sync visible
                  </Button>
                  <Button onClick={() => void refreshRecentLikes()} variant="secondary" size="sm">
                    <Twitter className="h-4 w-4" />
                    Refresh recent
                  </Button>
                  {importState.status === "running" ? (
                    <Button onClick={() => void stopAutoImport()} size="sm" className="bg-[#111827] hover:bg-[#000]">
                      <Pause className="h-4 w-4" />
                      Pause import
                    </Button>
                  ) : (
                    <Button onClick={() => void startAutoImport()} size="sm" className="bg-[#111827] hover:bg-[#000]">
                      <Play className="h-4 w-4" />
                      Import archive
                    </Button>
                  )}
                  <div className="ml-auto flex gap-2">
                    <Button
                      size="sm"
                      variant={storageStats.mode === "compact" ? "default" : "secondary"}
                      className={storageStats.mode === "compact" ? "bg-[#111827] hover:bg-[#000]" : ""}
                      onClick={() => void setStorageMode("compact")}
                    >
                      Compact
                    </Button>
                    <Button
                      size="sm"
                      variant={storageStats.mode === "deep" ? "default" : "secondary"}
                      className={storageStats.mode === "deep" ? "bg-[#111827] hover:bg-[#000]" : ""}
                      onClick={() => void setStorageMode("deep")}
                    >
                      Deep
                    </Button>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-[#e5e7eb] bg-white">
                <div className="border-b border-[#e5e7eb] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6b7280]">
                  Search
                </div>
                <div className="space-y-3 p-3">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9ca3af]" />
                    <Input
                      className="pl-9"
                      placeholder="keyword, @author, from:2025-01-01, to:2025-12-31"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {PRESET_QUERIES.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        className="rounded-md border border-[#d1d5db] bg-[#f9fafb] px-2.5 py-1 text-xs font-medium text-[#374151] hover:border-[#9ca3af]"
                        onClick={() => applyPreset(preset.query, preset.categories)}
                      >
                        {preset.label}
                      </button>
                    ))}
                    {CATEGORY_OPTIONS.map((category) => (
                      <button
                        key={category}
                        type="button"
                        className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
                          selectedCategories.includes(category)
                            ? "border-[#111827] bg-[#111827] text-white"
                            : "border-[#d1d5db] bg-white text-[#374151] hover:border-[#9ca3af]"
                        }`}
                        onClick={() => toggleCategory(category)}
                      >
                        {category}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-[#e5e7eb] bg-[#fafafa] px-3 py-2">
                    <div className="min-w-0 text-xs text-[#6b7280]">
                      Save common filters and reuse them as quick views.
                    </div>
                    <Button size="sm" variant="secondary" onClick={saveCurrentView}>
                      Save view
                    </Button>
                  </div>
                  {savedViews.length > 0 ? (
                    <div className="space-y-2">
                      <label className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6b7280]">
                        Saved views
                      </label>
                      <div className="flex flex-wrap gap-2">
                        {savedViews.map((view) => (
                          <div key={view.id} className="inline-flex items-center rounded-md border border-[#d1d5db] bg-white">
                            <button
                              type="button"
                              className="px-2.5 py-1 text-xs font-medium text-[#374151]"
                              onClick={() => loadSavedView(view)}
                            >
                              {view.name}
                            </button>
                            <button
                              type="button"
                              className="border-l border-[#e5e7eb] px-2 py-1 text-xs text-[#9ca3af] hover:text-[#111827]"
                              onClick={() => removeSavedView(view.id)}
                            >
                              x
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <div className="grid gap-3 md:grid-cols-[160px_1fr]">
                    <div className="space-y-1">
                      <label className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6b7280]">
                        Sort
                      </label>
                      <select
                        className="h-9 w-full rounded-md border border-[#d1d5db] bg-white px-3 text-sm text-[#111827] outline-none focus:ring-2 focus:ring-[#111827]/10"
                        value={sortBy}
                        onChange={(event) => setSortBy(event.target.value as SortOption)}
                      >
                        <option value="relevance">Relevance</option>
                        <option value="newest">Newest tweet</option>
                        <option value="oldest">Oldest tweet</option>
                        <option value="captured-newest">Newest captured</option>
                        <option value="captured-oldest">Oldest captured</option>
                        <option value="author">Author A-Z</option>
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6b7280]">
                        Export
                      </label>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="secondary" onClick={() => exportTweets("current", "json")}>
                          <Download className="h-3.5 w-3.5" />
                          Current JSON
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => exportTweets("current", "csv")}>
                          <Download className="h-3.5 w-3.5" />
                          Current CSV
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => exportTweets("full", "json")}>
                          <Download className="h-3.5 w-3.5" />
                          Full JSON
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => exportTweets("full", "csv")}>
                          <Download className="h-3.5 w-3.5" />
                          Full CSV
                        </Button>
                      </div>
                    </div>
                  </div>
                  <div className="rounded-lg border border-[#e5e7eb] bg-[#fafafa] p-3">
                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6b7280]">
                      Ask my likes
                    </div>
                    <div className="flex gap-2">
                      <Input
                        placeholder="What did I like about career, finance, or health from @someone?"
                        value={askQuery}
                        onChange={(event) => setAskQuery(event.target.value)}
                      />
                      <Button size="sm" onClick={() => void askArchive()} disabled={isAsking || tweets.length === 0}>
                        Ask
                      </Button>
                    </div>
                    {askAnswer ? (
                      <div className="mt-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <Badge variant={askAnswerSource === "model" ? "accent" : "secondary"}>
                            {askAnswerSource === "model" ? "AI answer" : "retrieval fallback"}
                          </Badge>
                        </div>
                        <div className="rounded-md border border-[#e5e7eb] bg-white p-3">
                          <p className="whitespace-pre-line text-sm leading-6 text-[#111827]">{askAnswer}</p>
                        </div>
                        {askCitations.length > 0 ? (
                          <div className="space-y-2">
                            {askCitations.slice(0, 3).map((tweet) => (
                              <a
                                key={tweet.id}
                                className="block rounded-md border border-[#d1d5db] bg-white p-3 text-xs text-[#374151] hover:border-[#9ca3af] hover:text-[#111827]"
                                href={tweet.url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <div className="font-medium text-[#111827]">
                                    @{tweet.authorHandle}
                                  </div>
                                  <ArrowUpRight className="h-3 w-3 shrink-0" />
                                </div>
                                <p className="mt-1 line-clamp-3 leading-5 text-[#4b5563]">{tweet.text}</p>
                                {tweet.whyMatched?.length ? (
                                  <div className="mt-2 flex flex-wrap gap-1.5">
                                    {tweet.whyMatched.slice(0, 2).map((reason) => (
                                      <Badge key={`${tweet.id}-${reason}`} variant="secondary">
                                        {reason}
                                      </Badge>
                                    ))}
                                  </div>
                                ) : null}
                              </a>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <PanelBlock title="Status">
                <KeyValue label="mode" value={importState.mode} />
                <KeyValue label="message" value={importState.message} />
                <KeyValue label="updated" value={formatDateTime(importState.updatedAt)} />
                <KeyValue label="likes/min" value={telemetry.likesPerMinute.toFixed(1)} />
                <KeyValue label="elapsed" value={formatDuration(telemetry.elapsedMs)} />
              </PanelBlock>

              <PanelBlock title="Index">
                <KeyValue
                  label="semantic"
                  value={
                    semanticState.indexedTweets >= Math.max(semanticState.totalTweets, 1)
                      ? "ready"
                      : `warming (${semanticState.indexedTweets}/${semanticState.totalTweets})`
                  }
                />
                <KeyValue label="device" value={semanticState.device} />
                <KeyValue label="indexed" value={`${semanticState.indexedTweets}/${semanticState.totalTweets}`} />
                <KeyValue label="pending" value={semanticState.pendingTweets.toString()} />
                <KeyValue label="embeddings" value={storageStats.embeddings.toString()} />
                <KeyValue label="model" value={semanticState.model} mono />
              </PanelBlock>

              <div className="rounded-lg border border-[#e5e7eb] bg-white">
                <button
                  type="button"
                  className="flex w-full items-center justify-between border-b border-[#e5e7eb] px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6b7280]"
                  onClick={() => setDiagnosticsOpen((current) => !current)}
                >
                  <span>Diagnostics</span>
                  {diagnosticsOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
                {diagnosticsOpen ? (
                  <div className="space-y-3 px-3 py-3">
                    <div className="space-y-2">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6b7280]">Importer</div>
                      <KeyValue label="imported" value={importState.importedCount.toString()} />
                      <KeyValue label="new batch" value={importState.newCount.toString()} />
                      <KeyValue label="scrolls" value={importState.checkpoint.scrolls.toString()} />
                      <KeyValue label="idle cycles" value={importState.checkpoint.idleCycles.toString()} />
                    </div>
                    <div className="space-y-2">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6b7280]">Telemetry</div>
                      <KeyValue label="avg batch" value={telemetry.avgBatchSize.toFixed(1)} />
                      <KeyValue label="last batch" value={telemetry.lastBatchSize.toString()} />
                      <KeyValue label="avg wait" value={`${Math.round(telemetry.avgWaitMs)} ms`} />
                      <KeyValue label="last wait" value={`${Math.round(telemetry.waitMs)} ms`} />
                    </div>
                    <div className="space-y-2">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6b7280]">Context</div>
                      <KeyValue label="tab" value={syncContext?.tabTitle ?? "No active tab"} />
                      <KeyValue label="url" value={syncContext?.url ?? "-"} mono />
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </section>

        {stats.topCategories.length > 0 ? (
          <section className="rounded-xl border border-[#d1d5db] bg-white px-4 py-3">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6b7280]">
              Top categories
            </div>
            <div className="flex flex-wrap gap-2">
              {stats.topCategories.map(([category, count]) => (
                <Badge key={category} variant="outline">
                  {category} {count}
                </Badge>
              ))}
            </div>
          </section>
        ) : null}

        <section className="space-y-2 pb-4">
          <div className="flex items-center justify-between px-1">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6b7280]">Results</div>
            <div className="text-xs text-[#6b7280]">
              {sortedTweets.length} items • {sortLabel(sortBy)} {isSearching ? "• ranking" : ""}
            </div>
          </div>

          {sortedTweets.length === 0 ? (
            <Card className="border-[#d1d5db] bg-white">
              <CardContent className="py-10 text-center text-sm text-[#6b7280]">
                No matching likes.
              </CardContent>
            </Card>
          ) : null}

          {sortedTweets.map((tweet) => (
            <Card key={tweet.id} className="border-[#d1d5db] bg-white">
              <CardContent className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <p className="text-sm font-semibold">{tweet.authorName}</p>
                      <p className="text-xs text-[#6b7280]">@{tweet.authorHandle}</p>
                      <Badge variant="secondary">{tweet.socialContext.type}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-[#6b7280]">
                      {tweet.createdAt ? new Date(tweet.createdAt).toLocaleString() : "Capture date unavailable"}
                    </p>
                  </div>
                  <a
                    className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-[#374151] hover:text-[#111827]"
                    href={tweet.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </a>
                </div>

                <p className="text-sm leading-6 text-[#111827]">{tweet.text}</p>

                <div className="flex flex-wrap gap-2">
                  {tweet.categories.map((category) => (
                    <Badge key={category} variant="outline">
                      {category}
                    </Badge>
                  ))}
                  {tweet.whyMatched?.map((reason) => (
                    <Badge key={reason} variant="secondary">
                      {reason}
                    </Badge>
                  ))}
                  {tweet.keywords.slice(0, 4).map((keyword) => (
                    <Badge key={keyword} variant="secondary">
                      {keyword}
                    </Badge>
                  ))}
                  {query.trim() ? <Badge variant="secondary">score {tweet.score.toFixed(2)}</Badge> : null}
                </div>

                {tweet.quotedTweet ? (
                  <div className="rounded-md border border-[#e5e7eb] bg-[#fafafa] p-3">
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6b7280]">
                      Quoted
                    </div>
                    <p className="text-sm text-[#374151]">{tweet.quotedTweet.text}</p>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </section>
      </div>
    </main>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[#e5e7eb] bg-[#fafafa] px-3 py-2">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6b7280]">{label}</div>
      <div className="mt-1 text-base font-semibold text-[#111827]">{value}</div>
    </div>
  );
}

function PanelBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[#e5e7eb] bg-white">
      <div className="border-b border-[#e5e7eb] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6b7280]">
        {title}
      </div>
      <div className="space-y-2 px-3 py-3">{children}</div>
    </div>
  );
}

function KeyValue({
  label,
  value,
  mono = false
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[88px_1fr] items-start gap-3 text-xs">
      <div className="font-medium uppercase tracking-[0.08em] text-[#6b7280]">{label}</div>
      <div className={`break-words text-[#111827] ${mono ? "font-mono text-[11px]" : ""}`}>{value}</div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDuration(ms: number): string {
  if (ms <= 0) {
    return "0s";
  }

  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatDateTime(value?: string): string {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function sortResults(results: SearchResult[], sortBy: SortOption): SearchResult[] {
  const sorted = [...results];
  switch (sortBy) {
    case "newest":
      return sorted.sort((left, right) => compareDates(right.createdAt, left.createdAt));
    case "oldest":
      return sorted.sort((left, right) => compareDates(left.createdAt, right.createdAt));
    case "captured-newest":
      return sorted.sort((left, right) => compareDates(right.capturedAt, left.capturedAt));
    case "captured-oldest":
      return sorted.sort((left, right) => compareDates(left.capturedAt, right.capturedAt));
    case "author":
      return sorted.sort((left, right) => left.authorHandle.localeCompare(right.authorHandle));
    case "relevance":
    default:
      return sorted.sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        return compareDates(right.createdAt ?? right.capturedAt, left.createdAt ?? left.capturedAt);
      });
  }
}

function compareDates(left?: string, right?: string): number {
  const leftTime = left ? new Date(left).getTime() : 0;
  const rightTime = right ? new Date(right).getTime() : 0;
  return leftTime - rightTime;
}

function sortLabel(sortBy: SortOption): string {
  switch (sortBy) {
    case "newest":
      return "newest";
    case "oldest":
      return "oldest";
    case "captured-newest":
      return "captured newest";
    case "captured-oldest":
      return "captured oldest";
    case "author":
      return "author";
    case "relevance":
    default:
      return "relevance";
  }
}

function toJsonExport(tweets: SearchResult[]): string {
  const rows = tweets.map((tweet) => ({
    id: tweet.id,
    canonicalId: tweet.canonicalId,
    authorName: tweet.authorName,
    authorHandle: tweet.authorHandle,
    createdAt: tweet.createdAt,
    capturedAt: tweet.capturedAt,
    url: tweet.url,
    text: tweet.text,
    quotedText: tweet.quotedTweet?.text ?? "",
    socialContext: tweet.socialContext.type,
    categories: tweet.categories,
    keywords: tweet.keywords,
    score: tweet.score,
    lexicalScore: tweet.lexicalScore ?? 0,
    semanticScore: tweet.semanticScore ?? 0
  }));
  return JSON.stringify(rows, null, 2);
}

function toCsvExport(tweets: SearchResult[]): string {
  const header = [
    "id",
    "canonicalId",
    "authorName",
    "authorHandle",
    "createdAt",
    "capturedAt",
    "url",
    "text",
    "quotedText",
    "socialContext",
    "categories",
    "keywords",
    "score",
    "lexicalScore",
    "semanticScore"
  ];

  const rows = tweets.map((tweet) => [
    tweet.id,
    tweet.canonicalId,
    tweet.authorName,
    tweet.authorHandle,
    tweet.createdAt ?? "",
    tweet.capturedAt,
    tweet.url,
    tweet.text,
    tweet.quotedTweet?.text ?? "",
    tweet.socialContext.type,
    tweet.categories.join("|"),
    tweet.keywords.join("|"),
    tweet.score.toFixed(4),
    String(tweet.lexicalScore ?? 0),
    String(tweet.semanticScore ?? 0)
  ]);

  return [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
}

function csvEscape(value: string): string {
  const normalized = value.replace(/\r?\n/g, " ").replace(/"/g, "\"\"");
  return `"${normalized}"`;
}

function downloadText(content: string, mime: string, filename: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function buildImportHeadline(
  importState: ImportJobState,
  semanticState: SemanticIndexState,
  totalLikes: number
): string | null {
  if (importState.status === "running") {
    if (importState.mode === "recent") {
      return `Refreshing recent likes in the background. ${importState.importedCount} scanned so far.`;
    }

    return `Importing your archive in the background. ${importState.importedCount} likes scanned so far.`;
  }

  if (importState.status === "completed") {
    if (semanticState.pendingTweets > 0) {
      return `Archive updated. Semantic index is still warming up (${semanticState.indexedTweets}/${Math.max(
        semanticState.totalTweets,
        totalLikes
      )}).`;
    }

    return `Archive is up to date. ${totalLikes} likes available locally.`;
  }

  if (importState.status === "paused") {
    return "Archive import is paused.";
  }

  if (importState.status === "error") {
    return importState.message || "Archive import hit an error.";
  }

  return null;
}
