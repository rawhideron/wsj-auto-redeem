'use strict';

const { connect } = require('puppeteer-real-browser');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

// ── Config ────────────────────────────────────────────────────────────────────
const WSJ_EMAIL            = process.env.WSJ_EMAIL            || '';
const WSJ_PASSWORD         = process.env.WSJ_PASSWORD         || '';
const LIBRARY_CARD_NUMBER  = process.env.LIBRARY_CARD_NUMBER  || '';
const LIBRARY_PIN          = process.env.LIBRARY_PIN          || '';
const LIBRARY_LOGIN_URL    = process.env.LIBRARY_LOGIN_URL    ||
  'https://bccls.polarislibrary.com/polaris/signin.aspx?ctx=1.1033.0.0.1&Red=https://fairviewlibrarynj.org/en/';
const FAIRVIEW_HOME_URL    = process.env.FAIRVIEW_HOME_URL    || 'https://fairviewlibrarynj.org/en/';
const CHROME_PATH          = process.env.CHROME_EXECUTABLE_PATH || undefined;
const USER_DATA_DIR        = process.env.USER_DATA_DIR        || path.join(__dirname, 'cookies', 'chrome-profile');
const ENCRYPT_KEY          = process.env.COOKIE_ENCRYPTION_KEY || '';
const COOKIE_FILE          = path.join(__dirname, 'cookies', 'wsj-cookies.json');
const HISTORY_FILE         = path.join(__dirname, 'cookies', 'history.json');

// ── Cookie encryption ─────────────────────────────────────────────────────────
async function deriveKey(passphrase, salt) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(passphrase, salt, 32, (err, key) => (err ? reject(err) : resolve(key)))
  );
}

async function encryptData(data) {
  const salt   = crypto.randomBytes(16);
  const iv     = crypto.randomBytes(12);
  const key    = await deriveKey(ENCRYPT_KEY, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc    = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return JSON.stringify({
    salt: salt.toString('hex'), iv: iv.toString('hex'),
    tag: tag.toString('hex'),  data: enc.toString('hex'),
  });
}

async function decryptData(raw) {
  const { salt, iv, tag, data } = JSON.parse(raw);
  const key     = await deriveKey(ENCRYPT_KEY, Buffer.from(salt, 'hex'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]);
  return JSON.parse(dec.toString('utf8'));
}

async function loadCookies() {
  try {
    const raw = await fs.readFile(COOKIE_FILE, 'utf8');
    if (ENCRYPT_KEY) return decryptData(raw);
    return JSON.parse(raw);
  } catch { return null; }
}

async function saveCookies(cookies) {
  await fs.mkdir(path.dirname(COOKIE_FILE), { recursive: true });
  const out = ENCRYPT_KEY ? await encryptData(cookies) : JSON.stringify(cookies, null, 2);
  await fs.writeFile(COOKIE_FILE, out, 'utf8');
}

// ── Browser ───────────────────────────────────────────────────────────────────
async function clearChromeLocks() {
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    await fs.unlink(path.join(USER_DATA_DIR, f)).catch(() => {});
  }
}

async function launchBrowser() {
  await clearChromeLocks();
  const opts = {
    headless: false,
    // args are merged into chrome-launcher's chromeFlags
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--no-first-run', '--no-default-browser-check'],
    customConfig: {},
    turnstile: true,
    connectOption: { defaultViewport: { width: 1440, height: 900 } },
    disableXvfb: true,
    ignoreAllFlags: false,
  };
  if (CHROME_PATH)    opts.customConfig.chromePath    = CHROME_PATH;
  if (USER_DATA_DIR)  opts.customConfig.userDataDir   = USER_DATA_DIR;
  const { browser, page } = await connect(opts);
  return { browser, page };
}

async function applyStealthToPage(page) {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver',  { get: () => undefined });
    Object.defineProperty(navigator, 'languages',  { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins',    { get: () => [1, 2, 3, 4, 5] });
  });
}

