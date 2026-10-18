import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
    plugins: [react()],
    base: "./",
    server: {
        // `npm run dev` talks to a separately started Flask backend.
        proxy: { "/api": "http://127.0.0.1:".concat(process.env.FLASK_PORT || 5050) },
    },
    build: {
        outDir: "../static/dist",
        emptyOutDir: true
    }
});
