(() => {
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  function apply(value) {
    root.dataset.theme = ['light', 'dark', 'auto'].includes(value) ? value : 'auto';
    const dark = root.dataset.theme === 'dark' || (root.dataset.theme === 'auto' && media.matches);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', dark ? '#0a0a0a' : '#ffffff');
  }
  try {
    apply(localStorage.getItem('orbit-theme') || 'auto');
  } catch {
    apply('auto');
  }
  media.addEventListener('change', () => apply(root.dataset.theme));
  window.addEventListener('orbit-theme-change', () => apply(root.dataset.theme));
  window.addEventListener('storage', (event) => {
    if (event.key === 'orbit-theme') {
      apply(event.newValue || 'auto');
      window.dispatchEvent(new Event('orbit-theme-change'));
    }
  });
})();
