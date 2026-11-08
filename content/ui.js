// Unified Single-Menu UI & Toolbar Button Injector for Google Photos AI Description Extension
// Uses clean text buttons matching Google Photos native UI — no icons, no multi-level navigation rails.

(function () {
  const TRIGGER_BTN_ID = "wphoto-trigger-btn";
  const MENU_CARD_ID = "wphoto-menu-card";
  const STATUS_BAR_ID = "wphoto-status-bar";

  const state = {
    menuOpen: false,
    view: "main", // "main" | "apikey"
    lang: "en",
    model: "cloud", // "cloud" | "local"
    overwrite: "no", // "no" | "yes"
    verbose: false,
    apiKey: "",
    showApiKeyPlain: false,
    apiKeyStatusMsg: "",
    nanoStatus: "idle", // "idle" | "available" | "downloadable" | "downloading" | "unavailable"
    nanoProgressPct: 0,
    enumeratingAlbum: false,
    activeBatch: null
  };

  function maskApiKey(key) {
    if (!key || typeof key !== "string") return "";
    const trimmed = key.trim();
    if (trimmed.length <= 8) return "••••••••";
    return `${trimmed.slice(0, 4)}••••••••${trimmed.slice(-4)}`;
  }

  async function loadStoredPrefs() {
    try {
      const data = await chrome.storage.local.get([
        "wphotoPrefs",
        "geminiApiKey",
        "aiDescriptionVerbose",
        "activeBatch"
      ]);
      if (data?.wphotoPrefs) {
        const p = data.wphotoPrefs;
        if (p.lang && window.WPHOTO_PROMPTS?.[p.lang]) state.lang = p.lang;
        if (p.model === "local" || p.model === "cloud") state.model = p.model;
        if (p.overwrite === "yes" || p.overwrite === "no") state.overwrite = p.overwrite;
      }
      if (typeof data?.geminiApiKey === "string" && data.geminiApiKey.trim()) {
        state.apiKey = data.geminiApiKey.trim();
      } else {
        state.apiKey = "";
      }
      if (typeof data?.aiDescriptionVerbose === "boolean") {
        state.verbose = data.aiDescriptionVerbose;
      }
      if (data?.activeBatch) {
        state.activeBatch = data.activeBatch;
      }
    } catch (e) {}
  }

  function saveStoredPrefs() {
    try {
      chrome.storage.local.set({
        wphotoPrefs: {
          lang: state.lang,
          model: state.model,
          overwrite: state.overwrite
        }
      });
    } catch (e) {}
  }

  async function saveGeminiApiKey(rawKey) {
    const cleaned = typeof rawKey === "string" ? rawKey.trim() : "";
    try {
      if (cleaned) {
        await chrome.storage.local.set({ geminiApiKey: cleaned });
        state.apiKey = cleaned;
        state.apiKeyStatusMsg = "Key saved";
      } else {
        await chrome.storage.local.remove("geminiApiKey");
        state.apiKey = "";
        state.apiKeyStatusMsg = "Key cleared";
      }
    } catch (e) {
      state.apiKeyStatusMsg = "Failed to save key";
    }
    renderMenu();
    setTimeout(() => {
      state.apiKeyStatusMsg = "";
      if (state.menuOpen) renderMenu();
    }, 2500);
  }

  async function clearGeminiApiKey() {
    try {
      await chrome.storage.local.remove("geminiApiKey");
    } catch (e) {}
    state.apiKey = "";
    state.apiKeyStatusMsg = "Key cleared";
    renderMenu();
    setTimeout(() => {
      state.apiKeyStatusMsg = "";
      if (state.menuOpen) renderMenu();
    }, 2500);
  }

  function getCtaLabel(lang, summary) {
    if (state.enumeratingAlbum) {
      return lang === "fr"
        ? "Lecture de l'album..."
        : lang === "es"
        ? "Leyendo álbum..."
        : "Reading album...";
    }
    if (summary.eligible > 0) {
      const n = summary.eligible;
      if (lang === "fr") return `Décrire ${n} photo${n === 1 ? "" : "s"}`;
      if (lang === "es") return `Describir ${n} foto${n === 1 ? "" : "s"}`;
      return `Describe ${n} photo${n === 1 ? "" : "s"}`;
    }
    if (summary.inAlbum) {
      if (lang === "fr") return "Décrire les photos de l'album";
      if (lang === "es") return "Describir fotos del álbum";
      return "Describe album photos";
    }
    if (lang === "fr") return "Sélectionnez des photos";
    if (lang === "es") return "Selecciona fotos";
    return "Select photos to start";
  }

  async function triggerLocalProbe() {
    if (state.model !== "local") return;
    state.nanoStatus = "idle";
    renderMenu();
    const status = await window.WPhotoAiEngine.probeNanoAvailability();
    state.nanoStatus = status;
    renderMenu();
  }

  async function handleDownloadLocalModel() {
    state.nanoStatus = "downloading";
    state.nanoProgressPct = 0;
    renderMenu();
    const result = await window.WPhotoAiEngine.downloadNanoModel((pct) => {
      state.nanoProgressPct = pct;
      if (state.menuOpen) renderMenu();
    });
    state.nanoStatus = result;
    if (state.menuOpen) renderMenu();
  }

  async function handleDownloadLog() {
    try {
      const logText = await window.WPhotoAiEngine.getAiDescLog();
      const blob = new Blob([logText], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ai_summary_log.txt";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
      }, 1000);
    } catch (e) {}
  }

  async function handleStartBatch() {
    if (state.model === "cloud" && !state.apiKey) {
      state.view = "apikey";
      renderMenu();
      return;
    }

    const summary = window.WPhotoSelection.getSummary();
    let photoIds = [];
    let skippedIds = [];

    if (summary.eligible > 0) {
      photoIds = window.WPhotoSelection.getEligibleIds();
      skippedIds = window.WPhotoSelection.getSkippedIds();
    } else if (summary.inAlbum) {
      state.enumeratingAlbum = true;
      renderMenu();
      const albumRes = await window.WPhotoSelection.enumerateCurrentAlbum();
      state.enumeratingAlbum = false;
      photoIds = albumRes.ids || [];
      skippedIds = albumRes.skippedIds || [];
    }

    if (photoIds.length === 0) {
      renderMenu();
      return;
    }

    closeMenu();
    await window.WPhotoBatchRunner.kickOffBatch({
      photoIds,
      skippedIds,
      originUrl: location.href,
      options: {
        lang: state.lang,
        model: state.model,
        overwrite: state.overwrite === "yes",
        verbose: state.verbose
      }
    });
  }

  function positionMenuCard(card) {
    const btn = document.getElementById(TRIGGER_BTN_ID);
    if (!btn) {
      card.style.top = "56px";
      card.style.right = "24px";
      return;
    }
    const rect = btn.getBoundingClientRect();
    const top = Math.max(8, Math.round(rect.bottom + 8));
    const rightSpace = window.innerWidth - rect.right;
    card.style.top = `${top}px`;
    if (rightSpace >= 16 && rect.right >= 320) {
      card.style.right = `${Math.max(12, Math.round(rightSpace))}px`;
      card.style.left = "auto";
    } else {
      card.style.left = `${Math.max(12, Math.round(rect.left))}px`;
      card.style.right = "auto";
    }
  }

  function closeMenu() {
    state.menuOpen = false;
    state.view = "main";
    const existing = document.getElementById(MENU_CARD_ID);
    if (existing) existing.remove();
  }

  function renderMenu() {
    if (!state.menuOpen || typeof document === "undefined") {
      const existing = document.getElementById(MENU_CARD_ID);
      if (existing) existing.remove();
      return;
    }

    let card = document.getElementById(MENU_CARD_ID);
    if (!card) {
      card = document.createElement("div");
      card.id = MENU_CARD_ID;
      card.setAttribute("role", "dialog");
      card.setAttribute("aria-label", "AI Description Menu");
      document.body.appendChild(card);
    }
    positionMenuCard(card);
    card.innerHTML = "";

    if (state.view === "apikey") {
      renderApiKeyView(card);
    } else {
      renderMainView(card);
    }
  }

  function renderApiKeyView(card) {
    const header = document.createElement("div");
    header.className = "wphoto-header";

    const title = document.createElement("span");
    title.className = "wphoto-title";
    title.textContent = "Google AI Studio API Key";

    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "wphoto-text-btn";
    backBtn.textContent = "Back";
    backBtn.addEventListener("click", () => {
      state.view = "main";
      renderMenu();
    });

    header.appendChild(title);
    header.appendChild(backBtn);
    card.appendChild(header);

    const helper = document.createElement("div");
    helper.className = "wphoto-note";
    helper.innerHTML =
      'Enter your Gemini API key from <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline;">Google AI Studio</a>. Stored locally on this browser only.';
    card.appendChild(helper);

    if (state.apiKey) {
      const statusRow = document.createElement("div");
      statusRow.className = "wphoto-field";
      statusRow.style.fontSize = "12px";
      statusRow.textContent = `Current key: ${maskApiKey(state.apiKey)}`;
      card.appendChild(statusRow);
    }

    const inputRow = document.createElement("div");
    inputRow.className = "wphoto-input-row";

    const input = document.createElement("input");
    input.type = state.showApiKeyPlain ? "text" : "password";
    input.className = "wphoto-input";
    input.placeholder = "AIzaSy...";
    input.value = state.apiKey;
    input.setAttribute("aria-label", "Gemini API Key");

    const toggleShowBtn = document.createElement("button");
    toggleShowBtn.type = "button";
    toggleShowBtn.className = "wphoto-text-btn";
    toggleShowBtn.textContent = state.showApiKeyPlain ? "Hide" : "Show";
    toggleShowBtn.addEventListener("click", () => {
      state.showApiKeyPlain = !state.showApiKeyPlain;
      state.apiKey = input.value;
      renderMenu();
    });

    inputRow.appendChild(input);
    inputRow.appendChild(toggleShowBtn);
    card.appendChild(inputRow);

    if (state.apiKeyStatusMsg) {
      const msg = document.createElement("div");
      msg.style.fontSize = "12px";
      msg.style.marginBottom = "8px";
      msg.style.color = "var(--wphoto-primary)";
      msg.textContent = state.apiKeyStatusMsg;
      card.appendChild(msg);
    }

    const actions = document.createElement("div");
    actions.className = "wphoto-actions-row";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "wphoto-primary-btn";
    saveBtn.style.flex = "1";
    saveBtn.textContent = "Save Key";
    saveBtn.addEventListener("click", () => {
      saveGeminiApiKey(input.value);
    });

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "wphoto-text-btn";
    clearBtn.textContent = "Clear";
    clearBtn.addEventListener("click", () => {
      input.value = "";
      clearGeminiApiKey();
    });

    actions.appendChild(saveBtn);
    actions.appendChild(clearBtn);
    card.appendChild(actions);
  }

  function createSegmentedControl(options, activeValue, onSelect, ariaLabel) {
    const group = document.createElement("div");
    group.className = "wphoto-segmented";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", ariaLabel);

    for (const opt of options) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "wphoto-seg-btn";
      btn.textContent = opt.label;
      btn.setAttribute("aria-pressed", String(opt.value === activeValue));
      btn.addEventListener("click", () => onSelect(opt.value));
      group.appendChild(btn);
    }
    return group;
  }

  function renderMainView(card) {
    // Header: Title + API Key button
    const header = document.createElement("div");
    header.className = "wphoto-header";

    const title = document.createElement("span");
    title.className = "wphoto-title";
    title.textContent = "AI Description";

    const apiKeyBtn = document.createElement("button");
    apiKeyBtn.type = "button";
    apiKeyBtn.className = "wphoto-text-btn";
    apiKeyBtn.textContent = state.apiKey ? "API Key (Set)" : "API Key";
    apiKeyBtn.addEventListener("click", () => {
      state.view = "apikey";
      renderMenu();
    });

    header.appendChild(title);
    header.appendChild(apiKeyBtn);
    card.appendChild(header);

    // 1. Language selector (dynamically built from window.WPHOTO_PROMPTS)
    const promptsMap = window.WPHOTO_PROMPTS || { en: { label: "English" } };
    const langOptions = Object.entries(promptsMap).map(([code, cfg]) => ({
      value: code,
      label: cfg.label || code.toUpperCase()
    }));

    const langField = document.createElement("div");
    langField.className = "wphoto-field";
    langField.setAttribute("data-wphoto-lang-toggle", "true");
    const langLabel = document.createElement("span");
    langLabel.className = "wphoto-label";
    langLabel.textContent = "Language";
    langField.appendChild(langLabel);
    langField.appendChild(
      createSegmentedControl(
        langOptions,
        state.lang,
        (val) => {
          state.lang = val;
          saveStoredPrefs();
          renderMenu();
        },
        "Language"
      )
    );
    card.appendChild(langField);

    // 2. Model selector (Cloud vs Local)
    const modelField = document.createElement("div");
    modelField.className = "wphoto-field";
    modelField.setAttribute("data-wphoto-model-toggle", "true");
    const modelLabel = document.createElement("span");
    modelLabel.className = "wphoto-label";
    modelLabel.textContent = "Model";
    modelField.appendChild(modelLabel);
    modelField.appendChild(
      createSegmentedControl(
        [
          { value: "cloud", label: "Cloud" },
          { value: "local", label: "Local" }
        ],
        state.model,
        (val) => {
          state.model = val;
          saveStoredPrefs();
          if (val === "local") triggerLocalProbe();
          else renderMenu();
        },
        "Model"
      )
    );
    card.appendChild(modelField);

    if (state.model === "local") {
      const localNote = document.createElement("div");
      localNote.className = "wphoto-note";
      if (state.nanoStatus === "available") {
        localNote.textContent = "Local Gemini Nano model is ready.";
      } else if (state.nanoStatus === "downloadable") {
        localNote.textContent = "Local Gemini Nano model requires a one-time download. ";
        const dlBtn = document.createElement("button");
        dlBtn.type = "button";
        dlBtn.className = "wphoto-link-btn";
        dlBtn.textContent = "Download model";
        dlBtn.addEventListener("click", handleDownloadLocalModel);
        localNote.appendChild(dlBtn);
      } else if (state.nanoStatus === "downloading") {
        localNote.textContent = `Downloading local model (${state.nanoProgressPct}%)...`;
      } else {
        localNote.textContent =
          "Local AI model unavailable on this device; descriptions will use photo metadata (people, place, year).";
      }
      card.appendChild(localNote);
    } else if (!state.apiKey) {
      const keyWarning = document.createElement("div");
      keyWarning.className = "wphoto-note";
      keyWarning.textContent = "Cloud model requires a Google AI Studio API key. ";
      const setKeyLink = document.createElement("button");
      setKeyLink.type = "button";
      setKeyLink.className = "wphoto-link-btn";
      setKeyLink.textContent = "Set API Key";
      setKeyLink.addEventListener("click", () => {
        state.view = "apikey";
        renderMenu();
      });
      keyWarning.appendChild(setKeyLink);
      card.appendChild(keyWarning);
    }

    // 3. Overwrite existing descriptions (No | Yes)
    const overwriteField = document.createElement("div");
    overwriteField.className = "wphoto-field";
    overwriteField.setAttribute("data-wphoto-overwrite-toggle", "true");
    const overwriteLabel = document.createElement("span");
    overwriteLabel.className = "wphoto-label";
    overwriteLabel.textContent = "Overwrite existing descriptions";
    overwriteField.appendChild(overwriteLabel);
    overwriteField.appendChild(
      createSegmentedControl(
        [
          { value: "no", label: "No" },
          { value: "yes", label: "Yes" }
        ],
        state.overwrite,
        (val) => {
          state.overwrite = val;
          saveStoredPrefs();
          renderMenu();
        },
        "Overwrite existing descriptions"
      )
    );
    card.appendChild(overwriteField);

    // 4. Verbose log checkbox + Download log button
    const verboseRow = document.createElement("div");
    verboseRow.className = "wphoto-row-between";
    verboseRow.setAttribute("data-wphoto-verbose-toggle", "true");

    const checkLabel = document.createElement("label");
    checkLabel.className = "wphoto-checkbox-label";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.verbose;
    checkbox.addEventListener("change", (e) => {
      state.verbose = !!e.target.checked;
      try {
        chrome.storage.local.set({
          aiDescriptionVerbose: state.verbose,
          ...(!state.verbose ? { aiDescriptionVerboseLog: "" } : {})
        });
      } catch (err) {}
      renderMenu();
    });
    const checkSpan = document.createElement("span");
    checkSpan.textContent = "Verbose log";
    checkLabel.appendChild(checkbox);
    checkLabel.appendChild(checkSpan);
    verboseRow.appendChild(checkLabel);

    if (state.verbose) {
      const dlLogBtn = document.createElement("button");
      dlLogBtn.type = "button";
      dlLogBtn.className = "wphoto-link-btn";
      dlLogBtn.textContent = "Download log";
      dlLogBtn.addEventListener("click", handleDownloadLog);
      verboseRow.appendChild(dlLogBtn);
    }
    card.appendChild(verboseRow);

    // 5. Primary CTA Button
    const summary = window.WPhotoSelection.getSummary();
    const canStart = summary.eligible > 0 || summary.inAlbum;
    const primaryBtn = document.createElement("button");
    primaryBtn.type = "button";
    primaryBtn.className = "wphoto-primary-btn";
    primaryBtn.setAttribute("data-wphoto-primary-cta", "true");
    primaryBtn.disabled = !canStart || state.enumeratingAlbum;
    primaryBtn.textContent = getCtaLabel(state.lang, summary);
    primaryBtn.addEventListener("click", handleStartBatch);
    card.appendChild(primaryBtn);
  }

  function renderStatusBar() {
    if (typeof document === "undefined") return;
    const batch = state.activeBatch;
    let bar = document.getElementById(STATUS_BAR_ID);
    if (!batch) {
      if (bar) bar.remove();
      return;
    }

    if (!bar) {
      bar = document.createElement("div");
      bar.id = STATUS_BAR_ID;
      document.body.appendChild(bar);
    }
    bar.innerHTML = "";

    const total = batch.photoIds?.length || 0;
    const done = batch.completedIds?.length || 0;
    const skipped = batch.skippedIds?.length || 0;
    const failed = batch.failedIds?.length || 0;
    const processed = window.WPhotoBatchRunner.getProcessedCount(batch);
    const isRunning = batch.completedAt === null && batch.lastReason === null;
    const isPaused = batch.lastReason === "paused";

    const textSpan = document.createElement("span");
    if (isRunning) {
      textSpan.textContent = `AI Describe: ${Math.min(processed + 1, total)} / ${total} (${done} done, ${skipped} skipped)`;
    } else if (isPaused) {
      textSpan.textContent = `Paused at ${processed} / ${total} (${done} done, ${skipped} skipped)`;
    } else {
      textSpan.textContent = `Finished: ${done} described, ${skipped} skipped, ${failed} failed`;
    }
    bar.appendChild(textSpan);

    if (isRunning) {
      const pauseBtn = document.createElement("button");
      pauseBtn.type = "button";
      pauseBtn.className = "wphoto-text-btn";
      pauseBtn.textContent = "Pause";
      pauseBtn.addEventListener("click", () => window.WPhotoBatchRunner.pauseBatch());
      bar.appendChild(pauseBtn);

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "wphoto-text-btn";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", () => window.WPhotoBatchRunner.cancelBatch());
      bar.appendChild(cancelBtn);
    } else if (isPaused) {
      const resumeBtn = document.createElement("button");
      resumeBtn.type = "button";
      resumeBtn.className = "wphoto-text-btn";
      resumeBtn.textContent = "Resume";
      resumeBtn.addEventListener("click", () => window.WPhotoBatchRunner.resumeBatch());
      bar.appendChild(resumeBtn);

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "wphoto-text-btn";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", () => window.WPhotoBatchRunner.clearActiveBatch());
      bar.appendChild(cancelBtn);
    } else {
      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "wphoto-text-btn";
      closeBtn.textContent = "Dismiss";
      closeBtn.addEventListener("click", () => window.WPhotoBatchRunner.clearActiveBatch());
      bar.appendChild(closeBtn);
    }
  }

  function findSelectionActionContainer() {
    const clearBtn = document.querySelector(
      'button[aria-label="Clear selection"], button[aria-label="Annuler la sélection"], button[aria-label="Borrar selección"], button[jslog*="8886"]'
    );
    if (!clearBtn || clearBtn.offsetParent === null) return null;
    let cur = clearBtn.parentElement;
    for (let i = 0; i < 6 && cur; i++) {
      const shareBtn = cur.querySelector(
        'button[aria-label="Share"], button[aria-label="Partager"], button[aria-label="Compartir"], button[jslog*="8919"]'
      );
      if (shareBtn && shareBtn.offsetParent !== null) {
        return shareBtn.parentElement;
      }
      cur = cur.parentElement;
    }
    return clearBtn.parentElement;
  }

  function findViewerActionContainer() {
    const infoBtn = document.querySelector(
      'button[aria-label="Open info"], button[aria-label="Close info"], button[aria-label="Informations"], button[aria-label="Info"], button[aria-label="Abrir información"], button[jslog*="8918"]'
    );
    if (infoBtn && infoBtn.offsetParent !== null && !infoBtn.closest("#gb")) {
      return { parent: infoBtn.parentElement, before: infoBtn };
    }
    return null;
  }

  function ensureTriggerButtonMounted() {
    if (typeof document === "undefined" || !document.body) return;
    let btn = document.getElementById(TRIGGER_BTN_ID);
    if (!btn) {
      btn = document.createElement("button");
      btn.id = TRIGGER_BTN_ID;
      btn.type = "button";
      btn.textContent = "AI Describe";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        state.menuOpen = !state.menuOpen;
        if (state.menuOpen && state.model === "local") {
          triggerLocalProbe();
        }
        renderMenu();
      });
    }

    // 1. Selection bar placement
    const selContainer = findSelectionActionContainer();
    if (selContainer) {
      btn.removeAttribute("data-pinned");
      if (btn.parentElement !== selContainer) {
        selContainer.insertBefore(btn, selContainer.firstChild);
      }
      return;
    }

    // 2. Single photo viewer placement
    if (window.WPhotoSelection.parsePhotoIdFromPath()) {
      const viewerCluster = findViewerActionContainer();
      if (viewerCluster && viewerCluster.parent) {
        btn.removeAttribute("data-pinned");
        if (btn.parentElement !== viewerCluster.parent) {
          viewerCluster.parent.insertBefore(btn, viewerCluster.before);
        }
        return;
      }
    }

    // 3. Fallback pinned header placement
    btn.setAttribute("data-pinned", "true");
    if (btn.parentElement !== document.body) {
      document.body.appendChild(btn);
    }
  }

  // Close menu on outside click or Escape
  if (typeof document !== "undefined") {
    document.addEventListener(
      "mousedown",
      (e) => {
        if (!state.menuOpen) return;
        const card = document.getElementById(MENU_CARD_ID);
        const btn = document.getElementById(TRIGGER_BTN_ID);
        const path = e.composedPath ? e.composedPath() : [];
        if ((card && path.includes(card)) || (btn && path.includes(btn))) return;
        closeMenu();
      },
      true
    );

    window.addEventListener(
      "keydown",
      (e) => {
        if (state.menuOpen && e.key === "Escape") {
          e.stopPropagation();
          e.preventDefault();
          closeMenu();
        }
      },
      true
    );
  }

  async function initUi() {
    await loadStoredPrefs();
    ensureTriggerButtonMounted();
    renderStatusBar();

    window.WPhotoSelection.onChange(() => {
      ensureTriggerButtonMounted();
      if (state.menuOpen) renderMenu();
    });

    window.WPhotoBatchRunner.onStateChange((batch) => {
      state.activeBatch = batch;
      renderStatusBar();
    });

    setInterval(ensureTriggerButtonMounted, 1200);
    await window.WPhotoBatchRunner.continueBatchIfActive();
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initUi);
    } else {
      initUi();
    }
  }

  window.WPhotoUi = {
    state,
    maskApiKey,
    saveGeminiApiKey,
    clearGeminiApiKey,
    renderMenu,
    renderStatusBar,
    closeMenu,
    ensureTriggerButtonMounted
  };
})();
