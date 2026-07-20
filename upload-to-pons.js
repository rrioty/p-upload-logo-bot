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

// Селекторы взяты из devtools-инспекции страницы (актуально на 2026-07-20).
// Если верстка поменяется — их нужно будет перепроверить.
const SELECTORS = {
  // сам чекбокс/лейбл согласия на модерацию — рядом с загрузчиком,
  // на скрине текст "I understand that selected artwork will be moderated..."
  consentCheckbox: 'text=I understand that selected artwork will be moderated',
  fileInput: 'input.launchpad-file-input',
  // после успешной загрузки на месте плейсхолдера обычно появляется <img> с превью
  uploadThumb: '.launchpad-upload-thumb img',
  // класс на label меняется с "is-ready" на что-то вроде "is-done"/"has-image" после загрузки —
  // это нужно перепроверить вручную, см. TODO ниже
  uploadLabel: 'label.launchpad-upload',
};

async function uploadTokenImage(imagePath, { headless = true, timeoutMs = 30000 } = {}) {
  const browser = await chromium.launch({ headless });
  const page = await browser.newPage();

  try {
    await page.goto(CREATE_PAGE_URL, { waitUntil: 'networkidle' });

    // 1. Согласие на модерацию/публичную загрузку
    const consent = page.locator(SELECTORS.consentCheckbox).first();
    if (await consent.count() > 0) {
      // если это чекбокс рядом с текстом — кликаем именно по input, а не по тексту
      const checkboxNearText = page.locator('input[type=checkbox]').first();
      if (await checkboxNearText.count() > 0) {
        await checkboxNearText.check({ force: true }).catch(() => consent.click());
      } else {
        await consent.click();
      }
    }

    // 2. Загружаем файл
    const fileInput = page.locator(SELECTORS.fileInput);
    await fileInput.waitFor({ state: 'attached', timeout: timeoutMs });
    await fileInput.setInputFiles(path.resolve(imagePath));

    // 3. Ждём, пока бэкенд обработает файл — либо появится превью,
    //    либо в сетевых запросах пройдёт ответ от аплоад-эндпоинта.
    //    Ловим сетевой ответ параллельно с ожиданием превью — что раньше сработает.
    let capturedUrl = null;
    let capturedCid = null;

    // Реальный эндпоинт, найденный через DevTools Network:
    // POST https://ponsfamily.com/api/ipfs/image (multipart/form-data)
    // Ответ вида: { "cid": "bafkrei...", "uri": "ipfs://bafkrei..." }
    const responsePromise = page.waitForResponse(
      (res) =>
        res.url() === 'https://ponsfamily.com/api/ipfs/image' &&
        res.request().method() === 'POST' &&
        res.status() < 400,
      { timeout: timeoutMs }
    ).then(async (res) => {
      try {
        const json = await res.json();
        capturedCid = json.cid || null;
        capturedUrl = json.uri || (json.cid ? `ipfs://${json.cid}` : null);
      } catch {
        // ответ не JSON — пропускаем, попробуем достать ссылку из DOM
      }
    }).catch(() => null);

    await Promise.race([
      responsePromise,
      page.locator(SELECTORS.uploadThumb).waitFor({ state: 'visible', timeout: timeoutMs }),
    ]);

    // 4. Если ссылку не поймали из сетевого ответа — пробуем достать из DOM
    if (!capturedUrl) {
      const thumb = page.locator(SELECTORS.uploadThumb);
      if (await thumb.count() > 0) {
        capturedUrl = await thumb.getAttribute('src');
      }
    }

    if (!capturedUrl) {
      throw new Error(
        'Не удалось поймать ссылку на изображение. ' +
        'Нужно посмотреть реальный сетевой запрос (Network tab) и поправить SELECTORS/парсинг ответа.'
      );
    }

    return { uri: capturedUrl, cid: capturedCid };
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
