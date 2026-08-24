// client.js — logica de chamada em grupo (mesh WebRTC) + tela compartilhada
// Nenhum audio/video passa pelo servidor: o servidor so ajuda os navegadores
// a se "apresentarem" (sinalizacao). Depois disso o trafego e direto entre eles.

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  // TURN publico de teste (Open Relay Project). Ajuda quando a rede de alguem
  // bloqueia conexao direta (P2P). Para uso serio e mais estavel, crie uma
  // conta gratuita em https://www.metered.ca/tools/openrelay/ e troque aqui.
  { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
];

const screenJoin = document.getElementById("screen-join");
const screenCall = document.getElementById("screen-call");
const joinForm = document.getElementById("join-form");
const inputName = document.getElementById("input-name");
const inputRoom = document.getElementById("input-room");
const joinHint = document.getElementById("join-hint");
const btnRandomRoom = document.getElementById("btn-random-room");
const selectMic = document.getElementById("select-mic");
const selectCam = document.getElementById("select-cam");
const btnDetectDevices = document.getElementById("btn-detect-devices");

const roomNameDisplay = document.getElementById("room-name-display");
const connectionStatus = document.getElementById("connection-status");
const btnCopyLink = document.getElementById("btn-copy-link");
const videoGrid = document.getElementById("video-grid");
const debugLog = document.getElementById("debug-log");
const btnToggleLog = document.getElementById("btn-toggle-log");

const btnMic = document.getElementById("btn-mic");
const btnCam = document.getElementById("btn-cam");
const btnShare = document.getElementById("btn-share");
const btnLeave = document.getElementById("btn-leave");

let socket = null;
let myName = "";
let myRoom = "";
let localStream = null;
let screenStream = null;
let micOn = true;
let camOn = true;
let autoCamPause = false;
let wasCamOnBeforeShare = true;
const micMeterFill = document.getElementById("mic-meter-fill");

// limites de banda/CPU: camera fica leve (a call nao e o foco quando alguem
// esta jogando), tela compartilhada prioriza fluidez (fps) sobre nitidez.
const CAMERA_MAX_BITRATE = 450_000; // ~450kbps é suficiente pra 360p de webcam
const SCREEN_MAX_BITRATE = 2_500_000; // ~2.5mbps: boa leitura de tela sem pesar
const SCREEN_MAX_FRAMERATE = 30;

// id -> { pc, polite, makingOffer, ignoreOffer, name, screenStreamId }
const peers = new Map();

// preenche o campo de canal se veio de um link compartilhado (?canal=xxx)
(function prefillFromLink() {
  const params = new URLSearchParams(location.search);
  const room = params.get("canal");
  if (room) inputRoom.value = room;
})();

// camera/microfone so funcionam em paginas https:// (ou localhost). Se
// alguem abrir por http:// num IP normal, o navegador bloqueia sem avisar
// direito — aqui a gente avisa antes de a pessoa nem tentar entrar.
(function warnIfInsecureContext() {
  const isLocalhost = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
  if (location.protocol !== "https:" && !isLocalhost) {
    joinHint.textContent =
      "Este link e http:// (nao https://) — o navegador vai bloquear camera e microfone. Use o endereco https:// do tunel/Render, nao o IP direto.";
    joinHint.style.color = "var(--danger)";
  }
})();

btnRandomRoom.addEventListener("click", () => {
  inputRoom.value = randomRoomCode();
});

btnDetectDevices.addEventListener("click", detectDevices);

// Os nomes dos dispositivos só aparecem depois que o navegador autoriza
// microfone/camera pelo menos uma vez — por isso pedimos um acesso rapido
// so pra "destravar" os nomes e depois paramos os tracks na hora.
async function detectDevices() {
  const prevLabel = btnDetectDevices.textContent;
  btnDetectDevices.textContent = "Detectando…";
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    tmp.getTracks().forEach((t) => t.stop());
  } catch (err) {
    // segue mesmo sem permissao total — o navegador pode ja ter os nomes
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    fillDeviceSelect(selectMic, devices.filter((d) => d.kind === "audioinput"), "Microfone");
    fillDeviceSelect(selectCam, devices.filter((d) => d.kind === "videoinput"), "Camera");
  } catch (err) {
    console.error("nao consegui listar dispositivos:", err);
  }
  btnDetectDevices.textContent = prevLabel;
}

