import { chromium } from 'playwright';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeReports } from './report.js';
import { checkoutOf, evaluateAlerts, identityCheck, purchaseState } from './pricing.js';

const root = process.cwd();
const config = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
const dataDir = path.join(root, 'data');
const historyPath = path.join(dataDir, 'history.jsonl');
const latestPath = path.join(dataDir, 'latest.json');
const alertStatePath = path.join(dataDir, 'alert-state.json');
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

const extractFlipkartOnce = async (page, site, product) => {
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
  const exchangeCeiling = toNumber(text.match(/Exchange offer\s*\nUp to ₹([\d,]+)/i)?.[1]) ?? null;
  const exchangeAvailable = /Exchange offer/i.test(text) && !/Not available at this Pincode/i.test(text);
  const cod = /No cash\s*on delivery/i.test(text) ? false : /Cash on\s*Delivery/i.test(text) ? true : null;
  const negativeDelivery = /Not available at this Pincode|Not Available for your pincode/i.test(text);
  // Delivery is only "verified" when the 500055 pincode was actually applied on the page.
  const deliverable = negativeDelivery ? false : pincodeSet ? true : null;
  const inStock = !/Sold out|Currently unavailable|Out of stock/i.test(text);

  return {
    site: site.id,
    product: product.id,
    productName: product.name,
    name: site.name,
    checkedAt: new Date().toISOString(),
    status: 'ok',
    url: site.url,
    title: await page.locator('h1').first().innerText().catch(() => jsonLd?.name ?? ''),
    mrp: null,
    listPrice,
    checkoutPrice: listPrice,
    effectivePrice: listPrice,
    maxBankOffer,
    bankOffers,
    bankOffersDetailed: bankOffers.map((bankOffer) => ({
      bank: bankOffer.bank,
      amount: bankOffer.amount,
      minTxn: null,
      eligibility: 'unknown',
      verified: false,
      expires: null,
    })),
    bankOfferKind: 'instant',
    qualifiedPrice: null,
    exchangeCeiling,
    exchangeAvailable,
    assumedExchangeValue: product.assumedExchangeValue ?? 0,
    exchangeAdjustedPrice: product.assumedExchangeValue
      ? Math.max(0, listPrice - product.assumedExchangeValue)
      : null,
    seller: text.match(/Seller:\s*([^\n]+)/i)?.[1]?.trim() ?? null,
    delivery: text.match(/Delivery by\s*\n?\s*([^\n]+)/i)?.[1]?.trim() ?? null,
    deliveryNote: deliverable === null ? 'pincode 500055 not confirmed on page' : null,
    inStock,
    deliverable,
    cod,
    pincodeSet,
  };
};

