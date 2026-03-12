import type { LikedTweet, SearchQuery, SearchResult } from "../types";

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
