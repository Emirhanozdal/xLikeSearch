import type { TweetCategory } from "../types";

const CATEGORY_RULES: Record<TweetCategory, string[]> = {
  rag: [
    "rag",
    "retrieval",
    "vector",
    "embedding",
    "embeddings",
    "retriever",
    "knowledge base",
    "semantic search",
    "rerank",
    "reranker",
    "hybrid search",
    "chunking",
    "grounding",
    "indexing"
  ],
  "fine-tuning": [
    "fine-tuning",
    "finetuning",
    "fine tuning",
    "sft",
    "lora",
    "qlora",
    "dpo",
    "grpo",
    "pretrain",
    "post-training",
    "alignment",
    "distillation"
  ],
  agents: [
    "agent",
    "agents",
    "assistant",
    "tool use",
    "tool-use",
    "tool calling",
    "tool-calling",
    "multi-agent",
    "workflow",
    "browser use",
    "computer use",
    "operator",
    "orchestration"
  ],
  evals: [
    "eval",
    "evals",
    "evaluation",
    "benchmark",
    "judge",
    "grading",
    "test set",
    "leaderboard",
    "accuracy",
    "recall",
    "precision",
    "hallucination"
  ],
  infra: [
    "latency",
    "gpu",
    "cuda",
    "serving",
    "inference",
    "throughput",
    "database",
    "index",
    "cache",
    "runtime",
    "kernel",
    "webgpu",
    "onnx",
    "wasm",
    "cpu",
    "memory"
  ],
  product: [
    "growth",
    "pricing",
    "market",
    "launch",
    "distribution",
    "saas",
    "users",
    "customer",
    "retention",
    "onboarding",
    "roadmap",
    "conversion",
    "positioning"
  ],
  design: [
    "design",
    "ux",
    "ui",
    "prototype",
    "layout",
    "visual",
    "motion",
    "interface",
    "typography",
    "interaction",
    "wireframe",
    "figma"
  ],
  uncategorized: []
};

export function extractKeywords(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, " ")
        .split(/[^a-z0-9+#.-]+/i)
        .filter((token) => token.length >= 3)
    )
  );
}

export function categorizeText(text: string): TweetCategory[] {
  const normalized = text.toLowerCase();
  const categories = Object.entries(CATEGORY_RULES)
    .filter(([category, terms]) => {
      if (category === "uncategorized") {
        return false;
      }

      let matches = 0;
      for (const term of terms) {
        if (normalized.includes(term)) {
          matches += 1;
        }
      }

      return matches > 0;
    })
    .map(([category]) => category as TweetCategory);

  return categories.length > 0 ? categories : ["uncategorized"];
}
