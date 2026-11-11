const joinForm = document.querySelector('#join');
const nameInput = document.querySelector('#name');
const actions = document.querySelector('#actions');
const status = document.querySelector('#status');
const invite = document.querySelector('#invite');
const inviteLink = document.querySelector('#invite-link');
const retry = document.querySelector('#retry');
const mic = document.querySelector('#mic');
const share = document.querySelector('#share');
const peers = new Map();

let events;
let session;
let microphone;
let screen;
let localPreview;
let iceServers = [];
const screenBitrate = 650000;
const frameRate = 15;

function roomId() {
  const fragment = location.hash.slice(1);
  if (/^[a-f0-9]{32}$/.test(fragment)) return fragment;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  history.replaceState(null, '', `#${id}`);
  return id;
}

const room = roomId();
const internetRoom = location.pathname === '/room';
const closeRoom = document.querySelector('#close-room');
const owner = internetRoom ? sessionStorage.getItem(`owner:${room}`) : null;
if (internetRoom) {
  const back = document.querySelector('#devices');
  back.href = '/';
  back.textContent = 'К интернет-комнатам';
  back.hidden = false;
  invite.textContent = 'Скопировать код';
  inviteLink.hidden = false;
  closeRoom.hidden = !owner;
}
const params = new URLSearchParams(location.search);
const device = params.get('device') || '';
const signalPath = /^[a-f0-9]{32}$/.test(device) ? `/lan/${device}` : '';
if (signalPath || params.get('desktop') === 'host') {
  invite.hidden = true;
  document.querySelector('#devices').hidden = false;
}

function relay(peer, type, data) {
  const token = session?.token;
  if (!token || peers.get(peer.id) !== peer) return Promise.resolve();
  return fetch(`${signalPath}/signal`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: peer.id, type, data }),
  }).then((response) => {
    if (!response.ok && peers.get(peer.id) === peer) throw new Error('Сигнал не доставлен');
  });
}

function enqueue(peer, task) {
  peer.pending = peer.pending.then(async () => {
    if (peers.get(peer.id) === peer) await task();
  }).catch(() => {
    if (peers.get(peer.id) === peer) {
      markConnection(peer, 'failed', 'Ошибка обмена данными для звонка.');
    }
  });
}

function removePeer(id) {
  const peer = peers.get(id);
  if (!peer) return;
  peers.delete(id);
  clearTimeout(peer.deadline);
  peer.connection.close();
  peer.element.remove();
  updateRetry();
}

function updateRetry() {
  retry.hidden = !events || ![...peers.values()].some((peer) => peer.element.dataset.connection === 'failed');
}

function markConnection(peer, state, text) {
  peer.element.dataset.connection = state;
  peer.state.textContent = text;
  updateRetry();
}

function updateViewer(peer) {
  peer.video.hidden = !peer.sharing || !peer.watching;
  peer.toggle.hidden = !peer.sharing;
  peer.toggle.textContent = peer.watching ? 'Приостановить экран' : 'Смотреть экран';
}

async function syncMedia(peer) {
  if (!peer.audioSender || !peer.videoSender) return;
  await peer.audioSender.replaceTrack(microphone || null);
  const track = peer.subscribed ? screen : null;
  const sender = peer.videoSender;
  if (sender.track === (track || null)) return;

  if (track) {
    const params = sender.getParameters();
    if (params.encodings.length) {
      params.encodings[0].maxBitrate = screenBitrate;
      params.encodings[0].maxFramerate = frameRate;
      await sender.setParameters(params);
    }
  }
  await sender.replaceTrack(track || null);
}

