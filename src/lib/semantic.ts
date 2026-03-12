import type {
  EmbeddingRecord,
  LikedTweet,
  SearchQuery,
  SearchResult,
  SemanticIndexState,
  TweetCategory
} from "../types";
import {
  getEmbeddingMap,
  getSemanticQueueState,
  getStorageSettings,
  putEmbeddings,
  setSemanticQueueState,
  updateTweetCategories,
  updateSemanticQueueState
} from "./db";
import { categorizeText, extractKeywords } from "./categorize";
import { filterByCategories, scoreTextMatch } from "./search";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const BATCH_SIZE = 4;
const MAX_SEMANTIC_RERANK = 120;
const MIN_QUERY_LENGTH_FOR_SEMANTIC = 3;
const TOPIC_THRESHOLD = 0.28;

const TOPIC_PROMPTS = {
  rag: "retrieval augmented generation, embeddings, reranking, vector databases, semantic search, chunking, grounding",
  "fine-tuning": "fine tuning, lora, qlora, dpo, post training, alignment, distillation, supervised fine tuning",
  agents: "agents, tool calling, orchestration, workflow automation, browser use, computer use, multi agent systems",
  evals: "evaluations, benchmarks, judges, test sets, hallucination checks, quality measurement, grading models",
  infra: "inference infrastructure, webgpu, onnx, wasm, runtime performance, latency, throughput, gpu serving, memory",
  product: "product strategy, growth, distribution, positioning, onboarding, pricing, retention, customer research",
  design: "design systems, interface design, ux, ui, typography, layouts, prototypes, interaction design"
} as const;

type FeatureExtractor = (input: string | string[], options: { pooling: "mean"; normalize: boolean }) => Promise<{
  data: Float32Array | number[];
  dims: number[];
}>;

let extractorPromise: Promise<FeatureExtractor> | null = null;
let workerPromise: Promise<SemanticIndexState> | null = null;
let topicVectorPromise: Promise<Map<string, number[]>> | null = null;

async function getExtractor(): Promise<FeatureExtractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const transformers = (await import("@huggingface/transformers")) as unknown as {
        env: {
          allowLocalModels: boolean;
          allowRemoteModels: boolean;
          useBrowserCache: boolean;
          backends: {
            onnx: {
              wasm: {
                wasmPaths?:
                  | string
                  | {
                      mjs: string;
                      wasm: string;
                    };
                proxy?: boolean;
                numThreads?: number;
              };
            };
          };
        };
        pipeline: (
          task: string,
          model: string,
          options: { device: "webgpu" | "wasm"; dtype: "q8" }
        ) => Promise<FeatureExtractor>;
      };
      const { pipeline, env } = transformers;
      env.allowLocalModels = false;
      env.allowRemoteModels = true;
      env.useBrowserCache = true;
      env.backends.onnx.wasm.wasmPaths = getOnnxWasmPaths();
      env.backends.onnx.wasm.proxy = false;
      env.backends.onnx.wasm.numThreads = 1;

      try {
        return await pipeline("feature-extraction", MODEL_ID, {
          device: getPreferredDevice(),
          dtype: "q8"
        });
      } catch {
        return await pipeline("feature-extraction", MODEL_ID, {
          device: "wasm",
          dtype: "q8"
        });
      }
    })();
  }

  return extractorPromise;
}

export function getPreferredDevice(): "webgpu" | "wasm" {
  return "gpu" in navigator ? "webgpu" : "wasm";
}

function getOnnxWasmRoot(): string {
  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    return chrome.runtime.getURL("assets/");
  }

  return "/assets/";
}

