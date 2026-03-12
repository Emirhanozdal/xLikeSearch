import type {
  EmbeddingRecord,
  ImportJobState,
  LikedTweet,
  SemanticQueueState,
  StorageMode,
  StorageSettings,
  StorageStats,
  TweetEntity,
  TweetSocialContext
} from "../types";

const DB_NAME = "x-like-search";
const DB_VERSION = 2;
const LIKES_STORE = "likes";
const AUTHORS_STORE = "authors";
const EMBEDDINGS_STORE = "embeddings";
const IMPORT_JOB_KEY = "importJobState";
const STORAGE_SETTINGS_KEY = "storageSettings";
const SEMANTIC_QUEUE_KEY = "semanticQueueState";

const DEFAULT_STORAGE_SETTINGS: StorageSettings = {
  mode: "compact",
  maxIndexedTweets: 8000,
  preserveQuotedTweets: true
};

interface AuthorRecord {
  id: string;
  name: string;
  handle: string;
}

interface StoredTweetEntity {
  id: string;
  text: string;
  authorId: string;
  createdAt?: string;
  url: string;
  media?: string[];
}

interface StoredLikedTweetRecord {
  id: string;
  canonicalId: string;
  text: string;
  authorId: string;
  createdAt?: string;
  url: string;
  media?: string[];
  originalTweet: StoredTweetEntity;
  quotedTweet?: StoredTweetEntity;
  socialContext: TweetSocialContext;
  categories: LikedTweet["categories"];
  keywords: string[];
  capturedAt: string;
}

interface StoredEmbeddingRecord {
  id: string;
  model: string;
  updatedAt: string;
  scale: number;
  data: ArrayBuffer;
}

interface CategoryUpdate {
  id: string;
  categories: LikedTweet["categories"];
}

