import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const money = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

const istTime = (iso) =>
  new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

const lastKnownGood = (historyEntries, siteId) =>
  [...historyEntries]
    .reverse()
    .find((entry) => entry.site === siteId && entry.status === 'ok' && entry.effectivePrice);

const historyForSite = (historyEntries, siteId, limit = 24) =>
  historyEntries.filter((entry) => entry.site === siteId && entry.status === 'ok' && entry.effectivePrice).slice(-limit);

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

const saleCalendarState = (config, now) => {
  const today = new Date(now);
  const sales = (config.saleCalendar ?? []).map((sale) => {
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

// Sales analyser: computes expected drop, predicted net, and a worth-waiting verdict.
const analyseSales = (config, historyEntries, results, saleState) => {
  const best = bestBuyable(results);
  const currentBestNet = best ? (best.netWithExchange ?? best.effectivePrice) : null;
  const currentBestList = best?.listPrice ?? null;
  const floorList = lowestListRecorded(historyEntries);
  const threshold = config.worthWaitingSavings ?? 4000;

  const analysed = saleState.all.map((sale) => {
    // Expected list = lower of configured expectation and historical-depth drop off the current floor.
    const fromDrop = floorList && sale.historicalDropPct
      ? Math.round((floorList * (1 - sale.historicalDropPct)) / 100) * 100
      : null;
    const expectedList = [sale.expectedListPrice, fromDrop, currentBestList]
      .filter((value) => value)
      .sort((a, b) => a - b)[0] ?? sale.expectedListPrice;

    // Predicted net subtracts only instant (full-payment) bank offers — EMI-only offers don't reduce the price you pay upfront.
    const bank = best?.maxBankOffer && best.bankOfferKind !== 'emi' ? best.maxBankOffer : 0;
    const exchange = best?.exchangeAvailable ? config.assumedExchangeValue : 0;
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

    return { ...sale, expectedList, predictedNet, savings, verdict };
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

const recommendationFor = (result, analysis, config) => {
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
  const rawSaleState = saleCalendarState(config, now);
  const analysis = analyseSales(config, historyEntries, results, rawSaleState);

  const sorted = [...results].sort((a, b) => {
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

  // 1. Markdown report
  const mdLines = [
    `# 📱 iPhone 17 (256GB, Mist Blue) Price Report`,
    `**Target Pincode:** \`${config.pincode}\` | **Updated:** ${istTime(now)} IST`,
    ``,
    `| Rank | Site | Deliverable | Effective | List Price | Best Bank Offer | Exchange Ceiling | Net (w/ ₹${config.assumedExchangeValue} M35) | Delivery |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
  ];

  sorted.forEach((r, index) => {
    if (r.status === 'error') {
      mdLines.push(`| ${index + 1} | **${r.name}** | - | ❌ Error (last good: see dashboard) | - | - | - | - | - |`);
    } else {
      const bestBankStr = r.maxBankOffer ? `${money.format(r.maxBankOffer)} (${r.bankOffers?.[0]?.bank ?? ''})` : 'None';
      const exchangeStr = r.exchangeCeiling ? money.format(r.exchangeCeiling) : r.exchangeAvailable ? 'Available' : 'N/A';
      const netStr = r.netWithExchange ? money.format(r.netWithExchange) : 'N/A';
      const deliverableStr = r.deliverable === false ? '❌ No' : '✅ Yes';
      mdLines.push(
        `| ${index + 1} | [**${r.name}**](${r.url}) | ${deliverableStr} | **${money.format(r.effectivePrice)}** | ${money.format(r.listPrice)} | ${bestBankStr} | ${exchangeStr} | **${netStr}** | ${r.delivery ?? 'N/A'} |`
      );
    }
  });

  mdLines.push(
    ``,
    `### 🛒 Sales Analyser`,
    `- Current best buyable: ${analysis.best ? `${analysis.best.name} net ${money.format(analysis.currentBestNet)}` : 'none yet'}`,
  );
  if (analysis.active.length) {
    for (const sale of analysis.active) {
      mdLines.push(`- 🔥 **SALE LIVE: ${sale.name}** (until ${istTime(sale.end.toISOString())}) — predicted net ~${money.format(sale.predictedNet)}. ${sale.note}`);
    }
  } else if (analysis.upcoming.length) {
    for (const sale of analysis.upcoming) {
      mdLines.push(`- ${sale.verdict.kind === 'worth' ? '💰' : sale.verdict.kind === 'marginal' ? '🤔' : '✅'} **${sale.name}** (${sale.daysAway} days): predicted net ~${money.format(sale.predictedNet)} — **${sale.verdict.text}**`);
    }
  } else {
    mdLines.push(`- No sale windows configured in config.json`);
  }

  mdLines.push(
    ``,
    `### 🎯 Targets`,
    `- **Flipkart:** List ≤ \`₹84,999\` | Net ≤ \`₹74,000\``,
    `- **Croma:** List ≤ \`₹82,900\` | Net ≤ \`₹76,400\``,
    `- **Vijay Sales:** List ≤ \`₹84,999\` | Net ≤ \`₹78,449\``,
  );

  const mdContent = mdLines.join('\n');
  await writeFile(path.join(reportsDir, 'latest.md'), mdContent, 'utf8');

  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      await writeFile(process.env.GITHUB_STEP_SUMMARY, mdContent + '\n', { flag: 'a' });
    } catch {}
  }

  // 2. HTML Dashboard
  const trendIcon = { down: '▼ falling', flat: '▬ stable', up: '▲ rising' };

  const bannerHtml = analysis.active.length
    ? `<div class="banner banner-sale">🔥 SALE LIVE: ${analysis.active.map((sale) => sale.name).join(', ')} — predicted net ~${money.format(analysis.active[0].predictedNet)}. ${analysis.active[0].note}</div>`
    : analysis.upcoming.length
      ? `<div class="banner banner-info">${analysis.upcoming[0].verdict.kind === 'worth' ? '💰' : '⏳'} ${analysis.upcoming[0].name} starts ${istTime(analysis.upcoming[0].start.toISOString())} (${analysis.upcoming[0].daysAway} days) — predicted net ~${money.format(analysis.upcoming[0].predictedNet)} · <strong>${analysis.upcoming[0].verdict.text}</strong></div>`
      : '';

  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="300">
  <title>iPhone 17 Price Monitor Dashboard</title>
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
    .subtitle { color: var(--muted); font-size: 0.9rem; margin-top: 0.25rem; }
    .banner { padding: 0.85rem 1.25rem; border-radius: 0.75rem; margin-bottom: 1.25rem; font-size: 0.95rem; }
    .banner-sale { background: rgba(245, 158, 11, 0.15); border: 1px solid var(--warning); color: var(--warning); }
    .banner-info { background: rgba(56, 189, 248, 0.12); border: 1px solid var(--accent); color: var(--accent); }
    .badge { padding: 0.25rem 0.6rem; border-radius: 9999px; font-size: 0.8rem; font-weight: 600; text-transform: uppercase; }
    .badge-ok { background: rgba(34, 197, 94, 0.2); color: var(--success); }
    .badge-error { background: rgba(239, 68, 68, 0.2); color: var(--error); }
    .badge-best { background: rgba(245, 158, 11, 0.25); color: var(--warning); }
    .badge-deliv { background: rgba(148, 163, 184, 0.15); color: var(--muted); font-size: 0.7rem; }
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
    .sale-active { color: var(--warning); font-weight: 600; }
    .low-record { color: var(--success); font-weight: 600; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>iPhone 17 (256GB, Mist Blue) Price Monitor</h1>
      <div class="subtitle">Pincode: <strong>${config.pincode}</strong> | Assumed M35 Exchange: <strong>${money.format(config.assumedExchangeValue)}</strong> | Cards sorted by lowest price you can actually buy at</div>
    </div>
    <div class="subtitle">Last updated: <strong>${istTime(now)}</strong> IST</div>
  </header>

  ${bannerHtml}

  <div class="grid">
    ${sorted
      .map((r) => {
        if (r.status === 'error') {
          const lastGood = lastKnownGood(historyEntries, r.site);
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

        const entries = historyForSite(historyEntries, r.site);
        const trend = trendOf(entries);
        const lowestRecorded = entries.length
          ? entries.reduce((min, entry) => (entry.effectivePrice < min.effectivePrice ? entry : min))
          : null;
        const rec = recommendationFor(r, analysis, config);
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
      })
      .join('')}
  </div>

  <section>
    <h2>🛒 Sale Analyser — worth watching?</h2>
    <table>
      <thead>
        <tr><th>Sale</th><th>Window (IST)</th><th>Status</th><th>Expected List</th><th>Predicted Net</th><th>Verdict</th></tr>
      </thead>
      <tbody>
        ${analysis.all
          .map((sale) => {
            const active = sale.active;
            const daysAway = sale.daysAway;
            const verdictColor = { worth: 'var(--success)', marginal: 'var(--warning)', now: 'var(--success)', live: 'var(--warning)', unknown: 'var(--muted)' }[sale.verdict.kind] ?? 'var(--text)';
            return `
          <tr>
            <td><strong>${sale.name}</strong></td>
            <td>${sale.start} → ${sale.end}</td>
            <td class="${active ? 'sale-active' : ''}">${active ? '🔥 LIVE' : daysAway > 0 ? `in ${daysAway} days` : 'passed'}</td>
            <td>${money.format(sale.expectedList)}</td>
            <td><strong>~${money.format(sale.predictedNet)}</strong></td>
            <td style="color:${verdictColor}; font-weight:600;">${sale.verdict.text}</td>
          </tr>`;
          })
          .join('')}
      </tbody>
    </table>
    <p class="subtitle" style="margin-top:0.75rem;">Expected list = min(configured estimate, historical-discount% applied to lowest recorded list). Predicted net subtracts the live bank offer + M35 exchange. "Worth waiting" = predicted net beats current best by the threshold.</p>
  </section>

  <section>
    <h2>📊 Recent Scrapes (newest first)</h2>
    <table>
      <thead>
        <tr><th>Time (IST)</th><th>Site</th><th>Status</th><th>List</th><th>Effective</th><th>Net w/ Exchange</th></tr>
      </thead>
      <tbody>
        ${historyEntries
          .slice(-15)
          .reverse()
          .map(
            (entry) => `
          <tr>
            <td>${istTime(entry.checkedAt)}</td>
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
  </section>
</body>
</html>`;

  await writeFile(path.join(root, 'dashboard.html'), htmlContent, 'utf8');
}

if (process.argv[1]?.endsWith('report.js')) {
  const root = process.cwd();
  const config = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
  const latestPath = path.join(root, 'data', 'latest.json');
  const historyPath = path.join(root, 'data', 'history.jsonl');
  const latestData = JSON.parse(await readFile(latestPath, 'utf8'));
  await writeReports({ root, config, results: latestData.sites, historyPath });
  console.log('Dashboard & Markdown report re-generated successfully!');
}
