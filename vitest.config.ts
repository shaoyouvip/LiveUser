import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          VISITOR_HMAC_SECRET: "test-only-liveuser-secret-0123456789abcdef",
        },
      },
    }),
  ],
});
