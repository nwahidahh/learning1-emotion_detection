let video = null;
let canvas = null;
let ctx = null;
let overlayCanvas = null;
let overlayCtx = null;
let bboxRect = null;
let stream = null;
let sessionId = null;
let studentId = 1; // simple default for demo
let captureLoop = null;

const consentBtn = document.getElementById('consentBtn');
const monitor = document.getElementById('monitor');
const latest = document.getElementById('latest');
const startBtn = document.getElementById('startSession');
const stopBtn = document.getElementById('stopSession');

consentBtn.addEventListener('click', async () => {
  document.getElementById('consent').style.display = 'none';
  monitor.style.display = 'flex';
  await startCamera();
});

async function startCamera(){
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
    video.play();
  }catch(e){
    alert('Could not access camera: ' + e.message);
  }
}

startBtn.addEventListener('click', async ()=>{
  // start session on backend
  const fd = new FormData();
  fd.append('student_id', studentId);
  const r = await fetch('/session/start', { method: 'POST', body: fd });
  const j = await r.json();
  sessionId = j.session_id;
  // start periodic capture
  if(captureLoop) clearInterval(captureLoop);
  captureLoop = setInterval(captureAndSend, 1000);
});

stopBtn.addEventListener('click', async ()=>{
  clearInterval(captureLoop);
  captureLoop = null;
  if(sessionId){
    const fd = new FormData();
    fd.append('session_id', sessionId);
    await fetch('/session/stop', { method: 'POST', body: fd });
    sessionId = null;
  }
});

async function captureAndSend(){
  if(!video || video.readyState < 2) return;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  canvas.toBlob(async (blob)=>{
    // send to /predict
    const fd = new FormData();
    fd.append('file', blob, 'frame.jpg');
    const resp = await fetch('/predict', { method: 'POST', body: fd });
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
    // log to backend
    const logfd = new FormData();
    logfd.append('student_id', studentId);
    logfd.append('session_id', sessionId);
    logfd.append('valence', data.valence);
    logfd.append('arousal', data.arousal);
    await fetch('/emotion/log', { method: 'POST', body: logfd });
    // update charts
    pushTimeline(data);
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

  overlayCtx.strokeStyle = '#00ff7f';
  overlayCtx.lineWidth = 2;
  overlayCtx.strokeRect(x, y, w, h);
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
