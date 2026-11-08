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
    apiKeyStatusKey: "",
    nanoStatus: "idle", // "idle" | "available" | "downloadable" | "downloading" | "unavailable"
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
      apiKeyHelperHtml:
        'Enter your Gemini API key from <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline;">Google AI Studio</a>. Stored locally on this browser only.',
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
      apiKeyHelperHtml:
        'Saisissez votre clé API Gemini depuis <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline;">Google AI Studio</a>. Stockée uniquement sur ce navigateur.',
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
      apiKeyHelperHtml:
        'Ingresa tu clave API de Gemini desde <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline;">Google AI Studio</a>. Guardada localmente solo en este navegador.',
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
        state.apiKeyStatusKey = "keySaved";
      } else {
        await chrome.storage.local.remove("geminiApiKey");
        state.apiKey = "";
        state.apiKeyStatusKey = "keyCleared";
      }
    } catch (e) {
      state.apiKeyStatusKey = "keySaveFailed";
    }
    renderMenu();
    setTimeout(() => {
      state.apiKeyStatusKey = "";
      if (state.menuOpen) renderMenu();
    }, 2500);
  }

  async function clearGeminiApiKey() {
    try {
      await chrome.storage.local.remove("geminiApiKey");
    } catch (e) {}
    state.apiKey = "";
    state.apiKeyStatusKey = "keyCleared";
    renderMenu();
    setTimeout(() => {
      state.apiKeyStatusKey = "";
      if (state.menuOpen) renderMenu();
    }, 2500);
  }

  function getCtaLabel(lang, summary) {
    const t = getUiStrings(lang);
    if (state.enumeratingAlbum) {
      return t.readingAlbum;
    }
    if (summary.eligible > 0) {
      return t.describeCount(summary.eligible);
    }
    if (summary.inAlbum) {
      return t.describeAlbum;
    }
    return t.selectPhotos;
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

  function parseColorDarkness(cssColor) {
    if (!cssColor || cssColor === "transparent") return null;
    const rgb = cssColor.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
    if (rgb) {
      const lum = 0.299 * Number(rgb[1]) + 0.587 * Number(rgb[2]) + 0.114 * Number(rgb[3]);
      return lum < 128;
    }
    const rgba = cssColor.match(/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/);
    if (rgba) {
      if (Number(rgba[4]) < 0.5) return null;
      const lum = 0.299 * Number(rgba[1]) + 0.587 * Number(rgba[2]) + 0.114 * Number(rgba[3]);
      return lum < 128;
    }
    return null;
  }

  function detectGooglePhotosTheme() {
    if (typeof window === "undefined" || typeof document === "undefined") return "light";
    if (typeof getComputedStyle === "function") {
      if (document.body) {
        const bodyDark = parseColorDarkness(getComputedStyle(document.body).backgroundColor);
        if (bodyDark !== null) return bodyDark ? "dark" : "light";
      }
      if (document.documentElement) {
        const docDark = parseColorDarkness(getComputedStyle(document.documentElement).backgroundColor);
        if (docDark !== null) return docDark ? "dark" : "light";
      }
    }
    const prefersDark =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    return prefersDark ? "dark" : "light";
  }

  function applyThemeAttr(el) {
    if (!el) return;
    el.setAttribute("data-theme", detectGooglePhotosTheme());
  }

  function closeMenu() {
    state.menuOpen = false;
    state.view = "main";
    const btn = typeof document !== "undefined" ? document.getElementById(TRIGGER_BTN_ID) : null;
    if (btn) btn.setAttribute("aria-expanded", "false");
    const existing = typeof document !== "undefined" ? document.getElementById(MENU_CARD_ID) : null;
    if (existing) existing.remove();
  }

  function renderMenu() {
    if (
      !state.menuOpen ||
      typeof document === "undefined" ||
      window.WPhotoSelection.parsePhotoIdFromPath()
    ) {
      if (window.WPhotoSelection?.parsePhotoIdFromPath?.()) {
        state.menuOpen = false;
      }
      const existing = typeof document !== "undefined" ? document.getElementById(MENU_CARD_ID) : null;
      if (existing) existing.remove();
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

    if (state.view === "apikey") {
      renderApiKeyView(card);
    } else {
      renderMainView(card);
    }
  }

  function renderApiKeyView(card) {
    const t = getUiStrings(state.lang);
    const header = document.createElement("div");
    header.className = "wphoto-header";

    const title = document.createElement("span");
    title.className = "wphoto-title";
    title.textContent = t.apiKeyTitle;

    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "wphoto-text-btn";
    backBtn.textContent = t.backBtn;
    backBtn.addEventListener("click", () => {
      state.view = "main";
      renderMenu();
    });

    header.appendChild(title);
    header.appendChild(backBtn);
    card.appendChild(header);

    const helper = document.createElement("div");
    helper.className = "wphoto-note";
    helper.innerHTML = t.apiKeyHelperHtml;
    card.appendChild(helper);

    if (state.apiKey) {
      const statusRow = document.createElement("div");
      statusRow.className = "wphoto-field";
      statusRow.style.fontSize = "12px";
      statusRow.textContent = t.currentKey(maskApiKey(state.apiKey));
      card.appendChild(statusRow);
    }

    const inputRow = document.createElement("div");
    inputRow.className = "wphoto-input-row";

    const input = document.createElement("input");
    input.type = state.showApiKeyPlain ? "text" : "password";
    input.className = "wphoto-input";
    input.placeholder = "AIzaSy...";
    input.value = state.apiKey;
    input.setAttribute("aria-label", t.apiKeyInputAria);

    const toggleShowBtn = document.createElement("button");
    toggleShowBtn.type = "button";
    toggleShowBtn.className = "wphoto-text-btn";
    toggleShowBtn.textContent = state.showApiKeyPlain ? t.hideBtn : t.showBtn;
    toggleShowBtn.addEventListener("click", () => {
      state.showApiKeyPlain = !state.showApiKeyPlain;
      state.apiKey = input.value;
      renderMenu();
    });

    inputRow.appendChild(input);
    inputRow.appendChild(toggleShowBtn);
    card.appendChild(inputRow);

    if (state.apiKeyStatusKey && t[state.apiKeyStatusKey]) {
      const msg = document.createElement("div");
      msg.style.fontSize = "12px";
      msg.style.marginBottom = "8px";
      msg.style.color = "var(--wphoto-primary)";
      msg.textContent = t[state.apiKeyStatusKey];
      card.appendChild(msg);
    }

    const actions = document.createElement("div");
    actions.className = "wphoto-actions-row";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "wphoto-primary-btn";
    saveBtn.style.flex = "1";
    saveBtn.textContent = t.saveKeyBtn;
    saveBtn.addEventListener("click", () => {
      saveGeminiApiKey(input.value);
    });

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "wphoto-text-btn";
    clearBtn.textContent = t.clearBtn;
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
    const t = getUiStrings(state.lang);

    // Header: Title + API Key button
    const header = document.createElement("div");
    header.className = "wphoto-header";

    const title = document.createElement("span");
    title.className = "wphoto-title";
    title.textContent = "AI Plus";

    const apiKeyBtn = document.createElement("button");
    apiKeyBtn.type = "button";
    apiKeyBtn.className = "wphoto-text-btn";
    apiKeyBtn.textContent = state.apiKey ? t.apiKeySetBtn : t.apiKeyBtn;
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
    langLabel.textContent = t.languageLabel;
    langField.appendChild(langLabel);
    langField.appendChild(
      createSegmentedControl(
        langOptions,
        state.lang,
        (val) => {
          state.lang = val;
          saveStoredPrefs();
          renderMenu();
          renderStatusBar();
        },
        t.languageLabel
      )
    );
    card.appendChild(langField);

    // 2. Model selector (Cloud vs Local)
    const modelField = document.createElement("div");
    modelField.className = "wphoto-field";
    modelField.setAttribute("data-wphoto-model-toggle", "true");
    const modelLabel = document.createElement("span");
    modelLabel.className = "wphoto-label";
    modelLabel.textContent = t.modelLabel;
    modelField.appendChild(modelLabel);
    modelField.appendChild(
      createSegmentedControl(
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
        },
        t.modelLabel
      )
    );
    card.appendChild(modelField);

    if (state.model === "local") {
      const localNote = document.createElement("div");
      localNote.className = "wphoto-note";
      if (state.nanoStatus === "available") {
        localNote.textContent = t.localReady;
      } else if (state.nanoStatus === "downloadable") {
        localNote.textContent = t.localDownloadNeeded;
        const dlBtn = document.createElement("button");
        dlBtn.type = "button";
        dlBtn.className = "wphoto-link-btn";
        dlBtn.textContent = t.downloadModelBtn;
        dlBtn.addEventListener("click", handleDownloadLocalModel);
        localNote.appendChild(dlBtn);
      } else if (state.nanoStatus === "downloading") {
        localNote.textContent = t.localDownloading(state.nanoProgressPct);
      } else {
        localNote.textContent = t.localUnavailable;
      }
      card.appendChild(localNote);
    } else if (!state.apiKey) {
      const keyWarning = document.createElement("div");
      keyWarning.className = "wphoto-note";
      keyWarning.textContent = t.cloudNeedsKey;
      const setKeyLink = document.createElement("button");
      setKeyLink.type = "button";
      setKeyLink.className = "wphoto-link-btn";
      setKeyLink.textContent = t.setApiKeyBtn;
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
    overwriteLabel.textContent = t.overwriteLabel;
    overwriteField.appendChild(overwriteLabel);
    overwriteField.appendChild(
      createSegmentedControl(
        [
          { value: "no", label: t.no },
          { value: "yes", label: t.yes }
        ],
        state.overwrite,
        (val) => {
          state.overwrite = val;
          saveStoredPrefs();
          renderMenu();
        },
        t.overwriteLabel
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
    checkSpan.textContent = t.verboseLog;
    checkLabel.appendChild(checkbox);
    checkLabel.appendChild(checkSpan);
    verboseRow.appendChild(checkLabel);

    if (state.verbose) {
      const dlLogBtn = document.createElement("button");
      dlLogBtn.type = "button";
      dlLogBtn.className = "wphoto-link-btn";
      dlLogBtn.textContent = t.downloadLog;
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
    applyThemeAttr(bar);
    bar.innerHTML = "";

    const activeLang = state.lang || batch.options?.lang || "en";
    const t = getUiStrings(activeLang);

    const total = batch.photoIds?.length || 0;
    const done = batch.completedIds?.length || 0;
    const skipped = batch.skippedIds?.length || 0;
    const failed = batch.failedIds?.length || 0;
    const processed = window.WPhotoBatchRunner.getProcessedCount(batch);
    const isRunning = batch.completedAt === null && batch.lastReason === null;
    const isPaused = batch.lastReason === "paused";

    const textSpan = document.createElement("span");
    if (isRunning) {
      textSpan.textContent = t.statusRunning(Math.min(processed + 1, total), total, done, skipped);
    } else if (isPaused) {
      textSpan.textContent = t.statusPaused(processed, total, done, skipped);
    } else {
      textSpan.textContent = t.statusFinished(done, skipped, failed);
    }
    bar.appendChild(textSpan);

    if (isRunning) {
      const pauseBtn = document.createElement("button");
      pauseBtn.type = "button";
      pauseBtn.className = "wphoto-text-btn";
      pauseBtn.textContent = t.pauseBtn;
      pauseBtn.addEventListener("click", () => window.WPhotoBatchRunner.pauseBatch());
      bar.appendChild(pauseBtn);

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "wphoto-text-btn";
      cancelBtn.textContent = t.cancelBtn;
      cancelBtn.addEventListener("click", () => window.WPhotoBatchRunner.cancelBatch());
      bar.appendChild(cancelBtn);
    } else if (isPaused) {
      const resumeBtn = document.createElement("button");
      resumeBtn.type = "button";
      resumeBtn.className = "wphoto-text-btn";
      resumeBtn.textContent = t.resumeBtn;
      resumeBtn.addEventListener("click", () => window.WPhotoBatchRunner.resumeBatch());
      bar.appendChild(resumeBtn);

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "wphoto-text-btn";
      cancelBtn.textContent = t.cancelBtn;
      cancelBtn.addEventListener("click", () => window.WPhotoBatchRunner.clearActiveBatch());
      bar.appendChild(cancelBtn);
    } else {
      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "wphoto-text-btn";
      closeBtn.textContent = t.dismissBtn;
      closeBtn.addEventListener("click", () => window.WPhotoBatchRunner.clearActiveBatch());
      bar.appendChild(closeBtn);
    }
  }

  function isElementVisible(el) {
    if (!el) return false;
    if (typeof el.checkVisibility === "function") {
      return el.checkVisibility({
        visibilityProperty: true,
        opacityProperty: true,
        contentVisibilityAuto: true
      });
    }
    return el.offsetParent !== null;
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
      for (let p = clearBtn; p; p = p.parentElement) {
        clearAncestors.add(p);
      }
      let commonAncestor = shareBtn;
      while (commonAncestor && !clearAncestors.has(commonAncestor)) {
        commonAncestor = commonAncestor.parentElement;
      }
      if (commonAncestor && commonAncestor.children) {
        for (const child of Array.from(commonAncestor.children)) {
          if (child.contains && child.contains(shareBtn)) {
            return child;
          }
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
    const inputs = Array.from(
      document.querySelectorAll('input[type="text"], input:not([type]), textarea')
    ).filter((el) => {
      const r = el.getBoundingClientRect?.();
      return r && r.top < 60 && r.width > 0;
    });
    for (const input of inputs) {
      const w = input.getBoundingClientRect().width;
      let cur = input;
      for (
        let i = 0;
        cur && i < 6 && !(i > 0 && cur.getBoundingClientRect?.().width > 1.5 * w);
        i++, cur = cur.parentElement
      ) {
        containers.push(cur);
      }
    }
    return containers;
  }

  function isExcludedTopBarNode(el, searchContainers) {
    if (!el) return true;
    if (el.closest?.('#gb, [class*="gb_"], [role="search"], form')) return true;
    return searchContainers.some((c) => c.contains?.(el));
  }

  function findHomeHeaderAnchor() {
    if (typeof document === "undefined") return null;
    const isRtl =
      typeof getComputedStyle === "function" &&
      document.documentElement &&
      getComputedStyle(document.documentElement).direction === "rtl";
    const searchContainers = getTopSearchContainers();
    const xCoord = (el) => {
      const left = el.getBoundingClientRect().left;
      return isRtl ? -left : left;
    };
    const candidates = Array.from(
      document.querySelectorAll('a[aria-label], button[aria-label], [role="button"][aria-label]')
    )
      .filter((el) => {
        if (
          el.id === TRIGGER_BTN_ID ||
          !isElementVisible(el) ||
          isExcludedTopBarNode(el, searchContainers)
        ) {
          return false;
        }
        const r = el.getBoundingClientRect?.();
        return r && r.top < 60 && r.width >= 24 && r.width <= 60 && r.height >= 24 && r.height <= 60;
      })
      .sort((a, b) => xCoord(a) - xCoord(b));

    if (candidates.length === 0) return null;
    let anchor = candidates[candidates.length - 1];
    for (let i = candidates.length - 1; i > 0; i--) {
      if (xCoord(candidates[i]) - xCoord(candidates[i - 1]) > 120) break;
      anchor = candidates[i - 1];
    }
    const halfW = (typeof window !== "undefined" ? window.innerWidth : 1280) / 2;
    const anchorLeft = anchor.getBoundingClientRect().left;
    const onActionSide = isRtl ? anchorLeft < halfW : anchorLeft > halfW;
    return onActionSide ? anchor : null;
  }

  function findHomeFlexHeaderBar() {
    if (typeof document === "undefined") return null;
    const searchContainers = getTopSearchContainers();
    const firstTopItem = Array.from(
      document.querySelectorAll("a[aria-label], button[aria-label]")
    ).find(
      (el) =>
        el.id !== TRIGGER_BTN_ID &&
        isElementVisible(el) &&
        !isExcludedTopBarNode(el, searchContainers) &&
        el.getBoundingClientRect?.().top < 60
    );
    if (!firstTopItem) return null;
    let cur = firstTopItem.parentElement;
    const winW = typeof window !== "undefined" ? window.innerWidth : 1280;
    for (let i = 0; i < 8 && cur; i++, cur = cur.parentElement) {
      const r = cur.getBoundingClientRect?.();
      const style = typeof getComputedStyle === "function" ? getComputedStyle(cur) : null;
      if (
        style &&
        style.display === "flex" &&
        r &&
        r.top < 20 &&
        r.height > 0 &&
        r.height < 100 &&
        r.width >= 0.9 * winW
      ) {
        if (
          searchContainers.includes(cur) ||
          (cur.querySelector?.('input[type="text"], [role="search"]') && cur.children.length <= 1)
        ) {
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
      if (!curParent || !curParent.parentElement) return;
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
    const curTop = parseFloat(btn.style.top) || 0;
    btn.style.position = "relative";
    btn.style.top = `${curTop + delta}px`;
  }

  function isAdjacentToAnchor(btn, anchor) {
    const parent = btn.parentElement;
    if (!parent || !parent.contains?.(anchor)) return false;
    const next = btn.nextElementSibling;
    return next !== null && (next === anchor || next.contains?.(anchor));
  }

  function isMountedInValidTopBarPosition(btn) {
    const r = btn.getBoundingClientRect?.();
    if (!r || (r.width === 0 && r.height === 0)) return false;
    const isRtl =
      typeof getComputedStyle === "function" &&
      document.documentElement &&
      getComputedStyle(document.documentElement).direction === "rtl";
    const halfW = (typeof window !== "undefined" ? window.innerWidth : 1280) / 2;
    return isRtl ? r.left < halfW : r.left > halfW;
  }

  function ensureTriggerButtonMounted() {
    if (typeof document === "undefined" || !document.body) return;

    // Disable and remove the menu & trigger button when looking at a single photo (/photo/<id>)
    if (window.WPhotoSelection.parsePhotoIdFromPath()) {
      if (state.menuOpen) {
        closeMenu();
      }
      const existingBtn = document.getElementById(TRIGGER_BTN_ID);
      if (existingBtn) {
        existingBtn.remove();
      }
      return;
    }

    let btn = document.getElementById(TRIGGER_BTN_ID);
    if (!btn) {
      btn = document.createElement("button");
      btn.id = TRIGGER_BTN_ID;
      btn.type = "button";
      btn.dir = "ltr";
      btn.textContent = "AI Plus";
      btn.setAttribute("aria-label", "AI Plus");
      btn.setAttribute("aria-haspopup", "dialog");
      btn.setAttribute("aria-expanded", String(state.menuOpen));
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        state.menuOpen = !state.menuOpen;
        btn.setAttribute("aria-expanded", String(state.menuOpen));
        if (state.menuOpen && state.model === "local") {
          triggerLocalProbe();
        }
        renderMenu();
      });
    }
    applyThemeAttr(btn);
    btn.setAttribute("aria-expanded", String(state.menuOpen));

    // 1. Selection bar placement (leftmost item of the right-side selection action cluster)
    const selContainer = findSelectionActionContainer();
    if (selContainer) {
      btn.removeAttribute("data-pinned");
      btn.setAttribute("data-placement", "selection");
      btn.style.position = "";
      btn.style.top = "";
      if (btn.parentElement !== selContainer || btn.previousElementSibling !== null) {
        selContainer.insertBefore(btn, selContainer.firstChild);
      }
      return;
    }

    // 2. Home / Album header action cluster placement (before top-right action buttons)
    btn.setAttribute("data-placement", "home");
    const anchor = findHomeHeaderAnchor();
    if (anchor && anchor.parentElement) {
      btn.removeAttribute("data-pinned");
      if (!isAdjacentToAnchor(btn, anchor)) {
        btn.style.position = "";
        btn.style.top = "";
        insertBeforeTopBarAnchor(btn, anchor);
      }
      if (isMountedInValidTopBarPosition(btn)) {
        alignTopBarButtonVertically(btn, anchor);
        return;
      }
    }

    // 3. Secondary flex header bar fallback
    const flexBar = findHomeFlexHeaderBar();
    if (flexBar) {
      btn.removeAttribute("data-pinned");
      btn.style.position = "";
      btn.style.top = "";
      if (btn.parentElement !== flexBar) {
        flexBar.appendChild(btn);
      }
      if (isMountedInValidTopBarPosition(btn)) {
        return;
      }
    }

    // 4. Final fallback: pinned top-right header placement
    btn.setAttribute("data-pinned", "true");
    btn.style.position = "";
    btn.style.top = "";
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
