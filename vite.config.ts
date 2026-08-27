import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

// Dev-server endpoint that mints short-lived fal.ai realtime tokens, so the
// API key stays server-side instead of shipping to the browser. Request format
// taken from @fal-ai/client's own getTemporaryAuthToken
// (node_modules/@fal-ai/client/src/auth.js): POST {restApiUrl}/tokens/ with
// allowed_apps: [endpoint alias] and Authorization: Key <FAL_KEY>.
const falTokenEndpoint = (key?: string): Plugin => ({
  name: 'fal-token-endpoint',
  configureServer(server) {
    server.middlewares.use('/api/fal/token', (req, res) => {
      void (async () => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('Method not allowed')
          return
        }
        if (!key) {
          res.statusCode = 500
          res.end('FAL_KEY missing — add it to .env and restart the dev server')
          return
        }
        try {
          const response = await fetch('https://rest.fal.ai/tokens/', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Key ${key}`,
            },
            body: JSON.stringify({
              // Alias of fal-ai/flux-2/klein/realtime
              allowed_apps: ['flux-2'],
              token_expiration: 120,
            }),
          })
          let token = await response.text()
          // The REST endpoint returns a JSON-encoded string; unwrap it so the
          // client gets the bare token
          try {
            const parsed: unknown = JSON.parse(token)
            if (typeof parsed === 'string') {
              token = parsed
            }
          } catch {
            // already a bare string
          }
          res.statusCode = response.status
          res.end(token)
        } catch (error) {
          res.statusCode = 502
          res.end(String(error))
        }
      })()
    })

    // Describes a reference image's visual style with fal's any-llm/vision
    // endpoint (see research/fal-any-llm-vision.md). The realtime Flux
    // endpoint has no reference-image input, so "style from image" works by
    // turning the image into a text prompt.
    server.middlewares.use('/api/fal/describe', (req, res) => {
      void (async () => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('Method not allowed')
          return
        }
        if (!key) {
          res.statusCode = 500
          res.end('FAL_KEY missing — add it to .env and restart the dev server')
          return
        }
        try {
          let body = ''
          for await (const chunk of req) {
            body += chunk
          }
          const { image } = JSON.parse(body) as { image?: string }
          if (!image?.startsWith('data:image/')) {
            res.statusCode = 400
            res.end('Expected JSON body with an `image` data URI')
            return
          }
          const response = await fetch('https://fal.run/fal-ai/any-llm/vision', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Key ${key}`,
            },
            body: JSON.stringify({
              model: 'google/gemini-2.5-flash-lite',
              image_urls: [image],
              prompt:
                'Describe the visual style of this image as a short phrase for an ' +
                'image editing prompt: material, texture, lighting and color palette. ' +
                'Ignore the subject matter. Respond with only the phrase, e.g. ' +
                '"a hand-stitched felt craft board with fabric textures and pastel colors".',
            }),
          })
          res.statusCode = response.status
          res.setHeader('Content-Type', 'application/json')
          res.end(await response.text())
        } catch (error) {
          res.statusCode = 502
          res.end(String(error))
        }
      })()
    })
  },
})

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Third argument '' loads all env vars, not just VITE_-prefixed ones
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), falTokenEndpoint(env.FAL_KEY)],
    optimizeDeps: {
      include: ['@bryntum/gantt', '@bryntum/gantt-react'],
    },
  }
})
