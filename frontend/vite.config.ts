import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return {
    plugins: [react()],
    server: {
      proxy: {
        "/api": {
          target: env.VITE_API_PROXY_TARGET || "http://127.0.0.1:8016",
          changeOrigin: true,
        },
      },
    },
    build: {
      chunkSizeWarningLimit: 650,
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              {
                name: "echarts-vendor",
                test: /node_modules[\\/](echarts|zrender)[\\/]/,
                priority: 30,
              },
              {
                name: "react-vendor",
                test: /node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/,
                priority: 20,
              },
            ],
          },
        },
      },
    },
  };
});
