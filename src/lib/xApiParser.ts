import { categorizeText, extractKeywords } from "./categorize";
import type { LikedTweet, TweetCategory, TweetEntity, TweetSocialContext } from "../types";

interface ParsedTimelinePage {
  tweets: LikedTweet[];
  bottomCursor?: string;
  topCursor?: string;
}

type UnknownRecord = Record<string, unknown>;

export function parseLikesTimelineResponse(payload: unknown): ParsedTimelinePage | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const tweets = collectTweets(payload);
  const cursors = collectCursors(payload);

  if (tweets.length === 0 && !cursors.bottomCursor && !cursors.topCursor) {
    return null;
  }

  return {
    tweets,
    bottomCursor: cursors.bottomCursor,
    topCursor: cursors.topCursor
  };
}

function collectTweets(payload: unknown): LikedTweet[] {
  const candidates = new Map<string, unknown>();
  for (const entry of collectTimelineEntries(payload)) {
    const tweet = extractEntryTweet(entry);
    const restId = readString(tweet, "rest_id");
    const legacy = readObject(tweet, "legacy");
    if (restId && legacy) {
      candidates.set(restId, tweet);
    }
  }

  const tweets: LikedTweet[] = [];
  for (const tweet of candidates.values()) {
    const parsed = toLikedTweet(tweet);
    if (parsed) {
      tweets.push(parsed);
    }
  }

  return tweets;
}

function collectTimelineEntries(payload: unknown): UnknownRecord[] {
  const entries: UnknownRecord[] = [];

  walk(payload, (node) => {
    const entryId = readString(node, "entryId");
    if (!entryId) {
      return;
    }

    if (
      entryId.startsWith("tweet-") ||
      entryId.startsWith("profile-conversation-") ||
      entryId.includes("who-to-follow") ||
      entryId.includes("cursor-")
    ) {
      entries.push(node);
    }
  });

  return entries;
}

function extractEntryTweet(entry: UnknownRecord): UnknownRecord | undefined {
  const content = readObject(entry, "content");
  const itemContent = readObject(content, "itemContent");
  const tweetResults =
    readObject(itemContent, "tweet_results") ??
    readObject(readObject(content, "content"), "tweet_results") ??
    readObject(readObject(content, "items"), "tweet_results");

  if (tweetResults) {
    return unwrapTweetResult(tweetResults);
  }

  const result = readObject(itemContent, "result");
  return result ? unwrapTweetResult(result) : undefined;
}

function collectCursors(payload: unknown): { bottomCursor?: string; topCursor?: string } {
  let bottomCursor: string | undefined;
  let topCursor: string | undefined;

  walk(payload, (node) => {
    const entryId = readString(node, "entryId");
    const content = readObject(node, "content");
    const cursorType =
      readString(content, "cursorType") ??
      readString(readObject(content, "itemContent"), "cursorType") ??
      readString(readObject(readObject(content, "content"), "cursorType"), "value");
    const value =
      readString(content, "value") ??
      readString(readObject(content, "itemContent"), "value") ??
      readString(readObject(readObject(content, "itemContent"), "content"), "value");

    const normalizedEntryId = entryId?.toLowerCase() ?? "";
    const normalizedCursor = cursorType?.toLowerCase() ?? "";
    if (!value) {
      return;
    }

    if (!bottomCursor && (normalizedCursor === "bottom" || normalizedEntryId.includes("cursor-bottom"))) {
      bottomCursor = value;
    }

    if (!topCursor && (normalizedCursor === "top" || normalizedEntryId.includes("cursor-top"))) {
      topCursor = value;
    }
  });

  return { bottomCursor, topCursor };
}

function toLikedTweet(node: unknown): LikedTweet | null {
  const tweet = unwrapTweetResult(node);
  const restId = readString(tweet, "rest_id");
  const legacy = readObject(tweet, "legacy");
  if (!restId || !legacy) {
    return null;
  }

  const author = readAuthor(tweet);
  const authorHandle = author.handle;
  const authorName = author.name;
  const text = readTweetText(tweet, legacy);
  if (!text) {
    return null;
  }

  const createdAt = readString(legacy, "created_at");
  const media = readMedia(legacy);
  const quotedTweet = readQuotedTweet(tweet);
  const socialContext = readSocialContext(tweet);
  const url = `https://x.com/${authorHandle}/status/${restId}`;
  const categoryText = [text, quotedTweet?.text ?? "", socialContext.label ?? "", authorName, authorHandle].join("\n");

  const originalTweet: TweetEntity = {
    id: restId,
    text,
    authorName,
    authorHandle,
    createdAt,
    url,
    media
  };

  return {
    id: restId,
    canonicalId: quotedTweet?.id ?? restId,
    text,
    authorName,
    authorHandle,
    createdAt,
    url,
    media,
    originalTweet,
    quotedTweet,
    socialContext,
    categories: limitCategories(categorizeText(categoryText)),
    keywords: extractKeywords([text, quotedTweet?.text ?? "", authorName, authorHandle].join(" ")),
    capturedAt: new Date().toISOString()
  };
}

function limitCategories(categories: TweetCategory[]): TweetCategory[] {
  if (categories.includes("uncategorized") && categories.length > 1) {
    return categories.filter((category) => category !== "uncategorized");
  }

  return categories.slice(0, 4);
}

