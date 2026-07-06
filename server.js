const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { createWorker, PSM } = require('tesseract.js');

process.on('uncaughtException', (err) => { console.error('UNCAUGHT:', err.stack || err); });
process.on('unhandledRejection', (err) => { console.error('UNHANDLED:', err); });

const app = express();
const PORT = process.env.PORT;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'recipes.sqlite');
const LEGACY_DATA_FILE = process.env.LEGACY_DATA_FILE || path.join(DATA_DIR, 'data.json');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
const LEGACY_JSON_IMPORT_META_KEY = 'legacy_json_import_status';
const OCR_ALGORITHM_VERSION = '3';
const OCR_RECIPE_TERMS = [
  'bake', 'boil', 'broil', 'butter', 'chill', 'combine', 'cook', 'cream',
  'cup', 'cups', 'directions', 'eggs', 'flour', 'fold', 'heat', 'ingredients',
  'milk', 'minutes', 'mix', 'oven', 'preheat', 'recipe', 'salt', 'serve',
  'simmer', 'sugar', 'tablespoon', 'tablespoons', 'teaspoon', 'teaspoons',
  'vanilla', 'whisk'
];

let db;

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function writeFileAtomic(filePath, data) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.writeFileSync(filePath, data); }
    catch (e2) { console.error('writeFileAtomic error:', e2.message); throw e2; }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
  }
}

function persistDb() {
  writeFileAtomic(DB_FILE, Buffer.from(db.export()));
}

