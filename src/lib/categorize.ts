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
  business: [
    "business",
    "company",
    "revenue",
    "profit",
    "sales",
    "founder",
    "enterprise",
    "operations",
    "strategy",
    "management"
  ],
  marketing: [
    "marketing",
    "brand",
    "branding",
    "content marketing",
    "seo",
    "copywriting",
    "audience",
    "campaign",
    "distribution",
    "newsletter"
  ],
  finance: [
    "finance",
    "investing",
    "investment",
    "stock",
    "stocks",
    "market cap",
    "valuation",
    "economy",
    "macro",
    "personal finance",
    "money"
  ],
  career: [
    "career",
    "hiring",
    "interview",
    "resume",
    "job",
    "promotion",
    "leadership",
    "manager",
    "mentorship",
    "networking"
  ],
  writing: [
    "writing",
    "essay",
    "storytelling",
    "copy",
    "blog",
    "thread",
    "editing",
    "narrative",
    "communication",
    "writing advice"
  ],
  health: [
    "health",
    "fitness",
    "sleep",
    "nutrition",
    "workout",
    "wellness",
    "diet",
    "recovery",
    "mental health",
    "exercise"
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
