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

const sparkline = (entries) => {
  const values = entries.map((entry) => entry.effectivePrice);
  if (values.length < 2) return '';
  const width = 260;
  const height = 44;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1, max - min);
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * (width - 4) + 2;
      const y = height - 6 - ((value - min) / span) * (height - 12);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const color = values[values.length - 1] <= values[0] ? 'var(--success)' : 'var(--error)';
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="display:block;margin:0.75rem 0 0;">
    <polyline fill="none" stroke="${color}" stroke-width="2" points="${points}" />
  </svg>`;
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
            ${sparkline(entries)}
            ${rec ? `<div class="rec rec-${rec.kind}">${rec.kind === 'buy' ? '🟢' : rec.kind === 'watch' ? '🟡' : '🔵'} ${rec.text}</div>` : ''}
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
              <td>${sale.start} → ${sale.end}</td>
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
    <h2 class="product-heading">📱 ${product.name}${product.id === 'iphone17' ? ' <span class="primary-tag">your target</span>' : ' <span class="watch-tag">watching</span>'}</h2>
    <div class="grid">
      ${sorted.map((r) => cardHtml(product, r, analysis, bestDealId)).join('')}
    </div>
    ${analyserSectionHtml(product, analysis)}`)
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
      --bg: #0f172a; --card-bg: #1e293b; --border: #334155; --text: #f8fafc; --muted: #94a3b8;
      --accent: #38bdf8; --success: #22c55e; --error: #ef4444; --warning: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 2rem; max-width: 1200px; margin: 0 auto; }
    header { margin-bottom: 1.25rem; border-bottom: 1px solid var(--border); padding-bottom: 1rem; display: flex; justify-content: space-between; align-items: flex-end; }
    h1 { font-size: 1.75rem; font-weight: 700; }
    h2 { font-size: 1.25rem; margin-bottom: 1rem; }
    .product-heading { margin: 2.25rem 0 1rem; font-size: 1.4rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; }
    .primary-tag, .watch-tag { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; padding: 0.2rem 0.5rem; border-radius: 9999px; vertical-align: middle; }
    .primary-tag { background: rgba(245, 158, 11, 0.25); color: var(--warning); }
    .watch-tag { background: rgba(148, 163, 184, 0.15); color: var(--muted); }
    .subtitle { color: var(--muted); font-size: 0.9rem; margin-top: 0.25rem; }
    .banner { padding: 0.85rem 1.25rem; border-radius: 0.75rem; margin-bottom: 1.25rem; font-size: 0.95rem; }
    .banner-sale { background: rgba(245, 158, 11, 0.15); border: 1px solid var(--warning); color: var(--warning); }
    .banner-info { background: rgba(56, 189, 248, 0.12); border: 1px solid var(--accent); color: var(--accent); }
    .banner-drop { background: rgba(34, 197, 94, 0.12); border: 1px solid var(--success); color: var(--success); }
    .badge { padding: 0.25rem 0.6rem; border-radius: 9999px; font-size: 0.8rem; font-weight: 600; text-transform: uppercase; }
    .badge-ok { background: rgba(34, 197, 94, 0.2); color: var(--success); }
    .badge-error { background: rgba(239, 68, 68, 0.2); color: var(--error); }
    .badge-best { background: rgba(245, 158, 11, 0.25); color: var(--warning); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1.5rem; margin-bottom: 2.5rem; }
    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 0.75rem; padding: 1.5rem; display: flex; flex-direction: column; justify-content: space-between; }
    .card-best { border-color: var(--warning); box-shadow: 0 0 0 1px var(--warning); }
    .card-header { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
    .card-title { font-size: 1.2rem; font-weight: 600; color: var(--accent); }
    .price-main { font-size: 1.8rem; font-weight: 700; margin-bottom: 0.25rem; }
    .price-sub { font-size: 0.9rem; color: var(--muted); margin-bottom: 1rem; }
    .rec { padding: 0.6rem 0.75rem; border-radius: 0.5rem; font-size: 0.85rem; margin: 0.9rem 0; }
    .rec-buy { background: rgba(34, 197, 94, 0.12); border: 1px solid var(--success); color: var(--success); }
    .rec-wait { background: rgba(56, 189, 248, 0.1); border: 1px solid var(--accent); color: var(--accent); }
    .rec-watch { background: rgba(245, 158, 11, 0.1); border: 1px solid var(--warning); color: var(--warning); }
    .detail-row { display: flex; justify-content: space-between; gap: 0.75rem; font-size: 0.875rem; padding: 0.4rem 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .detail-label { color: var(--muted); white-space: nowrap; }
    .detail-value { font-weight: 500; text-align: right; }
    .btn { display: inline-block; width: 100%; text-align: center; padding: 0.6rem; margin-top: 1.25rem; background: #2563eb; color: #fff; text-decoration: none; border-radius: 0.5rem; font-weight: 600; }
    .btn:hover { background: #1d4ed8; }
    section { background: var(--card-bg); border: 1px solid var(--border); border-radius: 0.75rem; padding: 1.5rem; margin-bottom: 2rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.875rem; text-align: left; }
    th, td { padding: 0.75rem; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-weight: 600; }
    .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .table-wrap table { min-width: 640px; }
    .sale-active { color: var(--warning); font-weight: 600; }
    .learned { color: var(--success); font-weight: 600; }
    .est { color: var(--muted); font-size: 0.85em; }
    .low-record { color: var(--success); font-weight: 600; }
    @media (max-width: 640px) {
      body { padding: 1rem; }
      header { flex-direction: column; align-items: flex-start; gap: 0.4rem; }
      h1 { font-size: 1.35rem; }
      h2 { font-size: 1.1rem; }
      .product-heading { font-size: 1.15rem; }
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
    <div class="subtitle">Last updated: <strong>${istTime(now)}</strong> IST</div>
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
