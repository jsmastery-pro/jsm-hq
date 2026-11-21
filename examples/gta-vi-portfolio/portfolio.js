const copyButton = document.querySelector('#copy-email');
const address = document.querySelector('.contact-actions a');
const status = document.querySelector('.copy-status');

if (navigator.clipboard?.writeText) {
  copyButton.hidden = false;
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(address.getAttribute('href').slice('mailto:'.length));
      status.textContent = 'Example email copied.';
    } catch {
      status.textContent = 'Copy failed. You can select the email address and copy it manually.';
    }
  });
}
