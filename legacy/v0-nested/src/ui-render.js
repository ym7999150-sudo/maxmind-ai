// ============================================================================
// MuxMind AI — src/ui-render.js
// Dynamic Chat UI, Task Tracker, API Manager Modal, Providers Modal, TTS
// ============================================================================

(function () {
  "use strict";

  const chatWindow = document.getElementById("chat-window");
  const promptInput = document.getElementById("user-prompt-input");
  const btnSend = document.getElementById("btn-send");
  const btnStop = document.getElementById("btn-stop");
  const btnAttach = document.getElementById("btn-attach");
  const fileInput = document.getElementById("file-upload-input");
  const btnClear = document.getElementById("btn-clear-chat");
  const btnTts = document.getElementById("btn-tts-toggle");
  const statusBadge = document.getElementById("status-badge");
  const progressFill = document.getElementById("task-progress-fill");
  const modelSelector = document.getElementById("model-selector-dropdown");

  const btnProviders = document.getElementById("btn-providers");
  const btnApiManager = document.getElementById("btn-api-manager");
  const modalProviders = document.getElementById("modal-providers");
  const modalApiManager = document.getElementById("modal-api-manager");
  const providersList = document.getElementById("providers-list");
  const apiKeysList = document.getElementById("api-keys-list");

  let history = [];
  let ttsMode = "mute"; // 'mute' | 'auto' | 'ar' | 'en'
  let pendingAttachment = null;
  let aborter = null;

  // ---------------------------------------------------------------------
  // Modal helpers
  // ---------------------------------------------------------------------
  function openModal(el) { el.classList.remove("hidden"); }
  function closeModal(el) { el.classList.add("hidden"); }

  document.querySelectorAll(".modal-close").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(document.getElementById(btn.dataset.close)));
  });
  [modalProviders, modalApiManager].forEach((m) => {
    m.addEventListener("click", (e) => { if (e.target === m) closeModal(m); });
  });

  // ---------------------------------------------------------------------
  // Providers panel — shows each provider's console / docs / pricing links
  // ---------------------------------------------------------------------
  async function loadProviders() {
    providersList.innerHTML = `<div class="loading-row">جارِ التحميل...</div>`;
    try {
      const res = await fetch("/api/providers");
      const data = await res.json();
      renderProviders(data.providers);
      renderApiKeyRows(data.providers);
    } catch (err) {
      providersList.innerHTML = `<div class="loading-row">تعذر تحميل المزودين: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderProviders(providers) {
    providersList.innerHTML = providers
      .map((p) => `
        <div class="provider-card">
          <div class="provider-card-top">
            <strong>${escapeHtml(p.name)}</strong>
            <span class="badge ${p.freeTier ? "free" : "paid"}">
              ${p.freeTier ? "يوجد مستوى مجاني" : "مدفوع فقط"}
            </span>
          </div>
          <div class="provider-note">${escapeHtml(p.freeNote || "")}</div>
          <div class="provider-links">
            <a href="${p.consoleUrl}" target="_blank" rel="noopener">🔑 الحصول على مفتاح API</a>
            <a href="${p.docsUrl}" target="_blank" rel="noopener">📄 توثيق الـ API</a>
            <a href="${p.pricingUrl}" target="_blank" rel="noopener">💳 الأسعار (مجاني/مدفوع)</a>
          </div>
        </div>
      `)
      .join("");
  }

  // ---------------------------------------------------------------------
  // API Key Manager panel — input + validate + dynamic model discovery
  // ---------------------------------------------------------------------
  function renderApiKeyRows(providers) {
    apiKeysList.innerHTML = providers
      .map((p) => `
        <div class="apikey-card" data-provider="${p.id}">
          <div class="provider-card-top">
            <strong>${escapeHtml(p.name)}</strong>
            <span class="badge ${p.freeTier ? "free" : "paid"}">${p.freeTier ? "مجاني متاح" : "مدفوع"}</span>
          </div>
          <div class="apikey-row">
            <input type="password" placeholder="أدخل مفتاح ${escapeHtml(p.name)}..." class="key-input" />
            <button class="validate-btn" data-action="validate">تحقق ✅</button>
          </div>
          <div class="apikey-row model-row hidden">
            <select class="model-select"></select>
          </div>
          <div class="status-text"></div>
          <div class="provider-links">
            <a href="${p.consoleUrl}" target="_blank" rel="noopener">🔑 صفحة المفاتيح</a>
            <a href="${p.pricingUrl}" target="_blank" rel="noopener">💳 مجاني/مدفوع</a>
          </div>
        </div>
      `)
      .join("");

    apiKeysList.querySelectorAll(".apikey-card").forEach((card) => {
      const providerId = card.dataset.provider;
      const keyInput = card.querySelector(".key-input");
      const validateBtn = card.querySelector(".validate-btn");
      const statusText = card.querySelector(".status-text");
      const modelRow = card.querySelector(".model-row");
      const modelSelect = card.querySelector(".model-select");

      validateBtn.addEventListener("click", async () => {
        const key = keyInput.value.trim();
        if (!key) {
          statusText.textContent = "الرجاء إدخال مفتاح أولاً";
          statusText.className = "status-text err";
          return;
        }
        validateBtn.disabled = true;
        statusText.textContent = "جارِ التحقق...";
        statusText.className = "status-text";

        try {
          const res = await fetch(`/api/validate/${providerId}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ key }),
          });
          const data = await res.json();

          if (data.valid) {
            statusText.textContent = `✅ مفتاح صالح (${data.latencyMs}ms زمن استجابة)`;
            statusText.className = "status-text ok";
            await fetch(`/api/keys/${providerId}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ key }),
            });

            if (data.models && data.models.length) {
              modelSelect.innerHTML = data.models
                .map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`)
                .join("");
              modelRow.classList.remove("hidden");
            }
          } else {
            statusText.textContent = `❌ مفتاح غير صالح: ${escapeHtml(data.error || "Access Denied")}`;
            statusText.className = "status-text err";
          }
        } catch (err) {
          statusText.textContent = `❌ خطأ: ${escapeHtml(err.message)}`;
          statusText.className = "status-text err";
        } finally {
          validateBtn.disabled = false;
        }
      });
    });
  }

  btnProviders.addEventListener("click", () => { openModal(modalProviders); loadProviders(); });
  btnApiManager.addEventListener("click", () => { openModal(modalApiManager); loadProviders(); });

  // ---------------------------------------------------------------------
  // Chat rendering
  // ---------------------------------------------------------------------
  function addMessage(role, text, meta) {
    const div = document.createElement("div");
    div.className = `msg ${role}`;
    div.innerHTML = `<div class="msg-text"></div>${meta ? `<div class="meta">${escapeHtml(meta)}</div>` : ""}`;
    div.querySelector(".msg-text").textContent = text;
    chatWindow.appendChild(div);
    chatWindow.scrollTop = chatWindow.scrollHeight;
    return div;
  }

  function setProgress(pct) { progressFill.style.width = `${pct}%`; }

  function setStatus(engine, tokensSaved) {
    statusBadge.textContent = `⚙️ Engine: ${engine || "—"} | Tokens Saved: ${tokensSaved || "—"}`;
  }

  // ---------------------------------------------------------------------
  // Send flow
  // ---------------------------------------------------------------------
  async function sendMessage() {
    const text = promptInput.value.trim();
    if (!text && !pendingAttachment) return;

    const displayText = pendingAttachment
      ? `${text}\n📎 ${pendingAttachment.filename}`
      : text;

    addMessage("user", displayText);
    history.push({ role: "user", content: text });
    promptInput.value = "";
    autoExpand();

    btnSend.disabled = true;
    btnStop.classList.remove("hidden");
    setProgress(20);

    const [forceProvider, forceModel] = modelSelector.value === "auto"
      ? [null, null]
      : modelSelector.value.split(":");

    try {
      setProgress(50);
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: pendingAttachment
            ? `${text}\n\n[Attached file: ${pendingAttachment.filename}]\n${pendingAttachment.content || ""}`
            : text,
          history: history.slice(0, -1),
          forceProvider,
          forceModel,
        }),
      });
      const data = await res.json();
      setProgress(85);

      if (!data.success) {
        addMessage("assistant", `⚠️ فشل التنفيذ: ${data.error || "خطأ غير معروف"}`);
        setStatus("Error", "0%");
      } else {
        addMessage("assistant", data.text, `${data.provider} · ${data.model} · ${data.tierLabel}`);
        history.push({ role: "assistant", content: data.text });
        setStatus(`${data.provider}/${data.model}`, "~45%");
        speak(data.text);
      }
    } catch (err) {
      addMessage("assistant", `⚠️ خطأ في الاتصال: ${err.message}`);
    } finally {
      setProgress(100);
      setTimeout(() => setProgress(0), 600);
      btnSend.disabled = false;
      btnStop.classList.add("hidden");
      pendingAttachment = null;
    }
  }

  btnSend.addEventListener("click", sendMessage);
  promptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  btnStop.addEventListener("click", () => {
    // Client-side stop: browser TTS + visual state reset (server request already in-flight)
    window.speechSynthesis?.cancel();
    btnStop.classList.add("hidden");
    setProgress(0);
  });

  btnClear.addEventListener("click", () => {
    history = [];
    chatWindow.innerHTML = "";
    setStatus(null, null);
  });

  function autoExpand() {
    promptInput.style.height = "auto";
    promptInput.style.height = Math.min(promptInput.scrollHeight, 160) + "px";
  }
  promptInput.addEventListener("input", autoExpand);

  // ---------------------------------------------------------------------
  // File attachment
  // ---------------------------------------------------------------------
  btnAttach.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);

    addMessage("assistant", `📎 جارِ معالجة الملف: ${file.name}...`);
    try {
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const data = await res.json();
      pendingAttachment = data;
      addMessage("assistant", `✅ تم إرفاق: ${data.filename} (${data.type})`);
    } catch (err) {
      addMessage("assistant", `⚠️ فشل رفع الملف: ${err.message}`);
    } finally {
      fileInput.value = "";
    }
  });

  // ---------------------------------------------------------------------
  // TTS toggle: Mute -> Arabic -> English -> Mute
  // ---------------------------------------------------------------------
  const ttsStates = [
    { mode: "mute", label: "🔇 صامت" },
    { mode: "ar", label: "🔊 عربي" },
    { mode: "en", label: "🔊 English" },
  ];
  let ttsIndex = 0;

  btnTts.addEventListener("click", () => {
    ttsIndex = (ttsIndex + 1) % ttsStates.length;
    ttsMode = ttsStates[ttsIndex].mode;
    btnTts.textContent = ttsStates[ttsIndex].label;
  });

  function speak(text) {
    if (ttsMode === "mute" || !window.speechSynthesis) return;
    const clean = text
      .replace(/```[\s\S]*?```/g, " كود برمجي ")
      .replace(/[*_#>`~]/g, "")
      .trim();
    if (!clean) return;

    const utter = new SpeechSynthesisUtterance(clean);
    utter.lang = ttsMode === "ar" ? "ar-SA" : "en-US";
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  }

  // ---------------------------------------------------------------------
  // Utils
  // ---------------------------------------------------------------------
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Initial load
  loadProviders();
})();
