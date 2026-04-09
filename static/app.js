let video = null;
let canvas = null;
let ctx = null;
let overlayCanvas = null;
let overlayCtx = null;
let bboxRect = null;
let stream = null;
let sessionId = null;
let captureLoop = null;

let authToken = localStorage.getItem('authToken') || null;
let currentUser = null;

const authSection = document.getElementById('authSection');
const userSection = document.getElementById('userSection');
const consentSection = document.getElementById('consentSection');
const materialSection = document.getElementById('materialSection');
const monitor = document.getElementById('monitor');
const teacherSection = document.getElementById('teacherSection');

const userInfo = document.getElementById('userInfo');
const consentStatus = document.getElementById('consentStatus');
const materialSelect = document.getElementById('materialSelect');
const latest = document.getElementById('latest');
const appMessage = document.getElementById('appMessage');

const loginEmail = document.getElementById('loginEmail');
const loginPassword = document.getElementById('loginPassword');
const registerName = document.getElementById('registerName');
const registerEmail = document.getElementById('registerEmail');
const registerPassword = document.getElementById('registerPassword');
const registerRole = document.getElementById('registerRole');

const loginBtn = document.getElementById('loginBtn');
const registerBtn = document.getElementById('registerBtn');
const logoutBtn = document.getElementById('logoutBtn');
const consentAcceptBtn = document.getElementById('consentAcceptBtn');
const consentWithdrawBtn = document.getElementById('consentWithdrawBtn');
const startBtn = document.getElementById('startSession');
const stopBtn = document.getElementById('stopSession');
const refreshTeacherBtn = document.getElementById('refreshTeacherBtn');
const teacherReport = document.getElementById('teacherReport');

function showMessage(msg){
  appMessage.innerText = msg || '';
}

async function apiFetch(url, options = {}){
  const headers = new Headers(options.headers || {});
  if(authToken) headers.set('Authorization', `Bearer ${authToken}`);
  const resp = await fetch(url, { ...options, headers });
  if(resp.status === 401){
    handleLogout();
    throw new Error('Session expired. Please login again.');
  }
  return resp;
}

async function bootstrap(){
  if(!authToken){
    renderLoggedOut();
    return;
  }
  try{
    const resp = await apiFetch('/auth/me');
    if(!resp.ok) throw new Error('Failed to load user');
    currentUser = await resp.json();
    await renderLoggedIn();
  }catch(err){
    handleLogout();
    showMessage(err.message);
  }
}

function renderLoggedOut(){
  authSection.style.display = 'flex';
  userSection.style.display = 'none';
  consentSection.style.display = 'none';
  materialSection.style.display = 'none';
  monitor.style.display = 'none';
  teacherSection.style.display = 'none';
}

async function renderLoggedIn(){
  authSection.style.display = 'none';
  userSection.style.display = 'flex';
  userInfo.innerText = `${currentUser.name} (${currentUser.role})`;

  if(currentUser.role === 'student'){
    consentSection.style.display = 'block';
    materialSection.style.display = 'block';
    monitor.style.display = 'flex';
    teacherSection.style.display = 'none';
    await loadConsentStatus();
    await loadMaterials();
    await startCamera();
  } else {
    consentSection.style.display = 'none';
    materialSection.style.display = 'none';
    monitor.style.display = 'none';
    teacherSection.style.display = 'block';
    await loadTeacherReport();
  }
}

function handleLogout(){
  authToken = null;
  currentUser = null;
  localStorage.removeItem('authToken');
  if(captureLoop){
    clearInterval(captureLoop);
    captureLoop = null;
  }
  if(stream){
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  sessionId = null;
  renderLoggedOut();
}

loginBtn.addEventListener('click', async ()=>{
  try{
    const fd = new URLSearchParams();
    fd.append('username', loginEmail.value.trim());
    fd.append('password', loginPassword.value);
    const resp = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: fd
    });
    const data = await resp.json();
    if(!resp.ok) throw new Error(data.detail || 'Login failed');
    authToken = data.access_token;
    localStorage.setItem('authToken', authToken);
    showMessage('Login successful.');
    await bootstrap();
  }catch(err){
    showMessage(err.message);
  }
});

