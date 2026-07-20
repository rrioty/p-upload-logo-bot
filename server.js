const express = require('express');
const multer = require('multer');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { uploadTokenImage } = require('./upload-to-pons');

const app = express();
// Сохраняем файл с оригинальным именем (с расширением!), чтобы Playwright потом
// передал в форму именно .png / .jpg / .webp / .gif — бэк ponsfamily смотрит на это
const storage = multer.diskStorage({
  destination: os.tmpdir(),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    const safeName = `upload-${Date.now()}${ext}`;
    cb(null, safeName);
  },
});
const upload = multer({ storage });

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Пришлите файл в поле "image" (multipart/form-data)' });
  }
  const tmpPath = req.file.path;
  try {
    const result = await uploadTokenImage(tmpPath, { headless: true, timeoutMs: 60000 });
    res.json(result);
  } catch (err) {
    console.error('Upload failed:', err);
    res.status(500).json({
      error: err.message,
      debugDir: err.debugDir || null,
      // подсказка, как забрать debug-файлы
      hint: err.debugDir
        ? `Открой в браузере: /debug/${path.basename(err.debugDir)}/screen.png и /debug/${path.basename(err.debugDir)}/page.html`
        : null,
    });
  } finally {
    fs.unlink(tmpPath, () => {});
  }
});

// Отдаём debug-файлы наружу, чтобы посмотреть, что видел браузер в момент падения
app.get('/debug/:dir/:file', (req, res) => {
  const dir = req.params.dir.replace(/[^a-zA-Z0-9\-_.]/g, '');
  const file = req.params.file.replace(/[^a-zA-Z0-9\-_.]/g, '');
  const full = path.join('/tmp', dir, file);
  if (!full.startsWith('/tmp/')) return res.status(400).end();
  if (!fs.existsSync(full)) return res.status(404).end();
  res.sendFile(full);
});

// Список всех debug-папок
app.get('/debug', (_req, res) => {
  const dirs = fs.readdirSync('/tmp').filter((d) => d.startsWith('debug-'));
  res.json(dirs.map((d) => ({
    dir: d,
    files: fs.readdirSync(path.join('/tmp', d)),
  })));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on :${PORT}`));
