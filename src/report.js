import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  checkoutOf,
  forecastFor,
  identityCheck,
  purchaseState,
} from './pricing.js';

const money = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

const istTime = (iso) =>
  new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

const istDate = (value) =>
  new Date(value).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });

const productOf = (entry, products) =>
  products.find((product) => product.id === (entry.product ?? 'iphone17')) ?? null;

const lastKnownGood = (historyEntries, productId, siteId) =>
  [...historyEntries]
    .reverse()
    .find(
      (entry) =>
        (entry.product ?? 'iphone17') === productId &&
        entry.site === siteId &&
        entry.status === 'ok' &&
        checkoutOf(entry)
    );

const historyForSite = (historyEntries, productId, siteId, limit = 48) =>
  historyEntries
    .filter(
      (entry) =>
        (entry.product ?? 'iphone17') === productId &&
        entry.site === siteId &&
        entry.status === 'ok' &&
        checkoutOf(entry)
    )
    .slice(-limit);

const trendOf = (entries) => {
  if (entries.length < 4) return 'flat';
  const half = Math.floor(entries.length / 2);
  const avg = (list) => list.reduce((sum, entry) => sum + checkoutOf(entry), 0) / list.length;
  const older = avg(entries.slice(0, half));
  const newer = avg(entries.slice(half));
  if (newer < older - 300) return 'down';
  if (newer > older + 300) return 'up';
  return 'flat';
};

const STALE_MS = 90 * 60000;
const stale = (iso) => iso && Date.now() - new Date(iso).getTime() > STALE_MS;

