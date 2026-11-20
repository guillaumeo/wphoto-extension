// Unified Single-Menu UI & Toolbar Button Injector for Google Photos AI Description Extension
// Uses clean text buttons matching Google Photos native UI — no icons, no multi-level navigation rails.

(function () {
  const TRIGGER_BTN_ID = "wphoto-trigger-btn";
  const MENU_CARD_ID = "wphoto-menu-card";
  const STATUS_BAR_ID = "wphoto-status-bar";
  const STATUS_BAR_AUTO_DISMISS_MS = 4500;
  const AI_STUDIO_LINK =
    '<a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline;">Google AI Studio</a>';
  let statusAutoDismissTimer = null;
  let apiKeyStatusTimer = null;

  const state = {
    menuOpen: false,
    view: "main",
    lang: "en",
    model: "cloud",
    overwrite: "no",
    verbose: false,
    apiKey: "",
    showApiKeyPlain: false,
    apiKeyStatusKey: "",
    nanoStatus: "idle",
    nanoProgressPct: 0,
    enumeratingAlbum: false,
    activeBatch: null
  };

  const UI_I18N = {
    en: {
      menuAriaLabel: "AI Plus Menu",
      apiKeyBtn: "API Key",
      apiKeySetBtn: "API Key (Set)",
      languageLabel: "Language",
      modelLabel: "Model",
      modelCloud: "Cloud",
      modelLocal: "Local",
      localReady: "Local Gemini Nano model is ready.",
      localDownloadNeeded: "Local Gemini Nano model requires a one-time download. ",
      downloadModelBtn: "Download model",
      localDownloading: (pct) => `Downloading local model (${pct}%)...`,
      localUnavailable:
        "Local AI model unavailable on this device; descriptions will use photo metadata (people, place, year).",
      cloudNeedsKey: "Cloud model requires a Google AI Studio API key. ",
      setApiKeyBtn: "Set API Key",
      overwriteLabel: "Overwrite existing descriptions",
      no: "No",
      yes: "Yes",
      verboseLog: "Verbose log",
      downloadLog: "Download log",
      readingAlbum: "Reading album...",
      describeCount: (n) => `Describe ${n} photo${n === 1 ? "" : "s"}`,
      describeAlbum: "Describe album photos",
      selectPhotos: "Select photos to start",
      apiKeyTitle: "Google AI Studio API Key",
      backBtn: "Back",
      apiKeyHelperHtml: `Enter your Gemini API key from ${AI_STUDIO_LINK}. Stored locally on this browser only.`,
      currentKey: (masked) => `Current key: ${masked}`,
      apiKeyInputAria: "Gemini API Key",
      showBtn: "Show",
      hideBtn: "Hide",
      saveKeyBtn: "Save Key",
      clearBtn: "Clear",
      keySaved: "Key saved",
      keyCleared: "Key cleared",
      keySaveFailed: "Failed to save key",
      statusRunning: (cur, total, done, skipped) =>
        `AI Plus: ${cur} / ${total} (${done} done, ${skipped} skipped)`,
      statusPaused: (processed, total, done, skipped) =>
        `Paused at ${processed} / ${total} (${done} done, ${skipped} skipped)`,
      statusCancelled: (done, skipped) => `Cancelled: ${done} described, ${skipped} skipped`,
      statusFinished: (done, skipped, failed) =>
        `Finished: ${done} described, ${skipped} skipped, ${failed} failed`,
      pauseBtn: "Pause",
      cancelBtn: "Cancel",
      resumeBtn: "Resume",
      dismissBtn: "Dismiss"
    },
    fr: {
      menuAriaLabel: "Menu AI Plus",
      apiKeyBtn: "Clé API",
      apiKeySetBtn: "Clé API (Active)",
      languageLabel: "Langue",
      modelLabel: "Modèle",
      modelCloud: "Cloud",
      modelLocal: "Local",
      localReady: "Le modèle local Gemini Nano est prêt.",
      localDownloadNeeded: "Le modèle local Gemini Nano nécessite un téléchargement unique. ",
      downloadModelBtn: "Télécharger le modèle",
      localDownloading: (pct) => `Téléchargement du modèle local (${pct}%)...`,
      localUnavailable:
        "Modèle IA local indisponible sur cet appareil ; les descriptions utiliseront les métadonnées (personnes, lieu, année).",
      cloudNeedsKey: "Le modèle Cloud nécessite une clé API Google AI Studio. ",
      setApiKeyBtn: "Configurer la clé API",
      overwriteLabel: "Remplacer les descriptions existantes",
      no: "Non",
      yes: "Oui",
      verboseLog: "Journal détaillé",
      downloadLog: "Télécharger le journal",
      readingAlbum: "Lecture de l'album...",
      describeCount: (n) => `Décrire ${n} photo${n === 1 ? "" : "s"}`,
      describeAlbum: "Décrire les photos de l'album",
      selectPhotos: "Sélectionnez des photos",
      apiKeyTitle: "Clé API Google AI Studio",
      backBtn: "Retour",
      apiKeyHelperHtml: `Saisissez votre clé API Gemini depuis ${AI_STUDIO_LINK}. Stockée uniquement sur ce navigateur.`,
      currentKey: (masked) => `Clé actuelle : ${masked}`,
      apiKeyInputAria: "Clé API Gemini",
      showBtn: "Afficher",
      hideBtn: "Masquer",
      saveKeyBtn: "Enregistrer",
      clearBtn: "Effacer",
      keySaved: "Clé enregistrée",
      keyCleared: "Clé effacée",
      keySaveFailed: "Échec de l'enregistrement",
      statusRunning: (cur, total, done, skipped) =>
        `AI Plus : ${cur} / ${total} (${done} terminé${done > 1 ? "s" : ""}, ${skipped} ignoré${skipped > 1 ? "s" : ""})`,
      statusPaused: (processed, total, done, skipped) =>
        `En pause à ${processed} / ${total} (${done} terminé${done > 1 ? "s" : ""}, ${skipped} ignoré${skipped > 1 ? "s" : ""})`,
      statusCancelled: (done, skipped) =>
        `Annulé : ${done} décrite${done > 1 ? "s" : ""}, ${skipped} ignorée${skipped > 1 ? "s" : ""}`,
      statusFinished: (done, skipped, failed) =>
        `Terminé : ${done} décrite${done > 1 ? "s" : ""}, ${skipped} ignorée${skipped > 1 ? "s" : ""}, ${failed} échec${failed > 1 ? "s" : ""}`,
      pauseBtn: "Pause",
      cancelBtn: "Annuler",
      resumeBtn: "Reprendre",
      dismissBtn: "Fermer"
    },
    es: {
      menuAriaLabel: "Menú AI Plus",
      apiKeyBtn: "Clave API",
      apiKeySetBtn: "Clave API (Activa)",
      languageLabel: "Idioma",
      modelLabel: "Modelo",
      modelCloud: "Nube",
      modelLocal: "Local",
      localReady: "El modelo local Gemini Nano está listo.",
      localDownloadNeeded: "El modelo local Gemini Nano requiere una descarga única. ",
      downloadModelBtn: "Descargar modelo",
      localDownloading: (pct) => `Descargando modelo local (${pct}%)...`,
      localUnavailable:
        "Modelo IA local no disponible en este dispositivo; las descripciones usarán los metadatos (personas, lugar, año).",
      cloudNeedsKey: "El modelo en la nube requiere una clave API de Google AI Studio. ",
      setApiKeyBtn: "Configurar clave API",
      overwriteLabel: "Sobrescribir descripciones existentes",
      no: "No",
      yes: "Sí",
      verboseLog: "Registro detallado",
      downloadLog: "Descargar registro",
      readingAlbum: "Leyendo álbum...",
      describeCount: (n) => `Describir ${n} foto${n === 1 ? "" : "s"}`,
      describeAlbum: "Describir fotos del álbum",
      selectPhotos: "Selecciona fotos",
      apiKeyTitle: "Clave API de Google AI Studio",
      backBtn: "Volver",
      apiKeyHelperHtml: `Ingresa tu clave API de Gemini desde ${AI_STUDIO_LINK}. Guardada localmente solo en este navegador.`,
      currentKey: (masked) => `Clave actual: ${masked}`,
      apiKeyInputAria: "Clave API de Gemini",
      showBtn: "Mostrar",
      hideBtn: "Ocultar",
      saveKeyBtn: "Guardar clave",
      clearBtn: "Borrar",
      keySaved: "Clave guardada",
      keyCleared: "Clave borrada",
      keySaveFailed: "Error al guardar la clave",
      statusRunning: (cur, total, done, skipped) =>
        `AI Plus: ${cur} / ${total} (${done} completada${done === 1 ? "" : "s"}, ${skipped} omitida${skipped === 1 ? "" : "s"})`,
      statusPaused: (processed, total, done, skipped) =>
        `En pausa en ${processed} / ${total} (${done} completada${done === 1 ? "" : "s"}, ${skipped} omitida${skipped === 1 ? "" : "s"})`,
      statusCancelled: (done, skipped) =>
        `Cancelado: ${done} descrita${done === 1 ? "" : "s"}, ${skipped} omitida${skipped === 1 ? "" : "s"}`,
      statusFinished: (done, skipped, failed) =>
        `Finalizado: ${done} descrita${done === 1 ? "" : "s"}, ${skipped} omitida${skipped === 1 ? "" : "s"}, ${failed} fallida${failed === 1 ? "" : "s"}`,
      pauseBtn: "Pausar",
      cancelBtn: "Cancelar",
      resumeBtn: "Reanudar",
      dismissBtn: "Cerrar"
    }
  };

  function getUiStrings(lang) {
    const base = UI_I18N[lang] || UI_I18N.en;
    const customUi = window.WPHOTO_PROMPTS?.[lang]?.ui;
    return customUi ? { ...base, ...customUi } : base;
  }

  function maskApiKey(key) {
    if (!key || typeof key !== "string") return "";
    const trimmed = key.trim();
    return trimmed.length <= 8 ? "••••••••" : `${trimmed.slice(0, 4)}••••••••${trimmed.slice(-4)}`;
  }

  async function loadStoredPrefs() {
    try {
      const data = await chrome.storage.local.get([
        "wphotoPrefs",
        "geminiApiKey",
        "aiDescriptionVerbose",
        "activeBatch"
      ]);
      const p = data?.wphotoPrefs;
      if (p) {
        if (p.lang && window.WPHOTO_PROMPTS?.[p.lang]) state.lang = p.lang;
        if (p.model === "local" || p.model === "cloud") state.model = p.model;
        if (p.overwrite === "yes" || p.overwrite === "no") state.overwrite = p.overwrite;
      }
      state.apiKey = typeof data?.geminiApiKey === "string" ? data.geminiApiKey.trim() : "";
      if (typeof data?.aiDescriptionVerbose === "boolean") state.verbose = data.aiDescriptionVerbose;
      if (data?.activeBatch) {
        const b = data.activeBatch;
        const isTerminal = b.completedAt !== null && b.lastReason !== "paused";
        if (isTerminal && typeof b.completedAt === "number" && Date.now() - b.completedAt >= STATUS_BAR_AUTO_DISMISS_MS) {
          state.activeBatch = null;
          try {
            chrome.storage.local.remove("activeBatch");
          } catch (e) {}
        } else {
          state.activeBatch = b;
        }
      }
    } catch (e) {}
  }

  function saveStoredPrefs() {
    try {
      chrome.storage.local.set({
        wphotoPrefs: { lang: state.lang, model: state.model, overwrite: state.overwrite }
      });
    } catch (e) {}
  }

  async function saveGeminiApiKey(rawKey) {
    const cleaned = typeof rawKey === "string" ? rawKey.trim() : "";
    try {
      if (cleaned) {
        await chrome.storage.local.set({ geminiApiKey: cleaned });
        state.apiKey = cleaned;
        state.apiKeyStatusKey = "keySaved";
      } else {
        await chrome.storage.local.remove("geminiApiKey");
        state.apiKey = "";
        state.apiKeyStatusKey = "keyCleared";
      }
    } catch (e) {
      state.apiKeyStatusKey = "keySaveFailed";
    }
    if (apiKeyStatusTimer) clearTimeout(apiKeyStatusTimer);
    renderMenu();
    apiKeyStatusTimer = setTimeout(() => {
      apiKeyStatusTimer = null;
      state.apiKeyStatusKey = "";
      if (state.menuOpen) renderMenu();
    }, 2500);
  }

  const clearGeminiApiKey = () => saveGeminiApiKey("");

  function getCtaLabel(lang, summary) {
    const t = getUiStrings(lang);
    if (state.enumeratingAlbum) return t.readingAlbum;
    if (summary.eligible > 0) return t.describeCount(summary.eligible);
    return summary.inAlbum ? t.describeAlbum : t.selectPhotos;
  }

  async function triggerLocalProbe() {
    if (state.model !== "local") return;
    state.nanoStatus = "idle";
    renderMenu();
    state.nanoStatus = await window.WPhotoAiEngine.probeNanoAvailability();
    if (state.menuOpen) renderMenu();
  }

  async function handleDownloadLocalModel() {
    if (state.nanoStatus === "downloading") return;
    state.nanoStatus = "downloading";
    state.nanoProgressPct = 0;
    renderMenu();
    state.nanoStatus = await window.WPhotoAiEngine.downloadNanoModel((pct) => {
      state.nanoProgressPct = pct;
      if (state.menuOpen) renderMenu();
    });
    if (state.menuOpen) renderMenu();
  }

  async function handleDownloadLog() {
    try {
      const logText = await window.WPhotoAiEngine.getAiDescLog();
      const url = URL.createObjectURL(new Blob([logText], { type: "text/plain;charset=utf-8" }));
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
    if (state.enumeratingAlbum) return;
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
      try {
        const albumRes = await window.WPhotoSelection.enumerateCurrentAlbum();
        photoIds = albumRes.ids || [];
        skippedIds = albumRes.skippedIds || [];
      } finally {
        state.enumeratingAlbum = false;
      }
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
    const rightSpace = window.innerWidth - rect.right;
    card.style.top = `${Math.max(8, Math.round(rect.bottom + 8))}px`;
    if (rightSpace >= 16 && rect.right >= 320) {
      card.style.right = `${Math.max(12, Math.round(rightSpace))}px`;
      card.style.left = "auto";
    } else {
      card.style.left = `${Math.max(12, Math.round(rect.left))}px`;
      card.style.right = "auto";
    }
  }

  function parseColorDarkness(cssColor) {
    if (!cssColor || cssColor === "transparent") return null;
    const m = cssColor.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/);
    if (!m || (m[4] !== undefined && Number(m[4]) < 0.5)) return null;
    return 0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3]) < 128;
  }

  function detectGooglePhotosTheme() {
    if (typeof window === "undefined" || typeof document === "undefined") return "light";
    if (typeof getComputedStyle === "function") {
      for (const node of [document.body, document.documentElement]) {
        if (!node) continue;
        const dark = parseColorDarkness(getComputedStyle(node).backgroundColor);
        if (dark !== null) return dark ? "dark" : "light";
      }
    }
    return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
  }

  function applyThemeAttr(node) {
    node?.setAttribute("data-theme", detectGooglePhotosTheme());
  }

  function shouldHideTriggerAndMenu() {
    if (!window.WPhotoSelection || window.WPhotoSelection.parsePhotoIdFromPath()) return true;
    const summary = window.WPhotoSelection.getSummary();
    return summary.mode === "viewer" || (!summary.inAlbum && summary.eligible === 0);
  }

  function closeMenu() {
    state.menuOpen = false;
    state.view = "main";
    if (typeof document === "undefined") return;
    document.getElementById(TRIGGER_BTN_ID)?.setAttribute("aria-expanded", "false");
    document.getElementById(MENU_CARD_ID)?.remove();
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function createActionBtn(label, className, onClick) {
    const btn = el("button", className, label);
    btn.type = "button";
    btn.addEventListener("click", onClick);
    return btn;
  }

  function createLabeledSegmentedField(attrName, labelText, options, activeVal, onSelect) {
    const field = el("div", "wphoto-field");
    field.setAttribute(attrName, "true");
    field.appendChild(el("span", "wphoto-label", labelText));

    const group = el("div", "wphoto-segmented");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", labelText);
    for (const opt of options) {
      const btn = createActionBtn(opt.label, "wphoto-seg-btn", () => onSelect(opt.value));
      btn.setAttribute("aria-pressed", String(opt.value === activeVal));
      group.appendChild(btn);
    }
    field.appendChild(group);
    return field;
  }

  function renderMenu() {
    const hideNow = shouldHideTriggerAndMenu();
    if (!state.menuOpen || typeof document === "undefined" || hideNow) {
      if (hideNow) state.menuOpen = false;
      if (typeof document !== "undefined") document.getElementById(MENU_CARD_ID)?.remove();
      return;
    }

    const t = getUiStrings(state.lang);
    let card = document.getElementById(MENU_CARD_ID);
    if (!card) {
      card = document.createElement("div");
      card.id = MENU_CARD_ID;
      card.setAttribute("role", "dialog");
      document.body.appendChild(card);
    }
    card.setAttribute("aria-label", t.menuAriaLabel);
    applyThemeAttr(card);
    positionMenuCard(card);
    card.innerHTML = "";

    if (state.view === "apikey") renderApiKeyView(card);
    else renderMainView(card);
  }

  function renderApiKeyView(card) {
    const t = getUiStrings(state.lang);
    const header = el("div", "wphoto-header");
    header.appendChild(el("span", "wphoto-title", t.apiKeyTitle));
    header.appendChild(
      createActionBtn(t.backBtn, "wphoto-text-btn", () => {
        state.view = "main";
        renderMenu();
      })
    );
    card.appendChild(header);

    const helper = el("div", "wphoto-note");
    helper.innerHTML = t.apiKeyHelperHtml;
    card.appendChild(helper);

    if (state.apiKey) {
      const statusRow = el("div", "wphoto-field", t.currentKey(maskApiKey(state.apiKey)));
      statusRow.style.fontSize = "12px";
      card.appendChild(statusRow);
    }

    const inputRow = el("div", "wphoto-input-row");
    const input = el("input", "wphoto-input");
    input.type = state.showApiKeyPlain ? "text" : "password";
    input.placeholder = "AIzaSy...";
    input.value = state.apiKey;
    input.setAttribute("aria-label", t.apiKeyInputAria);

    const toggleBtn = createActionBtn(
      state.showApiKeyPlain ? t.hideBtn : t.showBtn,
      "wphoto-text-btn",
      () => {
        state.showApiKeyPlain = !state.showApiKeyPlain;
        input.type = state.showApiKeyPlain ? "text" : "password";
        toggleBtn.textContent = state.showApiKeyPlain ? t.hideBtn : t.showBtn;
      }
    );
    inputRow.appendChild(input);
    inputRow.appendChild(toggleBtn);
    card.appendChild(inputRow);

    if (state.apiKeyStatusKey && t[state.apiKeyStatusKey]) {
      const msg = el("div", "", t[state.apiKeyStatusKey]);
      msg.style.fontSize = "12px";
      msg.style.marginBottom = "8px";
      msg.style.color = "var(--wphoto-primary)";
      card.appendChild(msg);
    }

    const actions = el("div", "wphoto-actions-row");
    const saveBtn = createActionBtn(t.saveKeyBtn, "wphoto-primary-btn", () => saveGeminiApiKey(input.value));
    saveBtn.style.flex = "1";
    actions.appendChild(saveBtn);
    actions.appendChild(
      createActionBtn(t.clearBtn, "wphoto-text-btn", () => {
        input.value = "";
        clearGeminiApiKey();
      })
    );
    card.appendChild(actions);
  }

  function renderMainView(card) {
    const t = getUiStrings(state.lang);
    const header = el("div", "wphoto-header");
    header.appendChild(el("span", "wphoto-title", "AI Plus"));
    header.appendChild(
      createActionBtn(state.apiKey ? t.apiKeySetBtn : t.apiKeyBtn, "wphoto-text-btn", () => {
        state.view = "apikey";
        renderMenu();
      })
    );
    card.appendChild(header);

    const langOptions = Object.entries(window.WPHOTO_PROMPTS || { en: { label: "English" } }).map(
      ([code, cfg]) => ({ value: code, label: cfg.label || code.toUpperCase() })
    );
    card.appendChild(
      createLabeledSegmentedField("data-wphoto-lang-toggle", t.languageLabel, langOptions, state.lang, (val) => {
        state.lang = val;
        saveStoredPrefs();
        renderMenu();
        renderStatusBar();
      })
    );

    card.appendChild(
      createLabeledSegmentedField(
        "data-wphoto-model-toggle",
        t.modelLabel,
        [
          { value: "cloud", label: t.modelCloud },
          { value: "local", label: t.modelLocal }
        ],
        state.model,
        (val) => {
          state.model = val;
          saveStoredPrefs();
          if (val === "local") triggerLocalProbe();
          else renderMenu();
        }
      )
    );

    if (state.model === "local") {
      const localNote = el("div", "wphoto-note");
      if (state.nanoStatus === "available") localNote.textContent = t.localReady;
      else if (state.nanoStatus === "downloadable") {
        localNote.textContent = t.localDownloadNeeded;
        localNote.appendChild(createActionBtn(t.downloadModelBtn, "wphoto-link-btn", handleDownloadLocalModel));
      } else if (state.nanoStatus === "downloading") {
        localNote.textContent = t.localDownloading(state.nanoProgressPct);
      } else {
        localNote.textContent = t.localUnavailable;
      }
      card.appendChild(localNote);
    } else if (!state.apiKey) {
      const keyWarning = el("div", "wphoto-note", t.cloudNeedsKey);
      keyWarning.appendChild(
        createActionBtn(t.setApiKeyBtn, "wphoto-link-btn", () => {
          state.view = "apikey";
          renderMenu();
        })
      );
      card.appendChild(keyWarning);
    }

    card.appendChild(
      createLabeledSegmentedField(
        "data-wphoto-overwrite-toggle",
        t.overwriteLabel,
        [
          { value: "no", label: t.no },
          { value: "yes", label: t.yes }
        ],
        state.overwrite,
        (val) => {
          state.overwrite = val;
          saveStoredPrefs();
          renderMenu();
        }
      )
    );

    const verboseRow = el("div", "wphoto-row-between");
    verboseRow.setAttribute("data-wphoto-verbose-toggle", "true");
    const checkLabel = el("label", "wphoto-checkbox-label");
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
    checkLabel.appendChild(checkbox);
    checkLabel.appendChild(el("span", "", t.verboseLog));
    verboseRow.appendChild(checkLabel);
    if (state.verbose) {
      verboseRow.appendChild(createActionBtn(t.downloadLog, "wphoto-link-btn", handleDownloadLog));
    }
    card.appendChild(verboseRow);

    const summary = window.WPhotoSelection.getSummary();
    const canStart = summary.eligible > 0 || summary.inAlbum;
    const primaryBtn = createActionBtn(getCtaLabel(state.lang, summary), "wphoto-primary-btn", handleStartBatch);
    primaryBtn.setAttribute("data-wphoto-primary-cta", "true");
    primaryBtn.disabled = !canStart || state.enumeratingAlbum;
    card.appendChild(primaryBtn);
  }

  function renderStatusBar() {
    if (typeof document === "undefined") return;
    if (statusAutoDismissTimer) {
      clearTimeout(statusAutoDismissTimer);
      statusAutoDismissTimer = null;
    }
    const batch = state.activeBatch;
    let bar = document.getElementById(STATUS_BAR_ID);
    if (!batch) {
      bar?.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement("div");
      bar.id = STATUS_BAR_ID;
      document.body.appendChild(bar);
    }
    applyThemeAttr(bar);
    bar.innerHTML = "";

    const t = getUiStrings(state.lang || batch.options?.lang || "en");
    const total = batch.photoIds?.length || 0;
    const done = batch.completedIds?.length || 0;
    const skipped = batch.skippedIds?.length || 0;
    const failed = batch.failedIds?.length || 0;
    const processed = window.WPhotoBatchRunner.getProcessedCount(batch);
    const isRunning = batch.completedAt === null && batch.lastReason === null;
    const isPaused = batch.lastReason === "paused";
    const isCancelled = batch.lastReason === "cancelled";

    const msg = isRunning
      ? t.statusRunning(Math.min(processed + 1, total), total, done, skipped)
      : isPaused
      ? t.statusPaused(processed, total, done, skipped)
      : isCancelled
      ? t.statusCancelled(done, skipped)
      : t.statusFinished(done, skipped, failed);
    bar.appendChild(el("span", "", msg));

    if (isRunning) {
      bar.appendChild(createActionBtn(t.pauseBtn, "wphoto-text-btn", () => window.WPhotoBatchRunner.pauseBatch()));
      bar.appendChild(createActionBtn(t.cancelBtn, "wphoto-text-btn", () => window.WPhotoBatchRunner.cancelBatch()));
    } else if (isPaused) {
      bar.appendChild(createActionBtn(t.resumeBtn, "wphoto-text-btn", () => window.WPhotoBatchRunner.resumeBatch()));
      bar.appendChild(createActionBtn(t.cancelBtn, "wphoto-text-btn", () => window.WPhotoBatchRunner.clearActiveBatch()));
    } else {
      if (state.menuOpen) closeMenu();
      bar.appendChild(createActionBtn(t.dismissBtn, "wphoto-text-btn", () => window.WPhotoBatchRunner.clearActiveBatch()));
      const ageMs = typeof batch.completedAt === "number" ? Math.max(0, Date.now() - batch.completedAt) : 0;
      statusAutoDismissTimer = setTimeout(() => {
        statusAutoDismissTimer = null;
        if (state.activeBatch && state.activeBatch.completedAt !== null && state.activeBatch.lastReason !== "paused") {
          state.activeBatch = null;
          window.WPhotoBatchRunner.clearActiveBatch();
          renderStatusBar();
        }
      }, Math.max(500, STATUS_BAR_AUTO_DISMISS_MS - ageMs));
    }
  }

  function isElementVisible(node) {
    if (!node) return false;
    if (typeof node.checkVisibility === "function") {
      return node.checkVisibility({ visibilityProperty: true, opacityProperty: true, contentVisibilityAuto: true });
    }
    return node.offsetParent !== null;
  }

  function findSelectionActionContainer() {
    const clearBtn = document.querySelector(
      'button[aria-label="Clear selection"], [aria-label="Clear selection"], button[aria-label="Annuler la sélection"], button[aria-label="Borrar selección"], button[jslog*="8886"]'
    );
    if (!clearBtn || !isElementVisible(clearBtn)) return null;

    let cur = clearBtn.parentElement;
    let shareBtn = null;
    while (
      cur &&
      !(shareBtn = cur.querySelector(
        '[aria-label="Share"], button[aria-label="Partager"], button[aria-label="Compartir"], button[jslog*="8919"]'
      ))
    ) {
      cur = cur.parentElement;
    }

    if (shareBtn && isElementVisible(shareBtn)) {
      const clearAncestors = new Set();
      for (let p = clearBtn; p; p = p.parentElement) clearAncestors.add(p);
      let commonAncestor = shareBtn;
      while (commonAncestor && !clearAncestors.has(commonAncestor)) {
        commonAncestor = commonAncestor.parentElement;
      }
      if (commonAncestor?.children) {
        for (const child of Array.from(commonAncestor.children)) {
          if (child.contains?.(shareBtn)) return child;
        }
        return commonAncestor;
      }
      return shareBtn.parentElement;
    }
    return clearBtn.parentElement;
  }

  function getTopSearchContainers() {
    const containers = [];
    if (typeof document === "undefined") return containers;
    for (const input of Array.from(document.querySelectorAll('input[type="text"], input:not([type]), textarea'))) {
      const r = input.getBoundingClientRect?.();
      if (!r || r.top >= 60 || r.width <= 0) continue;
      let cur = input;
      for (let i = 0; cur && i < 6 && !(i > 0 && cur.getBoundingClientRect?.().width > 1.5 * r.width); i++, cur = cur.parentElement) {
        containers.push(cur);
      }
    }
    return containers;
  }

  function isExcludedTopBarNode(node, searchContainers) {
    return !node || Boolean(node.closest?.('#gb, [class*="gb_"], [role="search"], form')) || searchContainers.some((c) => c.contains?.(node));
  }

  const isRtlDoc = () =>
    typeof getComputedStyle === "function" &&
    document.documentElement &&
    getComputedStyle(document.documentElement).direction === "rtl";

  function findHomeHeaderAnchor() {
    if (typeof document === "undefined") return null;
    const isRtl = isRtlDoc();
    const searchContainers = getTopSearchContainers();
    const candidates = Array.from(
      document.querySelectorAll('a[aria-label], button[aria-label], [role="button"][aria-label]')
    )
      .reduce((acc, node) => {
        if (node.id === TRIGGER_BTN_ID || !isElementVisible(node) || isExcludedTopBarNode(node, searchContainers)) {
          return acc;
        }
        const r = node.getBoundingClientRect?.();
        if (r && r.top < 60 && r.width >= 24 && r.width <= 60 && r.height >= 24 && r.height <= 60) {
          acc.push({ el: node, r, x: isRtl ? -r.left : r.left });
        }
        return acc;
      }, [])
      .sort((a, b) => a.x - b.x);

    if (candidates.length === 0) return null;
    let anchor = candidates[candidates.length - 1];
    for (let i = candidates.length - 1; i > 0; i--) {
      if (candidates[i].x - candidates[i - 1].x > 120) break;
      anchor = candidates[i - 1];
    }
    const halfW = (typeof window !== "undefined" ? window.innerWidth : 1280) / 2;
    return (isRtl ? anchor.r.left < halfW : anchor.r.left > halfW) ? anchor.el : null;
  }

  function findHomeFlexHeaderBar() {
    if (typeof document === "undefined") return null;
    const searchContainers = getTopSearchContainers();
    const firstTopItem = Array.from(document.querySelectorAll("a[aria-label], button[aria-label]")).find(
      (node) =>
        node.id !== TRIGGER_BTN_ID &&
        isElementVisible(node) &&
        !isExcludedTopBarNode(node, searchContainers) &&
        node.getBoundingClientRect?.().top < 60
    );
    if (!firstTopItem) return null;
    let cur = firstTopItem.parentElement;
    const winW = typeof window !== "undefined" ? window.innerWidth : 1280;
    for (let i = 0; i < 8 && cur; i++, cur = cur.parentElement) {
      const r = cur.getBoundingClientRect?.();
      const style = typeof getComputedStyle === "function" ? getComputedStyle(cur) : null;
      if (style?.display === "flex" && r && r.top < 20 && r.height > 0 && r.height < 100 && r.width >= 0.9 * winW) {
        if (searchContainers.includes(cur) || (cur.querySelector?.('input[type="text"], [role="search"]') && cur.children.length <= 1)) {
          continue;
        }
        return cur;
      }
    }
    return null;
  }

  function insertBeforeTopBarAnchor(btn, anchor) {
    const parent = anchor.parentElement;
    if (!parent) return;
    parent.insertBefore(btn, anchor);
    for (let i = 0; i < 8; i++) {
      const curParent = btn.parentElement;
      if (!curParent?.parentElement) return;
      const rect = curParent.getBoundingClientRect?.();
      if (!rect || rect.width > 60) return;
      curParent.parentElement.insertBefore(btn, curParent);
    }
  }

  function alignTopBarButtonVertically(btn, anchor) {
    const bRect = btn.getBoundingClientRect?.();
    const aRect = anchor.getBoundingClientRect?.();
    if (!bRect || !aRect || bRect.height === 0 || aRect.height === 0) return;
    const delta = Math.round(aRect.top + aRect.height / 2 - (bRect.top + bRect.height / 2));
    if (Math.abs(delta) < 2 || Math.abs(delta) > 12) return;
    btn.style.position = "relative";
    btn.style.top = `${(parseFloat(btn.style.top) || 0) + delta}px`;
  }

  function isAdjacentToAnchor(btn, anchor) {
    const next = btn.nextElementSibling;
    return Boolean(btn.parentElement?.contains?.(anchor) && next && (next === anchor || next.contains?.(anchor)));
  }

  function isMountedInValidTopBarPosition(btn) {
    const r = btn.getBoundingClientRect?.();
    if (!r || (r.width === 0 && r.height === 0)) return false;
    const halfW = (typeof window !== "undefined" ? window.innerWidth : 1280) / 2;
    return isRtlDoc() ? r.left < halfW : r.left > halfW;
  }

  function ensureTriggerButtonMounted() {
    if (typeof document === "undefined" || !document.body) return;
    if (shouldHideTriggerAndMenu()) {
      if (state.menuOpen) closeMenu();
      document.getElementById(TRIGGER_BTN_ID)?.remove();
      return;
    }

    let btn = document.getElementById(TRIGGER_BTN_ID);
    if (!btn) {
      btn = createActionBtn("AI Plus", "", (e) => {
        e.stopPropagation();
        state.menuOpen = !state.menuOpen;
        btn.setAttribute("aria-expanded", String(state.menuOpen));
        if (state.menuOpen && state.model === "local") triggerLocalProbe();
        renderMenu();
      });
      btn.id = TRIGGER_BTN_ID;
      btn.dir = "ltr";
      btn.setAttribute("aria-label", "AI Plus");
      btn.setAttribute("aria-haspopup", "dialog");
    }
    applyThemeAttr(btn);
    btn.setAttribute("aria-expanded", String(state.menuOpen));

    const resetInlinePos = () => {
      btn.style.position = "";
      btn.style.top = "";
    };

    const selContainer = findSelectionActionContainer();
    if (btn.parentElement && btn.getAttribute("data-pinned") === null) {
      const placement = btn.getAttribute("data-placement");
      if (placement === "selection" && selContainer === btn.parentElement && btn.previousElementSibling === null) return;
      if (
        placement === "home" &&
        !selContainer &&
        btn.nextElementSibling &&
        isElementVisible(btn.nextElementSibling) &&
        isMountedInValidTopBarPosition(btn)
      ) {
        return;
      }
    }

    if (selContainer) {
      btn.removeAttribute("data-pinned");
      btn.setAttribute("data-placement", "selection");
      resetInlinePos();
      if (btn.parentElement !== selContainer || btn.previousElementSibling !== null) {
        selContainer.insertBefore(btn, selContainer.firstChild);
      }
      return;
    }

    btn.setAttribute("data-placement", "home");
    const anchor = findHomeHeaderAnchor();
    if (anchor?.parentElement) {
      btn.removeAttribute("data-pinned");
      if (!isAdjacentToAnchor(btn, anchor)) {
        resetInlinePos();
        insertBeforeTopBarAnchor(btn, anchor);
      }
      if (isMountedInValidTopBarPosition(btn)) {
        alignTopBarButtonVertically(btn, anchor);
        return;
      }
    }

    const flexBar = findHomeFlexHeaderBar();
    if (flexBar) {
      btn.removeAttribute("data-pinned");
      resetInlinePos();
      if (btn.parentElement !== flexBar) flexBar.appendChild(btn);
      if (isMountedInValidTopBarPosition(btn)) return;
    }

    btn.setAttribute("data-pinned", "true");
    resetInlinePos();
    if (btn.parentElement !== document.body) document.body.appendChild(btn);
  }

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

    const syncUi = () => {
      ensureTriggerButtonMounted();
      if (state.menuOpen) renderMenu();
    };
    window.WPhotoSelection.onChange(syncUi);
    window.WPhotoBatchRunner.onStateChange((batch) => {
      state.activeBatch = batch;
      renderStatusBar();
    });
    window.addEventListener?.("popstate", syncUi);
    setInterval(() => {
      if (typeof document === "undefined" || document.hidden !== true) ensureTriggerButtonMounted();
    }, 1000);
    await window.WPhotoBatchRunner.continueBatchIfActive();
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initUi);
    else initUi();
  }

  window.WPhotoUi = {
    state,
    getUiStrings,
    maskApiKey,
    detectGooglePhotosTheme,
    findSelectionActionContainer,
    findHomeHeaderAnchor,
    saveGeminiApiKey,
    clearGeminiApiKey,
    renderMenu,
    renderStatusBar,
    closeMenu,
    ensureTriggerButtonMounted
  };
})();
