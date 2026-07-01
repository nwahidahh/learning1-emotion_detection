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
let teacherDashboardData = null;
let teacherClassTimelineChart = null;
let teacherClassScatterChart = null;
let teacherStudentTimelineChart = null;
let teacherStudentScatterChart = null;
let teacherSelectedStudentId = null;
let teacherSelectedSelfReport = "";
const CAPTURE_INTERVAL_MS = 500;
const MONITOR_POPUP_STATE_KEY = "monitorPopupState";

let authToken = localStorage.getItem("authToken") || null;
let currentUser = null;
let studentMaterialsData = [];

const ROLE_PAGE = {
  student: "/static/student.html",
  teacher: "/static/teacher.html",
  admin: "/static/admin.html",
};

const currentPage = (window.location.pathname.split("/").pop() || "").toLowerCase();
const isLoginPage = currentPage === "login.html";
const isRegisterPage = currentPage === "register.html";
const isStudentPage = currentPage === "student.html";
const isTeacherPage = currentPage === "teacher.html";
const isAdminPage = currentPage === "admin.html";
const isRolePage = isStudentPage || isTeacherPage || isAdminPage;

function el(id) {
  return document.getElementById(id);
}

function passwordScore(pwd) {
  if (!pwd) return 0;
  let score = 0;
  // length contribution (up to 40)
  score += Math.min(40, (pwd.length / 12) * 40);
  // character variety
  const hasLower = /[a-z]/.test(pwd);
  const hasUpper = /[A-Z]/.test(pwd);
  const hasDigit = /[0-9]/.test(pwd);
  const hasSymbol = /[^A-Za-z0-9]/.test(pwd);
  score += (hasLower + hasUpper + hasDigit + hasSymbol) * 15; // up to 60
  return Math.max(0, Math.min(100, Math.round(score)));
}

function expectedRoleFromPage() {
  if (isStudentPage) return "student";
  if (isTeacherPage) return "teacher";
  if (isAdminPage) return "admin";
  return null;
}

function redirectTo(url) {
  if (window.location.pathname !== url) {
    window.location.assign(url);
  }
}

function showMessage(msg, type = "danger") {
  const appMessage = el("appMessage");
  if (!appMessage) return;
  appMessage.textContent = msg || "";
  appMessage.classList.remove("d-none", "alert-danger", "alert-success", "alert-warning", "alert-info");
  appMessage.classList.add(`alert-${type}`);
}

function clearMessage() {
  const appMessage = el("appMessage");
  if (!appMessage) return;
  appMessage.textContent = "";
  appMessage.classList.add("d-none");
}

function setUserInfo() {
  const userInfo = el("userInfo");
  if (userInfo && currentUser) {
    userInfo.textContent = `${currentUser.name} (${currentUser.role})`;
  }
}

async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (authToken) headers.set("Authorization", `Bearer ${authToken}`);
  const resp = await fetch(url, { ...options, headers });
  if (resp.status === 401) {
    handleLogout(false);
    redirectTo("/static/login.html");
    throw new Error("Session expired. Please login again.");
  }
  return resp;
}

async function fetchCurrentUser() {
  const resp = await apiFetch("/auth/me");
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.detail || "Failed to load user profile");
  }
  currentUser = await resp.json();
  return currentUser;
}

function roleHome(role) {
  return ROLE_PAGE[role] || "/static/login.html";
}

async function redirectAfterAuth() {
  await fetchCurrentUser();
  redirectTo(roleHome(currentUser.role));
}

function handleLogout(showNotice = true) {
  authToken = null;
  currentUser = null;
  localStorage.removeItem("authToken");

  if (captureLoop) {
    clearInterval(captureLoop);
    captureLoop = null;
  }
  if (stream) {
    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch (_e) {}
    stream = null;
  }
  sessionId = null;

  if (showNotice) showMessage("Logged out.", "success");
}

function setupAuthButtons() {
  const loginBtn = el("loginBtn");
  const registerBtn = el("registerBtn");
  const logoutBtn = el("logoutBtn");

  if (loginBtn) {
    loginBtn.addEventListener("click", async () => {
      try {
        clearMessage();
        const fd = new URLSearchParams();
        fd.append("username", (el("loginEmail")?.value || "").trim());
        fd.append("password", el("loginPassword")?.value || "");
        const resp = await fetch("/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: fd,
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.detail || "Login failed");
        authToken = data.access_token;
        localStorage.setItem("authToken", authToken);
        showMessage("Login successful. Redirecting...", "success");
        await redirectAfterAuth();
      } catch (err) {
        showMessage(err.message || "Login failed");
      }
    });
  }

  if (registerBtn) {
    registerBtn.addEventListener("click", async () => {
      try {
        clearMessage();
        const consent = el("registerConsent")?.checked;
        const pwd = el("registerPassword")?.value || "";
        if (!consent) {
          showMessage("Please agree to the consent checkbox before creating an account.", "warning");
          return;
        }
        if (pwd.length < 8) {
          showMessage("Password must be at least 8 characters long.", "warning");
          return;
        }

        const resp = await fetch("/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: (el("registerName")?.value || "").trim(),
            email: (el("registerEmail")?.value || "").trim(),
            password: pwd,
            role: el("registerRole")?.value || "student",
          }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.detail || "Registration failed");
        authToken = data.access_token;
        localStorage.setItem("authToken", authToken);
        showMessage("Registration successful. Redirecting...", "success");
        await redirectAfterAuth();
      } catch (err) {
        showMessage(err.message || "Registration failed");
      }
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      handleLogout(false);
      redirectTo("/static/login.html");
    });
  }

  // password strength indicator on register page
  if (isRegisterPage) {
    const pwdInput = el("registerPassword");
    const bar = el("passwordStrengthBar");
    if (pwdInput && bar) {
      pwdInput.addEventListener("input", () => {
        const s = passwordScore(pwdInput.value);
        bar.style.width = `${s}%`;
        if (s < 40) bar.style.background = "linear-gradient(90deg,#ff9a9e,#ff6a6a)";
        else if (s < 70) bar.style.background = "linear-gradient(90deg,#ffd36a,#f6b042)";
        else bar.style.background = "linear-gradient(90deg,#9be15d,#00b09b)";
      });
    }
  }
}

async function bootstrap() {
  setupAuthButtons();

  if (!authToken) {
    if (isRolePage || (!isLoginPage && !isRegisterPage)) {
      redirectTo("/static/login.html");
    }
    return;
  }

  try {
    await fetchCurrentUser();
  } catch (_err) {
    handleLogout(false);
    redirectTo("/static/login.html");
    return;
  }

  if (isLoginPage || isRegisterPage) {
    redirectTo(roleHome(currentUser.role));
    return;
  }

  const expectedRole = expectedRoleFromPage();
  if (expectedRole && currentUser.role !== expectedRole) {
    redirectTo(roleHome(currentUser.role));
    return;
  }

  if (!isRolePage) {
    redirectTo(roleHome(currentUser.role));
    return;
  }

  setUserInfo();
  try {
    if (isStudentPage) await initStudentPage();
    if (isTeacherPage) await initTeacherPage();
    if (isAdminPage) await initAdminPage();
  } catch (err) {
    showMessage(err.message || "Failed to initialize page");
  }
}

