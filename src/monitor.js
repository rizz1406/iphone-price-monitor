import { chromium } from 'playwright';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeReports } from './report.js';

const root = process.cwd();
const config = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
const dataDir = path.join(root, 'data');
const historyPath = path.join(dataDir, 'history.jsonl');
const latestPath = path.join(dataDir, 'latest.json');
const errorDir = path.join(dataDir, 'errors');
const summaryOnly = process.argv.includes('--summary');
const debug = process.env.DEBUG === 'true';
const forceHeadless = process.env.HEADLESS === 'true';

const money = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

const toNumber = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(String(value ?? '').replace(/[^\d]/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

// Handles "₹92,900.00" style strings that toNumber's digit-strip would turn into 9290000.
const parseInr = (value) => {
  if (!value) return null;
  const match = String(value).replace(/₹/g, '').trim().match(/^([\d,]+(?:\.\d+)?)$/);
  if (!match) return null;
  const parsed = parseFloat(match[1].replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
};

const findProduct = (node) => {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findProduct(item);
      if (found) return found;
    }
    return null;
  }
  const type = node['@type'];
  const types = Array.isArray(type) ? type : [type];
  if (types.includes('Product')) return node;
  for (const value of Object.values(node)) {
    const found = findProduct(value);
    if (found) return found;
  }
  return null;
};

const getProductJsonLd = async (page) => {
  const scripts = await page.evaluate(() =>
    [...document.querySelectorAll('script[type="application/ld+json"]')].map((script) => script.textContent)
  );
  for (const raw of scripts) {
    try {
      const parsed = JSON.parse(raw);
      const product = findProduct(parsed);
      if (product) return product;
    } catch {
      continue;
    }
  }
  return null;
};

const getOffer = (product) => {
  const offers = product?.offers;
  if (Array.isArray(offers)) return offers[0] ?? null;
  return offers ?? null;
};

const offerPrice = (offer) => {
  if (!offer) return null;
  return (
    toNumber(offer.price) ??
    toNumber(offer.lowPrice) ??
    toNumber(offer.priceSpecification?.price) ??
    null
  );
};

const parseBanks = (text) => {
  const section = text.match(/Bank offers([\s\S]*?)(?:View EMI offers|View non-EMI offers|Additional benefits)/i)?.[1] ?? text;
  const pattern = /₹([\d,]+)\s*off[\s\S]{0,100}?(Flipkart SBI|Flipkart Axis|ICICI|HDFC|SBI|Axis|Bank of Baroda|IDFC First|Kotak|Yes|IndusInd)\b/gi;
  const offers = [];
  const seen = new Set();
  for (const match of section.matchAll(pattern)) {
    const amount = toNumber(match[1]);
    const bank = match[2].replace(/\s+/g, ' ').trim();
    const key = `${bank}|${amount}`;
    if (!amount || seen.has(key)) continue;
    seen.add(key);
    offers.push({ bank, amount });
  }
  return offers.sort((a, b) => b.amount - a.amount);
};

const parseVijayOffers = (text) => {
  const offers = [];
  const flat = /Flat\s*Rs\.?\s*([\d,]+)\s*Instant Discount on ([^\n]+)/gi;
  for (const match of text.matchAll(flat)) {
    const amount = toNumber(match[1]);
    if (amount) offers.push({ bank: match[2].trim(), amount, type: 'flat' });
  }
  const percent = /(\d+)%\s*Upto\s*Rs\.?\s*([\d,]+)\s*Instant Discount on ([^\n]+)/gi;
  for (const match of text.matchAll(percent)) {
    const amount = toNumber(match[2]);
    if (amount) offers.push({ bank: match[3].trim(), amount, type: `${match[1]}%` });
  }
  return offers.sort((a, b) => b.amount - a.amount);
};

const hasFlipkartPincode = (text, pincode) =>
  text.includes(pincode) && /Delivery details/i.test(text);

const setFlipkartPincode = async (page, pincode) => {
  try {
    await page.getByText('Change pincode', { exact: false }).first().click({ timeout: 5000 });
    await page.waitForTimeout(2000);
    const input = page.locator('input[placeholder="Enter pincode"]');
    await input.waitFor({ state: 'visible', timeout: 5000 });
    await input.fill(pincode);
    await page.getByText('Submit', { exact: true }).click({ timeout: 5000 });
    await page.waitForTimeout(5000);
  } catch (error) {
    if (debug) console.log('Flipkart pincode flow failed:', error.message);
    return false;
  }
  const text = await page.locator('body').innerText();
  return hasFlipkartPincode(text, pincode);
};

const extractFlipkart = async (page, site, product) => {
  await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  let pincodeSet = false;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (attempt > 1) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(5000);
    }
    pincodeSet = await setFlipkartPincode(page, config.pincode);
    if (pincodeSet) break;
    if (debug) console.log(`Flipkart pincode attempt ${attempt} failed`);
  }
  if (!pincodeSet) console.log('Flipkart pincode could not be set; using no-location data');
  await page.waitForTimeout(3000);

  const text = await page.locator('body').innerText();
  const jsonLd = await getProductJsonLd(page);
  const offer = getOffer(jsonLd);
  const bankOffers = parseBanks(text);
  const maxBankOffer = bankOffers[0]?.amount ?? null;
  const listPrice =
    offerPrice(offer) ??
    toNumber(text.match(/(\d+)%\s*\n\s*[\d,]+\s*\n\s*₹([\d,]+)/)?.[2]) ??
    toNumber(text.match(/₹([\d,]+)/)?.[1]);
  if (!listPrice) throw new Error('Could not extract Flipkart price (page may be bot-walled or not fully loaded)');
  const effectivePrice =
    toNumber(text.match(/Buy at ₹([\d,]+)/i)?.[1]) ??
    (listPrice && maxBankOffer ? Math.max(0, listPrice - maxBankOffer) : listPrice);
  const exchangeCeiling = toNumber(text.match(/Exchange offer\s*\nUp to ₹([\d,]+)/i)?.[1]) ?? null;
  const exchangeAvailable = !/Not available at this Pincode/i.test(text);
  const cod = /No cash\s*on delivery/i.test(text) ? false : /Cash on\s*Delivery/i.test(text) ? true : null;

  return {
    site: site.id,
    product: product.id,
    productName: product.name,
    name: site.name,
    checkedAt: new Date().toISOString(),
    status: 'ok',
    url: site.url,
    title: await page.locator('h1').first().innerText().catch(() => jsonLd?.name ?? ''),
    listPrice,
    effectivePrice,
    maxBankOffer,
    bankOffers,
    bankOfferKind: 'instant',
    exchangeCeiling,
    exchangeAvailable,
    assumedExchangeValue: product.assumedExchangeValue,
    netWithExchange:
      effectivePrice && product.assumedExchangeValue
        ? Math.max(0, effectivePrice - product.assumedExchangeValue)
        : effectivePrice,
    seller: text.match(/Seller:\s*([^\n]+)/i)?.[1]?.trim() ?? null,
    delivery: text.match(/Delivery by\s*\n?\s*([^\n]+)/i)?.[1]?.trim() ?? null,
    inStock: !/Sold out|Currently unavailable|Out of stock/i.test(text),
    deliverable: !/Not available at this Pincode|Not Available for your pincode/i.test(text),
    cod,
    pincodeSet,
    targets: {
      listPrice: site.targetListPrice,
      effectivePrice: site.targetEffectivePrice,
      netWithExchange: site.targetNetWithExchange,
    },
  };
};

