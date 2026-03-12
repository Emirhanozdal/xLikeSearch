export type TweetCategory =
  | "rag"
  | "fine-tuning"
  | "agents"
  | "evals"
  | "infra"
  | "product"
  | "design"
  | "business"
  | "marketing"
  | "finance"
  | "career"
  | "writing"
  | "health"
  | "uncategorized";

export interface TweetEntity {
  id: string;
  text: string;
  authorName: string;
  authorHandle: string;
  createdAt?: string;
  url: string;
  media: string[];
}

export interface TweetSocialContext {
  type: "liked" | "reposted" | "quoted";
  actorName?: string;
  actorHandle?: string;
  label?: string;
}

export interface LikedTweet {
  id: string;
  canonicalId: string;
  text: string;
  authorName: string;
  authorHandle: string;
  createdAt?: string;
  url: string;
  media: string[];
  originalTweet: TweetEntity;
  quotedTweet?: TweetEntity;
  socialContext: TweetSocialContext;
  categories: TweetCategory[];
  keywords: string[];
  capturedAt: string;
}

export interface SearchQuery {
  text: string;
  categories: TweetCategory[];
  authorHandles?: string[];
  dateFrom?: string;
  dateTo?: string;
}

export interface SearchResult extends LikedTweet {
  score: number;
  lexicalScore?: number;
  semanticScore?: number;
  whyMatched?: string[];
}

export interface SyncContext {
  isXTab: boolean;
  isLikesPage: boolean;
  tabTitle?: string;
  url?: string;
}

export interface EmbeddingRecord {
  id: string;
  vector: number[];
  model: string;
  updatedAt: string;
}

export interface SemanticIndexState {
  model: string;
  totalTweets: number;
  indexedTweets: number;
  pendingTweets: number;
  ready: boolean;
  device: "webgpu" | "wasm";
}

export interface SemanticQueueState {
  queuedIds: string[];
  status: "idle" | "running" | "paused" | "error";
  updatedAt: string;
  processedCount: number;
  lastProcessedId?: string;
  error?: string;
}

export interface ImportCheckpoint {
  lastTweetId?: string;
  lastCapturedAt?: string;
  seenCount: number;
  idleCycles: number;
  scrolls: number;
}

export interface ImportTelemetry {
  startedAt?: string;
  lastBatchAt?: string;
  elapsedMs: number;
  batches: number;
  avgBatchSize: number;
  likesPerMinute: number;
  lastBatchSize: number;
  waitMs: number;
  waitEvents: number;
  avgWaitMs: number;
}

export interface ImportJobState {
  status: "idle" | "running" | "paused" | "completed" | "error";
  mode: "visible" | "full" | "recent";
  startedAt?: string;
  updatedAt: string;
  importedCount: number;
  newCount: number;
  checkpoint: ImportCheckpoint;
  message: string;
  activeTabId?: number;
  error?: string;
}

export type StorageMode = "compact" | "deep";

export interface StorageSettings {
  mode: StorageMode;
  maxIndexedTweets: number;
  preserveQuotedTweets: boolean;
}

export interface StorageStats {
  totalLikes: number;
  authors: number;
  embeddings: number;
  indexedTweets: number;
  approxBytes: number;
  mode: StorageMode;
}

export interface StateSnapshot {
  importState?: ImportJobState;
  storageStats?: StorageStats;
  likesCount?: number;
  telemetry?: ImportTelemetry;
}

export type RuntimeMessage =
  | { type: "SYNC_VISIBLE_LIKES" }
  | { type: "GET_LIKES" }
  | { type: "GET_SYNC_CONTEXT" }
  | { type: "GET_STATE_SNAPSHOT" }
  | { type: "START_AUTO_IMPORT"; mode?: "full" | "recent"; knownIds?: string[] }
  | { type: "STOP_AUTO_IMPORT" }
  | { type: "GET_IMPORT_STATUS" }
  | {
      type: "IMPORT_BATCH";
      tweets: LikedTweet[];
      checkpoint: ImportCheckpoint;
      message: string;
      metrics: {
        batchSize: number;
        waitMs: number;
        happenedAt: string;
      };
    }
  | { type: "IMPORT_STATE_UPDATE"; state: Partial<ImportJobState> }
  | { type: "GET_STORAGE_STATS" }
  | { type: "SET_STORAGE_MODE"; mode: StorageMode }
  | { type: "STATE_SNAPSHOT"; snapshot: StateSnapshot };