function getOnnxWasmPaths():
  | string
  | {
      mjs: string;
      wasm: string;
    } {
  const root = getOnnxWasmRoot();
  return {
    mjs: `${root}ort-wasm-simd-threaded.jsep.mjs`,
    wasm: `${root}ort-wasm-simd-threaded.jsep.wasm`
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}

function toVector(data: Float32Array | number[], dims: number[]): number[] {
  const array = Array.from(data);
  if (dims.length === 1) {
    return array;
  }
  return array.slice(0, dims[dims.length - 1]);
}

function buildEmbeddingText(tweet: LikedTweet): string {
  return [
    tweet.authorName,
    tweet.authorHandle,
    tweet.text,
    tweet.originalTweet.text,
    tweet.socialContext.label,
    tweet.quotedTweet?.text,
    tweet.quotedTweet?.authorName,
    tweet.categories.join(" ")
  ]
    .filter(Boolean)
    .join("\n");
}

function buildQueryEmbeddingText(query: SearchQuery, inferredCategories: string[]): string {
  const parts = [query.text.trim()];
  if (query.categories.length > 0) {
    parts.push(`categories: ${query.categories.join(" ")}`);
  }
  if (inferredCategories.length > 0) {
    parts.push(`topics: ${inferredCategories.join(" ")}`);
  }

  const keywords = extractKeywords(query.text).slice(0, 8);
  if (keywords.length > 0) {
    parts.push(`keywords: ${keywords.join(" ")}`);
  }

  return parts.filter(Boolean).join("\n");
}

function computeCoverage(totalCandidates: number, embeddingCount: number): number {
  if (totalCandidates <= 0) {
    return 0;
  }

  return embeddingCount / totalCandidates;
}

function categoryOverlap(tweet: LikedTweet, explicit: string[], inferred: string[]): number {
  const matched = new Set<string>();
  for (const category of [...explicit, ...inferred]) {
    if (tweet.categories.includes(category as (typeof tweet.categories)[number])) {
      matched.add(category);
    }
  }

  return matched.size;
}

function buildWhyMatched(
  tweet: LikedTweet,
  queryText: string,
  lexicalScore: number,
  semanticScore: number,
  explicitCategories: string[],
  inferredCategories: string[],
  matchedTopics: string[] = []
): string[] {
  const reasons: string[] = [];
  const normalizedQuery = queryText.toLowerCase();
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);

  if (lexicalScore > 0 && terms.some((term) => tweet.text.toLowerCase().includes(term))) {
    reasons.push("tweet text matched");
  }

  if (terms.some((term) => tweet.authorHandle.toLowerCase().includes(term) || tweet.authorName.toLowerCase().includes(term))) {
    reasons.push("author matched");
  }

  if (tweet.quotedTweet && terms.some((term) => tweet.quotedTweet?.text.toLowerCase().includes(term))) {
    reasons.push("quoted tweet matched");
  }

  const matchingCategories = [...explicitCategories, ...inferredCategories, ...matchedTopics].filter((category) =>
    tweet.categories.includes(category as (typeof tweet.categories)[number]) || matchedTopics.includes(category)
  );
  if (matchingCategories.length > 0) {
    reasons.push(`topic matched: ${Array.from(new Set(matchingCategories)).join(", ")}`);
  }

  if (semanticScore > 0.42) {
    reasons.push("semantic similarity");
  }

  return reasons.slice(0, 3);
}

async function getTopicVectors(): Promise<Map<string, number[]>> {
  if (!topicVectorPromise) {
    topicVectorPromise = (async () => {
      const extractor = await getExtractor();
      const labels = Object.keys(TOPIC_PROMPTS);
      const output = await extractor(
        labels.map((label) => `${label}\n${TOPIC_PROMPTS[label as keyof typeof TOPIC_PROMPTS]}`),
        {
          pooling: "mean",
          normalize: true
        }
      );
      const width = output.dims[output.dims.length - 1];
      const vectors = chunk(Array.from(output.data), width);
      return new Map(labels.map((label, index) => [label, vectors[index] ?? []]));
    })();
  }

  return topicVectorPromise;
}

