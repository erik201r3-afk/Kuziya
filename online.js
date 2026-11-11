const create = document.querySelector('#create');
const lookup = document.querySelector('#lookup');
const message = document.querySelector('#message');
const params = new URLSearchParams(location.search);
if (params.has('local')) {
  document.querySelector('#local-only').hidden = false;
  document.querySelector('#service-settings').hidden = false;
  document.querySelector('#endpoint').value = params.get('endpoint') || '';
}

async function run(button, action) {
  button.disabled = true;
  message.textContent = '';
  try {
    await action();
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

create.addEventListener('click', () => run(create, async () => {
  const response = await fetch('/online/create', { method: 'POST' });
  if (!response.ok) throw new Error('Не удалось создать комнату. Попробуйте ещё раз.');
  const { code, owner } = await response.json();
  sessionStorage.setItem(`owner:${code}`, owner);
  location.assign(`/room#${code}`);
}));

lookup.addEventListener('submit', (event) => {
  event.preventDefault();
  run(lookup.querySelector('button'), async () => {
    const input = document.querySelector('#code').value.trim();
    if (input.startsWith('https://')) {
      const invite = new URL(input);
      if (invite.username || invite.password || invite.pathname !== '/room'
        || invite.search || !/^#[a-f0-9]{32}$/.test(invite.hash)) {
        throw new Error('Вставьте полную ссылку-приглашение Kuziya.');
      }
      location.assign(invite.href);
      return;
    }
    const code = input.toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(code)) throw new Error('Вставьте полный код комнаты.');
    const response = await fetch(`/online/check?code=${code}`);
    if (!response.ok) throw new Error('Комната закрыта или код истёк.');
    location.assign(`/room#${code}`);
  });
});

const service = document.querySelector('#service');
service.addEventListener('submit', (event) => {
  event.preventDefault();
  run(service.querySelector('button'), async () => {
    const endpoint = new URL(document.querySelector('#endpoint').value.trim());
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password
      || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
      throw new Error('Укажите HTTPS-адрес сервиса Kuziya.');
    }
    location.assign(endpoint.origin);
  });
});