function fillDeviceSelect(select, list, fallbackLabel) {
  const current = select.value;
  select.innerHTML = "";
  const def = document.createElement("option");
  def.value = "";
  def.textContent = `${fallbackLabel} padrao do sistema`;
  select.appendChild(def);
  list.forEach((d, i) => {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `${fallbackLabel} ${i + 1}`;
    select.appendChild(opt);
  });
  if (list.some((d) => d.deviceId === current)) select.value = current;
}

joinForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  myName = inputName.value.trim().slice(0, 24) || "Anonimo";
  myRoom = inputRoom.value.trim().toLowerCase().slice(0, 40).replace(/\s+/g, "-");
  if (!myRoom) return;

  joinHint.textContent = "";
  try {
    localStream = await getLocalMedia();
  } catch (err) {
    joinHint.textContent =
      err.name === "NotAllowedError"
        ? "Voce bloqueou o acesso a camera/microfone. Verifique nas permissoes do navegador (icone de cadeado na barra de endereco) e tente de novo."
        : "Nao consegui acessar sua camera/microfone (" + err.name + "). Verifique as permissoes e tente de novo.";
    joinHint.style.color = "var(--danger)";
    return;
  }

  enterCallScreen();
  connectSocket();
});

async function getLocalMedia() {
  const audioConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  if (selectMic.value) audioConstraints.deviceId = { exact: selectMic.value };

  // camera propositalmente mais leve que o normal (360p/24fps): isso ja
  // corta boa parte do consumo de CPU/memoria da chamada, o que sobra pra
  // rodar jogo + tela compartilhada com folga.
  const videoConstraints = {
    width: { ideal: 640 },
    height: { ideal: 360 },
    frameRate: { ideal: 24, max: 30 },
  };
  if (selectCam.value) videoConstraints.deviceId = { exact: selectCam.value };

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: videoConstraints,
    });
    startMicMeter(stream);
    return stream;
  } catch (err) {
    // sem camera? tenta so com audio pra nao travar quem so quer falar
    const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
    startMicMeter(stream);
    return stream;
  }
}

// medidor visual do microfone: ajuda a confirmar que o audio esta sendo
// captado de verdade (util pra descobrir se o problema e o dispositivo
// errado sendo usado, por exemplo).
function startMicMeter(stream) {
  const audioTrack = stream.getAudioTracks()[0];
  if (!audioTrack || !micMeterFill) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioCtx();
    const source = audioCtx.createMediaStreamSource(new MediaStream([audioTrack]));
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);

    function tick() {
      if (audioTrack.readyState === "ended") return;
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const level = Math.max(0, Math.min(100, Math.round((avg / 90) * 100)));
      micMeterFill.style.width = (micOn ? level : 0) + "%";
      requestAnimationFrame(tick);
    }
    tick();
  } catch (err) {
    console.warn("medidor de microfone indisponivel:", err);
  }
}

function enterCallScreen() {
  screenJoin.classList.add("hidden");
  screenCall.classList.remove("hidden");
  roomNameDisplay.textContent = myRoom;
  history.replaceState(null, "", `?canal=${encodeURIComponent(myRoom)}`);
  addLocalTile();
}

btnToggleLog.addEventListener("click", () => debugLog.classList.toggle("hidden"));

function log(msg) {
  const line = document.createElement("div");
  const time = new Date().toLocaleTimeString("pt-BR", { hour12: false });
  line.textContent = `[${time}] ${msg}`;
  debugLog.appendChild(line);
  debugLog.scrollTop = debugLog.scrollHeight;
  console.log(msg);
}

function connectSocket() {
  log(`conectando ao servidor de sinalizacao (${location.origin})…`);
  socket = io();

  socket.on("connect", () => {
    connectionStatus.textContent = "conectado";
    log(`conectado ao servidor (id: ${socket.id}). entrando no canal "${myRoom}"…`);
    socket.emit("join", { room: myRoom, name: myName });
  });

  socket.on("connect_error", (err) => {
    connectionStatus.textContent = "erro de conexao";
    log(`ERRO ao conectar no servidor: ${err.message}`);
  });

  socket.on("disconnect", (reason) => {
    connectionStatus.textContent = "reconectando…";
    log(`desconectado do servidor (${reason}), tentando reconectar…`);
  });

  socket.on("existing-peers", (list) => {
    log(`ja tem ${list.length} pessoa(s) no canal: ${list.map((p) => p.name).join(", ") || "ninguem ainda"}`);
    list.forEach(({ id, name }) => createPeerConnection(id, name, true));
  });

  socket.on("peer-joined", ({ id, name }) => {
    log(`"${name}" entrou no canal — iniciando conexao de video…`);
    createPeerConnection(id, name, false);
  });

  socket.on("peer-left", ({ id }) => {
    const peer = peers.get(id);
    log(`"${peer?.name || id}" saiu do canal`);
    removePeer(id);
  });

  socket.on("signal", async ({ from, data }) => {
    const peer = peers.get(from) || createPeerConnection(from, "Convidado", false);
    await handleSignal(peer, from, data);
  });

  socket.on("meta", ({ from, type, streamId }) => {
    const peer = peers.get(from);
    if (!peer) return;
    if (type === "screen-start") {
      peer.screenStreamId = streamId;
      const existing = peer.remoteStreams && peer.remoteStreams.get(streamId);
      if (existing) renderRemoteTile(from, existing, true);
    } else if (type === "screen-stop") {
      peer.screenStreamId = null;
      removeTile(`${from}-screen`);
    }
  });
}