function run(sql, params = []) {
  db.run(sql, params);
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  const rows = [];
  try {
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return rows;
}

function one(sql, params = []) {
  return all(sql, params)[0] || null;
}

function getMeta(key) {
  return one('SELECT value FROM app_meta WHERE key = ?', [key])?.value || null;
}

function setMeta(key, value) {
  run(`INSERT INTO app_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, value]);
}

function safeJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function normalizeTextList(value) {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  return String(value || '')
    .split(/\r?\n/)
    .map(line => normalizeRecipeLine(line))
    .filter(Boolean);
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

function rowToFolder(row) {
  return {
    id: String(row.id),
    name: row.name,
    parentId: row.parent_id ? String(row.parent_id) : null,
    createdAt: row.created_at || null
  };
}

function rowToRecipe(row) {
  return {
    id: String(row.id),
    folderId: row.folder_id ? String(row.folder_id) : null,
    filename: row.filename,
    name: row.name,
    ocrText: row.ocr_text || '',
    ingredients: safeJsonArray(row.ingredients_json),
    steps: safeJsonArray(row.steps_json),
    ocrStatus: row.ocr_status || 'pending',
    ocrError: row.ocr_error || null,
    createdAt: row.created_at
  };
}

function getFolders() {
  return sortFolders(all('SELECT * FROM folders').map(rowToFolder));
}

function escapeSqlLike(value) {
  return String(value).replace(/[\\%_]/g, char => `\\${char}`);
}

function getDescendantFolderIdsFromDb(folderId) {
  if (folderId === 'none') return ['none'];
  const ids = new Set([String(folderId)]);
  let changed = true;
  while (changed) {
    changed = false;
    all('SELECT id, parent_id FROM folders').forEach(folder => {
      if (folder.parent_id && ids.has(String(folder.parent_id)) && !ids.has(String(folder.id))) {
        ids.add(String(folder.id));
        changed = true;
      }
    });
  }
  return [...ids];
}

function getRecipes(options = {}) {
  const where = [];
  const params = [];
  const folderId = options.folderId ? String(options.folderId) : '';

  if (folderId && folderId !== 'all') {
    if (folderId === 'none') {
      where.push('(folder_id IS NULL OR folder_id = \'\')');
    } else {
      const folderIds = getDescendantFolderIdsFromDb(folderId);
      where.push(`folder_id IN (${folderIds.map(() => '?').join(', ')})`);
      params.push(...folderIds);
    }
  }

  const terms = String(options.search || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const searchMode = options.mode === 'ingredients' ? 'ingredients' : 'recipe';
  terms.forEach(term => {
    const like = `%${escapeSqlLike(term)}%`;
    if (searchMode === 'ingredients') {
      where.push(`lower(ingredients_json) LIKE ? ESCAPE '\\'`);
      params.push(like);
    } else {
      where.push(`(
        lower(name) LIKE ? ESCAPE '\\'
        OR lower(ocr_text) LIKE ? ESCAPE '\\'
        OR lower(steps_json) LIKE ? ESCAPE '\\'
      )`);
      params.push(like, like, like);
    }
  });

  const sql = `SELECT * FROM recipes${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC`;
  return all(sql, params).map(rowToRecipe);
}

function getRecipeStoreRowCount() {
  const folderCount = Number(one('SELECT COUNT(*) AS count FROM folders')?.count || 0);
  const recipeCount = Number(one('SELECT COUNT(*) AS count FROM recipes')?.count || 0);
  return folderCount + recipeCount;
}

function getRecipe(id) {
  const row = one('SELECT * FROM recipes WHERE id = ?', [String(id)]);
  return row ? rowToRecipe(row) : null;
}

function cleanOcrText(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeRecipeLine(line) {
  return line
    .replace(/^[\-*\u2022\s]+/, '')
    .replace(/^\(?\d+[\).:-]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueLines(lines, limit) {
  const seen = new Set();
  const out = [];
  for (const line of lines.map(normalizeRecipeLine).filter(Boolean)) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= limit) break;
  }
  return out;
}

function extractIngredientCandidates(text) {
  const measurementWords = [
    'cup', 'cups', 'tbsp', 'tablespoon', 'tablespoons', 'tsp', 'teaspoon', 'teaspoons',
    'oz', 'ounce', 'ounces', 'lb', 'lbs', 'pound', 'pounds', 'gram', 'grams', 'g', 'kg',
    'ml', 'l', 'pinch', 'dash', 'clove', 'cloves', 'can', 'cans', 'package', 'packages',
    'stick', 'sticks', 'slice', 'slices'
  ];
  const instructionWords = /\b(add|bake|boil|cook|combine|fold|heat|mix|preheat|pour|serve|stir|whisk)\b/i;
  const amountPattern = /^(\d+|[\u00bc\u00bd\u00be\u2153\u2154\u215b\u215c\u215d\u215e]|\d+\s*\/\s*\d+|\d+\.\d+)/;

  const lines = cleanOcrText(text)
    .split('\n')
    .map(normalizeRecipeLine)
    .filter(line => line.length >= 3 && line.length <= 140);

  return uniqueLines(lines.filter(line => {
    const lower = line.toLowerCase();
    const hasAmount = amountPattern.test(lower);
    const hasMeasure = measurementWords.some(word => new RegExp(`\\b${word}\\b`, 'i').test(lower));
    const looksLikeInstruction = instructionWords.test(lower) && lower.split(/\s+/).length > 8;
    return (hasAmount || hasMeasure) && !looksLikeInstruction;
  }), 100);
}

function parseRecipeText(text) {
  const lines = cleanOcrText(text)
    .split('\n')
    .map(normalizeRecipeLine)
    .filter(line => line.length >= 2);

  const ingredientHeaders = /^(ingredients?|you'?ll need|shopping list)$/i;
  const stepHeaders = /^(directions?|instructions?|method|preparation|steps?)$/i;
  const otherHeaders = /^(notes?|nutrition|serves?|yield|cook time|prep time)$/i;
  const instructionWords = /\b(add|arrange|bake|beat|boil|broil|chill|combine|cook|cover|drain|fold|fry|heat|mix|preheat|pour|reduce|remove|roast|saute|season|serve|simmer|stir|whisk)\b/i;

  let section = null;
  const ingredients = [];
  const steps = [];

  for (const line of lines) {
    if (ingredientHeaders.test(line)) { section = 'ingredients'; continue; }
    if (stepHeaders.test(line)) { section = 'steps'; continue; }
    if (otherHeaders.test(line)) { section = null; continue; }
    if (section === 'ingredients') ingredients.push(line);
    if (section === 'steps') steps.push(line);
  }

  const inferredSteps = lines.filter(line => {
    if (ingredientHeaders.test(line) || stepHeaders.test(line) || otherHeaders.test(line)) return false;
    return /^\(?\d+[\).:-]\s*/.test(line) || (instructionWords.test(line) && line.split(/\s+/).length >= 4);
  });

  return {
    ingredients: uniqueLines(ingredients.length ? ingredients : extractIngredientCandidates(text), 100),
    steps: uniqueLines(steps.length ? steps : inferredSteps, 80)
  };
}

function scoreOcrText(text, confidence) {
  const cleaned = cleanOcrText(text);
  const letters = (cleaned.match(/[A-Za-z]/g) || []).length;
  const words = (cleaned.match(/[A-Za-z][A-Za-z'-]{2,}/g) || []).length;
  const recipeWords = OCR_RECIPE_TERMS.reduce((total, term) => {
    const matches = cleaned.match(new RegExp(`\\b${term}\\b`, 'gi')) || [];
    return total + matches.length;
  }, 0);
  const parsed = parseRecipeText(cleaned);
  const structuredLines = parsed.ingredients.length + parsed.steps.length;
  const lineCount = cleaned.split('\n').filter(line => line.trim().length >= 3).length;
  const garbage = (cleaned.match(/[{}[\]|~^_=<>]/g) || []).length;
  return (Number(confidence) || 0) + (letters * 0.18) + (words * 2) + (recipeWords * 9) + (structuredLines * 12) + (lineCount * 1.5) - (garbage * 6);
}

async function readRecipeTextFromImage(filePath) {
  let worker;
  try {
    worker = await createWorker('eng', 1, { cachePath: __dirname });
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.AUTO,
      preserve_interword_spaces: '1',
      user_defined_dpi: '300'
    });

    const orientations = [
      { label: 'as-uploaded', radians: 0 },
      { label: 'rotated-right', radians: Math.PI / 2 },
      { label: 'upside-down', radians: Math.PI },
      { label: 'rotated-left', radians: -Math.PI / 2 }
    ];
    const pageModes = [
      { label: 'auto', mode: PSM.AUTO },
      { label: 'sparse', mode: PSM.SPARSE_TEXT }
    ];
    let best = null;

    for (const orientation of orientations) {
      for (const pageMode of pageModes) {
        await worker.setParameters({ tessedit_pageseg_mode: pageMode.mode });
        const attempt = { ...orientation, pageMode: pageMode.label };
        const result = await worker.recognize(filePath, {
          rotateAuto: true,
          rotateRadians: attempt.radians
        }, { text: true, blocks: false, hocr: false, tsv: false });
        const text = cleanOcrText(result?.data?.text || '');
        const score = scoreOcrText(text, result?.data?.confidence);
        if (!best || score > best.score) best = { ...attempt, text, score };
      }
    }

    const text = best?.text || '';
    const parsed = parseRecipeText(text);
    return {
      text,
      ingredients: parsed.ingredients,
      steps: parsed.steps,
      status: text ? 'complete' : 'empty',
      error: null
    };
  } catch (e) {
    console.error('OCR failed:', e.message);
    return { text: '', ingredients: [], steps: [], status: 'failed', error: e.message };
  } finally {
    if (worker) await worker.terminate().catch(() => {});
  }
}

async function readRecipeTextFromImages(files) {
  const results = [];
  for (const file of files) {
    results.push(await readRecipeTextFromImage(file.path));
  }

  const text = cleanOcrText(results.map(result => result.text).filter(Boolean).join('\n\n'));
  const parsed = parseRecipeText(text);
  const failures = results.filter(result => result.status === 'failed' && result.error);
  const hasText = Boolean(text);
  return {
    text,
    ingredients: parsed.ingredients,
    steps: parsed.steps,
    status: hasText ? 'complete' : failures.length === results.length ? 'failed' : 'empty',
    error: failures.length ? failures.map(result => result.error).join('; ') : null
  };
}

async function updateRecipeOcrFromImages(recipeId, files) {
  try {
    const existing = getRecipe(recipeId);
    if (!existing) return;
    const availableFiles = files.filter(file => file?.path && fs.existsSync(file.path));
    if (!availableFiles.length) return;
    const ocr = await readRecipeTextFromImages(availableFiles);
    run(`UPDATE recipes
      SET ocr_text = ?, ingredients_json = ?, steps_json = ?, ocr_status = ?, ocr_error = ?
      WHERE id = ?`, [
      ocr.text,
      JSON.stringify(ocr.ingredients),
      JSON.stringify(ocr.steps),
      ocr.status,
      ocr.error,
      String(recipeId)
    ]);
    persistDb();
  } catch (e) {
    console.error('Background OCR failed:', e.stack || e);
    try {
      run('UPDATE recipes SET ocr_status = ?, ocr_error = ? WHERE id = ?', [
        'failed',
        e.message || 'Text scan failed',
        String(recipeId)
      ]);
      persistDb();
    } catch (updateError) {
      console.error('Background OCR status update failed:', updateError.stack || updateError);
    }
  } finally {
    for (const extraFile of files.slice(1)) {
      if (extraFile?.path) fs.unlink(extraFile.path, () => {});
    }
  }
}

function readJsonSeed() {
  if (!fs.existsSync(LEGACY_DATA_FILE)) return { folders: [], recipes: [] };
  try {
    const data = JSON.parse(fs.readFileSync(LEGACY_DATA_FILE, 'utf8'));
    return {
      folders: Array.isArray(data.folders) ? data.folders : [],
      recipes: Array.isArray(data.recipes) ? data.recipes : []
    };
  } catch (e) {
    console.error('JSON seed read failed:', e.message);
    return { folders: [], recipes: [] };
  }
}

function migrateJsonSeed() {
  if (getMeta(LEGACY_JSON_IMPORT_META_KEY)) return;

  const existing = getRecipeStoreRowCount();
  if (existing > 0) {
    setMeta(LEGACY_JSON_IMPORT_META_KEY, JSON.stringify({
      status: 'skipped',
      reason: 'sqlite-already-populated',
      at: new Date().toISOString()
    }));
    return;
  }

  const seed = readJsonSeed();
  if (!seed.folders.length && !seed.recipes.length) {
    setMeta(LEGACY_JSON_IMPORT_META_KEY, JSON.stringify({
      status: 'skipped',
      reason: 'no-legacy-json-data',
      at: new Date().toISOString()
    }));
    return;
  }

  run('BEGIN TRANSACTION');
  try {
    for (const folder of seed.folders) {
      run('INSERT OR IGNORE INTO folders (id, name, parent_id, created_at) VALUES (?, ?, ?, ?)', [
        String(folder.id || Date.now()),
        String(folder.name || 'Folder'),
        folder.parentId ? String(folder.parentId) : null,
        folder.createdAt || new Date().toISOString()
      ]);
    }
    for (const recipe of seed.recipes) {
      const parsed = parseRecipeText(recipe.ocrText || '');
      run(`INSERT OR IGNORE INTO recipes
        (id, folder_id, filename, name, ocr_text, ingredients_json, steps_json, ocr_status, ocr_error, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        String(recipe.id || Date.now()),
        recipe.folderId ? String(recipe.folderId) : null,
        String(recipe.filename || ''),
        String(recipe.name || 'Untitled Recipe'),
        recipe.ocrText || '',
        JSON.stringify(Array.isArray(recipe.ingredients) ? recipe.ingredients : parsed.ingredients),
        JSON.stringify(Array.isArray(recipe.steps) ? recipe.steps : parsed.steps),
        recipe.ocrStatus || (recipe.ocrText ? 'complete' : 'pending'),
        recipe.ocrError || null,
        recipe.createdAt || new Date().toISOString()
      ]);
    }
    setMeta(LEGACY_JSON_IMPORT_META_KEY, JSON.stringify({
      status: 'imported',
      folders: seed.folders.length,
      recipes: seed.recipes.length,
      at: new Date().toISOString()
    }));
    run('COMMIT');
    persistDb();
    console.log(`Migrated ${seed.folders.length} folders and ${seed.recipes.length} recipes into SQLite`);
  } catch (e) {
    run('ROLLBACK');
    throw e;
  }
}

