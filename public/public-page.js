function readCsrfCookie() {
  const item = document.cookie.split('; ').find((cookie) => cookie.startsWith('csrf_token='));
  return item ? decodeURIComponent(item.slice('csrf_token='.length)) : '';
}

async function loadSession() {
  let response = await fetch('/api/me', { credentials: 'same-origin' });
  if (response.status !== 401) return response;
  const failure = await response.clone().json().catch(() => ({}));
  if (failure.error?.code !== 'ACCESS_TOKEN_EXPIRED') return response;
  const refreshed = await fetch('/api/auth/refresh', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-CSRF-Token': readCsrfCookie() },
  });
  const refreshFailure = refreshed.ok ? {} : await refreshed.json().catch(() => ({}));
  if (!refreshed.ok && !(refreshed.status === 409 && refreshFailure.error?.code === 'REFRESH_ALREADY_ROTATED')) {
    return response;
  }
  response = await fetch('/api/me', { credentials: 'same-origin' });
  return response;
}

async function updateSiteAccount() {
  const accountLink = document.querySelector('#site-login');
  if (!accountLink) return;

  try {
    const response = await loadSession();
    if (!response.ok) return;
    const session = await response.json();
    if (!session.user) return;
    accountLink.href = '/roommates';
    accountLink.textContent = '进入系统';
    accountLink.setAttribute('aria-label', `已登录为${session.user.name}，进入室友双选系统`);
  } catch {
    // Network failures leave the anonymous login action available.
  }
}

updateSiteAccount();