let openRequest: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (openRequest) {
    return openRequest;
  }

  openRequest = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(LIKES_STORE)) {
        db.createObjectStore(LIKES_STORE, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(AUTHORS_STORE)) {
        db.createObjectStore(AUTHORS_STORE, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(EMBEDDINGS_STORE)) {
        db.createObjectStore(EMBEDDINGS_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });

  return openRequest;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function authorIdFrom(name: string, handle: string): string {
  return `${handle.toLowerCase()}::${name.toLowerCase()}`;
}

function compactMedia(urls: string[] | undefined, mode: StorageMode): string[] | undefined {
  if (!urls || urls.length === 0) {
    return undefined;
  }

  return mode === "deep" ? urls.slice(0, 6) : urls.slice(0, 2);
}

function compactText(text: string, mode: StorageMode): string {
  const normalized = text.trim();
  return mode === "deep" ? normalized : normalized.slice(0, 1800);
}

function toStoredEntity(entity: TweetEntity, mode: StorageMode, authors: Map<string, AuthorRecord>): StoredTweetEntity {
  const authorId = authorIdFrom(entity.authorName, entity.authorHandle);
  authors.set(authorId, {
    id: authorId,
    name: entity.authorName,
    handle: entity.authorHandle
  });

  return {
    id: entity.id,
    text: compactText(entity.text, mode),
    authorId,
    createdAt: entity.createdAt,
    url: entity.url,
    media: compactMedia(entity.media, mode)
  };
}

function toStoredLike(tweet: LikedTweet, settings: StorageSettings, authors: Map<string, AuthorRecord>): StoredLikedTweetRecord {
  const mode = settings.mode;
  const authorId = authorIdFrom(tweet.authorName, tweet.authorHandle);
  authors.set(authorId, {
    id: authorId,
    name: tweet.authorName,
    handle: tweet.authorHandle
  });

  return {
    id: tweet.id,
    canonicalId: tweet.canonicalId,
    text: compactText(tweet.text, mode),
    authorId,
    createdAt: tweet.createdAt,
    url: tweet.url,
    media: compactMedia(tweet.media, mode),
    originalTweet: toStoredEntity(tweet.originalTweet, mode, authors),
    quotedTweet:
      settings.preserveQuotedTweets && tweet.quotedTweet
        ? toStoredEntity(tweet.quotedTweet, mode, authors)
        : undefined,
    socialContext: tweet.socialContext,
    categories: tweet.categories,
    keywords: mode === "deep" ? tweet.keywords.slice(0, 18) : tweet.keywords.slice(0, 10),
    capturedAt: tweet.capturedAt
  };
}

function fromStoredEntity(entity: StoredTweetEntity, authors: Map<string, AuthorRecord>): TweetEntity {
  const author = authors.get(entity.authorId);
  return {
    id: entity.id,
    text: entity.text,
    authorName: author?.name ?? "unknown",
    authorHandle: author?.handle ?? "unknown",
    createdAt: entity.createdAt,
    url: entity.url,
    media: entity.media ?? []
  };
}

function hydrateLike(record: StoredLikedTweetRecord, authors: Map<string, AuthorRecord>): LikedTweet {
  const author = authors.get(record.authorId);
  return {
    id: record.id,
    canonicalId: record.canonicalId,
    text: record.text,
    authorName: author?.name ?? "unknown",
    authorHandle: author?.handle ?? "unknown",
    createdAt: record.createdAt,
    url: record.url,
    media: record.media ?? [],
    originalTweet: fromStoredEntity(record.originalTweet, authors),
    quotedTweet: record.quotedTweet ? fromStoredEntity(record.quotedTweet, authors) : undefined,
    socialContext: record.socialContext,
    categories: record.categories,
    keywords: record.keywords,
    capturedAt: record.capturedAt
  };
}

function isLegacyTweet(tweet: unknown): tweet is LikedTweet {
  return Boolean(tweet && typeof tweet === "object" && "authorName" in tweet && "originalTweet" in tweet);
}

function quantizeVector(vector: number[]): { data: ArrayBuffer; scale: number } {
  let maxAbs = 0;
  for (const value of vector) {
    const abs = Math.abs(value);
    if (abs > maxAbs) {
      maxAbs = abs;
    }
  }

  const scale = maxAbs === 0 ? 1 : maxAbs / 127;
  const values = new Int8Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) {
    values[index] = Math.max(-127, Math.min(127, Math.round(vector[index] / scale)));
  }

  return {
    data: values.buffer,
    scale
  };
}

function dequantizeVector(record: StoredEmbeddingRecord): number[] {
  const data = new Int8Array(record.data);
  return Array.from(data, (value) => value * record.scale);
}

async function getAllAuthorsMap(): Promise<Map<string, AuthorRecord>> {
  const db = await openDatabase();
  const transaction = db.transaction([AUTHORS_STORE], "readonly");
  const authors = (await requestToPromise(transaction.objectStore(AUTHORS_STORE).getAll())) as AuthorRecord[];
  return new Map(authors.map((author) => [author.id, author]));
}

export async function migrateLikesFromChromeStorage(): Promise<void> {
  const legacy = await chrome.storage.local.get("likedTweets");
  const likes = (legacy.likedTweets as LikedTweet[] | undefined) ?? [];

  if (likes.length === 0) {
    return;
  }

  await saveLikes(likes);
  await chrome.storage.local.remove("likedTweets");
}

export async function getStorageSettings(): Promise<StorageSettings> {
  const result = await chrome.storage.local.get(STORAGE_SETTINGS_KEY);
  return {
    ...DEFAULT_STORAGE_SETTINGS,
    ...(result[STORAGE_SETTINGS_KEY] as Partial<StorageSettings> | undefined)
  };
}

export async function setStorageMode(mode: StorageMode): Promise<StorageSettings> {
  const current = await getStorageSettings();
  const next = {
    ...current,
    mode
  };
  await chrome.storage.local.set({
    [STORAGE_SETTINGS_KEY]: next
  });
  return next;
}

export async function getStoredLikes(): Promise<LikedTweet[]> {
  const db = await openDatabase();
  const transaction = db.transaction([LIKES_STORE], "readonly");
  const records = (await requestToPromise(transaction.objectStore(LIKES_STORE).getAll())) as Array<
    StoredLikedTweetRecord | LikedTweet
  >;
  const authors = await getAllAuthorsMap();

  const tweets = records.map((record) => {
    if (isLegacyTweet(record)) {
      return record;
    }
    return hydrateLike(record, authors);
  });

  return tweets.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
}

export async function saveLikes(incoming: LikedTweet[]): Promise<LikedTweet[]> {
  if (incoming.length === 0) {
    return getStoredLikes();
  }

  const settings = await getStorageSettings();
  const authors = new Map<string, AuthorRecord>();
  const db = await openDatabase();
  const transaction = db.transaction([LIKES_STORE, AUTHORS_STORE], "readwrite");
  const likesStore = transaction.objectStore(LIKES_STORE);
  const authorsStore = transaction.objectStore(AUTHORS_STORE);

  for (const tweet of incoming) {
    const record = toStoredLike(tweet, settings, authors);
    likesStore.put(record);
  }

  for (const author of authors.values()) {
    authorsStore.put(author);
  }

  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });

  return getStoredLikes();
}

