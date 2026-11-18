import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const money = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

const pctStr = (pct) => `${(pct * 100).toFixed(1).replace(/\.0$/, '')}%`;

const istTime = (iso) =>
  new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

const istDate = (value) =>
  new Date(value).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });

const productOf = (entry, products) =>
  products.find((product) => product.id === (entry.product ?? 'iphone17')) ?? null;

const lastKnownGood = (historyEntries, productId, siteId) =>
  [...historyEntries]
    .reverse()
    .find((entry) => (entry.product ?? 'iphone17') === productId && entry.site === siteId && entry.status === 'ok' && entry.effectivePrice);

const historyForSite = (historyEntries, productId, siteId, limit = 24) =>
  historyEntries
    .filter((entry) => (entry.product ?? 'iphone17') === productId && entry.site === siteId && entry.status === 'ok' && entry.effectivePrice)
    .slice(-limit);

const trendOf = (entries) => {
  if (entries.length < 4) return 'flat';
  const half = Math.floor(entries.length / 2);
  const avg = (list) => list.reduce((sum, e) => sum + e.effectivePrice, 0) / list.length;
  const older = avg(entries.slice(0, half));
  const newer = avg(entries.slice(half));
  if (newer < older - 300) return 'down';
  if (newer > older + 300) return 'up';
  return 'flat';
};

