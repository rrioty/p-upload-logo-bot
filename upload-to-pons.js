const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const CREATE_PAGE_URL = 'https://ponsfamily.com/launchpad/create';
const UPLOAD_ENDPOINT = 'https://ponsfamily.com/api/ipfs/image';

const SELECTORS = { fileInput: 'input.launchpad-file-input' };

async function uploadTokenImage(imagePath, { headless = true, timeoutMs = 60000 } = {}) {
  const browser = await chromium.launch({
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
  });
  const page = await context.newPage();

  const requestLog = [];
  page.on('request', (req) => {
    if (req.url().includes('ponsfamily.com/api')) {
      requestLog.push(`→ ${req.method()} ${req.url()}`);
    }
  });
  page.on('response', (res) => {
    if (res.url().includes('ponsfamily.com/api')) {
      requestLog.push(`← ${res.status()} ${res.url()}`);
    }
  });
  page.on('console', (msg) => console.log(`[page ${msg.type()}]`, msg.text()));

  const saveDebug = async (label) => {
    const dir = `/tmp/debug-${Date.now()}-${label}`;
    fs.mkdirSync(dir, { recursive: true });
    try { await page.screenshot({ path: `${dir}/screen.png`, fullPage: true }); } catch {}
    try { fs.writeFileSync(`${dir}/page.html`, await page.content()); } catch {}
    fs.writeFileSync(`${dir}/requests.log`, requestLog.join('\n'));
    console.error(`Debug сохранён в ${dir}`);
    return dir;
  };

  try {
    console.log('1) Открываю страницу…');
    await page.goto(CREATE_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {});
    console.log('   title:', await page.title());

    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (/just a moment|checking your browser|cloudflare/i.test(bodyText)) {
      const dir = await saveDebug('cf-challenge');
      const e = new Error('Cloudflare показывает challenge');
      e.debugDir = dir;
      throw e;
    }

    console.log('2) Ищу чекбокс согласия…');
    const checkboxCandidates = [
      page.getByRole('checkbox'),
      page.locator('input[type=checkbox]'),
      page.locator('.launchpad-disclosure input'),
      page.locator('.launchpad-disclosure'),
    ];
    let checked = false;
    for (const cand of checkboxCandidates) {
      const count = await cand.count().catch(() => 0);
      if (count > 0) {
        try {
          await cand.first().check({ force: true, timeout: 3000 });
          checked = true;
          break;
        } catch {
          try {
            await cand.first().click({ force: true, timeout: 3000 });
            checked = true;
            break;
          } catch {}
        }
      }
    }
    if (!checked) {
      const dir = await saveDebug('no-checkbox');
      const e = new Error('Не нашёл чекбокс согласия');
      e.debugDir = dir;
      throw e;
    }
    console.log('   чекбокс отмечен');

    // маленькая пауза — иногда чекбокс отправляет запрос на бэк, который выдаёт токен
    await page.waitForTimeout(1000);

    console.log('3) Ищу input[type=file] и загружаю файл…');
    const fileInput = page.locator(SELECTORS.fileInput);
    const fileInputCount = await fileInput.count();
    if (fileInputCount === 0) {
      const dir = await saveDebug('no-file-input');
      const e = new Error(`Не нашёл ${SELECTORS.fileInput}`);
      e.debugDir = dir;
      throw e;
    }
    await fileInput.setInputFiles(path.resolve(imagePath));
    console.log('   файл передан в input');

    console.log('4) Жду ответ от', UPLOAD_ENDPOINT, '…');
    let capturedUrl = null;
    let capturedCid = null;
    try {
      // Ловим ЛЮБОЙ ответ (включая 4xx/5xx), не только успешные
      const res = await page.waitForResponse(
        (r) => r.url() === UPLOAD_ENDPOINT && r.request().method() === 'POST',
        { timeout: timeoutMs }
      );
      const status = res.status();
      console.log('   статус ответа:', status);

      const responseHeaders = res.headers();
      console.log('   заголовки ответа:', JSON.stringify(responseHeaders, null, 2));

      const requestHeaders = res.request().headers();
      console.log('   заголовки запроса:', JSON.stringify(requestHeaders, null, 2));

      const bodyText = await res.text().catch(() => '<не удалось прочитать тело>');
      console.log('   тело ответа:', bodyText.slice(0, 1000));

      if (status >= 400) {
        const dir = await saveDebug(`upload-${status}`);
        // сохраняем полное тело ответа и заголовки отдельно
        fs.writeFileSync(`${dir}/response-body.txt`, bodyText);
        fs.writeFileSync(`${dir}/response-headers.json`, JSON.stringify(responseHeaders, null, 2));
        fs.writeFileSync(`${dir}/request-headers.json`, JSON.stringify(requestHeaders, null, 2));
        const e = new Error(`Upload вернул ${status}. Тело: ${bodyText.slice(0, 300)}`);
        e.debugDir = dir;
        throw e;
      }

      try {
        const json = JSON.parse(bodyText);
        capturedCid = json.cid || null;
        capturedUrl = json.uri || (json.cid ? `ipfs://${json.cid}` : null);
      } catch {}
    } catch (waitErr) {
      if (waitErr.debugDir) throw waitErr; // уже наша обёрнутая ошибка
      const dir = await saveDebug('no-upload-response');
      console.error('   запросы к /api за сессию:', requestLog);
      const e = new Error(`Не дождался POST на ${UPLOAD_ENDPOINT}: ${waitErr.message}`);
      e.debugDir = dir;
      throw e;
    }

    if (!capturedUrl) {
      const dir = await saveDebug('empty-response');
      const e = new Error('Ответ пришёл, но в нём нет cid/uri');
      e.debugDir = dir;
      throw e;
    }

    console.log('5) Готово:', capturedUrl);
    return { uri: capturedUrl, cid: capturedCid };
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  const imagePath = process.argv[2];
  if (!imagePath) {
    console.error('Использование: node upload-to-pons.js <путь-к-картинке>');
    process.exit(1);
  }
  uploadTokenImage(imagePath, { headless: true })
    .then(({ uri, cid }) => {
      console.log('URI:', uri);
      console.log('CID:', cid);
    })
    .catch((err) => {
      console.error('Ошибка:', err.message);
      if (err.debugDir) console.error('Debug:', err.debugDir);
      process.exit(1);
    });
}

module.exports = { uploadTokenImage };