async function inferSemanticTopicsFromVector(vector: number[]): Promise<string[]> {
  if (vector.length === 0) {
    return [];
  }

  const topicVectors = await getTopicVectors();
  return Array.from(topicVectors.entries())
    .map(([topic, topicVector]) => ({
      topic,
      score: cosineSimilarity(vector, topicVector)
    }))
    .filter((entry) => entry.score >= TOPIC_THRESHOLD)
    .sort((left, right) => right.score - left.score)
    .slice(0, 2)
    .map((entry) => entry.topic);
}

export async function askLikes(
  tweets: LikedTweet[],
  query: SearchQuery
): Promise<{
  answer: string;
  citations: SearchResult[];
  semanticState: SemanticIndexState;
}> {
  const { results, semanticState } = await hybridSearchLikes(tweets, query);
  const top = results.slice(0, 5);

  if (top.length === 0) {
    return {
      answer: "I could not find strong matches in your liked tweets for that question.",
      citations: [],
      semanticState
    };
  }

  const themes = new Map<string, number>();
  const embeddingMap = await getEmbeddingMap(top.map((tweet) => tweet.id));
  for (const tweet of top) {
    const semanticTopics = await inferSemanticTopicsFromVector(embeddingMap.get(tweet.id)?.vector ?? []);
    for (const category of [...tweet.categories, ...semanticTopics]) {
      if (category === "uncategorized") {
        continue;
      }
      themes.set(category, (themes.get(category) ?? 0) + 1);
    }
  }

  const topThemes = Array.from(themes.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([theme]) => theme);

  const evidenceLines = top.slice(0, 3).map((tweet) => {
    const snippet = tweet.text.replace(/\s+/g, " ").trim().slice(0, 180);
    const reasons = tweet.whyMatched?.slice(0, 2).join(", ");
    return `- @${tweet.authorHandle}: ${snippet}${tweet.text.length > 180 ? "..." : ""}${reasons ? ` (${reasons})` : ""}`;
  });

  const answerParts = [
    topThemes.length > 0
      ? `Summary: your likes cluster mostly around ${topThemes.join(", ")}.`
      : "Summary: your likes contain related matches, but no dominant topic cluster yet.",
    `Signals: strongest evidence comes from ${top
      .slice(0, 3)
      .map((tweet) => `@${tweet.authorHandle}`)
      .join(", ")}.`,
    "Evidence:",
    ...evidenceLines
  ];

  return {
    answer: answerParts.join("\n"),
    citations: top,
    semanticState
  };
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    const l = left[index];
    const r = right[index];
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }

  const denom = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denom === 0 ? 0 : dot / denom;
}

async function buildState(tweets: LikedTweet[], queuedCount?: number): Promise<SemanticIndexState> {
  const settings = await getStorageSettings();
  const indexedSlice = tweets.slice(0, settings.maxIndexedTweets);
  const existing = await getEmbeddingMap(indexedSlice.map((tweet) => tweet.id));
  const queue = await getSemanticQueueState();

  return {
    model: MODEL_ID,
    totalTweets: tweets.length,
    indexedTweets: existing.size,
    pendingTweets: queuedCount ?? queue.queuedIds.length,
    ready: indexedSlice.length > 0 && existing.size > 0,
    device: getPreferredDevice()
  };
}

export async function enqueueMissingEmbeddings(tweets: LikedTweet[]): Promise<SemanticIndexState> {
  const settings = await getStorageSettings();
  const indexedSlice = tweets.slice(0, settings.maxIndexedTweets);
  const existing = await getEmbeddingMap(indexedSlice.map((tweet) => tweet.id));
  const queue = await getSemanticQueueState();
  const queuedSet = new Set(queue.queuedIds);

  for (const tweet of indexedSlice) {
    if (!existing.has(tweet.id)) {
      queuedSet.add(tweet.id);
    }
  }

  await updateSemanticQueueState({
    queuedIds: Array.from(queuedSet),
    status: queue.status === "running" ? "running" : "idle"
  });

  return buildState(tweets, queuedSet.size);
}

