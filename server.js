require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

// TEMPORARY: allow any origin so this works immediately during setup.
// Once your site has a final URL, replace '*' below with that exact URL
// (e.g. 'https://yourdomain.com') so strangers can't ride on your API key
// by pointing their own site at your proxy.
app.use(cors({ origin: 'https://tnewg-tts-proxy.onrender.com' }));
app.use(express.json({ limit: '1mb' }));

const INWORLD_API_KEY = process.env.INWORLD_API_KEY;
if (!INWORLD_API_KEY) {
  console.error('Missing INWORLD_API_KEY environment variable — set it before starting the server.');
}

const ALLOWED_VOICE_IDS = new Set([
  'Loretta','Darlene','Marlene','Hank','Evelyn','Celeste','Pippa','Tessa','Liam','Callum',
  'Hamish','Abby','Graham','Rupert','Mortimer','Snik','Anjali','Saanvi','Arjun','Claire',
  'Oliver','Simon','Elliot','James','Serena','Gareth','Vinny','Lauren','Jessica','Ethan',
  'Tyler','Jason','Chloe','Veronica','Victoria','Miranda','Sebastian','Victor','Malcolm',
  'Nate','Brian','Amina','Kelsey','Derek','Evan','Kayla','Jake','Grant','Tristan','Nadia',
  'Selene','Marcus','Riley','Damon','Cedric','Mia','Naomi','Jonah','Levi','Avery','Brandon',
  'Conrad','Bianca','Lucian','Trevor','Alex','Ashley','Craig','Deborah','Dennis','Edward',
  'Elizabeth','Hades','Julia','Pixie','Mark','Olivia','Priya','Ronald','Sarah','Shaun',
  'Theodore','Timothy','Wendy','Dominus','Hana','Clive','Carter','Blake','Luna','Reed',
  'Duncan','Felix','Eleanor','Sophie',
]);

// Simple in-memory rate limiter: caps requests per IP per minute so a leaked
// or scraped proxy URL can't be used to run up an unbounded bill. This is
// intentionally basic (resets on server restart, not shared across multiple
// server instances) — fine for a single small deployment, not a substitute
// for the origin-restriction step above once you have a real domain.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 30;
const requestLog = new Map(); // ip -> [timestamps]

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (requestLog.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  requestLog.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT_MAX_REQUESTS;
}

app.post('/api/tts', async (req, res) => {
  try {
    if (!INWORLD_API_KEY) {
      return res.status(500).json({ error: 'Server is missing INWORLD_API_KEY' });
    }

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    if (isRateLimited(ip)) {
      return res.status(429).json({ error: 'Too many requests, slow down' });
    }

    const { text, voice_id } = req.body || {};
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'Missing or invalid "text"' });
    }
    if (text.length > 2000) {
      return res.status(400).json({ error: 'Text exceeds the 2000 character limit per request' });
    }

    const chosenVoice = ALLOWED_VOICE_IDS.has(voice_id) ? voice_id : 'Dennis';

    const inworldResp = await fetch('https://api.inworld.ai/tts/v1/voice', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${INWORLD_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        voice_id: chosenVoice,
        model_id: 'inworld-tts-2',
        audio_config: {
          audio_encoding: 'MP3',
          sample_rate_hertz: 48000,
        },
      }),
    });

    if (!inworldResp.ok) {
      const errText = await inworldResp.text().catch(() => '');
      console.error('Inworld API error:', inworldResp.status, errText);
      return res.status(502).json({ error: 'TTS provider returned an error' });
    }

    const data = await inworldResp.json();
    if (!data.audioContent) {
      return res.status(502).json({ error: 'TTS provider returned no audio' });
    }

    res.json({ audioContent: data.audioContent });
  } catch (err) {
    console.error('Unhandled proxy error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Inworld TTS proxy listening on port ${PORT}`));