export async function saveLikesBatch(
  incoming: LikedTweet[]
): Promise<{ totalLikes: number; insertedOrUpdated: number }> {
  if (incoming.length === 0) {
    const db = await openDatabase();
    const count = await requestToPromise(db.transaction([LIKES_STORE], "readonly").objectStore(LIKES_STORE).count());
    return {
      totalLikes: count,
      insertedOrUpdated: 0
    };
  }

  const settings = await getStorageSettings();
  const authors = new Map<string, AuthorRecord>();
  const db = await openDatabase();
  const transaction = db.transaction([LIKES_STORE, AUTHORS_STORE], "readwrite");
  const likesStore = transaction.objectStore(LIKES_STORE);
  const authorsStore = transaction.objectStore(AUTHORS_STORE);

  for (const tweet of incoming) {
    const record = toStoredLike(tweet, settings, authors);
    likesStore.put(record);
  }

  for (const author of authors.values()) {
    authorsStore.put(author);
  }

  const totalLikesRequest = likesStore.count();

  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });

  return {
    totalLikes: totalLikesRequest.result,
    insertedOrUpdated: incoming.length
  };
}

export async function getStorageCounts(): Promise<Pick<StorageStats, "totalLikes" | "authors" | "embeddings" | "indexedTweets">> {
  const db = await openDatabase();
  const [likes, authors, embeddings] = await Promise.all([
    requestToPromise(db.transaction([LIKES_STORE], "readonly").objectStore(LIKES_STORE).count()),
    requestToPromise(db.transaction([AUTHORS_STORE], "readonly").objectStore(AUTHORS_STORE).count()),
    requestToPromise(db.transaction([EMBEDDINGS_STORE], "readonly").objectStore(EMBEDDINGS_STORE).count())
  ]);

  return {
    totalLikes: likes,
    authors,
    embeddings,
    indexedTweets: embeddings
  };
}

export async function getEmbeddingMap(ids?: string[]): Promise<Map<string, EmbeddingRecord>> {
  const db = await openDatabase();
  const transaction = db.transaction([EMBEDDINGS_STORE], "readonly");
  const store = transaction.objectStore(EMBEDDINGS_STORE);

  const records: StoredEmbeddingRecord[] = ids
    ? (await Promise.all(
        ids.map((id) => requestToPromise(store.get(id)) as Promise<StoredEmbeddingRecord | undefined>)
      )).filter((item): item is StoredEmbeddingRecord => Boolean(item))
    : ((await requestToPromise(store.getAll())) as StoredEmbeddingRecord[]);

  return new Map(
    records.map((record) => [
      record.id,
      {
        id: record.id,
        vector: dequantizeVector(record),
        model: record.model,
        updatedAt: record.updatedAt
      }
    ])
  );
}