// Interactive chart: time-based x-axis, monotone-cubic smoothing (no overshoot on
// flat plateaus), padded y-domain so flat series still render mid-chart, animated
// draw-in, min/max dots, axis dates and hover crosshair + tooltip. Inline, no deps.
const chart = (entries, id) => {
  const values = entries.map((entry) => checkoutOf(entry));
  if (values.length < 2) return '';
  const W = 320;
  const H = 100;
  const PAD_X = 8;
  const PAD_TOP = 18;
  const PAD_BOTTOM = 22;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const pad = Math.max(span * 0.18, Math.round(max * 0.004) || 50);
  const lo = min - pad;
  const hi = max + pad;
  const times = entries.map((entry) => new Date(entry.checkedAt).getTime());
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  const timeSpan = t1 - t0;
  const pts = values.map((value, index) => {
    const xRatio = timeSpan > 0 ? (times[index] - t0) / timeSpan : index / (values.length - 1);
    const yRatio = (value - lo) / (hi - lo);
    return {
      x: +(PAD_X + xRatio * (W - PAD_X * 2)).toFixed(1),
      y: +(H - PAD_BOTTOM - yRatio * (H - PAD_TOP - PAD_BOTTOM)).toFixed(1),
      v: value,
      t: entries[index].checkedAt,
    };
  });
  const monotonePath = (points) => {
    const n = points.length;
    if (n === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
    const dx = [];
    const slopes = [];
    for (let i = 0; i < n - 1; i += 1) {
      dx[i] = Math.max(points[i + 1].x - points[i].x, 0.001);
      slopes[i] = (points[i + 1].y - points[i].y) / dx[i];
    }
    const m = new Array(n);
    m[0] = slopes[0];
    m[n - 1] = slopes[n - 2];
    for (let i = 1; i < n - 1; i += 1) {
      if (slopes[i - 1] * slopes[i] <= 0) {
        m[i] = 0;
      } else {
        const w1 = 2 * dx[i] + dx[i - 1];
        const w2 = dx[i] + 2 * dx[i - 1];
        m[i] = (w1 + w2) / (w1 / slopes[i - 1] + w2 / slopes[i]);
      }
    }
    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 0; i < n - 1; i += 1) {
      const c1x = points[i].x + dx[i] / 3;
      const c1y = points[i].y + (m[i] * dx[i]) / 3;
      const c2x = points[i + 1].x - dx[i] / 3;
      const c2y = points[i + 1].y - (m[i + 1] * dx[i]) / 3;
      d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${points[i + 1].x} ${points[i + 1].y}`;
    }
    return d;
  };
  const linePath = monotonePath(pts);
  const areaPath = `${linePath} L ${pts[pts.length - 1].x} ${H - PAD_BOTTOM} L ${pts[0].x} ${H - PAD_BOTTOM} Z`;
  const color = values[values.length - 1] <= values[0] ? 'success' : 'error';
  const flatish = span / Math.max(1, max) < 0.004;
  const minIdx = values.indexOf(min);
  const maxIdx = values.indexOf(max);
  const dataJson = JSON.stringify(pts.map((p) => [p.x, p.y, p.v, p.t])).replace(/"/g, '&quot;');
  const dot = (idx, cls) =>
    `<circle class="chart-dot" cx="${pts[idx].x}" cy="${pts[idx].y}" r="3" data-cls="${cls}"/>`;
  const firstDate = istDate(pts[0].t);
  const lastDate = istDate(pts[pts.length - 1].t);
  return `
        <div class="chart-wrap" data-points="${dataJson}" data-variant="${color}">
          <div class="chart-hi" ${flatish ? 'style="top: 45%;"' : ''}>${money.format(max)}</div>
          ${flatish ? '' : `<div class="chart-lo">${money.format(min)}</div>`}
          <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Price history chart from ${firstDate} to ${lastDate}">
            <defs>
              <linearGradient id="fill-${id}" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" class="chart-stop-hi" stop-opacity="0.32"/>
                <stop offset="100%" class="chart-stop-lo" stop-opacity="0"/>
              </linearGradient>
            </defs>
            <line class="chart-grid" x1="0" y1="${H - PAD_BOTTOM}" x2="${W}" y2="${H - PAD_BOTTOM}"/>
            <line class="chart-grid chart-grid-hi" x1="0" y1="${PAD_TOP}" x2="${W}" y2="${PAD_TOP}"/>
            ${flatish ? '' : `<path class="chart-area" d="${areaPath}" fill="url(#fill-${id})"/>`}
            <path class="chart-line" d="${linePath}" pathLength="1"/>
            ${minIdx !== maxIdx ? dot(minIdx, 'lo') : ''}
            ${minIdx !== maxIdx ? dot(maxIdx, 'hi') : ''}
            <line class="chart-cross" x1="0" y1="${PAD_TOP - 10}" x2="0" y2="${H - PAD_BOTTOM}" style="display:none"/>
            <circle class="chart-hover-dot" r="4" style="display:none"/>
          </svg>
          <div class="chart-axis"><span>${firstDate}</span><span>${lastDate}</span></div>
          <div class="chart-tip" style="display:none"></div>
        </div>`;
};

const saleCalendarState = (saleCalendar, now) => {
  const today = new Date(now);
  const sales = (saleCalendar ?? []).map((sale) => {
    const start = new Date(`${sale.start}T00:00:00+05:30`);
    const end = new Date(`${sale.end}T23:59:59+05:30`);
    const daysAway = Math.ceil((start - today) / 86400000);
    const active = today >= start && today <= end;
    return { ...sale, start, end, daysAway, active };
  });
  return {
    active: sales.filter((sale) => sale.active),
    upcoming: sales.filter((sale) => !sale.active).sort((a, b) => a.start - b.start),
    all: sales,
  };
};

const BLOCKER_LABELS = {
  SCRAPE_FAILED: 'scrape failed',
  PRICE_UNVERIFIED: 'price unverified',
  PRICE_SUSPICIOUS: 'price looks wrong',
  OUT_OF_STOCK: 'out of stock',
  STOCK_UNVERIFIED: 'stock unverified',
  NOT_DELIVERABLE: 'not deliverable to pincode',
  DELIVERY_UNVERIFIED: 'delivery unverified',
  STORAGE_MISMATCH: 'storage mismatch',
  COLOR_UNVERIFIED: 'colour unverified',
  INVALID_URL: 'listing URL invalid',
};

const blockersText = (result) =>
  (result.purchase?.blockers ?? []).map((blocker) => BLOCKER_LABELS[blocker] ?? blocker).join(', ');

const bestPurchasable = (results) =>
  results
    .filter((result) => result.status === 'ok' && result.purchase?.purchasable && result.checkoutPrice)
    .sort((a, b) => a.checkoutPrice - b.checkoutPrice)[0] ?? null;

const statusFor = (result, config) => {
  if (result.status !== 'ok' || !result.checkoutPrice) return null;
  const purchase = result.purchase;
  const target = config.target;
  if (!purchase?.purchasable) {
    return { kind: 'blocked', text: `NOT PURCHASABLE — ${blockersText(result)}` };
  }
  const price = purchase.price;
  const gap = price - target.buyNow;
  if (purchase.tier.tier === 'BUY') {
    return { kind: 'buy', text: `BUY NOW — checkout ${money.format(price)} is at or below your ${money.format(target.buyNow)} target` };
  }
  if (purchase.tier.tier === 'STRONG_DEAL') {
    return { kind: 'watch', text: `STRONG DEAL — ${money.format(price)}, but still ${money.format(gap)} above the ${money.format(target.buyNow)} target` };
  }
  if (purchase.tier.tier === 'WATCH') {
    return { kind: 'wait', text: `DEAL WATCH — ${money.format(price)}; keep waiting for ≤ ${money.format(target.buyNow)}` };
  }
  return { kind: 'wait', text: `WAIT — ${money.format(price)} is ${money.format(gap)} above your ${money.format(target.buyNow)} target` };
};

const forecastSectionHtml = (product, forecast, basisName) => {
  const stats = forecast.stats;
  const scenario = (key, name) => {
    const entry = forecast.scenarios?.[key];
    if (!entry) return '';
    return `<tr><td><strong>${name}</strong></td><td>${money.format(entry.range[0])} – ${money.format(entry.range[1])}</td><td>${entry.note}</td></tr>`;
  };
  const upcomingRows = forecast.upcoming.length
    ? forecast.upcoming
        .map(
          (sale) => `<tr>
            <td><strong>${sale.name}</strong></td>
            <td>${istDate(sale.start)} → ${istDate(sale.end)}</td>
            <td>${sale.daysAway > 0 ? `in ${sale.daysAway} days` : 'LIVE'}</td>
            <td>${sale.dateConfidence === 'estimated' ? '<span class="est">estimated</span>' : 'confirmed'}</td>
            <td class="source-cell">${sale.source ?? '—'}</td>
          </tr>`
        )
        .join('')
    : '';
  return `
  <section id="forecast-${product.id}">
    <h2>📈 ${product.shortName} — Price Forecast</h2>
    <div class="forecast-grid">
      <div class="stat"><div class="stat-label">Confidence</div><div class="stat-value">${forecast.confidence}</div></div>
      <div class="stat"><div class="stat-label">Data level</div><div class="stat-value">${forecast.label}</div></div>
      <div class="stat"><div class="stat-label">Observations</div><div class="stat-value">${stats.count}</div></div>
      <div class="stat"><div class="stat-label">Unique days</div><div class="stat-value">${stats.uniqueDays}</div></div>
      <div class="stat"><div class="stat-label">Observed min</div><div class="stat-value">${stats.min ? money.format(stats.min) : 'N/A'}</div></div>
      <div class="stat"><div class="stat-label">Observed median</div><div class="stat-value">${stats.median ? money.format(stats.median) : 'N/A'}</div></div>
      <div class="stat"><div class="stat-label">Observed max</div><div class="stat-value">${stats.max ? money.format(stats.max) : 'N/A'}</div></div>
      <div class="stat"><div class="stat-label">30-day volatility</div><div class="stat-value">${stats.volatility30 ? `± ${money.format(stats.volatility30)}` : 'N/A'}</div></div>
    </div>
    <p class="forecast-message">${forecast.message} <strong>These are scenarios, not predictions.</strong> All ranges are checkout price without exchange, based only on verified prices from <strong>${basisName}</strong> — stores that cannot deliver to your pincode are excluded.</p>
    ${
      forecast.scenarios
        ? `<div class="table-wrap">
      <table class="forecast-table">
        <thead><tr><th>Scenario</th><th>Plausible checkout range</th><th>What it assumes</th></tr></thead>
        <tbody>
          ${scenario('conservative', 'Conservative')}
          ${scenario('expected', 'Expected')}
          ${scenario('aggressive', 'Aggressive')}
        </tbody>
      </table>
      </div>
      <p class="subtitle">Method: ${forecast.method}.${forecast.level === 1 ? ' Requires 14+ unique days before this becomes a real forecast.' : ''}</p>`
        : ''
    }
    ${
      upcomingRows
        ? `<h3 class="sub-heading">Sale calendar</h3>
      <div class="table-wrap">
      <table class="forecast-table">
        <thead><tr><th>Sale</th><th>Window (IST)</th><th>Status</th><th>Date confidence</th><th>Source / note</th></tr></thead>
        <tbody>${upcomingRows}</tbody>
      </table>
      </div>`
        : ''
    }
  </section>`;
};

const heroHtml = (product, sorted, forecast, historyEntries, config, basisName, basisSite) => {
  const target = config.target;
  const best = bestPurchasable(sorted);
  const advertised = sorted
    .filter((result) => result.status === 'ok' && result.checkoutPrice)
    .sort((a, b) => a.checkoutPrice - b.checkoutPrice)[0] ?? null;
  const historyLow = (() => {
    const prices = historyForSite(historyEntries, product.id, basisSite, Number.MAX_SAFE_INTEGER).map(
      (entry) => checkoutOf(entry)
    );
    return prices.length ? Math.min(...prices) : null;
  })();
  const stats = forecast.stats;
  const price = best?.checkoutPrice ?? null;
  const gap = price ? price - target.buyNow : null;
  const progress = price ? Math.max(3, Math.min(100, Math.round((target.buyNow / price) * 100))) : 0;
  const tier = best?.purchase?.tier ?? null;
  const badgeClass = tier?.tier === 'BUY' ? 'badge-ok' : tier?.tier === 'STRONG_DEAL' ? 'badge-best' : 'badge-neutral';
  const nextSale = forecast.upcoming[0] ?? null;
  return `
  <section class="hero">
    <div class="hero-main">
      <div class="hero-kicker">PRIMARY TARGET · ${product.name}</div>
      <div class="hero-price-row">
        <span class="hero-price">${price ? money.format(price) : '—'}</span>
        <span class="badge ${badgeClass}">${best ? tier.label : 'NO VERIFIED PURCHASABLE OFFER'}</span>
      </div>
      <div class="hero-sub">
        ${
          price
            ? `Lowest verified checkout at <strong>${best.name}</strong> · ${gap > 0 ? `${money.format(gap)} above your ${money.format(target.buyNow)} target` : `at or below your ${money.format(target.buyNow)} target`}`
            : `No store currently meets all gates (in stock + deliverable to ${config.pincode} + verified identity). Advertised reference: <strong>${advertised ? `${money.format(advertised.checkoutPrice)} at ${advertised.name}` : 'none'}</strong> — not verified.`
        }
      </div>
      <div class="target-block">
        <div class="target-label"><span>Target: ${money.format(target.buyNow)}</span><span>${price ? (gap > 0 ? 'not hit yet' : '✓ hit') : 'waiting for verified offer'}</span></div>
        <div class="target-bar"><div class="target-fill ${price && gap <= 0 ? 'hit' : ''}" style="width:${progress}%"></div></div>
      </div>
      <div class="hero-stats">
        <div><span class="stat-label">History low (${basisName})</span><strong>${historyLow ? money.format(historyLow) : 'N/A'}</strong></div>
        <div><span class="stat-label">7-day median</span><strong>${stats.median7 ? money.format(stats.median7) : 'N/A'}</strong></div>
        <div><span class="stat-label">30-day median</span><strong>${stats.median30 ? money.format(stats.median30) : 'N/A'}</strong></div>
        <div><span class="stat-label">Forecast</span><strong>${forecast.confidence}${forecast.scenarios ? ` · ${money.format(forecast.scenarios.expected.range[0])}–${money.format(forecast.scenarios.expected.range[1])}` : ' · illustrative only'}</strong></div>
        <div><span class="stat-label">Next sale</span><strong>${nextSale ? `${nextSale.name} · ${nextSale.daysAway > 0 ? `in ${nextSale.daysAway} days` : 'live'}` : 'none configured'}</strong></div>
        <div><span class="stat-label">Verified</span><strong>${best?.verifiedAt ? `${istTime(best.verifiedAt)} IST` : 'n/a'}</strong></div>
      </div>
      ${
        forecast.insufficient
          ? `<p class="hero-note">Forecast is <strong>illustrative only</strong> — ${stats.uniqueDays} days of history, ${stats.count} observations. Need 14+ days for a reliable forecast.</p>`
          : ''
      }
      ${nextSale && nextSale.dateConfidence === 'estimated' ? '<p class="hero-note">Sale dates are <strong>estimated</strong>, not retailer-confirmed.</p>' : ''}
    </div>
  </section>`;
};

export async function writeReports({ root, config, results, historyPath }) {
  const reportsDir = path.join(root, 'reports');
  await mkdir(reportsDir, { recursive: true });

  let historyEntries = [];
  try {
    const rawHistory = await readFile(historyPath, 'utf8');
    historyEntries = rawHistory
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {}

  const now = new Date().toISOString();
  const products = config.products;
  const trendIcon = { down: '▼ falling', flat: '▬ stable', up: '▲ rising' };

  const hydrated = results.map((result) => {
    const product = productOf(result, products);
    if (!product || result.status !== 'ok') return result;
    const identity = result.identity ?? identityCheck(result, product);
    const base = {
      ...result,
      identity,
      checkoutPrice: checkoutOf(result),
      verifiedAt: result.verifiedAt ?? result.checkedAt,
    };
    return { ...base, purchase: result.purchase ?? purchaseState(base, config) };
  });

  // Per-product state: forecast comes only from verified checkout prices at the
  // buy channel (a store that can actually deliver), never from unpurchasable stores.
  const state = products.map((product) => {
    const productResults = hydrated.filter((result) => result.product === product.id);
    const saleState = saleCalendarState(product.saleCalendar, now);
    const sorted = [...productResults].sort((a, b) => {
      const aPurchasable = Boolean(a.purchase?.purchasable);
      const bPurchasable = Boolean(b.purchase?.purchasable);
      if (aPurchasable && !bPurchasable) return -1;
      if (!aPurchasable && bPurchasable) return 1;
      return (checkoutOf(a) ?? Number.POSITIVE_INFINITY) - (checkoutOf(b) ?? Number.POSITIVE_INFINITY);
    });
    const best = bestPurchasable(sorted);
    const fallbackSite = product.sites.find((site) => site.enabled) ?? product.sites[0];
    const basisSite = best?.site ?? fallbackSite?.id ?? null;
    const basisName =
      productResults.find((result) => result.site === basisSite)?.name ??
      fallbackSite?.name ??
      basisSite ??
      'n/a';
    const basisHistory = historyForSite(historyEntries, product.id, basisSite, Number.MAX_SAFE_INTEGER);
    const forecast = forecastFor(product, basisHistory, saleState, now);
    return {
      product,
      results: productResults,
      saleState,
      forecast,
      basisName,
      basisSite,
      sorted,
      bestDealId: best?.site ?? null,
    };
  });

  // Price-drop banner: biggest drop vs the previous recorded ok scrape for each site.
  const drops = [];
  for (const { product } of state) {
    for (const r of hydrated.filter(
      (res) => res.product === product.id && res.status === 'ok' && checkoutOf(res)
    )) {
      const siteHistory = historyForSite(historyEntries, product.id, r.site, 2);
      const previous = siteHistory.length >= 2 ? siteHistory[siteHistory.length - 2] : null;
      if (previous && checkoutOf(previous) > checkoutOf(r)) {
        drops.push({
          product: product.shortName,
          site: r.name,
          amount: checkoutOf(previous) - checkoutOf(r),
          current: checkoutOf(r),
          was: checkoutOf(previous),
        });
      }
    }
  }
  const topDrop = drops.sort((a, b) => b.amount - a.amount)[0] ?? null;

  // Global banner: live sale, else next estimated sale, else top drop. No price promises.
  const primary = state[0];
  const nextSale = primary.forecast.upcoming[0] ?? null;
  const activeSale = primary.saleState.active[0] ?? null;
  const bannerHtml = activeSale
    ? `<div class="banner banner-sale">🔥 SALE LIVE: ${activeSale.name} (until ${istDate(activeSale.end)}) — buy only if a verified checkout is ≤ ${money.format(config.target.buyNow)}.</div>`
    : nextSale
      ? `<div class="banner banner-info">⏳ Next sale: <strong>${nextSale.name}</strong> — ${istDate(nextSale.start)} (in ${nextSale.daysAway} days, dates ${nextSale.dateConfidence}). Target stays ${money.format(config.target.buyNow)} · forecast ${primary.forecast.confidence}.</div>`
      : '';

  const dropBannerHtml = topDrop
    ? `<div class="banner banner-drop">🔻 Biggest recent drop: <strong>${topDrop.product} @ ${topDrop.site}</strong> ${money.format(topDrop.was)} → <strong>${money.format(topDrop.current)}</strong> (−${money.format(topDrop.amount)})</div>`
    : '';

  const cardHtml = (product, r, bestDealId) => {
    if (r.status === 'error') {
      const lastGood = lastKnownGood(historyEntries, product.id, r.site);
      return `
          <div class="card">
            <div>
              <div class="card-header">
                <span class="card-title">${r.name}</span>
                <span>
                  <span class="badge badge-error">ERROR</span>
                  ${lastGood && stale(lastGood.checkedAt) ? '<span class="badge badge-stale">STALE</span>' : ''}
                </span>
              </div>
              <p style="color:var(--error); font-size:0.9rem;">${r.error}</p>
              ${
                lastGood
                  ? `
              <div class="price-main">${money.format(checkoutOf(lastGood))}</div>
              <div class="price-sub">Last known good scrape: <strong>${istTime(lastGood.checkedAt)}</strong> IST — <strong>not current</strong></div>
              <div class="detail-row"><span class="detail-label">M.R.P.</span><span class="detail-value">${lastGood.mrp ? money.format(lastGood.mrp) : 'N/A'}</span></div>
              <div class="detail-row"><span class="detail-label">Best Bank Offer</span><span class="detail-value">${lastGood.maxBankOffer ? `${money.format(lastGood.maxBankOffer)} (unverified)` : 'None'}</span></div>
              <div class="detail-row"><span class="detail-label">Delivery</span><span class="detail-value">${lastGood.delivery ?? 'N/A'}</span></div>`
                  : '<p style="color:var(--muted); font-size:0.9rem;">No successful scrape recorded yet.</p>'
              }
            </div>
            <a href="${r.url}" target="_blank" class="btn">View Store</a>
          </div>`;
    }

    const entries = historyForSite(historyEntries, product.id, r.site);
    const trend = trendOf(entries);
    const price = r.checkoutPrice ?? checkoutOf(r);
    const purchase = r.purchase ?? {
      purchasable: false,
      blockers: ['PRICE_UNVERIFIED'],
      tier: { tier: 'UNKNOWN', label: 'UNKNOWN' },
    };
    const rec = statusFor(r, config);
    const target = config.target;
    const lowestRecorded = entries.length
      ? entries.reduce((min, entry) => (checkoutOf(entry) < checkoutOf(min) ? entry : min))
      : null;
    const gap = price ? price - target.buyNow : null;
    const targetPct = price ? Math.max(4, Math.min(100, Math.round((target.buyNow / price) * 100))) : 0;
    const isStale = stale(r.verifiedAt);
    const tierBadge =
      purchase.tier.tier === 'BUY' ? 'badge-ok' : purchase.tier.tier === 'STRONG_DEAL' ? 'badge-best' : 'badge-neutral';
    const bestBank = r.bankOffers?.[0] ?? null;
    const identity = r.identity;

    return `
        <div class="card ${r.site === bestDealId ? 'card-best' : ''}">
          <div>
            <div class="card-header">
              <span class="card-title">${r.name}</span>
              <span class="badge-row">
                ${r.site === bestDealId ? '<span class="badge badge-best">★ BEST VERIFIED</span>' : ''}
                <span class="badge ${tierBadge}">${purchase.tier.label}</span>
                <span class="badge ${purchase.purchasable ? 'badge-ok' : 'badge-error'}">${purchase.purchasable ? 'PURCHASABLE' : 'NOT PURCHASABLE'}</span>
                ${isStale ? '<span class="badge badge-stale">STALE</span>' : ''}
              </span>
            </div>
            <div class="price-main">${price ? money.format(price) : '—'}</div>
            <div class="price-sub">
              Selling price${r.mrp ? ` · M.R.P. ${money.format(r.mrp)}` : ''} · excludes bank/exchange | Trend: ${trendIcon[trend]}${
                lowestRecorded && checkoutOf(lowestRecorded) < price
                  ? ` | Lowest recorded: <span class="low-record">${money.format(checkoutOf(lowestRecorded))}</span> on ${istTime(lowestRecorded.checkedAt)}`
                  : ''
              }
            </div>
            ${chart(entries, `${product.id}-${r.site}`)}
            ${rec ? `<div class="rec rec-${rec.kind}">${rec.kind === 'buy' ? '🟢' : rec.kind === 'watch' ? '🟡' : rec.kind === 'blocked' ? '🔴' : '🔵'} ${rec.text}</div>` : ''}
            ${
              price
                ? `
            <div class="target-block">
              <div class="target-label"><span>Your target: ${money.format(target.buyNow)} (no exchange)</span><span>${gap > 0 ? `${money.format(gap)} away` : '✓ hit'}</span></div>
              <div class="target-bar"><div class="target-fill ${gap <= 0 ? 'hit' : ''}" style="width:${targetPct}%"></div></div>
            </div>`
                : ''
            }
            <div class="detail-row"><span class="detail-label">M.R.P.</span><span class="detail-value">${r.mrp ? money.format(r.mrp) : 'N/A'}</span></div>
            <div class="detail-row"><span class="detail-label">Best Bank Offer</span><span class="detail-value">${r.maxBankOffer ? `${money.format(r.maxBankOffer)}${bestBank ? ` (${bestBank.bank})` : ''} — eligibility unverified` : 'None'}</span></div>
            <div class="detail-row"><span class="detail-label">Exchange (optional)</span><span class="detail-value">${
              r.assumedExchangeValue && r.exchangeAdjustedPrice
                ? `assumed ${money.format(r.assumedExchangeValue)} → ${money.format(r.exchangeAdjustedPrice)} after exchange${r.exchangeCeiling ? ` (ceiling ${money.format(r.exchangeCeiling)})` : ''} — not a discount`
                : 'N/A'
            }</span></div>
            <div class="detail-row"><span class="detail-label">Seller</span><span class="detail-value">${r.seller ?? 'N/A'}</span></div>
            <div class="detail-row"><span class="detail-label">Delivery</span><span class="detail-value">${r.delivery ?? 'N/A'}${r.deliveryNote ? ` (${r.deliveryNote})` : ''}</span></div>
            <div class="detail-row"><span class="detail-label">COD</span><span class="detail-value">${r.cod === true ? 'Yes' : r.cod === false ? 'No' : 'N/A'}</span></div>
            <div class="detail-row"><span class="detail-label">Identity</span><span class="detail-value">${
              identity
                ? `${identity.storageMatch === false ? '❌ storage' : identity.storageMatch ? '✓ 256GB' : 'storage n/a'} · ${identity.colorMatch === false ? '❌ colour' : identity.colorMatch ? '✓ colour' : 'colour n/a'}`
                : 'unverified'
            }</span></div>
            <div class="detail-row"><span class="detail-label">Verified</span><span class="detail-value">${r.verifiedAt ? `${istTime(r.verifiedAt)} IST` : 'N/A'}${isStale ? ' — stale' : ''}</span></div>
          </div>
          <a href="${r.url}" target="_blank" class="btn">View Product</a>
        </div>`;
  };

  const productSectionHtml = state
    .map(({ product, sorted, forecast, bestDealId, basisName }) => `
    <div class="product-block" data-product="${product.id}">
    <h2 class="product-heading">📱 ${product.name}${product.id === 'iphone17' ? ' <span class="primary-tag">your target</span>' : ' <span class="watch-tag">watching</span>'}</h2>
    <div class="grid">
      ${sorted.map((r) => cardHtml(product, r, bestDealId)).join('')}
    </div>
    ${forecastSectionHtml(product, forecast, basisName)}
    </div>`)
    .join('\n');

  const previousEntryFor = (entry) => {
    let index = historyEntries.indexOf(entry);
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const candidate = historyEntries[cursor];
      if (
        (candidate.product ?? 'iphone17') === (entry.product ?? 'iphone17') &&
        candidate.site === entry.site &&
        candidate.status === 'ok' &&
        checkoutOf(candidate)
      ) {
        return candidate;
      }
    }
    return null;
  };

  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="300">
  <title>Price Monitor — iPhone 17 target ₹70,000</title>
  <style>
    :root {
      --text: #f1f5f9; --muted: #9aa8bd;
      --accent: #7dd3fc; --success: #4ade80; --error: #f87171; --warning: #fbbf24;
      --glass: rgba(255, 255, 255, 0.06);
      --glass-strong: rgba(255, 255, 255, 0.09);
      --glass-border: rgba(255, 255, 255, 0.12);
      --glass-highlight: rgba(255, 255, 255, 0.18);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    body {
      color: var(--text); padding: 2rem; max-width: 1200px; margin: 0 auto;
      background:
        radial-gradient(1100px 600px at 8% -10%, rgba(56, 189, 248, 0.16), transparent 60%),
        radial-gradient(900px 550px at 95% 0%, rgba(168, 85, 247, 0.14), transparent 55%),
        radial-gradient(1000px 700px at 50% 115%, rgba(45, 212, 191, 0.12), transparent 60%),
        linear-gradient(180deg, #0b1020 0%, #0e1526 45%, #0b1220 100%);
      background-attachment: fixed;
      min-height: 100vh;
    }
    body::before {
      content: ""; position: fixed; inset: 0; z-index: -1; pointer-events: none;
      background:
        radial-gradient(420px 420px at 85% 25%, rgba(99, 102, 241, 0.10), transparent 65%),
        radial-gradient(520px 520px at 12% 70%, rgba(20, 184, 166, 0.09), transparent 65%);
      animation: drift 26s ease-in-out infinite alternate;
    }
    @keyframes drift {
      from { transform: translate3d(0, 0, 0) scale(1); }
      to   { transform: translate3d(-3%, 4%, 0) scale(1.06); }
    }
    @media (prefers-reduced-motion: reduce) { body::before { animation: none; } }
    header {
      margin-bottom: 1.5rem; padding-bottom: 1.25rem; display: flex; justify-content: space-between; align-items: flex-end;
      background: linear-gradient(160deg, var(--glass-strong), var(--glass));
      border: 1px solid var(--glass-border); border-radius: 1.25rem; padding: 1.25rem 1.5rem;
      backdrop-filter: blur(18px) saturate(160%); -webkit-backdrop-filter: blur(18px) saturate(160%);
      box-shadow: 0 8px 32px rgba(2, 6, 23, 0.45), inset 0 1px 0 var(--glass-highlight);
    }
    h1 { font-size: 1.75rem; font-weight: 700; letter-spacing: -0.01em; }
    h2 { font-size: 1.25rem; margin-bottom: 1rem; }
    .product-heading {
      margin: 2.25rem 0 1rem; font-size: 1.4rem; padding: 0.75rem 1.25rem; border-radius: 1rem;
      background: linear-gradient(120deg, rgba(125, 211, 252, 0.10), rgba(168, 85, 247, 0.08));
      border: 1px solid var(--glass-border); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
      box-shadow: inset 0 1px 0 var(--glass-highlight);
    }
    .primary-tag, .watch-tag { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; padding: 0.2rem 0.6rem; border-radius: 9999px; vertical-align: middle; backdrop-filter: blur(6px); }
    .primary-tag { background: rgba(251, 191, 36, 0.18); color: var(--warning); border: 1px solid rgba(251, 191, 36, 0.35); }
    .watch-tag { background: rgba(148, 163, 184, 0.12); color: var(--muted); border: 1px solid rgba(148, 163, 184, 0.25); }
    .subtitle { color: var(--muted); font-size: 0.9rem; margin-top: 0.25rem; }
    .header-right { display: flex; flex-direction: column; align-items: flex-end; gap: 0.55rem; }
    .filter-row { display: flex; align-items: center; gap: 0.6rem; }
    .filter-label { color: var(--muted); font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
    .filter-select {
      appearance: none; -webkit-appearance: none; outline: none; cursor: pointer;
      color: var(--text); font-size: 0.92rem; font-weight: 600;
      padding: 0.5rem 2.3rem 0.5rem 0.95rem; border-radius: 0.8rem;
      border: 1px solid var(--glass-border);
      background-color: rgba(255,255,255,0.05);
      background-image:
        url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' fill='none' stroke='%239aa8bd' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"),
        linear-gradient(135deg, rgba(255,255,255,0.10), rgba(255,255,255,0.03));
      background-repeat: no-repeat, no-repeat;
      background-position: right 0.85rem center, 0 0;
      background-size: 0.75rem 0.5rem, 100% 100%;
      backdrop-filter: blur(12px) saturate(160%); -webkit-backdrop-filter: blur(12px) saturate(160%);
      box-shadow: inset 0 1px 0 var(--glass-highlight), 0 4px 16px rgba(2, 6, 23, 0.35);
      transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease;
    }
    .filter-select:hover { border-color: rgba(255,255,255,0.25); transform: translateY(-1px); }
    .filter-select:focus { border-color: rgba(125, 211, 252, 0.55); box-shadow: 0 0 0 3px rgba(125, 211, 252, 0.15), inset 0 1px 0 var(--glass-highlight); }
    .filter-select option { background: #101a30; color: var(--text); }
    .product-block { animation: block-in 0.3s ease; }
    .product-block.hidden { display: none; }
    @keyframes block-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
    .banner {
      padding: 0.85rem 1.25rem; border-radius: 1rem; margin-bottom: 1.25rem; font-size: 0.95rem;
      backdrop-filter: blur(16px) saturate(150%); -webkit-backdrop-filter: blur(16px) saturate(150%);
      box-shadow: 0 6px 24px rgba(2, 6, 23, 0.35), inset 0 1px 0 var(--glass-highlight);
    }
    .banner-sale { background: rgba(251, 191, 36, 0.12); border: 1px solid rgba(251, 191, 36, 0.4); color: var(--warning); }
    .banner-info { background: rgba(125, 211, 252, 0.10); border: 1px solid rgba(125, 211, 252, 0.35); color: var(--accent); }
    .banner-drop { background: rgba(74, 222, 128, 0.10); border: 1px solid rgba(74, 222, 128, 0.35); color: var(--success); }
    .badge { padding: 0.25rem 0.65rem; border-radius: 9999px; font-size: 0.8rem; font-weight: 600; text-transform: uppercase; backdrop-filter: blur(6px); }
    .badge-ok { background: rgba(74, 222, 128, 0.14); color: var(--success); border: 1px solid rgba(74, 222, 128, 0.3); }
    .badge-error { background: rgba(248, 113, 113, 0.14); color: var(--error); border: 1px solid rgba(248, 113, 113, 0.3); }
    .badge-best { background: rgba(251, 191, 36, 0.16); color: var(--warning); border: 1px solid rgba(251, 191, 36, 0.35); }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1.5rem; margin-bottom: 2.5rem; }
    .card {
      background: linear-gradient(155deg, var(--glass-strong) 0%, var(--glass) 55%, rgba(255,255,255,0.03) 100%);
      border: 1px solid var(--glass-border); border-radius: 1.25rem; padding: 1.5rem;
      display: flex; flex-direction: column; justify-content: space-between;
      backdrop-filter: blur(20px) saturate(170%); -webkit-backdrop-filter: blur(20px) saturate(170%);
      box-shadow: 0 10px 34px rgba(2, 6, 23, 0.45), inset 0 1px 0 var(--glass-highlight);
      transition: transform 0.25s ease, box-shadow 0.25s ease, border-color 0.25s ease;
    }
    .card:hover {
      transform: translateY(-3px);
      border-color: rgba(255, 255, 255, 0.22);
      box-shadow: 0 16px 44px rgba(2, 6, 23, 0.55), inset 0 1px 0 var(--glass-highlight);
    }
    .card-best {
      border-color: rgba(251, 191, 36, 0.55);
      box-shadow: 0 0 0 1px rgba(251, 191, 36, 0.35), 0 10px 34px rgba(2, 6, 23, 0.45), inset 0 1px 0 var(--glass-highlight);
      background: linear-gradient(155deg, rgba(251, 191, 36, 0.10) 0%, var(--glass) 60%);
    }
    .card-header { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
    .card-title { font-size: 1.2rem; font-weight: 600; color: var(--accent); }
    .price-main { font-size: 1.8rem; font-weight: 700; margin-bottom: 0.25rem; text-shadow: 0 0 24px rgba(125, 211, 252, 0.25); }
    .price-sub { font-size: 0.9rem; color: var(--muted); margin-bottom: 1rem; }
    .rec { padding: 0.6rem 0.8rem; border-radius: 0.75rem; font-size: 0.85rem; margin: 0.9rem 0; backdrop-filter: blur(8px); }
    .rec-buy { background: rgba(74, 222, 128, 0.10); border: 1px solid rgba(74, 222, 128, 0.35); color: var(--success); }
    .rec-wait { background: rgba(125, 211, 252, 0.08); border: 1px solid rgba(125, 211, 252, 0.3); color: var(--accent); }
    .rec-watch { background: rgba(251, 191, 36, 0.08); border: 1px solid rgba(251, 191, 36, 0.3); color: var(--warning); }
    .target-block { margin: 0.1rem 0 0.75rem; }
    .target-label { display: flex; justify-content: space-between; font-size: 0.72rem; color: var(--muted); margin-bottom: 0.3rem; gap: 0.5rem; }
    .target-bar { height: 7px; border-radius: 9999px; background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.06); overflow: hidden; box-shadow: inset 0 1px 2px rgba(0,0,0,0.35); }
    .target-fill {
      height: 100%; border-radius: 9999px; width: 0;
      background: linear-gradient(90deg, rgba(125, 211, 252, 0.9), rgba(56, 189, 248, 0.7));
      box-shadow: 0 0 10px rgba(56, 189, 248, 0.5);
      animation: bar-fill 1s cubic-bezier(.4,0,.2,1) forwards;
    }
    .target-fill.hit { background: linear-gradient(90deg, rgba(74, 222, 128, 0.9), rgba(34, 197, 94, 0.75)); box-shadow: 0 0 10px rgba(74, 222, 128, 0.55); }
    @keyframes bar-fill { from { transform: scaleX(0); transform-origin: left; } to { transform: scaleX(1); transform-origin: left; } }
    .detail-row { display: flex; justify-content: space-between; gap: 0.75rem; font-size: 0.875rem; padding: 0.45rem 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
    .detail-row:last-child { border-bottom: none; }
    .detail-label { color: var(--muted); white-space: nowrap; }
    .detail-value { font-weight: 500; text-align: right; }
    .chart-wrap { position: relative; margin: 0.85rem 0 0.35rem; cursor: crosshair; }
    .chart-wrap svg { display: block; width: 100%; height: auto; }
    .chart-hi, .chart-lo { position: absolute; right: 2px; font-size: 0.62rem; font-weight: 600; color: var(--muted); letter-spacing: 0.02em; pointer-events: none; }
    .chart-hi { top: 2px; }
    .chart-lo { bottom: 20px; }
    .chart-axis { display: flex; justify-content: space-between; margin-top: 0.15rem; font-size: 0.66rem; color: var(--muted); }
    .chart-line { fill: none; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 1; stroke-dashoffset: 1; animation: chart-draw 1.4s cubic-bezier(.4,0,.2,1) forwards; }
    [data-variant="success"] .chart-line { stroke: var(--success); }
    [data-variant="error"] .chart-line { stroke: var(--error); }
    [data-variant="success"] .chart-stop-hi { stop-color: var(--success); }
    [data-variant="success"] .chart-stop-lo { stop-color: var(--success); }
    [data-variant="error"] .chart-stop-hi { stop-color: var(--error); }
    [data-variant="error"] .chart-stop-lo { stop-color: var(--error); }
    .chart-area { opacity: 0; animation: chart-fade 0.9s ease 0.55s forwards; }
    .chart-grid { stroke: rgba(255,255,255,0.07); stroke-width: 1; stroke-dasharray: 3 4; }
    .chart-grid-hi { stroke: rgba(255,255,255,0.04); }
    .chart-dot { stroke: rgba(10, 16, 32, 0.9); stroke-width: 1.5; opacity: 0; animation: chart-fade 0.5s ease 1s forwards; }
    .chart-dot[data-cls="lo"] { fill: var(--success); }
    .chart-dot[data-cls="hi"] { fill: var(--error); }
    .chart-cross { stroke: rgba(255,255,255,0.35); stroke-width: 1; stroke-dasharray: 2 3; transition: x 0.08s ease; }
    .chart-hover-dot { fill: #fff; stroke: rgba(10,16,32,0.9); stroke-width: 1.5; filter: drop-shadow(0 0 6px rgba(125,211,252,0.8)); transition: cx 0.08s ease, cy 0.08s ease; }
    .chart-tip {
      position: absolute; pointer-events: none; opacity: 0; z-index: 6;
      transform: translate(-50%, calc(-100% - 14px));
      background: rgba(8, 13, 26, 0.88); color: var(--text);
      border: 1px solid var(--glass-border); border-radius: 0.7rem;
      padding: 0.45rem 0.65rem; font-size: 0.72rem; line-height: 1.35; white-space: nowrap;
      backdrop-filter: blur(10px) saturate(150%); -webkit-backdrop-filter: blur(10px) saturate(150%);
      box-shadow: 0 8px 24px rgba(2, 6, 23, 0.6), inset 0 1px 0 var(--glass-highlight);
      transition: opacity 0.15s ease, left 0.08s ease, top 0.08s ease;
    }
    .chart-wrap:hover .chart-tip { opacity: 1; }
    .chart-tip .tip-price { font-weight: 700; font-size: 0.82rem; }
    .chart-tip .tip-delta-down { color: var(--success); }
    .chart-tip .tip-delta-up { color: var(--error); }
    @keyframes chart-draw { to { stroke-dashoffset: 0; } }
    @keyframes chart-fade { to { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) {
      .chart-line { animation: none; stroke-dashoffset: 0; }
      .chart-area, .chart-dot { animation: none; opacity: 1; }
    }
    .btn {
      display: inline-block; width: 100%; text-align: center; padding: 0.65rem; margin-top: 1.25rem;
      color: #eaf6ff; text-decoration: none; border-radius: 0.85rem; font-weight: 600;
      background: linear-gradient(135deg, rgba(56, 189, 248, 0.35), rgba(99, 102, 241, 0.35));
      border: 1px solid rgba(125, 211, 252, 0.45);
      backdrop-filter: blur(12px) saturate(160%); -webkit-backdrop-filter: blur(12px) saturate(160%);
      box-shadow: 0 6px 20px rgba(56, 189, 248, 0.18), inset 0 1px 0 rgba(255,255,255,0.25);
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }
    .btn:hover { transform: translateY(-1px); box-shadow: 0 10px 28px rgba(56, 189, 248, 0.3), inset 0 1px 0 rgba(255,255,255,0.3); }
    section {
      background: linear-gradient(155deg, var(--glass-strong), var(--glass));
      border: 1px solid var(--glass-border); border-radius: 1.25rem; padding: 1.5rem; margin-bottom: 2rem;
      backdrop-filter: blur(20px) saturate(160%); -webkit-backdrop-filter: blur(20px) saturate(160%);
      box-shadow: 0 8px 32px rgba(2, 6, 23, 0.4), inset 0 1px 0 var(--glass-highlight);
    }
    table { width: 100%; border-collapse: collapse; font-size: 0.875rem; text-align: left; }
    th, td { padding: 0.75rem; border-bottom: 1px solid rgba(255,255,255,0.08); }
    th { color: var(--muted); font-weight: 600; }
    tbody tr { transition: background 0.2s ease; }
    tbody tr:hover { background: rgba(255, 255, 255, 0.04); }
    .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .table-wrap table { min-width: 640px; }
    .sale-active { color: var(--warning); font-weight: 600; }
    .learned { color: var(--success); font-weight: 600; }
    .est { color: var(--muted); font-size: 0.85em; }
    .low-record { color: var(--success); font-weight: 600; }
    .badge-neutral { background: rgba(148, 163, 184, 0.14); color: var(--muted); border: 1px solid rgba(148, 163, 184, 0.3); }
    .badge-stale { background: rgba(251, 146, 60, 0.14); color: #fb923c; border: 1px solid rgba(251, 146, 60, 0.35); }
    .badge-row { display: inline-flex; align-items: center; gap: 0.35rem; flex-wrap: wrap; justify-content: flex-end; }
    .rec-blocked { background: rgba(248, 113, 113, 0.10); border: 1px solid rgba(248, 113, 113, 0.35); color: var(--error); }
    .hero {
      background: linear-gradient(150deg, rgba(125, 211, 252, 0.16), rgba(168, 85, 247, 0.10) 55%, var(--glass));
      border: 1px solid rgba(125, 211, 252, 0.35); border-radius: 1.5rem; padding: 1.75rem 2rem; margin-bottom: 1.5rem;
      backdrop-filter: blur(22px) saturate(170%); -webkit-backdrop-filter: blur(22px) saturate(170%);
      box-shadow: 0 14px 44px rgba(2, 6, 23, 0.5), inset 0 1px 0 rgba(255,255,255,0.22);
    }
    .hero-kicker { font-size: 0.72rem; font-weight: 700; letter-spacing: 0.12em; color: var(--accent); text-transform: uppercase; margin-bottom: 0.6rem; }
    .hero-price-row { display: flex; align-items: center; gap: 0.9rem; flex-wrap: wrap; }
    .hero-price { font-size: 2.6rem; font-weight: 800; line-height: 1; letter-spacing: -0.02em; text-shadow: 0 0 30px rgba(125, 211, 252, 0.35); }
    .hero-sub { color: var(--muted); margin: 0.55rem 0 0; font-size: 0.95rem; }
    .hero-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.75rem; margin-top: 1rem; }
    .hero-stats > div { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.09); border-radius: 0.8rem; padding: 0.6rem 0.75rem; }
    .hero-stats .stat-label { display: block; margin-bottom: 0.2rem; }
    .hero-stats strong { font-size: 0.92rem; font-weight: 600; }
    .hero-note { margin-top: 0.8rem; font-size: 0.85rem; color: var(--warning); }
    .forecast-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 0.7rem; margin-bottom: 0.9rem; }
    .stat { background: rgba(255,255,255,0.045); border: 1px solid rgba(255,255,255,0.08); border-radius: 0.75rem; padding: 0.65rem 0.75rem; }
    .stat-label { font-size: 0.7rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
    .stat-value { font-size: 0.95rem; font-weight: 600; margin-top: 0.15rem; }
    .forecast-message { margin: 0.35rem 0 0.9rem; font-size: 0.9rem; color: var(--muted); }
    .forecast-table td { vertical-align: top; }
    .source-cell { color: var(--muted); font-size: 0.82rem; max-width: 280px; }
    .sub-heading { margin: 1.25rem 0 0.6rem; font-size: 1rem; }
    @media (max-width: 640px) {
      body { padding: 1rem; }
      header { flex-direction: column; align-items: flex-start; gap: 0.4rem; padding: 1rem 1.15rem; }
      .header-right { align-items: flex-start; width: 100%; }
      .filter-row { width: 100%; }
      .filter-select { flex: 1; }
      h1 { font-size: 1.35rem; }
      h2 { font-size: 1.1rem; }
      .product-heading { font-size: 1.15rem; padding: 0.65rem 1rem; }
      .grid { grid-template-columns: 1fr; gap: 1rem; margin-bottom: 1.5rem; }
      .card { padding: 1.15rem; }
      .price-main { font-size: 1.55rem; }
      .card-title { font-size: 1.05rem; }
      .banner { padding: 0.75rem 1rem; font-size: 0.88rem; }
      section { padding: 1rem; margin-bottom: 1.25rem; }
      table { font-size: 0.8rem; }
      th, td { padding: 0.55rem 0.5rem; }
      .rec { font-size: 0.82rem; }
      .hero { padding: 1.25rem; }
      .hero-price { font-size: 2.1rem; }
      .hero-sub { font-size: 0.88rem; }
      .badge-row { justify-content: flex-start; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>📱 Price Monitor — iPhone 17 · Galaxy S25 · S26</h1>
      <div class="subtitle">Target: <strong>iPhone 17 256GB Mist Blue ≤ ${money.format(config.target.buyNow)}</strong> checkout, no exchange | Pincode: <strong>${config.pincode}</strong></div>
    </div>
    <div class="header-right">
      <div class="filter-row">
        <span class="filter-label">Show</span>
        <select id="product-filter" class="filter-select" aria-label="Filter by phone">
          <option value="all">All phones</option>
          ${products.map((product) => `<option value="${product.id}">${product.shortName}</option>`).join('')}
        </select>
      </div>
      <div class="subtitle">Last updated: <strong>${istTime(now)}</strong> IST · refresh in <span id="refresh-count">5:00</span></div>
    </div>
  </header>

  ${heroHtml(primary.product, primary.sorted, primary.forecast, historyEntries, config, primary.basisName, primary.basisSite)}
  ${bannerHtml}
  ${dropBannerHtml}
  ${productSectionHtml}

  <section>
    <h2>📊 Recent Scrapes (newest first)</h2>
    <div class="table-wrap">
    <table>
      <thead>
        <tr><th>Time (IST)</th><th>Product</th><th>Site</th><th>Status</th><th>Checkout</th><th>Δ prev</th><th>M.R.P.</th></tr>
      </thead>
      <tbody>
        ${historyEntries
          .slice(-20)
          .reverse()
          .map((entry) => {
            const previous = entry.status === 'ok' ? previousEntryFor(entry) : null;
            const delta = previous && checkoutOf(entry) ? checkoutOf(entry) - checkoutOf(previous) : null;
            return `
          <tr>
            <td>${istTime(entry.checkedAt)}</td>
            <td>${productOf(entry, products)?.shortName ?? entry.product ?? 'iPhone 17'}</td>
            <td><strong>${entry.name}</strong></td>
            <td><span class="badge ${entry.status === 'ok' ? 'badge-ok' : 'badge-error'}">${entry.status}</span></td>
            <td>${checkoutOf(entry) ? money.format(checkoutOf(entry)) : '-'}</td>
            <td style="color:${delta < 0 ? 'var(--success)' : delta > 0 ? 'var(--error)' : 'var(--muted)'};">${delta === null ? '-' : `${delta > 0 ? '+' : ''}${money.format(delta)}`}</td>
            <td>${entry.mrp ? money.format(entry.mrp) : '-'}</td>
          </tr>`;
          })
          .join('')}
      </tbody>
    </table>
    </div>
  </section>

  <script>
    (function () {
      const el = document.getElementById('refresh-count');
      if (!el) return;
      const limit = 300;
      const start = Date.now();
      const tick = function () {
        const left = Math.max(0, limit - Math.floor((Date.now() - start) / 1000));
        el.textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
      };
      tick();
      setInterval(tick, 1000);
    })();
    (function () {
      const filterEl = document.getElementById('product-filter');
      const blocks = document.querySelectorAll('.product-block');
      const applyFilter = function (value) {
        blocks.forEach(function (block) {
          block.classList.toggle('hidden', value !== 'all' && block.getAttribute('data-product') !== value);
        });
      };
      let saved = 'iphone17';
      try { saved = localStorage.getItem('priceFilter') || 'iphone17'; } catch (e) {}
      if (filterEl) {
        if (![...filterEl.options].some(function (o) { return o.value === saved; })) saved = 'iphone17';
        filterEl.value = saved;
        applyFilter(saved);
        filterEl.addEventListener('change', function () {
          applyFilter(filterEl.value);
          try { localStorage.setItem('priceFilter', filterEl.value); } catch (e) {}
        });
      }
    })();
    (function () {
      const W = 320, H = 100;
      const fmt = (v) => '₹' + v.toLocaleString('en-IN');
      document.querySelectorAll('.chart-wrap').forEach(function (wrap) {
        const svg = wrap.querySelector('svg');
        const tip = wrap.querySelector('.chart-tip');
        const cross = wrap.querySelector('.chart-cross');
        const hoverDot = wrap.querySelector('.chart-hover-dot');
        let pts = [];
        try { pts = JSON.parse(wrap.getAttribute('data-points').replace(/&quot;/g, '"')); } catch (e) { return; }
        if (!pts.length) return;
        const first = pts[0][2];
        const show = function (clientX, clientY) {
          const rect = svg.getBoundingClientRect();
          const vx = ((clientX - rect.left) / rect.width) * W;
          let best = pts[0];
          for (const p of pts) { if (Math.abs(p[0] - vx) < Math.abs(best[0] - vx)) best = p; }
          cross.setAttribute('x1', best[0]); cross.setAttribute('x2', best[0]);
          cross.style.display = '';
          hoverDot.setAttribute('cx', best[0]); hoverDot.setAttribute('cy', best[1]);
          hoverDot.style.display = '';
          const delta = best[2] - first;
          const pct = first ? ((delta / first) * 100).toFixed(1) : '0';
          const dateStr = new Date(best[3]).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
          tip.innerHTML =
            '<div class="tip-price">' + fmt(best[2]) + '</div>' +
            '<div>' + dateStr + ' IST</div>' +
            (delta === 0 ? '<div>start point</div>' :
              '<div class="' + (delta < 0 ? 'tip-delta-down' : 'tip-delta-up') + '">' +
              (delta < 0 ? '▼ ' : '▲ ') + fmt(Math.abs(delta)) + ' (' + pct + '%)</div>');
          const wrapRect = wrap.getBoundingClientRect();
          const leftPct = Math.min(92, Math.max(8, ((best[0] / W) * rect.width + rect.left - wrapRect.left) / wrapRect.width * 100));
          const topPct = ((best[1] / H) * rect.height + rect.top - wrapRect.top) / wrapRect.height * 100;
          tip.style.left = leftPct + '%';
          tip.style.top = topPct + '%';
        };
        wrap.addEventListener('mousemove', function (e) { show(e.clientX, e.clientY); });
        wrap.addEventListener('mouseleave', function () {
          tip.style.display = 'none';
          cross.style.display = 'none';
          hoverDot.style.display = 'none';
        });
        wrap.addEventListener('mouseenter', function () { tip.style.display = ''; });
        wrap.addEventListener('touchstart', function (e) {
          if (e.touches[0]) show(e.touches[0].clientX, e.touches[0].clientY);
        }, { passive: true });
      });
    })();
  </script>
</body>
</html>`;

  await writeFile(path.join(root, 'dashboard.html'), htmlContent, 'utf8');

  // 3. Markdown report — per product
  const mdLines = [
    `# 📱 Price Monitor — iPhone 17 · Galaxy S25 · Galaxy S26`,
    `**Primary target:** iPhone 17 256GB Mist Blue ≤ ${money.format(config.target.buyNow)} checkout (no exchange) | **Pincode:** \`${config.pincode}\` | **Updated:** ${istTime(now)} IST`,
  ];

  for (const { product, sorted, forecast, bestDealId, basisName } of state) {
    mdLines.push(
      ``,
      `## ${product.name}`,
      ``,
      `| Site | Tier | Purchasable | Checkout | M.R.P. | Bank offer (unverified) | Exchange (optional) | Verified (IST) |`,
      `| --- | --- | --- | --- | --- | --- | --- | --- |`,
    );
    sorted.forEach((r) => {
      if (r.status === 'error') {
        mdLines.push(`| [**${r.name}**](${r.url}) | — | ❌ Error | last known: see dashboard | — | — | — | — |`);
      } else {
        const purchase = r.purchase ?? {};
        const exchange =
          r.assumedExchangeValue && r.exchangeAdjustedPrice
            ? `${money.format(r.assumedExchangeValue)} assumed → ${money.format(r.exchangeAdjustedPrice)}`
            : '—';
        const checkout = checkoutOf(r);
        mdLines.push(
          `| [**${r.name}**](${r.url}) | ${purchase.tier?.label ?? 'UNKNOWN'}${r.site === bestDealId ? ' ★' : ''} | ${purchase.purchasable ? '✅ Yes' : `❌ ${blockersText(r)}`} | **${checkout ? money.format(checkout) : '—'}** | ${r.mrp ? money.format(r.mrp) : '—'} | ${r.maxBankOffer ? money.format(r.maxBankOffer) : '—'} | ${exchange} | ${r.verifiedAt ? istTime(r.verifiedAt) : istTime(r.checkedAt)} |`
        );
      }
    });

    mdLines.push(
      ``,
      `### 📈 Forecast`,
      `- Level: **${forecast.label}** · Confidence: **${forecast.confidence}** · Observations: ${forecast.stats.count} over ${forecast.stats.uniqueDays} unique days`,
      `- Basis: verified **${basisName}** checkout prices only (stores that cannot deliver are excluded)`,
      `- ${forecast.message}`
    );
    if (forecast.scenarios) {
      for (const [key, name] of [
        ['conservative', 'Conservative'],
        ['expected', 'Expected'],
        ['aggressive', 'Aggressive'],
      ]) {
        const scenario = forecast.scenarios[key];
        mdLines.push(`- **${name}:** ${money.format(scenario.range[0])} – ${money.format(scenario.range[1])} (${scenario.note})`);
      }
      mdLines.push(`- Method: ${forecast.method}`);
    }
    if (forecast.upcoming.length) {
      mdLines.push(`- Upcoming sales (dates estimated, not retailer-confirmed):`);
      for (const sale of forecast.upcoming) {
        mdLines.push(
          `  - **${sale.name}**: ${istDate(sale.start)} → ${istDate(sale.end)} (${sale.daysAway > 0 ? `${sale.daysAway} days` : 'live'}) — ${sale.source ?? 'no source'}`
        );
      }
    } else {
      mdLines.push(`- No upcoming sale windows configured`);
    }
    mdLines.push(`- All ranges are checkout price without exchange or unverified bank offers.`);
  }

  const mdContent = mdLines.join('\n');
  await writeFile(path.join(reportsDir, 'latest.md'), mdContent, 'utf8');

  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      await writeFile(process.env.GITHUB_STEP_SUMMARY, mdContent + '\n', { flag: 'a' });
    } catch {}
  }
}

// CLI entry: regenerate dashboard + markdown from the latest recorded data, no scraping.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const root = process.cwd();
  const config = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
  let results = [];
  try {
    results = JSON.parse(await readFile(path.join(root, 'data/latest.json'), 'utf8')).sites ?? [];
  } catch {}
  await writeReports({ root, config, results, historyPath: path.join(root, 'data/history.jsonl') });
  console.log('Dashboard & Markdown report re-generated successfully!');
}
