import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { extractVisibleLikedTweets, parseTweetArticle } from "../src/lib/xParser";

const fixturesDir = resolve(process.cwd(), "tests", "fixtures");

function fixtureDocument(name: string): Document {
  const html = readFileSync(resolve(fixturesDir, name), "utf8");
  return new DOMParser().parseFromString(html, "text/html");
}

describe("xParser", () => {
  it("parses a basic liked tweet", () => {
    const document = fixtureDocument("liked-basic.html");
    const article = document.querySelector<HTMLElement>('article[data-testid="tweet"]');

    expect(article).not.toBeNull();
    const parsed = parseTweetArticle(article!);

    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe("111");
    expect(parsed?.authorHandle).toBe("alice");
    expect(parsed?.socialContext.type).toBe("liked");
    expect(parsed?.categories).toContain("rag");
  });

  it("detects reposted context", () => {
    const document = fixtureDocument("reposted.html");
    const parsed = parseTweetArticle(document.querySelector<HTMLElement>('article[data-testid="tweet"]')!);

    expect(parsed?.socialContext.type).toBe("reposted");
    expect(parsed?.socialContext.label?.toLowerCase()).toContain("reposted");
    expect(parsed?.categories).toContain("fine-tuning");
    expect(parsed?.categories).toContain("evals");
  });

  it("parses quoted tweets separately", () => {
    const document = fixtureDocument("quoted.html");
    const parsed = parseTweetArticle(document.querySelector<HTMLElement>('article[data-testid="tweet"]')!);

    expect(parsed?.socialContext.type).toBe("quoted");
    expect(parsed?.quotedTweet?.id).toBe("444");
    expect(parsed?.quotedTweet?.authorHandle).toBe("dan");
    expect(parsed?.keywords).toContain("agent");
  });

  it("ignores cards without a status link", () => {
    const document = fixtureDocument("no-status.html");
    const parsed = parseTweetArticle(document.querySelector<HTMLElement>('article[data-testid="tweet"]')!);

    expect(parsed).toBeNull();
  });

  it("extracts multiple visible tweets from a root node", () => {
    const basic = readFileSync(resolve(fixturesDir, "liked-basic.html"), "utf8");
    const quoted = readFileSync(resolve(fixturesDir, "quoted.html"), "utf8");
    const document = new DOMParser().parseFromString(`${basic}${quoted}`, "text/html");

    const tweets = extractVisibleLikedTweets(document);

    expect(tweets).toHaveLength(2);
    expect(tweets.map((tweet) => tweet.id)).toEqual(["111", "333"]);
  });
});
