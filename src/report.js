import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkoutOf, forecastFor, identityCheck, purchaseState, targetFor } from './pricing.js';

const money = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

const istTime = (iso) =>
  new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

const istDate = (value) =>
  new Date(value).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));

const productOf = (entry, products) =>
  products.find((product) => product.id === (entry.product ?? 'iphone17')) ?? null;

const lifetimeLowFor = (historyEntries, productId) => {
  let lowest = null;
  for (const entry of historyEntries) {
    if (
      (entry.product ?? 'iphone17') !== productId ||
      entry.status !== 'ok' ||
      entry.purchase?.purchasable !== true ||
      !checkoutOf(entry)
    ) continue;
    if (!lowest || checkoutOf(entry) < checkoutOf(lowest)) lowest = entry;
  }
  return lowest;
};

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

const chart = (entries, id, target = null) => {
  const values = entries.map((entry) => checkoutOf(entry));
  if (values.length < 2) return '';
  const W = 320;
  const H = 100;
  const PAD_X = 8;
  const PAD_TOP = 16;
  const PAD_BOTTOM = 20;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const pad = Math.max(span * 0.18, Math.round(max * 0.004) || 50);
  const lo = min - pad;
  const hi = max + pad;
  const targetY = target ? H - PAD_BOTTOM - ((target - lo) / (hi - lo)) * (H - PAD_TOP - PAD_BOTTOM) : null;
  const targetInRange = targetY !== null && target > lo && target < hi;
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
  const pathFrom = (points) => {
    let d = `M ${points[0].x} ${points[0].y}`;
    if (points.length === 2) return `${d} L ${points[1].x} ${points[1].y}`;
    for (let i = 0; i < points.length - 1; i += 1) {
      const xMid = (points[i].x + points[i + 1].x) / 2;
      d += ` C ${xMid} ${points[i].y}, ${xMid} ${points[i + 1].y}, ${points[i + 1].x} ${points[i + 1].y}`;
    }
    return d;
  };
  const linePath = pathFrom(pts);
  const areaPath = `${linePath} L ${pts[pts.length - 1].x} ${H - PAD_BOTTOM} L ${pts[0].x} ${H - PAD_BOTTOM} Z`;
  const falling = values[values.length - 1] <= values[0];
  const minIdx = values.indexOf(min);
  const maxIdx = values.indexOf(max);
  const dataJson = JSON.stringify(pts.map((p) => [p.x, p.y, p.v, p.t])).replace(/"/g, '&quot;');
  const firstDate = istDate(pts[0].t);
  const lastDate = istDate(pts[pts.length - 1].t);
  return `
      <div class="chart-wrap" data-points="${dataJson}" data-variant="${falling ? 'down' : 'up'}">
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Price history from ${firstDate} to ${lastDate}">
          <defs>
            <linearGradient id="fill-${id}" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" class="chart-fill-hi" stop-opacity="0.18"/>
              <stop offset="100%" class="chart-fill-lo" stop-opacity="0"/>
            </linearGradient>
          </defs>
          <line class="chart-grid" x1="0" y1="${H - PAD_BOTTOM}" x2="${W}" y2="${H - PAD_BOTTOM}"/>
          <path class="chart-area" d="${areaPath}" fill="url(#fill-${id})"/>
          <path class="chart-line" d="${linePath}"/>
          ${targetInRange ? `<line class="chart-target" x1="0" y1="${targetY.toFixed(1)}" x2="${W}" y2="${targetY.toFixed(1)}"/>` : ''}
          ${minIdx !== maxIdx ? `<circle class="chart-dot chart-dot-lo" cx="${pts[minIdx].x}" cy="${pts[minIdx].y}" r="2.6"/>` : ''}
          ${minIdx !== maxIdx ? `<circle class="chart-dot chart-dot-hi" cx="${pts[maxIdx].x}" cy="${pts[maxIdx].y}" r="2.6"/>` : ''}
          <line class="chart-cross" x1="0" y1="0" x2="0" y2="${H - PAD_BOTTOM}" style="display:none"/>
          <circle class="chart-hover-dot" r="3.5" style="display:none"/>
        </svg>
        <div class="chart-axis"><span>${firstDate}</span><span>${lastDate}</span></div>
        ${
          target && !targetInRange
            ? `<p class="chart-note">Target ${money.format(target)} is ${money.format(Math.abs(target - (target < min ? min : max)))} ${
                target < min ? 'below the lowest plotted price' : 'above the highest plotted price'
              }.</p>`
            : ''
        }
        <div class="chart-tip" style="display:none"></div>
      </div>`;
};

const marketChart = (product, historyEntries, target, pincode) => {
  const verified = historyEntries.filter(
    (entry) =>
      (entry.product ?? 'iphone17') === product.id &&
      entry.status === 'ok' &&
      entry.purchase?.purchasable === true &&
      checkoutOf(entry)
  );
  if (verified.length < 2) {
    return `<section class="market-panel"><div class="market-head"><div><p class="eyebrow">Verified market history</p><h2>Price trend</h2></div></div><p class="market-empty">Collecting verified, deliverable prices. The graph appears after two valid checks.</p></section>`;
  }
  const siteNames = new Map(product.sites.map((site) => [site.id, site.name]));
  const grouped = new Map();
  for (const entry of verified) {
    if (!grouped.has(entry.site)) grouped.set(entry.site, []);
    grouped.get(entry.site).push(entry);
  }
  const series = [...grouped.entries()].map(([site, entries]) => ({ site, entries: entries.slice(-120) }));
  const all = series.flatMap((item) => item.entries);
  const prices = all.map((entry) => checkoutOf(entry));
  const times = all.map((entry) => new Date(entry.checkedAt).getTime());
  const minPrice = Math.min(...prices, target.buyNow);
  const maxPrice = Math.max(...prices, target.buyNow);
  const padding = Math.max(1000, (maxPrice - minPrice) * 0.12);
  const yMin = minPrice - padding;
  const yMax = maxPrice + padding;
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const W = 920;
  const H = 220;
  const left = 72;
  const right = 20;
  const top = 18;
  const bottom = 36;
  const x = (time) => left + ((time - tMin) / Math.max(1, tMax - tMin)) * (W - left - right);
  const y = (price) => top + ((yMax - price) / Math.max(1, yMax - yMin)) * (H - top - bottom);
  const colours = ['#2563eb', '#16a34a', '#f97316', '#7c3aed', '#dc2626', '#0891b2'];
  const paths = series
    .map((item, index) => {
      const points = item.entries.map((entry) => ({
        x: x(new Date(entry.checkedAt).getTime()),
        y: y(checkoutOf(entry)),
        price: checkoutOf(entry),
        date: entry.checkedAt,
      }));
      const colour = colours[index % colours.length];
      const line = points.length > 1
        ? `<path d="${points.map((point, pointIndex) => `${pointIndex ? 'L' : 'M'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ')}" fill="none" stroke="${colour}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`
        : '';
      const dots = points
        .map((point) => `<circle class="market-point" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="3.5" fill="${colour}" data-site="${escapeHtml(siteNames.get(item.site) ?? item.site)}" data-price="${point.price}" data-date="${point.date}" tabindex="0"/>`)
        .join('');
      return line + dots;
    })
    .join('');
  const legend = series
    .map((item, index) => `<span><i style="background:${colours[index % colours.length]}"></i>${escapeHtml(siteNames.get(item.site) ?? item.site)}</span>`)
    .join('');
  const targetY = y(target.buyNow);
  return `
    <section class="market-panel">
      <div class="market-head">
        <div><p class="eyebrow">Verified and deliverable only</p><h2>Best-price history</h2></div>
        <div class="market-legend">${legend}</div>
      </div>
      <svg class="market-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Verified checkout price history by store">
        <line x1="${left}" y1="${top}" x2="${left}" y2="${H - bottom}" class="market-axis"/>
        <line x1="${left}" y1="${H - bottom}" x2="${W - right}" y2="${H - bottom}" class="market-axis"/>
        <line x1="${left}" y1="${targetY.toFixed(1)}" x2="${W - right}" y2="${targetY.toFixed(1)}" class="market-target"/>
        <text x="8" y="${(y(maxPrice) + 4).toFixed(1)}" class="market-label">${money.format(maxPrice)}</text>
        <text x="8" y="${(y(minPrice) + 4).toFixed(1)}" class="market-label">${money.format(minPrice)}</text>
        <text x="${W - right}" y="${(targetY - 7).toFixed(1)}" text-anchor="end" class="market-target-label">Target ${money.format(target.buyNow)}</text>
        <line class="market-cross" x1="0" y1="${top}" x2="0" y2="${H - bottom}" hidden/>
        ${paths}
      </svg>
      <div class="market-dates"><span>${istDate(new Date(tMin))}</span><span>${istDate(new Date(tMax))}</span></div>
      <div class="market-tip" hidden></div>
      <p class="tiny">Unverified listings, unavailable colours and prices that cannot deliver to ${escapeHtml(pincode)} are excluded.</p>
    </section>`;
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

const BLOCKER_TEXT = {
  SCRAPE_FAILED: 'store check failed',
  PRICE_UNVERIFIED: 'price could not be verified',
  PRICE_SUSPICIOUS: 'price looks wrong',
  OUT_OF_STOCK: 'out of stock',
  STOCK_UNVERIFIED: 'stock could not be verified',
  NOT_DELIVERABLE: `won't deliver to 500055`,
  DELIVERY_UNVERIFIED: 'delivery to 500055 could not be verified',
  STORAGE_MISMATCH: 'wrong storage size',
  COLOR_UNVERIFIED: 'not the Mist Blue colour',
  INVALID_URL: 'listing link is invalid',
};

const blockerText = (result, config) =>
  (result.purchase?.blockers ?? []).map((blocker) => BLOCKER_TEXT[blocker] ?? blocker).join(', ');

const bestPurchasable = (results) =>
  results
    .filter((result) => result.status === 'ok' && result.purchase?.purchasable && result.checkoutPrice)
    .sort((a, b) => a.checkoutPrice - b.checkoutPrice)[0] ?? null;

const tierClass = (tier) => {
  if (tier === 'BUY') return 'pill-green';
  if (tier === 'STRONG_DEAL') return 'pill-amber';
  if (tier === 'WATCH') return 'pill-blue';
  return 'pill-grey';
};

const verdictFor = (best, target, purchasePlan, now) => {
  const waitingForWindow = purchasePlan?.notBefore &&
    new Date(now).getTime() < new Date(`${purchasePlan.notBefore}T00:00:00+05:30`).getTime();
  if (waitingForWindow) {
    return {
      tone: 'blue',
      title: 'Tracking',
      action: `Wait for a verified checkout price at or below ${money.format(target.buyNow)}.`,
      headline: 'Track now. Buy in December.',
    };
  }
  if (!best) {
    return {
      tone: 'grey',
      title: 'No verified offer',
      action: 'No store passes all checks right now. Wait for a verified price.',
      headline: 'Wait',
    };
  }
  const price = best.checkoutPrice;
  const gap = price - target.buyNow;
  const tier = best.purchase?.tier?.tier;
  if (tier === 'BUY') {
    return {
      tone: 'green',
      title: 'Buy now',
      action: `${money.format(price)} is at or below your ${money.format(target.buyNow)} target.`,
      headline: 'Buy now',
    };
  }
  if (tier === 'STRONG_DEAL') {
    return {
      tone: 'amber',
      title: 'Strong deal',
      action: `${money.format(price)} is only ${money.format(gap)} above your target.`,
      headline: 'Almost there',
    };
  }
  if (tier === 'WATCH') {
    return {
      tone: 'blue',
      title: 'Keep watching',
      action: `${money.format(price)} is ${money.format(gap)} above your target.`,
      headline: 'Keep watching',
    };
  }
  return {
    tone: 'grey',
    title: 'Wait',
    action: `${money.format(price)} is ${money.format(gap)} above your ${money.format(target.buyNow)} target.`,
    headline: 'Wait for a lower price',
  };
};

const reasonFor = (r, config) => {
  if (r.status === 'error') return { tone: 'bad', text: 'Store check failed. Last known price is shown below.' };
  if (r.purchase?.purchasable) {
    return { tone: 'ok', text: `In stock and delivers to ${config.pincode}.` };
  }
  const reasons = blockerText(r, config);
  return { tone: 'bad', text: reasons ? `Can't buy: ${reasons}.` : `Can't verify this offer right now.` };
};

const heroHtml = (product, sorted, forecast, historyEntries, config, basisName, basisSite, now) => {
  const target = targetFor(config, product.id);
  const best = bestPurchasable(sorted);
  const advertised = sorted
    .filter((result) => result.status === 'ok' && result.checkoutPrice)
    .sort((a, b) => a.checkoutPrice - b.checkoutPrice)[0] ?? null;
  const lifetimeLow = lifetimeLowFor(historyEntries, product.id);
  const verdict = verdictFor(best, target, config.purchasePlan, now);
  const price = best?.checkoutPrice ?? null;
  const resaleValue = product.assumedExchangeValue ?? 0;
  const gap = price ? price - target.buyNow : null;
  const progress = price ? Math.max(3, Math.min(100, Math.round((target.buyNow / price) * 100))) : 0;
  const nextSale = forecast.upcoming[0] ?? null;
  const lowestPrice = lifetimeLow ? checkoutOf(lifetimeLow) : null;
  return `
  <section class="verdict verdict-${verdict.tone}">
    <div class="verdict-main">
      <p class="eyebrow">${escapeHtml(product.name)} · your target</p>
      <div class="verdict-title-row">
        <span class="verdict-title">${verdict.headline}</span>
        <span class="pill ${tierClass(best?.purchase?.tier?.tier)}">${verdict.title}</span>
      </div>
      <p class="verdict-action">${verdict.action}</p>
      <p class="verdict-sub">${
        best
          ? `Best verified offer: <strong>${escapeHtml(best.name)}</strong>${best.delivery ? ` · ${escapeHtml(best.delivery)}` : ''}`
          : advertised
            ? `Lowest listed price: <strong>${money.format(advertised.checkoutPrice)} at ${escapeHtml(advertised.name)}</strong> — but it does not pass all checks.`
            : 'No store could be checked successfully.'
      }</p>
      <div class="progress"><div class="progress-fill ${gap !== null && gap <= 0 ? 'progress-hit' : ''}" style="width:${progress}%"></div></div>
      <div class="progress-labels"><span>Target ${money.format(target.buyNow)}</span><span>${
        price ? (gap > 0 ? `${money.format(gap)} to go` : 'Target reached') : 'Waiting for a verified price'
      }</span></div>
    </div>
    <div class="verdict-stats">
      <div><span>Best price now</span><strong>${price ? money.format(price) : '—'}</strong></div>
      <div><span>Your target</span><strong>${money.format(target.buyNow)}</strong></div>
      <div><span>After selling M35</span><strong>${price ? money.format(Math.max(0, price - resaleValue)) : '—'}</strong></div>
    </div>
    <div class="verdict-foot">
      <span>Lowest verified since tracking began: <strong>${
        lowestPrice
          ? `${money.format(lowestPrice)} at ${escapeHtml(lifetimeLow.name)} (${istDate(lifetimeLow.checkedAt)})`
          : 'no history yet'
      }</strong></span>
      <span>Next sale: <strong>${
        nextSale
          ? `${escapeHtml(nextSale.name)} — ${nextSale.daysAway > 0 ? `in ${nextSale.daysAway} days` : 'live'}${nextSale.dateConfidence === 'estimated' ? ' (estimated)' : ''}`
          : 'none configured'
      }</strong></span>
    </div>
  </section>`;
};

const forecastHtml = (product, forecast, basisName) => {
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
            <td>${sale.daysAway > 0 ? `in ${sale.daysAway} days` : 'live'}</td>
            <td>${sale.dateConfidence === 'estimated' ? 'Estimated' : 'Confirmed'}</td>
          </tr>`
        )
        .join('')
    : '';
  return `
    <details class="panel">
      <summary>
        <span>Price forecast &amp; sale calendar</span>
        <span class="summary-meta">${forecast.label} · ${forecast.confidence} confidence</span>
      </summary>
      <div class="panel-body">
        <p class="panel-lead">${forecast.message}</p>
        <div class="stat-grid">
          <div><span>Observations</span><strong>${stats.count}</strong></div>
          <div><span>Days recorded</span><strong>${stats.uniqueDays}</strong></div>
          <div><span>Lowest seen</span><strong>${stats.min ? money.format(stats.min) : '—'}</strong></div>
          <div><span>Median</span><strong>${stats.median ? money.format(stats.median) : '—'}</strong></div>
          <div><span>Highest seen</span><strong>${stats.max ? money.format(stats.max) : '—'}</strong></div>
        </div>
        ${
          forecast.scenarios
            ? `<div class="table-wrap">
          <table>
            <thead><tr><th>Scenario</th><th>Possible checkout</th><th>What it assumes</th></tr></thead>
            <tbody>
              ${scenario('conservative', 'Conservative')}
              ${scenario('expected', 'Expected')}
              ${scenario('aggressive', 'Aggressive')}
            </tbody>
          </table>
        </div>`
            : ''
        }
        ${
          upcomingRows
            ? `<h4>Upcoming sales</h4>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Sale</th><th>Window (IST)</th><th>Status</th><th>Date confidence</th></tr></thead>
              <tbody>${upcomingRows}</tbody>
            </table>
          </div>`
            : ''
        }
        <p class="tiny">Based only on verified ${escapeHtml(basisName)} prices. Stores that cannot deliver to your pincode are excluded. Ranges are scenarios, not predictions.</p>
      </div>
    </details>`;
};

const cardHtml = (product, r, bestDealId, config, historyEntries) => {
  const target = targetFor(config, product.id);
  const site = product.sites.find((entry) => entry.id === r.site);
  const siteNote = site?.note ?? null;

  if (r.status === 'error') {
    const lastGood = lastKnownGood(historyEntries, product.id, r.site);
    return `
      <article class="card">
        <div class="card-head">
          <h3>${escapeHtml(r.name)}</h3>
          <span class="pill pill-red">Check failed</span>
        </div>
        <p class="card-reason bad"><span class="dot"></span>${escapeHtml(r.error)}</p>
        ${
          lastGood
            ? `<div class="price-row"><span class="price">${money.format(checkoutOf(lastGood))}</span><span class="price-note">last known · ${istTime(lastGood.checkedAt)} IST</span></div>
        <p class="card-gap">Not current. We will update on the next successful check.</p>`
            : `<p class="card-gap">No successful check recorded yet.</p>`
        }
        ${siteNote ? `<p class="site-note">${escapeHtml(siteNote)}</p>` : ''}
        <a class="store-link" href="${r.url}" target="_blank" rel="noopener">Open ${escapeHtml(r.name)}</a>
      </article>`;
  }

  const entries = historyForSite(historyEntries, product.id, r.site);
  const verifiedEntries = entries.filter((entry) => entry.purchase?.purchasable === true);
  const trend = trendOf(entries);
  const price = r.checkoutPrice ?? checkoutOf(r);
  const purchase = r.purchase ?? { purchasable: false, blockers: [], tier: { tier: 'UNKNOWN', label: 'UNKNOWN' } };
  const reason = reasonFor(r, config);
  const isBest = r.site === bestDealId;
  const isStale = stale(r.verifiedAt);
  const lowestRecorded = verifiedEntries.length
    ? verifiedEntries.reduce((min, entry) => (checkoutOf(entry) < checkoutOf(min) ? entry : min))
    : null;
  const gap = price ? price - target.buyNow : null;
  const bankOffers = (r.bankOffersDetailed ?? []).filter((offer) => offer.kind !== 'emi' && offer.amount > 0);
  const bankMap = {};
  for (const offer of bankOffers) bankMap[offer.bank] = Math.max(bankMap[offer.bank] ?? 0, offer.amount);
  const bestBank = r.bankOffers?.[0] ?? null;
  const identity = r.identity;
  return `
      <article class="card ${isBest ? 'card-best' : ''}">
        <div class="card-head">
          <div>
            <h3>${escapeHtml(r.name)}</h3>
            ${isBest ? '<span class="best-tag">Best verified</span>' : ''}
          </div>
          <span class="pill ${tierClass(purchase.tier.tier)}">${purchase.tier.label}</span>
        </div>
        <div class="price-row">
          <span class="price">${price ? money.format(price) : '—'}</span>
          ${r.mrp ? `<span class="mrp">M.R.P. ${money.format(r.mrp)}</span>` : ''}
        </div>
        <p class="card-reason ${reason.tone === 'ok' ? 'ok' : 'bad'}"><span class="dot"></span>${reason.text}</p>
        <p class="card-gap">${
          price
            ? gap > 0
              ? `${money.format(gap)} above your ${money.format(target.buyNow)} target`
              : `At or below your ${money.format(target.buyNow)} target`
            : 'Price not available'
        }</p>
        <dl class="facts">
          <div><dt>Delivery</dt><dd>${escapeHtml(r.delivery ?? 'Not shown')}${r.deliveryNote ? `<span class="fact-note">${escapeHtml(r.deliveryNote)}</span>` : ''}</dd></div>
          <div><dt>Seller</dt><dd>${escapeHtml(r.seller ?? 'Not shown')}</dd></div>
          <div><dt>Bank offer</dt><dd>${r.maxBankOffer ? `${money.format(r.maxBankOffer)}${bestBank ? ` · ${escapeHtml(bestBank.bank)}` : ''}<span class="fact-note">eligibility not verified</span>` : 'None listed'}</dd></div>
          <div><dt>Exchange</dt><dd>${r.assumedExchangeValue && r.exchangeAdjustedPrice ? `${money.format(r.exchangeAdjustedPrice)} if you trade in<span class="fact-note">not a discount</span>` : 'Not counted'}</dd></div>
        </dl>
        ${
          Object.keys(bankMap).length
            ? `<p class="bank-estimate" data-banks="${escapeHtml(JSON.stringify(bankMap))}" hidden>
          If your card is eligible: <strong class="bank-estimate-price"></strong> <span>estimate only, not verified</span>
        </p>`
            : ''
        }
        <details class="more">
          <summary>Price history &amp; details</summary>
          <div class="more-body">
            ${chart(entries, `${product.id}-${r.site}`, target.buyNow)}
            <dl class="facts facts-more">
              <div><dt>Trend</dt><dd>${{ down: 'Falling', flat: 'Stable', up: 'Rising' }[trend]}</dd></div>
              <div><dt>Lowest verified</dt><dd>${lowestRecorded ? `${money.format(checkoutOf(lowestRecorded))} · ${istTime(lowestRecorded.checkedAt)} IST` : 'No verified history'}</dd></div>
              <div><dt>Model</dt><dd>${identity ? `${identity.storageMatch === false ? 'Wrong storage' : identity.storageMatch ? '256GB' : 'Storage n/a'} · ${identity.colorMatch === false ? 'Wrong colour' : identity.colorMatch ? 'Mist Blue' : 'Colour n/a'}` : 'Not verified'}</dd></div>
              <div><dt>Cash on delivery</dt><dd>${r.cod === true ? 'Yes' : r.cod === false ? 'No' : 'Not shown'}</dd></div>
              <div><dt>Last verified</dt><dd>${r.verifiedAt ? `${istTime(r.verifiedAt)} IST` : 'Unknown'}${isStale ? ' · stale' : ''}</dd></div>
            </dl>
          </div>
        </details>
        ${siteNote ? `<p class="site-note">${escapeHtml(siteNote)}</p>` : ''}
        <a class="store-link" href="${r.url}" target="_blank" rel="noopener">Open ${escapeHtml(r.name)}</a>
      </article>`;
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

  const bankTotals = new Map();
  for (const result of hydrated) {
    if (result.status !== 'ok') continue;
    for (const offer of result.bankOffersDetailed ?? []) {
      if (offer.kind === 'emi' || !(offer.amount > 0)) continue;
      bankTotals.set(offer.bank, Math.max(bankTotals.get(offer.bank) ?? 0, offer.amount));
    }
  }
  const bankOptions = [...bankTotals.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  const productSections = state
    .map(({ product, sorted, forecast, bestDealId, basisName }) => {
      const best = sorted.find((result) => result.site === bestDealId) ?? null;
      const summaryPrice = best?.checkoutPrice ?? null;
      const summary = best
        ? `Best verified: <strong>${money.format(summaryPrice)}</strong> at ${escapeHtml(best.name)} · ${best.purchase?.tier?.label ?? ''}`
        : 'No verified purchasable offer. Prices shown are advertised only.';
      return `
      <section class="product-block" data-product="${product.id}">
        <div class="section-head">
          <div>
            <h2>${escapeHtml(product.name)}</h2>
            <p>${summary}</p>
          </div>
        </div>
        <div class="cards">
          ${sorted.map((r) => cardHtml(product, r, bestDealId, config, historyEntries)).join('')}
        </div>
        ${forecastHtml(product, forecast, basisName)}
      </section>`;
    })
    .join('\n');

  const tabs = products
    .map(
      (product) =>
        `<button class="tab" type="button" role="tab" data-product="${product.id}" aria-selected="${
          product.primary ? 'true' : 'false'
        }">${escapeHtml(product.shortName)}${product.primary ? '<span class="tab-tag">target</span>' : ''}</button>`
    )
    .join('');

  const historyRows = historyEntries
    .slice(-20)
    .reverse()
    .map((entry) => {
      const price = checkoutOf(entry);
      return `<tr>
        <td>${istTime(entry.checkedAt)}</td>
        <td>${escapeHtml(productOf(entry, products)?.shortName ?? entry.product ?? 'iPhone 17')}</td>
        <td>${escapeHtml(entry.name ?? '')}</td>
        <td>${entry.status === 'ok' ? 'OK' : 'Failed'}</td>
        <td>${price ? money.format(price) : '—'}</td>
      </tr>`;
    })
    .join('');

  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>iPhone Price Monitor</title>
  <style>
    :root {
      --bg: #f4f6fa;
      --card: #ffffff;
      --text: #0f172a;
      --muted: #64748b;
      --line: #e2e8f0;
      --blue: #2563eb;
      --green: #15803d;
      --green-bg: #ecfdf3;
      --amber: #b45309;
      --amber-bg: #fffbeb;
      --red: #b91c1c;
      --red-bg: #fef2f2;
      --radius: 16px;
      --shadow: 0 1px 2px rgba(15, 23, 42, 0.06), 0 8px 24px rgba(15, 23, 42, 0.04);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 28px 18px 48px; background: var(--bg); color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.5; -webkit-font-smoothing: antialiased;
    }
    .wrap { max-width: 1060px; margin: 0 auto; }
    .top { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
    .brand { margin: 0; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--blue); }
    h1 { margin: 4px 0 4px; font-size: 1.9rem; letter-spacing: -0.02em; }
    .sub { margin: 0; color: var(--muted); font-size: 0.95rem; }
    .updated { text-align: right; color: var(--muted); font-size: 0.78rem; line-height: 1.4; }
    .updated strong { display: block; color: var(--text); font-size: 0.95rem; }
    .verdict { border-radius: 20px; padding: 24px; margin-bottom: 20px; background: var(--card); box-shadow: var(--shadow); border: 1px solid var(--line); }
    .verdict-green { background: linear-gradient(180deg, #f0fdf4, #ffffff); border-color: #bbf7d0; }
    .verdict-amber { background: linear-gradient(180deg, #fffbeb, #ffffff); border-color: #fde68a; }
    .verdict-blue { background: linear-gradient(180deg, #eff6ff, #ffffff); border-color: #bfdbfe; }
    .verdict-grey { background: linear-gradient(180deg, #f8fafc, #ffffff); }
    .eyebrow { margin: 0 0 6px; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
    .verdict-title-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .verdict-title { font-size: 2rem; font-weight: 800; letter-spacing: -0.02em; }
    .verdict-action { margin: 6px 0 0; font-size: 1rem; color: var(--text); }
    .verdict-sub { margin: 4px 0 0; font-size: 0.9rem; color: var(--muted); }
    .progress { height: 9px; border-radius: 999px; background: #e8edf5; overflow: hidden; margin-top: 16px; }
    .progress-fill { height: 100%; border-radius: inherit; background: var(--blue); }
    .progress-hit { background: var(--green); }
    .progress-labels { display: flex; justify-content: space-between; gap: 10px; font-size: 0.78rem; color: var(--muted); margin-top: 6px; }
    .verdict-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 18px; }
    .verdict-stats div { background: rgba(255,255,255,0.7); border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; }
    .verdict-stats span { display: block; font-size: 0.72rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
    .verdict-stats strong { display: block; font-size: 1.2rem; margin-top: 2px; }
    .verdict-foot { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-top: 14px; font-size: 0.82rem; color: var(--muted); border-top: 1px solid var(--line); padding-top: 12px; }
    .verdict-note { margin: 10px 0 0; font-size: 0.82rem; color: var(--amber); }
    .pill { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase; white-space: nowrap; }
    .pill-green { background: var(--green-bg); color: var(--green); border: 1px solid #bbf7d0; }
    .pill-amber { background: var(--amber-bg); color: var(--amber); border: 1px solid #fde68a; }
    .pill-blue { background: #eff6ff; color: var(--blue); border: 1px solid #bfdbfe; }
    .pill-grey { background: #f1f5f9; color: var(--muted); border: 1px solid #e2e8f0; }
    .pill-red { background: var(--red-bg); color: var(--red); border: 1px solid #fecaca; }
    .toolbar { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; margin: 22px 0 18px; }
    .tabs { display: flex; gap: 6px; background: #e9eef6; padding: 4px; border-radius: 12px; flex-wrap: wrap; }
    .tab {
      appearance: none; border: 0; background: transparent; color: var(--muted); font-weight: 600; font-size: 0.9rem;
      padding: 8px 14px; border-radius: 9px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
    }
    .tab:hover { color: var(--text); }
    .tab[aria-selected="true"] { background: var(--card); color: var(--text); box-shadow: 0 1px 3px rgba(15, 23, 42, 0.12); }
    .tab-tag { font-size: 0.62rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--amber); background: var(--amber-bg); border-radius: 999px; padding: 2px 6px; }
    .bank-control { display: flex; flex-direction: column; gap: 4px; min-width: 240px; }
    .bank-control label { font-size: 0.72rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
    .bank-control select {
      appearance: none; width: 100%; padding: 9px 36px 9px 12px; border-radius: 10px; border: 1px solid var(--line);
      background: var(--card) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' fill='none' stroke='%2364748b' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 12px center;
      color: var(--text); font-size: 0.9rem; font-weight: 600; cursor: pointer;
    }
    .bank-control select:focus { outline: 2px solid #bfdbfe; border-color: #93c5fd; }
    .hint { margin: 0; font-size: 0.72rem; color: var(--muted); }
    .product-block.hidden { display: none; }
    .section-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; flex-wrap: wrap; margin: 0 0 14px; }
    .section-head h2 { margin: 0; font-size: 1.35rem; letter-spacing: -0.01em; }
    .section-head p { margin: 3px 0 0; font-size: 0.86rem; color: var(--muted); }
    .cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 18px; box-shadow: var(--shadow); display: flex; flex-direction: column; gap: 10px; }
    .card-best { border-color: #86efac; box-shadow: 0 0 0 1px #86efac, var(--shadow); }
    .card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
    .card-head h3 { margin: 0; font-size: 1.05rem; }
    .best-tag { display: inline-block; margin-top: 4px; font-size: 0.66rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--green); }
    .price-row { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
    .price { font-size: 1.9rem; font-weight: 800; letter-spacing: -0.02em; }
    .mrp { font-size: 0.8rem; color: var(--muted); }
    .price-note { font-size: 0.78rem; color: var(--muted); }
    .card-reason { display: flex; align-items: flex-start; gap: 8px; margin: 0; font-size: 0.88rem; font-weight: 600; }
    .card-reason .dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; flex: none; }
    .card-reason.ok { color: var(--green); }
    .card-reason.ok .dot { background: var(--green); }
    .card-reason.bad { color: var(--red); }
    .card-reason.bad .dot { background: var(--red); }
    .card-gap { margin: -4px 0 0; font-size: 0.82rem; color: var(--muted); }
    .facts { margin: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 10px 16px; }
    .facts div { min-width: 0; }
    .facts dt { font-size: 0.68rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted); }
    .facts dd { margin: 2px 0 0; font-size: 0.86rem; font-weight: 500; overflow-wrap: anywhere; }
    .fact-note { display: block; font-size: 0.72rem; color: var(--muted); font-weight: 400; }
    .facts-more { margin-top: 12px; }
    .bank-estimate { margin: 0; padding: 8px 10px; border-radius: 10px; background: var(--green-bg); border: 1px solid #bbf7d0; font-size: 0.84rem; color: var(--green); }
    .bank-estimate span { color: var(--muted); font-size: 0.74rem; }
    .more { border-top: 1px solid var(--line); padding-top: 10px; }
    .more summary { cursor: pointer; font-size: 0.84rem; font-weight: 600; color: var(--blue); list-style: none; display: flex; align-items: center; gap: 6px; }
    .more summary::-webkit-details-marker { display: none; }
    .more summary::before { content: "+"; font-weight: 700; }
    .more[open] summary::before { content: "−"; }
    .more-body { padding-top: 12px; }
    .site-note { margin: 0; font-size: 0.76rem; color: var(--muted); }
    .store-link {
      margin-top: auto; display: block; text-align: center; text-decoration: none; font-weight: 700; font-size: 0.88rem;
      color: #fff; background: var(--blue); padding: 10px 14px; border-radius: 10px;
    }
    .store-link:hover { background: #1d4ed8; }
    .panel { margin-top: 18px; background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); }
    .panel summary { cursor: pointer; padding: 14px 18px; display: flex; justify-content: space-between; align-items: center; gap: 10px; font-weight: 700; list-style: none; flex-wrap: wrap; }
    .panel summary::-webkit-details-marker { display: none; }
    .panel summary::before { content: "+"; font-weight: 700; color: var(--blue); margin-right: 4px; }
    .panel[open] summary::before { content: "−"; }
    .panel summary > span:first-child { margin-right: auto; }
    .summary-meta { font-size: 0.76rem; font-weight: 600; color: var(--muted); }
    .panel-body { padding: 0 18px 18px; }
    .panel-lead { margin: 0 0 12px; color: var(--muted); font-size: 0.88rem; }
    .stat-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; margin-bottom: 14px; }
    .stat-grid div { background: #f8fafc; border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; }
    .stat-grid span { display: block; font-size: 0.66rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
    .stat-grid strong { font-size: 0.95rem; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 0.84rem; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 700; }
    h4 { margin: 16px 0 8px; font-size: 0.92rem; }
    .tiny { margin: 10px 0 0; font-size: 0.74rem; color: var(--muted); }
    .chart-wrap { position: relative; margin: 4px 0 2px; }
    .chart-wrap svg { display: block; width: 100%; height: auto; }
    .chart-line { fill: none; stroke: var(--blue); stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
    [data-variant="down"] .chart-line { stroke: var(--green); }
    [data-variant="up"] .chart-line { stroke: var(--red); }
    [data-variant="down"] .chart-fill-hi, [data-variant="down"] .chart-fill-lo { stop-color: var(--green); }
    [data-variant="up"] .chart-fill-hi, [data-variant="up"] .chart-fill-lo { stop-color: var(--red); }
    .chart-area { opacity: 1; }
    .chart-grid { stroke: #e2e8f0; stroke-width: 1; stroke-dasharray: 3 4; }
    .chart-dot { stroke: #fff; stroke-width: 1.5; }
    .chart-dot-lo { fill: var(--green); }
    .chart-dot-hi { fill: var(--red); }
    .chart-target { stroke: var(--amber); stroke-width: 1.2; stroke-dasharray: 4 3; }
    .chart-cross { stroke: #94a3b8; stroke-width: 1; stroke-dasharray: 2 3; }
    .chart-hover-dot { fill: var(--blue); stroke: #fff; stroke-width: 1.5; }
    .chart-axis { display: flex; justify-content: space-between; font-size: 0.68rem; color: var(--muted); margin-top: 4px; }
    .chart-note { margin: 4px 0 0; font-size: 0.72rem; color: var(--amber); }
    .chart-tip {
      position: absolute; pointer-events: none; opacity: 0; z-index: 5; transform: translate(-50%, calc(-100% - 12px));
      background: #0f172a; color: #fff; border-radius: 8px; padding: 6px 9px; font-size: 0.72rem; line-height: 1.35; white-space: nowrap;
      box-shadow: 0 6px 18px rgba(15, 23, 42, 0.25); transition: opacity 0.12s ease;
    }
    .chart-wrap:hover .chart-tip { opacity: 1; }
    .chart-tip .tip-price { font-weight: 700; }
    .chart-tip .tip-down { color: #86efac; }
    .chart-tip .tip-up { color: #fca5a5; }
    .how { margin-top: 18px; }
    .how ul { margin: 0; padding-left: 18px; color: var(--muted); font-size: 0.84rem; display: grid; gap: 6px; }
    .footer { margin-top: 18px; font-size: 0.74rem; color: var(--muted); text-align: center; }
    .market-panel { position: relative; margin: 18px 0; padding: 20px 22px; background: var(--card); border: 1px solid var(--line); border-radius: 18px; box-shadow: var(--shadow); }
    .market-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
    .market-head h2 { margin: 2px 0 0; font-size: 1.15rem; }
    .market-legend { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px 14px; color: var(--muted); font-size: 0.75rem; }
    .market-legend span { display: inline-flex; align-items: center; gap: 6px; }
    .market-legend i { width: 9px; height: 9px; border-radius: 50%; }
    .market-svg { width: 100%; height: auto; margin-top: 12px; overflow: visible; }
    .market-axis { stroke: #d8e0ec; stroke-width: 1; }
    .market-target { stroke: #f59e0b; stroke-width: 1.5; stroke-dasharray: 6 5; }
    .market-label, .market-target-label { fill: var(--muted); font-size: 11px; }
    .market-target-label { fill: #b45309; font-weight: 700; }
    .market-cross { stroke: #64748b; stroke-width: 1; stroke-dasharray: 3 3; pointer-events: none; }
    .market-point { cursor: crosshair; stroke: #fff; stroke-width: 1.5; transition: r 0.12s ease; }
    .market-point:hover, .market-point:focus { r: 6; outline: none; }
    .market-tip { position: absolute; z-index: 8; transform: translate(-50%, calc(-100% - 10px)); background: #0f172a; color: #fff; border-radius: 8px; padding: 7px 10px; font-size: 0.75rem; line-height: 1.4; white-space: nowrap; pointer-events: none; box-shadow: 0 8px 24px rgba(15,23,42,.24); }
    .market-dates { display: flex; justify-content: space-between; padding-left: 72px; color: var(--muted); font-size: 0.72rem; }
    .market-empty { color: var(--muted); margin: 14px 0 0; }
    @media (max-width: 720px) {
      body { padding: 16px 12px 32px; }
      h1 { font-size: 1.5rem; }
      .updated { text-align: left; }
      .verdict { padding: 18px; }
      .verdict-title { font-size: 1.6rem; }
      .verdict-stats { grid-template-columns: 1fr 1fr; }
      .verdict-stats div:last-child { grid-column: span 2; }
      .cards { grid-template-columns: 1fr; }
      .stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .toolbar { align-items: stretch; }
      .tabs { width: 100%; }
      .tab { flex: 1; justify-content: center; }
      .bank-control { width: 100%; }
      .facts { grid-template-columns: 1fr; }
      .market-panel { padding: 16px 12px; }
      .market-head { display: block; }
      .market-legend { justify-content: flex-start; margin-top: 10px; }
      .market-dates { padding-left: 42px; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="top">
      <div>
        <p class="brand">Price Monitor</p>
        <h1>Should you buy the iPhone 17 yet?</h1>
        <p class="sub">iPhone 17 256GB Mist Blue · buy target ${money.format(targetFor(config, 'iphone17').buyNow)} · pincode ${config.pincode}</p>
      </div>
      <div class="updated">Last checked<strong>${istTime(now)} IST</strong>Prices without exchange or bank offers</div>
    </header>

    ${heroHtml(state[0].product, state[0].sorted, state[0].forecast, historyEntries, config, state[0].basisName, state[0].basisSite, now)}

    ${marketChart(state[0].product, historyEntries, targetFor(config, state[0].product.id), config.pincode)}

    <div class="toolbar">
      <div class="tabs" role="tablist" aria-label="Choose a phone">
        ${tabs}
      </div>
      ${
        bankOptions.length
          ? `<div class="bank-control">
        <label for="bank-select">Bank offer</label>
        <select id="bank-select">
          <option value="">No bank offer</option>
          ${bankOptions
            .map(([bank, amount]) => `<option value="${escapeHtml(bank)}">${escapeHtml(bank)} — up to ${money.format(amount)} off</option>`)
            .join('')}
        </select>
        <p class="hint" id="bank-hint">Optional estimate only — verdicts stay based on the real price.</p>
      </div>`
          : ''
      }
    </div>

    ${productSections}

    <details class="panel how">
      <summary>How to read this page</summary>
      <div class="panel-body">
        <ul>
          <li><strong>Buyable</strong> means all checks pass: correct model, 256GB storage, Mist Blue colour, in stock, and delivery to pincode ${config.pincode} verified.</li>
          <li><strong>Wait / Keep watching / Strong deal / Buy now</strong> use each phone's own checkout target, without exchange or unverified bank offers.</li>
          <li>A historical low counts only when the exact phone was in stock and deliverable to ${config.pincode}. It means lowest verified since tracking began, not an all-time market claim.</li>
          <li>Bank offers are optional estimates and are never used for verdicts or alerts. Exchange value is never treated as a discount.</li>
          <li>Data is refreshed automatically by a price check roughly every 30 minutes. Reload this page to see the latest.</li>
        </ul>
      </div>
    </details>

    <details class="panel how">
      <summary>Recent checks</summary>
      <div class="panel-body table-wrap">
        <table>
          <thead><tr><th>Time (IST)</th><th>Phone</th><th>Store</th><th>Status</th><th>Checkout</th></tr></thead>
          <tbody>${historyRows}</tbody>
        </table>
      </div>
    </details>

    <p class="footer">Prices are checked automatically and may change. Always confirm on the store page before buying.</p>
  </div>

  <script>
    (function () {
      document.querySelectorAll('.market-panel').forEach(function (panel) {
        var svg = panel.querySelector('.market-svg');
        var tip = panel.querySelector('.market-tip');
        var cross = panel.querySelector('.market-cross');
        var points = Array.prototype.slice.call(panel.querySelectorAll('.market-point'));
        if (!svg || !tip) return;
        var show = function (point) {
          var svgRect = svg.getBoundingClientRect();
          var panelRect = panel.getBoundingClientRect();
          var cx = Number(point.getAttribute('cx'));
          var cy = Number(point.getAttribute('cy'));
          var price = Number(point.getAttribute('data-price'));
          var date = new Date(point.getAttribute('data-date')).toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'
          });
          tip.innerHTML = '<strong>' + point.getAttribute('data-site') + ' · ₹' + price.toLocaleString('en-IN') + '</strong><br>' + date + ' IST';
          tip.style.left = (svgRect.left - panelRect.left + (cx / 920) * svgRect.width) + 'px';
          tip.style.top = (svgRect.top - panelRect.top + (cy / 220) * svgRect.height) + 'px';
          tip.hidden = false;
          if (cross) {
            cross.setAttribute('x1', cx);
            cross.setAttribute('x2', cx);
            cross.hidden = false;
          }
        };
        var showNearest = function (clientX, clientY) {
          if (!points.length) return;
          var rect = svg.getBoundingClientRect();
          var vx = ((clientX - rect.left) / rect.width) * 920;
          var vy = ((clientY - rect.top) / rect.height) * 220;
          var nearest = points[0];
          var bestDistance = Infinity;
          points.forEach(function (point) {
            var dx = Number(point.getAttribute('cx')) - vx;
            var dy = Number(point.getAttribute('cy')) - vy;
            var distance = dx * dx + dy * dy;
            if (distance < bestDistance) { bestDistance = distance; nearest = point; }
          });
          show(nearest);
        };
        points.forEach(function (point) {
          point.addEventListener('mouseenter', function () { show(point); });
          point.addEventListener('focus', function () { show(point); });
          point.addEventListener('click', function () { show(point); });
          point.addEventListener('blur', function () { tip.hidden = true; });
        });
        svg.addEventListener('mousemove', function (event) { showNearest(event.clientX, event.clientY); });
        svg.addEventListener('click', function (event) { showNearest(event.clientX, event.clientY); });
        svg.addEventListener('touchstart', function (event) {
          if (event.touches[0]) showNearest(event.touches[0].clientX, event.touches[0].clientY);
        }, { passive: true });
        svg.addEventListener('mouseleave', function () {
          tip.hidden = true;
          if (cross) cross.hidden = true;
        });
      });
    })();

    (function () {
      var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
      var blocks = Array.prototype.slice.call(document.querySelectorAll('.product-block'));
      var bankSelect = document.getElementById('bank-select');
      var bankHint = document.getElementById('bank-hint');
      var active = '';

      function visibleBankRows() {
        var block = document.querySelector('.product-block:not(.hidden)');
        if (!block) return [];
        return Array.prototype.slice.call(block.querySelectorAll('.bank-estimate')).filter(function (row) {
          return !row.hidden;
        });
      }

      function applyBank() {
        var bank = bankSelect ? bankSelect.value : '';
        var rows = Array.prototype.slice.call(document.querySelectorAll('.bank-estimate'));
        rows.forEach(function (row) {
          var map = {};
          try { map = JSON.parse(row.getAttribute('data-banks') || '{}'); } catch (e) {}
          var amount = bank ? map[bank] : null;
          var card = row.closest('.card');
          var priceEl = card ? card.querySelector('.price') : null;
          var price = priceEl ? Number(priceEl.textContent.replace(/[^0-9]/g, '')) : 0;
          if (!amount || !price) { row.hidden = true; return; }
          row.hidden = false;
          var valueEl = row.querySelector('.bank-estimate-price');
          if (valueEl) valueEl.textContent = '₹' + Math.max(0, price - amount).toLocaleString('en-IN');
        });
        if (bankHint) {
          if (!bank) {
            bankHint.textContent = 'Optional estimate only — verdicts stay based on the real price.';
          } else {
            bankHint.textContent = visibleBankRows().length
              ? 'Estimate shown on eligible cards only. Not verified.'
              : 'No listed offer for this bank on this phone.';
          }
        }
      }

      function applyProduct(id) {
        active = id;
        tabs.forEach(function (tab) {
          tab.setAttribute('aria-selected', tab.getAttribute('data-product') === id ? 'true' : 'false');
        });
        blocks.forEach(function (block) {
          block.classList.toggle('hidden', block.getAttribute('data-product') !== id);
        });
        applyBank();
      }

      var saved = '';
      try { saved = localStorage.getItem('priceProduct') || ''; } catch (e) {}
      if (!tabs.some(function (tab) { return tab.getAttribute('data-product') === saved; })) {
        var primary = tabs.filter(function (tab) { return tab.getAttribute('aria-selected') === 'true'; })[0];
        saved = primary ? primary.getAttribute('data-product') : (tabs[0] ? tabs[0].getAttribute('data-product') : '');
      }
      tabs.forEach(function (tab) {
        tab.addEventListener('click', function () {
          var id = tab.getAttribute('data-product');
          applyProduct(id);
          try { localStorage.setItem('priceProduct', id); } catch (e) {}
        });
      });
      if (bankSelect) {
        var savedBank = '';
        try { savedBank = localStorage.getItem('bankOffer') || ''; } catch (e) {}
        if (Array.prototype.some.call(bankSelect.options, function (option) { return option.value === savedBank; })) {
          bankSelect.value = savedBank;
        }
        bankSelect.addEventListener('change', function () {
          applyBank();
          try { localStorage.setItem('bankOffer', bankSelect.value); } catch (e) {}
        });
      }
      applyProduct(saved);
    })();

    (function () {
      var W = 320, H = 100;
      var fmt = function (value) { return '₹' + value.toLocaleString('en-IN'); };
      document.querySelectorAll('.chart-wrap').forEach(function (wrap) {
        var svg = wrap.querySelector('svg');
        var tip = wrap.querySelector('.chart-tip');
        var cross = wrap.querySelector('.chart-cross');
        var dot = wrap.querySelector('.chart-hover-dot');
        var pts = [];
        try { pts = JSON.parse(wrap.getAttribute('data-points').replace(/&quot;/g, '"')); } catch (e) { return; }
        if (!pts.length) return;
        var first = pts[0][2];
        var show = function (clientX) {
          var rect = svg.getBoundingClientRect();
          var vx = ((clientX - rect.left) / rect.width) * W;
          var best = pts[0];
          for (var i = 0; i < pts.length; i += 1) {
            if (Math.abs(pts[i][0] - vx) < Math.abs(best[0] - vx)) best = pts[i];
          }
          cross.setAttribute('x1', best[0]);
          cross.setAttribute('x2', best[0]);
          cross.style.display = '';
          dot.setAttribute('cx', best[0]);
          dot.setAttribute('cy', best[1]);
          dot.style.display = '';
          var delta = best[2] - first;
          var pct = first ? ((delta / first) * 100).toFixed(1) : '0';
          var dateStr = new Date(best[3]).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
          tip.innerHTML =
            '<div class="tip-price">' + fmt(best[2]) + '</div>' +
            '<div>' + dateStr + ' IST</div>' +
            (delta === 0
              ? '<div>start point</div>'
              : '<div class="' + (delta < 0 ? 'tip-down' : 'tip-up') + '">' +
                (delta < 0 ? '▼ ' : '▲ ') + fmt(Math.abs(delta)) + ' (' + pct + '%)</div>');
          var wrapRect = wrap.getBoundingClientRect();
          var left = Math.min(92, Math.max(8, (((best[0] / W) * rect.width + rect.left - wrapRect.left) / wrapRect.width) * 100));
          var top = (((best[1] / H) * rect.height + rect.top - wrapRect.top) / wrapRect.height) * 100;
          tip.style.left = left + '%';
          tip.style.top = top + '%';
        };
        wrap.addEventListener('mousemove', function (e) { show(e.clientX); });
        wrap.addEventListener('mouseleave', function () {
          tip.style.display = 'none';
          cross.style.display = 'none';
          dot.style.display = 'none';
        });
        wrap.addEventListener('mouseenter', function () { tip.style.display = ''; });
        wrap.addEventListener('touchstart', function (e) {
          if (e.touches[0]) show(e.touches[0].clientX);
        }, { passive: true });
      });
    })();
  </script>
</body>
</html>`;

  await writeFile(path.join(root, 'dashboard.html'), htmlContent, 'utf8');

  const mdLines = [
    `# iPhone Price Monitor`,
    `**Primary target:** iPhone 17 256GB Mist Blue ≤ ${money.format(targetFor(config, 'iphone17').buyNow)} checkout (no exchange) | **Pincode:** \`${config.pincode}\` | **Updated:** ${istTime(now)} IST`,
  ];

  for (const { product, sorted, forecast, bestDealId, basisName } of state) {
    const productTarget = targetFor(config, product.id);
    mdLines.push(
      ``,
      `## ${product.name}`,
      ``,
      `| Site | Tier | Buyable | Checkout | M.R.P. | Bank offer (unverified) | Delivery | Verified (IST) |`,
      `| --- | --- | --- | --- | --- | --- | --- | --- |`,
    );
    sorted.forEach((r) => {
      if (r.status === 'error') {
        mdLines.push(`| [**${r.name}**](${r.url}) | — | ❌ Error | last known: see dashboard | — | — | — | — |`);
      } else {
        const purchase = r.purchase ?? {};
        const checkout = checkoutOf(r);
        mdLines.push(
          `| [**${r.name}**](${r.url}) | ${purchase.tier?.label ?? 'UNKNOWN'}${r.site === bestDealId ? ' ★' : ''} | ${purchase.purchasable ? '✅ Yes' : `❌ ${blockerText(r, config)}`} | **${checkout ? money.format(checkout) : '—'}** | ${r.mrp ? money.format(r.mrp) : '—'} | ${r.maxBankOffer ? money.format(r.maxBankOffer) : '—'} | ${r.delivery ?? '—'} | ${r.verifiedAt ? istTime(r.verifiedAt) : istTime(r.checkedAt)} |`
        );
      }
    });

    mdLines.push(
      ``,
      `### Forecast`,
      `- Level: **${forecast.label}** · Confidence: **${forecast.confidence}** · Observations: ${forecast.stats.count} over ${forecast.stats.uniqueDays} unique days`,
      `- Basis: verified **${basisName}** checkout prices only (stores that cannot deliver are excluded)`,
      `- ${forecast.message}`
    );
    const lifetimeLow = lifetimeLowFor(historyEntries, product.id);
    if (lifetimeLow) {
      const lowPrice = checkoutOf(lifetimeLow);
      mdLines.push(
        `- Lowest verified since tracking began: **${money.format(lowPrice)}** at ${lifetimeLow.name} (${istDate(lifetimeLow.checkedAt)}) — ${
          lowPrice > productTarget.buyNow ? `${money.format(lowPrice - productTarget.buyNow)} above target` : 'target reached'
        }`
      );
    }
    const siteNotes = product.sites.filter((site) => site.note);
    if (siteNotes.length) {
      mdLines.push(`- Store notes:`);
      for (const site of siteNotes) mdLines.push(`  - **${site.name}:** ${site.note}`);
    }
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
