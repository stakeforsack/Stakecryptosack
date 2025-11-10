// Shared price updater (uses CoinGecko simple/price endpoint)
(() => {
  const API = 'https://api.coingecko.com/api/v3/simple/price';
  let intervalId = null;

  function formatPrice(v) {
    if (v === undefined || v === null) return '—';
    return '$' + Number(v).toLocaleString(undefined, { maximumFractionDigits: 8 });
  }

  async function fetchAndUpdate(ids) {
    if (!ids || ids.length === 0) return;
    try {
      const idsParam = encodeURIComponent(ids.join(','));
      const url = `${API}?ids=${idsParam}&vs_currencies=usd&include_24hr_change=true`;
      const res = await fetch(url);
      const data = await res.json();

      ids.forEach(id => {
        const price = data[id] && data[id].usd;
        const change = data[id] && data[id].usd_24h_change;
        // update elements by data attributes
        const priceEl = document.querySelectorAll(`[data-price-id="${id}"]`);
        priceEl.forEach(el => el.textContent = formatPrice(price));
        const changeEl = document.querySelectorAll(`[data-change-id="${id}"]`);
        changeEl.forEach(el => {
          if (typeof change === 'number') {
            const sign = change >= 0 ? '+' : '';
            el.textContent = sign + change.toFixed(2) + '%';
            el.classList.toggle('pos', change >= 0);
            el.classList.toggle('neg', change < 0);
          } else {
            el.textContent = '';
          }
        });
      });
    } catch (err) {
      console.error('MarketPrices fetch error', err);
    }
  }

  window.MarketPrices = {
    start: (ids = [], ms = 10000) => {
      if (!Array.isArray(ids) || ids.length === 0) return;
      // do initial fetch asap
      fetchAndUpdate(ids);
      if (intervalId) clearInterval(intervalId);
      intervalId = setInterval(() => fetchAndUpdate(ids), ms);
    },
    stop: () => {
      if (intervalId) clearInterval(intervalId);
      intervalId = null;
    },
    fetchNow: (ids = []) => fetchAndUpdate(ids)
  };
})();