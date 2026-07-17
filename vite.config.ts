import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const repository = process.env.GITHUB_REPOSITORY?.split("/")[1] ?? "";
const isAccountSite = repository.endsWith(".github.io");
const base = repository && !isAccountSite ? `/${repository}/` : "/";

export default defineConfig({
  plugins: [vue()],
  base,
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
