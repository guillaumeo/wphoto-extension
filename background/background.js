// Background Service Worker for Google Photos AI Description Extension
// Handles Chrome Debugger Protocol (CDP) trusted input, Network save quiescence, and Local Gemini Nano bridge injection.

let attachedTabId = null;
const inFlightRequests = new Map();
const ignoredTelemetryIds = new Set();
const recentSaveTimestamps = [];
let lastNetworkActivityAt = null;
let pendingQuiescenceWait = null;

const VISIBILITY_OVERRIDE_SCRIPT = `
  try {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: function() { return 'visible'; }
    });
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: function() { return false; }
    });
  } catch (e) {}
`;

function sendDebuggerCommand(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      resolve(result);
    });
  });
}

function resetNetworkState() {
  inFlightRequests.clear();
  ignoredTelemetryIds.clear();
  lastNetworkActivityAt = null;
  if (pendingQuiescenceWait) {
    const wait = pendingQuiescenceWait;
    pendingQuiescenceWait = null;
    clearTimeout(wait.ceilingTimer);
    if (wait.idleTimer) clearTimeout(wait.idleTimer);
    wait.sendResponse({
      ok: true,
      reason: "ceiling",
      waitMs: Date.now() - wait.startedAt,
      saveXhrsObserved: wait.saveXhrsObserved
    });
  }
}

function recordNetworkActivity() {
  lastNetworkActivityAt = Date.now();
}

function checkQuiescenceIdle() {
  if (!pendingQuiescenceWait) return;
  if (pendingQuiescenceWait.idleTimer) {
    clearTimeout(pendingQuiescenceWait.idleTimer);
    pendingQuiescenceWait.idleTimer = null;
  }
  if (inFlightRequests.size > 0) return;

  const baseline = Math.max(lastNetworkActivityAt ?? 0, pendingQuiescenceWait.startedAt);
  const elapsed = Date.now() - baseline;
  const remaining = pendingQuiescenceWait.idleMs - elapsed;

  if (remaining <= 0) {
    const wait = pendingQuiescenceWait;
    pendingQuiescenceWait = null;
    clearTimeout(wait.ceilingTimer);
    wait.sendResponse({
      ok: true,
      reason: "idle",
      waitMs: Date.now() - wait.startedAt,
      saveXhrsObserved: wait.saveXhrsObserved
    });
    return;
  }

  pendingQuiescenceWait.idleTimer = setTimeout(() => {
    checkQuiescenceIdle();
  }, remaining);
}

try {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId !== attachedTabId) return;

    if (method === "Page.javascriptDialogOpening") {
      sendDebuggerCommand(source.tabId, "Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
      return;
    }

    if (method.startsWith("Network.") && params) {
      if (method === "Network.requestWillBeSent") {
        const url = params.request?.url ?? "";
        const isGoogleUpload = /\/upload/i.test(url) && url.includes("google");
        if (!url.includes("batchexecute") && !isGoogleUpload) return;

        const reqId = params.requestId;
        if (!reqId) return;
        if (url.includes("rpcids=rJ0tlb")) {
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

        recordNetworkActivity();
        if (pendingQuiescenceWait) {
          pendingQuiescenceWait.saveXhrsObserved++;
        }
        checkQuiescenceIdle();
      } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
        const reqId = params.requestId;
        if (!reqId) return;
        if (ignoredTelemetryIds.has(reqId)) {
          ignoredTelemetryIds.delete(reqId);
          return;
        }
        if (!inFlightRequests.has(reqId)) return;
        inFlightRequests.delete(reqId);
        recordNetworkActivity();
        checkQuiescenceIdle();
      }
    }
  });

  chrome.debugger.onDetach.addListener((source, reason) => {
    const tabId = source.tabId;
    if (tabId !== undefined && attachedTabId === tabId) {
      attachedTabId = null;
      resetNetworkState();
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
    await sendDebuggerCommand(tabId, "Runtime.evaluate", {
      expression: VISIBILITY_OVERRIDE_SCRIPT
    });
  } catch (e) {}
  try {
    await sendDebuggerCommand(tabId, "Network.enable", {});
  } catch (e) {}
}

async function dispatchTrustedClick(tabId, x, y) {
  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 1,
    y: 1,
    button: "none",
    buttons: 0,
    modifiers: 0,
    pointerType: "mouse"
  });
  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    buttons: 0,
    modifiers: 0,
    pointerType: "mouse"
  });
  await new Promise((r) => setTimeout(r, 40));
  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
    modifiers: 0,
    pointerType: "mouse"
  });
  await new Promise((r) => setTimeout(r, 40));
  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
    modifiers: 0,
    pointerType: "mouse"
  });
}

async function dispatchTrustedKey(tabId, { key, code, windowsVirtualKeyCode, commands, modifiers = 0, repeat = 1 }) {
  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 1,
    y: 1,
    button: "none",
    buttons: 0,
    modifiers: 0,
    pointerType: "mouse"
  });
  const baseEvent = {
    key,
    code,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
    modifiers
  };
  if (Array.isArray(commands) && commands.length > 0) {
    baseEvent.commands = commands;
  }
  const count = Math.max(1, Math.trunc(repeat));
  for (let i = 0; i < count; i++) {
    await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      ...baseEvent
    });
    await new Promise((r) => setTimeout(r, 25));
    await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      ...baseEvent
    });
    if (i < count - 1) {
      await new Promise((r) => setTimeout(r, 8));
    }
  }
}