const setCromaPincode = async (page, pincode) => {
  const input = page.locator('input[placeholder="Enter Pincode"]').first();
  const inputVisible = await input.isVisible().catch(() => false);
  if (!inputVisible) {
    const add = page.locator('button:visible').filter({ hasText: 'Add Pincode' }).first();
    if (await add.count()) await add.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  if (!(await input.count())) return;
  await input.fill(pincode).catch(() => {});
  const continueButton = page.locator('button:visible').filter({ hasText: 'Continue' }).first();
  if (await continueButton.count()) {
    await continueButton.click({ timeout: 5000 }).catch(() => {});
  }
  await page
    .waitForFunction((pin) => document.body.innerText.includes(pin), pincode, { timeout: 10000 })
    .catch(() => {});
  await page.waitForTimeout(4000);
};

const extractCroma = async (page, site, product) => {
  await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  let text = await page.locator('body').innerText();
  if (/Access Denied|don't have permission to access/i.test(text)) {
    throw new Error('Croma blocked the request (Akamai Access Denied)');
  }
  await setCromaPincode(page, config.pincode);
  text = await page.locator('body').innerText();
  const jsonLd = await getProductJsonLd(page);
  const offer = getOffer(jsonLd);
  const listPrice = offerPrice(offer) ?? toNumber(text.match(/₹([\d,]+)/)?.[1]);
  if (!listPrice) throw new Error('Could not extract Croma price');
  const deliverable = !/Not Available for your pincode/i.test(text);

  return {
    site: site.id,
    product: product.id,
    productName: product.name,
    name: site.name,
    checkedAt: new Date().toISOString(),
    status: 'ok',
    url: site.url,
    title: await page.locator('h1').first().innerText().catch(() => jsonLd?.name ?? ''),
    listPrice,
    effectivePrice: listPrice,
    maxBankOffer: null,
    bankOffers: [],
    bankOfferKind: 'none',
    exchangeCeiling: null,
    exchangeAvailable: false,
    assumedExchangeValue: null,
    netWithExchange: listPrice,
    seller: 'Croma',
    delivery: deliverable
      ? text.match(/Delivery by\s*([^\n]+)/i)?.[1]?.trim() ?? null
      : `Not available for ${config.pincode}`,
    inStock: /Add to Cart|Buy Now/i.test(text) && !/Out of Stock|Sold Out/i.test(text),
    deliverable,
    cod: null,
    pincodeSet: text.includes(config.pincode),
    targets: {
      listPrice: site.targetListPrice,
      effectivePrice: site.targetEffectivePrice,
      netWithExchange: site.targetNetWithExchange,
    },
  };
};

const extractVijay = async (page, site, product) => {
  await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  const text = await page.locator('body').innerText();
  if (/Access Denied|don't have permission to access/i.test(text)) {
    throw new Error('Vijay Sales blocked the request');
  }
  const jsonLd = await getProductJsonLd(page);
  const offer = getOffer(jsonLd);
  const listPrice = offerPrice(offer) ?? toNumber(text.match(/₹([\d,]+)/)?.[1]);
  if (!listPrice) throw new Error('Could not extract Vijay Sales price');
  const bankOffers = parseVijayOffers(text);
  const maxBankOffer = bankOffers[0]?.amount ?? null;

  return {
    site: site.id,
    product: product.id,
    productName: product.name,
    name: site.name,
    checkedAt: new Date().toISOString(),
    status: 'ok',
    url: site.url,
    title: await page.locator('h1').first().innerText().catch(() => jsonLd?.name ?? ''),
    listPrice,
    effectivePrice: listPrice,
    maxBankOffer,
    bankOffers,
    bankOfferKind: 'emi',
    exchangeCeiling: null,
    exchangeAvailable: /Exchange Bonus/i.test(text),
    assumedExchangeValue: product.assumedExchangeValue,
    netWithExchange: listPrice && product.assumedExchangeValue
      ? Math.max(0, listPrice - product.assumedExchangeValue)
      : listPrice,
    seller: 'Vijay Sales',
    delivery: text.match(/Free delivery by\s*([^\n]+)/i)?.[1]?.trim() ?? null,
    inStock: /In stock/i.test(text) && !/Out of Stock|Sold Out/i.test(text),
    deliverable: !/Out of Stock|Sold Out|Currently Unavailable/i.test(text),
    cod: null,
    pincodeSet: text.includes(config.pincode),
    targets: {
      listPrice: site.targetListPrice,
      effectivePrice: site.targetEffectivePrice,
      netWithExchange: site.targetNetWithExchange,
    },
  };
};

const extractAmazon = async (page, site, product) => {
  const gotoWithRetry = async () => {
    try {
      await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch {
      await page.waitForTimeout(8000);
      await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
  };
  await gotoWithRetry();
  await page.waitForTimeout(5000);
  let text = await page.locator('body').innerText().catch(() => '');
  if (/Enter the characters you see below|Robot Check|Type the characters/i.test(text)) {
    throw new Error('Amazon blocked the request (captcha / bot check)');
  }
  if (/Continue shopping/i.test(text)) {
    const btn = page
      .locator('button:has-text("Continue shopping"), input[value="Continue shopping"], a:has-text("Continue shopping")')
      .first();
    await btn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(3000);
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
  }
  text = await page.locator('body').innerText().catch(() => '');
  const jsonLd = await getProductJsonLd(page);
  const offer = getOffer(jsonLd);
  const domPrice =
    parseInr(
      await page.locator('#corePrice_feature_div .a-offscreen').first().innerText({ timeout: 4000 }).catch(() => null)
    ) ??
    parseInr(
      await page.locator('#apex_desktop .a-price-whole').first().innerText({ timeout: 4000 }).catch(() => null)
    );
  const listPrice = offerPrice(offer) ?? domPrice ?? toNumber(text.match(/₹\s?([\d,]+)/)?.[1]);
  if (!listPrice) throw new Error('Could not extract Amazon price');
  const inStock = /In stock/i.test(text) || (await page.locator('#add-to-cart-button').count()) > 0;
  const exchangeCeiling = toNumber(text.match(/up to ₹\s?([\d,]+)(?:\.00)?\s*off/i)?.[1]) ?? null;

  return {
    site: site.id,
    product: product.id,
    productName: product.name,
    name: site.name,
    checkedAt: new Date().toISOString(),
    status: 'ok',
    url: site.url,
    title: await page.locator('#productTitle').first().innerText().catch(() => jsonLd?.name ?? ''),
    listPrice,
    effectivePrice: listPrice,
    maxBankOffer: null,
    bankOffers: [],
    bankOfferKind: 'none',
    exchangeCeiling,
    exchangeAvailable: false,
    assumedExchangeValue: product.assumedExchangeValue,
    netWithExchange: listPrice,
    seller: text.match(/Sold by\s*([^\n]+)/i)?.[1]?.trim() ?? 'Amazon',
    delivery: text.match(/(?:FREE delivery|Delivery)[^\n]*([A-Z][a-z]+,?\s+\d+\s+[A-Z]+)/)?.[1]?.trim() ?? null,
    inStock,
    deliverable: inStock,
    cod: null,
    pincodeSet: false,
    targets: {
      listPrice: site.targetListPrice,
      effectivePrice: site.targetEffectivePrice,
      netWithExchange: site.targetNetWithExchange,
    },
  };
};

const extractors = {
  flipkart: extractFlipkart,
  croma: extractCroma,
  vijay: extractVijay,
  amazon: extractAmazon,
};

const resultKey = (result) => `${result.product ?? 'iphone17'}:${result.site}`;

const readPrevious = async () => {
  try {
    const latest = JSON.parse(await readFile(latestPath, 'utf8'));
    return new Map(latest.sites.map((site) => [resultKey(site), site]));
  } catch {
    return new Map();
  }
};

const calculateReasons = (result, previous) => {
  const reasons = [];
  if (result.status === 'error') {
    if (previous?.status !== 'error') reasons.push('site check failed');
    return reasons;
  }
  if (!previous) {
    reasons.push('first successful check');
    return reasons;
  }
  if (previous.status === 'error') reasons.push('site recovered');
  if (result.listPrice && result.targets.listPrice && result.listPrice <= result.targets.listPrice) {
    if (!previous.listPrice || previous.listPrice > result.targets.listPrice) {
      reasons.push(`list price hit target ${money.format(result.targets.listPrice)}`);
    }
  }
  if (result.effectivePrice && result.targets.effectivePrice && result.effectivePrice <= result.targets.effectivePrice) {
    if (!previous.effectivePrice || previous.effectivePrice > result.targets.effectivePrice) {
      reasons.push(`effective price hit target ${money.format(result.targets.effectivePrice)}`);
    }
  }
  if (result.netWithExchange && result.targets.netWithExchange && result.netWithExchange <= result.targets.netWithExchange) {
    if (!previous.netWithExchange || previous.netWithExchange > result.targets.netWithExchange) {
      reasons.push(`net-with-exchange hit target ${money.format(result.targets.netWithExchange)}`);
    }
  }
  if (result.effectivePrice && previous.effectivePrice && result.effectivePrice < previous.effectivePrice) {
    reasons.push(`new low ${money.format(result.effectivePrice)}`);
  }
  if (
    result.bankOfferKind !== 'emi' &&
    result.maxBankOffer &&
    result.maxBankOffer > (previous.maxBankOffer ?? 0)
  ) {
    reasons.push(`bank offer increased to ${money.format(result.maxBankOffer)}`);
  }
  if (typeof previous.inStock === 'boolean' && previous.inStock !== result.inStock) {
    reasons.push(result.inStock ? 'back in stock' : 'out of stock');
  }
  if (previous.seller && result.seller && previous.seller !== result.seller) {
    reasons.push(`seller changed to ${result.seller}`);
  }
  if (result.deliverable === false && reasons.length) {
    reasons.push(`not deliverable at pincode ${config.pincode}`);
  }
  return reasons;
};

const formatSite = (result) => {
  if (result.status === 'error') {
    return `${result.productName ?? result.name}: ${result.name} ERROR - ${result.error}\n${result.url}`;
  }
  const lines = [`${result.productName ?? 'iPhone 17'} @ ${result.name}: ${result.title || result.productName}`];
  lines.push(`List: ${result.listPrice ? money.format(result.listPrice) : 'unknown'}`);
  if (result.effectivePrice) lines.push(`Effective: ${money.format(result.effectivePrice)}`);
  if (result.maxBankOffer) {
    const best = result.bankOffers?.[0];
    const label = result.bankOfferKind === 'emi' ? 'Best EMI offer' : 'Best bank offer';
    lines.push(`${label}: ${money.format(result.maxBankOffer)}${best ? ` (${best.bank})` : ''}`);
  }
  if (result.exchangeCeiling) {
    lines.push(`Exchange ceiling: ${money.format(result.exchangeCeiling)}${result.exchangeAvailable ? '' : ' (not available at this pincode)'}`);
  }
  if (result.netWithExchange && result.exchangeAvailable) {
    lines.push(`Net with assumed exchange ${result.assumedExchangeValue ? money.format(result.assumedExchangeValue) : 'none'}: ${money.format(result.netWithExchange)}`);
  }
  if (result.seller) lines.push(`Seller: ${result.seller}`);
  if (result.delivery) lines.push(`Delivery: ${result.delivery}`);
  if (result.cod !== null) lines.push(`COD: ${result.cod ? 'yes' : 'no'}`);
  lines.push(
    `Target: list <= ${money.format(result.targets.listPrice)} | net <= ${money.format(result.targets.netWithExchange)}`
  );
  lines.push(result.url);
  return lines.join('\n');
};

const alertHeadline = (product, reasons) => `${product} — ${reasons[0]}`;

// GitHub Issues as the alert inbox: one issue per change-event. GitHub emails the
// repo owner automatically. Skipped when GH_TOKEN is absent (local runs).
const createAlertIssue = async (result, reasons) => {
  const token = process.env.GH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return;
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: `[Price Alert] ${result.productName ?? result.product} @ ${result.name}`,
        body: `${formatSite(result)}\n\n**Reasons:** ${reasons.join('; ')}\n\n[Dashboard](https://${repo.split('/')[0]}.github.io/${repo.split('/')[1]}/dashboard.html)`,
      }),
    });
    if (!response.ok) console.log(`Issue creation failed: HTTP ${response.status}`);
  } catch (error) {
    console.log(`Issue creation failed: ${error.message}`);
  }
};