async function backfillMissingOcr() {
  const missing = all(`SELECT id, filename FROM recipes
    WHERE filename IS NOT NULL
      AND filename != ''
      AND (ocr_text IS NULL OR ocr_text = '')
      AND (ocr_status IS NULL OR ocr_status != 'failed')`);

  for (const recipe of missing) {
    const filePath = path.join(UPLOADS_DIR, recipe.filename);
    if (!fs.existsSync(filePath)) continue;
    console.log(`Reading recipe text from ${recipe.filename}`);
    const ocr = await readRecipeTextFromImage(filePath);
    run(`UPDATE recipes
      SET ocr_text = ?, ingredients_json = ?, steps_json = ?, ocr_status = ?, ocr_error = ?
      WHERE id = ?`, [
      ocr.text,
      JSON.stringify(ocr.ingredients),
      JSON.stringify(ocr.steps),
      ocr.status,
      ocr.error,
      String(recipe.id)
    ]);
    persistDb();
  }
}

async function reprocessAllOcr() {
  const recipes = all(`SELECT id, filename FROM recipes
    WHERE filename IS NOT NULL
      AND filename != ''`);

  let updated = 0;
  let missing = 0;
  for (const recipe of recipes) {
    const filePath = path.join(UPLOADS_DIR, recipe.filename);
    if (!fs.existsSync(filePath)) {
      missing += 1;
      continue;
    }
    console.log(`Re-reading recipe text from ${recipe.filename}`);
    const ocr = await readRecipeTextFromImage(filePath);
    run(`UPDATE recipes
      SET ocr_text = ?, ingredients_json = ?, steps_json = ?, ocr_status = ?, ocr_error = ?
      WHERE id = ?`, [
      ocr.text,
      JSON.stringify(ocr.ingredients),
      JSON.stringify(ocr.steps),
      ocr.status,
      ocr.error,
      String(recipe.id)
    ]);
    persistDb();
    updated += 1;
  }

  return { updated, missing };
}

