const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

function load() {
  if (!fs.existsSync(DATA_FILE)) return { people: [] };
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function save(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
function adminOnly(req, res, next) {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong admin password' });
  }
  next();
}

// ---------- Pages ----------
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/s/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'spin.html')));
app.get('/', (req, res) => res.send('Secret Spin is running. Use your private link.'));

// ---------- Admin API ----------
app.get('/api/admin/people', adminOnly, (req, res) => res.json(load().people));

app.post('/api/admin/people', adminOnly, (req, res) => {
  const names = (req.body.names || []).map(n => String(n).trim()).filter(Boolean);
  const data = load();
  for (const name of names) {
    if (data.people.some(p => p.name.toLowerCase() === name.toLowerCase())) continue;
    data.people.push({ id: crypto.randomBytes(8).toString('hex'), name, result: null, spunAt: null });
  }
  save(data);
  res.json(data.people);
});

app.delete('/api/admin/people/:id', adminOnly, (req, res) => {
  const data = load();
  data.people = data.people.filter(p => p.id !== req.params.id);
  save(data);
  res.json(data.people);
});

app.post('/api/admin/reset/:id', adminOnly, (req, res) => {
  const data = load();
  const person = data.people.find(p => p.id === req.params.id);
  if (person) { person.result = null; person.spunAt = null; }
  save(data);
  res.json(data.people);
});

// ---------- Participant API ----------
app.get('/api/me/:id', (req, res) => {
  const data = load();
  const me = data.people.find(p => p.id === req.params.id);
  if (!me) return res.status(404).json({ error: 'Invalid link' });
  res.json({ name: me.name, result: me.result, wheelNames: data.people.map(p => p.name) });
});

app.post('/api/spin/:id', (req, res) => {
  const data = load();
  const me = data.people.find(p => p.id === req.params.id);
  if (!me) return res.status(404).json({ error: 'Invalid link' });
  if (me.result) return res.json({ result: me.result, already: true });

  const taken = new Set(data.people.map(p => p.result).filter(Boolean));
  const available = data.people.map(p => p.name).filter(n => n !== me.name && !taken.has(n));
  if (available.length === 0) return res.status(409).json({ error: 'No names left to pick' });

  const pick = available[crypto.randomInt(available.length)];
  me.result = pick;
  me.spunAt = new Date().toISOString();
  save(data);
  res.json({ result: pick });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Running on port ' + PORT));