async function initStudentPage() {
  initMonitorPopupControls();
  await loadConsentStatus();
  await loadStudentMaterials();
  initCharts();
  await startCamera();

  el("consentAcceptBtn")?.addEventListener("click", async () => {
    try {
      const resp = await apiFetch("/consent/accept", { method: "POST" });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || "Failed to accept consent");
      await loadConsentStatus();
      showMessage("Consent accepted.", "success");
    } catch (err) {
      showMessage(err.message);
    }
  });

  el("consentWithdrawBtn")?.addEventListener("click", async () => {
    try {
      const resp = await apiFetch("/consent/withdraw", { method: "POST" });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || "Failed to withdraw consent");
      await loadConsentStatus();
      showMessage("Consent withdrawn.", "warning");
    } catch (err) {
      showMessage(err.message);
    }
  });

  el("studentMaterials")?.addEventListener("change", async () => {
    const selectedId = Number(el("studentMaterials")?.value || 0);
    const sidebarMaterials = el("sidebarMaterials");
    
    // Update sidebar active state
    if (sidebarMaterials) {
      const items = sidebarMaterials.querySelectorAll(".sidebar-material-item");
      items.forEach((item) => {
        item.classList.remove("active");
        if (Number(item.dataset.materialId) === selectedId) {
          item.classList.add("active");
        }
      });
    }
    
    renderSelectedMaterialDetail();
    await loadCommentsForSelectedMaterial();
  });

  el("openMaterialBtn")?.addEventListener("click", async () => {
    const material = getSelectedStudentMaterial();
    if (!material) {
      showMessage("Select a material first.");
      return;
    }
    try {
      const resp = await apiFetch(`/materials/${material.id}/open`, { method: "POST" });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || "Failed to track material open");
      renderSelectedMaterialDetail();
      el("materialPreview")?.scrollIntoView({ behavior: "smooth", block: "start" });
      await loadLastOpenedBadge();
      showMessage("Material opened and tracked.", "success");
    } catch (err) {
      showMessage(err.message);
    }
  });

  el("submitCommentBtn")?.addEventListener("click", async () => {
    const material = getSelectedStudentMaterial();
    const commentText = (el("commentText")?.value || "").trim();
    if (!material) {
      showMessage("Select a material first.");
      return;
    }
    if (!commentText) {
      showMessage("Comment cannot be empty.");
      return;
    }
    try {
      const resp = await apiFetch(`/materials/${material.id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comment_text: commentText }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || "Failed to submit comment");
      el("commentText").value = "";
      await loadCommentsForSelectedMaterial();
      showMessage("Comment submitted.", "success");
    } catch (err) {
      showMessage(err.message);
    }
  });

  el("startSession")?.addEventListener("click", async () => {
    try {
      const selectedMaterialId = el("materialSelect")?.value || "";
      const query = selectedMaterialId ? `?material_id=${encodeURIComponent(selectedMaterialId)}` : "";
      const resp = await apiFetch(`/session/start${query}`, { method: "POST" });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || "Failed to start session");
      sessionId = data.session_id;
      if (captureLoop) clearInterval(captureLoop);
      await captureAndSend();
      captureLoop = setInterval(captureAndSend, CAPTURE_INTERVAL_MS);
      showMessage(`Session started: ${sessionId}`, "success");
    } catch (err) {
      showMessage(err.message);
    }
  });

  el("stopSession")?.addEventListener("click", async () => {
    try {
      if (captureLoop) {
        clearInterval(captureLoop);
        captureLoop = null;
      }
      if (sessionId) {
        const resp = await apiFetch(`/session/stop?session_id=${encodeURIComponent(sessionId)}`, { method: "POST" });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.detail || "Failed to stop session");
        showMessage(`Session stopped: ${sessionId}`, "success");
        sessionId = null;
      }
    } catch (err) {
      showMessage(err.message);
    }
  });
}

function initMonitorPopupControls() {
  const monitor = el("monitor");
  const openBtn = el("monitorOpenBtn");
  const minBtn = el("monitorMinBtn");
  const closeBtn = el("monitorCloseBtn");
  if (!monitor || !openBtn || !minBtn || !closeBtn) return;
  if (monitor.dataset.popupReady === "1") return;

  const stored = localStorage.getItem(MONITOR_POPUP_STATE_KEY) || "open";
  applyMonitorPopupState(stored, false);

  openBtn.addEventListener("click", () => applyMonitorPopupState("open", true));
  minBtn.addEventListener("click", () => {
    const minimized = monitor.classList.contains("minimized");
    applyMonitorPopupState(minimized ? "open" : "minimized", true);
  });
  closeBtn.addEventListener("click", () => applyMonitorPopupState("closed", true));

  monitor.dataset.popupReady = "1";
}

function applyMonitorPopupState(state, persist = true) {
  const monitor = el("monitor");
  const openBtn = el("monitorOpenBtn");
  if (!monitor || !openBtn) return;

  monitor.classList.remove("minimized");
  openBtn.style.display = "none";

  if (state === "closed") {
    monitor.style.display = "none";
    openBtn.style.display = "inline-flex";
  } else if (state === "minimized") {
    monitor.style.display = "block";
    monitor.classList.add("minimized");
  } else {
    monitor.style.display = "block";
  }

  if (persist) localStorage.setItem(MONITOR_POPUP_STATE_KEY, state);
}

function updateLiveEmotionSummary(data) {
  const v = Number(data?.valence || 0);
  const a = Number(data?.arousal || 0);

  const anger = Math.max(0, Math.round(Math.max(-v - 0.12, 0) * Math.max(a - 0.2, 0) * 140));
  const contempt = Math.max(0, Math.round(Math.max(-v - 0.18, 0) * Math.max(0.55 - a, 0) * 135));
  const disgust = Math.max(0, Math.round(Math.max(-v - 0.2, 0) * Math.max(a - 0.25, 0) * (1 - Math.min(Math.abs(a - 0.55) * 1.15, 1)) * 150));
  const fear = Math.max(0, Math.round(Math.max(-v, 0) * Math.max(a - 0.45, 0) * 140));
  const happiness = Math.max(0, Math.round(Math.max(v, 0) * (0.55 + a * 0.45) * 145));
  const neutral = Math.max(0, Math.round((1 - Math.min(Math.abs(v), 1)) * (1 - Math.min(Math.abs(a - 0.5) * 1.7, 1)) * 110));
  const sadness = Math.max(0, Math.round(Math.max(-v, 0) * Math.max(0.6 - a, 0) * 155));
  const surprise = Math.max(0, Math.round(Math.max(a - 0.55, 0) * (1 - Math.min(Math.abs(v) * 0.8, 1)) * 160));

  const raw = { anger, contempt, disgust, fear, happiness, neutral, sadness, surprise };
  const total = Object.values(raw).reduce((s, n) => s + n, 0) || 1;
  const pct = Object.fromEntries(Object.entries(raw).map(([k, n]) => [k, Math.round((n / total) * 100)]));

  let dominant = "neutral";
  let dominantValue = -1;
  for (const [key, value] of Object.entries(pct)) {
    if (value > dominantValue) {
      dominant = key;
      dominantValue = value;
    }
  }

  const labelMap = {
    anger: "Anger",
    contempt: "Contempt",
    disgust: "Disgust",
    fear: "Fear",
    happiness: "Happiness",
    neutral: "Neutral",
    sadness: "Sadness",
    surprise: "Surprise",
  };

  const ring = el("liveEmotionRing");
  const label = el("liveEmotionLabel");
  const ratio = el("liveEmotionPct");
  const emoAnger = el("emoAnger");
  const emoContempt = el("emoContempt");
  const emoDisgust = el("emoDisgust");
  const emoFear = el("emoFear");
  const emoHappiness = el("emoHappiness");
  const emoNeutral = el("emoNeutral");
  const emoSadness = el("emoSadness");
  const emoSurprise = el("emoSurprise");
  if (!ring || !label || !ratio || !emoAnger || !emoContempt || !emoDisgust || !emoFear || !emoHappiness || !emoNeutral || !emoSadness || !emoSurprise) return;

  const dominantPct = Math.max(0, Math.min(100, pct[dominant] || 0));
  const sweep = Math.round((dominantPct / 100) * 360);
  ring.style.background = `conic-gradient(#22c55e 0deg, #22c55e ${sweep}deg, #d1d5db ${sweep}deg, #d1d5db 360deg)`;
  ring.textContent = `${dominantPct}%`;
  label.textContent = labelMap[dominant] || "Neutral";
  ratio.textContent = `${dominantPct}%`;

  emoAnger.textContent = `${pct.anger || 0}%`;
  emoContempt.textContent = `${pct.contempt || 0}%`;
  emoDisgust.textContent = `${pct.disgust || 0}%`;
  emoFear.textContent = `${pct.fear || 0}%`;
  emoHappiness.textContent = `${pct.happiness || 0}%`;
  emoNeutral.textContent = `${pct.neutral || 0}%`;
  emoSadness.textContent = `${pct.sadness || 0}%`;
  emoSurprise.textContent = `${pct.surprise || 0}%`;
}

async function loadConsentStatus() {
  const consentSection = el("consentSection");
  const consentStatus = el("consentStatus");
  const monitor = el("monitor");
  if (!consentSection || !consentStatus || !monitor) return;

  const resp = await apiFetch("/consent/me");
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    consentStatus.textContent = "Unable to load consent status.";
    return;
  }

  if (!data || data.status !== "accepted") {
    consentSection.style.display = "block";
    monitor.style.display = "none";
    const openBtn = el("monitorOpenBtn");
    if (openBtn) openBtn.style.display = "none";
    consentStatus.textContent = data ? `Consent status: ${data.status}` : "Consent status: not provided.";
    return;
  }

  consentSection.style.display = "none";
  const preferred = localStorage.getItem(MONITOR_POPUP_STATE_KEY) || "open";
  applyMonitorPopupState(preferred, false);
  consentStatus.textContent = `Consent status: accepted (${new Date(data.timestamp).toLocaleString()})`;

  // Ensure Plotly circumplex resizes / renders when monitor is shown (fixes hidden-container render issue)
  try {
    const sc = el("scatterChart");
    if (sc && typeof Plotly !== "undefined" && Plotly.Plots && Plotly.Plots.resize) {
      // small timeout to allow layout to settle
      setTimeout(() => {
        try {
          Plotly.Plots.resize(sc);
        } catch (_e) {}
      }, 80);
    }
  } catch (_e) {}
}

async function loadStudentMaterials() {
  const studentSelect = el("studentMaterials");
  const sessionSelect = el("materialSelect");
  const sidebarMaterials = el("sidebarMaterials");
  if (!studentSelect || !sessionSelect) return;

  const resp = await apiFetch("/materials");
  const list = await resp.json().catch(() => []);
  if (!resp.ok) throw new Error(list.detail || "Failed to load materials");

  studentMaterialsData = Array.isArray(list) ? list : [];

  studentSelect.innerHTML = "";
  sessionSelect.innerHTML = '<option value="">No material selected</option>';
  if (sidebarMaterials) {
    sidebarMaterials.innerHTML = "";
  }
  
  if (studentMaterialsData.length === 0) {
    studentSelect.innerHTML = '<option value="">No assigned material</option>';
    renderSelectedMaterialDetail();
    renderComments([]);
    await loadLastOpenedBadge();
    return;
  }

  for (const item of studentMaterialsData) {
    const optionA = document.createElement("option");
    optionA.value = String(item.id);
    optionA.textContent = `${item.title} — ${item.subject} (${item.file_type})`;
    studentSelect.appendChild(optionA);

    const optionB = document.createElement("option");
    optionB.value = String(item.id);
    optionB.textContent = `${item.title} — ${item.subject}`;
    sessionSelect.appendChild(optionB);
  }

  // Populate sidebar materials
  if (sidebarMaterials && studentMaterialsData.length > 0) {
    sidebarMaterials.innerHTML = studentMaterialsData
      .map(
        (item) => `
        <div class="sidebar-material-item" data-material-id="${item.id}" onclick="selectMaterialFromSidebar(${item.id})">
          <div class="sidebar-material-title">${escapeHtml(item.title || "Untitled")}</div>
          <div class="sidebar-material-subject">${escapeHtml(item.subject || "General")}</div>
        </div>
      `
      )
      .join("");
    // Mark first item as active
    const firstItem = sidebarMaterials.querySelector(".sidebar-material-item");
    if (firstItem) {
      firstItem.classList.add("active");
    }
  }

  renderSelectedMaterialDetail();
  await loadCommentsForSelectedMaterial();
  await loadLastOpenedBadge();
}

function getSelectedStudentMaterial() {
  const selectedId = Number(el("studentMaterials")?.value || 0);
  return studentMaterialsData.find((m) => m.id === selectedId) || null;
}

function selectMaterialFromSidebar(materialId) {
  const studentSelect = el("studentMaterials");
  const sidebarMaterials = el("sidebarMaterials");
  
  if (studentSelect) {
    studentSelect.value = String(materialId);
  }
  
  // Update sidebar active state
  if (sidebarMaterials) {
    const items = sidebarMaterials.querySelectorAll(".sidebar-material-item");
    items.forEach((item) => {
      item.classList.remove("active");
      if (Number(item.dataset.materialId) === materialId) {
        item.classList.add("active");
      }
    });
  }
  
  renderSelectedMaterialDetail();
  loadCommentsForSelectedMaterial();
}

function renderSelectedMaterialDetail() {
  const detail = el("materialDetail");
  const preview = el("materialPreview");
  if (!detail) return;
  const material = getSelectedStudentMaterial();
  if (!material) {
    detail.textContent = "No material selected.";
    if (preview) preview.innerHTML = "";
    return;
  }

  const location = material.file_type === "link" ? (material.external_url || "-") : (material.file_path || "-");
  detail.innerHTML = `
    <div><strong>Title:</strong> ${escapeHtml(material.title || "")}</div>
    <div><strong>Subject:</strong> ${escapeHtml(material.subject || "")}</div>
    <div><strong>Type:</strong> ${escapeHtml(material.file_type || "")}</div>
    <div><strong>Location:</strong> ${escapeHtml(location)}</div>
    <div><strong>Instruction:</strong> ${escapeHtml(material.instruction || "-")}</div>
  `;

  if (!preview) return;
  if (material.file_type === "pdf" && material.file_path) {
    const src = getPublicMaterialUrl(material.file_path);
    preview.innerHTML = `<iframe title="Material PDF" src="${src}"></iframe>`;
  } else if (material.file_type === "link" && material.external_url) {
    const embed = getEmbedUrl(material.external_url);
    if (embed) {
      preview.innerHTML = `<iframe title="Material Video" src="${escapeHtml(embed)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>`;
    } else {
      const href = escapeHtml(material.external_url);
      preview.innerHTML = `
        <div class="d-flex flex-column gap-2 p-2 border rounded bg-white">
          <div class="text-body-secondary small">This link cannot be embedded, so it is shown below.</div>
          <a href="${href}" target="_blank" rel="noopener noreferrer" class="btn btn-outline-primary btn-sm align-self-start">Open link</a>
        </div>
      `;
    }
  } else {
    preview.innerHTML = "";
  }
}

function getPublicMaterialUrl(rawPath) {
  if (!rawPath) return "";
  const cleaned = String(rawPath).trim();
  if (/^https?:\/\//i.test(cleaned) || cleaned.startsWith("/uploads/")) {
    return encodeURI(cleaned);
  }
  const withoutLeadingDot = cleaned.replace(/^\.\//, "");
  if (withoutLeadingDot.startsWith("uploads/")) {
    return encodeURI(`/${withoutLeadingDot}`);
  }
  return encodeURI(cleaned);
}

function getEmbedUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl, window.location.origin);
    const hostname = url.hostname.replace(/^www\./, "");

    if (hostname === "youtube.com" || hostname === "m.youtube.com") {
      const videoId = url.searchParams.get("v");
      if (videoId) return `https://www.youtube.com/embed/${encodeURIComponent(videoId)}`;
    }

    if (hostname === "youtu.be") {
      const videoId = url.pathname.split("/").filter(Boolean)[0];
      if (videoId) return `https://www.youtube.com/embed/${encodeURIComponent(videoId)}`;
    }

    if (hostname === "youtube.com" && url.pathname.startsWith("/embed/")) {
      return url.toString();
    }

    return rawUrl;
  } catch (_err) {
    return null;
  }
}

async function loadCommentsForSelectedMaterial() {
  const material = getSelectedStudentMaterial();
  if (!material) {
    renderComments([]);
    return;
  }

  const resp = await apiFetch(`/materials/${material.id}/comments`);
  const data = await resp.json().catch(() => []);
  if (!resp.ok) throw new Error(data.detail || "Failed to load comments");
  renderComments(data);
}

function renderComments(items) {
  const container = el("commentsList");
  if (!container) return;
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) {
    container.innerHTML = '<div class="text-body-secondary">No comments yet.</div>';
    return;
  }

  container.innerHTML = rows
    .map(
      (item) => `
      <div class="border rounded p-2 mb-2">
        <div class="small text-body-secondary">${escapeHtml(item.user_name)} (${escapeHtml(item.user_role)}) • ${new Date(item.created_at).toLocaleString()}</div>
        <div>${escapeHtml(item.comment_text)}</div>
      </div>
    `
    )
    .join("");
}