const notify = async (message) => {
  console.log('ALERT:\n' + message);
  await appendFile(
    path.join(dataDir, 'alerts.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), message }) + '\n'
  ).catch(() => {});
};

const main = async () => {
  await mkdir(dataDir, { recursive: true });
  await mkdir(errorDir, { recursive: true });
  const previousSites = await readPrevious();
  const previousResults = [...previousSites.values()];
  const results = [];
  const alertMessages = [];
  const headlines = [];
  const browsers = new Map();

  const getPage = async (site) => {
    const headed = Boolean(site.headed) && !forceHeadless;
    const key = headed ? 'headed' : 'headless';
    if (!browsers.has(key)) {
      const browser = await chromium.launch({
        headless: !headed,
        args: process.env.CI ? ['--no-sandbox'] : [],
      });
      const context = await browser.newContext({
        locale: 'en-IN',
        timezoneId: 'Asia/Kolkata',
        viewport: { width: 1440, height: 1200 },
      });
      browsers.set(key, { browser, context });
    }
    return browsers.get(key).context.newPage();
  };

  for (const product of config.products) {
    for (const site of product.sites.filter((entry) => entry.enabled)) {
      const page = await getPage(site);
      const previous = previousSites.get(`${product.id}:${site.id}`);
      let result;
      try {
        result = await extractors[site.type](page, site, product);
      } catch (error) {
        const screenshot = path.join(errorDir, `${product.id}-${site.id}-${Date.now()}.png`);
        await page.screenshot({ path: screenshot, fullPage: false }).catch(() => {});
        result = {
          site: site.id,
          product: product.id,
          productName: product.name,
          name: site.name,
          checkedAt: new Date().toISOString(),
          status: 'error',
          error: error.message,
          url: site.url,
          targets: {
            listPrice: site.targetListPrice,
            effectivePrice: site.targetEffectivePrice,
            netWithExchange: site.targetNetWithExchange,
          },
        };
      } finally {
        if (debug && result?.status === 'ok') {
          const text = await page.locator('body').innerText().catch(() => '');
          await writeFile(path.join(dataDir, `debug-${site.id}.txt`), text).catch(() => {});
        }
        await page.close();
      }

      results.push(result);
      const reasons = calculateReasons(result, previous);
      if (reasons.length) {
        alertMessages.push(`${formatSite(result)}\nReason: ${reasons.join('; ')}`);
        await createAlertIssue(result, reasons);
        headlines.push(alertHeadline(result.productName ?? result.product, reasons));
      }
      console.log(`\n--- ${result.productName ?? product.name} @ ${site.name} ---`);
      console.log(formatSite(result));
      console.log('Reasons:', reasons.length ? reasons.join('; ') : 'none');
    }
  }

  for (const entry of browsers.values()) {
    await entry.browser.close();
  }

  const now = new Date().toISOString();
  const latest = { updatedAt: now, pincode: config.pincode, sites: results };
  await writeFile(latestPath, JSON.stringify(latest, null, 2));
  for (const result of results) {
    await appendFile(historyPath, JSON.stringify(result) + '\n');
  }

  // Commit-message headline: consumed by CI to prefix the bot commit, and cleared
  // every run so a stale flag never survives into the next commit.
  await writeFile(
    path.join(dataDir, 'alert-headline.txt'),
    headlines.length ? `ALERT: ${headlines.slice(0, 3).join(' | ')}` : 'no alerts',
  ).catch(() => {});

  await writeReports({ root, config, results, historyPath });

  if (summaryOnly) {
    const lines = [`Price monitor — pincode ${config.pincode}`, `Checked: ${now}`, ''];
    for (const product of config.products) {
      const productResults = results.filter((result) => result.product === product.id);
      lines.push(`== ${product.name} ==`);
      for (const result of productResults) lines.push(formatSite(result), '');
      const priced = productResults.filter((result) => result.effectivePrice);
      if (priced.length) {
        const best = priced.reduce((lowest, result) =>
          result.effectivePrice < lowest.effectivePrice ? result : lowest
        );
        lines.push(`Best effective: ${best.name} at ${money.format(best.effectivePrice)}`, '');
      }
    }
    await notify(lines.join('\n'));
    return;
  }

  if (alertMessages.length) {
    await notify(`Price alert\n\n${alertMessages.join('\n\n')}`);
  } else {
    console.log('No alerts this run.');
  }
  const failed = results.filter((result) => result.status === 'error');
  if (failed.length === results.length) {
    process.exitCode = 1;
  }
};

await main();
