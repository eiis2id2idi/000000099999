const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const JWT_SECRET = process.env.JWT_SECRET || 'troque-esse-segredo-em-producao';
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SITES_DIR = path.join(__dirname, 'storage', 'sites');
const APIS_DIR = path.join(__dirname, 'storage', 'apis');

for (const dir of [DATA_DIR, SITES_DIR, APIS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], sites: [], apis: [] }, null, 2));
}

function readDB() {
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
}
function writeDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
function slugify(str) {
  return str
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
function uniqueSlug(base, existingSlugs) {
  let slug = slugify(base) || uuidv4().slice(0, 8);
  let final = slug;
  let i = 1;
  while (existingSlugs.includes(final)) {
    final = `${slug}-${i}`;
    i++;
  }
  return final;
}

const app = express();
app.use(cors());
app.use(express.json());
app.use('/', express.static(path.join(__dirname, 'public')));

// ---------- AUTH ----------
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token ausente' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

app.post('/api/auth/register', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: 'Email e senha (mín. 6 caracteres) obrigatórios' });
  }
  const db = readDB();
  if (db.users.find(u => u.email === email)) {
    return res.status(409).json({ error: 'Email já cadastrado' });
  }
  const user = {
    id: uuidv4(),
    email,
    passwordHash: bcrypt.hashSync(password, 10),
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  writeDB(db);
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, email: user.email });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const db = readDB();
  const user = db.users.find(u => u.email === email);
  if (!user || !bcrypt.compareSync(password || '', user.passwordHash)) {
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, email: user.email });
});

// ---------- UPLOAD SITES (zip com index.html na raiz) ----------
const siteUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.post('/api/sites', requireAuth, siteUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Envie um arquivo .zip do site' });
  const db = readDB();
  const slug = uniqueSlug(req.body.slug || req.file.originalname.replace(/\.zip$/i, ''), db.sites.map(s => s.slug));
  const targetDir = path.join(SITES_DIR, slug);
  fs.mkdirSync(targetDir, { recursive: true });

  try {
    const zip = new AdmZip(req.file.buffer);
    zip.extractAllTo(targetDir, true);
  } catch (e) {
    return res.status(400).json({ error: 'ZIP inválido: ' + e.message });
  }

  if (!fs.existsSync(path.join(targetDir, 'index.html'))) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    return res.status(400).json({ error: 'O index.html precisa estar solto na raiz do ZIP, sem estar dentro de nenhuma pasta' });
  }

  const site = { id: uuidv4(), slug, ownerId: req.user.id, createdAt: new Date().toISOString() };
  db.sites.push(site);
  writeDB(db);
  res.json({ site, url: `/s/${slug}/` });
});

app.get('/api/my/sites', requireAuth, (req, res) => {
  const db = readDB();
  res.json(db.sites.filter(s => s.ownerId === req.user.id));
});

app.delete('/api/sites/:id', requireAuth, (req, res) => {
  const db = readDB();
  const site = db.sites.find(s => s.id === req.params.id && s.ownerId === req.user.id);
  if (!site) return res.status(404).json({ error: 'Site não encontrado' });
  fs.rmSync(path.join(SITES_DIR, site.slug), { recursive: true, force: true });
  db.sites = db.sites.filter(s => s.id !== site.id);
  writeDB(db);
  res.json({ ok: true });
});

// Serve sites estáticos
app.use('/s/:slug', (req, res, next) => {
  const dir = path.join(SITES_DIR, req.params.slug);
  if (!fs.existsSync(dir)) return res.status(404).send('Site não encontrado');
  express.static(dir)(req, res, next);
}, (req, res) => {
  res.status(404).send('Arquivo não encontrado');
});

// ---------- UPLOAD APIs (arquivo .js único) ----------
const apiUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.post('/api/apis', requireAuth, apiUpload.single('file'), (req, res) => {
  if (!req.file || !req.file.originalname.endsWith('.js')) {
    return res.status(400).json({ error: 'Envie um arquivo .js exportando: module.exports = (req, res) => {...} ou um express.Router()' });
  }
  const db = readDB();
  const slug = uniqueSlug(req.body.slug || req.file.originalname.replace(/\.js$/i, ''), db.apis.map(a => a.slug));
  const filePath = path.join(APIS_DIR, `${slug}.js`);
  fs.writeFileSync(filePath, req.file.buffer);

  const api = { id: uuidv4(), slug, ownerId: req.user.id, createdAt: new Date().toISOString() };
  db.apis.push(api);
  writeDB(db);
  res.json({ api, url: `/a/${slug}` });
});

app.get('/api/my/apis', requireAuth, (req, res) => {
  const db = readDB();
  res.json(db.apis.filter(a => a.ownerId === req.user.id));
});

app.delete('/api/apis/:id', requireAuth, (req, res) => {
  const db = readDB();
  const api = db.apis.find(a => a.id === req.params.id && a.ownerId === req.user.id);
  if (!api) return res.status(404).json({ error: 'API não encontrada' });
  const filePath = path.join(APIS_DIR, `${api.slug}.js`);
  delete require.cache[require.resolve(filePath)];
  fs.rmSync(filePath, { force: true });
  db.apis = db.apis.filter(a => a.id !== api.id);
  writeDB(db);
  res.json({ ok: true });
});

// Executa APIs hospedadas dinamicamente
app.all('/a/:slug', mountUserApi);
app.all('/a/:slug/*', mountUserApi);

function mountUserApi(req, res) {
  const filePath = path.join(APIS_DIR, `${req.params.slug}.js`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'API não encontrada' });
  try {
    delete require.cache[require.resolve(filePath)];
    const handler = require(filePath);
    if (typeof handler === 'function') {
      return handler(req, res);
    }
    if (handler && typeof handler.handle === 'function') {
      // é um express.Router()
      req.url = req.originalUrl.replace(`/a/${req.params.slug}`, '') || '/';
      return handler(req, res, () => res.status(404).json({ error: 'Rota não encontrada na API' }));
    }
    res.status(500).json({ error: 'Formato de export inválido no arquivo da API' });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao executar a API: ' + e.message });
  }
}

app.listen(PORT, () => {
  console.log(`Vexus Host rodando em http://localhost:${PORT}`);
});