// ── Human-like helpers ────────────────────────────────────────────────────────
function randomDelay(min = 800, max = 2500) {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

async function humanMouseMove(page, element) {
  try {
    const box = await element.boundingBox();
    if (!box) return;
    const tx = box.x + box.width  * (0.3 + Math.random() * 0.4);
    const ty = box.y + box.height * (0.3 + Math.random() * 0.4);
    const { x: cx, y: cy } = await page.evaluate(
      () => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
    );
    const steps = 8 + Math.floor(Math.random() * 8);
    for (let i = 0; i <= steps; i++) {
      const t    = i / steps;
      const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      await page.mouse.move(
        cx + (tx - cx) * ease + (Math.random() - 0.5) * 4,
        cy + (ty - cy) * ease + (Math.random() - 0.5) * 4
      );
      await new Promise(r => setTimeout(r, 10 + Math.random() * 20));
    }
  } catch {}
}

async function humanClick(page, element) {
  try {
    await element.scrollIntoView();
    await randomDelay(200, 600);
    await humanMouseMove(page, element);
    await randomDelay(50, 150);
    await element.click();
  } catch { await element.click().catch(() => {}); }
}

async function humanType(page, element, text) {
  await humanClick(page, element);
  await randomDelay(200, 500);
  for (const ch of text) {
    await element.type(ch, { delay: 60 + Math.random() * 120 });
  }
}

// ── Library login (BCCLS Polaris) ─────────────────────────────────────────────
async function loginToLibrary(page) {
  if (!LIBRARY_CARD_NUMBER || !LIBRARY_PIN) {
    console.log('[library] No credentials — skipping');
    return false;
  }
  console.log('[library] Logging in...');
  try {
    await page.goto(LIBRARY_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (err) {
    throw new Error(err.message); // re-throw so caller can catch and continue
  }
  await randomDelay();

  const cardSelectors = [
    '#textboxBarcode', 'input[name="textboxBarcode"]',
    'input[id*="card"]', 'input[name*="card"]', 'input[type="text"]',
  ];
  const pinSelectors = [
    '#textboxPassword', 'input[name="textboxPassword"]',
    'input[id*="pin"]', 'input[name*="pin"]', 'input[type="password"]',
  ];

  let cardInput, pinInput;
  for (const sel of cardSelectors) { cardInput = await page.$(sel); if (cardInput) break; }
  for (const sel of pinSelectors)  { pinInput  = await page.$(sel); if (pinInput)  break; }

  if (!cardInput || !pinInput) {
    console.log('[library] Could not find login inputs');
    return false;
  }

  await humanType(page, cardInput, LIBRARY_CARD_NUMBER);
  await humanType(page, pinInput,  LIBRARY_PIN);

  const submit = await page.$('input[type="submit"], button[type="submit"]');
  if (submit) await humanClick(page, submit);
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
  await randomDelay();

  const text    = await page.evaluate(() => document.body.innerText.toLowerCase());
  const success = /sign out|log out|my account|welcome/i.test(text);
  console.log(`[library] ${success ? 'Logged in' : 'Login may have failed'}`);
  return success;
}

// ── Fairview → WSJ partner page ───────────────────────────────────────────────
async function findWSJLink(page) {
  return page.evaluate(() => {
    const direct = Array.from(document.querySelectorAll('a')).find(a =>
      /wsj\.com|partner\.wsj|wall.street/i.test(a.href) ||
      /wall street journal|wsj/i.test(a.innerText + a.title)
    );
    if (direct) return direct.href;
    const imgLink = Array.from(document.querySelectorAll('a')).find(a =>
      Array.from(a.querySelectorAll('img')).some(img => /wsj|wall street/i.test(img.alt + img.src))
    );
    return imgLink ? imgLink.href : null;
  });
}

async function openWSJFromFairview(page) {
  console.log('[fairview] Navigating to Fairview home...');
  await page.goto(FAIRVIEW_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await randomDelay(1500, 3000);

  let wsjHref = await findWSJLink(page);

  // If not on the home page (e.g. redirected by locale/IP), try the Online resources section
  if (!wsjHref) {
    console.log(`[fairview] WSJ link not on initial page (${page.url()}) — trying Online nav...`);
    const onlineClicked = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('a, button'))
        .find(e => /^online$|^e-?resources$|^digital/i.test((e.innerText || e.textContent).trim()));
      if (el) { el.click(); return true; }
      return false;
    });
    if (onlineClicked) {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await randomDelay(1500, 2500);
      wsjHref = await findWSJLink(page);
    }
  }

  // Last resort: try the root domain directly
  if (!wsjHref) {
    console.log('[fairview] Trying root domain...');
    await page.goto('https://fairviewlibrarynj.org/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await randomDelay(1500, 2500);
    wsjHref = await findWSJLink(page);
  }

  if (!wsjHref) throw new Error('WSJ link not found on Fairview home page');

  const codeMatch = wsjHref.match(/enter-redemption-code\/([A-Z0-9]+)/i);
  console.log(`[fairview] WSJ link: ${wsjHref}`);
  if (codeMatch) console.log(`[fairview] Redemption code: ${codeMatch[1]}`);

  await randomDelay();
  await applyStealthToPage(page);
  await page.goto(wsjHref, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await randomDelay(2000, 4000);

  console.log(`[fairview] Arrived at: ${page.url()}`);
  return page;
}

// ── Terms checkbox + Register (used when already authenticated via cookies) ────
async function acceptTermsAndRegister(page) {
  // Check the required ToS checkbox ("By checking this box, I agree to the Terms of Use...")
  const checked = await page.evaluate(() => {
    const cb = Array.from(document.querySelectorAll('input[type="checkbox"]'))
      .find(el => {
        const label = document.querySelector(`label[for="${el.id}"]`);
        return /by checking this box|terms of use|privacy/i.test(
          (label?.innerText || label?.textContent || '') +
          (el.closest('label')?.innerText || '')
        );
      });
    if (cb && !cb.checked) { cb.click(); return true; }
    if (cb?.checked) return true; // already checked
    return false;
  });

  if (!checked) {
    console.log('[wsj] Terms checkbox not found — cannot register');
    return false;
  }
  console.log('[wsj] Terms checkbox checked');
  await randomDelay(500, 1000);

  // Click REGISTER
  const registered = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, input[type="submit"]'))
      .find(el => /register/i.test(el.innerText || el.value || ''));
    if (btn) { btn.click(); return true; }
    return false;
  });

  if (!registered) {
    console.log('[wsj] REGISTER button not found');
    return false;
  }
  console.log('[wsj] Clicked REGISTER');

  await Promise.race([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }),
    randomDelay(6000, 8000),
  ]).catch(() => {});
  await randomDelay(2000, 3000);

  return await isSubscriptionActivated(page);
}

