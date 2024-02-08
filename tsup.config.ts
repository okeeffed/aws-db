/**
 * This needs to be updated for usage with TurboRepo.
 * @see https://github.com/vercel/turbo/issues/2903
 */
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["index.ts"],
  sourcemap: true,
});
