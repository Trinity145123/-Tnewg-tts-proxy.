require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
const app = express();

// TEMPORARY: allow any origin so this works immediately during setup.
// Once your site has a final URL, replace '*' below with that exact URL
// (e.g. 'https://yourdomain.com') so strangers can't ride on your API key
// by pointing their own site at your proxy.
app.use(cors({ origin: 'https://tnewg-tts-proxy.onrender.com' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname)));
app.use(cookieParser());

const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET;

if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
    .then(() => console.log('MongoDB connected'))
    .catch(err => console.error('MongoDB connection error:', err.message));
} else {
  console.error('MONGODB_URI is not set — signup/login will not work.');
}

const userSchema = new mongoose.Schema({
  name: { type: String, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function issueSessionCookie(res, user) {
  const token = jwt.sign({ uid: user._id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('newg_session', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

app.post('/api/signup', async (req, res) => {
  try {
    if (!JWT_SECRET || !MONGODB_URI) {
      return res.status(500).json({ error: 'Server not configured yet.' });
    }
    const { name, email, password } = req.body || {};
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ error: 'Email already registered.' });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({ name, email: email.toLowerCase(), passwordHash });
    issueSessionCookie(res, user);
    res.status(201).json({ ok: true, email: user.email, name: user.name });
  } catch (err) {
    console.error('Signup error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    if (!JWT_SECRET || !MONGODB_URI) {
      return res.status(500).json({ error: 'Server not configured yet.' });
    }
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }
    issueSessionCookie(res, user);
    res.status(200).json({ ok: true, email: user.email, name: user.name });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.get('/api/me', (req, res) => {
  const token = req.cookies && req.cookies.newg_session;
  if (!token) return res.json({ loggedIn: false });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    res.json({ loggedIn: true, email: payload.email });
  } catch {
    res.json({ loggedIn: false });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('newg_session');
  res.json({ ok: true });
});
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
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'index.html')));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Inworld TTS proxy listening on port ${PORT}`));