function randomRoomCode() {
  const words = ["luar", "raio", "eco", "trilha", "farol", "brasa", "onda", "ninho", "vento", "torre"];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  return `${pick()}-${pick()}-${Math.floor(Math.random() * 90 + 10)}`;
}

/* ---------------- WebRTC (mesh + perfect negotiation) ---------------- */

// limita bitrate/fps de um sender pra economizar CPU e memoria sem depender
// so do que o navegador decide sozinho. Silencioso se o navegador nao suportar.
async function capSender(sender, encodingOpts) {
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    Object.assign(params.encodings[0], encodingOpts);
    await sender.setParameters(params);
  } catch (err) {
    // alguns navegadores/versoes nao aceitam setParameters antes da 1a negociacao — ok ignorar
  }
}

function createPeerConnection(id, name, isInitiatorSide) {
  if (peers.has(id)) return peers.get(id);

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const peer = {
    pc,
    polite: socket.id > id, // regra deterministica e complementar dos dois lados
    makingOffer: false,
    ignoreOffer: false,
    name,
    screenStreamId: null,
    remoteStreams: new Map(),
  };
  peers.set(id, peer);

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      const sender = pc.addTrack(track, localStream);
      if (track.kind === "video") capSender(sender, { maxBitrate: CAMERA_MAX_BITRATE });
    });
  }
  if (screenStream) {
    screenStream.getTracks().forEach((track) => {
      const sender = pc.addTrack(track, screenStream);
      if (track.kind === "video") {
        capSender(sender, { maxBitrate: SCREEN_MAX_BITRATE, maxFramerate: SCREEN_MAX_FRAMERATE });
      }
    });
  }

  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      const offer = await pc.createOffer();
      if (pc.signalingState !== "stable") return;
      await pc.setLocalDescription(offer);
      socket.emit("signal", { to: id, data: { description: pc.localDescription } });
    } catch (err) {
      console.error("negociacao falhou:", err);
    } finally {
      peer.makingOffer = false;
    }
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit("signal", { to: id, data: { candidate } });
  };

  pc.oniceconnectionstatechange = () => {
    log(`conexao com "${name}": ${pc.iceConnectionState}`);
    if (["failed", "disconnected"].includes(pc.iceConnectionState)) {
      pc.restartIce && pc.restartIce();
    }
  };

  pc.ontrack = (event) => {
    const stream = event.streams[0];
    if (!stream) return;
    peer.remoteStreams.set(stream.id, stream);
    const isScreen = stream.id === peer.screenStreamId;
    renderRemoteTile(id, stream, isScreen);

    event.track.addEventListener("ended", () => {
      if (stream.id === peer.screenStreamId) removeTile(`${id}-screen`);
    });
  };

  return peer;
}

async function handleSignal(peer, from, data) {
  const { pc } = peer;
  try {
    if (data.description) {
      const desc = data.description;
      const offerCollision =
        desc.type === "offer" && (peer.makingOffer || pc.signalingState !== "stable");
      peer.ignoreOffer = !peer.polite && offerCollision;
      if (peer.ignoreOffer) return;

      await pc.setRemoteDescription(desc);
      if (desc.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("signal", { to: from, data: { description: pc.localDescription } });
      }
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (err) {
        if (!peer.ignoreOffer) console.error("erro ao adicionar ICE candidate:", err);
      }
    }
  } catch (err) {
    console.error("erro de sinalizacao:", err);
  }
}

function removePeer(id) {
  const peer = peers.get(id);
  if (!peer) return;
  peer.pc.close();
  peers.delete(id);
  removeTile(id);
  removeTile(`${id}-screen`);
}

