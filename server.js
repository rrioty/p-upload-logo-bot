const express = require('express');
const multer = require('multer');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { uploadTokenImage } = require('./upload-to-pons');

const app = express();
const upload = multer({ dest: os.tmpdir() });

app.get('/health', (_req, res) => res.json({ ok: true }));

// Тест: curl -F "image=@./logo.png" https://<ваш-сервис>.onrender.com/upload
app.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Пришлите файл в поле "image" (multipart/form-data)' });
  }

  const tmpPath = req.file.path;
  try {
    // headless: true обязателен на Render — там нет дисплея
    const result = await uploadTokenImage(tmpPath, { headless: true, timeoutMs: 45000 });
    res.json(result); // { uri, cid }
  } catch (err) {
    console.error('Upload failed:', err);
    res.status(500).json({ error: err.message });
  } finally {
    fs.unlink(tmpPath, () => {});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on :${PORT}`));
