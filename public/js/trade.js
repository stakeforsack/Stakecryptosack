const COINS = [
  { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', img: '/img/btc.png' },
  { id: 'ethereum', symbol: 'ETH', name: 'Ethereum', img: '/img/eth.png' },
  { id: 'tether', symbol: 'USDT', name: 'Tether', img: '/img/usdt.png' },
  { id: 'cardano', symbol: 'ADA', name: 'Cardano', img: '/img/ada.png' },
  { id: 'binancecoin', symbol: 'BNB', name: 'BNB', img: '/img/bnb.png' },
  { id: 'solana', symbol: 'SOL', name: 'Solana', img: '/img/sol.png' }
];

const coinsListEl = document.getElementById('coinsList');
const chartArea = document.getElementById('chartArea');
const chartTitle = document.getElementById('chartTitle');
const chartLoader = document.getElementById('chartLoader');
const priceCanvas = document.getElementById('priceChart');

let priceChart = null;
let selectedCoin = null;
let liveInterval = null;
let pricePollInterval = 5000; // 5s for near-real-time updates
const MAX_POINTS = 300;

function renderCoins() {
  coinsListEl.innerHTML = '';
  COINS.forEach(c => {
    const div = document.createElement('div');
    div.className = 'coin';
    div.dataset.id = c.id;
    div.innerHTML = `
      <img src="${c.img}" alt="${c.symbol}" onerror="this.style.display='none'">
      <div class="meta">
        <div class="name">${c.symbol} · ${c.name}</div>
        <div class="price" id="price-${c.id}">Loading...</div>
      </div>
      <div id="chg-${c.id}" class="change"></div>
    `;
    div.addEventListener('click', () => openChart(c));
    coinsListEl.appendChild(div);
  });
}

async function fetchPrices() {
  const ids = COINS.map(c => c.id).join(',');
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
    const res = await fetch(url);
    const data = await res.json();
    COINS.forEach(c => {
      const pEl = document.getElementById(`price-${c.id}`);
      const chEl = document.getElementById(`chg-${c.id}`);
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

// timeframe in milliseconds map
const TIMEFRAMES = {
  '1H': 60 * 60 * 1000,
  '6H': 6 * 60 * 60 * 1000,
  '1D': 24 * 60 * 60 * 1000
};

function openChart(coin) {
  selectedCoin = coin;
  chartArea.style.display = 'block';
  chartTitle.textContent = `${coin.name} (${coin.symbol})`;
  loadChartData(coin.id, '1D'); // default show 1 day (will filter)
}

async function loadChartData(coinId, timeframeKey = '1D') {
  if (!coinId) return;
  chartLoader.style.display = 'block';
  if (liveInterval) { clearInterval(liveInterval); liveInterval = null; }

  try {
    // fetch 1 day of data (CoinGecko supports days=1). We'll filter to timeframe.
    const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=1`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.prices) throw new Error('No chart data');

    const now = Date.now();
    const tfMs = TIMEFRAMES[timeframeKey] || TIMEFRAMES['1D'];

    // Filter points within timeframe (if tf is > 24h, keep all)
    const filtered = data.prices.filter(p => {
      const t = p[0];
      return (tfMs >= 24 * 60 * 60 * 1000) || (t >= now - tfMs);
    });

    // Convert to labels and values (use local time string for x labels)
    const labels = filtered.map(p => {
      const d = new Date(p[0]);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    });
    const values = filtered.map(p => Number(p[1]));

    // create or update chart
    if (priceChart) priceChart.destroy();

    priceChart = new Chart(priceCanvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: `${selectedCoin.symbol} price (USD)`,
          data: values,
          borderColor: '#a855f7',
          backgroundColor: 'rgba(168,85,247,0.08)',
          pointRadius: 0,
          tension: 0.18
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,               // disable initial animation for stability
        transitions: {                  // reduce animation on update
          active: { animation: { duration: 0 } }
        },
        scales: {
          x: {
            ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }
          },
          y: {
            ticks: {
              callback: v => '$' + Number(v).toLocaleString(undefined, { maximumFractionDigits: 8 })
            }
          }
        },
        plugins: { legend: { display: false } }
      }
    });

    chartLoader.style.display = 'none';

    // start live updates (poll latest price every pricePollInterval)
    liveInterval = setInterval(async () => {
      try {
        const pRes = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`);
        const pData = await pRes.json();
        const newPrice = pData[coinId] && pData[coinId].usd;
        if (newPrice != null && priceChart) {
          const nowLabel = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          priceChart.data.labels.push(nowLabel);
          priceChart.data.datasets[0].data.push(Number(newPrice));
          // keep last MAX_POINTS points
          while (priceChart.data.labels.length > MAX_POINTS) {
            priceChart.data.labels.shift();
            priceChart.data.datasets[0].data.shift();
          }
          // update without animation to avoid reflow
          priceChart.update('none');
        }
      } catch (e) { console.error('Live update failed', e); }
    }, pricePollInterval);

  } catch (err) {
    console.error('Chart load error', err);
    chartLoader.textContent = 'Failed to load chart';
  }
}

// timeframe buttons
document.addEventListener('click', (e) => {
  if (!selectedCoin) return;
  if (e.target.id === 'btn1h') loadChartData(selectedCoin.id, '1H');
  if (e.target.id === 'btn6h') loadChartData(selectedCoin.id, '6H');
  if (e.target.id === 'btn1d') loadChartData(selectedCoin.id, '1D');
});

// initial
renderCoins();
fetchPrices();
setInterval(fetchPrices, 10000); // refresh coin prices every 10s