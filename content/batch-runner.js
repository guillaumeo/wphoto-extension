// Batch Runner State Machine for Google Photos AI Description Extension
// Persists batch state across full page navigations (/photo/<id>), handles 900ms post-navigation settle,
// 1x transient DOM retry, photo stack completion propagation, and Pause / Resume / Cancel controls.

(function () {
  const PHOTO_WALL_CLOCK_TIMEOUT_MS = 60000;
  const POST_NAV_SETTLE_MS = 1100;
  const TRANSIENT_RETRY_ERRORS = new Set([
    "textarea_not_visible",
    "caption_focus_failed",
    "url_drifted_mid_run",
    "not_on_photo_url",
    "info_panel_did_not_open"
  ]);
  const SKIP_ERROR_CODES = new Set([
    "skipped_video",
    "skipped_existing_description",
    "skipped_cloud_error",
    "skipped_no_metadata"
  ]);

  let isEngineNavigating = false;
  let isBatchRunningInMemory = false;
  const stateListeners = new Set();

  function notifyStateListeners(batch) {
    for (const fn of stateListeners) {
      try {
        fn(batch);
      } catch (e) {}
    }
  }

  async function loadActiveBatch() {
    try {
      const { activeBatch } = await chrome.storage.local.get("activeBatch");
      if (!activeBatch) return null;
      activeBatch.retryPhotoIds = activeBatch.retryPhotoIds || {};
      activeBatch.failureReasons = activeBatch.failureReasons || {};
      isBatchRunningInMemory = activeBatch.completedAt === null && activeBatch.lastReason === null;
      return activeBatch;
    } catch (e) {
      return null;
    }
  }

  async function saveActiveBatch(batch) {
    try {
      await chrome.storage.local.set({ activeBatch: batch });
      isBatchRunningInMemory = batch && batch.completedAt === null && batch.lastReason === null;
      notifyStateListeners(batch);
    } catch (e) {}
  }

  async function clearActiveBatch() {
    try {
      await chrome.storage.local.remove("activeBatch");
      isBatchRunningInMemory = false;
      notifyStateListeners(null);
    } catch (e) {}
  }

  function getProcessedCount(batch) {
    if (!batch || !Array.isArray(batch.photoIds)) return 0;
    const doneSet = new Set([
      ...(batch.completedIds || []),
      ...(batch.failedIds || []),
      ...(batch.skippedIds || [])
    ]);
    return batch.photoIds.filter((id) => doneSet.has(id)).length;
  }

  function navigateToPhoto(photoId) {
    const targetUrl = window.WPhotoSelection.buildPhotoUrl(location.pathname, photoId);
    try {
      if (typeof window.__batchAppendLog === "function") {
        window.__batchAppendLog(
          `[nav] page transition \u2192 target=${photoId} href=${targetUrl} (from=${location.pathname})`
        );
      }
    } catch (e) {}
    isEngineNavigating = true;
    if (location.href === targetUrl) {
      location.reload();
      return;
    }
    location.href = targetUrl;
  }

  function navigateToOrigin(originUrl) {
    if (originUrl && location.href !== originUrl) {
      isEngineNavigating = true;
      location.href = originUrl;
    }
  }

  async function processCurrentPhotoStep(batch, { skipSettle = false } = {}) {
    const dom = window.WPhotoDomCaption;
    const ai = window.WPhotoAiEngine;
    const idx = getProcessedCount(batch);
    if (idx >= batch.photoIds.length) {
      batch.completedAt = Date.now();
      await saveActiveBatch(batch);
      await dom.sendToBackground({ type: "BATCH_DETACH" });
      navigateToOrigin(batch.originUrl);
      return;
    }

    const photoId = batch.photoIds[idx];
    try {
      if (typeof window.__batchAppendLog === "function") {
        window.__batchAppendLog(
          `[batch:enter] photo=${idx + 1}/${batch.photoIds.length} id=${photoId} url=${location.pathname}`
        );
      }
    } catch (e) {}

    if (!skipSettle) {
      await dom.sleep(POST_NAV_SETTLE_MS);
      const latest = await loadActiveBatch();
      if (!latest || latest.completedAt !== null || latest.lastReason !== null) {
        return;
      }
      batch = latest;
    }

    const attachRes = await dom.sendToBackground({ type: "BATCH_ATTACH" });
    if (!attachRes.ok) {
      batch.failedIds = [...batch.failedIds, photoId];
      batch.completedAt = Date.now();
      batch.lastReason = "dom_abort";
      await saveActiveBatch(batch);
      await dom.sendToBackground({ type: "BATCH_DETACH" });
      return;
    }

    const timeoutToken = Symbol("photo_timeout");
    const runPromise = ai.runAiDescription({
      ...batch.options,
      photoId
    });
    const outcome = await Promise.race([
      runPromise,
      new Promise((resolve) => setTimeout(() => resolve(timeoutToken), PHOTO_WALL_CLOCK_TIMEOUT_MS))
    ]);

    const result =
      outcome === timeoutToken
        ? { success: false, error: "photo_timeout", timing: {} }
        : outcome;

    // 1x transient error retry via page reload
    if (
      !result.success &&
      result.error &&
      TRANSIENT_RETRY_ERRORS.has(result.error) &&
      (batch.retryPhotoIds[photoId] ?? 0) < 1
    ) {
      const updated = {
        ...batch,
        retriedTotal: (batch.retriedTotal ?? 0) + 1,
        retryPhotoIds: {
          ...batch.retryPhotoIds,
          [photoId]: (batch.retryPhotoIds[photoId] ?? 0) + 1
        }
      };
      await saveActiveBatch(updated);
      navigateToPhoto(photoId);
      return;
    }

    const latestBatch = await loadActiveBatch();
    if (!latestBatch || latestBatch.lastReason !== null || latestBatch.completedAt !== null) {
      return;
    }

    const isSkipped = !result.success && result.error && SKIP_ERROR_CODES.has(result.error);
    const failureReasons = { ...(latestBatch.failureReasons || {}) };
    if (!result.success && !isSkipped) {
      failureReasons[photoId] = result.error || "unexpected";
    }

    let extraCompleted = [];
    try {
      if (
        result.success &&
        typeof result.errorDetail === "string" &&
        result.errorDetail.startsWith("{")
      ) {
        const parsed = JSON.parse(result.errorDetail);
        if (Array.isArray(parsed.extraCompletedIds)) {
          extraCompleted = parsed.extraCompletedIds.filter(
            (id) => !latestBatch.completedIds.includes(id) && id !== photoId
          );
        }
      }
    } catch (e) {}

    const nextBatch = {
      ...latestBatch,
      completedIds: result.success
        ? [...latestBatch.completedIds, photoId, ...extraCompleted]
        : latestBatch.completedIds,
      skippedIds: isSkipped ? [...latestBatch.skippedIds, photoId] : latestBatch.skippedIds,
      failedIds:
        result.success || isSkipped ? latestBatch.failedIds : [...latestBatch.failedIds, photoId],
      failureReasons
    };

    const nextIdx = getProcessedCount(nextBatch);
    if (nextIdx >= nextBatch.photoIds.length) {
      nextBatch.completedAt = Date.now();
      await saveActiveBatch(nextBatch);
      await dom.sendToBackground({ type: "BATCH_DETACH" });
      navigateToOrigin(nextBatch.originUrl);
      return;
    }

    await saveActiveBatch(nextBatch);
    navigateToPhoto(nextBatch.photoIds[nextIdx]);
  }

  async function kickOffBatch({ photoIds, options = {}, originUrl, skippedIds = [] }) {
    if (!Array.isArray(photoIds) || photoIds.length === 0) {
      return { started: false, error: "no_photo_ids" };
    }

    if (options.verbose) {
      await window.WPhotoAiEngine.clearAiDescLog();
    }

    const attachRes = await window.WPhotoDomCaption.sendToBackground({ type: "BATCH_ATTACH" });
    const batch = {
      action: "aiDescription",
      options: {
        lang: options.lang || "en",
        model: options.model || "cloud",
        overwrite: options.overwrite === true || options.overwrite === "yes",
        verbose: options.verbose === true
      },
      photoIds: [...photoIds],
      completedIds: [],
      failedIds: [],
      skippedIds: [...skippedIds],
      failureReasons: {},
      retryPhotoIds: {},
      retriedTotal: 0,
      startedAt: Date.now(),
      completedAt: null,
      lastReason: null,
      originUrl: originUrl || location.href
    };

    if (!attachRes.ok) {
      await saveActiveBatch({
        ...batch,
        completedAt: Date.now(),
        lastReason: "dom_abort"
      });
      return { started: false, error: attachRes.error || "attach_failed" };
    }

    await saveActiveBatch(batch);
    const firstId = photoIds[0];
    const currentViewerId = window.WPhotoSelection.parsePhotoIdFromPath();
    if (currentViewerId === firstId) {
      await processCurrentPhotoStep(batch, { skipSettle: true });
      return { started: true };
    }

    navigateToPhoto(firstId);
    return { started: true };
  }

  async function continueBatchIfActive() {
    const batch = await loadActiveBatch();
    if (!batch || batch.completedAt !== null || batch.lastReason !== null) return;

    const currentViewerId = window.WPhotoSelection.parsePhotoIdFromPath();
    if (!currentViewerId) return;

    const idx = getProcessedCount(batch);
    if (idx >= batch.photoIds.length) {
      batch.completedAt = Date.now();
      await saveActiveBatch(batch);
      await window.WPhotoDomCaption.sendToBackground({ type: "BATCH_DETACH" });
      navigateToOrigin(batch.originUrl);
      return;
    }

    if (batch.photoIds[idx] !== currentViewerId) return;
    await processCurrentPhotoStep(batch);
  }

  async function pauseBatch() {
    const batch = await loadActiveBatch();
    if (batch && batch.completedAt === null) {
      batch.lastReason = "paused";
      batch.completedAt = Date.now();
      await saveActiveBatch(batch);
      await window.WPhotoDomCaption.sendToBackground({ type: "BATCH_DETACH" });
    }
  }

  async function cancelBatch() {
    const batch = await loadActiveBatch();
    if (batch && batch.completedAt === null) {
      batch.lastReason = "cancelled";
      batch.completedAt = Date.now();
      await saveActiveBatch(batch);
      await window.WPhotoDomCaption.sendToBackground({ type: "BATCH_DETACH" });
    }
  }

  async function resumeBatch() {
    const batch = await loadActiveBatch();
    if (!batch || (batch.completedAt === null && batch.lastReason === null)) return;

    const idx = getProcessedCount(batch);
    if (idx >= batch.photoIds.length) {
      batch.lastReason = null;
      batch.completedAt = Date.now();
      await saveActiveBatch(batch);
      await window.WPhotoDomCaption.sendToBackground({ type: "BATCH_DETACH" });
      navigateToOrigin(batch.originUrl);
      return;
    }

    batch.lastReason = null;
    batch.completedAt = null;
    await saveActiveBatch(batch);
    await window.WPhotoDomCaption.sendToBackground({ type: "BATCH_ATTACH" });

    const targetId = batch.photoIds[idx];
    const currentViewerId = window.WPhotoSelection.parsePhotoIdFromPath();
    if (currentViewerId === targetId) {
      await processCurrentPhotoStep(batch, { skipSettle: true });
    } else {
      navigateToPhoto(targetId);
    }
  }

  // Register unexpected debugger detach listener & storage listener
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === "BATCH_UNEXPECTED_DETACH") {
        (async () => {
          const batch = await loadActiveBatch();
          if (batch && batch.completedAt === null && batch.lastReason === null) {
            batch.lastReason = "paused";
            batch.completedAt = Date.now();
            await saveActiveBatch(batch);
          }
        })();
      }
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.activeBatch) {
        notifyStateListeners(changes.activeBatch.newValue || null);
      }
    });

    window.addEventListener("beforeunload", (e) => {
      if (!isEngineNavigating && isBatchRunningInMemory) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  } catch (e) {}

  window.WPhotoBatchRunner = {
    loadActiveBatch,
    saveActiveBatch,
    clearActiveBatch,
    getProcessedCount,
    kickOffBatch,
    continueBatchIfActive,
    pauseBatch,
    resumeBatch,
    cancelBatch,
    onStateChange(fn) {
      stateListeners.add(fn);
      return () => stateListeners.delete(fn);
    }
  };
})();