function createPeer({ id, name }, offerer = false) {
  const connection = new RTCPeerConnection({ iceServers });
  const element = document.createElement('article');
  const title = document.createElement('h2');
  const state = document.createElement('p');
  const audio = document.createElement('audio');
  const video = document.createElement('video');
  const toggle = document.createElement('button');
  title.textContent = name;
  state.textContent = 'Соединяем…';
  audio.autoplay = true;
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  toggle.type = 'button';
  element.append(title, state, audio, toggle, video);
  document.querySelector('#peers').append(element);

  const peer = {
    id, connection, element, state, video, toggle, offerer,
    sharing: false, watching: true, subscribed: true,
    pending: Promise.resolve(), candidates: [],
  };
  peers.set(id, peer);
  peer.deadline = setTimeout(() => {
    if (peer.connection.connectionState !== 'connected') {
      markConnection(peer, 'failed', 'Голос и экран не подключились. Попробуйте переподключиться.');
    }
  }, 20000);
  updateViewer(peer);

  toggle.addEventListener('click', () => {
    peer.watching = !peer.watching;
    updateViewer(peer);
    enqueue(peer, () => relay(peer, 'subscribe', peer.watching));
  });
  connection.addEventListener('track', ({ track }) => {
    const player = track.kind === 'audio' ? audio : video;
    player.srcObject = new MediaStream([track]);
    if (player === audio) {
      audio.play().catch(() => {
        audio.controls = true;
      });
    }
  });
  connection.addEventListener('icecandidate', ({ candidate }) => {
    if (candidate) enqueue(peer, () => relay(peer, 'candidate', candidate.toJSON()));
  });
  connection.addEventListener('connectionstatechange', () => {
    const states = {
      connected: 'На связи',
      connecting: 'Соединяем…',
      disconnected: 'Связь прервалась. Ждём восстановления…',
      failed: 'Связь потеряна. Выйдите и войдите снова.',
    };
    const phase = connection.connectionState;
    if (phase === 'connected') clearTimeout(peer.deadline);
    markConnection(peer, phase === 'disconnected' ? 'failed' : phase, states[phase] || 'Соединяем…');
    if (connection.connectionState === 'failed' && peer.offerer && !peer.restarted) {
      peer.restarted = true;
      enqueue(peer, () => offer(peer, { iceRestart: true }));
    }
    if (connection.connectionState === 'connected') peer.restarted = false;
  });

  if (offerer) {
    peer.audioSender = connection.addTransceiver('audio').sender;
    peer.videoSender = connection.addTransceiver('video', {
      sendEncodings: [{ maxBitrate: screenBitrate, maxFramerate: frameRate }],
    }).sender;
    enqueue(peer, () => offer(peer));
  }
  return peer;
}

async function offer(peer, options) {
  const { connection } = peer;
  await connection.setLocalDescription(await connection.createOffer(options));
  await syncMedia(peer);
  await relay(peer, 'description', connection.localDescription.toJSON());
  await relay(peer, 'sharing', Boolean(screen));
}

async function handleSignal(peer, { type, data }) {
  const { connection } = peer;
  if (type === 'description') {
    await connection.setRemoteDescription(data);
    for (const candidate of peer.candidates.splice(0)) await connection.addIceCandidate(candidate);
    if (data.type === 'offer') {
      const [audio, video] = connection.getTransceivers();
      audio.direction = 'sendrecv';
      video.direction = 'sendrecv';
      peer.audioSender = audio.sender;
      peer.videoSender = video.sender;
      await connection.setLocalDescription(await connection.createAnswer());
      await syncMedia(peer);
      await relay(peer, 'description', connection.localDescription.toJSON());
      await relay(peer, 'sharing', Boolean(screen));
    }
  } else if (type === 'candidate') {
    if (connection.remoteDescription) await connection.addIceCandidate(data);
    else peer.candidates.push(data);
  } else if (type === 'sharing') {
    peer.sharing = data === true;
    updateViewer(peer);
  } else if (type === 'subscribe') {
    peer.subscribed = data === true;
    await syncMedia(peer);
  }
}

function connect(name) {
  const source = new EventSource(`${signalPath}/events?${new URLSearchParams({ room, name })}`);
  events = source;
  status.textContent = 'Подключаемся…';
  source.addEventListener('welcome', (event) => {
    for (const id of peers.keys()) removePeer(id);
    session = JSON.parse(event.data);
    iceServers = session.iceServers;
    for (const peer of session.peers) createPeer(peer, true);
    status.textContent = session.turnUnavailable
      ? 'Ретранслятор недоступен. Пробуем прямое соединение.'
      : 'Вы в комнате. Микрофон и экран включаются вручную.';
  });
  source.addEventListener('joined', (event) => createPeer(JSON.parse(event.data)));
  source.addEventListener('left', (event) => removePeer(JSON.parse(event.data).id));
  source.addEventListener('signal', (event) => {
    const message = JSON.parse(event.data);
    const peer = peers.get(message.from);
    if (peer) enqueue(peer, () => handleSignal(peer, message));
  });
  source.addEventListener('expired', () => {
    leave();
    closeRoom.hidden = true;
    status.textContent = 'Комната закрыта или код истёк.';
  });
  source.addEventListener('closed', () => {
    leave();
    closeRoom.hidden = true;
    status.textContent = 'Комната закрыта.';
  });
  source.addEventListener('full', () => {
    leave();
    status.textContent = 'В комнате уже четыре участника.';
  });
  source.onerror = async () => {
    if (events !== source) return;
    status.textContent = 'Связь с сервером прервалась. Переподключаемся…';
    if (!internetRoom) return;
    const response = await fetch('/online/health', { signal: AbortSignal.timeout(4000) })
      .catch(() => null);
    if (events === source && source.readyState !== EventSource.OPEN
      && response?.headers.get('X-Kuziya-Service') !== '1') {
      status.textContent = 'Адрес комнаты недоступен. Перезапустите Kuziya и откройте свежую ссылку.';
    }
  };
}

