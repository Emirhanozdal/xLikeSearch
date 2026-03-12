import { categorizeText, extractKeywords } from "./categorize";
import type { LikedTweet, TweetEntity, TweetSocialContext } from "../types";

export function extractVisibleLikedTweets(root: ParentNode = document): LikedTweet[] {
  const articles = Array.from(root.querySelectorAll<HTMLElement>('article[data-testid="tweet"]'));

  return articles
    .map((article) => parseTweetArticle(article))
    .filter((tweet): tweet is LikedTweet => tweet !== null);
}

export function parseTweetArticle(article: HTMLElement): LikedTweet | null {
  const primaryStatusLink = getPrimaryStatusLink(article);
  if (!primaryStatusLink) {
    return null;
  }

  const tweetId = extractStatusId(primaryStatusLink.href);
  if (!tweetId) {
    return null;
  }

  const quotedTweet = extractQuotedTweet(article);
  const mainText = getPrimaryTweetText(article);
  const author = extractAuthor(article, primaryStatusLink);
  const media = extractMedia(article);
  const createdAt = article.querySelector<HTMLTimeElement>("time")?.dateTime;
  const socialContext = extractSocialContext(article);

  if (!mainText) {
    return null;
  }

  const originalTweet: TweetEntity = {
    id: tweetId,
    text: mainText,
    authorName: author.name,
    authorHandle: author.handle,
    createdAt,
    url: primaryStatusLink.href,
    media
  };

  return {
    id: tweetId,
    canonicalId: quotedTweet?.id ?? tweetId,
    text: mainText,
    authorName: author.name,
    authorHandle: author.handle,
    createdAt,
    url: primaryStatusLink.href,
    media,
    originalTweet,
    quotedTweet,
    socialContext,
    categories: categorizeText([mainText, quotedTweet?.text ?? "", socialContext.label ?? ""].join("\n")),
    keywords: extractKeywords([mainText, quotedTweet?.text ?? ""].join(" ")),
    capturedAt: new Date().toISOString()
  };
}

function getPrimaryStatusLink(article: HTMLElement): HTMLAnchorElement | null {
  const quoteNode = article.querySelector<HTMLElement>('[data-testid="quoteTweet"]');

  return (
    Array.from(article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]')).find(
      (link) => !quoteNode?.contains(link)
    ) ?? null
  );
}

function getPrimaryTweetText(article: HTMLElement): string {
  const quoteNode = article.querySelector<HTMLElement>('[data-testid="quoteTweet"]');
  const textNodes = Array.from(article.querySelectorAll<HTMLElement>('[data-testid="tweetText"]')).filter(
    (node) => !quoteNode?.contains(node)
  );

  return normalizeText(textNodes.map(getNodeText).find(Boolean) ?? getNodeText(article));
}

function extractQuotedTweet(article: HTMLElement): TweetEntity | undefined {
  const quote = article.querySelector<HTMLElement>('[data-testid="quoteTweet"]');
  if (!quote) {
    return undefined;
  }

  const link = quote.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
  const id = link ? extractStatusId(link.href) : null;
  const textNode = quote.querySelector<HTMLElement>('[data-testid="tweetText"]');
  const text = normalizeText(textNode ? getNodeText(textNode) : getNodeText(quote));
  if (!id || !text) {
    return undefined;
  }

  const author = extractAuthor(quote, link ?? undefined);

  return {
    id,
    text,
    authorName: author.name,
    authorHandle: author.handle,
    createdAt: quote.querySelector<HTMLTimeElement>("time")?.dateTime,
    url: link?.href ?? "",
    media: extractMedia(quote)
  };
}

function extractAuthor(container: ParentNode, statusLink?: HTMLAnchorElement | null): { name: string; handle: string } {
  const pathname = statusLink ? new URL(statusLink.href).pathname : "";
  const statusHandle = pathname.split("/").filter(Boolean)[0];
  const profileLinks = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href]')).filter((link) => {
    try {
      const url = new URL(link.href);
      return /^\/[A-Za-z0-9_]+$/.test(url.pathname);
    } catch {
      return false;
    }
  });

  const exactHandleLink =
    profileLinks.find((link) => new URL(link.href).pathname.replace("/", "") === statusHandle) ?? profileLinks[0];

  const handle = exactHandleLink
    ? new URL(exactHandleLink.href).pathname.replace("/", "")
    : statusHandle || "unknown";

  const textCandidates = profileLinks
    .map((link) => normalizeText(getNodeText(link)))
    .filter(Boolean)
    .filter((value) => value !== `@${handle}` && value !== handle);

  return {
    name: textCandidates[0] ?? handle,
    handle
  };
}

function extractSocialContext(article: HTMLElement): TweetSocialContext {
  const contextNode = Array.from(article.querySelectorAll<HTMLElement>('[data-testid], span, div'))
    .map((node) => normalizeText(getNodeText(node)))
    .find((text) => /reposted|retweeted/i.test(text));

  if (contextNode) {
    return {
      type: "reposted",
      label: contextNode
    };
  }

  if (article.querySelector('[data-testid="quoteTweet"]')) {
    return {
      type: "quoted",
      label: "Quoted tweet"
    };
  }

  return {
    type: "liked",
    label: "Liked tweet"
  };
}

function extractMedia(container: ParentNode): string[] {
  return Array.from(container.querySelectorAll<HTMLImageElement>("img"))
    .map((image) => image.src)
    .filter((src) => src && !src.includes("profile_images"));
}

function extractStatusId(url: string): string | null {
  return url.match(/status\/(\d+)/)?.[1] ?? null;
}

function getNodeText(node: Element): string {
  return "innerText" in node && typeof node.innerText === "string" && node.innerText
    ? node.innerText
    : node.textContent ?? "";
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
