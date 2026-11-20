// Background Service Worker for Google Photos AI Description Extension
// Handles Chrome Debugger Protocol (CDP) trusted input, Network save quiescence, and Local Gemini Nano bridge injection.

let attachedTabId = null;
let userDetachedTabId = null;
let attachInFlight = null;
const inFlightRequests = new Map();
const ignoredTelemetryIds = new Set();
const recentSaveTimestamps = [];
let lastNetworkActivityAt = null;
let pendingQuiescenceWait = null;

const VISIBILITY_OVERRIDE_SCRIPT = `
  try {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  } catch (e) {}
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sendDebuggerCommand(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(result);
    });
  });
}

function detachTab(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.debugger.detach({ tabId }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch (e) {
      resolve();
    }
  });
}

function resolveQuiescenceWait(reason) {
  if (!pendingQuiescenceWait) return;
  const wait = pendingQuiescenceWait;
  pendingQuiescenceWait = null;
  clearTimeout(wait.ceilingTimer);
  if (wait.idleTimer) clearTimeout(wait.idleTimer);
  wait.sendResponse({
    ok: true,
    reason,
    waitMs: Date.now() - wait.startedAt,
    saveXhrsObserved: wait.saveXhrsObserved
  });
}

function resetNetworkState() {
  inFlightRequests.clear();
  ignoredTelemetryIds.clear();
  lastNetworkActivityAt = null;
  resolveQuiescenceWait("ceiling");
}

function checkQuiescenceIdle() {
  if (!pendingQuiescenceWait) return;
  if (pendingQuiescenceWait.idleTimer) {
    clearTimeout(pendingQuiescenceWait.idleTimer);
    pendingQuiescenceWait.idleTimer = null;
  }
  const staleCutoff = Date.now() - 15000;
  for (const [reqId, req] of inFlightRequests) {
    if (req.startedAt < staleCutoff) inFlightRequests.delete(reqId);
  }
  if (inFlightRequests.size > 0) return;

  const baseline = Math.max(lastNetworkActivityAt ?? 0, pendingQuiescenceWait.startedAt);
  const remaining = pendingQuiescenceWait.idleMs - (Date.now() - baseline);
  if (remaining <= 0) {
    resolveQuiescenceWait("idle");
    return;
  }
  pendingQuiescenceWait.idleTimer = setTimeout(checkQuiescenceIdle, remaining);
}

try {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId !== attachedTabId) return;

    if (method === "Page.javascriptDialogOpening") {
      sendDebuggerCommand(source.tabId, "Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
      return;
    }

    if (method.startsWith("Network.") && params) {
      const reqId = params.requestId;
      if (!reqId) return;

      if (method === "Network.requestWillBeSent") {
        const url = params.request?.url ?? "";
        const isGoogleUpload = /\/upload/i.test(url) && url.includes("google");
        if (!url.includes("batchexecute") && !isGoogleUpload) return;

        if (url.includes("rpcids=rJ0tlb")) {
          if (ignoredTelemetryIds.size > 200) ignoredTelemetryIds.clear();
          ignoredTelemetryIds.add(reqId);
          return;
        }

        const now = Date.now();
        inFlightRequests.set(reqId, { url, startedAt: now });
        recentSaveTimestamps.push(now);
        const cutoff = now - 10000;
        while (recentSaveTimestamps.length > 0 && recentSaveTimestamps[0] < cutoff) {
          recentSaveTimestamps.shift();
        }

        lastNetworkActivityAt = now;
        if (pendingQuiescenceWait) pendingQuiescenceWait.saveXhrsObserved++;
        checkQuiescenceIdle();
      } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
        if (ignoredTelemetryIds.delete(reqId) || !inFlightRequests.delete(reqId)) return;
        lastNetworkActivityAt = Date.now();
        checkQuiescenceIdle();
      }
    }
  });

  chrome.debugger.onDetach.addListener((source, reason) => {
    const tabId = source.tabId;
    if (tabId !== undefined && attachedTabId === tabId) {
      attachedTabId = null;
      userDetachedTabId = tabId;
      resetNetworkState();
      try {
        if (chrome.storage?.local) {
          chrome.storage.local.get("activeBatch", (data) => {
            const batch = data?.activeBatch;
            if (batch && batch.completedAt === null && batch.lastReason === null) {
              batch.lastReason = "cancelled";
              batch.completedAt = Date.now();
              chrome.storage.local.set({ activeBatch: batch });
            }
          });
        }
      } catch (e) {}
      chrome.tabs.sendMessage(tabId, {
        type: "BATCH_UNEXPECTED_DETACH",
        reason: String(reason)
      }).catch(() => {});
    }
  });
} catch (err) {
  console.warn("[wphoto] debugger listeners error:", err);
}

async function configureAttachedSession(tabId) {
  try {
    await sendDebuggerCommand(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
  } catch (e) {}
  try {
    await sendDebuggerCommand(tabId, "Page.enable", {});
    await sendDebuggerCommand(tabId, "Page.addScriptToEvaluateOnNewDocument", {
      source: VISIBILITY_OVERRIDE_SCRIPT
    });
  } catch (e) {}
  try {
    await sendDebuggerCommand(tabId, "Runtime.evaluate", { expression: VISIBILITY_OVERRIDE_SCRIPT });
  } catch (e) {}
  try {
    await sendDebuggerCommand(tabId, "Network.enable", {});
  } catch (e) {}
}

function dispatchMouse(tabId, type, x, y, extra = {}) {
  return sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: "none",
    buttons: 0,
    modifiers: 0,
    pointerType: "mouse",
    ...extra
  });
}

async function dispatchTrustedClick(tabId, x, y) {
  await dispatchMouse(tabId, "mouseMoved", 1, 1);
  await dispatchMouse(tabId, "mouseMoved", x, y);
  await sleep(40);
  await dispatchMouse(tabId, "mousePressed", x, y, { button: "left", buttons: 1, clickCount: 1 });
  await sleep(40);
  await dispatchMouse(tabId, "mouseReleased", x, y, { button: "left", buttons: 0, clickCount: 1 });
}

async function dispatchTrustedKey(tabId, { key, code, windowsVirtualKeyCode, commands, modifiers = 0, repeat = 1 }) {
  await dispatchMouse(tabId, "mouseMoved", 1, 1);
  const baseEvent = {
    key,
    code,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
    modifiers,
    ...(Array.isArray(commands) && commands.length > 0 ? { commands } : {})
  };
  const count = Math.max(1, Math.trunc(repeat));
  for (let i = 0; i < count; i++) {
    await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...baseEvent });
    await sleep(25);
    await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...baseEvent });
    if (i < count - 1) await sleep(8);
  }
}

function nanoBridgeMain(config) {
  if (window.__wphotoNanoBridgeInstalled) return;
  window.__wphotoNanoBridgeInstalled = true;

  const LM = globalThis.LanguageModel;
  const expected = { expectedInputs: [{ type: "image" }] };
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const reply = (id, payload) => {
    window.postMessage({ ns: "wphotoNanoReply", id, ...payload }, window.location.origin);
  };

  const computeMeanBrightness = (source) => {
    if (!ctx) return -1;
    ctx.clearRect(0, 0, 64, 64);
    ctx.drawImage(source, 0, 0, 64, 64);
    const data = ctx.getImageData(0, 0, 64, 64).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
    }
    return Math.round(sum / (data.length / 4));
  };

  const loadBitmap = async (imgSrc) => {
    try {
      const resp = await fetch(imgSrc, { credentials: "include" });
      if (resp.ok) {
        const bmp = await createImageBitmap(await resp.blob());
        const brightness = computeMeanBrightness(bmp);
        if (brightness > (config?.minMeanBrightness ?? 2)) {
          return { bitmap: bmp, brightness, path: "fetch" };
        }
        bmp.close();
      }
    } catch (e) {}

    const imgEl = Array.from(document.querySelectorAll("img")).find(
      (el) => el.src === imgSrc && el.naturalWidth > 0
    );
    if (!imgEl) return { error: "image_unavailable" };

    try {
      const bmp = await createImageBitmap(imgEl);
      try {
        if (computeMeanBrightness(bmp) === 0) {
          bmp.close();
          return { error: "black_frame" };
        }
      } catch (e) {}
      return { bitmap: bmp, brightness: -1, path: "element" };
    } catch (e) {
      return { error: "bitmap_failed: " + String(e?.message ?? e) };
    }
  };

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.ns !== "wphotoNano" || typeof data.id !== "string") return;

    if (data.op === "probe") {
      if (!LM) return reply(data.id, { status: "no_api" });
      try {
        reply(data.id, { status: await LM.availability(expected) });
      } catch (e) {
        reply(data.id, { status: "unavailable", error: String(e?.message ?? e) });
      }
    } else if (data.op === "download") {
      if (!LM) return reply(data.id, { status: "no_api" });
      try {
        const session = await LM.create({
          ...expected,
          monitor(m) {
            m.addEventListener("downloadprogress", (ev) => {
              if (typeof ev.loaded === "number") {
                reply(data.id, { progressPct: Math.round(ev.loaded * 100) });
              }
            });
          }
        });
        session.destroy();
        reply(data.id, { status: "available" });
      } catch (e) {
        reply(data.id, { status: "unavailable", error: String(e?.message ?? e) });
      }
    } else if (data.op === "generate") {
      if (!LM) return reply(data.id, { error: "no_api" });
      if (!data.imgSrc || !data.instruction) return reply(data.id, { error: "bad_request" });

      const t0 = performance.now();
      const loaded = await loadBitmap(data.imgSrc);
      if ("error" in loaded) return reply(data.id, { error: loaded.error });

      let session = null;
      let timeoutId = null;
      try {
        session = await LM.create(expected);
        const promptText = `${data.rules ?? ""} ${data.instruction}`.trim();
        const text = await Promise.race([
          session.prompt([
            {
              role: "user",
              content: [
                { type: "image", value: loaded.bitmap },
                { type: "text", value: promptText }
              ]
            }
          ]),
          new Promise((_, rej) => {
            timeoutId = setTimeout(
              () => rej(new Error("generate_timeout")),
              config?.generateTimeoutMs ?? 35000
            );
          })
        ]);
        reply(data.id, { text, ms: Math.round(performance.now() - t0) });
      } catch (e) {
        reply(data.id, { error: "generate_failed: " + String(e?.message ?? e) });
      } finally {
        clearTimeout(timeoutId);
        try { session?.destroy(); } catch (e) {}
        try { loaded.bitmap.close(); } catch (e) {}
      }
    }
  });
}

function normalizeDispatchError(tabId, err, fallback) {
  const msg = err?.message || fallback;
  if (/debugger is not attached/i.test(msg ?? "") && attachedTabId === tabId) {
    attachedTabId = null;
    resetNetworkState();
  }
  return msg;
}

async function handleAttach(tabId, message) {
  while (attachInFlight) {
    try { await attachInFlight; } catch (e) {}
  }
  let releaseAttach;
  attachInFlight = new Promise((r) => { releaseAttach = r; });
  try {
    if (message.explicitStart) {
      userDetachedTabId = null;
    } else if (userDetachedTabId === tabId) {
      return { ok: false, error: "detached_by_user" };
    }
    if (message.forPhotoStep && chrome.storage?.local) {
      try {
        const stored = await chrome.storage.local.get("activeBatch");
        const active = stored?.activeBatch;
        if (!active || active.completedAt !== null || active.lastReason !== null) {
          return { ok: false, error: "batch_not_active" };
        }
      } catch (e) {}
    }
    if (attachedTabId === tabId) {
      try {
        await sendDebuggerCommand(tabId, "Runtime.evaluate", { expression: VISIBILITY_OVERRIDE_SCRIPT });
        return { ok: true, attached: true, tabId };
      } catch (e) {
        attachedTabId = null;
        resetNetworkState();
      }
    }
    if (attachedTabId !== null && attachedTabId !== tabId) {
      await detachTab(attachedTabId);
      attachedTabId = null;
      resetNetworkState();
    }
    try {
      await new Promise((resolve, reject) => {
        chrome.debugger.attach({ tabId }, "1.3", () => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          resolve();
        });
      });
      attachedTabId = tabId;
      await configureAttachedSession(tabId);
      return { ok: true, attached: true, tabId };
    } catch (e) {
      return { ok: false, error: e.message || "attach_failed" };
    }
  } finally {
    attachInFlight = null;
    releaseAttach();
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type ?? "";
  if (!type.startsWith("BATCH_")) return false;

  const tabId = sender.tab?.id;
  if (typeof tabId !== "number") {
    sendResponse({ ok: false, error: "no_tab_id" });
    return false;
  }

  const runAttached = async (fn, fallback) => {
    if (attachedTabId !== tabId) {
      sendResponse({ ok: false, error: "not_attached" });
      return;
    }
    try {
      await fn();
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: normalizeDispatchError(tabId, e, fallback) });
    }
  };

  (async () => {
    switch (type) {
      case "BATCH_ATTACH":
        sendResponse(await handleAttach(tabId, message));
        return;

      case "BATCH_DETACH":
        if (attachedTabId === tabId) {
          resetNetworkState();
          attachedTabId = null;
          await detachTab(tabId);
        }
        sendResponse({ ok: true });
        return;

      case "BATCH_GET_STATUS":
        sendResponse({ ok: true, attached: attachedTabId === tabId, tabId: attachedTabId });
        return;

      case "BATCH_DISPATCH_CLICK_AT":
        return runAttached(() => dispatchTrustedClick(tabId, message.x, message.y), "click_failed");

      case "BATCH_DISPATCH_KEY":
        return runAttached(() => dispatchTrustedKey(tabId, message), "key_dispatch_failed");

      case "BATCH_INSERT_TEXT":
        return runAttached(
          () => sendDebuggerCommand(tabId, "Input.insertText", { text: message.text }),
          "insert_text_failed"
        );

      case "BATCH_AWAIT_SAVE_QUIESCENCE": {
        if (attachedTabId !== tabId) {
          sendResponse({ ok: false, error: "not_attached" });
          return;
        }
        if (pendingQuiescenceWait) resolveQuiescenceWait("superseded");
        const now = Date.now();
        const idleMs = message.idleMs ?? 500;
        const maxWaitMs = message.maxWaitMs ?? 4000;
        const seedRecentMs = message.seedRecentMs ?? 0;
        const seededCount =
          typeof seedRecentMs === "number" && seedRecentMs > 0
            ? recentSaveTimestamps.filter((ts) => ts >= now - Math.min(seedRecentMs, 10000)).length
            : 0;

        pendingQuiescenceWait = {
          sendResponse,
          startedAt: now,
          idleMs,
          saveXhrsObserved: seededCount,
          idleTimer: null,
          ceilingTimer: setTimeout(() => resolveQuiescenceWait("ceiling"), maxWaitMs)
        };
        checkQuiescenceIdle();
        return;
      }

      case "BATCH_NANO_INJECT":
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: nanoBridgeMain,
            args: [{ generateTimeoutMs: 35000, minMeanBrightness: 2 }]
          });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.message || "nano_inject_failed" });
        }
        return;

      default:
        sendResponse({ ok: false, error: "unknown_message_type" });
    }
  })();

  return true;
});