function readQuotedTweet(tweet: unknown): TweetEntity | undefined {
  const quoted = unwrapTweetResult(
    readObject(readObject(tweet, "quoted_status_result"), "result") ??
      readObject(readObject(tweet, "quoted_status_result"), "tweet")
  );
  const restId = readString(quoted, "rest_id");
  const legacy = readObject(quoted, "legacy");
  if (!restId || !legacy) {
    return undefined;
  }

  const author = readAuthor(quoted);
  const authorHandle = author.handle;
  const authorName = author.name;

  return {
    id: restId,
    text: readTweetText(quoted, legacy),
    authorName,
    authorHandle,
    createdAt: readString(legacy, "created_at"),
    url: `https://x.com/${authorHandle}/status/${restId}`,
    media: readMedia(legacy)
  };
}

function readAuthor(tweet: unknown): { handle: string; name: string } {
  const direct =
    unwrapUserResult(readObject(readObject(readObject(tweet, "core"), "user_results"), "result")) ??
    unwrapUserResult(readObject(readObject(tweet, "author_results"), "result")) ??
    unwrapUserResult(readObject(tweet, "user_results")) ??
    unwrapUserResult(readObject(tweet, "user"));

  const directLegacy = readObject(direct, "legacy");
  const directHandle = readString(directLegacy, "screen_name");
  const directName = readString(directLegacy, "name");
  if (directHandle || directName) {
    const handle = directHandle ?? normalizeHandleFromString(readString(direct, "screen_name")) ?? "unknown";
    return {
      handle,
      name: directName ?? readString(direct, "name") ?? handle
    };
  }

  let fallbackHandle: string | undefined;
  let fallbackName: string | undefined;

  walk(tweet, (node) => {
    if (fallbackHandle && fallbackName) {
      return;
    }

    const legacy = readObject(node, "legacy");
    const screenName =
      readString(legacy, "screen_name") ??
      normalizeHandleFromString(readString(node, "screen_name")) ??
      normalizeHandleFromString(readString(node, "screenName"));
    const name = readString(legacy, "name") ?? readString(node, "name");

    if (!fallbackHandle && screenName) {
      fallbackHandle = screenName;
    }

    if (!fallbackName && name) {
      fallbackName = name;
    }
  });

  const handle = fallbackHandle ?? "unknown";
  return {
    handle,
    name: fallbackName ?? handle
  };
}

function readSocialContext(tweet: unknown): TweetSocialContext {
  const socialContext = readObject(tweet, "social_context");
  const contextType = readString(socialContext, "context_type");
  const text = readString(readObject(socialContext, "text"), "text") ?? readString(socialContext, "text");

  if (contextType?.toLowerCase().includes("retweet") || /repost|retweeted/i.test(text ?? "")) {
    return {
      type: "reposted",
      label: text ?? "Reposted tweet"
    };
  }

  if (readObject(tweet, "quoted_status_result")) {
    return {
      type: "quoted",
      label: text ?? "Quoted tweet"
    };
  }

  return {
    type: "liked",
    label: text ?? "Liked tweet"
  };
}

function readTweetText(tweet: unknown, legacy: UnknownRecord): string {
  const noteText = readString(
    readObject(
      readObject(readObject(tweet, "note_tweet"), "note_tweet_results"),
      "result"
    ),
    "text"
  );
  return noteText ?? readString(legacy, "full_text") ?? readString(legacy, "text") ?? "";
}

function readMedia(legacy: UnknownRecord): string[] {
  const urls = new Set<string>();
  const extendedMedia = readArray(readObject(readObject(legacy, "extended_entities"), "media"));
  const entityMedia = readArray(readObject(readObject(legacy, "entities"), "media"));

  for (const item of [...extendedMedia, ...entityMedia]) {
    const media = readObject(item);
    const mediaUrl = readString(media, "media_url_https") ?? readString(media, "media_url");
    if (mediaUrl) {
      urls.add(mediaUrl);
    }
  }

  return Array.from(urls);
}

function unwrapTweetResult(node: unknown): UnknownRecord | undefined {
  const object = readObject(node);
  if (!object) {
    return undefined;
  }

  const typename = readString(object, "__typename");
  if (typename === "Tweet" || typename === "TweetWithVisibilityResults") {
    return object;
  }

  const result = readObject(object, "result");
  if (result) {
    return unwrapTweetResult(result) ?? result;
  }

  const tweet = readObject(object, "tweet");
  if (tweet) {
    return unwrapTweetResult(tweet) ?? tweet;
  }

  const tweetResults = readObject(object, "tweet_results");
  if (tweetResults) {
    return unwrapTweetResult(tweetResults);
  }

  return object;
}

function unwrapUserResult(node: unknown): UnknownRecord | undefined {
  const object = readObject(node);
  if (!object) {
    return undefined;
  }

  const result = readObject(object, "result");
  if (result) {
    return unwrapUserResult(result) ?? result;
  }

  return object;
}

function normalizeHandleFromString(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.startsWith("@") ? value.slice(1) : value;
}

function walk(node: unknown, visitor: (node: UnknownRecord) => void) {
  if (!node || typeof node !== "object") {
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      walk(item, visitor);
    }
    return;
  }

  visitor(node as UnknownRecord);
  for (const value of Object.values(node as UnknownRecord)) {
    walk(value, visitor);
  }
}

function readObject(node: unknown, key?: string): UnknownRecord | undefined {
  if (!node || typeof node !== "object") {
    return undefined;
  }

  if (!key) {
    return node as UnknownRecord;
  }

  const value = (node as UnknownRecord)[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : undefined;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(node: unknown, key?: string): string | undefined {
  const value = key ? (node as UnknownRecord | undefined)?.[key] : node;
  return typeof value === "string" ? value : undefined;
}
