// Pure pricing, availability, forecasting and alerting logic.
// No I/O here — imported by monitor.js, report.js and unit tests.

export const DEFAULT_TARGET = { buyNow: 70000, strongDealMax: 74999, watchMax: 79999 };

export const targetFor = (config, productId) =>
  config?.products?.find((product) => product.id === productId)?.target ??
  config?.target ??
  DEFAULT_TARGET;

const moneyText = (value) => `₹${Math.round(value).toLocaleString('en-IN')}`;
const previousMinText = (value) => moneyText(value);

const num = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(String(value ?? '').replace(/[^\d]/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export const roundMoney = (value, step = 100) => {
  if (!Number.isFinite(value)) return null;
  return Math.round(value / step) * step;
};

export const median = (values) => {
  const list = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
};

export const quantile = (values, q) => {
  const list = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!list.length) return null;
  const pos = (list.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return list[base + 1] !== undefined ? list[base] + rest * (list[base + 1] - list[base]) : list[base];
};

// Canonical "price you actually pay before exchange and before unverified offers".
export const checkoutOf = (observation) =>
  num(observation?.checkoutPrice) ?? num(observation?.effectivePrice) ?? num(observation?.listPrice);

export const priceTier = (price, target = DEFAULT_TARGET) => {
  if (!Number.isFinite(price) || price <= 0) {
    return { tier: 'UNKNOWN', label: 'UNKNOWN', target };
  }
  if (price <= target.buyNow) return { tier: 'BUY', label: 'BUY NOW', target };
  if (price <= target.strongDealMax) return { tier: 'STRONG_DEAL', label: 'STRONG DEAL', target };
  if (price <= target.watchMax) return { tier: 'WATCH', label: 'DEAL WATCH', target };
  return { tier: 'WAIT', label: 'WAIT', target };
};

// Product identity: storage and colour checks from the scraped listing title.
export const identityCheck = (observation, product) => {
  const title = String(observation?.title ?? '').toLowerCase();
  const expectedStorage = String(product?.expected?.storage ?? '').replace(/[^0-9]/g, '');
  const expectedColor = product?.expected?.color ? String(product.expected.color).toLowerCase() : null;
  const storageMatch = expectedStorage ? new RegExp(`\\b${expectedStorage}\\s*gb\\b`).test(title) : null;
  const colorMatch = expectedColor ? title.includes(expectedColor) : null;
  return {
    storageMatch,
    colorMatch,
    verified: storageMatch !== false && colorMatch !== false,
  };
};

// Availability rules: only verified in-stock + verified delivery is purchasable.
// Unknown delivery/stock is never treated as available.
export const purchaseState = (observation, config) => {
  const target = targetFor(config, observation?.product);
  const price = checkoutOf(observation);
  const blockers = [];
  if (observation?.status !== 'ok') blockers.push('SCRAPE_FAILED');
  if (!price) blockers.push('PRICE_UNVERIFIED');
  else if (price < 1000 || price > 500000) blockers.push('PRICE_SUSPICIOUS');
  if (observation?.inStock === false) blockers.push('OUT_OF_STOCK');
  else if (observation?.inStock !== true) blockers.push('STOCK_UNVERIFIED');
  if (observation?.deliverable === false) blockers.push('NOT_DELIVERABLE');
  else if (observation?.deliverable !== true) blockers.push('DELIVERY_UNVERIFIED');
  const identity = observation?.identity ?? {};
  if (identity.storageMatch === false) blockers.push('STORAGE_MISMATCH');
  if (identity.colorMatch === false) blockers.push('COLOR_UNVERIFIED');
  if (!/^https?:\/\//i.test(observation?.url ?? '')) blockers.push('INVALID_URL');
  const unique = [...new Set(blockers)];
  return {
    purchasable: unique.length === 0,
    blockers: unique,
    price,
    tier: priceTier(price, target),
  };
};

const dayKey = (iso) =>
  new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

const isUsable = (entry, productId) =>
  entry &&
  entry.status === 'ok' &&
  (entry.product ?? 'iphone17') === productId &&
  entry.purchase?.purchasable === true &&
  checkoutOf(entry) &&
  checkoutOf(entry) >= 1000 &&
  checkoutOf(entry) <= 500000;

export const usableObservations = (historyEntries, productId) =>
  (historyEntries ?? []).filter((entry) => isUsable(entry, productId));

export const computeStats = (observations, now = new Date().toISOString()) => {
  const prices = observations.map((entry) => checkoutOf(entry));
  const nowMs = new Date(now).getTime();
  const within = (days) =>
    observations
      .filter((entry) => nowMs - new Date(entry.checkedAt).getTime() <= days * 86400000)
      .map((entry) => checkoutOf(entry));
  const recent7 = within(7);
  const recent30 = within(30);
  const uniqueDays = new Set(observations.map((entry) => dayKey(entry.checkedAt))).size;
  const firstAt = observations.length ? observations[0].checkedAt : null;
  const lastAt = observations.length ? observations[observations.length - 1].checkedAt : null;
  const pctChange = (series) => {
    if (series.length < 2) return null;
    const first = series[0];
    const last = series[series.length - 1];
    return first ? (last - first) / first : null;
  };
  const mad = (list) => {
    const med = median(list);
    if (med === null) return null;
    return median(list.map((value) => Math.abs(value - med)));
  };
  const sorted30 = recent30.filter(Number.isFinite);
  return {
    count: observations.length,
    uniqueDays,
    firstAt,
    lastAt,
    min: prices.length ? Math.min(...prices) : null,
    max: prices.length ? Math.max(...prices) : null,
    median: median(prices),
    median7: median(recent7),
    median30: median(recent30),
    avg7: recent7.length ? recent7.reduce((sum, value) => sum + value, 0) / recent7.length : null,
    avg30: recent30.length ? recent30.reduce((sum, value) => sum + value, 0) / recent30.length : null,
    q25_30: quantile(sorted30, 0.25),
    q75_30: quantile(sorted30, 0.75),
    volatility30: mad(recent30) !== null ? Math.round(1.4826 * mad(recent30)) : null,
    change7Pct: pctChange(recent7),
    change30Pct: pctChange(recent30),
    daysCovered: firstAt && lastAt ? Math.round((new Date(lastAt) - new Date(firstAt)) / 86400000) : 0,
  };
};

// Forecast hierarchy:
//  Level 1: <14 unique days or <20 observations -> illustrative ranges, LOW confidence.
//  Level 2: >=14 days & >=20 obs -> robust quantile/MAD scenarios, LOW-MEDIUM confidence.
//  Level 3: >=2 completed sale windows with data -> sale-calibrated scenarios, MEDIUM.
// Never invents probabilities; ranges only.
export const forecastFor = (product, historyEntries, sales, now = new Date().toISOString()) => {
  const observations = usableObservations(historyEntries, product.id);
  const stats = computeStats(observations, now);
  const current = observations.length ? checkoutOf(observations[observations.length - 1]) : null;
  const upcoming = (sales?.upcoming ?? []).map((sale) => ({
    name: sale.name,
    start: sale.start,
    end: sale.end,
    daysAway: sale.daysAway,
    dateConfidence: sale.dateConfidence ?? 'estimated',
    source: sale.source ?? null,
  }));
  const completedWindows = [];
  for (const sale of sales?.all ?? []) {
    if (sale.active || sale.daysAway > 0) continue;
    const startMs = sale.start.getTime();
    const endMs = sale.end.getTime();
    const inWindow = observations.filter((entry) => {
      const at = new Date(entry.checkedAt).getTime();
      return at >= startMs && at <= endMs;
    });
    const beforeWindow = observations.filter((entry) => new Date(entry.checkedAt).getTime() < startMs);
    if (inWindow.length >= 5 && beforeWindow.length >= 3) {
      const windowMin = Math.min(...inWindow.map((entry) => checkoutOf(entry)));
      const baseline = median(beforeWindow.slice(-15).map((entry) => checkoutOf(entry)));
      if (baseline && windowMin < baseline) {
        completedWindows.push({ name: sale.name, dropPct: 1 - windowMin / baseline, windowMin, baseline });
      }
    }
  }

  const base = {
    product: product.id,
    stats,
    current,
    upcoming,
    completedWindows: completedWindows.length,
    period: stats.firstAt && stats.lastAt ? { from: stats.firstAt, to: stats.lastAt } : null,
  };

  if (stats.count < 5 || stats.uniqueDays < 2 || !current) {
    return {
      ...base,
      level: 0,
      label: 'INSUFFICIENT DATA',
      confidence: 'LOW',
      insufficient: true,
      message: 'Not enough usable observations to estimate future prices yet. Showing raw observations only.',
      method: null,
      scenarios: null,
    };
  }

  if (stats.uniqueDays < 14 || stats.count < 20) {
    const observedMin = stats.min;
    const observedMax = stats.max;
    const med = stats.median30 ?? stats.median;
    return {
      ...base,
      level: 1,
      label: 'ILLUSTRATIVE ONLY',
      confidence: 'LOW',
      insufficient: true,
      message: `Only ${stats.uniqueDays} days of usable history (need 14+). The ranges below are illustrative, not a forecast.`,
      method: 'illustrative — observed range with wide uncertainty',
      scenarios: {
        conservative: { range: [roundMoney(current), roundMoney(Math.max(current, observedMax))], note: 'price holds near its recent level' },
        expected: { range: [roundMoney(Math.min(observedMin, med)), roundMoney(current)], note: 'reverts toward the observed low' },
        aggressive: { range: [roundMoney(observedMin * 0.97), roundMoney(observedMin)], note: 'below anything observed so far — low probability, not evidence-based' },
      },
    };
  }

  const sigma = stats.volatility30 ?? Math.round(Math.max(0, (stats.q75_30 - stats.q25_30) / 2));
  const q25 = stats.q25_30 ?? stats.median;
  const med = stats.median30 ?? stats.median;
  const completed = completedWindows.length >= 2;
  const saleDrop = completed
    ? median(completedWindows.map((window) => window.dropPct))
    : null;
  const expectedLow = completed ? Math.min(q25, med * (1 - saleDrop)) : q25;
  return {
    ...base,
    level: completed ? 3 : 2,
    label: completed ? 'SALE-CALIBRATED' : 'HISTORY-BASED',
    confidence: completed ? 'MEDIUM' : stats.uniqueDays >= 30 ? 'MEDIUM' : 'LOW-MEDIUM',
    insufficient: false,
    message: completed
      ? `Based on ${completedWindows.length} completed sale windows plus the last 30 days of prices.`
      : 'Based on the last 30 days of verified prices. Sale behaviour is still uncertain.',
    method: completed
      ? 'sale-window drop medians combined with 30-day quantiles'
      : '30-day medians/quantiles with robust volatility (MAD)',
    scenarios: {
      conservative: { range: [roundMoney(med), roundMoney(med + Math.max(sigma, 0.01 * med))], note: 'small discount or flat pricing' },
      expected: { range: [roundMoney(expectedLow), roundMoney(med)], note: 'typical recent price range' },
      aggressive: { range: [roundMoney(stats.min), roundMoney(expectedLow)], note: 'requires a repeat of the best price observed so far' },
    },
  };
};

// ---------------------------------------------------------------------------
// Alert engine: BUY NOW / STRONG DEAL / PRICE DROP / RECORD LOW / SALE STARTED
// Dedupe: never repeat an alert for the same product+site+price; re-alert only
// when the price drops meaningfully (default ₹500) or after a cooldown, and only
// if the tolerated price is lower than the previously alerted one.

const ALERT_RANK = { BUY_NOW: 5, STRONG_DEAL: 4, RECORD_LOW: 3, PRICE_DROP: 2, SALE_STARTED: 1 };

export const evaluateAlerts = ({ result, previous, history = [], config, state = {}, now = new Date().toISOString() }) => {
  const alerts = [];
  const newState = { ...state };
  const target = targetFor(config, result?.product);
  const cooldownMs = (config?.alerts?.cooldownHours ?? 12) * 3600000;
  const repeatDrop = config?.alerts?.repeatDropAmount ?? 500;
  const dropAmount = config?.alerts?.dropAmount ?? 1000;
  const dropPct = config?.alerts?.dropPct ?? 0.02;
  const confirmationChecks = Math.max(1, config?.alerts?.confirmationChecks ?? 1);
  const confirmationTolerance = config?.alerts?.confirmationTolerance ?? 200;
  const nowMs = new Date(now).getTime();
  const notBefore = config?.purchasePlan?.notBefore
    ? new Date(`${config.purchasePlan.notBefore}T00:00:00+05:30`).getTime()
    : null;
  const purchaseWindowOpen = !notBefore || nowMs >= notBefore;
  const purchase = purchaseState(result, config);
  const previousPrice = checkoutOf(previous);
  const currentPrice = purchase.price;
  if (result?.status !== 'ok' || !currentPrice) return { alerts, state: newState };

  const siteHistory = history
    .filter(
      (entry) =>
        entry.status === 'ok' &&
        (entry.product ?? 'iphone17') === result.product &&
        entry.site === result.site &&
        entry.purchase?.purchasable === true &&
        checkoutOf(entry)
    )
    .map((entry) => ({ ...entry, price: checkoutOf(entry) }))
    .sort((a, b) => new Date(a.checkedAt) - new Date(b.checkedAt));

  const confirmationHistory = siteHistory.slice(-(confirmationChecks - 1));
  const priceConfirmed =
    confirmationChecks === 1 ||
    (confirmationHistory.length === confirmationChecks - 1 &&
      confirmationHistory.every((entry) => Math.abs(entry.price - currentPrice) <= confirmationTolerance));

  const firedKey = (kind) => `${result.product}:${result.site}:${kind}`;
  const shouldFire = (kind, price) => {
    const prior = state[firedKey(kind)];
    if (!prior) return true;
    if (price == null || prior.price == null) {
      return nowMs - new Date(prior.at).getTime() >= cooldownMs;
    }
    // A meaningfully lower price always re-alerts; otherwise never for BUY/STRONG,
    // and only after cooldown for the noisier kinds.
    if (price <= prior.price - repeatDrop) return true;
    if (kind === 'BUY_NOW' || kind === 'STRONG_DEAL' || kind === 'RECORD_LOW') return false;
    return nowMs - new Date(prior.at).getTime() >= cooldownMs;
  };
  const record = (kind, reason, extra = {}) => {
    alerts.push({
      kind,
      rank: ALERT_RANK[kind] ?? 0,
      product: result.product,
      productName: result.productName,
      site: result.site,
      siteName: result.name,
      price: currentPrice,
      previousPrice,
      reason,
      tier: purchase.tier.tier,
      ...extra,
    });
    newState[firedKey(kind)] = { at: now, price: currentPrice };
  };

  // RECORD LOW: strictly below every previously verified price for this site.
  if (purchase.purchasable && priceConfirmed && siteHistory.length >= 3) {
    const priorMin = Math.min(...siteHistory.map((entry) => entry.price));
    if (currentPrice < priorMin && shouldFire('RECORD_LOW', currentPrice)) {
      record('RECORD_LOW', `new verified low — previous best ${previousMinText(priorMin)}`);
    }
  }

  // BUY NOW / STRONG DEAL — availability and verification are hard gates.
  if (purchase.purchasable && priceConfirmed && purchaseWindowOpen) {
    if (purchase.tier.tier === 'BUY' && shouldFire('BUY_NOW', currentPrice)) {
      record('BUY_NOW', `checkout ${moneyText(currentPrice)} is at or below your ${moneyText(target.buyNow)} target`);
    } else if (purchase.tier.tier === 'STRONG_DEAL' && shouldFire('STRONG_DEAL', currentPrice)) {
      record('STRONG_DEAL', `checkout ${moneyText(currentPrice)} is within ${moneyText(target.strongDealMax - currentPrice)} of your ${moneyText(target.buyNow)} target`);
    }
  }

  // PRICE DROP vs the last verified price (BUY/STRONG already covers target crossings).
  if (purchase.purchasable && priceConfirmed && previousPrice && currentPrice < previousPrice) {
    const amount = previousPrice - currentPrice;
    const pct = amount / previousPrice;
    const isTargetAlert = alerts.some((alert) => alert.kind === 'BUY_NOW' || alert.kind === 'STRONG_DEAL');
    if (!isTargetAlert && (amount >= dropAmount || pct >= dropPct) && shouldFire('PRICE_DROP', currentPrice)) {
      record('PRICE_DROP', `price fell ${moneyText(amount)} (${(pct * 100).toFixed(1)}%) from ${moneyText(previousPrice)}`);
    }
  }

  // SALE STARTED: a calendar sale is live AND the price actually moved vs the 7-day median.
  const activeSales = config?.activeSales ?? [];
  if (purchase.purchasable && priceConfirmed && activeSales.length) {
    const recent = siteHistory.filter((entry) => nowMs - new Date(entry.checkedAt).getTime() <= 7 * 86400000);
    const med7 = median(recent.map((entry) => entry.price));
    if (med7 && currentPrice <= med7 * 0.99) {
      const day = new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      const sale = activeSales[0];
      const key = `${result.product}:${result.site}:SALE_STARTED`;
      const prior = state[key];
      const sameDay = prior && new Date(prior.at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) === day;
      if (!sameDay) {
        alerts.push({
          kind: 'SALE_STARTED',
          rank: ALERT_RANK.SALE_STARTED,
          product: result.product,
          productName: result.productName,
          site: result.site,
          siteName: result.name,
          price: currentPrice,
          previousPrice: med7,
          reason: `${sale.name} is live and price is ${((1 - currentPrice / med7) * 100).toFixed(1)}% below the 7-day median`,
          tier: purchase.tier.tier,
          saleName: sale.name,
        });
        newState[key] = { at: now, price: currentPrice };
      }
    }
  }

  return { alerts, state: newState };
};