async function loadLastOpenedBadge() {
  const badge = el("lastOpenedBadge");
  if (!badge) return;
  const resp = await apiFetch("/materials/last-opened");
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(data.detail || "Failed to load last opened material");
  if (!data) {
    badge.textContent = "Last opened: none";
    return;
  }
  badge.textContent = `Last opened: ${data.title}`;

  const selected = el("studentMaterials");
  if (selected && Number(selected.value || 0) === data.material_id) {
    badge.classList.remove("text-bg-primary");
    badge.classList.add("text-bg-success");
  } else {
    badge.classList.remove("text-bg-success");
    badge.classList.add("text-bg-primary");
  }
}

async function initTeacherPage() {
  await teacherLoadMaterials();
  await teacherLoadDashboard();

  el("teacherMaterialType")?.addEventListener("change", toggleTeacherUploadInputs);
  toggleTeacherUploadInputs();

  el("teacherTopRefreshBtn")?.addEventListener("click", async () => {
    await teacherLoadDashboard(teacherSelectedStudentId);
  });

  el("refreshTeacherDashboardBtn")?.addEventListener("click", async () => {
    await teacherLoadDashboard(teacherSelectedStudentId);
  });

  el("teacherMaterialFilter")?.addEventListener("change", async () => {
    teacherSelectedStudentId = Number(el("teacherStudentFilter")?.value || teacherSelectedStudentId || 0) || null;
    await teacherLoadDashboard(teacherSelectedStudentId);
  });

  el("teacherStudentFilter")?.addEventListener("change", async () => {
    teacherSelectedStudentId = Number(el("teacherStudentFilter")?.value || 0) || null;
    await teacherLoadStudentReport(teacherSelectedStudentId);
  });

  el("teacherUploadBtn")?.addEventListener("click", async () => {
    try {
      const type = el("teacherMaterialType")?.value || "pdf";
      const fd = new FormData();
      fd.append("title", (el("teacherTitle")?.value || "").trim());
      fd.append("subject", (el("teacherSubject")?.value || "").trim());
      fd.append("material_type", type);
      fd.append("instruction", (el("teacherInstruction")?.value || "").trim());
      const durationValue = (el("teacherDuration")?.value || "").trim();
      if (durationValue) fd.append("duration_minutes", durationValue);

      if (type === "link") {
        fd.append("external_url", (el("teacherExternalUrl")?.value || "").trim());
      } else {
        const file = el("teacherFile")?.files?.[0];
        if (!file) throw new Error("Please choose a PDF file");
        fd.append("file", file);
      }

      const resp = await apiFetch("/materials/upload", { method: "POST", body: fd });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.detail || "Upload failed");
      showMessage("Material uploaded.", "success");
      await teacherLoadMaterials(data.id);
      await teacherLoadDashboard(teacherSelectedStudentId);
    } catch (err) {
      showMessage(err.message);
    }
  });

  el("loadTeacherMaterialBtn")?.addEventListener("click", () => {
    teacherFillEditForm();
  });

  el("saveMaterialEditBtn")?.addEventListener("click", async () => {
    const material = getTeacherSelectedMaterial();
    if (!material) {
      showMessage("Select a material first.");
      return;
    }
    try {
      const payload = {
        title: (el("editTitle")?.value || "").trim(),
        subject: (el("editSubject")?.value || "").trim(),
        instruction: (el("editInstruction")?.value || "").trim(),
      };
      const durationRaw = (el("editDuration")?.value || "").trim();
      payload.duration_minutes = durationRaw ? Number(durationRaw) : null;
      const externalUrl = (el("editExternalUrl")?.value || "").trim();
      if (externalUrl) payload.external_url = externalUrl;

      const resp = await apiFetch(`/materials/${material.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.detail || "Update failed");
      showMessage("Material updated.", "success");
      await teacherLoadMaterials(material.id);
      await teacherLoadComments();
      await teacherLoadDashboard(teacherSelectedStudentId);
    } catch (err) {
      showMessage(err.message);
    }
  });

  el("assignMaterialBtn")?.addEventListener("click", async () => {
    const material = getTeacherSelectedMaterial();
    const studentId = Number(el("assignStudentId")?.value || 0);
    if (!material || !studentId) {
      showMessage("Select material and valid student ID.");
      return;
    }
    try {
      const fd = new URLSearchParams();
      fd.append("student_id", String(studentId));
      const resp = await apiFetch(`/materials/${material.id}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: fd,
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.detail || "Assignment failed");
      showMessage(data.already_assigned ? "Student already assigned." : "Material assigned.", "success");
      await teacherLoadDashboard(teacherSelectedStudentId);
    } catch (err) {
      showMessage(err.message);
    }
  });

  el("loadTeacherCommentsBtn")?.addEventListener("click", teacherLoadComments);
  el("teacherMaterialSelect")?.addEventListener("change", async () => {
    teacherFillEditForm();
    await teacherLoadComments();
    await teacherLoadDashboard(teacherSelectedStudentId);
  });

  teacherFillEditForm();
  await teacherLoadComments();
}