// Flipkart intermittently bot-walls datacenter IPs. Retry with backoff before
// giving up so one flake doesn't produce a false "site check failed" alert.
const extractFlipkart = async (page, site, product) => {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await extractFlipkartOnce(page, site, product);
    } catch (error) {
      lastError = error;
      if (debug) console.log(`Flipkart attempt ${attempt} failed: ${error.message}`);
      if (attempt < 2) await page.waitForTimeout(20000);
    }
  }
  throw lastError;
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
  const pincodeSet = text.includes(config.pincode);
  const negativeDelivery = /Not Available for your pincode/i.test(text);
  const deliverable = negativeDelivery ? false : pincodeSet ? true : null;

  return {
    site: site.id,
    product: product.id,
    productName: product.name,
    name: site.name,
    checkedAt: new Date().toISOString(),
    status: 'ok',
    url: site.url,
    title: await page.locator('h1').first().innerText().catch(() => jsonLd?.name ?? ''),
    mrp: null,
    listPrice,
    checkoutPrice: listPrice,
    effectivePrice: listPrice,
    maxBankOffer: null,
    bankOffers: [],
    bankOffersDetailed: [],
    bankOfferKind: 'none',
    qualifiedPrice: null,
    exchangeCeiling: null,
    exchangeAvailable: false,
    assumedExchangeValue: null,
    exchangeAdjustedPrice: null,
    seller: 'Croma',
    delivery: deliverable
      ? text.match(/Delivery by\s*([^\n]+)/i)?.[1]?.trim() ?? null
      : `Not available for ${config.pincode}`,
    deliveryNote: deliverable === null ? 'pincode 500055 not confirmed on page' : null,
    inStock: /Add to Cart|Buy Now/i.test(text) && !/Out of Stock|Sold Out/i.test(text),
    deliverable,
    cod: null,
    pincodeSet,
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
  const pincodeSet = text.includes(config.pincode);
  const inStock = /In stock/i.test(text) && !/Out of Stock|Sold Out|Currently Unavailable/i.test(text);

  return {
    site: site.id,
    product: product.id,
    productName: product.name,
    name: site.name,
    checkedAt: new Date().toISOString(),
    status: 'ok',
    url: site.url,
    title: await page.locator('h1').first().innerText().catch(() => jsonLd?.name ?? ''),
    mrp: null,
    listPrice,
    checkoutPrice: listPrice,
    effectivePrice: listPrice,
    maxBankOffer,
    bankOffers,
    bankOffersDetailed: bankOffers.map((bankOffer) => ({
      bank: bankOffer.bank,
      amount: bankOffer.amount,
      minTxn: null,
      eligibility: 'unknown',
      verified: false,
      expires: null,
      kind: 'emi',
    })),
    bankOfferKind: 'emi',
    qualifiedPrice: null,
    exchangeCeiling: null,
    exchangeAvailable: /Exchange Bonus/i.test(text),
    assumedExchangeValue: product.assumedExchangeValue ?? 0,
    exchangeAdjustedPrice: product.assumedExchangeValue
      ? Math.max(0, listPrice - product.assumedExchangeValue)
      : null,
    seller: 'Vijay Sales',
    delivery: text.match(/Free delivery by\s*([^\n]+)/i)?.[1]?.trim() ?? null,
    deliveryNote: pincodeSet ? null : 'delivery not verified for pincode 500055',
    inStock,
    deliverable: pincodeSet ? inStock : null,
    cod: null,
    pincodeSet,
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
  const mrp =
    toNumber(
      await page
        .locator('#corePriceDisplay_desktop_feature_div .basisPrice .a-offscreen, #corePrice_desktop .basisPrice .a-offscreen')
        .first()
        .innerText({ timeout: 3000 })
        .catch(() => null)
    ) ?? parseInr(text.match(/M\.R\.P\.?:?\s*₹\s?([\d,]+)/)?.[1]);
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
    mrp: mrp && mrp > listPrice ? mrp : null,
    listPrice,
    checkoutPrice: listPrice,
    effectivePrice: listPrice,
    maxBankOffer: null,
    bankOffers: [],
    bankOffersDetailed: [],
    bankOfferKind: 'none',
    qualifiedPrice: null,
    exchangeCeiling,
    exchangeAvailable: false,
    assumedExchangeValue: product.assumedExchangeValue ?? 0,
    exchangeAdjustedPrice: null,
    seller: text.match(/Sold by\s*([^\n]+)/i)?.[1]?.trim() ?? 'Amazon',
    delivery: text.match(/(?:FREE delivery|Delivery)[^\n]*([A-Z][a-z]+,?\s+\d+\s+[A-Z]+)/)?.[1]?.trim() ?? null,
    deliveryNote: 'Amazon does not expose pincode serviceability without login — verify at checkout',
    inStock,
    deliverable: null,
    cod: null,
    pincodeSet: false,
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

const readAlertState = async () => {
  try {
    return JSON.parse(await readFile(alertStatePath, 'utf8'));
  } catch {
    return {};
  }
};

const saleWindow = (sale) => ({
  name: sale.name,
  start: new Date(`${sale.start}T00:00:00+05:30`),
  end: new Date(`${sale.end}T23:59:59+05:30`),
  dateConfidence: sale.dateConfidence ?? 'estimated',
  source: sale.source ?? null,
});

const activeSalesFor = (product, now = new Date()) =>
  (product.saleCalendar ?? [])
    .map(saleWindow)
    .filter((sale) => now >= sale.start && now <= sale.end);

// Attach identity verification + purchasability to a successful scrape.
const enrichResult = (result, product) => {
  if (result.status !== 'ok') return result;
  const price = checkoutOf(result);
  const enriched = {
    ...result,
    title: result.title ?? '',
    checkoutPrice: price,
    effectivePrice: price,
    verifiedAt: result.checkedAt,
    identity: identityCheck(result, product),
  };
  enriched.purchase = purchaseState(enriched, config);
  return enriched;
};

const BLOCKER_TEXT = {
  SCRAPE_FAILED: 'scrape failed',
  PRICE_UNVERIFIED: 'price unverified',
  PRICE_SUSPICIOUS: 'price looks wrong',
  OUT_OF_STOCK: 'out of stock',
  STOCK_UNVERIFIED: 'stock unverified',
  NOT_DELIVERABLE: `not deliverable to ${config.pincode}`,
  DELIVERY_UNVERIFIED: 'delivery unverified',
  STORAGE_MISMATCH: 'storage mismatch',
  COLOR_UNVERIFIED: 'colour unverified',
  INVALID_URL: 'listing URL invalid',
};

const availabilityText = (result) => {
  if (result.status === 'error') return `ERROR: ${result.error}`;
  const purchase = result.purchase;
  if (purchase?.purchasable) return `PURCHASABLE — ${purchase.tier.label}`;
  const blockers = (purchase?.blockers ?? []).map((blocker) => BLOCKER_TEXT[blocker] ?? blocker);
  return purchase ? `NOT PURCHASABLE — ${blockers.join(', ')}` : 'UNVERIFIED';
};

const istStamp = (iso) =>
  new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

const formatSite = (result) => {
  if (result.status === 'error') {
    return `${result.productName ?? result.name}: ${result.name} ERROR - ${result.error}\n${result.url}`;
  }
  const target = config.target;
  const lines = [`${result.productName ?? 'iPhone 17'} @ ${result.name}: ${result.title || result.productName}`];
  const price = checkoutOf(result);
  lines.push(
    `Checkout: ${price ? money.format(price) : 'unknown'}${result.mrp ? ` (M.R.P. ${money.format(result.mrp)})` : ''}`
  );
  if (result.maxBankOffer) {
    const best = result.bankOffers?.[0];
    const label = result.bankOfferKind === 'emi' ? 'Best EMI offer' : 'Best bank offer';
    lines.push(
      `${label}: ${money.format(result.maxBankOffer)}${best ? ` (${best.bank})` : ''} — eligibility unverified, not included`
    );
  }
  if (result.assumedExchangeValue && result.exchangeAdjustedPrice) {
    lines.push(
      `Exchange (optional): assumed ${money.format(result.assumedExchangeValue)}${result.exchangeCeiling ? ` vs ceiling ${money.format(result.exchangeCeiling)}` : ''} → ${money.format(result.exchangeAdjustedPrice)} after exchange (not a discount)`
    );
  }
  if (result.seller) lines.push(`Seller: ${result.seller}`);
  if (result.delivery) lines.push(`Delivery: ${result.delivery}`);
  if (result.deliveryNote) lines.push(`Note: ${result.deliveryNote}`);
  if (result.cod !== null && result.cod !== undefined) lines.push(`COD: ${result.cod ? 'yes' : 'no'}`);
  lines.push(`Availability: ${availabilityText(result)}`);
  if (result.identity) {
    lines.push(
      `Identity: storage ${result.identity.storageMatch === false ? 'MISMATCH' : result.identity.storageMatch ? 'ok' : 'n/a'} / colour ${result.identity.colorMatch === false ? 'unverified' : result.identity.colorMatch ? 'ok' : 'n/a'}`
    );
  }
  lines.push(`Target: BUY NOW ≤ ${money.format(target.buyNow)} | STRONG ≤ ${money.format(target.strongDealMax)}`);
  if (result.verifiedAt) lines.push(`Verified: ${istStamp(result.verifiedAt)} IST`);
  lines.push(result.url);
  return lines.join('\n');
};

const alertHeadline = (product, alerts) => {
  const top = [...alerts].sort((a, b) => b.rank - a.rank)[0];
  return top ? `${product} — ${top.kind.replace(/_/g, ' ')}: ${top.reason}` : null;
};

// GitHub Issues as the alert inbox: one issue per change-event. GitHub emails the
// repo owner automatically. Skipped when GH_TOKEN is absent (local runs).
const createAlertIssue = async (result, alerts) => {
  const token = process.env.GH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return;
  const top = [...alerts].sort((a, b) => b.rank - a.rank)[0];
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: `[${top.kind.replace(/_/g, ' ')}] ${result.productName ?? result.product} @ ${result.name} — ${money.format(top.price)}`,
        body: `${formatSite(result)}\n\n**Alerts:**\n${alerts.map((alert) => `- **${alert.kind}** — ${alert.reason}`).join('\n')}\n\n[Dashboard](https://${repo.split('/')[0]}.github.io/${repo.split('/')[1]}/dashboard.html)`,
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
  let historyEntries = [];
  try {
    historyEntries = (await readFile(historyPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {}
  let alertState = await readAlertState();
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
        };
      } finally {
        if (debug && result?.status === 'ok') {
          const text = await page.locator('body').innerText().catch(() => '');
          await writeFile(path.join(dataDir, `debug-${site.id}.txt`), text).catch(() => {});
        }
        await page.close();
      }

      const enriched = enrichResult(result, product);
      results.push(enriched);
      const { alerts, state } = evaluateAlerts({
        result: enriched,
        previous,
        history: historyEntries,
        config: { ...config, activeSales: activeSalesFor(product) },
        state: alertState,
      });
      alertState = state;
      if (alerts.length) {
        alertMessages.push(
          ...alerts.map((alert) => `${formatSite(enriched)}\nAlert: ${alert.kind} — ${alert.reason}`)
        );
        await createAlertIssue(enriched, alerts);
        for (const alert of alerts) {
          const headline = alertHeadline(enriched.productName ?? product.name, [alert]);
          if (headline) headlines.push(headline);
        }
      }
      console.log(`\n--- ${result.productName ?? product.name} @ ${site.name} ---`);
      console.log(formatSite(enriched));
      console.log(
        'Alerts:',
        alerts.length ? alerts.map((alert) => `${alert.kind} (${alert.reason})`).join('; ') : 'none'
      );
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
  await writeFile(alertStatePath, JSON.stringify(alertState, null, 2)).catch(() => {});

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
      const purchasable = productResults.filter((result) => result.purchase?.purchasable);
      if (purchasable.length) {
        const best = purchasable.reduce((lowest, result) =>
          checkoutOf(result) < checkoutOf(lowest) ? result : lowest
        );
        lines.push(`Best verified purchasable: ${best.name} at ${money.format(checkoutOf(best))}`, '');
      } else {
        lines.push('No verified purchasable offer (in stock + deliverable + verified identity).', '');
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
