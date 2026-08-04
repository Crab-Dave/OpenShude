async function updateSiteAccount() {
  const accountLink = document.querySelector('#site-login');
  if (!accountLink) return;

  try {
    const response = await fetch('/api/me', { credentials: 'same-origin' });
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
