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
      captureLoop = setInterval(captureAndSend, 1000);
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
    consentStatus.textContent = data ? `Consent status: ${data.status}` : "Consent status: not provided.";
    return;
  }

  consentSection.style.display = "none";
  monitor.style.display = "block";
  consentStatus.textContent = `Consent status: accepted (${new Date(data.timestamp).toLocaleString()})`;
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

        drawBoundingBox(data.bbox, { width: data.frame_width, height: data.frame_height });

        await apiFetch("/emotion/log", {
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
        });

        pushTimeline(data);
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
  const scatterCanvas = el("scatterChart");
  if (!timelineCanvas || !scatterCanvas || typeof Chart === "undefined") return;

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

  scatterChart = new Chart(scatterCanvas.getContext("2d"), {
    type: "scatter",
    data: { datasets: [{ label: "Arousal vs Valence", data: [], backgroundColor: "purple" }] },
    options: {
      animation: false,
      scales: {
        x: { title: { display: true, text: "Valence (-1..1)" } },
        y: { title: { display: true, text: "Arousal (0..1)" } },
      },
    },
  });
}

function pushTimeline(data) {
  if (!timelineChart || !scatterChart) return;
  const t = new Date().toLocaleTimeString();
  timelineChart.data.labels.push(t);
  timelineChart.data.datasets[0].data.push(data.valence);
  timelineChart.data.datasets[1].data.push(data.arousal);
  if (timelineChart.data.labels.length > 60) {
    timelineChart.data.labels.shift();
    timelineChart.data.datasets.forEach((ds) => ds.data.shift());
  }
  timelineChart.update("none");

  scatterChart.data.datasets[0].data.push({ x: data.valence, y: data.arousal });
  if (scatterChart.data.datasets[0].data.length > 200) scatterChart.data.datasets[0].data.shift();
  scatterChart.update("none");
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
