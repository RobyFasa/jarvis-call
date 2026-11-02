"use strict";

const tg = window.Telegram && window.Telegram.WebApp;
const query = new URLSearchParams(location.search);
const fragment = new URLSearchParams(location.hash.slice(1));
let key = fragment.get("k") || query.get("k");
query.delete("k");
fragment.delete("k");
// La chiave resta solo in memoria, fuori dalla cronologia e dagli URL copiati.
const cleanHash = fragment.toString();
history.replaceState(null, "", `${location.pathname}?${query}${cleanHash ? `#${cleanHash}` : ""}`);
const nonce = query.get("n");
const minutes = Number(query.get("m"));
const validParams = key && nonce && Number.isInteger(minutes) && minutes >= 1 && minutes <= 30;
const $ = (id) => document.getElementById(id);
const status = $("status");
const hint = $("hint");
const start = $("start");
const mute = $("mute");
const close = $("close");
const audio = $("remote-audio");
const audioButton = $("enable-audio");
const requests = [];
const REQUESTS_STORAGE_KEY = "jarvis-call-requests";
const USED_NONCES_STORAGE_KEY = "jarvis-call-used-nonces";
const toolResults = new Map();
let pc, dc, localStream, remoteStream, audioContext, analyser, animation, ticker;
let connectTimeout, goodbyeTimeout, abortController;
let startedAt = null;
let stoppedSeconds = null;
let attempted = false;
let closed = false;
let failed = false;
let warned = false;
let sayingGoodbye = false;
let audioPlaying = false;
let responseActive = false;
const responseQueue = [];

if (tg) {
  tg.ready();
  tg.expand();
}
if (!validParams) {
  status.textContent = "Apra la chiamata dal pulsante in chat (/chiama).";
  hint.textContent = "Il collegamento della chiamata non è completo.";
  start.disabled = true;
} else {
  restoreRequests();
  if (usedNonces().includes(nonce)) blockUsedButton();
}

function readStorage(storageKey) {
  try { return JSON.parse(localStorage.getItem(storageKey)); }
  catch { return null; }
}

function saveRequests() {
  try {
    localStorage.setItem(REQUESTS_STORAGE_KEY, JSON.stringify({ n: nonce, requests, at: Date.now() }));
  } catch { /* Alcuni client non consentono localStorage. */ }
}

function usedNonces() {
  const saved = readStorage(USED_NONCES_STORAGE_KEY);
  return Array.isArray(saved) ? saved.filter((value) => typeof value === "string") : [];
}

function blockUsedButton() {
  closed = true;
  start.disabled = true;
  status.textContent = "Questo pulsante è già stato usato. Chieda una nuova chiamata in chat con /chiama.";
}

function restoreRequests() {
  const saved = readStorage(REQUESTS_STORAGE_KEY);
  if (!saved || typeof saved.n !== "string" || !Array.isArray(saved.requests)
      || !Number.isFinite(saved.at) || Date.now() - saved.at < 0
      || Date.now() - saved.at >= 24 * 60 * 60 * 1000) return;
  const remaining = [];
  for (const text of saved.requests) {
    if (typeof text !== "string" || !text.trim() || [...text].length > 500) continue;
    if (requests.length < 10 && fitsRequests([...requests, text])) requests.push(text);
    else remaining.push(text);
  }
  if (requests.length) showFallback(saved.n === nonce
    ? "Copi queste richieste nella chat con Jarvis."
    : "Dall'ultima chiamata erano rimaste queste richieste: le invio con questa.");
  if (remaining.length) {
    $("result").hidden = false;
    $("result-hint").textContent += " Queste non entrano: le ripeta in chat: " + remaining.join("; ");
  }
}

function send(event) {
  if (dc && dc.readyState === "open") dc.send(JSON.stringify(event));
}

function requestResponse(response = null) {
  if (closed || failed || sayingGoodbye) return;
  if (responseActive) {
    if (response || !responseQueue.includes(null)) responseQueue.push(response);
    return;
  }
  responseActive = true;
  send(response ? { type: "response.create", response } : { type: "response.create" });
}

function elapsed() {
  if (stoppedSeconds !== null) return stoppedSeconds;
  return startedAt === null ? 0 : Math.min(3600, Math.ceil((performance.now() - startedAt) / 1000));
}

function updateTimer() {
  const seconds = elapsed();
  $("timer").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  if (seconds >= minutes * 60) {
    finish();
  } else if (!warned && seconds >= (minutes - 1) * 60) {
    warned = true;
    requestResponse({
      instructions: "Avvisi brevemente il proprietario che manca un minuto alla fine della chiamata."
    });
  }
}

function cleanup() {
  clearInterval(ticker);
  clearTimeout(connectTimeout);
  clearTimeout(goodbyeTimeout);
  cancelAnimationFrame(animation);
  if (abortController) abortController.abort();
  if (dc) dc.close();
  if (pc) pc.close();
  for (const stream of [localStream, remoteStream]) {
    if (stream) stream.getTracks().forEach((track) => track.stop());
  }
  audio.pause();
  audio.srcObject = null;
  if (audioContext) audioContext.close().catch(() => {});
  $("orb").style.setProperty("--level", "0");
  mute.disabled = true;
  audioButton.hidden = true;
  if (tg && tg.disableClosingConfirmation) tg.disableClosingConfirmation();
}

function showFallback(message) {
  $("result").hidden = false;
  $("result-hint").textContent = message;
  const list = $("requests");
  list.replaceChildren();
  for (const text of requests) {
    const item = document.createElement("li");
    item.textContent = text;
    list.appendChild(item);
  }
  if (!requests.length) $("result-hint").textContent += " Non ci sono richieste annotate.";
}

function fitsRequests(items) {
  const payload = { v: 1, n: nonce, secs: 3600, requests: items };
  return new TextEncoder().encode(JSON.stringify(payload)).length <= 4096;
}

function finish() {
  if (closed) return;
  closed = true;
  stoppedSeconds = elapsed();
  cleanup();
  start.hidden = true;
  $("controls").hidden = true;
  status.textContent = "Chiamata chiusa";
  hint.textContent = "Le richieste annotate passano ora alla chat.";
  const payload = { v: 1, n: nonce, secs: stoppedSeconds, requests: [...requests] };
  const encoder = new TextEncoder();
  if (tg && typeof tg.sendData === "function" && encoder.encode(JSON.stringify(payload)).length <= 4096) {
    try {
      tg.sendData(JSON.stringify(payload));
      try { localStorage.removeItem(REQUESTS_STORAGE_KEY); } catch { /* Storage non disponibile. */ }
      // sendData chiude la mini-app soltanto se aperta dalla tastiera di risposta.
      showFallback("Se la finestra resta aperta, copi queste richieste nella chat con Jarvis.");
      return;
    } catch {
      // Il client può non supportare il ritorno dati: le richieste rimangono recuperabili.
    }
  }
  showFallback("Copi queste richieste nella chat con Jarvis per farle eseguire.");
}

function fail(message) {
  if (closed || failed) return;
  failed = true;
  stoppedSeconds = elapsed();
  cleanup();
  start.hidden = true;
  $("controls").hidden = false;
  status.textContent = message;
  hint.textContent = "Tocchi Chiudi per tornare alla chat, poi usi /chiama per riprovare.";
}

function toolOutput(callId, output, continueResponse = true) {
  send({ type: "conversation.item.create", item: {
    type: "function_call_output", call_id: callId, output: JSON.stringify(output)
  } });
  if (continueResponse) requestResponse();
}

function onEvent(event) {
  if (closed || failed) return;
  if (event.type === "error") {
    fail("La linea ha segnalato un errore. Può riprovare dalla chat.");
  } else if (event.type === "response.created") {
    responseActive = true;
  } else if (event.type === "response.done") {
    responseActive = false;
    if (responseQueue.length) requestResponse(responseQueue.shift());
  } else if (event.type === "output_audio_buffer.started") {
    audioPlaying = true;
    status.textContent = "Jarvis parla";
  } else if (event.type === "output_audio_buffer.stopped" || event.type === "output_audio_buffer.cleared") {
    audioPlaying = false;
    if (sayingGoodbye) finish();
    else status.textContent = mute.getAttribute("aria-pressed") === "true" ? "Microfono disattivato" : "In ascolto";
  } else if (event.type === "response.function_call_arguments.done") {
    if (typeof event.call_id !== "string") return;
    if (toolResults.has(event.call_id)) {
      toolOutput(event.call_id, toolResults.get(event.call_id), false);
      return;
    }
    if (event.name === "chiudi_chiamata") {
      sayingGoodbye = true;
      toolResults.set(event.call_id, { ok: true });
      toolOutput(event.call_id, { ok: true }, false);
      // Attende lo svuotamento dell'audio remoto, senza lasciare la chiusura sospesa.
      goodbyeTimeout = setTimeout(finish, 3000);
    } else if (event.name === "annota_richiesta") {
      let output;
      try {
        const args = JSON.parse(event.arguments);
        const text = typeof args.testo === "string" ? args.testo.trim() : "";
        if (!text || [...text].length > 500 || requests.length >= 10) throw new Error();
        if (!fitsRequests([...requests, text])) {
          output = { ok: false, error: "Spazio esaurito: dica al proprietario di ripetere questa richiesta in chat dopo la chiamata." };
        } else {
          requests.push(text);
          saveRequests();
          output = { ok: true };
        }
      } catch {
        output = { ok: false, error: "Richiesta non annotata: usi un testo da 1 a 500 caratteri, massimo 10 richieste." };
      }
      toolResults.set(event.call_id, output);
      toolOutput(event.call_id, output);
    }
  }
}

function analyseRemote(stream) {
  if (!audioContext || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  audioContext.createMediaStreamSource(stream).connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  function draw() {
    if (closed || failed) return;
    analyser.getByteTimeDomainData(samples);
    let energy = 0;
    for (const sample of samples) energy += ((sample - 128) / 128) ** 2;
    const level = Math.min(1, Math.sqrt(energy / samples.length) * 5);
    $("orb").style.setProperty("--level", String(level));
    animation = requestAnimationFrame(draw);
  }
  draw();
}

start.addEventListener("click", async () => {
  if (!validParams || attempted || closed) return;
  if (usedNonces().includes(nonce)) {
    blockUsedButton();
    return;
  }
  attempted = true;
  try { localStorage.setItem(USED_NONCES_STORAGE_KEY, JSON.stringify([...usedNonces(), nonce].slice(-50))); }
  catch { /* Il blocco resta valido in memoria anche senza storage. */ }
  if (requests.length) saveRequests();
  start.hidden = true;
  $("controls").hidden = false;
  mute.disabled = true;
  status.textContent = "In collegamento…";
  hint.textContent = "Consenta l’uso del microfono. La linea si aprirà tra pochi istanti.";
  if (tg && tg.enableClosingConfirmation) tg.enableClosingConfirmation();
  connectTimeout = setTimeout(() => fail("Il collegamento sta impiegando troppo tempo."), 30000);
  try {
    // AudioContext viene sbloccato nel gesto dell'utente, prima di attendere il microfono (iOS).
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      audioContext = new AudioContextClass();
      audioContext.resume().catch(() => {});
    }
    audio.play().catch(() => {});
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (closed || failed) {
      localStream.getTracks().forEach((track) => track.stop());
      return;
    }
    pc = new RTCPeerConnection();
    pc.ontrack = (event) => {
      if (closed || failed) {
        event.track.stop();
        return;
      }
      remoteStream = event.streams[0] || new MediaStream([event.track]);
      audio.srcObject = remoteStream;
      audio.play().catch(() => { if (!closed && !failed) audioButton.hidden = false; });
      analyseRemote(remoteStream);
    };
    pc.onconnectionstatechange = () => {
      if (!closed && !failed && pc.connectionState === "failed") fail("La linea si è interrotta.");
    };
    pc.addTrack(localStream.getTracks()[0]);
    dc = pc.createDataChannel("oai-events");
    dc.onopen = () => {
      if (closed || failed) return;
      clearTimeout(connectTimeout);
      startedAt = performance.now();
      mute.disabled = false;
      status.textContent = "In ascolto";
      hint.textContent = "Parli pure. Jarvis La ascolta.";
      requestResponse({
        instructions: "Saluta brevemente in italiano in una frase e chiedi se la si sente bene."
      });
      updateTimer();
      ticker = setInterval(updateTimer, 250);
    };
    dc.onmessage = (event) => {
      try { onEvent(JSON.parse(event.data)); }
      catch { fail("Non riesco a leggere la risposta della linea."); }
    };
    dc.onclose = () => { if (!closed && !failed) fail("La linea si è chiusa."); };
    const offer = await pc.createOffer();
    if (closed || failed) return;
    await pc.setLocalDescription(offer);
    if (closed || failed) return;
    abortController = new AbortController();
    const response = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST", body: offer.sdp, signal: abortController.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/sdp" }
    });
    key = null;
    if (closed || failed) return;
    if (!response.ok) {
      fail(response.status === 401 || response.status === 403
        ? "Il collegamento è scaduto. Apra una nuova chiamata dalla chat."
        : "Non riesco ad aprire la linea in questo momento.");
      return;
    }
    const sdp = await response.text();
    if (!closed && !failed) await pc.setRemoteDescription({ type: "answer", sdp });
  } catch (error) {
    if (!closed && !failed) fail(error.name === "NotAllowedError"
      ? "Il microfono non è autorizzato. Consenta l’accesso nelle impostazioni."
      : "Non riesco a collegarmi. Verifichi microfono e connessione.");
  }
});

mute.addEventListener("click", () => {
  if (!localStream || closed || failed || startedAt === null) return;
  const muted = mute.getAttribute("aria-pressed") !== "true";
  localStream.getAudioTracks().forEach((track) => { track.enabled = !muted; });
  mute.setAttribute("aria-pressed", String(muted));
  mute.textContent = muted ? "Attiva microfono" : "Disattiva microfono";
  if (!audioPlaying) status.textContent = muted ? "Microfono disattivato" : "In ascolto";
});
close.addEventListener("click", finish);
audioButton.addEventListener("click", async () => {
  try {
    if (audioContext) await audioContext.resume();
    await audio.play();
    audioButton.hidden = true;
  } catch { hint.textContent = "Non riesco ad attivare l’audio. Verifichi le impostazioni del telefono."; }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && startedAt !== null && !closed && !failed) updateTimer();
});
window.addEventListener("pagehide", () => {
  if (attempted && !closed) {
    stoppedSeconds = elapsed();
    closed = true;
    cleanup();
  }
});
