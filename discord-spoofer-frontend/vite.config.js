import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/


export default defineConfig(({ mode }) => {
  // const env = loadEnv(mode, process.cwd(), 'VITE_');
  // const port = Number(env.VITE_PORT) || 5173;
  return {
    plugins: [react()],
    server: {
      host: "0.0.0.0",
      port: 80
    },
    build: {
      assetsDir: 'static',
    },
  }
}
);
