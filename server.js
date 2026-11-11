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
    state = { people: [] };
    return state;
  }
  try {
    state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!Array.isArray(state.people)) state.people = [];
  } catch (err) {
    console.error('Failed to parse data.json, starting clean:', err);
    state = { people: [] };
  }
  return state;
}

function save() {
  const dataString = JSON.stringify(state, null, 2);
  fs.writeFileSync(TEMP_FILE, dataString, 'utf8');
  fs.renameSync(TEMP_FILE, DATA_FILE);
}

// Helper: Generates unique URL slug from first name (e.g. "John Doe" -> "john", duplicates -> "john-2")
function generateSlug(fullName, existingPeople) {
  const firstName = fullName.trim().split(/\s+/)[0];
  let baseSlug = firstName.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!baseSlug) baseSlug = 'guest';

  let slug = baseSlug;
  let counter = 2;
  const existingSlugs = new Set(existingPeople.map(p => p.slug || p.id));

  while (existingSlugs.has(slug)) {
    slug = `${baseSlug}-${counter}`;
    counter++;
  }
  return slug;
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

  const slugs = peopleList.map(p => p.slug);
  let shuffled = [...slugs];
  let isValid = false;
  let attempts = 0;

  while (!isValid && attempts < 1000) {
    attempts++;
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    isValid = shuffled.every((targetSlug, idx) => targetSlug !== slugs[idx]);
  }

  if (!isValid) {
    shuffled = slugs.map((_, i) => slugs[(i + 1) % slugs.length]);
  }

  const map = new Map();
  slugs.forEach((srcSlug, i) => {
    const targetPerson = peopleList.find(p => p.slug === shuffled[i]);
    map.set(srcSlug, targetPerson.name);
  });
  return map;
}

// ---------- Admin routes ----------
app.get('/api/admin/people', adminOnly, (req, res) => {
  res.json(load().people);
});

app.post('/api/admin/people', adminOnly, (req, res) => {
  const rawNames = Array.isArray(req.body.names) ? req.body.names : [];
  const names = rawNames
    .map(n => String(n).trim())
    .filter(n => n.length > 0 && n.length <= 50);

  const data = load();
  let addedCount = 0;

  for (const name of names) {
    if (data.people.some(p => p.name.toLowerCase() === name.toLowerCase())) continue;
    
    const slug = generateSlug(name, data.people);
    data.people.push({
      id: slug,            // Keyed by slug
      slug: slug,          // e.g. "john" or "mary"
      name: name,
      assignedResult: null,
      result: null,
      spunAt: null
    });
    addedCount++;
  }

  if (addedCount > 0) save();
  res.json(data.people);
});

app.post('/api/admin/lock-assignments', adminOnly, (req, res) => {
  const data = load();
  if (data.people.length < 2) {
    return res.status(400).json({ error: 'Need at least 2 participants to generate pairings' });
  }

  const pairings = generateDerangements(data.people);
  data.people.forEach(p => {
    p.assignedResult = pairings.get(p.slug);
  });

  save();
  res.json({ message: 'Pairings locked successfully', count: data.people.length });
});

app.delete('/api/admin/people/:slug', adminOnly, (req, res) => {
  const data = load();
  data.people = data.people.filter(p => (p.slug || p.id) !== req.params.slug);
  save();
  res.json(data.people);
});

app.post('/api/admin/reset/:slug', adminOnly, (req, res) => {
  const data = load();
  const person = data.people.find(p => (p.slug || p.id) === req.params.slug);
  if (person) {
    person.result = null;
    person.spunAt = null;
  }
  save();
  res.json(data.people);
});

app.post('/api/admin/reset-all', adminOnly, (req, res) => {
  const data = load();
  data.people.forEach(p => {
    p.result = null;
    p.spunAt = null;
    p.assignedResult = null;
  });
  save();
  res.json(data.people);
});

// ---------- Participant routes ----------
app.get('/api/me/:slug', (req, res) => {
  const data = load();
  const me = data.people.find(p => (p.slug || p.id) === req.params.slug.toLowerCase());
  if (!me) return res.status(404).json({ error: 'Invalid link' });

  res.json({
    name: me.name,
    result: me.result,
    wheelNames: data.people.map(p => p.name)
  });
});

app.post('/api/spin/:slug', (req, res) => {
  const data = load();
  const me = data.people.find(p => (p.slug || p.id) === req.params.slug.toLowerCase());
  if (!me) return res.status(404).json({ error: 'Invalid link' });

  if (me.result) return res.json({ result: me.result, already: true });

  if (me.assignedResult) {
    me.result = me.assignedResult;
    me.spunAt = new Date().toISOString();
    save();
    return res.json({ result: me.result });
  }

  const taken = new Set(data.people.map(p => p.result).filter(Boolean));
  const available = data.people
    .map(p => p.name)
    .filter(n => n !== me.name && !taken.has(n));

  if (available.length === 0) {
    return res.status(409).json({ error: 'No valid recipient available' });
  }

  const pick = available[crypto.randomInt(available.length)];
  me.result = pick;
  me.spunAt = new Date().toISOString();
  save();
  res.json({ result: pick });
});

// Serve the spin page at /:slug (e.g. site.com/john)
app.get('/:slug', (req, res) => {
  const data = load();
  const exists = data.people.some(p => (p.slug || p.id) === req.params.slug.toLowerCase());
  if (exists) {
    return res.sendFile(path.join(__dirname, 'public', 'spin.html'));
  }
  res.status(404).send('Participant link not found.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Running on port ' + PORT));
