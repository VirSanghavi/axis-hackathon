import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// base "./" keeps asset URLs relative, so the same build works when the hub
// serves it at "/" and when Vercel serves it from any path.
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: { fs: { allow: [".."] } },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", sourcemap: false },
});