export async function processSemanticQueue(
  tweets: LikedTweet[],
  onProgress?: (state: SemanticIndexState) => void
): Promise<SemanticIndexState> {
  if (workerPromise) {
    return workerPromise;
  }

  workerPromise = (async () => {
    const queue = await getSemanticQueueState();
    const tweetMap = new Map(tweets.map((tweet) => [tweet.id, tweet]));
    const ids = queue.queuedIds.filter((id) => tweetMap.has(id));

    if (ids.length === 0) {
      const idleState = await updateSemanticQueueState({ status: "idle" });
      const state = await buildState(tweets, idleState.queuedIds.length);
      onProgress?.(state);
      workerPromise = null;
      return state;
    }

    await updateSemanticQueueState({ status: "running" });
    const extractor = await getExtractor();
    let remainingIds = ids;

    const batchIds = ids.slice(0, BATCH_SIZE);
    const batchTweets = batchIds.map((id) => tweetMap.get(id)).filter((tweet): tweet is LikedTweet => Boolean(tweet));

    if (batchTweets.length > 0) {
      const output = await extractor(
        batchTweets.map((tweet) => buildEmbeddingText(tweet)),
        {
          pooling: "mean",
          normalize: true
        }
      );

      const width = output.dims[output.dims.length - 1];
      const vectors = chunk(Array.from(output.data), width);
      const records: EmbeddingRecord[] = batchTweets.map((tweet, index) => ({
        id: tweet.id,
        vector: vectors[index] ?? [],
        model: MODEL_ID,
        updatedAt: new Date().toISOString()
      }));

      await putEmbeddings(records);
      const categoryUpdates = await Promise.all(
        batchTweets.map(async (tweet, index) => {
          const semanticTopics = await inferSemanticTopicsFromVector(vectors[index] ?? []);
          const categories = Array.from(
            new Set([...tweet.categories.filter((value) => value !== "uncategorized"), ...semanticTopics])
          ) as TweetCategory[];
          return {
            id: tweet.id,
            categories: (categories.length > 0 ? categories : ["uncategorized"]) as TweetCategory[]
          };
        })
      );
      await updateTweetCategories(categoryUpdates);
      remainingIds = remainingIds.filter((id) => !batchIds.includes(id));
    }

    const queueState = await setQueueProgress(remainingIds, batchIds.at(-1));
    const finalState = await buildState(tweets, queueState.queuedIds.length);
    onProgress?.(finalState);
    workerPromise = null;
    return finalState;
  })().catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : "Semantic queue failed.";
    await updateSemanticQueueState({
      status: "error",
      error: message
    });
    workerPromise = null;
    throw error;
  });

  return workerPromise;
}

async function setQueueProgress(remainingIds: string[], lastProcessedId?: string) {
  const current = await getSemanticQueueState();
  const next = {
    ...current,
    queuedIds: remainingIds,
    status: remainingIds.length === 0 ? "idle" : "running",
    processedCount: current.processedCount + 1,
    lastProcessedId
  } as const;
  await setSemanticQueueState({
    ...next,
    updatedAt: new Date().toISOString()
  });
  return next;
}