function toggleTeacherUploadInputs() {
  const type = el("teacherMaterialType")?.value || "pdf";
  const fileInput = el("teacherFile");
  const urlInput = el("teacherExternalUrl");
  if (fileInput) fileInput.disabled = type === "link";
  if (urlInput) urlInput.disabled = type !== "link";
}

async function teacherLoadMaterials(selectId = null) {
  const resp = await apiFetch("/materials");
  const list = await resp.json().catch(() => []);
  if (!resp.ok) throw new Error(list.detail || "Failed to load materials");

  studentMaterialsData = Array.isArray(list) ? list : [];
  const select = el("teacherMaterialSelect");
  if (!select) return;
  select.innerHTML = "";

  for (const item of studentMaterialsData) {
    const option = document.createElement("option");
    option.value = String(item.id);
    option.textContent = `${item.title} — ${item.subject} (${item.file_type})`;
    select.appendChild(option);
  }

  if (selectId) select.value = String(selectId);
  if (!select.value && studentMaterialsData[0]) select.value = String(studentMaterialsData[0].id);
}

function getTeacherSelectedMaterial() {
  const selectedId = Number(el("teacherMaterialSelect")?.value || 0);
  return studentMaterialsData.find((m) => m.id === selectedId) || null;
}

function teacherFillEditForm() {
  const material = getTeacherSelectedMaterial();
  if (!material) return;
  if (el("editTitle")) el("editTitle").value = material.title || "";
  if (el("editSubject")) el("editSubject").value = material.subject || "";
  if (el("editDuration")) el("editDuration").value = material.duration_minutes || "";
  if (el("editInstruction")) el("editInstruction").value = material.instruction || "";
  if (el("editExternalUrl")) el("editExternalUrl").value = material.external_url || "";
}

