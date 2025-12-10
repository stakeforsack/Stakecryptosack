// trade.js — updated to be mobile-friendly, remove order UI, hide chart x-axis labels,
// and reduce price polling to avoid spamming CoinGecko.
//
// Replace your current trade.js with this file (keeps existing endpoints / behavior).

const COINS = [
  { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', img: '/img/btc.png' },
  { id: 'ethereum', symbol: 'ETH', name: 'Ethereum', img: '/img/eth.png' },
  { id: 'tether', symbol: 'USDT', name: 'Tether', img: '/img/usdt.png' },
  { id: 'cardano', symbol: 'ADA', name: 'Cardano', img: '/img/ada.png' },
  { id: 'binancecoin', symbol: 'BNB', name: 'BNB', img: '/img/bnb.png' },
  { id: 'solana', symbol: 'SOL', name: 'Solana', img: '/img/sol.png' }
];

const coinsListEl = document.getElementById('coinsList');
const chartBox = document.getElementById('chartBox');
const chartTitle = document.getElementById('chartTitle');
const chartLoader = document.getElementById('chartLoader');
const priceCanvas = document.getElementById('priceChart');

let priceChart = null;
let selectedCoin = null;
let liveInterval = null;
let pricePollInterval = 15000; // 15s to reduce request rate
const MAX_POINTS = 300;

// backoff on repeated 429s
let consecutive429 = 0;
let fetchIntervalHandle = null;

function el(className, inner = '') {
  const d = document.createElement('div');
  d.className = className;
  d.innerHTML = inner;
  return d;
}

function renderCoins() {
  coinsListEl.innerHTML = '';
  COINS.forEach(c => {
    const div = document.createElement('div');
    div.className = 'coin';
    div.dataset.id = c.id;
    div.innerHTML = `
      <div class="img"><img src="${c.img}" alt="${c.symbol}"></div>
      <div class="meta">
        <div class="name">${c.symbol} · ${c.name}</div>
        <div class="pair">${c.symbol} / USDT</div>
      </div>
      <div class="priceRow">
        <div class="price" id="price-${c.id}">—</div>
        <div id="chg-${c.id}" class="change">—</div>
      </div>
    `;
    div.addEventListener('click', () => openChart(c, div));
    coinsListEl.appendChild(div);
  });
}

/**
 * fetchPrices - fetches a compact price object and updates UI.
 * Uses a gentle polling interval and backs off if CoinGecko returns 429.
 */
async function fetchPrices() {
  const ids = COINS.map(c => c.id).join(',');
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
    const res = await fetch(url);
    if (res.status === 429) {
      consecutive429++;
      // exponential backoff: increase interval and skip update
      const backoff = Math.min(60000, pricePollInterval * Math.pow(2, consecutive429));
      console.warn('CoinGecko 429 — backing off to', backoff);
      if (fetchIntervalHandle) clearInterval(fetchIntervalHandle);
      fetchIntervalHandle = setInterval(fetchPrices, backoff);
      return;
    } else {
      // clear backoff on success
      if (consecutive429 > 0) {
        consecutive429 = 0;
        if (fetchIntervalHandle) { clearInterval(fetchIntervalHandle); fetchIntervalHandle = setInterval(fetchPrices, pricePollInterval); }
      }
    }
    const data = await res.json();
    COINS.forEach(c => {
      const pEl = document.getElementById(`price-${c.id}`);
      const chEl = document.getElementById(`chg-${c.id}`);
      if (!pEl || !chEl) return;
      if (data[c.id] && data[c.id].usd != null) {
        const price = Number(data[c.id].usd);
        pEl.textContent = '$' + price.toLocaleString(undefined, { maximumFractionDigits: 8 });
        const ch = Number(data[c.id].usd_24h_change || 0);
        chEl.textContent = (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%';
        chEl.className = 'change ' + (ch >= 0 ? 'pos' : 'neg');
      } else {
        pEl.textContent = '—';
        chEl.textContent = '';
      }
    });
  } catch (err) {
    console.error('Price fetch error', err);
  }
}

// TIMEFRAMES used to filter the Chart data returned (we request 1 day raw and filter client-side)
const TIMEFRAMES = {
  '1H': 60 * 60 * 1000,
  '6H': 6 * 60 * 60 * 1000,
  '1D': 24 * 60 * 60 * 1000
};

function openChart(coin, domNode) {
  selectedCoin = coin;
  document.querySelectorAll('.coin').forEach(x => x.classList.remove('active'));
  if (domNode) domNode.classList.add('active');

  chartBox.style.display = 'block';
  chartTitle.textContent = `${coin.name} (${coin.symbol})`;
  loadChartData(coin.id, '1D');
}

// load chart data (we request 1 day and filter to timeframe)
async function loadChartData(coinId, timeframeKey = '1D') {
  if (!coinId) return;
  chartLoader.style.display = 'block';

  // stop existing live updates
  if (liveInterval) { clearInterval(liveInterval); liveInterval = null; }

  try {
    const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Chart request failed: ${res.status}`);
    const data = await res.json();
    if (!data.prices || !Array.isArray(data.prices)) throw new Error('No chart data');

    const now = Date.now();
    const tfMs = TIMEFRAMES[timeframeKey] || TIMEFRAMES['1D'];
    const filtered = data.prices.filter(p => {
      const t = p[0];
      // if timeframe is >= 24h, keep all
      if (tfMs >= 24 * 60 * 60 * 1000) return true;
      return (t >= now - tfMs);
    });

    // labels: we'll hide axis labels (you asked no date/time) — keep labels minimal for Chart internal mapping
    const labels = filtered.map((p, i) => i); // simple index labels — we hide axis display
    const values = filtered.map(p => Number(p[1]));

    // destroy old chart
    if (priceChart) {
      try { priceChart.destroy(); } catch (e) {/* ignore */}
      priceChart = null;
    }

    // create chart with x-axis hidden (no date/time) and compact tooltip
    const ctx = priceCanvas.getContext('2d');
    priceChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: `${selectedCoin.symbol} price (USD)`,
          data: values,
          borderColor: '#a855f7',
          backgroundColor: 'rgba(168,85,247,0.08)',
          pointRadius: 0,
          tension: 0.22,
          borderWidth: 2,
          fill: true,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: () => '', // remove title (date/time)
              label: (ctx) => {
                const v = ctx.parsed.y;
                return '$' + Number(v).toLocaleString(undefined, { maximumFractionDigits: 8 });
              }
            }
          }
        },
        scales: {
          x: {
            display: false, // hide x-axis (no dates / times)
            grid: { display: false }
          },
          y: {
            ticks: {
              callback: v => '$' + Number(v).toLocaleString(undefined, { maximumFractionDigits: 8 })
            },
            grid: { color: 'rgba(255,255,255,0.02)' }
          }
        },
        interaction: {
          intersect: false,
          mode: 'index'
        }
      }
    });

    chartLoader.style.display = 'none';

    // start live polling of single latest price to append smoothly
    liveInterval = setInterval(async () => {
      try {
        const pRes = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`);
        if (!pRes.ok) return;
        const pData = await pRes.json();
        const newPrice = pData[coinId] && pData[coinId].usd;
        if (newPrice != null && priceChart) {
          // push new point
          priceChart.data.labels.push(priceChart.data.labels.length);
          priceChart.data.datasets[0].data.push(Number(newPrice));
          // maintain max points
          while (priceChart.data.labels.length > MAX_POINTS) {
            priceChart.data.labels.shift();
            priceChart.data.datasets[0].data.shift();
          }
          priceChart.update('none'); // update without animation
        }
      } catch (e) { console.error('Live update failed', e); }
    }, pricePollInterval);

  } catch (err) {
    console.error('Chart load error', err);
    chartLoader.textContent = 'Failed to load chart';
  }
}

// timeframe buttons (delegated)
document.addEventListener('click', (e) => {
  if (!selectedCoin) return;
  if (e.target.id === 'btn1h') loadChartData(selectedCoin.id, '1H');
  if (e.target.id === 'btn6h') loadChartData(selectedCoin.id, '6H');
  if (e.target.id === 'btn1d') loadChartData(selectedCoin.id, '1D');
});

// INITIALIZE
renderCoins();
fetchPrices();
// use a single poll interval handle so we can backoff gracefully
if (fetchIntervalHandle) clearInterval(fetchIntervalHandle);
fetchIntervalHandle = setInterval(fetchPrices, pricePollInterval);

// Also start the shared MarketPrices script (if present) for other pages
try {
  if (window.MarketPrices && typeof window.MarketPrices.start === 'function') {
    // start a light update for the smaller UI (keeps other parts synced)
    window.MarketPrices.start(COINS.map(c => c.id), 20000);
  }
} catch (e) {}