// Interactive chart: time-based x-axis, monotone-cubic smoothing (no overshoot on
// flat plateaus), padded y-domain so flat series still render mid-chart, animated
// draw-in, min/max dots, axis dates and hover crosshair + tooltip. Inline, no deps.
const chart = (entries, id) => {
  const values = entries.map((entry) => entry.effectivePrice);
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

const bestBuyable = (results) =>
  results
    .filter((r) => r.status === 'ok' && r.deliverable !== false && r.effectivePrice)
    .sort((a, b) => a.effectivePrice - b.effectivePrice)[0] ?? null;

const lowestListRecorded = (historyEntries) => {
  const ok = historyEntries.filter((entry) => entry.status === 'ok' && entry.listPrice);
  return ok.length ? Math.min(...ok.map((entry) => entry.listPrice)) : null;
};

// Self-learning: once a sale window has started, the actual lowest list price recorded
// during the window calibrates the drop estimate. Recorded history is the memory —
// no config edits needed. Guesses only apply until real sale data exists.
const learnedSaleData = (historyEntries, sale) => {
  if (sale.active === false && sale.daysAway > 0) return null;
  const windowEnd = sale.active ? Date.now() : sale.end.getTime();
  const inWindow = historyEntries.filter(
    (entry) => entry.status === 'ok' && entry.listPrice &&
      new Date(entry.checkedAt).getTime() >= sale.start.getTime() &&
      new Date(entry.checkedAt).getTime() <= windowEnd,
  );
  if (!inWindow.length) return null;
  const observedMinList = Math.min(...inWindow.map((entry) => entry.listPrice));
  const before = historyEntries.filter(
    (entry) => entry.status === 'ok' && entry.listPrice &&
      new Date(entry.checkedAt).getTime() < sale.start.getTime(),
  );
  const baseline = before.length ? Math.min(...before.map((entry) => entry.listPrice)) : null;
  const observedDropPct = baseline && baseline > observedMinList ? 1 - observedMinList / baseline : null;
  return { observedMinList, baseline, observedDropPct, samples: inWindow.length };
};

// Sales analyser: computes expected drop, predicted net, and a worth-waiting verdict.
const analyseSales = (product, historyEntries, results, saleState) => {
  const best = bestBuyable(results);
  const currentBestNet = best ? (best.netWithExchange ?? best.effectivePrice) : null;
  const currentBestList = best?.listPrice ?? null;
  const floorList = lowestListRecorded(historyEntries);
  const threshold = product.worthWaitingSavings ?? 4000;

  const analysed = saleState.all.map((sale) => {
    const learned = learnedSaleData(historyEntries, sale);

    let expectedList;
    if (learned?.observedMinList) {
      // Real sale data exists — the observed price IS ground truth. Never compound the
      // learned drop % on top of it (that would double-count the discount).
      expectedList = [sale.expectedListPrice, learned.observedMinList]
        .filter((value) => value)
        .sort((a, b) => a - b)[0];
    } else {
      // No sale-window data yet — predict from the configured drop % off the recorded floor.
      const fromDrop = floorList && sale.historicalDropPct
        ? Math.round((floorList * (1 - sale.historicalDropPct)) / 100) * 100
        : null;
      expectedList = [sale.expectedListPrice, fromDrop, currentBestList]
        .filter((value) => value)
        .sort((a, b) => a - b)[0] ?? sale.expectedListPrice;
    }

    // Predicted net subtracts only instant (full-payment) bank offers — EMI-only offers don't reduce the price you pay upfront.
    const bank = best?.maxBankOffer && best.bankOfferKind !== 'emi' ? best.maxBankOffer : 0;
    const exchange = best?.exchangeAvailable ? (product.assumedExchangeValue ?? 0) : 0;
    const predictedNet = expectedList - bank - exchange;
    const savings = currentBestNet ? currentBestNet - predictedNet : null;

    let verdict;
    if (sale.active) {
      verdict = { kind: 'live', text: 'LIVE NOW — buy if net hits your target' };
    } else if (savings === null) {
      verdict = { kind: 'unknown', text: 'No baseline yet' };
    } else if (savings >= threshold) {
      verdict = { kind: 'worth', text: `WORTH WAITING — saves ~${money.format(savings)}` };
    } else if (savings >= 1000) {
      verdict = { kind: 'marginal', text: `MARGINAL — saves ~${money.format(savings)}` };
    } else {
      verdict = { kind: 'now', text: `NOT WORTH WAITING — current price already better (sale saves ~${money.format(savings)})` };
    }

    return { ...sale, expectedList, predictedNet, savings, verdict, learned };
  });

  return {
    best,
    currentBestNet,
    threshold,
    active: analysed.filter((sale) => sale.active),
    upcoming: analysed.filter((sale) => !sale.active).sort((a, b) => a.start - b.start),
    all: analysed,
  };
};

const recommendationFor = (result, analysis, product) => {
  if (result.status !== 'ok' || !result.effectivePrice) return null;
  const net = result.netWithExchange ?? result.effectivePrice;
  const targetNet = result.targets?.netWithExchange;
  if (net && targetNet && net <= targetNet) {
    return { kind: 'buy', text: `BUY NOW — net ${money.format(net)} meets target ${money.format(targetNet)}` };
  }
  const upcomingWorth = analysis.upcoming.filter((sale) => sale.verdict.kind === 'worth');
  const active = analysis.active[0];
  if (active) {
    return {
      kind: 'watch',
      text: `SALE LIVE: ${active.name} — predicted net ~${money.format(active.predictedNet)}. ${active.note}`,
    };
  }
  if (upcomingWorth.length) {
    const sale = upcomingWorth[0];
    const when = sale.daysAway > 0 ? `in ${sale.daysAway} days` : 'soon';
    return {
      kind: 'wait',
      text: `WAIT — ${sale.name} starts ${when}; predicted net ~${money.format(sale.predictedNet)} (saves ~${money.format(sale.savings)})`,
    };
  }
  if (analysis.upcoming.length) {
    const sale = analysis.upcoming[0];
    return {
      kind: 'buy',
      text: `BUY NOW — upcoming ${sale.name} unlikely to beat this (predicted net ~${money.format(sale.predictedNet)} vs current ${money.format(net)})`,
    };
  }
  return { kind: 'wait', text: 'No sale windows configured — buy if price drops below target' };
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

  // Per-product analysis state
  const state = products.map((product) => {
    const productResults = results.filter((r) => r.product === product.id);
    const saleState = saleCalendarState(product.saleCalendar, now);
    const analysis = analyseSales(product, historyEntries, productResults, saleState);
    const sorted = [...productResults].sort((a, b) => {
      const deliverableA = a.status === 'ok' && a.deliverable !== false && a.effectivePrice;
      const deliverableB = b.status === 'ok' && b.deliverable !== false && b.effectivePrice;
      if (deliverableA && !deliverableB) return -1;
      if (!deliverableA && deliverableB) return 1;
      if (!deliverableA && !deliverableB) return 0;
      return a.effectivePrice - b.effectivePrice;
    });
    const bestDealId = sorted.find(
      (r) => r.status === 'ok' && r.deliverable !== false && r.effectivePrice
    )?.site;
    return { product, results: productResults, analysis, sorted, bestDealId };
  });

  // Price-drop banner: biggest drop vs the previous recorded ok scrape for each site.
  const drops = [];
  for (const { product } of state) {
    for (const r of results.filter((res) => res.product === product.id && res.status === 'ok' && res.effectivePrice)) {
      const siteHistory = historyForSite(historyEntries, product.id, r.site, 2);
      const previous = siteHistory.length >= 2 ? siteHistory[siteHistory.length - 2] : null;
      if (previous && previous.effectivePrice > r.effectivePrice) {
        drops.push({
          product: product.shortName,
          site: r.name,
          amount: previous.effectivePrice - r.effectivePrice,
          current: r.effectivePrice,
          was: previous.effectivePrice,
        });
      }
    }
  }
  const topDrop = drops.sort((a, b) => b.amount - a.amount)[0] ?? null;

  // Global banner: live sale of the primary product, else next worth-waiting sale, else top drop.
  const primary = state[0];
  const bannerHtml = primary.analysis.active.length
    ? `<div class="banner banner-sale">🔥 SALE LIVE: ${primary.analysis.active.map((sale) => sale.name).join(', ')} — ${primary.product.shortName} predicted net ~${money.format(primary.analysis.active[0].predictedNet)}. ${primary.analysis.active[0].note}</div>`
    : primary.analysis.upcoming.length
      ? `<div class="banner banner-info">${primary.analysis.upcoming[0].verdict.kind === 'worth' ? '💰' : '⏳'} ${primary.analysis.upcoming[0].name} starts ${istTime(primary.analysis.upcoming[0].start.toISOString())} (${primary.analysis.upcoming[0].daysAway} days) — ${primary.product.shortName} predicted net ~${money.format(primary.analysis.upcoming[0].predictedNet)} · <strong>${primary.analysis.upcoming[0].verdict.text}</strong></div>`
      : '';

  const dropBannerHtml = topDrop
    ? `<div class="banner banner-drop">🔻 Biggest recent drop: <strong>${topDrop.product} @ ${topDrop.site}</strong> ${money.format(topDrop.was)} → <strong>${money.format(topDrop.current)}</strong> (−${money.format(topDrop.amount)})</div>`
    : '';

  const cardHtml = (product, r, analysis, bestDealId) => {
    if (r.status === 'error') {
      const lastGood = lastKnownGood(historyEntries, product.id, r.site);
      return `
          <div class="card">
            <div>
              <div class="card-header">
                <span class="card-title">${r.name}</span>
                <span class="badge badge-error">ERROR</span>
              </div>
              <p style="color:var(--error); font-size:0.9rem;">${r.error}</p>
              ${
                lastGood
                  ? `
              <div class="price-main">${money.format(lastGood.effectivePrice)}</div>
              <div class="price-sub">Last known good scrape: <strong>${istTime(lastGood.checkedAt)}</strong> IST</div>
              <div class="detail-row"><span class="detail-label">List Price</span><span class="detail-value">${lastGood.listPrice ? money.format(lastGood.listPrice) : 'N/A'}</span></div>
              <div class="detail-row"><span class="detail-label">Best Bank Offer</span><span class="detail-value">${lastGood.maxBankOffer ? money.format(lastGood.maxBankOffer) : 'None'}</span></div>
              <div class="detail-row"><span class="detail-label">Net w/ Exchange</span><span class="detail-value" style="color:var(--success); font-weight:700;">${lastGood.netWithExchange ? money.format(lastGood.netWithExchange) : 'N/A'}</span></div>
              <div class="detail-row"><span class="detail-label">Delivery</span><span class="detail-value">${lastGood.delivery ?? 'N/A'}</span></div>`
                  : '<p style="color:var(--muted); font-size:0.9rem;">No successful scrape recorded yet.</p>'
              }
            </div>
            <a href="${r.url}" target="_blank" class="btn">View Store</a>
          </div>`;
    }

    const entries = historyForSite(historyEntries, product.id, r.site);
    const trend = trendOf(entries);
    const lowestRecorded = entries.length
      ? entries.reduce((min, entry) => (entry.effectivePrice < min.effectivePrice ? entry : min))
      : null;
    const rec = recommendationFor(r, analysis, product);
    const deliverable = r.deliverable !== false;
    const targetNet = r.targets?.netWithExchange ?? null;
    const netNow = r.netWithExchange ?? r.effectivePrice;
    const targetReached = Boolean(targetNet && netNow && netNow <= targetNet);
    const targetGap = targetNet && netNow ? netNow - targetNet : null;
    const targetPct = targetNet && netNow ? Math.max(4, Math.min(100, Math.round((targetNet / netNow) * 100))) : null;

    return `
        <div class="card ${r.site === bestDealId ? 'card-best' : ''}">
          <div>
            <div class="card-header">
              <span class="card-title">${r.name}</span>
              <span>
                ${r.site === bestDealId ? '<span class="badge badge-best">★ BEST DEAL</span>' : ''}
                <span class="badge ${deliverable ? 'badge-ok' : 'badge-error'}">${deliverable ? 'BUYABLE' : 'NOT DELIVERABLE'}</span>
              </span>
            </div>
            <div class="price-main">${money.format(r.effectivePrice)}</div>
            <div class="price-sub">List: ${money.format(r.listPrice)} | Trend: ${trendIcon[trend]}${
              lowestRecorded && lowestRecorded.effectivePrice < r.effectivePrice
                ? ` | Lowest recorded: <span class="low-record">${money.format(lowestRecorded.effectivePrice)}</span> on ${istTime(lowestRecorded.checkedAt)}`
                : ''
            }</div>
            ${chart(entries, `${product.id}-${r.site}`)}
            ${rec ? `<div class="rec rec-${rec.kind}">${rec.kind === 'buy' ? '🟢' : rec.kind === 'watch' ? '🟡' : '🔵'} ${rec.text}</div>` : ''}
            ${
              targetNet
                ? `
            <div class="target-block">
              <div class="target-label"><span>Your target: ${money.format(targetNet)}</span><span>${targetReached ? '✓ hit' : `${money.format(targetGap)} away`}</span></div>
              <div class="target-bar"><div class="target-fill ${targetReached ? 'hit' : ''}" style="width:${targetPct}%"></div></div>
            </div>`
                : ''
            }
            <div class="detail-row"><span class="detail-label">Net w/ Exchange</span><span class="detail-value" style="color:var(--success); font-weight:700;">${r.netWithExchange ? money.format(r.netWithExchange) : 'N/A'}</span></div>
            <div class="detail-row"><span class="detail-label">Best Bank Offer</span><span class="detail-value">${r.maxBankOffer ? money.format(r.maxBankOffer) : 'None'}</span></div>
            <div class="detail-row"><span class="detail-label">Exchange Ceiling</span><span class="detail-value">${r.exchangeCeiling ? money.format(r.exchangeCeiling) : 'N/A'}</span></div>
            <div class="detail-row"><span class="detail-label">Seller</span><span class="detail-value">${r.seller ?? 'N/A'}</span></div>
            <div class="detail-row"><span class="detail-label">Delivery</span><span class="detail-value">${r.delivery ?? 'N/A'}</span></div>
            <div class="detail-row"><span class="detail-label">COD</span><span class="detail-value">${r.cod === true ? 'Yes' : r.cod === false ? 'No' : 'N/A'}</span></div>
          </div>
          <a href="${r.url}" target="_blank" class="btn">View Product</a>
        </div>`;
  };

  const analyserSectionHtml = (product, analysis) => `
    <section>
      <h2>🛒 ${product.shortName} — Sale Analyser</h2>
      <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Sale</th><th>Window (IST)</th><th>Status</th><th>Drop Est.</th><th>Expected List</th><th>Predicted Net</th><th>Verdict</th></tr>
        </thead>
        <tbody>
          ${analysis.all
            .map((sale) => {
              const active = sale.active;
              const daysAway = sale.daysAway;
              const learned = sale.learned?.observedDropPct != null;
              const dropCell = learned
                ? `<span class="learned" title="Calibrated from ${sale.learned.samples} scrapes during the sale window (baseline list ₹${sale.learned.baseline?.toLocaleString('en-IN')})">📈 ${pctStr(sale.learned.observedDropPct)} learned</span>`
                : sale.historicalDropPct
                  ? `${pctStr(sale.historicalDropPct)} <span class="est">(estimate)</span>`
                  : '<span class="est">—</span>';
              const verdictColor = { worth: 'var(--success)', marginal: 'var(--warning)', now: 'var(--success)', live: 'var(--warning)', unknown: 'var(--muted)' }[sale.verdict.kind] ?? 'var(--text)';
              return `
            <tr>
              <td><strong>${sale.name}</strong></td>
              <td>${istDate(sale.start)} → ${istDate(sale.end)}</td>
              <td class="${active ? 'sale-active' : ''}">${active ? '🔥 LIVE' : daysAway > 0 ? `in ${daysAway} days` : 'passed'}</td>
              <td>${dropCell}</td>
              <td>${money.format(sale.expectedList)}</td>
              <td><strong>~${money.format(sale.predictedNet)}</strong></td>
              <td style="color:${verdictColor}; font-weight:600;">${sale.verdict.text}</td>
            </tr>`;
            })
            .join('')}
        </tbody>
      </table>
      </div>
      <p class="subtitle" style="margin-top:0.75rem;">Expected list = min(configured estimate, drop% applied to lowest recorded list, price actually observed once the sale starts). Drop % starts as a configured guess and <strong>self-calibrates</strong> from real sale-window scrapes.${product.assumedExchangeValue ? ` Net assumes ₹${money.format(product.assumedExchangeValue)} exchange.` : ' No exchange assumed for this product.'}</p>
    </section>`;

  const productSectionHtml = state
    .map(({ product, sorted, analysis, bestDealId }) => `
    <div class="product-block" data-product="${product.id}">
    <h2 class="product-heading">📱 ${product.name}${product.id === 'iphone17' ? ' <span class="primary-tag">your target</span>' : ' <span class="watch-tag">watching</span>'}</h2>
    <div class="grid">
      ${sorted.map((r) => cardHtml(product, r, analysis, bestDealId)).join('')}
    </div>
    ${analyserSectionHtml(product, analysis)}
    </div>`)
    .join('\n');

  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="300">
  <title>Price Monitor — iPhone 17 · Galaxy S25 · Galaxy S26</title>
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
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>📱 Price Monitor — iPhone 17 · Galaxy S25 · S26</h1>
      <div class="subtitle">Pincode: <strong>${config.pincode}</strong> | iPhone net assumes M35 exchange <strong>${money.format(products[0].assumedExchangeValue)}</strong> | Cards sorted by lowest price you can actually buy at</div>
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

  ${bannerHtml}
  ${dropBannerHtml}
  ${productSectionHtml}

  <section>
    <h2>📊 Recent Scrapes (newest first)</h2>
    <div class="table-wrap">
    <table>
      <thead>
        <tr><th>Time (IST)</th><th>Product</th><th>Site</th><th>Status</th><th>List</th><th>Effective</th><th>Net w/ Exchange</th></tr>
      </thead>
      <tbody>
        ${historyEntries
          .slice(-20)
          .reverse()
          .map(
            (entry) => `
          <tr>
            <td>${istTime(entry.checkedAt)}</td>
            <td>${productOf(entry, products)?.shortName ?? entry.product ?? 'iPhone 17'}</td>
            <td><strong>${entry.name}</strong></td>
            <td><span class="badge ${entry.status === 'ok' ? 'badge-ok' : 'badge-error'}">${entry.status}</span></td>
            <td>${entry.listPrice ? money.format(entry.listPrice) : '-'}</td>
            <td>${entry.effectivePrice ? money.format(entry.effectivePrice) : '-'}</td>
            <td>${entry.netWithExchange ? money.format(entry.netWithExchange) : '-'}</td>
          </tr>`
          )
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
      let saved = 'all';
      try { saved = localStorage.getItem('priceFilter') || 'all'; } catch (e) {}
      if (filterEl) {
        if (![...filterEl.options].some(function (o) { return o.value === saved; })) saved = 'all';
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
    `**Target Pincode:** \`${config.pincode}\` | **Updated:** ${istTime(now)} IST`,
  ];

  for (const { product, sorted, analysis } of state) {
    mdLines.push(
      ``,
      `## ${product.name}`,
      ``,
      `| Rank | Site | Deliverable | Effective | List Price | Best Bank Offer | Net${product.assumedExchangeValue ? ` (w/ ₹${product.assumedExchangeValue} exchange)` : ''} | Delivery |`,
      `| --- | --- | --- | --- | --- | --- | --- | --- |`,
    );
    sorted.forEach((r, index) => {
      if (r.status === 'error') {
        mdLines.push(`| ${index + 1} | **${r.name}** | - | ❌ Error (last good: see dashboard) | - | - | - | - |`);
      } else {
        const bestBankStr = r.maxBankOffer ? `${money.format(r.maxBankOffer)} (${r.bankOffers?.[0]?.bank ?? ''})` : 'None';
        const netStr = r.netWithExchange ? money.format(r.netWithExchange) : 'N/A';
        const deliverableStr = r.deliverable === false ? '❌ No' : '✅ Yes';
        mdLines.push(
          `| ${index + 1} | [**${r.name}**](${r.url}) | ${deliverableStr} | **${money.format(r.effectivePrice)}** | ${money.format(r.listPrice)} | ${bestBankStr} | **${netStr}** | ${r.delivery ?? 'N/A'} |`
        );
      }
    });

    mdLines.push(
      ``,
      `### 🛒 Sales Analyser`,
      `- Current best buyable: ${analysis.best ? `${analysis.best.name} net ${money.format(analysis.currentBestNet)}` : 'none yet'}`,
    );
    const dropNote = (sale) => {
      const pct = sale.learned?.observedDropPct ?? sale.historicalDropPct;
      return sale.learned?.observedDropPct != null
        ? `**learned ${pctStr(pct)} from ${sale.learned.samples} scrapes**`
        : pct ? `${pctStr(pct)} (estimate, self-calibrates when the sale starts)` : 'unknown';
    };
    if (analysis.active.length) {
      for (const sale of analysis.active) {
        mdLines.push(`- 🔥 **SALE LIVE: ${sale.name}** (until ${istTime(sale.end.toISOString())}) — expected list ~${money.format(sale.expectedList)}, predicted net ~${money.format(sale.predictedNet)}. ${sale.note}`);
      }
    } else if (analysis.upcoming.length) {
      for (const sale of analysis.upcoming) {
        mdLines.push(`- ${sale.verdict.kind === 'worth' ? '💰' : sale.verdict.kind === 'marginal' ? '🤔' : '✅'} **${sale.name}** (${sale.daysAway} days): expected list ~${money.format(sale.expectedList)} · drop ${dropNote(sale)} · predicted net ~${money.format(sale.predictedNet)} — **${sale.verdict.text}**`);
      }
    } else {
      mdLines.push(`- No sale windows configured`);
    }
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
