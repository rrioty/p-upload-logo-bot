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
  uploadThumb: '.launchpad-upload-thumb img, label.launchpad-upload img, img[src]',
};

const UPLOAD_RESPONSE_URL_HINTS = [
  '/api/',
  '/ipfs',
  '/upload',
  '/image',
  '/file',
  '/media',
  'pinata',
  'cloudflare',
  'r2',
  's3',
];

const IPFS_URI_RE = /ipfs:\/\/[^\s"'<>),}]+/i;
const IPFS_GATEWAY_RE = /https?:\/\/[^\s"'<>),}]+\/ipfs\/([a-z0-9]+)[^\s"'<>),}]*/i;
const CID_RE = /\b(?:bafy|bafk|bagi|Qm)[a-z0-9]{20,}\b/i;

function extractUploadResult(value, seen = new Set()) {
  if (!value) {
    return { uri: null, cid: null };
  }

  if (typeof value === 'string') {
    const ipfsUri = value.match(IPFS_URI_RE)?.[0] || null;
    if (ipfsUri) {
      return { uri: ipfsUri, cid: ipfsUri.replace(/^ipfs:\/\//i, '').split(/[/?#]/)[0] };
    }

    const gatewayMatch = value.match(IPFS_GATEWAY_RE);
    if (gatewayMatch) {
      return { uri: value, cid: gatewayMatch[1] };
    }

    const cid = value.match(CID_RE)?.[0] || null;
    return { uri: cid ? `ipfs://${cid}` : null, cid };
  }

  if (typeof value !== 'object' || seen.has(value)) {
    return { uri: null, cid: null };
  }
  seen.add(value);

  const preferredKeys = [
    'uri',
    'url',
    'image',
    'imageUrl',
    'src',
    'cid',
    'Hash',
    'hash',
    'IpfsHash',
    'ipfsHash',
  ];

  for (const key of preferredKeys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const result = extractUploadResult(value[key], seen);
      if (result.uri) {
        return result;
      }
    }
  }

  for (const nested of Object.values(value)) {
    const result = extractUploadResult(nested, seen);
    if (result.uri) {
      return result;
    }
  }

  return { uri: null, cid: null };
}

function isLikelyUploadResponse(res) {
  const request = res.request();
  const url = res.url().toLowerCase();
  const resourceType = request.resourceType();

  return (
    res.status() < 400 &&
    ['fetch', 'xhr'].includes(resourceType) &&
    UPLOAD_RESPONSE_URL_HINTS.some((hint) => url.includes(hint))
  );
}

async function readUploadResponse(res) {
  const contentType = (res.headers()['content-type'] || '').toLowerCase();

  if (contentType.includes('application/json')) {
    return extractUploadResult(await res.json());
  }

  if (!contentType || contentType.includes('text/') || contentType.includes('javascript')) {
    const body = await res.text();
    try {
      return extractUploadResult(JSON.parse(body));
    } catch {
      return extractUploadResult(body);
    }
  }

  return { uri: null, cid: null };
}

async function waitForCapturedUpload(getCapturedUpload, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await getCapturedUpload();
    if (result.uri) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return { uri: null, cid: null };
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

    const observedUploadUrls = [];
    let capturedUpload = Promise.resolve({ uri: null, cid: null });
    page.on('response', (res) => {
      if (!isLikelyUploadResponse(res)) {
        return;
      }

      observedUploadUrls.push(`${res.status()} ${res.request().method()} ${res.url()}`);
      capturedUpload = capturedUpload.then(async (previous) => {
        if (previous.uri) {
          return previous;
        }

        return readUploadResponse(res).catch(() => ({ uri: null, cid: null }));
      });
    });

    await fileInput.setInputFiles(path.resolve(imagePath));

    const networkPromise = waitForCapturedUpload(() => capturedUpload, timeoutMs);
    const thumbPromise = page.locator(SELECTORS.uploadThumb)
      .first()
      .waitFor({ state: 'visible', timeout: timeoutMs })
      .then(async () => extractUploadResult(await page.locator(SELECTORS.uploadThumb).first().getAttribute('src')))
      .catch(() => ({ uri: null, cid: null }));

    let { uri, cid } = await Promise.race([networkPromise, thumbPromise]);

    if (!uri) {
      ({ uri, cid } = await networkPromise);
    }
    if (!uri) {
      ({ uri, cid } = await thumbPromise);
    }

    if (!uri) {
      const observed = observedUploadUrls.length > 0
        ? ` Проверенные ответы: ${observedUploadUrls.slice(-5).join('; ')}`
        : ' Подходящих upload/API ответов не было видно.';
      throw new Error(
        'Не удалось поймать ссылку на изображение. ' +
        'Не найден IPFS URI/CID ни в ответах upload API, ни в src превью.' +
        observed
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
