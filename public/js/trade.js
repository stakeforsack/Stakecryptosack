// trade.js — improved, mobile-friendly, animated, and robust
// Assumes: Chart.js is loaded and HTML has elements with IDs used in original layout.

const COINS = [
  { id: "bitcoin", symbol: "BTC", name: "Bitcoin", img: "/img/btc.png" },
  { id: "ethereum", symbol: "ETH", name: "Ethereum", img: "/img/eth.png" },
  { id: "tether", symbol: "USDT", name: "Tether", img: "/img/usdt.png" },
  { id: "cardano", symbol: "ADA", name: "Cardano", img: "/img/ada.png" },
  { id: "binancecoin", symbol: "BNB", name: "BNB", img: "/img/bnb.png" },
  { id: "solana", symbol: "SOL", name: "Solana", img: "/img/sol.png" },
];

const coinsListEl = document.getElementById("coinsList") || document.querySelector(".coins");
const chartArea = document.getElementById("chartBox") || document.getElementById("chartArea");
const chartTitle = document.getElementById("chartTitle") || document.getElementById("chartTitle");
const chartLoader = document.getElementById("chartLoader") || null;
const priceCanvas = document.getElementById("priceChart");
const timeframeButtons = document.querySelectorAll(".periods button");

let priceChart = null;
let selectedCoin = null;
let liveInterval = null;
let pricePollInterval = 5000; // 5s near-real-time updates
const MAX_POINTS = 300;

// Simple in-memory cache for fetched market_chart results to avoid hammering API
const chartCache = {}; // { coinId: { fetchedAt: ts, prices: [...], raw: {...} } }
const PRICE_REFRESH_MS = 10000; // refresh list prices every 10s

// helpers
function formatPriceForList(v) {
  if (v === undefined || v === null || Number.isNaN(v)) return "—";
  // choose decimals based on magnitude
  if (v >= 1) return "$" + Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (v >= 0.01) return "$" + Number(v).toLocaleString(undefined, { maximumFractionDigits: 4 });
  return "$" + Number(v).toLocaleString(undefined, { maximumFractionDigits: 8 });
}

function formatPriceForChartTick(v) {
  if (v === undefined || v === null) return "";
  if (v >= 1) return "$" + Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (v >= 0.01) return "$" + Number(v).toLocaleString(undefined, { maximumFractionDigits: 4 });
  return "$" + Number(v).toLocaleString(undefined, { maximumFractionDigits: 8 });
}

function el(tag, cls, html) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (html !== undefined) d.innerHTML = html;
  return d;
}

// Render coin list (responsive)
function renderCoins() {
  if (!coinsListEl) return;
  coinsListEl.innerHTML = "";
  COINS.forEach((c) => {
    const div = el("div", "coin");
    div.dataset.id = c.id;
    div.setAttribute("role", "button");
    div.setAttribute("aria-label", `${c.name} (${c.symbol})`);
    div.innerHTML = `
      <img src="${c.img}" alt="${c.symbol}" onerror="this.style.display='none'">
      <div class="name">${c.symbol}</div>
      <div class="pair">${c.name}</div>
      <div class="price" id="price-${c.id}">—</div>
      <div id="chg-${c.id}" class="change">—</div>
    `;
    div.addEventListener("click", () => openChart(c, "1D"));
    coinsListEl.appendChild(div);
  });
}

// Fetch top-level prices for the list
async function fetchPrices() {
  const ids = COINS.map((c) => c.id).join(",");
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Price API error");
    const data = await res.json();

    COINS.forEach((c) => {
      const pEl = document.getElementById(`price-${c.id}`);
      const chEl = document.getElementById(`chg-${c.id}`);
      if (data[c.id] && data[c.id].usd != null) {
        const price = Number(data[c.id].usd);
        pEl.textContent = formatPriceForList(price);
        const ch = Number(data[c.id].usd_24h_change || 0);
        chEl.textContent = (ch >= 0 ? "+" : "") + ch.toFixed(2) + "%";
        chEl.className = "change " + (ch >= 0 ? "pos" : "neg");
        // subtle pulse animation for update
        pEl.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 350 });
      } else {
        if (pEl) pEl.textContent = "—";
        if (chEl) chEl.textContent = "";
      }
    });
  } catch (err) {
    console.error("Price fetch error", err);
  }
}

// TIMEFRAMES in milliseconds (used to filter points)
const TIMEFRAMES = {
  "1H": 60 * 60 * 1000,
  "6H": 6 * 60 * 60 * 1000,
  "1D": 24 * 60 * 60 * 1000,
};