/* ---------------- UI: grade de video ---------------- */

function addLocalTile() {
  const tile = buildTile("local", `${myName} (voce)`, true);
  videoGrid.appendChild(tile.wrapper);
  attachStreamToTile(tile, localStream, true);
}

function renderRemoteTile(peerId, stream, isScreen) {
  const tileId = isScreen ? `${peerId}-screen` : peerId;
  const peer = peers.get(peerId);
  const label = isScreen ? `${peer?.name || "Convidado"} — tela` : peer?.name || "Convidado";

  let tile = getTileParts(tileId);
  if (!tile) {
    tile = buildTile(tileId, label, false, isScreen);
    videoGrid.appendChild(tile.wrapper);
  } else {
    tile.labelEl.textContent = label;
  }
  attachStreamToTile(tile, stream, false);
}

function buildTile(id, label, isLocal, isScreen) {
  const wrapper = document.createElement("div");
  wrapper.className = "tile" + (isScreen ? " tile-screen" : "");
  wrapper.dataset.tileId = id;
  wrapper.tabIndex = 0;

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  if (isLocal) video.muted = true;

  const labelEl = document.createElement("div");
  labelEl.className = "tile-label";
  labelEl.textContent = label;

  const expandBtn = document.createElement("button");
  expandBtn.type = "button";
  expandBtn.className = "tile-expand";
  expandBtn.title = "Tela cheia";
  expandBtn.textContent = "⛶";
  expandBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleTileFullscreen(wrapper);
  });
  wrapper.addEventListener("dblclick", () => toggleTileFullscreen(wrapper));

  wrapper.appendChild(video);
  wrapper.appendChild(labelEl);
  wrapper.appendChild(expandBtn);

  return { wrapper, video, labelEl };
}

function toggleTileFullscreen(wrapper) {
  if (document.fullscreenElement === wrapper) {
    document.exitFullscreen();
  } else if (wrapper.requestFullscreen) {
    wrapper.requestFullscreen().catch(() => {});
  } else if (wrapper.webkitRequestFullscreen) {
    wrapper.webkitRequestFullscreen();
  }
}

function getTileParts(id) {
  const wrapper = videoGrid.querySelector(`[data-tile-id="${cssEscape(id)}"]`);
  if (!wrapper) return null;
  return {
    wrapper,
    video: wrapper.querySelector("video"),
    labelEl: wrapper.querySelector(".tile-label"),
  };
}

function attachStreamToTile(tile, stream, isLocal) {
  tile.video.srcObject = stream;
  const hasVideoTrack = stream.getVideoTracks().length > 0 && stream.getVideoTracks()[0].enabled;
  tile.wrapper.classList.toggle("no-video", !hasVideoTrack);
}

function removeTile(id) {
  const el = videoGrid.querySelector(`[data-tile-id="${cssEscape(id)}"]`);
  if (el) el.remove();
}

