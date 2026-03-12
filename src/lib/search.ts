import type { LikedTweet, SearchQuery, SearchResult } from "../types";

export function parseSearchQuery(raw: string, selectedCategories: SearchQuery["categories"]): SearchQuery {
  const authorHandles = Array.from(
    new Set(
      Array.from(raw.matchAll(/@([A-Za-z0-9_]+)/g)).map((match) => match[1].toLowerCase())
    )
  );

  const dateFromMatch = raw.match(/\b(?:from|since|after):(\d{4}-\d{2}-\d{2})\b/i);
  const dateToMatch = raw.match(/\b(?:to|until|before):(\d{4}-\d{2}-\d{2})\b/i);

  const cleaned = raw
    .replace(/@([A-Za-z0-9_]+)/g, " ")
    .replace(/\b(?:from|since|after):\d{4}-\d{2}-\d{2}\b/gi, " ")
    .replace(/\b(?:to|until|before):\d{4}-\d{2}-\d{2}\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    text: cleaned,
    categories: selectedCategories,
    authorHandles,
    dateFrom: dateFromMatch?.[1],
    dateTo: dateToMatch?.[1]
  };
}

export function scoreTextMatch(tweet: LikedTweet, query: string): number {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return 1;
  }

  let score = 0;
  const textFields = [tweet.text, tweet.originalTweet.text, tweet.quotedTweet?.text ?? ""].map((value) =>
    value.toLowerCase()
  );
  const metadataFields = [
    tweet.socialContext.label ?? "",
    tweet.authorName,
    tweet.authorHandle,
    tweet.originalTweet.authorName,
    tweet.originalTweet.authorHandle,
    tweet.quotedTweet?.authorName ?? "",
    tweet.quotedTweet?.authorHandle ?? ""
  ].map((value) => value.toLowerCase());
  const allFields = [...textFields, ...metadataFields];

  if (textFields.some((value) => value.includes(normalizedQuery))) {
    score += 10;
  }

  if (metadataFields.some((value) => value.includes(normalizedQuery))) {
    score += 5;
  }

  for (const keyword of tweet.keywords) {
    if (keyword.includes(normalizedQuery)) {
      score += 3;
    }
  }

  for (const term of normalizedQuery.split(/\s+/)) {
    if (!term) {
      continue;
    }

    if (textFields.some((value) => value.includes(term))) {
      score += 2;
    } else if (metadataFields.some((value) => value.includes(term))) {
      score += 1;
    }
  }

  if (tweet.categories.some((category) => normalizedQuery.includes(category))) {
    score += 2;
  }

  if (allFields.some((value) => value.startsWith(normalizedQuery))) {
    score += 2;
  }

  return score;
}

export function searchLikes(tweets: LikedTweet[], query: SearchQuery): SearchResult[] {
  return tweets
    .map((tweet) => {
      const categoryScore =
        query.categories.length === 0 || query.categories.every((category) => tweet.categories.includes(category))
          ? 2
          : -100;
      const lexicalScore = scoreTextMatch(tweet, query.text);
      const score = categoryScore + lexicalScore;
      return { ...tweet, score, lexicalScore, semanticScore: 0 };
    })
    .filter((tweet) => tweet.score > 0)
    .sort((left, right) => right.score - left.score);
}

export function filterByCategories(tweets: LikedTweet[], categories: SearchQuery["categories"]): LikedTweet[] {
  if (categories.length === 0) {
    return tweets;
  }

  return tweets.filter((tweet) => categories.every((category) => tweet.categories.includes(category)));
}

export function filterByStructuredQuery(tweets: LikedTweet[], query: SearchQuery): LikedTweet[] {
  return tweets.filter((tweet) => {
    if (query.categories.length > 0 && !query.categories.every((category) => tweet.categories.includes(category))) {
      return false;
    }

    if (query.authorHandles && query.authorHandles.length > 0) {
      const authorPool = [
        tweet.authorHandle,
        tweet.originalTweet.authorHandle,
        tweet.quotedTweet?.authorHandle ?? ""
      ].map((value) => value.toLowerCase());
      if (!query.authorHandles.some((handle) => authorPool.includes(handle))) {
        return false;
      }
    }

    const createdAt = tweet.createdAt ? new Date(tweet.createdAt).getTime() : undefined;
    if (query.dateFrom && createdAt !== undefined && createdAt < new Date(query.dateFrom).getTime()) {
      return false;
    }
    if (query.dateTo && createdAt !== undefined && createdAt > new Date(query.dateTo).getTime()) {
      return false;
    }

    return true;
  });
}
