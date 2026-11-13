# iPhone 17 Price & Offer Monitor (Pincode 500055)

**🌐 Live Dashboard:** https://rizz1406.github.io/iphone-price-monitor/dashboard.html

Automated Playwright pipeline monitoring **iPhone 17 256GB Mist Blue** prices, instant bank discounts, exchange ceilings, seller info, and delivery availability across **Flipkart**, **Croma**, and **Vijay Sales** for pincode **500055**.

---

## 🎯 Target Thresholds

- **Flipkart:** Target List ≤ `₹84,999` | Target Net ≤ `₹74,000` (Assumed M35 Exchange: `₹6,550`)
- **Croma:** Target List ≤ `₹82,900` | Target Net ≤ `₹76,400`
- **Vijay Sales:** Target List ≤ `₹84,999` | Target Net ≤ `₹78,449`

---

## 🚀 Features

- **Pincode Automation:** Automatically injects pincode `500055` into Flipkart & Croma location modals.
- **Akamai Bypass:** Headed browser mode under `Xvfb` allows Croma extraction on CI without Access Denied blocks.
- **Self-Contained Dashboard:** Generates `dashboard.html` with current store cards, bank offer breakdowns, and price history timeline.
- **GitHub Actions Integration:** Runs scheduled checks every 30 mins (08:00 - 23:00 IST), posts step summaries, and commits data directly to the repo.

---

## 💻 Local Commands

```bash
# Run monitor locally (scrapes Flipkart, Croma, Vijay Sales and updates dashboard)
npm run monitor

# Re-generate dashboard.html and reports/latest.md from latest data
npm run dashboard
```

---

## 📊 Outputs

- **`dashboard.html`**: Open in any browser to view current store prices, best offers, and history.
- **`reports/latest.md`**: Markdown report committed to repo and surfaced in GitHub Actions Step Summary.
- **`data/latest.json`**: Latest extracted JSON state for all stores.
- **`data/history.jsonl`**: Append-only execution history log.