function showMicState() {
  mic.textContent = microphone ? 'Выключить микрофон' : 'Включить микрофон';
  mic.setAttribute('aria-pressed', String(Boolean(microphone)));
}

function stopScreen() {
  const track = screen;
  screen = undefined;
  track?.stop();
  localPreview?.remove();
  localPreview = undefined;
  share.textContent = 'Показать экран';
  share.setAttribute('aria-pressed', 'false');
  for (const peer of peers.values()) {
    enqueue(peer, async () => {
      await syncMedia(peer);
      await relay(peer, 'sharing', Boolean(screen));
    });
  }
}

function leave() {
  events?.close();
  events = undefined;
  session = undefined;
  for (const id of peers.keys()) removePeer(id);
  microphone?.stop();
  microphone = undefined;
  showMicState();
  stopScreen();
  actions.hidden = true;
  joinForm.hidden = false;
  status.textContent = 'Вы вышли из комнаты.';
}

joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!nameInput.value.trim()) return;
  if (!isSecureContext || !navigator.mediaDevices?.getDisplayMedia) {
    status.textContent = 'Для микрофона и экрана откройте комнату в Chrome или Edge через HTTPS или localhost.';
    return;
  }
  joinForm.hidden = true;
  actions.hidden = false;
  connect(nameInput.value.trim());
});
document.querySelector('#leave').addEventListener('click', leave);
retry.addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!events || !name) return;
  events.close();
  session = undefined;
  for (const id of peers.keys()) removePeer(id);
  connect(name);
});

inviteLink.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    inviteLink.textContent = 'Ссылка скопирована';
  } catch {
    status.textContent = 'Скопируйте ссылку из адресной строки браузера.';
  }
});

invite.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(internetRoom ? room : location.href);
    invite.textContent = internetRoom ? 'Код скопирован' : 'Приглашение скопировано';
  } catch {
    status.textContent = internetRoom ? 'Код комнаты: ' + room : 'Скопируйте ссылку из адресной строки.';
  }
});

closeRoom.addEventListener('click', async () => {
  closeRoom.disabled = true;
  try {
    const response = await fetch(`/online/close?code=${room}`, {
      method: 'POST', headers: { Authorization: `Bearer ${owner}` },
    });
    if (!response.ok) throw new Error('Не удалось закрыть комнату.');
    sessionStorage.removeItem(`owner:${room}`);
    leave();
    closeRoom.hidden = true;
    status.textContent = 'Комната закрыта.';
  } catch (error) {
    status.textContent = error.message;
  } finally {
    closeRoom.disabled = false;
  }
});

mic.addEventListener('click', async () => {
  const currentRoom = events;
  mic.disabled = true;
  try {
    if (microphone) {
      microphone.stop();
      microphone = undefined;
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
      const [track] = stream.getAudioTracks();
      if (events !== currentRoom) {
        track.stop();
        return;
      }
      microphone = track;
      track.addEventListener('ended', () => {
        if (microphone === track) {
          microphone = undefined;
          showMicState();
          for (const peer of peers.values()) enqueue(peer, () => syncMedia(peer));
        }
      });
    }
    showMicState();
    for (const peer of peers.values()) enqueue(peer, () => syncMedia(peer));
  } catch {
    status.textContent = 'Не удалось включить микрофон. Проверьте разрешение браузера.';
  } finally {
    mic.disabled = false;
  }
});

share.addEventListener('click', async () => {
  if (screen) {
    stopScreen();
    return;
  }
  const currentRoom = events;
  share.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { max: 1280 },
        height: { max: 720 },
        frameRate: { max: frameRate },
      },
      audio: false,
    });
    const [track] = stream.getVideoTracks();
    if (events !== currentRoom) {
      track.stop();
      return;
    }
    screen = track;
    track.contentHint = 'detail';
    track.addEventListener('ended', stopScreen, { once: true });
    localPreview = document.createElement('article');
    const title = document.createElement('h2');
    title.textContent = 'Вы показываете экран';
    localPreview.append(title);
    document.querySelector('#peers').prepend(localPreview);
    share.textContent = 'Остановить показ';
    share.setAttribute('aria-pressed', 'true');
    for (const peer of peers.values()) {
      enqueue(peer, async () => {
        await syncMedia(peer);
        await relay(peer, 'sharing', Boolean(screen));
      });
    }
  } catch {
    status.textContent = 'Показ экрана не запущен.';
  } finally {
    share.disabled = false;
  }
});

window.addEventListener('pagehide', leave);



