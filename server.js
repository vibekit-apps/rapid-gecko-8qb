const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { recognize } = require('tesseract.js');

process.on('uncaughtException', (err) => { console.error('UNCAUGHT:', err.stack || err); });
process.on('unhandledRejection', (err) => { console.error('UNHANDLED:', err); });

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = process.env.DATA_FILE || path.join(DATA_DIR, 'data.json');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');

// Ensure dirs exist
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Test writability at startup
try {
  const testFile = DATA_FILE + '.tmp';
  fs.writeFileSync(testFile, 'ok', 'utf8');
  fs.unlinkSync(testFile);
  console.log('Write test OK:', DATA_FILE);
} catch (e) {
  console.error('Write test FAILED:', e.message, '— uid:', process.getuid?.(), 'gid:', process.getgid?.());
}

// Load/save helpers
function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { folders: [], recipes: [] };
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      folders: Array.isArray(data.folders) ? data.folders : [],
      recipes: Array.isArray(data.recipes) ? data.recipes : []
    };
  }
  catch (e) {
    console.error('loadData error:', e.message);
    return { folders: [], recipes: [] };
  }
}
function saveData(d) {
  const json = JSON.stringify(d, null, 2);
  try {
    const tmp = `${DATA_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    // Atomic rename can fail (EACCES/EPERM) when the container's squashed-root
    // user can't rename over the workspace-owned file under a sticky dir.
    // Fall back to an in-place write to the (world-writable) data file.
    try { fs.writeFileSync(DATA_FILE, json, 'utf8'); }
    catch (e2) { console.error('saveData error:', e2.message); throw e2; }
  }
}

function compareFolders(a, b) {
  const byName = String(a?.name || '').localeCompare(String(b?.name || ''), undefined, {
    sensitivity: 'base',
    numeric: true
  });
  return byName || String(a?.id || '').localeCompare(String(b?.id || ''));
}

function sortFolders(folders) {
  return [...folders].sort(compareFolders);
}

// Multer — store in uploads/
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_'))
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

function cleanOcrText(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractIngredientCandidates(text) {
  const measurementWords = [
    'cup', 'cups', 'tbsp', 'tablespoon', 'tablespoons', 'tsp', 'teaspoon', 'teaspoons',
    'oz', 'ounce', 'ounces', 'lb', 'lbs', 'pound', 'pounds', 'gram', 'grams', 'g', 'kg',
    'ml', 'l', 'pinch', 'dash', 'clove', 'cloves', 'can', 'cans', 'package', 'packages'
  ];
  const instructionWords = /\b(bake|boil|cook|combine|fold|heat|mix|preheat|pour|serve|stir|whisk)\b/i;
  const amountPattern = /^(\d+|[\u00bc\u00bd\u00be\u2153\u2154\u215b\u215c\u215d\u215e]|\d+\s*\/\s*\d+|\d+\.\d+)/;

  const lines = cleanOcrText(text)
    .split('\n')
    .map(line => line.replace(/^[\-*\u2022\s]+/, '').trim())
    .filter(line => line.length >= 3 && line.length <= 120);

  const ingredients = lines.filter(line => {
    const lower = line.toLowerCase();
    const hasAmount = amountPattern.test(lower);
    const hasMeasure = measurementWords.some(word => new RegExp(`\\b${word}\\b`, 'i').test(lower));
    const looksLikeInstruction = instructionWords.test(lower) && lower.split(/\s+/).length > 8;
    return (hasAmount || hasMeasure) && !looksLikeInstruction;
  });

  return [...new Set(ingredients)].slice(0, 80);
}

async function readRecipeTextFromImage(filePath) {
  try {
    const result = await recognize(filePath, 'eng', { cachePath: __dirname });
    const text = cleanOcrText(result?.data?.text || '');
    return {
      text,
      ingredients: extractIngredientCandidates(text),
      status: text ? 'complete' : 'empty',
      error: null
    };
  } catch (e) {
    console.error('OCR failed:', e.message);
    return { text: '', ingredients: [], status: 'failed', error: e.message };
  }
}

function parseJsonBody(req, res, next) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('application/json')) {
    req.body = req.body || {};
    next();
    return;
  }

  let total = 0;
  let settled = false;
  const chunks = [];
  const limit = 128 * 1024;

  function fail(status, message) {
    if (settled) return;
    settled = true;
    if (!res.headersSent) res.status(status).json({ error: message });
  }

  req.on('aborted', () => {
    console.warn('Request aborted:', req.method, req.originalUrl || req.url);
    settled = true;
  });
  req.on('error', () => fail(400, 'Request was interrupted. Please try again.'));
  req.on('data', chunk => {
    if (settled) return;
    total += chunk.length;
    if (total > limit) {
      fail(413, 'Request body too large');
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (settled) return;
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) {
      req.body = {};
      settled = true;
      next();
      return;
    }
    try {
      req.body = JSON.parse(raw);
      settled = true;
      next();
    } catch (e) {
      fail(400, 'Invalid request body');
    }
  });
}

app.use(parseJsonBody);
app.use(express.static(__dirname));
app.use('/uploads', express.static(UPLOADS_DIR));

// Diagnostic endpoint
app.get('/api/diag', (req, res) => {
  const testFile = DATA_FILE + '.tmp';
  try {
    fs.writeFileSync(testFile, 'ok', 'utf8');
    fs.unlinkSync(testFile);
    res.json({ writable: true, data: DATA_FILE, uploads: UPLOADS_DIR, uid: process.getuid?.(), gid: process.getgid?.() });
  } catch (e) {
    res.json({ writable: false, error: e.message, data: DATA_FILE, uploads: UPLOADS_DIR, uid: process.getuid?.(), gid: process.getgid?.() });
  }
});

// --- Folders ---
app.get('/api/folders', (req, res) => {
  const d = loadData();
  res.json(sortFolders(d.folders));
});

app.post('/api/folders', (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const name = body.name ?? req.query?.name;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required' });
    const d = loadData();
    const folder = { id: Date.now().toString(), name: String(name).trim() };
    d.folders.push(folder);
    d.folders = sortFolders(d.folders);
    saveData(d);
    res.json(folder);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const updateFolder = (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const name = body.name ?? req.query?.name;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required' });
    const d = loadData();
    const f = d.folders.find(x => x.id === req.params.id);
    if (!f) return res.status(404).json({ error: 'Not found' });
    f.name = String(name).trim();
    d.folders = sortFolders(d.folders);
    saveData(d);
    res.json(f);
  } catch (e) { res.status(500).json({ error: e.message }); }
};
app.post('/api/folders/:id', updateFolder);
app.patch('/api/folders/:id', updateFolder);
app.put('/api/folders/:id', updateFolder);

app.delete('/api/folders/:id', (req, res) => {
  try {
    const d = loadData();
    d.folders = d.folders.filter(x => x.id !== req.params.id);
    d.recipes.forEach(r => { if (r.folderId === req.params.id) r.folderId = null; });
    saveData(d);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Recipes ---
app.get('/api/recipes', (req, res) => {
  const d = loadData();
  res.json(d.recipes);
});

app.post('/api/recipes', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Photo required' });
    const d = loadData();
    const ocr = await readRecipeTextFromImage(req.file.path);
    const recipe = {
      id: Date.now().toString(),
      folderId: req.body.folderId || null,
      filename: req.file.filename,
      name: req.body.name || 'Untitled Recipe',
      ocrText: ocr.text,
      ingredients: ocr.ingredients,
      ocrStatus: ocr.status,
      ocrError: ocr.error,
      createdAt: new Date().toISOString()
    };
    d.recipes.push(recipe);
    saveData(d);
    res.json(recipe);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const patchRecipe = (req, res) => {
  try {
    const d = loadData();
    const r = d.recipes.find(x => x.id === req.params.id);
    if (!r) return res.status(404).json({ error: 'Not found' });
    if (req.body.name !== undefined) r.name = req.body.name;
    if (req.body.folderId !== undefined) r.folderId = req.body.folderId;
    saveData(d);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
};
app.post('/api/recipes/:id', patchRecipe);
app.patch('/api/recipes/:id', patchRecipe);

app.delete('/api/recipes/:id', (req, res) => {
  try {
    const d = loadData();
    const r = d.recipes.find(x => x.id === req.params.id);
    if (r) {
      const fp = path.join(UPLOADS_DIR, r.filename);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    d.recipes = d.recipes.filter(x => x.id !== req.params.id);
    saveData(d);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API route not found' });
});

app.use((err, req, res, next) => {
  console.error('Request error:', err.stack || err);
  if (req.path && req.path.startsWith('/api/')) {
    res.status(err.status || 500).json({ error: err.message || 'Server error' });
    return;
  }
  next(err);
});

app.listen(PORT, '0.0.0.0', () => console.log('Recipe box ready on port ' + PORT));