// fetch chart (market_chart) and cache it
async function fetchChartRaw(coinId, days = 1) {
  const now = Date.now();
  const cache = chartCache[coinId];
  // reuse if fetched recently (30s) and days requested same (we store raw.days)
  if (cache && cache.raw && cache.rawDays === days && now - (cache.fetchedAt || 0) < 30 * 1000) {
    return cache.raw;
  }

  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(
    coinId
  )}/market_chart?vs_currency=usd&days=${days}&interval=hourly`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Chart API error");
  const raw = await res.json();

  chartCache[coinId] = chartCache[coinId] || {};
  chartCache[coinId].raw = raw;
  chartCache[coinId].rawDays = days;
  chartCache[coinId].fetchedAt = Date.now();
  return raw;
}

// build label string from timestamp depending on timeframe
function labelFromTimestamp(ms, timeframeKey) {
  const d = new Date(ms);
  if (timeframeKey === "1H" || timeframeKey === "6H") {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  // 1D or larger, show hours for 1D
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// open chart for coin and timeframe (default 1D)
async function openChart(coin, timeframeKey = "1D") {
  selectedCoin = coin;
  // visually mark active coin
  document.querySelectorAll(".coin").forEach((el) => el.classList.toggle("active", el.dataset.id === coin.id));

  if (chartArea) chartArea.style.display = "block";
  if (chartTitle) chartTitle.textContent = `${coin.name} (${coin.symbol})`;

  await loadChartData(coin.id, timeframeKey);
}

// Main loader — pulls cached chart raw, filters by timeframe and draws Chart.js
async function loadChartData(coinId, timeframeKey = "1D") {
  if (!coinId || !priceCanvas) return;
  // show loader element if provided
  if (chartLoader) chartLoader.style.display = "block";

  // clear previous live updates
  if (liveInterval) {
    clearInterval(liveInterval);
    liveInterval = null;
  }

  try {
    // fetch raw (1 day is enough for 1D/6H/1H filtering)
    const raw = await fetchChartRaw(coinId, 1);
    if (!raw || !raw.prices) throw new Error("No chart data");

    const now = Date.now();
    const tfMs = TIMEFRAMES[timeframeKey] || TIMEFRAMES["1D"];

    // filter points to timeframe (if timeframe <= 24h)
    const points = raw.prices.filter((p) => {
      const t = p[0];
      return tfMs >= 24 * 60 * 60 * 1000 ? true : t >= now - tfMs;
    });

    // if no points found (rare), fallback to raw.prices
    const usePoints = points.length ? points : raw.prices;

    const labels = usePoints.map((p) => labelFromTimestamp(p[0], timeframeKey));
    const values = usePoints.map((p) => Number(p[1]));

    // prepare gradient for chart line fill (works with canvas 2d)
    const ctx = priceCanvas.getContext("2d");
    // resize canvas container properly (the HTML should set canvas height via CSS)
    // create gradient based on canvas height
    const gradient = ctx.createLinearGradient(0, 0, 0, priceCanvas.height || 260);
    gradient.addColorStop(0, "rgba(168,85,247,0.12)");
    gradient.addColorStop(1, "rgba(168,85,247,0.02)");

    // destroy old chart
    if (priceChart) {
      try { priceChart.destroy(); } catch (e) { /* ignore */ }
      priceChart = null;
    }

    // Create new Chart.js instance
    priceChart = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: `${selectedCoin?.symbol || coinId} price (USD)`,
            data: values,
            borderColor: "#a855f7",
            backgroundColor: gradient,
            pointRadius: 0,
            tension: 0.18,
            borderWidth: 2,
            hoverRadius: 4,
            segment: {
              // nice subtle transition on value change
              borderDash: (ctx) => (ctx.p0DataIndex === 0 ? [] : []),
            },
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (context) => {
                const v = context.parsed.y;
                return formatPriceForChartTick(v);
              },
            },
          },
        },
        scales: {
          x: {
            ticks: { color: "#9aa3b2", maxRotation: 0, autoSkip: true, maxTicksLimit: 10 },
            grid: { display: false },
          },
          y: {
            ticks: { color: "#9aa3b2", callback: formatPriceForChartTick },
            grid: { color: "rgba(255,255,255,0.02)" },
          },
        },
      },
    });

    // hide loader
    if (chartLoader) chartLoader.style.display = "none";

    // live poll the latest price and append to chart
    liveInterval = setInterval(async () => {
      try {
        const pRes = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`);
        if (!pRes.ok) throw new Error("live price fetch failed");
        const pData = await pRes.json();
        const newPrice = pData[coinId] && pData[coinId].usd;
        if (newPrice != null && priceChart) {
          const nowLabel = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
          priceChart.data.labels.push(nowLabel);
          priceChart.data.datasets[0].data.push(Number(newPrice));
          // keep last MAX_POINTS points
          while (priceChart.data.labels.length > MAX_POINTS) {
            priceChart.data.labels.shift();
            priceChart.data.datasets[0].data.shift();
          }
          // update without heavy animation
          priceChart.update("none");
        }
      } catch (e) {
        console.debug("Live update failed", e);
      }
    }, pricePollInterval);
  } catch (err) {
    console.error("Chart load error", err);
    if (chartLoader) chartLoader.style.display = "none";
    // show a minimal error message inside chart area if present
    if (chartArea) {
      chartArea.style.display = "block";
      chartTitle.textContent = `${selectedCoin?.name || coinId} — failed to load chart`;
    }
  }
}

// timeframe button handler
document.addEventListener("click", (e) => {
  if (!selectedCoin) return;
  const id = e.target && e.target.id;
  if (id === "btn1h") {
    loadChartData(selectedCoin.id, "1H");
    timeframeButtons.forEach((b) => b.classList.toggle("active", b.id === "btn1h"));
  }
  if (id === "btn6h") {
    loadChartData(selectedCoin.id, "6H");
    timeframeButtons.forEach((b) => b.classList.toggle("active", b.id === "btn6h"));
  }
  if (id === "btn1d") {
    loadChartData(selectedCoin.id, "1D");
    timeframeButtons.forEach((b) => b.classList.toggle("active", b.id === "btn1d"));
  }
});

// Resize canvas handle (helps maintain good look on mobile)
function resizeCanvasToContainer() {
  if (!priceCanvas) return;
  const parent = priceCanvas.parentElement;
  if (!parent) return;
  const style = getComputedStyle(parent);
  const height = Math.max(220, Math.min(420, parent.clientWidth * 0.55)); // responsive height
  priceCanvas.style.height = height + "px";
  if (priceChart) priceChart.resize();
}
window.addEventListener("resize", () => {
  resizeCanvasToContainer();
});

// initial render + polls
renderCoins();
fetchPrices().catch(() => {});
setInterval(fetchPrices, PRICE_REFRESH_MS);

// ensure canvas sizing initially
setTimeout(() => resizeCanvasToContainer(), 120);
