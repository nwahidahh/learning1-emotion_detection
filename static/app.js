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
    stream.getTracks().forEach((t) => t.stop());
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
        const resp = await fetch("/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: (el("registerName")?.value || "").trim(),
            email: (el("registerEmail")?.value || "").trim(),
            password: el("registerPassword")?.value || "",
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
      if (material.file_type === "link" && material.external_url) {
        window.open(material.external_url, "_blank", "noopener,noreferrer");
      } else if (material.file_path) {
        window.open(material.file_path.replace("./", "/"), "_blank");
      }
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

  const happy = Math.max(0, Math.round(Math.max(v, 0) * 45 + Math.max(a, 0) * 35));
  const sad = Math.max(0, Math.round(Math.max(-v, 0) * 50 + Math.max(0.55 - a, 0) * 40));
  const surprised = Math.max(0, Math.round(Math.max(a - 0.7, 0) * 100 * (0.6 + Math.abs(v) * 0.4)));
  const focused = Math.max(0, Math.round(Math.max(a - 0.35, 0) * 45 * (1 - Math.min(Math.abs(v), 0.9))));
  const neutral = Math.max(0, Math.round((1 - Math.min(Math.abs(v), 1)) * (1 - Math.min(Math.abs(a - 0.5) * 1.3, 1)) * 85));

  const raw = { happy, neutral, focused, surprised, sad };
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
    happy: "Happy",
    neutral: "Neutral",
    focused: "Focused",
    surprised: "Surprised",
    sad: "Sad",
  };

  const ring = el("liveEmotionRing");
  const label = el("liveEmotionLabel");
  const ratio = el("liveEmotionPct");
  const emoHappy = el("emoHappy");
  const emoNeutral = el("emoNeutral");
  const emoFocused = el("emoFocused");
  const emoSurprised = el("emoSurprised");
  const emoSad = el("emoSad");
  if (!ring || !label || !ratio || !emoHappy || !emoNeutral || !emoFocused || !emoSurprised || !emoSad) return;

  const dominantPct = Math.max(0, Math.min(100, pct[dominant] || 0));
  const sweep = Math.round((dominantPct / 100) * 360);
  ring.style.background = `conic-gradient(#22c55e 0deg, #22c55e ${sweep}deg, #d1d5db ${sweep}deg, #d1d5db 360deg)`;
  ring.textContent = `${dominantPct}%`;
  label.textContent = labelMap[dominant] || "Neutral";
  ratio.textContent = `${dominantPct}%`;

  emoHappy.textContent = `${pct.happy || 0}%`;
  emoNeutral.textContent = `${pct.neutral || 0}%`;
  emoFocused.textContent = `${pct.focused || 0}%`;
  emoSurprised.textContent = `${pct.surprised || 0}%`;
  emoSad.textContent = `${pct.sad || 0}%`;
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
  if (!studentSelect || !sessionSelect) return;

  const resp = await apiFetch("/materials");
  const list = await resp.json().catch(() => []);
  if (!resp.ok) throw new Error(list.detail || "Failed to load materials");

  studentMaterialsData = Array.isArray(list) ? list : [];

  studentSelect.innerHTML = "";
  sessionSelect.innerHTML = '<option value="">No material selected</option>';
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

  renderSelectedMaterialDetail();
  await loadCommentsForSelectedMaterial();
  await loadLastOpenedBadge();
}

function getSelectedStudentMaterial() {
  const selectedId = Number(el("studentMaterials")?.value || 0);
  return studentMaterialsData.find((m) => m.id === selectedId) || null;
}

function renderSelectedMaterialDetail() {
  const detail = el("materialDetail");
  if (!detail) return;
  const material = getSelectedStudentMaterial();
  if (!material) {
    detail.textContent = "No material selected.";
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

  el("teacherMaterialType")?.addEventListener("change", toggleTeacherUploadInputs);
  toggleTeacherUploadInputs();

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
    } catch (err) {
      showMessage(err.message);
    }
  });

  el("loadTeacherCommentsBtn")?.addEventListener("click", teacherLoadComments);
  el("teacherMaterialSelect")?.addEventListener("change", async () => {
    teacherFillEditForm();
    await teacherLoadComments();
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
  if (!timelineCanvas || !scatterDiv) return;

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
      options: { animation: false },
    });
  }

  // Arousal–Valence circumplex using Plotly
  if (typeof Plotly === "undefined") return;

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
  // allow Plotly updates even if timelineChart (Chart.js) isn't initialized
  if (!scatterChart) return;
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
  try {
    const displayArousal = Number(data.arousal) * 2.0 - 1.0;
    // scatterChart is the DOM node used for Plotly
    // show only current live emotion (no history trail)
    Plotly.restyle(scatterChart, { x: [[Number(data.valence)]], y: [[displayArousal]] }, [0]);
  } catch (e) {
    // silent fail to avoid breaking main flow
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
