import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function fromRoot(path: string) {
  return new URL(path, import.meta.url).pathname;
}

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidepanel: fromRoot("./sidepanel.html"),
        background: fromRoot("./src/background.ts"),
        content: fromRoot("./src/content.ts"),
        pageBridge: fromRoot("./src/pageBridge.ts")
      },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name].[ext]"
      }
    }
  }
});
