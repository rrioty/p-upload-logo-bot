const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const CREATE_PAGE_URL = 'https://ponsfamily.com/launchpad/create';
const UPLOAD_ENDPOINT = 'https://ponsfamily.com/api/ipfs/image';

const SELECTORS = {
  fileInput: 'input.launchpad-file-input',
  uploadLabel: 'label.launchpad-upload',
};

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

    console.log('2) Кликаю чекбокс согласия (через реальный click, чтобы React увидел event)…');
    // Реальный клик по label — так React гарантированно обработает изменение стейта
    const disclosureLabel = page.locator('label.launchpad-upload').first();
    const consentCheckbox = page.locator('input[type=checkbox]').first();

    let consentOk = false;
    // 1) Пробуем кликнуть по label чекбокса согласия — обычно текст "I understand..." обёрнут в label
    const consentByText = page.locator('label:has-text("I understand")').first();
    if (await consentByText.count()) {
      try {
        await consentByText.click({ timeout: 3000 });
        consentOk = true;
      } catch {}
    }
    // 2) Fallback — обычный check через input
    if (!consentOk && await consentCheckbox.count()) {
      try {
        await consentCheckbox.check({ force: true, timeout: 3000 });
        consentOk = true;
      } catch {}
    }
    if (!consentOk) {
      const dir = await saveDebug('no-checkbox');
      const e = new Error('Не смог отметить чекбокс согласия');
      e.debugDir = dir;
      throw e;
    }
    console.log('   чекбокс отмечен');
    await page.waitForTimeout(500);

    console.log('3) Устанавливаю файл в input…');
    const fileInput = page.locator(SELECTORS.fileInput);
    if (await fileInput.count() === 0) {
      const dir = await saveDebug('no-file-input');
      const e = new Error(`Не нашёл ${SELECTORS.fileInput}`);
      e.debugDir = dir;
      throw e;
    }

    // Читаем файл сами и подсовываем через DataTransfer + dispatchEvent —
    // это единственный способ, чтобы React 100% увидел изменение input'а
    const absolutePath = path.resolve(imagePath);
    const fileBuffer = fs.readFileSync(absolutePath);
    const fileName = path.basename(absolutePath);
    // определяем mime-type по расширению
    const ext = path.extname(fileName).toLowerCase();
    const mimeByExt = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
    const mime = mimeByExt[ext] || 'image/png';
    const base64 = fileBuffer.toString('base64');
    console.log(`   файл: ${fileName}, ${fileBuffer.length} байт, mime=${mime}`);

    // Способ 1: стандартный setInputFiles
    await fileInput.setInputFiles(absolutePath);

    // Способ 2 (страховка): через DataTransfer + dispatchEvent,
    // чтобы гарантированно триггернуть onChange у React-обёртки
    await page.evaluate(async ({ base64, fileName, mime, selector }) => {
      const input = document.querySelector(selector);
      if (!input) return { ok: false, reason: 'no input in DOM' };
      // Собираем File
      const binary = atob(base64);
      const len = binary.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], fileName, { type: mime });
      // Кладём в DataTransfer
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      // Триггерим и change, и input — React слушает разное в зависимости от версии/обёртки
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, files: input.files.length, first: input.files[0]?.name };
    }, { base64, fileName, mime, selector: SELECTORS.fileInput });
    console.log('   файл установлен + change/input события отправлены');

    console.log('4) Жду ответ от', UPLOAD_ENDPOINT, '…');
    let capturedUrl = null;
    let capturedCid = null;
    try {
      const res = await page.waitForResponse(
        (r) => r.url() === UPLOAD_ENDPOINT && r.request().method() === 'POST',
        { timeout: timeoutMs }
      );
      const status = res.status();
      console.log('   статус ответа:', status);

      const bodyText = await res.text().catch(() => '<не удалось прочитать тело>');
      console.log('   тело ответа:', bodyText.slice(0, 1000));

      if (status >= 400) {
        const dir = await saveDebug(`upload-${status}`);
        fs.writeFileSync(`${dir}/response-body.txt`, bodyText);
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
      if (waitErr.debugDir) throw waitErr;
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