export async function putEmbeddings(records: EmbeddingRecord[]): Promise<void> {
  if (records.length === 0) {
    return;
  }

  const settings = await getStorageSettings();
  const limited = records.slice(0, settings.maxIndexedTweets);
  const db = await openDatabase();
  const transaction = db.transaction([EMBEDDINGS_STORE], "readwrite");
  const store = transaction.objectStore(EMBEDDINGS_STORE);

  for (const record of limited) {
    const quantized = quantizeVector(record.vector);
    const stored: StoredEmbeddingRecord = {
      id: record.id,
      model: record.model,
      updatedAt: record.updatedAt,
      scale: quantized.scale,
      data: quantized.data
    };
    store.put(stored);
  }

  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function updateTweetCategories(updates: CategoryUpdate[]): Promise<void> {
  if (updates.length === 0) {
    return;
  }

  const db = await openDatabase();
  const transaction = db.transaction([LIKES_STORE], "readwrite");
  const store = transaction.objectStore(LIKES_STORE);

  for (const update of updates) {
    const existing = (await requestToPromise(store.get(update.id))) as StoredLikedTweetRecord | LikedTweet | undefined;
    if (!existing) {
      continue;
    }

    if (isLegacyTweet(existing)) {
      store.put({
        ...existing,
        categories: update.categories
      });
      continue;
    }

    store.put({
      ...existing,
      categories: update.categories
    } satisfies StoredLikedTweetRecord);
  }

  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function getStorageStats(): Promise<StorageStats> {
  const db = await openDatabase();
  const [likes, authors, embeddings] = await Promise.all([
    requestToPromise(db.transaction([LIKES_STORE], "readonly").objectStore(LIKES_STORE).getAll()),
    requestToPromise(db.transaction([AUTHORS_STORE], "readonly").objectStore(AUTHORS_STORE).getAll()),
    requestToPromise(db.transaction([EMBEDDINGS_STORE], "readonly").objectStore(EMBEDDINGS_STORE).getAll())
  ]);
  const settings = await getStorageSettings();
  const embeddingBytes = (embeddings as StoredEmbeddingRecord[]).reduce((total, item) => total + item.data.byteLength, 0);
  const approxBytes =
    new Blob([JSON.stringify(likes)]).size +
    new Blob([JSON.stringify(authors)]).size +
    embeddingBytes;

  return {
    totalLikes: (likes as Array<StoredLikedTweetRecord | LikedTweet>).length,
    authors: (authors as AuthorRecord[]).length,
    embeddings: (embeddings as StoredEmbeddingRecord[]).length,
    indexedTweets: (embeddings as StoredEmbeddingRecord[]).length,
    approxBytes,
    mode: settings.mode
  };
}

export async function getSemanticQueueState(): Promise<SemanticQueueState> {
  const result = await chrome.storage.local.get(SEMANTIC_QUEUE_KEY);
  return (
    (result[SEMANTIC_QUEUE_KEY] as SemanticQueueState | undefined) ?? {
      queuedIds: [],
      status: "idle",
      updatedAt: new Date().toISOString(),
      processedCount: 0
    }
  );
}

export async function setSemanticQueueState(state: SemanticQueueState): Promise<void> {
  await chrome.storage.local.set({
    [SEMANTIC_QUEUE_KEY]: state
  });
}

export async function updateSemanticQueueState(
  partial: Partial<SemanticQueueState>
): Promise<SemanticQueueState> {
  const current = await getSemanticQueueState();
  const next: SemanticQueueState = {
    ...current,
    ...partial,
    updatedAt: new Date().toISOString()
  };
  await setSemanticQueueState(next);
  return next;
}

export async function getImportJobState(): Promise<ImportJobState> {
  const result = await chrome.storage.local.get(IMPORT_JOB_KEY);
  return (
    (result[IMPORT_JOB_KEY] as ImportJobState | undefined) ?? {
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
    }
  );
}

export async function setImportJobState(state: ImportJobState): Promise<void> {
  await chrome.storage.local.set({
    [IMPORT_JOB_KEY]: state
  });
}

export async function updateImportJobState(partial: Partial<ImportJobState>): Promise<ImportJobState> {
  const current = await getImportJobState();
  const next: ImportJobState = {
    ...current,
    ...partial,
    checkpoint: {
      ...current.checkpoint,
      ...partial.checkpoint
    },
    updatedAt: new Date().toISOString()
  };
  await setImportJobState(next);
  return next;
}