async function teacherLoadComments() {
  const material = getTeacherSelectedMaterial();
  const container = el("teacherComments");
  if (!container) return;
  if (!material) {
    container.innerHTML = '<div class="text-body-secondary">No material selected.</div>';
    return;
  }

  const resp = await apiFetch(`/materials/${material.id}/comments`);
  const data = await resp.json().catch(() => []);
  if (!resp.ok) throw new Error(data.detail || "Failed to load comments");

  if (!Array.isArray(data) || !data.length) {
    container.innerHTML = '<div class="text-body-secondary">No comments yet.</div>';
    return;
  }

  container.innerHTML = data
    .map(
      (item) => `
      <div class="border rounded p-2 mb-2">
        <div class="small text-body-secondary">${escapeHtml(item.user_name)} (${escapeHtml(item.user_role)}) • ${new Date(item.created_at).toLocaleString()}</div>
        <div>${escapeHtml(item.comment_text)}</div>
      </div>
    `
    )
    .join("");
}

function teacherLocalStorageKey(prefix, studentId) {
  return `${prefix}:${studentId}`;
}

function teacherFormatValue(value, digits = 2) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue.toFixed(digits) : "0.00";
}

function teacherFormatTime(value) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString();
  } catch (_err) {
    return "-";
  }
}

function teacherEmotionLabel(valence, arousal) {
  if (valence > 0.2 && arousal > 0.55) return "engaged";
  if (valence > 0.2 && arousal <= 0.55) return "calm";
  if (valence < -0.25 && arousal > 0.55) return "possible confusion";
  if (valence < -0.35 && arousal > 0.45) return "possible frustration";
  if (arousal < 0.35) return "low engagement";
  return "steady";
}

function teacherSetChipState(container, activeValue) {
  if (!container) return;
  container.querySelectorAll("[data-self-report]").forEach((button) => {
    button.classList.toggle("active", button.dataset.selfReport === activeValue);
  });
}

function teacherClearChart(chartRef) {
  if (chartRef && typeof chartRef.destroy === "function") {
    chartRef.destroy();
  }
}

function teacherRenderLineChart(canvasId, chartRefName, labels, valenceSeries, arousalSeries) {
  const canvas = el(canvasId);
  if (!canvas || typeof Chart === "undefined") return null;
  const existing = chartRefName === "class" ? teacherClassTimelineChart : teacherStudentTimelineChart;
  teacherClearChart(existing);
  const nextChart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Valence", data: valenceSeries, borderColor: "#2f6fed", backgroundColor: "rgba(47,111,237,0.12)", tension: 0.28, fill: true },
        { label: "Arousal", data: arousalSeries, borderColor: "#ef4444", backgroundColor: "rgba(239,68,68,0.12)", tension: 0.28, fill: true },
      ],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { display: false },
        y: { min: -1, max: 1, ticks: { stepSize: 0.5 } },
      },
      plugins: {
        legend: { labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true } },
      },
    },
  });
  if (chartRefName === "class") teacherClassTimelineChart = nextChart;
  else teacherStudentTimelineChart = nextChart;
  return nextChart;
}

function teacherRenderScatter(divId, chartRefName, points) {
  const target = el(divId);
  if (!target || typeof Plotly === "undefined") return;
  const x = points.map((point) => Number(point.valence || 0));
  const y = points.map((point) => Number(point.arousal || 0) * 2 - 1);
  const text = points.map((point) => `${point.label || "Learner"} • ${teacherFormatTime(point.timestamp)}`);
  const trace = {
    x,
    y,
    text,
    mode: "markers",
    type: "scatter",
    marker: { color: chartRefName === "class" ? "#6f42c1" : "#0ea5e9", size: 8, opacity: 0.9 },
  };
  const layout = {
    margin: { l: 50, r: 20, t: 20, b: 45 },
    xaxis: { range: [-1, 1], title: "Valence", zeroline: false, showgrid: false },
    yaxis: { range: [-1, 1], title: "Arousal", zeroline: false, showgrid: false },
    showlegend: false,
    hovermode: "closest",
  };
  Plotly.newPlot(target, [trace], layout, { responsive: true, displayModeBar: false });
  if (chartRefName === "class") teacherClassScatterChart = target;
  else teacherStudentScatterChart = target;
}

function teacherRenderRoster(students) {
  const roster = el("teacherStudentRoster");
  if (!roster) return;
  if (!Array.isArray(students) || !students.length) {
    roster.innerHTML = '<div class="text-body-secondary small">No students are available yet.</div>';
    return;
  }

  roster.innerHTML = students
    .map((student) => {
      const flags = Array.isArray(student.support_flags) ? student.support_flags : [];
      const flagText = flags.slice(0, 2).join(" • ");
      return `
        <button class="teacher-roster-item" type="button" data-student-id="${student.id}">
          <div class="teacher-roster-name">${escapeHtml(student.name || `Student ${student.id}`)}</div>
          <div class="teacher-roster-meta">${student.assignment_count || 0} assignments • ${teacherEmotionLabel(student.valence_mean, student.arousal_mean)}</div>
          <div class="teacher-roster-footnote">${escapeHtml(flagText || "No current support flag")}</div>
        </button>
      `;
    })
    .join("");

  roster.querySelectorAll("[data-student-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      const studentId = Number(button.dataset.studentId || 0);
      if (!studentId) return;
      teacherSelectedStudentId = studentId;
      const studentFilter = el("teacherStudentFilter");
      if (studentFilter) studentFilter.value = String(studentId);
      await teacherLoadStudentReport(studentId);
    });
  });
}

function teacherPopulateFilters(data) {
  const materialFilter = el("teacherMaterialFilter");
  const studentFilter = el("teacherStudentFilter");
  if (materialFilter) {
    const previous = materialFilter.value;
    materialFilter.innerHTML = '<option value="">All materials</option>';
    for (const material of Array.isArray(data?.materials) ? data.materials : []) {
      const option = document.createElement("option");
      option.value = String(material.id);
      option.textContent = `${material.title} (${material.file_type})`;
      materialFilter.appendChild(option);
    }
    if (previous) materialFilter.value = previous;
  }

  const studentOptions = Array.isArray(data?.students) ? data.students : [];
  if (studentFilter) {
    const previous = studentFilter.value;
    studentFilter.innerHTML = '<option value="">Choose a student</option>';
    for (const student of studentOptions) {
      const option = document.createElement("option");
      option.value = String(student.id);
      option.textContent = `${student.name || `Student ${student.id}`} • ${teacherEmotionLabel(student.valence_mean, student.arousal_mean)}`;
      studentFilter.appendChild(option);
    }
    if (previous) studentFilter.value = previous;
  }
}

