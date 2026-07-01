const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Ensure uploads dir exists
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Load/save helpers
function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { folders: [], recipes: [] };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { folders: [], recipes: [] }; }
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }

// Multer — store in uploads/
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_'))
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(__dirname));
app.use('/uploads', express.static(UPLOADS_DIR));

// --- Folders ---
app.get('/api/folders', (req, res) => {
  const d = loadData();
  res.json(d.folders);
});

app.post('/api/folders', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const d = loadData();
  const folder = { id: Date.now().toString(), name: name.trim() };
  d.folders.push(folder);
  saveData(d);
  res.json(folder);
});

app.patch('/api/folders/:id', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const d = loadData();
  const f = d.folders.find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: 'Not found' });
  f.name = name.trim();
  saveData(d);
  res.json(f);
});

app.delete('/api/folders/:id', (req, res) => {
  const d = loadData();
  d.folders = d.folders.filter(x => x.id !== req.params.id);
  // Move recipes in this folder to unorganized (folderId = null)
  d.recipes.forEach(r => { if (r.folderId === req.params.id) r.folderId = null; });
  saveData(d);
  res.json({ ok: true });
});

// --- Recipes ---
app.get('/api/recipes', (req, res) => {
  const d = loadData();
  res.json(d.recipes);
});

app.post('/api/recipes', upload.single('photo'), (req, res) => {
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
});

app.patch('/api/recipes/:id', (req, res) => {
  const d = loadData();
  const r = d.recipes.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (req.body.name !== undefined) r.name = req.body.name;
  if (req.body.folderId !== undefined) r.folderId = req.body.folderId;
  saveData(d);
  res.json(r);
});

app.delete('/api/recipes/:id', (req, res) => {
  const d = loadData();
  const r = d.recipes.find(x => x.id === req.params.id);
  if (r) {
    const fp = path.join(UPLOADS_DIR, r.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  d.recipes = d.recipes.filter(x => x.id !== req.params.id);
  saveData(d);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log('Recipe box ready on port ' + PORT));
