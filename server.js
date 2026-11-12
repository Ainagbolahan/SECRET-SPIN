const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || ''; // Format: "username/repo-name"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_FILE_PATH = 'data.json';

const DATA_FILE = path.join(__dirname, 'data.json');
const TEMP_FILE = path.join(__dirname, 'data.json.tmp');

let state = { people: [], isApproved: false };
let githubFileSha = null;
let isSyncing = false;
let syncPending = false;

function githubHeaders() {
  return {
    'Authorization': `Bearer ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'secret-spin-app',
    'Content-Type': 'application/json'
  };
}

// Pull latest data.json from GitHub on server startup
async function loadFromGitHub() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    console.log('GitHub sync disabled (GITHUB_TOKEN or GITHUB_REPO not set). Using local file.');
    if (fs.existsSync(DATA_FILE)) {
      try {
        state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      } catch (e) {
        state = { people: [], isApproved: false };
      }
    }
    return;
  }

  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}?ref=${GITHUB_BRANCH}`;
    const res = await fetch(url, { headers: githubHeaders() });

    if (res.status === 404) {
      console.log('data.json not found on GitHub yet. Will create on first save.');
      return;
    }

    if (!res.ok) {
      throw new Error(`GitHub GET failed: ${res.status} ${await res.text()}`);
    }

    const fileData = await res.json();
    githubFileSha = fileData.sha;
    const decoded = Buffer.from(fileData.content, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);

    state = {
      people: Array.isArray(parsed.people) ? parsed.people : [],
      isApproved: Boolean(parsed.isApproved)
    };

    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf8');
    console.log(`Loaded ${state.people.length} participants from GitHub.`);
  } catch (err) {
    console.error('Error loading state from GitHub:', err.message);
  }
}

