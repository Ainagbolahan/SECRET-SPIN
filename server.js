const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';
const DATA_FILE = path.join(__dirname, 'data.json');
const TEMP_FILE = path.join(__dirname, 'data.json.tmp');

let state = null;

function load() {
  if (state) return state;
  if (!fs.existsSync(DATA_FILE)) {
    state = { people: [], isApproved: false };
    return state;
  }
  try {
    state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!Array.isArray(state.people)) state.people = [];
    if (typeof state.isApproved !== 'boolean') state.isApproved = false;
  } catch (err) {
    console.error('Failed to parse data.json, starting clean:', err);
    state = { people: [], isApproved: false };
  }
  return state;
}

function save() {
  const dataString = JSON.stringify(state, null, 2);
  fs.writeFileSync(TEMP_FILE, dataString, 'utf8');
  fs.renameSync(TEMP_FILE, DATA_FILE);
}

function isValidEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(String(email).toLowerCase());
}

function adminOnly(req, res, next) {
  const providedPassword = String(req.headers['x-admin-password'] || '');
  const bufferProvided = Buffer.from(providedPassword);
  const bufferExpected = Buffer.from(ADMIN_PASSWORD);

  if (
    bufferProvided.length !== bufferExpected.length ||
    !crypto.timingSafeEqual(bufferProvided, bufferExpected)
  ) {
    return res.status(401).json({ error: 'Wrong admin password' });
  }
  next();
}

function generateDerangements(peopleList) {
  if (peopleList.length < 2) return null;

  const tokens = peopleList.map(p => p.token);
  let shuffled = [...tokens];
  let isValid = false;
  let attempts = 0;

  while (!isValid && attempts < 1000) {
    attempts++;
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    isValid = shuffled.every((targetToken, idx) => targetToken !== tokens[idx]);
  }

  if (!isValid) {
    shuffled = tokens.map((_, i) => tokens[(i + 1) % tokens.length]);
  }

  const map = new Map();
  tokens.forEach((srcToken, i) => {
    const targetPerson = peopleList.find(p => p.token === shuffled[i]);
    map.set(srcToken, targetPerson.email);
  });
  return map;
}

// ---------- Admin routes ----------
app.get('/api/admin/people', adminOnly, (req, res) => {
  const data = load();
  res.json({ people: data.people, isApproved: data.isApproved });
});

app.post('/api/admin/people', adminOnly, (req, res) => {
  const rawEmails = Array.isArray(req.body.emails) ? req.body.emails : [];
  const validEmails = rawEmails
    .map(e => String(e).trim().toLowerCase())
    .filter(e => isValidEmail(e));

  if (validEmails.length === 0) {
    return res.status(400).json({ error: 'No valid email addresses provided.' });
  }

  const data = load();
  let addedCount = 0;

  for (const email of validEmails) {
    if (data.people.some(p => p.email.toLowerCase() === email)) continue;
    
    // Secure 32-character token for participant URL
    const token = crypto.randomBytes(16).toString('hex');

    data.people.push({
      email: email,
      token: token,
      assignedResult: null,
      result: null,
      spunAt: null
    });
    addedCount++;
  }

  if (addedCount > 0) save();
  res.json({ people: data.people, isApproved: data.isApproved, addedCount });
});

app.post('/api/admin/toggle-approval', adminOnly, (req, res) => {
  const data = load();
  data.isApproved = req.body.approved !== undefined ? Boolean(req.body.approved) : !data.isApproved;
  save();
  res.json({ message: `Spinning is now ${data.isApproved ? 'APPROVED' : 'LOCKED'}`, isApproved: data.isApproved });
});

app.post('/api/admin/lock-assignments', adminOnly, (req, res) => {
  const data = load();
  if (data.people.length < 2) {
    return res.status(400).json({ error: 'Need at least 2 participants to generate pairings' });
  }

  const pairings = generateDerangements(data.people);
  data.people.forEach(p => {
    p.assignedResult = pairings.get(p.token);
  });

  save();
  res.json({ message: 'Pairings locked successfully', count: data.people.length });
});

app.delete('/api/admin/people/:token', adminOnly, (req, res) => {
  const data = load();
  data.people = data.people.filter(p => p.token !== req.params.token);
  save();
  res.json({ people: data.people, isApproved: data.isApproved });
});

app.post('/api/admin/reset/:token', adminOnly, (req, res) => {
  const data = load();
  const person = data.people.find(p => p.token === req.params.token);
  if (person) {
    person.result = null;
    person.spunAt = null;
  }
  save();
  res.json({ people: data.people, isApproved: data.isApproved });
});

app.post('/api/admin/reset-all', adminOnly, (req, res) => {
  const data = load();
  data.people.forEach(p => {
    p.result = null;
    p.spunAt = null;
    p.assignedResult = null;
  });
  data.isApproved = false;
  save();
  res.json({ people: data.people, isApproved: data.isApproved });
});

// ---------- Participant routes ----------
app.get('/api/me/:token', (req, res) => {
  const data = load();
  const me = data.people.find(p => p.token === req.params.token);
  if (!me) return res.status(404).json({ error: 'Invalid access link' });

  res.json({
    email: me.email,
    result: me.result,
    isApproved: data.isApproved,
    wheelNames: data.people.map(p => p.email)
  });
});

app.post('/api/spin/:token', (req, res) => {
  const data = load();
  
  if (!data.isApproved) {
    return res.status(403).json({ error: 'Spinning has not been approved by the admin yet.' });
  }

  const me = data.people.find(p => p.token === req.params.token);
  if (!me) return res.status(404).json({ error: 'Invalid access link' });

  if (me.result) return res.json({ result: me.result, already: true });

  if (me.assignedResult) {
    me.result = me.assignedResult;
    me.spunAt = new Date().toISOString();
    save();
    return res.json({ result: me.result });
  }

  const taken = new Set(data.people.map(p => p.result).filter(Boolean));
  const available = data.people
    .map(p => p.email)
    .filter(e => e !== me.email && !taken.has(e));

  if (available.length === 0) {
    return res.status(409).json({ error: 'No valid recipient available' });
  }

  const pick = available[crypto.randomInt(available.length)];
  me.result = pick;
  me.spunAt = new Date().toISOString();
  save();
  res.json({ result: pick });
});

// Serve participant spin page via token link
app.get('/spin/:token', (req, res) => {
  const data = load();
  const exists = data.people.some(p => p.token === req.params.token);
  if (exists) {
    return res.sendFile(path.join(__dirname, 'public', 'spin.html'));
  }
  res.status(404).send('Invalid or expired participant link.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Running on port ' + PORT));