// ── WSJ sign-in ────────────────────────────────────────────────────────────────
// Handles the partner.wsj.com flow:
//   register page → click "SIGN IN" → accounts.wsj.com (email → password, two-step)
async function loginToWSJ(page) {
  if (!WSJ_EMAIL || !WSJ_PASSWORD) {
    console.log('[wsj] No credentials — skipping sign-in');
    return false;
  }

  // Already past the sign-in gate?
  const alreadyDone = await isSubscriptionActivated(page);
  if (alreadyDone) {
    console.log('[wsj] Subscription already activated — no sign-in needed');
    return true;
  }

  // On the register page: click the SIGN IN link
  const onRegister = /register/i.test(page.url());
  if (onRegister) {
    console.log('[wsj] On register page — looking for SIGN IN link...');
    const clicked = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('a, button, [role="button"], span, p'))
        .find(e => /sign[\s-]?in|log[\s-]?in/i.test((e.innerText || e.textContent || '').trim()));
      if (el) { el.click(); return true; }
      return false;
    });
    if (!clicked) {
      // Already authenticated via cookies — page shows only the terms checkbox + REGISTER
      console.log('[wsj] Already authenticated — checking for terms checkbox + REGISTER');
      return await acceptTermsAndRegister(page);
    }
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }),
      randomDelay(4000, 6000),
    ]).catch(() => {});
    await randomDelay();
    console.log(`[wsj] After SIGN IN click: ${page.url()}`);
  }

  // WSJ uses a two-step login: email first, then password on the next screen.
  // We loop up to 4 times to handle each step.
  for (let step = 0; step < 4; step++) {
    const url  = page.url();
    const text = await page.evaluate(() => document.body.innerText);
    console.log(`[wsj] Sign-in step ${step + 1} — ${url}`);

    if (await isSubscriptionActivated(page)) {
      console.log('[wsj] Sign-in complete — subscription activated');
      return true;
    }

    // Email field
    const emailSel = [
      '#username', '#email', 'input[type="email"]',
      'input[autocomplete="username"]', 'input[name*="email"]', 'input[name*="user"]',
    ];
    let emailInput;
    for (const sel of emailSel) { emailInput = await page.$(sel); if (emailInput) break; }

    if (emailInput) {
      const val = await page.evaluate(el => el.value, emailInput);
      if (!val) {
        console.log('[wsj] Entering email...');
        await humanType(page, emailInput, WSJ_EMAIL);
        await randomDelay(400, 800);
      }
    }

    // Password field
    const pwSel = [
      '#password', 'input[type="password"]',
      'input[autocomplete="current-password"]', 'input[name*="pass"]',
    ];
    let pwInput;
    for (const sel of pwSel) { pwInput = await page.$(sel); if (pwInput) break; }

    if (pwInput) {
      const val = await page.evaluate(el => el.value, pwInput);
      if (!val) {
        console.log('[wsj] Entering password...');
        await humanType(page, pwInput, WSJ_PASSWORD);
        await randomDelay(400, 800);
      }
    }

    if (!emailInput && !pwInput) {
      console.log('[wsj] No email or password field found — sign-in flow may have changed');
      break;
    }

    // Submit
    const submitSel = [
      'button[type="submit"]', 'input[type="submit"]',
      'button.btn--primary', 'button.submit', 'button[data-testid*="submit"]',
    ];
    let submitBtn;
    for (const sel of submitSel) { submitBtn = await page.$(sel); if (submitBtn) break; }

    if (!submitBtn) {
      console.log('[wsj] No submit button found');
      break;
    }

    const btnLabel = await page.evaluate(el => el.innerText || el.value, submitBtn);
    console.log(`[wsj] Clicking "${btnLabel.trim()}"...`);
    await humanClick(page, submitBtn);

    await Promise.race([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      randomDelay(6000, 8000),
    ]).catch(() => {});
    await randomDelay(1000, 2000);

    const newText = await page.evaluate(() => document.body.innerText.toLowerCase());
    if (/incorrect|invalid|wrong|error|failed|bad credentials/i.test(newText)) {
      console.log('[wsj] Sign-in failed — check WSJ_EMAIL / WSJ_PASSWORD');
      return false;
    }
  }

  const activated = await isSubscriptionActivated(page);
  console.log(`[wsj] Final sign-in status: ${activated ? 'success' : 'unclear'}`);
  return activated;
}

