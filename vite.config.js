import { defineConfig } from 'vite'
import { readFileSync } from 'fs'

let https;

try {
  https = {
    key: readFileSync('localhost.key'),
    cert: readFileSync('localhost.pem'),
    passphrase: "nanover",
  };
} catch (e) {
  console.log("SKIPPING HTTPS", e);
}

export default defineConfig({
  server: {
    https,
    port: 5500,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
        }
      }
    }
  }
})