export async function hybridSearchLikes(
  tweets: LikedTweet[],
  query: SearchQuery
): Promise<{
  results: SearchResult[];
  semanticState: SemanticIndexState;
}> {
  const filtered = filterByCategories(tweets, query.categories);
  const semanticState = await enqueueMissingEmbeddings(filtered);
  const normalizedQuery = query.text.trim();
  const inferredCategories = normalizedQuery ? categorizeText(normalizedQuery).filter((value) => value !== "uncategorized") : [];

  if (!normalizedQuery) {
    return {
      results: filtered.map((tweet) => ({ ...tweet, score: 1, lexicalScore: 0, semanticScore: 0 })),
      semanticState
    };
  }

  const lexicalCandidates = filtered
    .map((tweet) => {
      const lexicalScore = scoreTextMatch(tweet, normalizedQuery);
      const recencyBoost = tweet.createdAt ? 0.15 : 0;
      const overlap = categoryOverlap(tweet, query.categories, inferredCategories);
      return { tweet, lexicalScore, recencyBoost, overlap };
    })
    .filter((item) => item.lexicalScore > 0 || item.overlap > 0 || normalizedQuery.length < MIN_QUERY_LENGTH_FOR_SEMANTIC)
    .sort(
      (left, right) =>
        right.lexicalScore + right.recencyBoost + right.overlap * 1.5 -
        (left.lexicalScore + left.recencyBoost + left.overlap * 1.5)
    );

  if (normalizedQuery.length < MIN_QUERY_LENGTH_FOR_SEMANTIC) {
    return {
      results: lexicalCandidates
        .map(({ tweet, lexicalScore, recencyBoost, overlap }) => ({
          ...tweet,
          score: lexicalScore + recencyBoost + overlap,
          lexicalScore,
          semanticScore: 0,
          whyMatched: buildWhyMatched(tweet, normalizedQuery, lexicalScore, 0, query.categories, inferredCategories)
        }))
        .slice(0, MAX_SEMANTIC_RERANK),
      semanticState
    };
  }

  const candidateTweets = lexicalCandidates.slice(0, MAX_SEMANTIC_RERANK).map((item) => item.tweet);
  const embeddingMap = await getEmbeddingMap(candidateTweets.map((tweet) => tweet.id));
  const coverage = computeCoverage(candidateTweets.length, embeddingMap.size);
  const extractor = await getExtractor();
  const queryOutput = await extractor(buildQueryEmbeddingText(query, inferredCategories), {
    pooling: "mean",
    normalize: true
  });
  const queryVector = toVector(queryOutput.data, queryOutput.dims);
  const semanticWeight = coverage >= 0.6 ? 10 : coverage >= 0.3 ? 6 : 2.5;
  const results = await Promise.all(
    candidateTweets.map(async (tweet) => {
      const lexicalScore = scoreTextMatch(tweet, normalizedQuery);
      const semanticVector = embeddingMap.get(tweet.id)?.vector ?? [];
      const semanticScore = cosineSimilarity(queryVector, semanticVector);
      const recencyBoost = tweet.createdAt ? 0.15 : 0;
      const semanticTopics = await inferSemanticTopicsFromVector(semanticVector);
      const nextCategories = Array.from(
        new Set([...tweet.categories.filter((value) => value !== "uncategorized"), ...semanticTopics])
      ) as LikedTweet["categories"];
      const enrichedTweet = nextCategories.length > 0 ? { ...tweet, categories: nextCategories } : tweet;
      const overlap = categoryOverlap(enrichedTweet, query.categories, inferredCategories);
      const score = lexicalScore * 0.65 + semanticScore * semanticWeight + overlap * 1.4 + recencyBoost;
      return {
        ...enrichedTweet,
        score,
        lexicalScore,
        semanticScore,
        whyMatched: buildWhyMatched(
          enrichedTweet,
          normalizedQuery,
          lexicalScore,
          semanticScore,
          query.categories,
          inferredCategories,
          semanticTopics
        )
      };
    })
  );

  return {
    results: results
    .filter((tweet) => tweet.score > 0.15 || tweet.lexicalScore > 0)
    .sort((left, right) => right.score - left.score),
    semanticState
  };
}

export async function warmSemanticQueue(
  tweets: LikedTweet[],
  onProgress?: (state: SemanticIndexState) => void
): Promise<SemanticIndexState> {
  await enqueueMissingEmbeddings(tweets);
  const state = await processSemanticQueue(tweets, onProgress);
  if (state.pendingTweets > 0) {
    window.setTimeout(() => {
      void processSemanticQueue(tweets, onProgress).catch(() => undefined);
    }, 350);
  }
  return state;
}

export function getSemanticModelId() {
  return MODEL_ID;
}