function nanoBridgeMain(config) {
  if (window.__wphotoNanoBridgeInstalled) return;
  window.__wphotoNanoBridgeInstalled = true;

  const LM = globalThis.LanguageModel;
  const expected = { expectedInputs: [{ type: "image" }] };

  const reply = (id, payload) => {
    window.postMessage({ ns: "wphotoNanoReply", id, ...payload }, window.location.origin);
  };

  const computeMeanBrightness = (source) => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (!ctx) return -1;
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
      const bmp = await createImageBitmap(await resp.blob());
      const brightness = computeMeanBrightness(bmp);
      if (brightness > (config?.minMeanBrightness ?? 2)) {
        return { bitmap: bmp, brightness, path: "fetch" };
      }
      bmp.close();
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
        const status = await LM.availability(expected);
        reply(data.id, { status });
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
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error("generate_timeout")), config?.generateTimeoutMs ?? 35000)
          )
        ]);
        reply(data.id, { text, ms: Math.round(performance.now() - t0) });
      } catch (e) {
        reply(data.id, { error: "generate_failed: " + String(e?.message ?? e) });
      } finally {
        try {
          session?.destroy();
        } catch (e) {}
        try {
          loaded.bitmap.close();
        } catch (e) {}
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type ?? "";
  if (!type.startsWith("BATCH_")) return false;

  const tabId = sender.tab?.id;
  if (typeof tabId !== "number") {
    sendResponse({ ok: false, error: "no_tab_id" });
    return false;
  }

  (async () => {
    switch (type) {
      case "BATCH_ATTACH": {
        if (attachedTabId === tabId) {
          try {
            await configureAttachedSession(tabId);
            sendResponse({ ok: true, attached: true, tabId });
            return;
          } catch (e) {
            attachedTabId = null;
            resetNetworkState();
          }
        }
        if (attachedTabId !== null && attachedTabId !== tabId) {
          try {
            await new Promise((r) => chrome.debugger.detach({ tabId: attachedTabId }, () => r()));
          } catch (e) {}
          attachedTabId = null;
          resetNetworkState();
        }
        try {
          await new Promise((resolve, reject) => {
            chrome.debugger.attach({ tabId }, "1.3", () => {
              if (chrome.runtime.lastError) {
                return reject(new Error(chrome.runtime.lastError.message));
              }
              resolve();
            });
          });
          attachedTabId = tabId;
          await configureAttachedSession(tabId);
          sendResponse({ ok: true, attached: true, tabId });
        } catch (e) {
          sendResponse({ ok: false, error: e.message || "attach_failed" });
        }
        return;
      }

      case "BATCH_DETACH": {
        if (attachedTabId === tabId) {
          resetNetworkState();
          attachedTabId = null;
          try {
            await new Promise((resolve) => {
              chrome.debugger.detach({ tabId }, () => {
                void chrome.runtime.lastError;
                resolve();
              });
            });
          } catch (e) {}
        }
        sendResponse({ ok: true });
        return;
      }

      case "BATCH_GET_STATUS": {
        sendResponse({ ok: true, attached: attachedTabId === tabId, tabId: attachedTabId });
        return;
      }

      case "BATCH_DISPATCH_CLICK_AT": {
        if (attachedTabId !== tabId) {
          sendResponse({ ok: false, error: "not_attached" });
          return;
        }
        try {
          await dispatchTrustedClick(tabId, message.x, message.y);
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: normalizeDispatchError(tabId, e, "click_failed") });
        }
        return;
      }

      case "BATCH_DISPATCH_KEY": {
        if (attachedTabId !== tabId) {
          sendResponse({ ok: false, error: "not_attached" });
          return;
        }
        try {
          await dispatchTrustedKey(tabId, message);
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: normalizeDispatchError(tabId, e, "key_dispatch_failed") });
        }
        return;
      }

      case "BATCH_INSERT_TEXT": {
        if (attachedTabId !== tabId) {
          sendResponse({ ok: false, error: "not_attached" });
          return;
        }
        try {
          await sendDebuggerCommand(tabId, "Input.insertText", { text: message.text });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: normalizeDispatchError(tabId, e, "insert_text_failed") });
        }
        return;
      }

      case "BATCH_AWAIT_SAVE_QUIESCENCE": {
        if (attachedTabId !== tabId) {
          sendResponse({ ok: false, error: "not_attached" });
          return;
        }
        if (pendingQuiescenceWait) {
          sendResponse({ ok: false, error: "already_waiting" });
          return;
        }
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
          ceilingTimer: setTimeout(() => {
            if (pendingQuiescenceWait) {
              const wait = pendingQuiescenceWait;
              pendingQuiescenceWait = null;
              if (wait.idleTimer) clearTimeout(wait.idleTimer);
              wait.sendResponse({
                ok: true,
                reason: "ceiling",
                waitMs: Date.now() - wait.startedAt,
                saveXhrsObserved: wait.saveXhrsObserved
              });
            }
          }, maxWaitMs)
        };
        checkQuiescenceIdle();
        return;
      }

      case "BATCH_NANO_INJECT": {
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
      }

      default:
        sendResponse({ ok: false, error: "unknown_message_type" });
    }
  })();

  return true;
});
