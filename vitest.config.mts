import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // dist/ contem os testes ja transpilados por `npm run build`; coleta-los faria a
    // suite rodar duas vezes o mesmo caso e quebrar no formato CommonJS.
    exclude: ["node_modules", "dist"],
  },
});
