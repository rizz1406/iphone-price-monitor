import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const money = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

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

  // 1. Generate Markdown Report
  const mdLines = [
    `# 📱 iPhone 17 (256GB, Mist Blue) Price Report`,
    `**Target Pincode:** \`${config.pincode}\` | **Updated:** ${now}`,
    ``,
    `| Site | Status | List Price | Effective | Best Bank Offer | Exchange Ceiling | Net (w/ ₹${config.assumedExchangeValue} M35) | Delivery | COD |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
  ];

  for (const r of results) {
    if (r.status === 'error') {
      mdLines.push(`| **${r.name}** | ❌ Error | - | - | - | - | - | - | - |`);
    } else {
      const bestBankStr = r.maxBankOffer ? `${money.format(r.maxBankOffer)} (${r.bankOffers?.[0]?.bank ?? ''})` : 'None';
      const exchangeStr = r.exchangeCeiling ? money.format(r.exchangeCeiling) : r.exchangeAvailable ? 'Available' : 'N/A';
      const netStr = r.netWithExchange ? money.format(r.netWithExchange) : 'N/A';
      const codStr = r.cod === true ? 'Yes' : r.cod === false ? 'No' : 'N/A';
      mdLines.push(
        `| [**${r.name}**](${r.url}) | ✅ OK | ${money.format(r.listPrice)} | **${money.format(r.effectivePrice)}** | ${bestBankStr} | ${exchangeStr} | **${netStr}** | ${r.delivery ?? 'N/A'} | ${codStr} |`
      );
    }
  }

  mdLines.push(
    ``,
    `### Targets Summary`,
    `- **Flipkart:** Target List ≤ \`₹84,999\` | Target Net ≤ \`₹74,000\``,
    `- **Croma:** Target List ≤ \`₹82,900\` | Target Net ≤ \`₹76,400\``,
    `- **Vijay Sales:** Target List ≤ \`₹84,999\` | Target Net ≤ \`₹78,449\``
  );

  const mdContent = mdLines.join('\n');
  await writeFile(path.join(reportsDir, 'latest.md'), mdContent, 'utf8');

  // If in GitHub Actions, append to Step Summary
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      await writeFile(process.env.GITHUB_STEP_SUMMARY, mdContent + '\n', { flag: 'a' });
    } catch {}
  }

  // 2. Generate HTML Dashboard
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="300">
  <title>iPhone 17 Price Monitor Dashboard</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --success: #22c55e;
      --error: #ef4444;
      --warning: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 2rem; max-width: 1200px; margin: 0 auto; }
    header { margin-bottom: 2rem; border-bottom: 1px solid var(--border); padding-bottom: 1rem; display: flex; justify-content: space-between; align-items: flex-end; }
    h1 { font-size: 1.75rem; font-weight: 700; color: var(--text); }
    .subtitle { color: var(--muted); font-size: 0.9rem; margin-top: 0.25rem; }
    .badge { padding: 0.25rem 0.6rem; border-radius: 9999px; font-size: 0.8rem; font-weight: 600; text-transform: uppercase; }
    .badge-ok { background: rgba(34, 197, 94, 0.2); color: var(--success); }
    .badge-error { background: rgba(239, 68, 68, 0.2); color: var(--error); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1.5rem; margin-bottom: 2.5rem; }
    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 0.75rem; padding: 1.5rem; display: flex; flex-direction: column; justify-content: space-between; }
    .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
    .card-title { font-size: 1.2rem; font-weight: 600; color: var(--accent); }
    .price-main { font-size: 1.8rem; font-weight: 700; margin-bottom: 0.5rem; color: var(--text); }
    .price-sub { font-size: 0.9rem; color: var(--muted); margin-bottom: 1rem; }
    .detail-row { display: flex; justify-content: space-between; font-size: 0.875rem; padding: 0.4rem 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .detail-label { color: var(--muted); }
    .detail-value { font-weight: 500; text-align: right; }
    .btn { display: inline-block; width: 100%; text-align: center; padding: 0.6rem; margin-top: 1.25rem; background: #2563eb; color: #fff; text-decoration: none; border-radius: 0.5rem; font-weight: 600; transition: background 0.2s; }
    .btn:hover { background: #1d4ed8; }
    section { background: var(--card-bg); border: 1px solid var(--border); border-radius: 0.75rem; padding: 1.5rem; margin-bottom: 2rem; }
    h2 { font-size: 1.25rem; margin-bottom: 1rem; color: var(--text); }
    table { width: 100%; border-collapse: collapse; font-size: 0.875rem; text-align: left; }
    th, td { padding: 0.75rem; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-weight: 600; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>iPhone 17 (256GB, Mist Blue) Price Monitor</h1>
      <div class="subtitle">Target Pincode: <strong>${config.pincode}</strong> | Assumed M35 Exchange: <strong>${money.format(config.assumedExchangeValue)}</strong></div>
    </div>
    <div class="subtitle">Last updated: <strong>${new Date(now).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</strong></div>
  </header>

  <div class="grid">
    ${results
      .map((r) => {
        if (r.status === 'error') {
          const lastGood = [...historyEntries]
            .reverse()
            .find((entry) => entry.site === r.site && entry.status === 'ok' && entry.effectivePrice);
          const lastGoodTime = lastGood
            ? new Date(lastGood.checkedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })
            : null;
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
              <div class="price-sub">Last known good scrape: <strong>${lastGoodTime}</strong> (IST)</div>
              <div class="detail-row">
                <span class="detail-label">List Price</span>
                <span class="detail-value">${lastGood.listPrice ? money.format(lastGood.listPrice) : 'N/A'}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Best Bank Offer</span>
                <span class="detail-value">${lastGood.maxBankOffer ? money.format(lastGood.maxBankOffer) : 'None'}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Net w/ Exchange</span>
                <span class="detail-value" style="color:var(--success); font-weight:700;">${lastGood.netWithExchange ? money.format(lastGood.netWithExchange) : 'N/A'}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Delivery</span>
                <span class="detail-value">${lastGood.delivery ?? 'N/A'}</span>
              </div>`
                  : '<p style="color:var(--muted); font-size:0.9rem;">No successful scrape recorded yet.</p>'
              }
            </div>
            <a href="${r.url}" target="_blank" class="btn">View Store</a>
          </div>`;
        }
        return `
        <div class="card">
          <div>
            <div class="card-header">
              <span class="card-title">${r.name}</span>
              <span class="badge badge-ok">AVAILABLE</span>
            </div>
            <div class="price-main">${money.format(r.effectivePrice)}</div>
            <div class="price-sub">List Price: ${money.format(r.listPrice)}</div>

            <div class="detail-row">
              <span class="detail-label">Net w/ Exchange</span>
              <span class="detail-value" style="color:var(--success); font-weight:700;">${r.netWithExchange ? money.format(r.netWithExchange) : 'N/A'}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Best Bank Offer</span>
              <span class="detail-value">${r.maxBankOffer ? money.format(r.maxBankOffer) : 'None'}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Exchange Ceiling</span>
              <span class="detail-value">${r.exchangeCeiling ? money.format(r.exchangeCeiling) : 'N/A'}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Seller</span>
              <span class="detail-value">${r.seller ?? 'N/A'}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Delivery</span>
              <span class="detail-value">${r.delivery ?? 'N/A'}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">COD Available</span>
              <span class="detail-value">${r.cod === true ? 'Yes' : r.cod === false ? 'No' : 'N/A'}</span>
            </div>
          </div>
          <a href="${r.url}" target="_blank" class="btn">View Product</a>
        </div>`;
      })
      .join('')}
  </div>

  <section>
    <h2>Recent Scrapes History</h2>
    <table>
      <thead>
        <tr>
          <th>Time (IST)</th>
          <th>Site</th>
          <th>Status</th>
          <th>List Price</th>
          <th>Effective</th>
          <th>Net w/ Exchange</th>
        </tr>
      </thead>
      <tbody>
        ${historyEntries
          .slice(-15)
          .reverse()
          .map(
            (entry) => `
          <tr>
            <td>${new Date(entry.checkedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td>
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

// Allow direct CLI execution
if (process.argv[1]?.endsWith('report.js')) {
  const root = process.cwd();
  const config = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
  const latestPath = path.join(root, 'data', 'latest.json');
  const historyPath = path.join(root, 'data', 'history.jsonl');
  const latestData = JSON.parse(await readFile(latestPath, 'utf8'));
  await writeReports({ root, config, results: latestData.sites, historyPath });
  console.log('Dashboard & Markdown report re-generated successfully!');
}
