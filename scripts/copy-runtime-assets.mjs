import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const distAssets = resolve(root, "dist", "assets");

mkdirSync(distAssets, { recursive: true });

const files = [
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm"
];

for (const file of files) {
  copyFileSync(
    resolve(root, "node_modules", "@huggingface", "transformers", "dist", file),
    resolve(distAssets, file)
  );
}