// Push data.json to GitHub sequentially to avoid SHA race conditions
async function pushToGitHub() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;
  if (isSyncing) {
    syncPending = true;
    return;
  }

  isSyncing = true;
  syncPending = false;

  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`;
    const contentBase64 = Buffer.from(JSON.stringify(state, null, 2), 'utf8').toString('base64');

    // Fetch current SHA if we don't have it cached yet
    if (!githubFileSha) {
      const checkRes = await fetch(`${url}?ref=${GITHUB_BRANCH}`, { headers: githubHeaders() });
      if (checkRes.ok) {
        const checkData = await checkRes.json();
        githubFileSha = checkData.sha;
      }
    }

    const body = {
      message: `Auto-save spin data (${new Date().toISOString()}) [skip render]`,
      content: contentBase64,
      branch: GITHUB_BRANCH
    };
    if (githubFileSha) body.sha = githubFileSha;

    let putRes = await fetch(url, {
      method: 'PUT',
      headers: githubHeaders(),
      body: JSON.stringify(body)
    });

    // Retry once if SHA became stale due to external edit
    if (putRes.status === 409) {
      const refreshRes = await fetch(`${url}?ref=${GITHUB_BRANCH}`, { headers: githubHeaders() });
      if (refreshRes.ok) {
        const refreshData = await refreshRes.json();
        body.sha = refreshData.sha;
        putRes = await fetch(url, {
          method: 'PUT',
          headers: githubHeaders(),
          body: JSON.stringify(body)
        });
      }
    }

    if (!putRes.ok) {
      throw new Error(`GitHub PUT failed: ${putRes.status} ${await putRes.text()}`);
    }

    const resultData = await putRes.json();
    githubFileSha = resultData.content.sha;
    console.log('Saved data.json to GitHub.');
  } catch (err) {
    console.error('GitHub sync error:', err.message);
  } finally {
    isSyncing = false;
    if (syncPending) pushToGitHub();
  }
}

function load() {
  return state;
}

function save() {
  const dataString = JSON.stringify(state, null, 2);
  fs.writeFileSync(TEMP_FILE, dataString, 'utf8');
  fs.renameSync(TEMP_FILE, DATA_FILE);
  pushToGitHub(); // Triggers async commit to GitHub
}

function parseAndValidateEmails(input) {
  let raw = [];
  if (Array.isArray(input)) {
    raw = input;
  } else if (typeof input === 'string') {
    raw = input.split(/[\n,\r;\s]+/);
  }

  const cleaned = raw
    .map(e => String(e).replace(/[<>'"]/g, '').trim().toLowerCase())
    .filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));

  return [...new Set(cleaned)];
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

  const emails = peopleList.map(p => p.email);
  let shuffled = [...emails];
  let isValid = false;
  let attempts = 0;

  while (!isValid && attempts < 1000) {
    attempts++;
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    isValid = shuffled.every((targetEmail, idx) => targetEmail !== emails[idx]);
  }

  if (!isValid) {
    shuffled = emails.map((_, i) => emails[(i + 1) % emails.length]);
  }

  const map = new Map();
  emails.forEach((srcEmail, i) => {
    map.set(srcEmail, shuffled[i]);
  });
  return map;
}

// ---------- Public Participant Routes ----------

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'spin.html'));
});

app.post('/api/check-email', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Please enter a valid email address.' });

  const data = load();
  const person = data.people.find(p => p.email.toLowerCase() === email);

  if (!person) {
    return res.status(404).json({ 
      error: 'Email not found on the admin roster. Please contact your event host.' 
    });
  }

  res.json({
    email: person.email,
    alreadySpun: !!person.result,
    isApproved: data.isApproved,
    wheelNames: data.people.map(p => p.email)
  });
});

app.post('/api/spin', (req, res) => {
  const data = load();
  const email = String(req.body.email || '').trim().toLowerCase();

  if (!data.isApproved) {
    return res.status(403).json({ error: 'Spinning is locked. Please wait for the admin to enable spins.' });
  }

  const person = data.people.find(p => p.email.toLowerCase() === email);
  if (!person) {
    return res.status(404).json({ error: 'Email not tied to admin roster.' });
  }

  if (person.result) {
    return res.status(400).json({ error: 'You have already completed your spin.' });
  }

  if (person.assignedResult) {
    person.result = person.assignedResult;
    person.spunAt = new Date().toISOString();
    save();
    return res.json({ result: person.result });
  }

  const taken = new Set(data.people.map(p => p.result).filter(Boolean));
  const available = data.people
    .map(p => p.email)
    .filter(e => e !== person.email && !taken.has(e));

  if (available.length === 0) {
    return res.status(409).json({ error: 'No valid recipient available to pick.' });
  }

  const pick = available[crypto.randomInt(available.length)];
  person.result = pick;
  person.spunAt = new Date().toISOString();
  save();
  res.json({ result: pick });
});

// ---------- Admin Routes ----------
app.get('/api/admin/people', adminOnly, (req, res) => {
  const data = load();
  res.json({ people: data.people, isApproved: data.isApproved });
});

app.post('/api/admin/restore', adminOnly, (req, res) => {
  const incomingPeople = Array.isArray(req.body.people) ? req.body.people : [];
  const data = load();

  data.people = incomingPeople
    .filter(p => p && typeof p.email === 'string')
    .map(p => ({
      email: p.email.trim().toLowerCase(),
      assignedResult: p.assignedResult || null,
      result: p.result || null,
      spunAt: p.spunAt || null
    }));

  if (typeof req.body.isApproved === 'boolean') {
    data.isApproved = req.body.isApproved;
  }

  save();
  res.json({ people: data.people, isApproved: data.isApproved });
});

app.post('/api/admin/people', adminOnly, (req, res) => {
  const validEmails = parseAndValidateEmails(req.body.emails);

  if (validEmails.length === 0) {
    return res.status(400).json({ error: 'No valid email addresses provided.' });
  }

  const data = load();
  let addedCount = 0;
  let skippedCount = 0;

  for (const email of validEmails) {
    if (data.people.some(p => p.email.toLowerCase() === email)) {
      skippedCount++;
      continue;
    }
    
    data.people.push({
      email: email,
      assignedResult: null,
      result: null,
      spunAt: null
    });
    addedCount++;
  }

  if (addedCount > 0) save();
  res.json({ people: data.people, isApproved: data.isApproved, addedCount, skippedCount });
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
    p.assignedResult = pairings.get(p.email);
  });

  save();
  res.json({ 
    message: 'Pairings generated and locked successfully', 
    people: data.people, 
    isApproved: data.isApproved 
  });
});

app.delete('/api/admin/people/:email', adminOnly, (req, res) => {
  const data = load();
  const targetEmail = req.params.email.toLowerCase();
  data.people = data.people.filter(p => p.email.toLowerCase() !== targetEmail);
  save();
  res.json({ people: data.people, isApproved: data.isApproved });
});

app.post('/api/admin/reset/:email', adminOnly, (req, res) => {
  const data = load();
  const targetEmail = req.params.email.toLowerCase();
  const person = data.people.find(p => p.email.toLowerCase() === targetEmail);
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

const PORT = process.env.PORT || 3000;

// Load data from GitHub before accepting traffic
loadFromGitHub().then(() => {
  app.listen(PORT, () => console.log('Running on port ' + PORT));
});
