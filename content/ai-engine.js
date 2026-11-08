// AI Description Engine (Cloud Gemini + Local Gemini Nano + Multi-Language Template Interpolation + Stack Propagation)

(function () {
  const CAPTION_MAX_LENGTH = 1000;
  const GENERATE_TIMEOUT_MS = 35000;
  let nanoMsgSeq = 0;
  let nanoInjectedOrigin = null;

  function getPromptConfig(lang = "en") {
    const prompts = (typeof window !== "undefined" && window.WPHOTO_PROMPTS) || {};
    return prompts[lang] || prompts.en || {};
  }

  function extractFirstNames(people = []) {
    return (people || [])
      .map((name) => String(name).trim().split(/\s+/)[0])
      .filter((first) => first.length > 0);
  }

  function joinNamesList(firstNames, lang = "en") {
    const tpl = getPromptConfig(lang);
    const andWord = tpl.andWord || "and";
    if (!firstNames || firstNames.length === 0) return "";
    if (firstNames.length === 1) return firstNames[0];
    if (firstNames.length === 2) return `${firstNames[0]} ${andWord} ${firstNames[1]}`;
    const commaAnd = lang === "en" ? `, ${andWord} ` : ` ${andWord} `;
    return `${firstNames.slice(0, -1).join(", ")}${commaAnd}${firstNames[firstNames.length - 1]}`;
  }

  function buildRules(metadata, lang = "en") {
    const tpl = getPromptConfig(lang);
    const firstNames = extractFirstNames(metadata?.people || []);
    const untaggedCount = metadata?.untaggedCount || 0;
    const location = metadata?.location || null;

    let peoplePart = "";
    if (firstNames.length > 0) {
      let peopleListStr = firstNames.join(", ");
      if (untaggedCount > 0) {
        const untaggedPhrase =
          untaggedCount === 1
            ? tpl.untaggedOne || "one additional untagged person"
            : (tpl.untaggedMany || "{count} additional untagged people").replace(
                /\{count\}/g,
                String(untaggedCount)
              );
        const plusWord = lang === "es" ? "más" : "plus";
        peopleListStr += `, ${plusWord} ${untaggedPhrase}`;
      }
      peoplePart = (tpl.peopleTagged || "Tagged people in this photo: {people}.").replace(
        /\{people\}/g,
        peopleListStr
      );
    } else {
      peoplePart = tpl.peopleNone || "No people are tagged in this photo.";
    }

    const strictPart = tpl.strictRules || "";
    const locationPart = location
      ? (tpl.locationRule || "The tagged place name is '{location}'.").replace(
          /\{location\}/g,
          location
        )
      : "";

    return [peoplePart, strictPart, locationPart].filter(Boolean).join(" ");
  }

  function buildInstruction(metadata, lang = "en") {
    const tpl = getPromptConfig(lang);
    const firstNames = extractFirstNames(metadata?.people || []);
    if (firstNames.length > 0) {
      const namesJoined = joinNamesList(firstNames, lang);
      return (tpl.instructionWithPeople || "").replace(/\{names\}/g, namesJoined);
    }
    return tpl.instructionNoPeople || "";
  }

  function composeMetadataCaption(metadata, lang = "en") {
    const tpl = getPromptConfig(lang);
    const firstNames = extractFirstNames(metadata?.people || []);
    const location = metadata?.location || null;
    const year = metadata?.year || null;
    const inWord = tpl.inWord || "in";

    if (firstNames.length === 0 && !location) return null;

    let text = "";
    if (firstNames.length > 0) {
      text = joinNamesList(firstNames, lang);
      if (location) {
        text += ` ${inWord} ${location}`;
      }
    } else {
      text = `${location}`;
    }

    if (year) {
      text += `, ${year}`;
    }
    return (text + ".").slice(0, CAPTION_MAX_LENGTH);
  }

  function cleanGeneratedCaption(rawText) {
    let text = String(rawText || "").trim();
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (lines.length > 1 && /^(here'?s|voici|voil[àa]|aqu[íi]\s+tienes|he\s+aqu[íi])\b.*:$/i.test(lines[0])) {
      lines.shift();
    }

    text = lines
      .join(" ")
      .replace(/\*\*/g, "")
      .replace(/^["'\u201c\u2018\u00ab]+|["'\u201d\u2019\u00bb]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();

    let stripped = text
      .replace(
        /^(here'?s|here\s+is)(?:\s+(?:a|an|the)?\s*(?:suggested\s+)?(?:caption|description)?)?\s*[:.-]?\s*/i,
        ""
      )
      .replace(
        /^(voici|voil[àa])(?:\s+(?:une|la|cette)?\s*(?:proposition\s+de\s+)?(?:l[ée]gende|description)?\s*(?:pour|de)?\s*(?:la|cette)?\s*(?:photo|image)?)?\s*[:.-]?\s*/i,
        ""
      )
      .replace(
        /^(aqu[íi]\s+tienes|he\s+aqu[íi])(?:\s+(?:una|la|esta)?\s*(?:propuesta\s+de\s+)?(?:leyenda|descripci[óo]n|pie\s+de\s+foto)?)?\s*[:.-]?\s*/i,
        ""
      )
      .replace(
        /^(a |an |the )?(photo(graph)?|image|picture|snapshot)\b( of| shows| showing| features| depicting| with)?[,:]?\s*/i,
        ""
      )
      .replace(
        /^((une |la |cette )?(photo(graphie)?|image|vue|clich[ée])\b( de| d'| montre| montrant| pr[ée]sentant| avec)?[,:]?\s*)/i,
        ""
      )
      .replace(
        /^((una |la |esta )?(foto(graf[íi]a)?|imagen|vista|instant[áa]nea)\b( de| muestra| mostrando| con)?[,:]?\s*)/i,
        ""
      );

    if (stripped.length >= 10 && stripped !== text) {
      text = stripped.charAt(0).toUpperCase() + stripped.slice(1);
    }

    const twoSentences = text.match(/^[^.!?]*[.!?](?:\s+[^.!?]*[.!?])?/);
    if (twoSentences && twoSentences[0].trim().length >= 15) {
      text = twoSentences[0].trim();
    }

    return text.slice(0, CAPTION_MAX_LENGTH);
  }

  async function clearAiDescLog() {
    try {
      await chrome.storage.local.set({ aiDescriptionVerboseLog: "" });
    } catch (e) {}
  }

  async function getAiDescLog() {
    try {
      const data = await chrome.storage.local.get("aiDescriptionVerboseLog");
      return data?.aiDescriptionVerboseLog || "";
    } catch (e) {
      return "";
    }
  }

  function appendAiDescLog(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try {
      chrome.storage.local.get("aiDescriptionVerboseLog", (data) => {
        const prev = (data && data.aiDescriptionVerboseLog) || "";
        chrome.storage.local.set({ aiDescriptionVerboseLog: prev + line });
      });
    } catch (e) {}
  }

  if (typeof window !== "undefined") {
    window.__batchAppendLog = appendAiDescLog;
  }

  const DEFAULT_429_BACKOFF_MS = [2000, 5000, 10000];

  function sleepMs(ms) {
    if (typeof window !== "undefined" && window.WPhotoDomCaption?.sleep) {
      return window.WPhotoDomCaption.sleep(ms);
    }
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function resolve429RetryDelayMs(resp, attemptIndex, customDelays) {
    const schedule =
      Array.isArray(customDelays) && customDelays.length > 0
        ? customDelays
        : (typeof window !== "undefined" && Array.isArray(window.__wphotoRetryDelaysMs)
            ? window.__wphotoRetryDelaysMs
            : DEFAULT_429_BACKOFF_MS);
    const baseDelay = schedule[Math.min(attemptIndex, schedule.length - 1)] ?? 2000;
    try {
      const retryAfterHeader = resp?.headers?.get?.("Retry-After") || resp?.headers?.get?.("retry-after");
      if (retryAfterHeader && !Array.isArray(customDelays)) {
        const secs = Number(retryAfterHeader);
        if (Number.isFinite(secs) && secs > 0) {
          return Math.min(30000, Math.max(baseDelay, Math.round(secs * 1000)));
        }
      }
    } catch (e) {}
    return baseDelay;
  }

  async function callGeminiCloud({
    apiKey,
    model = "gemini-3.1-flash-lite",
    rules = "",
    instruction = "",
    imgSrc = null,
    lang = "en",
    retryDelaysMs = null,
    onRetry = null
  }) {
    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      return { error: "missing_gemini_api_key" };
    }
    const prompt = (rules ? rules + "\n\n" : "") + instruction;
    const parts = [{ text: prompt.trim() }];

    if (imgSrc && typeof document !== "undefined") {
      let b64 = null;
      const targetW = 768;
      const targetH = 768;
      const drawSourceTo768 = (srcObj, sw, sh) => {
        const canvas = document.createElement("canvas");
        const w = sw || targetW;
        const h = sh || targetH;
        const scale = Math.min(targetW / w, targetH / h);
        const dw = Math.round(w * scale);
        const dh = Math.round(h * scale);
        const dx = Math.round((targetW - dw) / 2);
        const dy = Math.round((targetH - dh) / 2);
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(srcObj, dx, dy, dw, dh);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
        return dataUrl && dataUrl.includes(",") ? dataUrl.split(",")[1] : null;
      };

      try {
        const img = Array.from(document.querySelectorAll("img")).find(
          (el) => el.src === imgSrc && el.naturalWidth > 0
        );
        if (img) {
          b64 = drawSourceTo768(img, img.naturalWidth, img.naturalHeight);
        }
      } catch (e) {
        b64 = null;
      }

      if (!b64 && typeof fetch === "function" && typeof createImageBitmap === "function") {
        try {
          let imgResp = await fetch(imgSrc, { credentials: "include" }).catch(() => null);
          if (!imgResp || !imgResp.ok) {
            imgResp = await fetch(imgSrc, { credentials: "omit" }).catch(() => null);
          }
          if (imgResp && imgResp.ok) {
            const blob = await imgResp.blob();
            const bmp = await createImageBitmap(blob);
            try {
              b64 = drawSourceTo768(bmp, bmp.width, bmp.height);
            } finally {
              try {
                bmp.close();
              } catch (e) {}
            }
          }
        } catch (e) {}
      }

      if (b64) {
        parts.push({ inline_data: { mime_type: "image/jpeg", data: b64 } });
      }
    }

    const buildUrl = (m) =>
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(m) +
      ":generateContent?key=" +
      encodeURIComponent(apiKey.trim());

    const tpl = getPromptConfig(lang);
    const sysInst = tpl.system ? { parts: [{ text: tpl.system }] } : undefined;

    const reqInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        ...(sysInst ? { system_instruction: sysInst } : {}),
        generationConfig: { temperature: 0.2, maxOutputTokens: 500 }
      })
    };

    try {
      let activeModel = model;
      let resp = null;
      let retries429 = 0;
      const maxRetries429 = Array.isArray(retryDelaysMs) && retryDelaysMs.length > 0
        ? retryDelaysMs.length
        : DEFAULT_429_BACKOFF_MS.length;

      for (let attempt = 0; attempt <= maxRetries429; attempt++) {
        resp = await fetch(buildUrl(activeModel), reqInit);
        if (resp.status === 404 && activeModel === "gemini-3.1-flash-lite") {
          activeModel = "gemini-3.1-flash-lite-preview";
          resp = await fetch(buildUrl(activeModel), reqInit);
        }
        if (resp.status === 429 && attempt < maxRetries429) {
          retries429++;
          const waitMs = resolve429RetryDelayMs(resp, attempt, retryDelaysMs);
          if (typeof onRetry === "function") {
            try {
              onRetry(retries429, waitMs);
            } catch (e) {}
          }
          await sleepMs(waitMs);
          continue;
        }
        break;
      }

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        return {
          error: "gemini_api_error_" + resp.status + ": " + errText.slice(0, 150),
          retries429
        };
      }
      const data = await resp.json();
      const candParts = data?.candidates?.[0]?.content?.parts;
      let text = null;
      if (Array.isArray(candParts)) {
        const nonThought = candParts.filter(
          (p) => p && !p.thought && typeof p.text === "string" && p.text.trim().length > 0
        );
        if (nonThought.length > 0) {
          text = nonThought.map((p) => p.text.trim()).join(" ");
        } else {
          const anyText = candParts.find((p) => p && typeof p.text === "string" && p.text.trim().length > 0);
          if (anyText) text = anyText.text.trim();
        }
      }
      return typeof text === "string" && text.trim().length > 0
        ? { text: text.trim(), retries429 }
        : { error: "empty_gemini_reply", retries429 };
    } catch (e) {
      return { error: "gemini_fetch_failed: " + String(e?.message || e) };
    }
  }

  async function ensureNanoInjected() {
    if (typeof location !== "undefined" && nanoInjectedOrigin === location.origin) return true;
    try {
      const res = await window.WPhotoDomCaption.sendToBackground({ type: "BATCH_NANO_INJECT" });
      if (res?.ok) {
        if (typeof location !== "undefined") nanoInjectedOrigin = location.origin;
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  async function sendNanoMessage(payload, timeoutMs, onProgress) {
    if (!(await ensureNanoInjected())) return null;
    const id = `n${++nanoMsgSeq}_${Date.now()}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", listener);
        resolve(null);
      }, timeoutMs);

      function listener(event) {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.ns !== "wphotoNanoReply" || data.id !== id) return;
        if (typeof data.progressPct === "number") {
          onProgress?.(data.progressPct);
          return;
        }
        clearTimeout(timer);
        window.removeEventListener("message", listener);
        resolve(data);
      }

      window.addEventListener("message", listener);
      window.postMessage({ ns: "wphotoNano", id, ...payload }, window.location.origin);
    });
  }

  async function probeNanoAvailability() {
    const res = await sendNanoMessage({ op: "probe" }, 3000);
    const status = res?.status;
    return status === "available" || status === "downloadable" || status === "downloading"
      ? status
      : "unavailable";
  }

  async function downloadNanoModel(onProgress) {
    const res = await sendNanoMessage({ op: "download" }, 300000, onProgress);
    return res?.status === "available" ? "available" : "unavailable";
  }

  function findMainPhotoImage() {
    if (typeof document === "undefined") return null;
    const imgs = Array.from(document.querySelectorAll("img"))
      .filter((el) => {
        if (el.naturalWidth <= 200) return false;
        if (typeof el.checkVisibility === "function") {
          return el.checkVisibility({
            visibilityProperty: true,
            opacityProperty: true,
            contentVisibilityAuto: true
          });
        }
        return el.offsetParent !== null;
      })
      .sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight);
    return imgs[0]?.src ?? null;
  }

  async function runAiDescription(options = {}) {
    const dom = window.WPhotoDomCaption;
    const t0 = performance.now();
    const timing = {
      panelOpenMs: -1,
      textareaVisibleMs: -1,
      focusToInsertMs: -1,
      blurToSettleMs: -1,
      totalMs: -1,
      retried: false,
      metadataMs: -1,
      generateMs: -1,
      peopleCount: 0,
      hadLocation: false,
      usedAi: false
    };

    const getPhotoId = () =>
      options.photoId ||
      (typeof location !== "undefined" && location.pathname.match(/\/photo\/([^/?#]+)/)?.[1]) ||
      "unknown";

    const logStep = (step, details) => {
      if (!options.verbose) return;
      const elapsed = Math.round(performance.now() - t0);
      appendAiDescLog(
        `photo: ${getPhotoId()} | +${elapsed}ms | [${step}]${details ? " | " + details : ""}`
      );
    };

    let finalCaption = null;
    const logFinal = (success, err, det) => {
      if (!options.verbose) return;
      const mName = options.model || "cloud";
      const resStr = success
        ? finalCaption
          ? `"${finalCaption}"`
          : "SUCCESS"
        : err
        ? err + (det ? ` (${det})` : "")
        : "failed";
      appendAiDescLog(
        `photo: ${getPhotoId()} | model: ${mName} | ${
          success ? "response: " : "error: "
        }${resStr} | timing: panelOpen=${timing.panelOpenMs}ms metadata=${timing.metadataMs}ms generate=${timing.generateMs}ms focusInsert=${timing.focusToInsertMs}ms total=${Math.round(
          performance.now() - t0
        )}ms`
      );
    };

    const finish = (success, error, errorDetail) => {
      logFinal(success, error, errorDetail);
      timing.totalMs = Math.round(performance.now() - t0);
      return { success, error, errorDetail, timing };
    };

    if (typeof document !== "undefined" && document.querySelector("video")) {
      return finish(false, "skipped_video", "video items are not supported");
    }

    logStep("panel_open_start");
    const panelStart = performance.now();
    const panelRes = await dom.ensureInfoPanelOpen();
    if (!panelRes.ok) {
      logStep("panel_open_failed", `${panelRes.error} (${panelRes.detail})`);
      return finish(false, panelRes.error, panelRes.detail);
    }
    timing.panelOpenMs = Math.round(performance.now() - panelStart);
    logStep("panel_open_success", `${timing.panelOpenMs}ms`);

    const shouldOverwrite = options.overwrite === true || options.overwrite === "yes";
    if (!shouldOverwrite) {
      let ta = dom.findVisibleDescriptionTextarea();
      if (!ta) {
        const wStart = performance.now();
        while (!ta && performance.now() - wStart < 1500) {
          await dom.sleep(150);
          ta = dom.findVisibleDescriptionTextarea();
        }
      }
      if (ta && typeof ta.value === "string" && ta.value.trim().length > 0) {
        return finish(false, "skipped_existing_description", "existing description preserved");
      }
    }

    logStep("metadata_fetch_start");
    const metaStart = performance.now();
    const metadata = await dom.extractMetadataWithStabilization();
    timing.metadataMs = Math.round(performance.now() - metaStart);
    timing.peopleCount = metadata.people.length;
    timing.hadLocation = metadata.location !== null;
    logStep(
      "metadata_fetch_done",
      `${timing.metadataMs}ms (people=${timing.peopleCount}, location=${timing.hadLocation})`
    );

    if (!shouldOverwrite) {
      const ta = dom.findVisibleDescriptionTextarea();
      if (ta && typeof ta.value === "string" && ta.value.trim().length > 0) {
        return finish(false, "skipped_existing_description", "existing description preserved");
      }
    }

    let photoImg = findMainPhotoImage();
    const imgWaitStart = performance.now();
    while (!photoImg && performance.now() - imgWaitStart < 5000) {
      await dom.sleep(150);
      photoImg = findMainPhotoImage();
    }
    logStep("image_found", photoImg ? "ready" : "not_found");

    const lang = options.lang || "en";
    const rulesText = buildRules(metadata, lang);
    const instrText = buildInstruction(metadata, lang);

    const genStart = performance.now();
    let genErrorDetail = null;

    if (options.model === "cloud") {
      let apiKeyVal = null;
      try {
        const stored = await chrome.storage.local.get("geminiApiKey");
        apiKeyVal = stored?.geminiApiKey;
      } catch (e) {}

      if (!apiKeyVal || typeof apiKeyVal !== "string" || !apiKeyVal.trim()) {
        genErrorDetail = "missing_gemini_api_key: Please configure your Google AI Studio API key";
      } else {
        const cloudRes = await callGeminiCloud({
          apiKey: apiKeyVal.trim(),
          model: "gemini-3.1-flash-lite",
          rules: rulesText,
          instruction: instrText,
          imgSrc: photoImg,
          lang,
          onRetry: (attempt, waitMs) => {
            logStep("cloud_retry_429", `attempt=${attempt} wait=${waitMs}ms`);
          }
        });
        if (cloudRes && !cloudRes.error && typeof cloudRes.text === "string") {
          const cleaned = cleanGeneratedCaption(cloudRes.text);
          if (cleaned.length > 0) {
            finalCaption = cleaned;
            timing.usedAi = true;
          } else {
            genErrorDetail = "cloud model returned empty caption";
          }
        } else {
          genErrorDetail = cloudRes ? cloudRes.error ?? "empty reply" : "cloud api error";
        }
      }
      timing.generateMs = Math.round(performance.now() - genStart);
      if (!finalCaption) {
        return finish(false, "skipped_cloud_error", genErrorDetail || "cloud model failed");
      }
    } else {
      const avail = await probeNanoAvailability();
      if (avail === "available" && photoImg) {
        const nanoRes = await sendNanoMessage(
          { op: "generate", imgSrc: photoImg, rules: rulesText, instruction: instrText },
          GENERATE_TIMEOUT_MS + 15000
        );
        if (nanoRes && !nanoRes.error && typeof nanoRes.text === "string") {
          const cleaned = cleanGeneratedCaption(nanoRes.text);
          if (cleaned.length > 0) {
            finalCaption = cleaned;
            timing.usedAi = true;
          } else {
            genErrorDetail = "local model returned empty caption";
          }
        } else {
          genErrorDetail = nanoRes ? nanoRes.error ?? "empty reply" : "bridge timeout";
        }
      }
      timing.generateMs = Math.round(performance.now() - genStart);
      if (finalCaption === null) {
        finalCaption = composeMetadataCaption(metadata, lang);
        if (finalCaption === null) {
          return finish(false, "skipped_no_metadata", genErrorDetail || "no metadata for fallback");
        }
      }
    }

    if (!shouldOverwrite) {
      const ta = dom.findVisibleDescriptionTextarea();
      if (ta && typeof ta.value === "string" && ta.value.trim().length > 0) {
        return finish(false, "skipped_existing_description", "existing description preserved");
      }
    }

    const capRes = await dom.runCaption({
      text: finalCaption,
      overwrite: shouldOverwrite
    });
    if (!capRes.success) {
      return finish(false, capRes.error, capRes.errorDetail);
    }

    // Photo stack propagation: apply the same description to all other photos in the stack
    const extraStackPhotoIds = [];
    try {
      const findStackThumbs = () => {
        if (typeof document === "undefined") return [];
        const candidates = Array.from(
          document.querySelectorAll(
            'button[aria-label*="Photo "], button[aria-label*="photo "], [role="button"][data-stack-item], button[data-photo-id], [role="listitem"] button'
          )
        );
        let thumbs = candidates.filter(
          (el) => el.offsetParent !== null && el.querySelector("img") && el.getBoundingClientRect().height < 160
        );
        if (thumbs.length === 0) {
          const strip = document.querySelector(
            '[role="region"][aria-label*="Photos in stack"], [aria-label*="stack" i], [jsname="bCqjTe"], [data-filmstrip]'
          );
          if (strip) {
            thumbs = Array.from(strip.querySelectorAll('button, [role="button"]')).filter(
              (el) => el.offsetParent !== null && el.querySelector("img")
            );
          }
        }
        return thumbs;
      };

      const stackThumbs = findStackThumbs();
      if (stackThumbs.length > 1) {
        for (let idx = 0; idx < stackThumbs.length; idx++) {
          const curThumbs = findStackThumbs();
          const targetThumb =
            curThumbs[idx] ||
            curThumbs.find((t) => t.getAttribute("aria-label") === stackThumbs[idx].getAttribute("aria-label"));
          if (!targetThumb) continue;
          const isSelected =
            targetThumb.getAttribute("aria-selected") === "true" ||
            targetThumb.getAttribute("aria-current") === "true";
          if (isSelected) continue;
          targetThumb.click();
          await dom.sleep(300);
          const subPhotoId =
            (typeof location !== "undefined" && location.pathname.match(/\/photo\/([^/?#]+)/)?.[1]) || null;
          if (subPhotoId && subPhotoId !== options.photoId && !extraStackPhotoIds.includes(subPhotoId)) {
            extraStackPhotoIds.push(subPhotoId);
          }
          await dom.ensureInfoPanelOpen();
          const subTa = dom.findVisibleDescriptionTextarea();
          const hasExisting = subTa && typeof subTa.value === "string" && subTa.value.trim().length > 0;
          if (shouldOverwrite || !hasExisting) {
            await dom.runCaption({
              text: finalCaption,
              overwrite: shouldOverwrite
            });
          }
          await dom.sleep(200);
        }
      }
    } catch (e) {}

    timing.textareaVisibleMs = capRes.timing.textareaVisibleMs;
    timing.focusToInsertMs = capRes.timing.focusToInsertMs;
    timing.blurToSettleMs = capRes.timing.blurToSettleMs;
    timing.retried = capRes.timing.retried;

    return finish(
      true,
      undefined,
      extraStackPhotoIds.length > 0 ? JSON.stringify({ extraCompletedIds: extraStackPhotoIds }) : undefined
    );
  }

  window.WPhotoAiEngine = {
    getPromptConfig,
    extractFirstNames,
    joinNamesList,
    buildRules,
    buildInstruction,
    composeMetadataCaption,
    cleanGeneratedCaption,
    callGeminiCloud,
    probeNanoAvailability,
    downloadNanoModel,
    runAiDescription,
    clearAiDescLog,
    getAiDescLog,
    appendAiDescLog
  };
})();
