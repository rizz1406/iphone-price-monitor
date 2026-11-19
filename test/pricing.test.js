import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkoutOf,
  computeStats,
  DEFAULT_TARGET,
  evaluateAlerts,
  forecastFor,
  identityCheck,
  priceTier,
  purchaseState,
  quantile,
  roundMoney,
} from '../src/pricing.js';

const config = {
  target: { ...DEFAULT_TARGET },
  alerts: { cooldownHours: 12, repeatDropAmount: 500, dropAmount: 1000, dropPct: 0.02 },
};

const product = { id: 'iphone17', expected: { storage: '256GB', color: 'Mist Blue' } };

const okResult = (overrides = {}) => ({
  site: 'flipkart',
  product: 'iphone17',
  name: 'Flipkart',
  status: 'ok',
  title: 'Apple iPhone 17 (Mist Blue, 256 GB)',
  url: 'https://www.flipkart.com/x',
  checkedAt: '2026-11-20T10:00:00.000Z',
  checkoutPrice: 70000,
  effectivePrice: 70000,
  listPrice: 70000,
  inStock: true,
  deliverable: true,
  identity: identityCheck({ title: 'Apple iPhone 17 (Mist Blue, 256 GB)' }, product),
  ...overrides,
});

test('priceTier boundaries match the purchase spec exactly', () => {
  assert.equal(priceTier(69999).tier, 'BUY');
  assert.equal(priceTier(70000).tier, 'BUY');
  assert.equal(priceTier(70001).tier, 'STRONG_DEAL');
  assert.equal(priceTier(74999).tier, 'STRONG_DEAL');
  assert.equal(priceTier(75000).tier, 'WATCH');
  assert.equal(priceTier(79999).tier, 'WATCH');
  assert.equal(priceTier(80000).tier, 'WAIT');
  assert.equal(priceTier(85000).tier, 'WAIT');
  assert.equal(priceTier(null).tier, 'UNKNOWN');
});

test('checkoutOf prefers checkoutPrice and ignores bank/exchange deductions', () => {
  assert.equal(checkoutOf({ checkoutPrice: 85100, effectivePrice: 81100, listPrice: 89100 }), 85100);
  assert.equal(checkoutOf({ effectivePrice: 81100, listPrice: 89100 }), 81100);
  assert.equal(checkoutOf({ listPrice: 89100 }), 89100);
  assert.equal(checkoutOf({}), null);
});

test('identityCheck verifies storage and colour from title', () => {
  const good = identityCheck({ title: 'Apple iPhone 17 (Mist Blue, 256 GB)' }, product);
  assert.equal(good.storageMatch, true);
  assert.equal(good.colorMatch, true);
  assert.equal(good.verified, true);

  const black = identityCheck({ title: 'Apple iPhone 17 (Black, 256 GB)' }, product);
  assert.equal(black.storageMatch, true);
  assert.equal(black.colorMatch, false);
  assert.equal(black.verified, false);

  const wrongStorage = identityCheck({ title: 'Apple iPhone 17 (Mist Blue, 128 GB)' }, product);
  assert.equal(wrongStorage.storageMatch, false);
});

test('purchaseState blocks unverified availability and price', () => {
  const top = purchaseState(
    okResult({ purchase: undefined, identity: identityCheck(okResult(), product) }),
    config
  );
  assert.equal(top.purchasable, true);
  assert.deepEqual(top.blockers, []);
  assert.equal(top.tier.tier, 'BUY');

  const noDelivery = purchaseState(okResult({ deliverable: null }), config);
  assert.equal(noDelivery.purchasable, false);
  assert.ok(noDelivery.blockers.includes('DELIVERY_UNVERIFIED'));

  const outOfStock = purchaseState(okResult({ inStock: false }), config);
  assert.ok(outOfStock.blockers.includes('OUT_OF_STOCK'));

  const wrongColour = purchaseState(
    okResult({ title: 'Apple iPhone 17 (Black, 256 GB)', identity: identityCheck({ title: 'Apple iPhone 17 (Black, 256 GB)' }, product) }),
    config
  );
  assert.ok(wrongColour.blockers.includes('COLOR_UNVERIFIED'));

  const badPrice = purchaseState(okResult({ checkoutPrice: 9290000, effectivePrice: 9290000 }), config);
  assert.ok(badPrice.blockers.includes('PRICE_SUSPICIOUS'));
});

test('exchange and bank offers never change the purchasable checkout price', () => {
  const withExtras = importantExtras(okResult());
  const state = purchaseState(withExtras, config);
  assert.equal(state.price, 85100);
  assert.equal(state.tier.tier, 'WAIT');
});

function importantExtras(result) {
  return {
    ...result,
    checkoutPrice: 85100,
    effectivePrice: 85100,
    listPrice: 89100,
    maxBankOffer: 4000,
    assumedExchangeValue: 5000,
    exchangeAdjustedPrice: 80100,
    exchangeCeiling: 6900,
  };
}

test('computeStats ignores unusable observations', () => {
  const days = Array.from({ length: 6 }, (_, index) => ({
    status: 'ok',
    product: 'iphone17',
    checkedAt: `2026-11-${String(13 + index).padStart(2, '0')}T10:00:00.000Z`,
    checkoutPrice: 84000 + index * 1000,
    effectivePrice: 84000 + index * 1000,
    listPrice: 84000 + index * 1000,
  }));
  const observations = [
    ...days,
    { status: 'error', product: 'iphone17', checkedAt: '2026-11-19T10:00:00.000Z' },
    { status: 'ok', product: 'iphone17', checkedAt: '2026-11-19T11:00:00.000Z', checkoutPrice: 5000000 },
  ];
  const stats = computeStats(observations.filter((entry) => entry.status === 'ok' && checkoutOf(entry) && checkoutOf(entry) < 500000));
  assert.equal(stats.count, 6);
  assert.equal(stats.uniqueDays, 6);
  assert.equal(stats.min, 84000);
  assert.equal(stats.max, 89000);
  assert.equal(stats.daysCovered, 5);
});

