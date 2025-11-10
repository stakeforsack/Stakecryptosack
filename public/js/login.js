document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('loginForm');
  const errEl = document.getElementById('loginError');
  if (!form) return;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    errEl.textContent = '';
    const formData = new FormData(form);
    const payload = {
      email: (formData.get('email') || '').toString(),
      password: (formData.get('password') || '').toString()
    };
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        errEl.textContent = j.error || `Login failed (${res.status})`;
        return;
      }
      // success: redirect to account or reload
      window.location.href = '/account.html';
    } catch (e) {
      console.error(e);
      errEl.textContent = 'Network error';
    }
  });
});