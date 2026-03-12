import { describe, expect, it } from "vitest";
import {
  advanceImportController,
  createCheckpoint,
  createImportControllerState,
  registerScroll
} from "../src/lib/importController";
import type { LikedTweet } from "../src/types";

function makeTweet(id: string): LikedTweet {
  return {
    id,
    canonicalId: id,
    text: `tweet ${id}`,
    authorName: "Test User",
    authorHandle: "testuser",
    createdAt: "2026-03-11T10:00:00.000Z",
    url: `https://x.com/testuser/status/${id}`,
    media: [],
    originalTweet: {
      id,
      text: `tweet ${id}`,
      authorName: "Test User",
      authorHandle: "testuser",
      createdAt: "2026-03-11T10:00:00.000Z",
      url: `https://x.com/testuser/status/${id}`,
      media: []
    },
    socialContext: {
      type: "liked",
      label: "Liked tweet"
    },
    categories: ["uncategorized"],
    keywords: ["tweet"],
    capturedAt: "2026-03-11T10:00:00.000Z"
  };
}

describe("importController", () => {
  it("deduplicates tweets across steps", () => {
    const state = createImportControllerState();
    const first = advanceImportController(state, [makeTweet("1"), makeTweet("2")], "2026-03-11T10:00:01.000Z");
    const second = advanceImportController(state, [makeTweet("2"), makeTweet("3")], "2026-03-11T10:00:02.000Z");

    expect(first.freshTweets.map((tweet) => tweet.id)).toEqual(["1", "2"]);
    expect(second.freshTweets.map((tweet) => tweet.id)).toEqual(["3"]);
    expect(second.checkpoint.seenCount).toBe(3);
    expect(second.checkpoint.lastTweetId).toBe("3");
  });

  it("marks completion after repeated idle cycles", () => {
    const state = createImportControllerState();
    let result = advanceImportController(state, [makeTweet("1")], "2026-03-11T10:00:01.000Z");

    for (let index = 0; index < 8; index += 1) {
      result = advanceImportController(state, [], `2026-03-11T10:00:0${index + 2}.000Z`);
    }

    expect(result.status).toBe("completed");
    expect(result.checkpoint.idleCycles).toBe(8);
  });

  it("tracks scroll count and exposes checkpoints", () => {
    const state = createImportControllerState();

    advanceImportController(state, [makeTweet("1")], "2026-03-11T10:00:01.000Z");
    registerScroll(state);
    registerScroll(state);

    const checkpoint = createCheckpoint(state, "2026-03-11T10:00:05.000Z");

    expect(checkpoint.scrolls).toBe(2);
    expect(checkpoint.seenCount).toBe(1);
    expect(checkpoint.lastCapturedAt).toBe("2026-03-11T10:00:05.000Z");
  });
});
