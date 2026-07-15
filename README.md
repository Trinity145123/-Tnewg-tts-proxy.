# NewG Inworld TTS Proxy

A tiny server that holds your Inworld API key privately and forwards
text-to-speech requests from the site. The key never reaches the browser.

## What this does

- Exposes `POST /api/tts` — takes `{ text, voice_id }`, calls Inworld's TTS
  API server-side, returns `{ audioContent: "<base64 mp3>" }`.
- Exposes `GET /health` — returns `{ ok: true }`, useful to confirm the
  server is actually running after deploy.
- Rejects any `voice_id` not in Inworld's known voice list (defends against
  garbage/abuse input).
- Basic per-IP rate limiting (30 requests/minute) so a leaked URL can't be
  used to run up unlimited usage on your key.

## 1. Get your Inworld API key

Follow the steps from the Inworld integration guide:
- https://platform.inworld.ai/api-keys — sign in, click "Generate new key",
  copy the "Basic (Base64)" key.

## 2. Run it locally first (optional but recommended)

```bash
cd inworld-tts-proxy
npm install
cp .env.example .env
# edit .env and paste your real key in place of the placeholder
npm start
```

Then in another terminal:
```bash
curl http://localhost:3000/health
curl -X POST http://localhost:3000/api/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello, this is a test.","voice_id":"Deborah"}'
```
You should get back JSON with a long `audioContent` base64 string. If you
get an error instead, the message will say why (bad/missing key, bad
voice_id, etc.) — fix that before deploying.

## 3. Deploy to Render (or Railway — same idea)

1. Push this folder to a GitHub repo.
2. On Render.com: New → Web Service → connect the repo.
3. Build command: `npm install` — Start command: `npm start`.
4. Under Environment, add `INWORLD_API_KEY` with your real key as the value.
   Do NOT put the key in the code or commit it — only in the platform's
   environment variable settings.
5. Deploy. Render will give you a URL like
   `https://newg-tts-proxy.onrender.com`.
6. Confirm it works: visit `https://newg-tts-proxy.onrender.com/health`
   in a browser — you should see `{"ok":true}`.

## 4. Point the site at it

In the site's `index.html`, find this line near the top of the `<script>`
block:

```js
const TTS_PROXY_URL = ''; // <-- paste your deployed proxy URL + /api/tts here
```

Fill it in, e.g.:

```js
const TTS_PROXY_URL = 'https://newg-tts-proxy.onrender.com/api/tts';
```

Save, and the site will use the real Inworld voices. If the URL is left
blank, or the proxy is unreachable for any reason, the site automatically
falls back to the browser's built-in voice so it never breaks — it just
won't sound as good until the proxy is live.

## 5. Lock down CORS once your site has a permanent URL

Right now `server.js` allows requests from any origin (`origin: '*'`), so
setup isn't blocked on knowing your final site URL. Once the site is at
its permanent address, open `server.js` and change:

```js
app.use(cors({ origin: '*' }));
```

to:

```js
app.use(cors({ origin: 'https://your-actual-site-url.com' }));
```

This stops other people from pointing their own projects at your proxy
and spending your Inworld usage.

## Notes on cost

Inworld bills per character synthesized. The site chunks long answers into
~180-character pieces before sending them, so a single answer is several
requests, not one giant one — keep that in mind if you're watching usage
on Inworld's dashboard.