registerBtn.addEventListener('click', async ()=>{
  try{
    const resp = await fetch('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: registerName.value.trim(),
        email: registerEmail.value.trim(),
        password: registerPassword.value,
        role: registerRole.value,
      })
    });
    const data = await resp.json();
    if(!resp.ok) throw new Error(data.detail || 'Register failed');
    authToken = data.access_token;
    localStorage.setItem('authToken', authToken);
    showMessage('Registration successful.');
    await bootstrap();
  }catch(err){
    showMessage(err.message);
  }
});

logoutBtn.addEventListener('click', ()=>{
  handleLogout();
  showMessage('Logged out.');
});

async function loadConsentStatus(){
  const resp = await apiFetch('/consent/me');
  if(!resp.ok){
    consentStatus.innerText = 'Unable to load consent status.';
    return;
  }
  const data = await resp.json();
  if(!data){
    consentStatus.innerText = 'Consent status: not provided.';
    return;
  }
  consentStatus.innerText = `Consent status: ${data.status} (${new Date(data.timestamp).toLocaleString()})`;
}

consentAcceptBtn.addEventListener('click', async ()=>{
  try{
    const resp = await apiFetch('/consent/accept', { method: 'POST' });
    const data = await resp.json();
    if(!resp.ok) throw new Error(data.detail || 'Failed to update consent');
    consentStatus.innerText = `Consent status: ${data.status} (${new Date(data.timestamp).toLocaleString()})`;
    showMessage('Consent accepted.');
  }catch(err){
    showMessage(err.message);
  }
});

consentWithdrawBtn.addEventListener('click', async ()=>{
  try{
    const resp = await apiFetch('/consent/withdraw', { method: 'POST' });
    const data = await resp.json();
    if(!resp.ok) throw new Error(data.detail || 'Failed to update consent');
    consentStatus.innerText = `Consent status: ${data.status} (${new Date(data.timestamp).toLocaleString()})`;
    showMessage('Consent withdrawn. New sessions are blocked.');
  }catch(err){
    showMessage(err.message);
  }
});

async function loadMaterials(){
  materialSelect.innerHTML = '<option value="">No material selected</option>';
  try{
    const resp = await apiFetch('/materials');
    const list = await resp.json();
    if(!resp.ok) throw new Error(list.detail || 'Failed to load materials');
    list.forEach(item => {
      const option = document.createElement('option');
      option.value = String(item.id);
      option.textContent = `${item.title} — ${item.subject} (${item.file_type})`;
      materialSelect.appendChild(option);
    });
  }catch(err){
    showMessage(err.message);
  }
}

async function loadTeacherReport(){
  try{
    const resp = await apiFetch('/teacher/dashboard');
    const data = await resp.json();
    if(!resp.ok) throw new Error(data.detail || 'Failed to load teacher report');
    teacherReport.innerText = JSON.stringify(data, null, 2);
  }catch(err){
    teacherReport.innerText = err.message;
  }
}

refreshTeacherBtn.addEventListener('click', loadTeacherReport);

async function startCamera(){
  if(stream) return;
  video = document.getElementById('video');
  canvas = document.getElementById('canvas');
  overlayCanvas = document.getElementById('overlay');
  bboxRect = document.getElementById('bboxRect');
  ctx = canvas.getContext('2d');
  overlayCtx = overlayCanvas.getContext('2d');
  try{
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    video.srcObject = stream;
    video.addEventListener('loadedmetadata', () => {
      const w = video.videoWidth || 320;
      const h = video.videoHeight || 240;
      canvas.width = w;
      canvas.height = h;
      overlayCanvas.width = w;
      overlayCanvas.height = h;
    }, { once: true });
    await video.play();
  }catch(e){
    showMessage('Could not access camera: ' + e.message);
  }
}

startBtn.addEventListener('click', async ()=>{
  if(!currentUser || currentUser.role !== 'student') return;
  try{
    const materialIdPart = materialSelect.value ? `?material_id=${encodeURIComponent(materialSelect.value)}` : '';
    const resp = await apiFetch(`/session/start${materialIdPart}`, { method: 'POST' });
    const data = await resp.json();
    if(!resp.ok) throw new Error(data.detail || 'Failed to start session');
    sessionId = data.session_id;
    if(captureLoop) clearInterval(captureLoop);
    captureLoop = setInterval(captureAndSend, 1000);
    showMessage(`Session started: ${sessionId}`);
  }catch(err){
    showMessage(err.message);
  }
});

