import type { ImportCheckpoint, LikedTweet } from "../types";

export interface ImportControllerState {
  seenIds: Set<string>;
  idleCycles: number;
  scrolls: number;
  lastTweetId?: string;
}

export interface ImportStepResult {
  freshTweets: LikedTweet[];
  checkpoint: ImportCheckpoint;
  status: "running" | "completed";
}

const DEFAULT_MAX_IDLE_CYCLES = 8;

export function createImportControllerState(seed?: Partial<ImportControllerState>): ImportControllerState {
  return {
    seenIds: seed?.seenIds ?? new Set<string>(),
    idleCycles: seed?.idleCycles ?? 0,
    scrolls: seed?.scrolls ?? 0,
    lastTweetId: seed?.lastTweetId
  };
}

export function advanceImportController(
  state: ImportControllerState,
  visibleTweets: LikedTweet[],
  capturedAt = new Date().toISOString(),
  maxIdleCycles = DEFAULT_MAX_IDLE_CYCLES
): ImportStepResult {
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
  return {
    freshTweets,
    checkpoint,
    status
  };
}

export function registerScroll(state: ImportControllerState) {
  state.scrolls += 1;
}

export function createCheckpoint(state: ImportControllerState, capturedAt = new Date().toISOString()): ImportCheckpoint {
  return {
    lastTweetId: state.lastTweetId,
    lastCapturedAt: capturedAt,
    seenCount: state.seenIds.size,
    idleCycles: state.idleCycles,
    scrolls: state.scrolls
  };
}