test('forecastFor is honest with only 6 days of data', () => {
  const history = Array.from({ length: 30 }, (_, index) => ({
    status: 'ok',
    product: 'iphone17',
    site: 'flipkart',
    checkedAt: new Date(Date.UTC(2026, 10, 13 + Math.floor(index / 5), 10, 0, 0)).toISOString(),
    checkoutPrice: 85000 + (index % 3) * 500,
    effectivePrice: 85000 + (index % 3) * 500,
  }));
  const forecast = forecastFor(product, history, { upcoming: [], all: [] }, '2026-11-18T12:00:00.000Z');
  assert.equal(forecast.level, 1);
  assert.equal(forecast.confidence, 'LOW');
  assert.equal(forecast.insufficient, true);
  assert.match(forecast.message, /illustrative/i);
  assert.ok(forecast.scenarios.expected.range[0] <= forecast.scenarios.expected.range[1]);
});

test('forecastFor escalates once 14+ days exist', () => {
  const history = Array.from({ length: 60 }, (_, index) => ({
    status: 'ok',
    product: 'iphone17',
    site: 'flipkart',
    checkedAt: new Date(Date.UTC(2026, 9, 1 + Math.floor(index / 2), 10, 0, 0)).toISOString(),
    checkoutPrice: 82000 + (index % 5) * 400,
    effectivePrice: 82000 + (index % 5) * 400,
  }));
  const forecast = forecastFor(product, history, { upcoming: [], all: [] }, '2026-11-30T12:00:00.000Z');
  assert.equal(forecast.level, 2);
  assert.notEqual(forecast.label, 'INSUFFICIENT DATA');
  assert.ok(forecast.scenarios.conservative.range[0] > 0);
});

test('evaluateAlerts fires BUY_NOW only when purchasable and ≤ 70000', () => {
  const history = Array.from({ length: 6 }, (_, index) => ({
    ...okResult({ checkedAt: `2026-11-${String(13 + index).padStart(2, '0')}T10:00:00.000Z` }),
    checkoutPrice: 86000,
    effectivePrice: 86000,
  }));
  const previous = { ...okResult(), checkoutPrice: 86000, effectivePrice: 86000 };

  const atTarget = evaluateAlerts({
    result: okResult({ checkoutPrice: 70000, effectivePrice: 70000 }),
    previous,
    history,
    config,
    state: {},
    now: '2026-11-20T10:00:00.000Z',
  });
  assert.ok(atTarget.alerts.some((alert) => alert.kind === 'BUY_NOW'));

  const blocked = evaluateAlerts({
    result: okResult({ checkoutPrice: 69000, effectivePrice: 69000, deliverable: null }),
    previous,
    history,
    config,
    state: {},
    now: '2026-11-20T10:00:00.000Z',
  });
  assert.equal(blocked.alerts.some((alert) => alert.kind === 'BUY_NOW'), false);
});

test('evaluateAlerts dedupes repeats and re-alerts only on a meaningful drop', () => {
  const history = Array.from({ length: 6 }, (_, index) => ({
    ...okResult({ checkedAt: `2026-11-${String(13 + index).padStart(2, '0')}T10:00:00.000Z` }),
    checkoutPrice: 86000,
    effectivePrice: 86000,
  }));
  const previous = { ...okResult(), checkoutPrice: 86000, effectivePrice: 86000 };
  const first = evaluateAlerts({
    result: okResult({ checkoutPrice: 70000, effectivePrice: 70000 }),
    previous,
    history,
    config,
    state: {},
    now: '2026-11-20T10:00:00.000Z',
  });
  const repeat = evaluateAlerts({
    result: okResult({ checkoutPrice: 70000, effectivePrice: 70000 }),
    previous: { ...okResult(), checkoutPrice: 70000, effectivePrice: 70000 },
    history,
    config,
    state: first.state,
    now: '2026-11-20T11:00:00.000Z',
  });
  assert.equal(first.alerts.some((alert) => alert.kind === 'BUY_NOW'), true);
  assert.equal(repeat.alerts.length, 0);

  const lower = evaluateAlerts({
    result: okResult({ checkoutPrice: 69500, effectivePrice: 69500 }),
    previous: { ...okResult(), checkoutPrice: 70000, effectivePrice: 70000 },
    history,
    config,
    state: first.state,
    now: '2026-11-20T11:00:00.000Z',
  });
  assert.ok(lower.alerts.some((alert) => alert.kind === 'BUY_NOW'));
});

test('evaluateAlerts records a RECORD LOW below all previous observations', () => {
  const history = Array.from({ length: 6 }, (_, index) => ({
    ...okResult({ checkedAt: `2026-11-${String(13 + index).padStart(2, '0')}T10:00:00.000Z` }),
    checkoutPrice: 80000 + index * 200,
    effectivePrice: 80000 + index * 200,
  }));
  const result = evaluateAlerts({
    result: okResult({ checkoutPrice: 79000, effectivePrice: 79000 }),
    previous: { ...okResult(), checkoutPrice: 81000, effectivePrice: 81000 },
    history,
    config,
    state: {},
    now: '2026-11-20T10:00:00.000Z',
  });
  assert.ok(result.alerts.some((alert) => alert.kind === 'RECORD_LOW'));
  assert.ok(result.alerts.some((alert) => alert.kind === 'PRICE_DROP'));
});

test('quantile and roundMoney behave', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(roundMoney(69764, 100), 69800);
  assert.equal(roundMoney(null), null);
});
