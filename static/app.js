let video = null;
let canvas = null;
let ctx = null;
let stream = null;
let sessionId = null;
let studentId = 1; // simple default for demo

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
  ctx = canvas.getContext('2d');
  try{
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    video.srcObject = stream;
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
  captureLoop = setInterval(captureAndSend, 1000);
});

stopBtn.addEventListener('click', async ()=>{
  clearInterval(window.captureLoop);
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
    const data = await resp.json();
    latest.innerText = `valence=${data.valence.toFixed(2)} arousal=${data.arousal.toFixed(2)}`;
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
