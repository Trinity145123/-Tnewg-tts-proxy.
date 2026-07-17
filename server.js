const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

require('dotenv').config();

const app = express();
app.use(cookieParser());
app.use(cors({ origin: 'https://tnewg-tts-proxy.onrender.com', credentials: true }));

// Stripe webhook needs raw body — must come BEFORE express.json()
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
    let event;
    if (STRIPE_WEBHOOK_SECRET) {
      const sig = req.headers['stripe-signature'];
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } else {
      event = JSON.parse(req.body);
    }
    if (event.type === 'checkout.session.completed' || event.type === 'invoice.paid') {
      const customerId = event.data.object.customer;
      if (customerId) {
        await User.findOneAndUpdate({ stripeCustomerId: customerId }, { subscriptionStatus: 'active' });
        console.log('Subscription activated for customer:', customerId);
      }
    }
    if (event.type === 'customer.subscription.deleted' || event.type === 'invoice.payment_failed') {
      const customerId = event.data.object.customer;
      if (customerId) {
        await User.findOneAndUpdate({ stripeCustomerId: customerId }, { subscriptionStatus: 'free' });
        console.log('Subscription cancelled for customer:', customerId);
      }
    }
    res.json({ received: true });
  } catch(err) {
    console.error('Webhook error:', err);
    return res.status(400).json({ error: 'Webhook error' });
  }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

// MongoDB
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI environment variable.');
} else {
  mongoose.connect(MONGODB_URI)
    .then(() => console.log('Connected to MongoDB.'))
    .catch(err => console.error('MongoDB connection error:', err));
}

const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  stripeCustomerId: { type: String },
  subscriptionStatus: { type: String, default: 'free' },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

const INWORLD_API_KEY = process.env.INWORLD_API_KEY;
if (!INWORLD_API_KEY) console.error('Missing INWORLD_API_KEY.');

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

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 30;
const requestLog = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (requestLog.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  requestLog.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT_MAX_REQUESTS;
}

// JWT helper
function getJwtSecret() { return process.env.JWT_SECRET || 'fallback_secret'; }
function verifySession(req) {
  const token = req.cookies.newg_session;
  if (!token) return null;
  try { return jwt.verify(token, getJwtSecret()); }
  catch(e) { return null; }
}
function issueSessionCookie(res, payload) {
  const token = jwt.sign(payload, getJwtSecret(), { expiresIn: '7d' });
  res.cookie('newg_session', token, { httpOnly: true, secure: true, sameSite: 'strict', maxAge: 7*24*60*60*1000 });
}

// --- AUTH ---
app.post('/api/signup', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || typeof email !== 'string') return res.status(400).json({ error: 'Email is required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email format' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    const normalizedEmail = email.trim().toLowerCase();
    if (await User.findOne({ email: normalizedEmail })) return res.status(409).json({ error: 'Email already registered' });
    const passwordHash = await bcrypt.hash(password, 10);
    const newUser = new User({ email: normalizedEmail, passwordHash });
    await newUser.save();
    issueSessionCookie(res, { userId: newUser._id, email: newUser.email });
    return res.status(201).json({ ok: true, email: newUser.email });
  } catch(err) { console.error('Signup error:', err); return res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const user = await User.findOne({ email: email.trim().toLowerCase() });
    if (!user || !(await bcrypt.compare(password, user.passwordHash)))
      return res.status(401).json({ error: 'Incorrect email or password' });
    issueSessionCookie(res, { userId: user._id, email: user.email });
    return res.status(200).json({ ok: true, email: user.email });
  } catch(err) { console.error('Login error:', err); return res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/me', async (req, res) => {
  const decoded = verifySession(req);
  if (!decoded) return res.status(401).json({ error: 'Not authenticated' });
  return res.json({ email: decoded.email });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('newg_session', { httpOnly: true, secure: true, sameSite: 'strict' });
  return res.json({ ok: true });
});

// --- SUBSCRIPTION ---
app.get('/api/subscription', async (req, res) => {
  try {
    const decoded = verifySession(req);
    if (!decoded) return res.json({ status: 'free' });
    const user = await User.findById(decoded.userId);
    return res.json({ status: user ? (user.subscriptionStatus || 'free') : 'free' });
  } catch(err) { return res.json({ status: 'free' }); }
});

app.post('/api/create-checkout', async (req, res) => {
  try {
    const decoded = verifySession(req);
    if (!decoded) return res.status(401).json({ error: 'Please log in to subscribe' });
    const user = await User.findById(decoded.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email });
      customerId = customer.id;
      await User.findByIdAndUpdate(decoded.userId, { stripeCustomerId: customerId });
    }
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      mode: 'subscription',
      success_url: 'https://tnewg-tts-proxy.onrender.com/?subscribed=1',
      cancel_url: 'https://tnewg-tts-proxy.onrender.com/?cancelled=1',
    });
    return res.json({ url: session.url });
  } catch(err) { console.error('Checkout error:', err); return res.status(500).json({ error: 'Could not create checkout session' }); }
});

// --- TTS PROXY ---
app.post('/api/tts', async (req, res) => {
  try {
    if (!INWORLD_API_KEY) return res.status(500).json({ error: 'Server is missing INWORLD_API_KEY' });
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    if (isRateLimited(ip)) return res.status(429).json({ error: 'Too many requests, slow down' });
    const { text, voice_id } = req.body || {};
    if (!text || typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Missing or invalid "text"' });
    if (text.length > 2000) return res.status(400).json({ error: 'Text exceeds 2000 character limit' });
    const chosenVoice = ALLOWED_VOICE_IDS.has(voice_id) ? voice_id : 'Dennis';
    const inworldResp = await fetch('https://api.inworld.ai/tts/v1/voice', {
      method: 'POST',
      headers: { Authorization: `Basic ${INWORLD_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice_id: chosenVoice, model_id: 'inworld-tts-2', audio_config: { audio_encoding: 'MP3', sample_rate_hertz: 48000 } }),
    });
    if (!inworldResp.ok) {
      const errText = await inworldResp.text().catch(() => '');
      console.error('Inworld API error:', inworldResp.status, errText);
      return res.status(502).json({ error: 'TTS provider returned an error' });
    }
    const data = await inworldResp.json();
    if (!data.audioContent) return res.status(502).json({ error: 'TTS provider returned no audio' });
    res.json({ audioContent: data.audioContent });
  } catch(err) { console.error('TTS proxy error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NewG server listening on port ${PORT}`));