function teacherRenderSummary(data) {
  const materials = Array.isArray(data?.materials) ? data.materials : [];
  const students = Array.isArray(data?.students) ? data.students : [];
  const assignmentSummary = data?.assignment_summary || {};
  const supportCount = students.filter((student) => Array.isArray(student.support_flags) && student.support_flags.some((flag) => flag !== "steady" && flag !== "calm / steady")).length;

  const materialsMetric = el("teacherMetricMaterials");
  const assignmentsMetric = el("teacherMetricAssignments");
  const studentsMetric = el("teacherMetricStudents");
  const supportMetric = el("teacherMetricSupport");
  const dashboardStatus = el("teacherDashboardStatus");
  const assignmentSummaryChip = el("teacherAssignmentSummary");

  if (materialsMetric) materialsMetric.textContent = String(materials.length);
  if (assignmentsMetric) assignmentsMetric.textContent = String(assignmentSummary.total || 0);
  if (studentsMetric) studentsMetric.textContent = String(students.length);
  if (supportMetric) supportMetric.textContent = String(supportCount);
  if (dashboardStatus) {
    dashboardStatus.textContent = `${data?.count || 0} emotion logs • ${teacherFormatValue(data?.valence_mean || 0)} valence • ${teacherFormatValue(data?.arousal_mean || 0)} arousal`;
  }
  if (assignmentSummaryChip) {
    assignmentSummaryChip.textContent = `${assignmentSummary.active || 0} active • ${assignmentSummary.pending || 0} pending • ${assignmentSummary.completed || 0} completed`;
  }

  const consentNote = el("teacherConsentNote");
  if (consentNote) {
    consentNote.textContent = data?.consent_note || "Show emotion data only after active consent is confirmed for the learner session.";
  }
}

function teacherRenderClassCharts(data) {
  const recentLogs = Array.isArray(data?.recent_logs) ? data.recent_logs.slice().reverse() : [];
  const labels = recentLogs.map((row) => new Date(row.timestamp).toLocaleTimeString());
  const valences = recentLogs.map((row) => Number(row.valence || 0));
  const arousals = recentLogs.map((row) => Number(row.arousal || 0) * 2 - 1);
  teacherRenderLineChart("teacherClassTimeline", "class", labels, valences, arousals);
  teacherRenderScatter(
    "teacherClassScatter",
    "class",
    recentLogs.map((row) => ({
      valence: row.valence,
      arousal: row.arousal,
      label: row.student_name || `Student ${row.student_id}`,
      timestamp: row.timestamp,
    }))
  );
}

