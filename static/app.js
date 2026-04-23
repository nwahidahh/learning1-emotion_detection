let video = null;
let canvas = null;
let ctx = null;
let overlayCanvas = null;
let overlayCtx = null;
let bboxRect = null;
let stream = null;
let sessionId = null;
let captureLoop = null;
let timelineChart = null;
let scatterChart = null;

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

const currentPage = (window.location.pathname.split('/').pop() || '').toLowerCase();
const isLoginPage = currentPage === 'login.html';
const isRegisterPage = currentPage === 'register.html';
const isMainPage = currentPage === 'main.html';

function redirectTo(url){
  if(window.location.pathname !== url){
    window.location.assign(url);
  }
}

function showMessage(msg){
  if(appMessage) appMessage.innerText = msg || '';
}

function setDisplay(element, value){
  if(element && element.style){
    element.style.display = value;
  }
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
    if(isMainPage) redirectTo('/static/login.html');
    return;
  }

  if(isLoginPage || isRegisterPage){
    redirectTo('/static/main.html');
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
  setDisplay(authSection, 'flex');
  setDisplay(userSection, 'none');
  setDisplay(consentSection, 'none');
  setDisplay(materialSection, 'none');
  setDisplay(monitor, 'none');
  setDisplay(teacherSection, 'none');
}

async function renderLoggedIn(){
  if(!isMainPage){
    redirectTo('/static/main.html');
    return;
  }

  setDisplay(authSection, 'none');
  setDisplay(userSection, 'flex');
  if(userInfo) userInfo.innerText = `${currentUser.name} (${currentUser.role})`;

  if(currentUser.role === 'student'){
    setDisplay(consentSection, 'block');
    setDisplay(materialSection, 'block');
    setDisplay(monitor, 'flex');
    setDisplay(teacherSection, 'none');
    await loadConsentStatus();
    await loadMaterials();
    initCharts();
    await startCamera();
  } else {
    setDisplay(consentSection, 'none');
    setDisplay(materialSection, 'none');
    setDisplay(monitor, 'none');
    setDisplay(teacherSection, 'block');
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
  if(isMainPage){
    renderLoggedOut();
    redirectTo('/static/login.html');
  }
}

if(loginBtn){
  loginBtn.addEventListener('click', async ()=>{
    try{
      const fd = new URLSearchParams();
      fd.append('username', (loginEmail && loginEmail.value || '').trim());
      fd.append('password', loginPassword && loginPassword.value || '');
      const resp = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: fd
      });
      const data = await resp.json();
      if(!resp.ok) throw new Error(data.detail || 'Login failed');
      authToken = data.access_token;
      localStorage.setItem('authToken', authToken);
      showMessage('Login successful. Redirecting...');
      window.location.replace('/static/main.html');
    }catch(err){
      showMessage(err.message);
    }
  });
}

if(registerBtn){
  registerBtn.addEventListener('click', async ()=>{
    try{
      const resp = await fetch('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: (registerName && registerName.value || '').trim(),
          email: (registerEmail && registerEmail.value || '').trim(),
          password: registerPassword && registerPassword.value || '',
          role: registerRole && registerRole.value || 'student',
        })
      });
      const data = await resp.json();
      if(!resp.ok) throw new Error(data.detail || 'Register failed');
      authToken = data.access_token;
      localStorage.setItem('authToken', authToken);
      showMessage('Registration successful. Redirecting...');
      window.location.replace('/static/main.html');
    }catch(err){
      showMessage(err.message);
    }
  });
}

if(logoutBtn){
  logoutBtn.addEventListener('click', ()=>{
    handleLogout();
    showMessage('Logged out.');
  });
}

async function loadConsentStatus(){
  if(!consentStatus) return;
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
  setDisplay(consentSection, data.status === 'accepted' ? 'none' : 'block');
  consentStatus.innerText = `Consent status: ${data.status} (${new Date(data.timestamp).toLocaleString()})`;
}

if(consentAcceptBtn){
  consentAcceptBtn.addEventListener('click', async ()=>{
    try{
      const resp = await apiFetch('/consent/accept', { method: 'POST' });
      const data = await resp.json();
      if(!resp.ok) throw new Error(data.detail || 'Failed to update consent');
      setDisplay(consentSection, data.status === 'accepted' ? 'none' : 'block');
      consentStatus.innerText = `Consent status: ${data.status} (${new Date(data.timestamp).toLocaleString()})`;
      showMessage('Consent accepted.');
    }catch(err){
      showMessage(err.message);
    }
  });
}

if(consentWithdrawBtn){
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
}

async function loadMaterials(){
  if(!materialSelect) return;
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
  if(!teacherReport) return;
  try{
    const resp = await apiFetch('/teacher/dashboard');
    const data = await resp.json();
    if(!resp.ok) throw new Error(data.detail || 'Failed to load teacher report');
    teacherReport.innerText = JSON.stringify(data, null, 2);
  }catch(err){
    teacherReport.innerText = err.message;
  }
}

if(refreshTeacherBtn){
  refreshTeacherBtn.addEventListener('click', loadTeacherReport);
}

async function startCamera(){
  if(stream) return;
  video = document.getElementById('video');
  canvas = document.getElementById('canvas');
  overlayCanvas = document.getElementById('overlay');
  bboxRect = document.getElementById('bboxRect');
  if(!video || !canvas || !overlayCanvas || !bboxRect) return;
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

if(startBtn){
  startBtn.addEventListener('click', async ()=>{
    if(!currentUser || currentUser.role !== 'student') return;
    try{
      const materialIdPart = materialSelect && materialSelect.value ? `?material_id=${encodeURIComponent(materialSelect.value)}` : '';
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
}

if(stopBtn){
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
}

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
      if(!latest) return;
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

function initCharts(){
  if(timelineChart && scatterChart) return;
  const timelineCanvas = document.getElementById('timelineChart');
  const scatterCanvas = document.getElementById('scatterChart');
  if(!timelineCanvas || !scatterCanvas || typeof Chart === 'undefined') return;

  const timelineCtx = timelineCanvas.getContext('2d');
  const scatterCtx = scatterCanvas.getContext('2d');

  timelineChart = new Chart(timelineCtx, {
    type: 'line',
    data: { labels: [], datasets: [
      { label: 'Valence', data: [], borderColor: 'blue', fill:false},
      { label: 'Arousal', data: [], borderColor: 'red', fill:false}
    ]},
    options: { animation: false }
  });

  scatterChart = new Chart(scatterCtx, {
    type: 'scatter',
    data: { datasets: [{ label: 'Arousal vs Valence', data: [], backgroundColor: 'purple' }] },
    options: { animation: false, scales: { x: { title: { display: true, text: 'Valence (-1..1)' } }, y: { title: { display: true, text: 'Arousal (0..1)' } } } }
  });
}

function pushTimeline(d){
  if(!timelineChart || !scatterChart) return;
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
