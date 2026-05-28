import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    setupFiles: ["src/__tests__/setup.ts"],
    include: ["src/__tests__/**/*.test.ts"],
    // All tests share the same in-memory store Maps — must run in one process
    pool: "forks",
    forks: { singleFork: true },
    sequence: { shuffle: false },
  },
  resolve: {
    alias: [
      // TypeScript CJS source files use .js extensions in imports (e.g. "../store/index.js")
      // but the actual files are .ts. Strip .js from relative imports so Vite finds the .ts files.
      { find: /^(\.{1,2}\/.+)\.js$/, replacement: "$1" },
    ],
  },
});
