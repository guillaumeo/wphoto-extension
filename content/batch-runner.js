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
    "skipped_no_metadata",
    "skipped_unowned",
    "skipped_not_found"
  ]);

  let isEngineNavigating = false;
  let isBatchRunningInMemory = false;
  let activeRunGeneration = 0;
  let isBatchAborted = false;
  const stateListeners = new Set();

  function abortInFlightWork() {
    isBatchAborted = true;
    isBatchRunningInMemory = false;
    activeRunGeneration++;
    try {
      if (typeof window !== "undefined" && window.__wphotoActiveAbortController) {
        window.__wphotoActiveAbortController.abort();
        window.__wphotoActiveAbortController = null;
      }
    } catch (e) {}
  }

  function resetAbortStateForNewRun() {
    isBatchAborted = false;
    activeRunGeneration++;
  }

  if (typeof window !== "undefined") {
    window.__wphotoIsBatchAborted = () => isBatchAborted;
  }

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
      activeBatch.prefilledCaptions = activeBatch.prefilledCaptions || {};
      activeBatch.stackFallbackIds = activeBatch.stackFallbackIds || {};
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
    abortInFlightWork();
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
    const myGen = activeRunGeneration;
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
    }

    if (myGen !== activeRunGeneration || isBatchAborted) return;
    const preAttachBatch = await loadActiveBatch();
    if (!preAttachBatch || preAttachBatch.completedAt !== null || preAttachBatch.lastReason !== null) {
      return;
    }
    batch = preAttachBatch;

    const attachRes = await dom.sendToBackground({ type: "BATCH_ATTACH", forPhotoStep: true });
    if (myGen !== activeRunGeneration || isBatchAborted) return;
    if (!attachRes.ok) {
      const latestAfterAttach = await loadActiveBatch();
      if (!latestAfterAttach || latestAfterAttach.completedAt !== null || latestAfterAttach.lastReason !== null) {
        return;
      }
      if (attachRes.error === "batch_not_active" || attachRes.error === "detached_by_user") {
        batch.completedAt = Date.now();
        batch.lastReason = "cancelled";
      } else {
        batch.failedIds = [...batch.failedIds, photoId];
        batch.completedAt = Date.now();
        batch.lastReason = "dom_abort";
      }
      await saveActiveBatch(batch);
      await dom.sendToBackground({ type: "BATCH_DETACH" });
      return;
    }

    const timeoutToken = Symbol("photo_timeout");
    const prefilledCaption =
      batch.prefilledCaptions && typeof batch.prefilledCaptions[photoId] === "string"
        ? batch.prefilledCaptions[photoId]
        : null;
    const runPromise = ai.runAiDescription({
      ...batch.options,
      photoId,
      prefilledCaption,
      alreadyCompletedIds: batch.completedIds || []
    });
    const outcome = await Promise.race([
      runPromise,
      new Promise((resolve) => setTimeout(() => resolve(timeoutToken), PHOTO_WALL_CLOCK_TIMEOUT_MS))
    ]);

    if (myGen !== activeRunGeneration || isBatchAborted) {
      return;
    }

    const latestBatch = await loadActiveBatch();
    if (!latestBatch || latestBatch.lastReason !== null || latestBatch.completedAt !== null) {
      return;
    }

    const result =
      outcome === timeoutToken
        ? { success: false, error: "photo_timeout", timing: {} }
        : outcome;

    if (result.error === "batch_aborted") {
      return;
    }

    // 1x transient error retry via page reload
    if (
      !result.success &&
      result.error &&
      TRANSIENT_RETRY_ERRORS.has(result.error) &&
      (latestBatch.retryPhotoIds[photoId] ?? 0) < 1
    ) {
      const updated = {
        ...latestBatch,
        retriedTotal: (latestBatch.retriedTotal ?? 0) + 1,
        retryPhotoIds: {
          ...latestBatch.retryPhotoIds,
          [photoId]: (latestBatch.retryPhotoIds[photoId] ?? 0) + 1
        }
      };
      await saveActiveBatch(updated);
      navigateToPhoto(photoId);
      return;
    }

    const isSkipped = !result.success && result.error && SKIP_ERROR_CODES.has(result.error);
    const failureReasons = { ...(latestBatch.failureReasons || {}) };
    if (!result.success && !isSkipped) {
      failureReasons[photoId] = result.error || "unexpected";
    }

    let extraCompleted = [];
    let pendingStackIds = [];
    let sharedCaption = null;
    let actualCaptionedIds = [];
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
        if (Array.isArray(parsed.pendingStackIds)) {
          pendingStackIds = parsed.pendingStackIds.filter(
            (id) => typeof id === "string" && id.length > 0 && !latestBatch.completedIds.includes(id)
          );
        }
        if (typeof parsed.sharedCaption === "string" && parsed.sharedCaption.trim().length > 0) {
          sharedCaption = parsed.sharedCaption.trim();
        }
        if (Array.isArray(parsed.captionedIds)) {
          actualCaptionedIds = parsed.captionedIds.filter(
            (id) => typeof id === "string" && id.length > 0
          );
        }
      }
    } catch (e) {}

    const nextPrefilledCaptions = { ...(latestBatch.prefilledCaptions || {}) };
    const nextStackFallbackIds = { ...(latestBatch.stackFallbackIds || {}) };
    let nextPhotoIds = [...latestBatch.photoIds];

    if (sharedCaption) {
      for (const pid of pendingStackIds) {
        nextPrefilledCaptions[pid] = sharedCaption;
        if (
          pid !== photoId &&
          !nextPhotoIds.includes(pid) &&
          !latestBatch.completedIds.includes(pid) &&
          !extraCompleted.includes(pid)
        ) {
          const curIdx = nextPhotoIds.indexOf(photoId);
          if (curIdx >= 0) {
            nextPhotoIds.splice(curIdx + 1, 0, pid);
          } else {
            nextPhotoIds.push(pid);
          }
        }
      }
    }

    let stepCompletedIds = [];
    if (result.success) {
      const photoIdStillPending =
        pendingStackIds.includes(photoId) &&
        actualCaptionedIds.length > 0 &&
        !actualCaptionedIds.includes(photoId) &&
        !nextStackFallbackIds[photoId];

      if (photoIdStillPending && sharedCaption) {
        nextStackFallbackIds[photoId] = 1;
        nextPrefilledCaptions[photoId] = sharedCaption;
        for (const cid of actualCaptionedIds) {
          if (!latestBatch.completedIds.includes(cid)) {
            stepCompletedIds.push(cid);
          }
          if (!nextPhotoIds.includes(cid)) {
            const curIdx = nextPhotoIds.indexOf(photoId);
            if (curIdx >= 0) {
              nextPhotoIds.splice(curIdx, 0, cid);
            } else {
              nextPhotoIds.push(cid);
            }
          }
        }
      } else {
        stepCompletedIds = [photoId, ...extraCompleted];
      }
    }

    const nextBatch = {
      ...latestBatch,
      photoIds: nextPhotoIds,
      prefilledCaptions: nextPrefilledCaptions,
      stackFallbackIds: nextStackFallbackIds,
      completedIds: result.success
        ? Array.from(new Set([...latestBatch.completedIds, ...stepCompletedIds]))
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

    resetAbortStateForNewRun();

    if (options.verbose) {
      await window.WPhotoAiEngine.clearAiDescLog();
    }

    const attachRes = await window.WPhotoDomCaption.sendToBackground({
      type: "BATCH_ATTACH",
      explicitStart: true
    });
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
    isBatchAborted = false;
    await processCurrentPhotoStep(batch);
  }

  async function pauseBatch() {
    abortInFlightWork();
    const batch = await loadActiveBatch();
    if (batch && batch.completedAt === null) {
      batch.lastReason = "paused";
      batch.completedAt = Date.now();
      await saveActiveBatch(batch);
      await window.WPhotoDomCaption.sendToBackground({ type: "BATCH_DETACH" });
    }
  }

  async function cancelBatch() {
    abortInFlightWork();
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

    resetAbortStateForNewRun();
    batch.lastReason = null;
    batch.completedAt = null;
    await saveActiveBatch(batch);
    const attachRes = await window.WPhotoDomCaption.sendToBackground({
      type: "BATCH_ATTACH",
      explicitStart: true
    });
    if (!attachRes.ok) {
      batch.lastReason = "dom_abort";
      batch.completedAt = Date.now();
      await saveActiveBatch(batch);
      return;
    }

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
        abortInFlightWork();
        (async () => {
          const batch = await loadActiveBatch();
          if (batch && (batch.completedAt === null || batch.lastReason === null)) {
            batch.lastReason = "cancelled";
            batch.completedAt = batch.completedAt || Date.now();
            await saveActiveBatch(batch);
          } else if (batch) {
            notifyStateListeners(batch);
          }
        })();
      }
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.activeBatch) {
        const nextVal = changes.activeBatch.newValue || null;
        if (!nextVal || nextVal.completedAt !== null || nextVal.lastReason !== null) {
          abortInFlightWork();
        }
        notifyStateListeners(nextVal);
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
