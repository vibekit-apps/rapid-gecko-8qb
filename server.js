const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

process.on('uncaughtException', (err) => { console.error('UNCAUGHT:', err.stack || err); });
process.on('unhandledRejection', (err) => { console.error('UNHANDLED:', err); });

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
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
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { folders: [], recipes: [] }; }
}
function saveData(d) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }
  catch (e) { console.error('saveData error:', e.message); throw e; }
}

// Multer — store in uploads/
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_'))
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json());
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
  res.json(d.folders);
});

app.post('/api/folders', (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
    const d = loadData();
    const folder = { id: Date.now().toString(), name: name.trim() };
    d.folders.push(folder);
    saveData(d);
    res.json(folder);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const patchFolder = (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
    const d = loadData();
    const f = d.folders.find(x => x.id === req.params.id);
    if (!f) return res.status(404).json({ error: 'Not found' });
    f.name = name.trim();
    saveData(d);
    res.json(f);
  } catch (e) { res.status(500).json({ error: e.message }); }
};

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

app.post('/api/recipes', upload.single('photo'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Photo required' });
    const d = loadData();
    const recipe = {
      id: Date.now().toString(),
      folderId: req.body.folderId || null,
      filename: req.file.filename,
      name: req.body.name || 'Untitled Recipe',
      createdAt: new Date().toISOString()
    };
    d.recipes.push(recipe);
    saveData(d);
    res.json(recipe);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/folders/:id', patchFolder);
app.patch('/api/folders/:id', patchFolder);

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

app.listen(PORT, () => console.log('Recipe box ready on port ' + PORT));
