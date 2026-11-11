const device = document.querySelector('#device');
const host = document.querySelector('#host');
const stop = document.querySelector('#stop');
const find = document.querySelector('#find');
const result = document.querySelector('#result');
let room;

async function request(path, method = 'GET') {
  const response = await fetch('/desktop/' + path, { method });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Локальная служба недоступна');
  return body;
}

function updateRoom(value) {
  room = value;
  host.textContent = room ? 'Открыть комнату' : 'Создать комнату';
  stop.hidden = !room;
}

async function run(button, task) {
  button.disabled = true;
  result.textContent = '';
  try {
    await task();
  } catch (error) {
    result.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

const copy = document.querySelector('#copy');
copy.addEventListener('click', () => run(copy, async () => {
  await navigator.clipboard.writeText(device.value);
  result.textContent = 'ID скопирован.';
}));
host.addEventListener('click', () => run(host, async () => {
  if (!room) updateRoom((await request('host', 'POST')).room);
  location.assign(`/?desktop=host#${room}`);
}));
stop.addEventListener('click', () => run(stop, async () => {
  await request('stop', 'POST');
  updateRoom(undefined);
  result.textContent = 'Комната закрыта.';
}));
find.addEventListener('submit', (event) => {
  event.preventDefault();
  run(find.querySelector('button'), async () => {
    const id = document.querySelector('#friend').value.trim().toLowerCase();
    const address = document.querySelector('#address').value.trim();
    result.textContent = 'Ищем устройство…';
    const params = new URLSearchParams({ id, address });
    const found = await request(`find?${params}`, 'POST');
    location.assign(`/?device=${id}#${found.room}`);
  });
});

try {
  const info = await request('device');
  device.value = info.id;
  updateRoom(info.room);
} catch {
  result.textContent = 'Запустите Myrlo через start-desktop.bat.';
}