function teacherRenderProgressTable(data) {
  const tbody = el("teacherProgressTable");
  if (!tbody) return;
  const students = Array.isArray(data?.students) ? data.students : [];
  if (!students.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-body-secondary">No student data yet.</td></tr>';
    return;
  }

  tbody.innerHTML = students
    .map((student) => {
      const support = Array.isArray(student.support_flags) ? student.support_flags[0] || "steady" : "steady";
      return `
        <tr class="teacher-progress-row" data-student-id="${student.id}">
          <td>
            <div class="fw-semibold">${escapeHtml(student.name || `Student ${student.id}`)}</div>
            <div class="small text-body-secondary">${escapeHtml(student.email || "")}</div>
          </td>
          <td><span class="teacher-chip teacher-chip-soft">${escapeHtml(student.status || "pending")}</span></td>
          <td>${student.assignment_count || 0}</td>
          <td>${student.opened_count || 0}</td>
          <td>${student.completed_count || 0}</td>
          <td>${Math.round((Number(student.focus_ratio || 0) * 100))}%</td>
          <td>${escapeHtml(support)}</td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll("[data-student-id]").forEach((row) => {
    row.addEventListener("click", async () => {
      const studentId = Number(row.dataset.studentId || 0);
      if (!studentId) return;
      teacherSelectedStudentId = studentId;
      const studentFilter = el("teacherStudentFilter");
      if (studentFilter) studentFilter.value = String(studentId);
      await teacherLoadStudentReport(studentId);
    });
  });
}

function teacherRenderMaterialStatus(data) {
  const materials = Array.isArray(data?.materials) ? data.materials : [];
  const materialFilter = el("teacherMaterialFilter");
  const teacherMaterialSelect = el("teacherMaterialSelect");
  if (materialFilter && !materialFilter.value && materials[0]) materialFilter.value = String(materials[0].id);
  if (teacherMaterialSelect && !teacherMaterialSelect.value && materials[0]) teacherMaterialSelect.value = String(materials[0].id);
}

function teacherSuggestionList(student) {
  const suggestions = [];
  const flags = Array.isArray(student?.support_flags) ? student.support_flags : [];
  if (flags.includes("possible confusion")) suggestions.push("Offer a short recap or a worked example after class.");
  if (flags.includes("low engagement")) suggestions.push("Break the task into smaller steps and check in earlier.");
  if (flags.includes("possible frustration")) suggestions.push("Pause for encouragement and remove unnecessary task load.");
  if (!suggestions.length) suggestions.push("Continue monitoring. The current pattern looks steady.");
  return suggestions;
}

function teacherCompareSelfReport(student, selfReportText) {
  const emotionWord = teacherEmotionLabel(student?.valence_mean || 0, student?.arousal_mean || 0);
  const report = String(selfReportText || "").toLowerCase();
  if (!report) return `Self-report not captured yet. The current emotion summary looks ${emotionWord}.`;
  if (report.includes("confus")) return `Self-report mentions confusion, which aligns with the ${emotionWord} signal.`;
  if (report.includes("frustrat")) return `Self-report mentions frustration, which aligns with the ${emotionWord} signal.`;
  if (report.includes("focus") || report.includes("engag")) return `Self-report suggests attention or engagement, while the emotion summary looks ${emotionWord}.`;
  if (report.includes("calm") || report.includes("fine")) return `Self-report sounds calm, and the emotion summary looks ${emotionWord}.`;
  return `Self-report recorded. The current emotion summary still reads as ${emotionWord}, so compare it with your lesson context.`;
}

async function teacherLoadDashboard(preferredStudentId = null) {
  const materialFilter = Number(el("teacherMaterialFilter")?.value || 0) || null;
  const studentFilter = Number(preferredStudentId || el("teacherStudentFilter")?.value || 0) || null;
  const params = new URLSearchParams();
  if (materialFilter) params.set("material_id", String(materialFilter));
  if (studentFilter) params.set("student_id", String(studentFilter));

  const resp = await apiFetch(`/teacher/dashboard${params.toString() ? `?${params.toString()}` : ""}`);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.detail || "Failed to load teacher dashboard");

  teacherDashboardData = data;
  teacherPopulateFilters(data);
  teacherRenderSummary(data);
  teacherRenderProgressTable(data);
  teacherRenderRoster(data.students || []);
  teacherRenderClassCharts(data);
  teacherRenderMaterialStatus(data);

  const currentStudentId = preferredStudentId || teacherSelectedStudentId || Number(el("teacherStudentFilter")?.value || 0) || (data.students && data.students[0] ? data.students[0].id : 0);
  if (currentStudentId) {
    teacherSelectedStudentId = currentStudentId;
    const studentFilter = el("teacherStudentFilter");
    if (studentFilter) studentFilter.value = String(currentStudentId);
    await teacherLoadStudentReport(currentStudentId, materialFilter);
  } else {
    teacherRenderEmptyStudentState();
  }
}

function teacherRenderEmptyStudentState() {
  const title = el("teacherSelectedStudentTitle");
  const meta = el("teacherSelectedStudentMeta");
  const consent = el("teacherSelectedStudentConsent");
  const summary = el("teacherSelectedStudentSummary");
  const note = el("teacherSelectedStudentNote");
  const support = el("teacherStudentSupportList");
  if (title) title.textContent = "Select a student";
  if (meta) meta.textContent = "Choose a learner from the table or dropdown.";
  if (consent) consent.textContent = "Consent pending";
  if (summary) {
    summary.innerHTML = '<tr><td colspan="2" class="text-body-secondary">The student summary will appear here after selection.</td></tr>';
  }
  if (note) note.textContent = "Select a learner to see a short, supportive interpretation and suggested follow-up.";
  if (support) support.textContent = "Select a learner to see support-oriented suggestions.";
}

async function teacherLoadStudentReport(studentId, materialId = null) {
  if (!studentId) {
    teacherRenderEmptyStudentState();
    return;
  }

  const params = new URLSearchParams();
  params.set("student_id", String(studentId));
  if (materialId) params.set("material_id", String(materialId));

  const resp = await apiFetch(`/student/dashboard?${params.toString()}`);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.detail || "Failed to load student report");

  const student = (teacherDashboardData?.students || []).find((item) => Number(item.id) === Number(studentId)) || { id: studentId };
  const title = el("teacherSelectedStudentTitle");
  const meta = el("teacherSelectedStudentMeta");
  const consent = el("teacherSelectedStudentConsent");
  const summary = el("teacherSelectedStudentSummary");
  const note = el("teacherSelectedStudentNote");
  const support = el("teacherStudentSupportList");

  if (title) title.textContent = student.name || `Student ${studentId}`;
  if (meta) meta.textContent = `${student.assignment_count || 0} assignments • ${student.completed_count || 0} completed • focus ${Math.round((Number(student.focus_ratio || 0) * 100))}%`;
  if (consent) {
    consent.textContent = student.consent_active ? "Consent active" : "Consent required";
    consent.classList.toggle("teacher-chip-warning", !student.consent_active);
  }

  const timelineValues = Array.isArray(data.times) ? data.times : [];
  const valences = Array.isArray(data.valences) ? data.valences : [];
  const arousals = Array.isArray(data.arousals) ? data.arousals.map((value) => Number(value) * 2 - 1) : [];

  const emotionWord = teacherEmotionLabel(student.valence_mean || 0, student.arousal_mean || 0);
  const supportFlags = Array.isArray(student.support_flags) ? student.support_flags : [];
  const durationText = data.times && data.times.length > 1 ? `${Math.max(1, Math.round((new Date(data.times[data.times.length - 1]) - new Date(data.times[0])) / 60000))} min observed` : "Insufficient duration data";
  const tableRows = [
    ["Emotion summary", emotionWord],
    ["Observed focus ratio", `${Math.round((Number(student.focus_ratio || data.focus_ratio || 0) * 100))}%`],
    ["Timeline coverage", durationText],
    ["Valence mean", teacherFormatValue(student.valence_mean || 0)],
    ["Arousal mean", teacherFormatValue(student.arousal_mean || 0)],
    ["Open / completed", `${student.opened_count || 0} opened • ${student.completed_count || 0} completed`],
    ["Support cue", supportFlags.join(", ") || "steady"],
    ["Consent", student.consent_active ? "Active" : "Required"],
  ];
  if (summary) {
    summary.innerHTML = tableRows
      .map(
        ([label, value]) => `
          <tr>
            <th scope="row">${escapeHtml(label)}</th>
            <td>${escapeHtml(value)}</td>
          </tr>
        `
      )
      .join("");
  }
  if (note) {
    note.textContent = `This summary is a support cue only. ${supportFlags.some((flag) => flag !== "steady") ? "Possible follow-up may help." : "The current pattern looks stable."}`;
  }
  if (support) {
    support.innerHTML = teacherSuggestionList(student)
      .map((item) => `<div class="teacher-support-item">${escapeHtml(item)}</div>`)
      .join("");
  }
}

async function initAdminPage() {
  await adminLoadStats();
  await adminLoadActivity();

  el("refreshAdminStatsBtn")?.addEventListener("click", adminLoadStats);
  el("refreshAdminActivityBtn")?.addEventListener("click", adminLoadActivity);

  el("toggleUserActiveBtn")?.addEventListener("click", async () => {
    const userId = Number(el("adminUserId")?.value || 0);
    const active = (el("adminUserActive")?.value || "true") === "true";
    if (!userId) {
      showMessage("Provide a valid user ID.");
      return;
    }
    try {
      const resp = await apiFetch(`/admin/users/${userId}/active?is_active=${active}`, { method: "PATCH" });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.detail || "Failed to update user status");
      showMessage(`User ${data.user_id} status updated to ${data.is_active}.`, "success");
      await adminLoadActivity();
    } catch (err) {
      showMessage(err.message);
    }
  });

  el("downloadExportBtn")?.addEventListener("click", async () => {
    try {
      const resp = await apiFetch("/admin/export.csv");
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.detail || "Export failed");
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "research_export.csv";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      showMessage("CSV export downloaded.", "success");
    } catch (err) {
      showMessage(err.message);
    }
  });
}

async function adminLoadStats() {
  const resp = await apiFetch("/admin/stats");
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.detail || "Failed to load admin stats");
  if (el("statsUsers")) el("statsUsers").textContent = `${data.users_active}/${data.users_total}`;
  if (el("statsMaterials")) el("statsMaterials").textContent = String(data.materials_total || 0);
  if (el("statsComments")) el("statsComments").textContent = String(data.comments_total || 0);
  if (el("statsLogs")) el("statsLogs").textContent = String(data.logs_total || 0);
}

async function adminLoadActivity() {
  const resp = await apiFetch("/admin/activity");
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.detail || "Failed to load activity");
  const body = el("adminActivityBody");
  if (!body) return;
  const items = Array.isArray(data.items) ? data.items : [];
  body.innerHTML = items
    .map((item) => {
      const actor = item.actor_name ? `${item.actor_name} (${item.actor_role || "-"})` : "-";
      const detail = item.detail || `${item.entity_type || ""} ${item.entity_id || ""}`;
      return `<tr>
        <td>${new Date(item.timestamp).toLocaleString()}</td>
        <td>${escapeHtml(item.event_type || "")}</td>
        <td>${escapeHtml(actor)}</td>
        <td>${escapeHtml(detail)}</td>
      </tr>`;
    })
    .join("");
}

async function startCamera() {
  if (stream) return;
  video = el("video");
  canvas = el("canvas");
  overlayCanvas = el("overlay");
  bboxRect = el("bboxRect");
  if (!video || !canvas || !overlayCanvas || !bboxRect) return;

  ctx = canvas.getContext("2d");
  overlayCtx = overlayCanvas.getContext("2d");
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    video.srcObject = stream;
    video.addEventListener(
      "loadedmetadata",
      () => {
        const w = video.videoWidth || 320;
        const h = video.videoHeight || 240;
        canvas.width = w;
        canvas.height = h;
        overlayCanvas.width = w;
        overlayCanvas.height = h;
      },
      { once: true }
    );
    await video.play();
  } catch (e) {
    showMessage("Could not access camera: " + e.message);
  }
}

async function captureAndSend() {
  if (!video || video.readyState < 2 || !sessionId) return;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  canvas.toBlob(
    async (blob) => {
      try {
        const fd = new FormData();
        fd.append("file", blob, "frame.jpg");
        const resp = await apiFetch("/predict", { method: "POST", body: fd });
        if (!resp.ok) {
          drawBoundingBox(null);
          const latest = el("latest");
          let msg = "predict failed";
          try {
            const err = await resp.json();
            if (err && err.detail) msg = err.detail;
          } catch (_e) {}
          if (latest) latest.textContent = msg;
          return;
        }

        const data = await resp.json();
        const latest = el("latest");
        if (latest) {
          latest.textContent = `valence=${data.valence.toFixed(2)} arousal=${data.arousal.toFixed(2)} source=${(data.bbox && data.bbox.source) || "none"}`;
        }

        updateLiveEmotionSummary(data);

        drawBoundingBox(data.bbox, { width: data.frame_width, height: data.frame_height });

        // update timeline + circumplex immediately for realtime UI
        pushTimeline(data);

        // keep logging, but do not block chart updates on network/database latency
        apiFetch("/emotion/log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: sessionId,
            valence: data.valence,
            arousal: data.arousal,
            confidence: data.confidence || null,
            model_version: data.model_version || null,
            client_timestamp: new Date().toISOString(),
            source: "server-fallback",
          }),
        }).catch((_e) => {});
      } catch (err) {
        if (el("latest")) el("latest").textContent = err.message;
      }
    },
    "image/jpeg",
    0.8
  );
}

function drawBoundingBox(bbox, frameSize) {
  if (!overlayCtx || !overlayCanvas || !bboxRect) return;
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  if (!bbox || bbox.width <= 0 || bbox.height <= 0) {
    bboxRect.style.display = "none";
    return;
  }

  const sourceW = frameSize && frameSize.width ? Number(frameSize.width) : overlayCanvas.width;
  const sourceH = frameSize && frameSize.height ? Number(frameSize.height) : overlayCanvas.height;
  const targetW = overlayCanvas.clientWidth || overlayCanvas.width;
  const targetH = overlayCanvas.clientHeight || overlayCanvas.height;
  const scaleX = sourceW > 0 ? targetW / sourceW : 1;
  const scaleY = sourceH > 0 ? targetH / sourceH : 1;

  const x = Math.max(0, Math.round(Number(bbox.x) * scaleX));
  const y = Math.max(0, Math.round(Number(bbox.y) * scaleY));
  const w = Math.max(1, Math.round(Number(bbox.width) * scaleX));
  const h = Math.max(1, Math.round(Number(bbox.height) * scaleY));

  bboxRect.style.display = "block";
  bboxRect.style.left = `${x}px`;
  bboxRect.style.top = `${y}px`;
  bboxRect.style.width = `${w}px`;
  bboxRect.style.height = `${h}px`;
}

function initCharts() {
  if (timelineChart && scatterChart) return;
  const timelineCanvas = el("timelineChart");
  const scatterDiv = el("scatterChart");
  if (!timelineCanvas) return;

  // timeline chart remains Chart.js
  if (!timelineChart && typeof Chart !== "undefined") {
    timelineChart = new Chart(timelineCanvas.getContext("2d"), {
      type: "line",
      data: {
        labels: [],
        datasets: [
          { label: "Valence", data: [], borderColor: "blue", fill: false },
          { label: "Arousal", data: [], borderColor: "red", fill: false },
        ],
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            display: false,
            grid: { display: false },
          },
          y: {
            min: -1,
            max: 1,
            ticks: { stepSize: 0.5 },
          },
        },
        elements: {
          point: { radius: 1.5, hoverRadius: 3, borderWidth: 1 },
        },
        plugins: {
          legend: {
            labels: {
              boxWidth: 10,
              boxHeight: 10,
              usePointStyle: true,
              pointStyle: "line",
            },
          },
        },
      },
    });
  }

  // Arousal–Valence circumplex using Plotly
  if (!scatterDiv || typeof Plotly === "undefined") return;

  scatterChart = scatterDiv; // use DOM element as reference

  const trace = {
    x: [],
    y: [],
    mode: "markers",
    type: "scatter",
    name: "Arousal vs Valence",
    marker: { color: "#6f42c1", size: 8, opacity: 0.9, line: { width: 0 } },
  };

  // background shapes: left (warm) and right (cool), circle boundary, and axes lines
  const shapes = [
    // left half soft pink/red
    {
      type: "rect",
      xref: "x",
      yref: "y",
      x0: -1,
      x1: 0,
      y0: -1,
      y1: 1,
      fillcolor: "rgba(255,200,200,0.4)",
      line: { width: 0 },
    },
    // right half soft cyan/blue
    {
      type: "rect",
      xref: "x",
      yref: "y",
      x0: 0,
      x1: 1,
      y0: -1,
      y1: 1,
      fillcolor: "rgba(200,235,255,0.45)",
      line: { width: 0 },
    },
    // circular boundary (approximated by circle shape)
    {
      type: "circle",
      xref: "x",
      yref: "y",
      x0: -1,
      x1: 1,
      y0: -1,
      y1: 1,
      line: { color: "rgba(80,80,80,0.9)", width: 2 },
    },
    // x and y axes (thicker zerolines)
    { type: "line", x0: -1, x1: 1, y0: 0, y1: 0, xref: "x", yref: "y", line: { color: "#333", width: 1 } },
    { type: "line", x0: 0, x1: 0, y0: -1, y1: 1, xref: "x", yref: "y", line: { color: "#333", width: 1 } },
  ];

  const annotations = [
    // quadrant titles
    { x: -0.6, y: 0.65, text: "Anger", showarrow: false, font: { size: 14, color: "#6b0300", family: "Helvetica, Arial, sans-serif" } },
    { x: 0.6, y: 0.65, text: "Joy", showarrow: false, font: { size: 14, color: "#0b4b66", family: "Helvetica, Arial, sans-serif" } },
    { x: -0.6, y: -0.65, text: "Sadness", showarrow: false, font: { size: 14, color: "#3a1f5a", family: "Helvetica, Arial, sans-serif" } },
    { x: 0.6, y: -0.65, text: "Pleasure", showarrow: false, font: { size: 14, color: "#025e73", family: "Helvetica, Arial, sans-serif" } },
    // axis end annotations
    { x: 0, y: 1.08, text: "(active)", showarrow: false, font: { size: 12 } },
    { x: 0, y: -1.08, text: "(passive)", showarrow: false, font: { size: 12 } },
    { x: -1.08, y: 0, text: "(negative)", showarrow: false, font: { size: 12 } },
    { x: 1.08, y: 0, text: "(positive)", showarrow: false, font: { size: 12 } },
    // emotion word examples (approx locations)
    { x: -0.75, y: 0.45, text: "furious, annoyed, disgusted", showarrow: false, font: { size: 11, color: "#6b0300" } },
    { x: 0.7, y: 0.45, text: "excited, delighted, blissful", showarrow: false, font: { size: 11, color: "#0b4b66" } },
    { x: -0.7, y: -0.45, text: "disappointed, depressed, bored", showarrow: false, font: { size: 11, color: "#3a1f5a" } },
    { x: 0.7, y: -0.45, text: "serene, relaxed", showarrow: false, font: { size: 11, color: "#025e73" } },
  ];

  const layout = {
    xaxis: {
      range: [-1, 1],
      zeroline: false,
      showgrid: false,
      title: "Valence",
      tickmode: "array",
      tickvals: [-1, -0.5, 0, 0.5, 1],
      ticktext: ["-1", "-0.5", "0", "0.5", "1"],
    },
    yaxis: {
      range: [-1, 1],
      zeroline: false,
      showgrid: false,
      title: "Arousal",
    },
    shapes: shapes,
    annotations: annotations,
    margin: { l: 60, r: 60, t: 40, b: 60 },
    showlegend: false,
    hovermode: "closest",
    // keep equal aspect ratio
    yaxis: Object.assign({ scaleanchor: "x", scaleratio: 1 }, { range: [-1, 1], title: "Arousal" }),
  };

  Plotly.newPlot(scatterDiv, [trace], layout, { responsive: true, displayModeBar: false });
}

function pushTimeline(data) {
  // allow timeline updates even if Plotly is not available
  const t = new Date().toLocaleTimeString();

  if (timelineChart) {
    timelineChart.data.labels.push(t);
    timelineChart.data.datasets[0].data.push(data.valence);
    timelineChart.data.datasets[1].data.push(data.arousal);
    if (timelineChart.data.labels.length > 60) {
      timelineChart.data.labels.shift();
      timelineChart.data.datasets.forEach((ds) => ds.data.shift());
    }
    timelineChart.update("none");
  }

  // Update Plotly circumplex: convert arousal (0..1) to display coord (-1..1)
  if (scatterChart && typeof Plotly !== "undefined") {
    try {
      const displayArousal = Number(data.arousal) * 2.0 - 1.0;
      // scatterChart is the DOM node used for Plotly
      // show only current live emotion (no history trail)
      Plotly.restyle(scatterChart, { x: [[Number(data.valence)]], y: [[displayArousal]] }, [0]);
    } catch (e) {
      // silent fail to avoid breaking main flow
    }
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

bootstrap();