async function restoreExistingOcrIfNeeded() {
  if (getMeta('ocr_algorithm_version') === OCR_ALGORITHM_VERSION) return;
  const result = await reprocessAllOcr();
  setMeta('ocr_algorithm_version', OCR_ALGORITHM_VERSION);
  persistDb();
  console.log(`OCR restore complete: ${result.updated} updated, ${result.missing} missing image files`);
}

async function initDatabase() {
  const SQL = await initSqlJs({
    locateFile: file => path.join(__dirname, 'node_modules/sql.js/dist', file)
  });

  db = fs.existsSync(DB_FILE)
    ? new SQL.Database(fs.readFileSync(DB_FILE))
    : new SQL.Database();

  run('PRAGMA foreign_keys = ON');
  run(`CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id TEXT,
    created_at TEXT NOT NULL
  )`);
  const folderColumns = all('PRAGMA table_info(folders)').map(col => col.name);
  if (!folderColumns.includes('parent_id')) {
    run('ALTER TABLE folders ADD COLUMN parent_id TEXT');
  }
  run(`CREATE TABLE IF NOT EXISTS recipes (
    id TEXT PRIMARY KEY,
    folder_id TEXT,
    filename TEXT NOT NULL,
    name TEXT NOT NULL,
    ocr_text TEXT NOT NULL DEFAULT '',
    ingredients_json TEXT NOT NULL DEFAULT '[]',
    steps_json TEXT NOT NULL DEFAULT '[]',
    ocr_status TEXT NOT NULL DEFAULT 'pending',
    ocr_error TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL
  )`);
  run(`CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  run('CREATE INDEX IF NOT EXISTS idx_recipes_folder ON recipes(folder_id)');
  run('CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id)');
  migrateJsonSeed();
  persistDb();
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_'))
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024, files: 8 } });

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
  const limit = 1024 * 1024;

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

app.get('/api/diag', (req, res) => {
  const testFile = DB_FILE + '.tmp';
  try {
    fs.writeFileSync(testFile, 'ok', 'utf8');
    fs.unlinkSync(testFile);
    res.json({ writable: true, database: DB_FILE, legacyJsonImport: getMeta(LEGACY_JSON_IMPORT_META_KEY), uploads: UPLOADS_DIR, uid: process.getuid?.(), gid: process.getgid?.() });
  } catch (e) {
    res.json({ writable: false, error: e.message, database: DB_FILE, legacyJsonImport: getMeta(LEGACY_JSON_IMPORT_META_KEY), uploads: UPLOADS_DIR, uid: process.getuid?.(), gid: process.getgid?.() });
  }
});

app.get('/api/folders', (req, res) => {
  res.json(getFolders());
});

app.post('/api/folders', (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const name = body.name ?? req.query?.name;
    const parentId = body.parentId ?? req.query?.parentId ?? null;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required' });
    if (parentId && !one('SELECT id FROM folders WHERE id = ?', [String(parentId)])) return res.status(400).json({ error: 'Parent folder not found' });
    const folder = {
      id: Date.now().toString(),
      name: String(name).trim(),
      parentId: parentId ? String(parentId) : null,
      createdAt: new Date().toISOString()
    };
    run('INSERT INTO folders (id, name, parent_id, created_at) VALUES (?, ?, ?, ?)', [folder.id, folder.name, folder.parentId, folder.createdAt]);
    persistDb();
    res.json(folder);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function wouldCreateFolderCycle(folderId, parentId) {
  let currentId = parentId ? String(parentId) : null;
  const seen = new Set();
  while (currentId) {
    if (currentId === String(folderId)) return true;
    if (seen.has(currentId)) return true;
    seen.add(currentId);
    const parent = one('SELECT parent_id FROM folders WHERE id = ?', [currentId]);
    currentId = parent?.parent_id ? String(parent.parent_id) : null;
  }
  return false;
}

const updateFolder = (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const name = body.name ?? req.query?.name;
    const parentId = body.parentId ?? req.query?.parentId;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required' });
    const folder = one('SELECT * FROM folders WHERE id = ?', [String(req.params.id)]);
    if (!folder) return res.status(404).json({ error: 'Not found' });
    const nextParentId = parentId === undefined ? (folder.parent_id || null) : (parentId ? String(parentId) : null);
    if (nextParentId && !one('SELECT id FROM folders WHERE id = ?', [nextParentId])) return res.status(400).json({ error: 'Parent folder not found' });
    if (wouldCreateFolderCycle(req.params.id, nextParentId)) return res.status(400).json({ error: 'A folder cannot be inside itself' });
    run('UPDATE folders SET name = ?, parent_id = ? WHERE id = ?', [String(name).trim(), nextParentId, String(req.params.id)]);
    persistDb();
    res.json(rowToFolder(one('SELECT * FROM folders WHERE id = ?', [String(req.params.id)])));
  } catch (e) { res.status(500).json({ error: e.message }); }
};
app.post('/api/folders/:id', updateFolder);
app.patch('/api/folders/:id', updateFolder);
app.put('/api/folders/:id', updateFolder);

app.delete('/api/folders/:id', (req, res) => {
  try {
    const folder = one('SELECT * FROM folders WHERE id = ?', [String(req.params.id)]);
    run('UPDATE recipes SET folder_id = NULL WHERE folder_id = ?', [String(req.params.id)]);
    run('UPDATE folders SET parent_id = ? WHERE parent_id = ?', [folder?.parent_id || null, String(req.params.id)]);
    run('DELETE FROM folders WHERE id = ?', [String(req.params.id)]);
    persistDb();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/recipes', (req, res) => {
  res.json(getRecipes({
    search: req.query.search || req.query.q || '',
    folderId: req.query.folderId || '',
    mode: req.query.mode || ''
  }));
});

app.post('/api/recipes', upload.fields([
  { name: 'photos', maxCount: 8 },
  { name: 'photo', maxCount: 1 }
]), async (req, res) => {
  try {
    const files = [
      ...(req.files?.photos || []),
      ...(req.files?.photo || [])
    ];
    if (!files.length) return res.status(400).json({ error: 'Photo required' });
    const coverFile = files[0];
    const recipe = {
      id: Date.now().toString(),
      folderId: req.body.folderId || null,
      filename: coverFile.filename,
      name: req.body.name || 'Untitled Recipe',
      ocrText: '',
      ingredients: [],
      steps: [],
      ocrStatus: 'pending',
      ocrError: null,
      createdAt: new Date().toISOString()
    };

    run(`INSERT INTO recipes
      (id, folder_id, filename, name, ocr_text, ingredients_json, steps_json, ocr_status, ocr_error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      recipe.id,
      recipe.folderId,
      recipe.filename,
      recipe.name,
      recipe.ocrText,
      JSON.stringify(recipe.ingredients),
      JSON.stringify(recipe.steps),
      recipe.ocrStatus,
      recipe.ocrError,
      recipe.createdAt
    ]);
    persistDb();
    res.json(recipe);
    setImmediate(() => {
      updateRecipeOcrFromImages(recipe.id, files).catch(err => console.error('Background OCR failed:', err.stack || err));
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const patchRecipe = (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const recipe = getRecipe(req.params.id);
    if (!recipe) return res.status(404).json({ error: 'Not found' });
    const name = body.name ?? req.query?.name;
    const folderId = body.folderId ?? req.query?.folderId;
    const hasOcrText = Object.prototype.hasOwnProperty.call(body, 'ocrText');
    const hasIngredients = Object.prototype.hasOwnProperty.call(body, 'ingredients');
    const hasSteps = Object.prototype.hasOwnProperty.call(body, 'steps');
    if (name !== undefined) {
      const cleanName = String(name).trim();
      if (!cleanName) return res.status(400).json({ error: 'Name required' });
      run('UPDATE recipes SET name = ? WHERE id = ?', [cleanName, String(req.params.id)]);
    }
    if (folderId !== undefined) {
      const nextFolderId = folderId ? String(folderId) : null;
      if (nextFolderId && !one('SELECT id FROM folders WHERE id = ?', [nextFolderId])) return res.status(400).json({ error: 'Folder not found' });
      run('UPDATE recipes SET folder_id = ? WHERE id = ?', [nextFolderId, String(req.params.id)]);
    }
    if (hasOcrText || hasIngredients || hasSteps) {
      const ocrText = hasOcrText ? cleanOcrText(body.ocrText) : recipe.ocrText;
      const parsed = parseRecipeText(ocrText);
      const ingredients = hasIngredients ? normalizeTextList(body.ingredients) : parsed.ingredients;
      const steps = hasSteps ? normalizeTextList(body.steps) : parsed.steps;
      run(`UPDATE recipes
        SET ocr_text = ?, ingredients_json = ?, steps_json = ?, ocr_status = ?, ocr_error = ?
        WHERE id = ?`, [
        ocrText,
        JSON.stringify(ingredients),
        JSON.stringify(steps),
        ocrText ? 'complete' : 'empty',
        null,
        String(req.params.id)
      ]);
    }
    persistDb();
    res.json(getRecipe(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
};
app.post('/api/recipes/:id', patchRecipe);
app.patch('/api/recipes/:id', patchRecipe);

app.delete('/api/recipes/:id', (req, res) => {
  try {
    const recipe = getRecipe(req.params.id);
    if (recipe) {
      const fp = path.join(UPLOADS_DIR, recipe.filename);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    run('DELETE FROM recipes WHERE id = ?', [String(req.params.id)]);
    persistDb();
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

initDatabase()
  .then(() => {
    if (process.argv.includes('--reprocess-ocr')) {
      return reprocessAllOcr()
        .then(({ updated, missing }) => {
          setMeta('ocr_algorithm_version', OCR_ALGORITHM_VERSION);
          persistDb();
          console.log(`OCR reprocess complete: ${updated} updated, ${missing} missing image files`);
        })
        .finally(() => {
          process.exit(0);
        });
    }

    app.listen(PORT, '0.0.0.0', () => console.log('Recipe box ready on port ' + PORT));
    backfillMissingOcr()
      .then(() => restoreExistingOcrIfNeeded())
      .catch(err => console.error('OCR restore failed:', err.stack || err));
  })
  .catch(err => {
    console.error('Database startup failed:', err.stack || err);
    process.exit(1);
  });
