/**
 * Загружает изображение токена через форму на ponsfamily.com/launchpad/create
 * и возвращает ссылку на файл в IPFS.
 *
 * Как это работает:
 * 1. Открывает страницу создания токена в headless-браузере
 * 2. Кликает чекбокс "I understand that selected artwork will be moderated..."
 * 3. Загружает файл через input[type=file]
 * 4. Ждёт, пока бэкенд обработает картинку и появится превью / ссылка
 * 5. Возвращает { uri, cid } — например:
 *    { uri: "ipfs://bafkrei...", cid: "bafkrei..." }
 *
 * Установка:
 *   npm init -y
 *   npm install playwright
 *   npx playwright install chromium
 *
 * Запуск:
 *   node upload-to-pons.js /путь/до/logo.png
 */

const { chromium } = require('playwright');
const path = require('path');

const CREATE_PAGE_URL = 'https://ponsfamily.com/launchpad/create';

const SELECTORS = {
  consentCheckbox: 'text=I understand that selected artwork will be moderated',
  fileInput: 'input[type="file"], input.launchpad-file-input',
  uploadThumb: '.launchpad-upload-thumb img, label.launchpad-upload img, img[src*="ipfs"], img[src*="/api/"]',
};

const UPLOAD_RESPONSE_URL_PARTS = [
  '/api/ipfs/image',
  '/api/ipfs',
  '/ipfs/image',
  '/upload',
];

function isUploadImageResponse(res) {
  const request = res.request();
  const url = res.url();

  return (
    request.method() === 'POST' &&
    res.status() < 400 &&
    UPLOAD_RESPONSE_URL_PARTS.some((part) => url.includes(part))
  );
}

function normalizeUploadPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { uri: null, cid: null };
  }

  const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  const cid = data.cid || data.Hash || data.hash || data.IpfsHash || data.ipfsHash || null;
  const uri = data.uri || data.url || data.image || data.imageUrl || data.src || (cid ? `ipfs://${cid}` : null);

  return { uri, cid };
}

async function readUploadResponse(res) {
  const contentType = (res.headers()['content-type'] || '').toLowerCase();

  if (contentType.includes('application/json')) {
    return normalizeUploadPayload(await res.json());
  }

  const body = await res.text();
  try {
    return normalizeUploadPayload(JSON.parse(body));
  } catch {
    const ipfsMatch = body.match(/ipfs:\/\/[^\s"'<>]+/i);
    if (ipfsMatch) {
      return { uri: ipfsMatch[0], cid: ipfsMatch[0].replace(/^ipfs:\/\//i, '') };
    }

    return { uri: null, cid: null };
  }
}

async function uploadTokenImage(imagePath, { headless = true, timeoutMs = 30000 } = {}) {
  const browser = await chromium.launch({ headless });
  const page = await browser.newPage();

  try {
    await page.goto(CREATE_PAGE_URL, { waitUntil: 'networkidle' });

    // 1. Согласие на модерацию/публичную загрузку
    const consent = page.locator(SELECTORS.consentCheckbox).first();
    if (await consent.count() > 0) {
      const checkboxNearText = page.locator('input[type=checkbox]').first();
      if (await checkboxNearText.count() > 0) {
        await checkboxNearText.check({ force: true }).catch(() => consent.click());
      } else {
        await consent.click();
      }
    }

    const fileInput = page.locator(SELECTORS.fileInput).first();
    await fileInput.waitFor({ state: 'attached', timeout: timeoutMs });

    // Важно: начинаем ждать POST до setInputFiles(). Иначе быстрый ответ аплоада
    // можно пропустить, и код упадёт с ошибкой "Не удалось поймать ссылку".
    const responsePromise = page.waitForResponse(isUploadImageResponse, { timeout: timeoutMs })
      .then(readUploadResponse)
      .catch(() => ({ uri: null, cid: null }));

    await fileInput.setInputFiles(path.resolve(imagePath));

    const thumbPromise = page.locator(SELECTORS.uploadThumb)
      .first()
      .waitFor({ state: 'visible', timeout: timeoutMs })
      .then(async () => {
        const src = await page.locator(SELECTORS.uploadThumb).first().getAttribute('src');
        return { uri: src, cid: null };
      })
      .catch(() => ({ uri: null, cid: null }));

    let { uri, cid } = await responsePromise;
    if (!uri) {
      ({ uri, cid } = await thumbPromise);
    }

    if (!uri) {
      throw new Error(
        'Не удалось поймать ссылку на изображение. ' +
        'Проверьте Network tab: не найден успешный POST загрузки или src превью.'
      );
    }

    return { uri, cid };
  } finally {
    await browser.close();
  }
}

// CLI-запуск: node upload-to-pons.js ./logo.png
if (require.main === module) {
  const imagePath = process.argv[2];
  if (!imagePath) {
    console.error('Использование: node upload-to-pons.js <путь-к-картинке>');
    process.exit(1);
  }

  uploadTokenImage(imagePath, { headless: true })
    .then(({ uri, cid }) => {
      console.log('Готово.');
      console.log('URI:', uri);
      console.log('CID:', cid);
    })
    .catch((err) => {
      console.error('Ошибка загрузки:', err.message);
      process.exit(1);
    });
}

module.exports = { uploadTokenImage };