function cssEscape(str) {
  return String(str).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

/* ---------------- controles ---------------- */

btnMic.addEventListener("click", () => {
  if (!localStream) return;
  micOn = !micOn;
  localStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
  btnMic.classList.toggle("is-off", !micOn);
  btnMic.querySelector(".ctrl-icon").textContent = micOn
    ? btnMic.querySelector(".ctrl-icon").dataset.on
    : btnMic.querySelector(".ctrl-icon").dataset.off;
});

function setCameraEnabled(on) {
  camOn = on;
  if (localStream) localStream.getVideoTracks().forEach((t) => (t.enabled = camOn));
  btnCam.classList.toggle("is-off", !camOn);
  const icon = btnCam.querySelector(".ctrl-icon");
  icon.textContent = camOn ? icon.dataset.on : icon.dataset.off;
  const localTile = getTileParts("local");
  if (localTile) localTile.wrapper.classList.toggle("no-video", !camOn);
}

btnCam.addEventListener("click", () => {
  if (!localStream) return;
  setCameraEnabled(!camOn);
});

btnShare.addEventListener("click", async () => {
  if (screenStream) {
    stopScreenShare();
    return;
  }
  try {
    // audio:true faz o navegador oferecer a opcao "compartilhar audio" no
    // seletor de tela (precisa marcar essa caixinha na hora de escolher).
    screenStream = await navigator.mediaDevices.getDisplayMedia({
  video: {
  frameRate: { ideal: 60, max: 60 },
    width: { ideal: 1920 },
    height: { ideal: 1080 }
  },
  audio: true // ou false se não quiser som
});
  } catch (err) {
    return; // usuario cancelou o seletor de tela
  }

  const screenVideoTrack = screenStream.getVideoTracks()[0];
  // 'motion' pede pro codec priorizar fluidez (fps) sobre nitidez de detalhe
  // fino — ideal pra jogo em movimento e mais leve pra CPU do que 'detail'.
  if (screenVideoTrack) screenVideoTrack.contentHint = "motion";

  screenStream.getTracks().forEach((track) => {
    peers.forEach((peer) => {
      const sender = peer.pc.addTrack(track, screenStream);
      if (track.kind === "video") {
     capSender(sender, { maxBitrate: 4000000, maxFramerate: 60 });
      }
    });
  });
  socket.emit("meta", { type: "screen-start", streamId: screenStream.id });

  const localScreenTile = buildTile("local-screen", `${myName} (sua tela)`, true, true);
  videoGrid.prepend(localScreenTile.wrapper);
  attachStreamToTile(localScreenTile, screenStream, true);

  // pausa a camera automaticamente enquanto compartilha: sobra CPU/memoria
  // pro jogo e pra codificar a tela com fps melhor. A camera volta sozinha
  // quando parar de compartilhar (se estava ligada antes).
  wasCamOnBeforeShare = camOn;
  if (camOn) {
    autoCamPause = true;
    setCameraEnabled(false);
  }

  btnShare.classList.add("is-active");
  if (screenVideoTrack) screenVideoTrack.addEventListener("ended", stopScreenShare);
});

function stopScreenShare() {
  if (!screenStream) return;
  const tracks = screenStream.getTracks();

  peers.forEach((peer) => {
    tracks.forEach((track) => {
      const sender = peer.pc.getSenders().find((s) => s.track === track);
      if (sender) peer.pc.removeTrack(sender);
    });
  });

  tracks.forEach((t) => t.stop());
  screenStream = null;
  removeTile("local-screen");
  btnShare.classList.remove("is-active");
  if (socket) socket.emit("meta", { type: "screen-stop" });

  if (autoCamPause && wasCamOnBeforeShare) setCameraEnabled(true);
  autoCamPause = false;
}

btnCopyLink.addEventListener("click", async () => {
  const url = `${location.origin}${location.pathname}?canal=${encodeURIComponent(myRoom)}`;
  try {
    await navigator.clipboard.writeText(url);
    const old = btnCopyLink.textContent;
    btnCopyLink.textContent = "link copiado!";
    setTimeout(() => (btnCopyLink.textContent = old), 1600);
  } catch (err) {
    prompt("Copie o link do canal:", url);
  }
});

btnLeave.addEventListener("click", () => {
  window.location.href = location.pathname; // recarrega limpo, encerra tudo
});

window.addEventListener("beforeunload", () => {
  if (socket) socket.emit("leave");
});
const container = document.querySelector('.video-container');

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    container.requestFullscreen().catch(err => {
      console.error(`Erro ao entrar em tela cheia: ${err.message}`);
    });
  } else {
    document.exitFullscreen();
  }
}

function handleFullscreenChange() {
  const isFullscreen = !!document.fullscreenElement;
  document.querySelectorAll('video').forEach(video => {
    if (isFullscreen) {
      video.style.width = '100%';
      video.style.height = '100%';
    } else {
      video.style.width = '';
      video.style.height = '';
    }
  });
}

document.addEventListener('fullscreenchange', handleFullscreenChange);
document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
document.addEventListener('mozfullscreenchange', handleFullscreenChange);
// ===== FULLSCREEN FIX - La Volte =====
(function () {
  const screenCall = document.getElementById('screen-call');
  const videoGrid = document.getElementById('video-grid');
  function adjustVideoAspectRatios() {
    if (!videoGrid) return;
    const videos = videoGrid.querySelectorAll('video');
    videos.forEach((video) => {
      if (video.readyState >= 1 && video.videoWidth && video.videoHeight) {
        video.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
      } else {
        video.addEventListener('loadedmetadata', () => {
          video.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
        }, { once: true });
      }
    });
  }
  function handleFullscreenChange() {
    const isFullscreen = !!(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement
    );
    if (isFullscreen && videoGrid) {
      adjustVideoAspectRatios();
    }
  }
  document.addEventListener('fullscreenchange', handleFullscreenChange);
  document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
  document.addEventListener('mozfullscreenchange', handleFullscreenChange);
  if (videoGrid) {
    const observer = new MutationObserver(() => adjustVideoAspectRatios());
    observer.observe(videoGrid, { childList: true });
  }
})();