stopBtn.addEventListener('click', async ()=>{
  try{
    if(captureLoop){
      clearInterval(captureLoop);
      captureLoop = null;
    }
    if(sessionId){
      await apiFetch(`/session/stop?session_id=${encodeURIComponent(sessionId)}`, { method: 'POST' });
      showMessage(`Session stopped: ${sessionId}`);
      sessionId = null;
    }
  }catch(err){
    showMessage(err.message);
  }
});

async function captureAndSend(){
  if(!video || video.readyState < 2 || !sessionId) return;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  canvas.toBlob(async (blob)=>{
    try{
      const fd = new FormData();
      fd.append('file', blob, 'frame.jpg');
      const resp = await apiFetch('/predict', { method: 'POST', body: fd });
      if(!resp.ok){
        drawBoundingBox(null);
        let msg = 'predict failed';
        try{
          const err = await resp.json();
          if(err && err.detail) msg = err.detail;
        }catch(_e){}
        latest.innerText = msg;
        return;
      }

      const data = await resp.json();
      latest.innerText = `valence=${data.valence.toFixed(2)} arousal=${data.arousal.toFixed(2)} source=${(data.bbox && data.bbox.source) || 'none'}`;
      drawBoundingBox(data.bbox, { width: data.frame_width, height: data.frame_height });

      await apiFetch('/emotion/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          valence: data.valence,
          arousal: data.arousal,
          confidence: data.confidence || null,
          model_version: data.model_version || null,
          client_timestamp: new Date().toISOString(),
          source: 'server-fallback'
        })
      });

      pushTimeline(data);
    }catch(err){
      latest.innerText = err.message;
    }
  }, 'image/jpeg', 0.8);
}

function drawBoundingBox(bbox, frameSize){
  if(!overlayCtx || !overlayCanvas || !bboxRect) return;
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  if(!bbox || bbox.width <= 0 || bbox.height <= 0){
    bboxRect.style.display = 'none';
    return;
  }

  const sourceW = (frameSize && frameSize.width) ? Number(frameSize.width) : overlayCanvas.width;
  const sourceH = (frameSize && frameSize.height) ? Number(frameSize.height) : overlayCanvas.height;
  const targetW = overlayCanvas.clientWidth || overlayCanvas.width;
  const targetH = overlayCanvas.clientHeight || overlayCanvas.height;
  const scaleX = sourceW > 0 ? (targetW / sourceW) : 1;
  const scaleY = sourceH > 0 ? (targetH / sourceH) : 1;

  const x = Math.max(0, Math.round(Number(bbox.x) * scaleX));
  const y = Math.max(0, Math.round(Number(bbox.y) * scaleY));
  const w = Math.max(1, Math.round(Number(bbox.width) * scaleX));
  const h = Math.max(1, Math.round(Number(bbox.height) * scaleY));

  bboxRect.style.display = 'block';
  bboxRect.style.left = `${x}px`;
  bboxRect.style.top = `${y}px`;
  bboxRect.style.width = `${w}px`;
  bboxRect.style.height = `${h}px`;
}

// --- simple Chart.js timeline + scatter ---
const timelineCtx = document.getElementById('timelineChart').getContext('2d');
const scatterCtx = document.getElementById('scatterChart').getContext('2d');

const timelineChart = new Chart(timelineCtx, {
  type: 'line',
  data: { labels: [], datasets: [
    { label: 'Valence', data: [], borderColor: 'blue', fill:false},
    { label: 'Arousal', data: [], borderColor: 'red', fill:false}
  ]},
  options: { animation: false }
});

const scatterChart = new Chart(scatterCtx, {
  type: 'scatter',
  data: { datasets: [{ label: 'Arousal vs Valence', data: [], backgroundColor: 'purple' }] },
  options: { animation: false, scales: { x: { title: { display: true, text: 'Valence (-1..1)' } }, y: { title: { display: true, text: 'Arousal (0..1)' } } } }
});

function pushTimeline(d){
  const t = new Date().toLocaleTimeString();
  timelineChart.data.labels.push(t);
  timelineChart.data.datasets[0].data.push(d.valence);
  timelineChart.data.datasets[1].data.push(d.arousal);
  if(timelineChart.data.labels.length>60){ timelineChart.data.labels.shift(); timelineChart.data.datasets.forEach(ds=>ds.data.shift()); }
  timelineChart.update('none');

  scatterChart.data.datasets[0].data.push({x: d.valence, y: d.arousal});
  if(scatterChart.data.datasets[0].data.length>200) scatterChart.data.datasets[0].data.shift();
  scatterChart.update('none');
}

bootstrap();