// ── Outcome detection ─────────────────────────────────────────────────────────
async function isSubscriptionActivated(page) {
  try {
    const text = await page.evaluate(() => document.body.innerText.toLowerCase());
    const url  = page.url();
    // Positive signals: fresh redemption confirmed
    if (/activated|subscription confirmed|thank you|access granted|welcome back|you now have access/i.test(text)) return true;
    // Already subscribed / code already used — subscription is still active, count as success
    if (/already subscribed|already have (an? )?access|already have (an? )?subscription|code (has )?already been redeemed|currently (have )?access/i.test(text)) return true;
    // Landed on WSJ proper (not the partner/login flow) = redemption went through
    if (/^https:\/\/(www\.)?wsj\.com\//i.test(url) && !/login|sign-?in/i.test(url)) return true;
    return false;
  } catch { return false; }
}

async function isBlocked(page) {
  try {
    const text = await page.evaluate(() => document.body.innerText.toLowerCase());
    return /blocked|access denied|robot|captcha detected/i.test(text);
  } catch { return false; }
}

// ── History logging ───────────────────────────────────────────────────────────
async function logAttempt(success, notes = '') {
  let history = [];
  try { history = JSON.parse(await fs.readFile(HISTORY_FILE, 'utf8')); } catch {}
  history.push({ ts: new Date().toISOString(), success, notes });
  if (history.length > 30) history = history.slice(-30);
  await fs.mkdir(path.dirname(HISTORY_FILE), { recursive: true });
  await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
}

async function analyzePattern() {
  try {
    const history = JSON.parse(await fs.readFile(HISTORY_FILE, 'utf8'));
    const recent  = history.slice(-10);
    const wins    = recent.filter(h => h.success).length;
    console.log(`[history] Recent: ${wins}/${recent.length} succeeded`);
    const last = history[history.length - 1];
    if (last) console.log(`[history] Last: ${last.ts} — ${last.success ? 'success' : 'failure'}${last.notes ? ' (' + last.notes + ')' : ''}`);
  } catch {}
}

// ── Main redemption flow ───────────────────────────────────────────────────────
async function redeemSubscription() {
  await analyzePattern();
  console.log('\n[redeem] Starting WSJ redemption...');
  await fs.mkdir(path.join(__dirname, 'cookies'), { recursive: true });

  const { browser, page } = await launchBrowser();
  await applyStealthToPage(page);

  try {
    // Restore cookies from last session
    const saved = await loadCookies();
    if (saved?.length) {
      console.log(`[redeem] Restoring ${saved.length} cookies`);
      for (const c of saved) await page.setCookie(c).catch(() => {});
    }

    // Optional: library login (Fairview WSJ link is publicly visible without it,
    // but kept here in case the library ever gates access behind authentication)
    if (LIBRARY_CARD_NUMBER && LIBRARY_PIN) {
      await loginToLibrary(page).catch(err =>
        console.log(`[library] Login skipped (${err.message}) — continuing without it`)
      );
    }

    // Navigate Fairview → partner.wsj.com redemption URL
    await openWSJFromFairview(page);

    // Debug screenshot
    await page.screenshot({ path: path.join(__dirname, 'cookies', 'wsj-landing.png'), fullPage: true });

    if (await isBlocked(page)) {
      console.log('[redeem] Bot detection triggered — aborting');
      await logAttempt(false, 'bot detection');
      return;
    }

    // Sign in
    const signedIn = await loginToWSJ(page);

    // Persist session cookies
    const cookies = await page.cookies();
    await saveCookies(cookies);
    console.log(`[redeem] Saved ${cookies.length} cookies`);

    await randomDelay(2000, 3000);
    await page.screenshot({ path: path.join(__dirname, 'cookies', 'wsj-final.png'), fullPage: true });

    const finalUrl  = page.url();
    const finalText = await page.evaluate(() => document.body.innerText);
    console.log(`[redeem] Final URL: ${finalUrl}`);
    console.log(`[redeem] Page preview: ${finalText.substring(0, 300).replace(/\n+/g, ' ')}`);

    const activated = signedIn || await isSubscriptionActivated(page);
    const alreadyActive = /already subscribed|already have (an? )?access|already have (an? )?subscription|code (has )?already been redeemed|currently (have )?access/i.test(finalText);
    if (activated) {
      const msg = alreadyActive ? '\n✅ Subscription already active — skipping redundant redemption' : '\n✅ WSJ redemption succeeded!';
      console.log(msg);
      await logAttempt(true, alreadyActive ? 'already active' : finalUrl);
    } else if (/sign.?in|log.?in|register/i.test(finalText)) {
      console.log('\n❌ Still on auth page — sign-in failed');
      await logAttempt(false, 'auth failed');
    } else {
      console.log('\n⚠️  Result unclear — check cookies/wsj-final.png');
      await logAttempt(false, 'unclear — check screenshot');
    }
  } catch (err) {
    console.error('[redeem] Fatal error:', err.message);
    await logAttempt(false, err.message);
    try { await page.screenshot({ path: path.join(__dirname, 'cookies', 'wsj-error.png'), fullPage: true }); } catch {}
  } finally {
    await randomDelay(2000, 3000);
    await browser.close();
  }
}

// ── Manual cookie capture mode ────────────────────────────────────────────────
// Run with: node redeem.js --manual
// Opens visible Chrome so you can log in by hand. Press Ctrl+C to save cookies.
async function manualLogin() {
  console.log('[manual] Opening browser — log in to WSJ, then press Ctrl+C to save cookies.\n');

  const { browser, page } = await launchBrowser();
  await applyStealthToPage(page);

  // Open WSJ sign-in directly
  await page.goto('https://www.wsj.com/login', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});

  process.on('SIGINT', async () => {
    console.log('\n[manual] Capturing cookies...');
    const pages = await browser.pages();
    let all = [];
    for (const p of pages) {
      try { all = all.concat(await p.cookies()); } catch {}
    }
    await saveCookies(all);
    console.log(`[manual] Saved ${all.length} cookies to ${COOKIE_FILE}`);
    await browser.close();
    process.exit(0);
  });

  await new Promise(() => {}); // keep alive until Ctrl+C
}

// ── Entry point ────────────────────────────────────────────────────────────────
if (process.argv[2] === '--manual') {
  manualLogin().catch(err => { console.error(err); process.exit(1); });
} else {
  redeemSubscription().catch(err => { console.error(err); process.exit(1); });
}
