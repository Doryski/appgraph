/// <reference types="node" />
import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { viteSingleFile } from "vite-plugin-singlefile"

const fromHere = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))

export default defineConfig({
  root: fromHere("./"),
  base: "./",
  mode: "production",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  publicDir: false,
  plugins: [react(), tailwindcss(), viteSingleFile({ removeViteModuleLoader: true })],
  resolve: {
    alias: {
      "@/": fromHere("./src/"),
      "@appgraph/": fromHere("../src/"),
    },
  },
  build: {
    outDir: fromHere("./dist"),
    emptyOutDir: true,
    modulePreload: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    chunkSizeWarningLimit: Number.MAX_SAFE_INTEGER,
    reportCompressedSize: false,
  },
})
