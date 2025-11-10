// Call submitDeposit(coin, amount) from your deposit page.
// Example: document.getElementById('submitBtn').addEventListener('click', () => submitDeposit('BTC', 0.01));

async function submitDeposit(coin, amount) {
  try {
    const res = await fetch('/deposit', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coin, amount })
    });

    let payload;
    try {
      payload = await res.json();
    } catch (e) {
      const txt = await res.text().catch(() => '<no-body>');
      throw new Error(`Server returned non-JSON response (${res.status}): ${txt}`);
    }

    if (!res.ok || !payload.ok) {
      const msg = (payload && payload.error) || `Deposit failed (${res.status})`;
      throw new Error(msg);
    }

    // ensure coin/address present
    payload.coin = payload.coin || coin;
    payload.address = payload.address || payload.addr || payload.address_str || '';

    // save for result page and redirect
    try {
      sessionStorage.setItem('lastDeposit', JSON.stringify(payload));
      window.location.href = '/deposit-result.html';
    } catch (e) {
      // fallback to query params if sessionStorage unavailable
      const q = new URLSearchParams({ coin: payload.coin || '', address: payload.address || '' }).toString();
      window.location.href = '/deposit-result.html?' + q;
    }
  } catch (err) {
    console.error('deposit submit error', err);
    // show a simple alert; replace with UI error element if you have one
    alert(err.message || 'Deposit failed');
  }
}

// expose to global so HTML can call it directly
window.submitDeposit = submitDeposit;