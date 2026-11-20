// Selection & Album Scope Tracker for Google Photos AI Description Extension
// Supports Technique 1 (Grid Checkbox Selection & Single Photo Viewer) and Technique 2 (Entire Album Scope).

(function () {
  const DURATION_REGEX = /^\p{Nd}{1,2}:\p{Nd}{2}$/u;
  const ACCOUNT_PREFIX_REGEX = /^\/(u\/\d+)\//;
  const VIDEO_LABEL_RE = /(?:^| - )(?:Video|Vidéo|Vídeo|Animation|Animación) - /;
  const PHOTO_LABEL_RE = /(?:^| - )(?:Photo|Foto|Burst photo|Raw photo) - /;
  const ACTOR_SLICE_RE = /\["(AF1Qip[A-Za-z0-9_\-]{20,})"\]/;
  const VIEWER_LIB_RE = /\["AF1Qip[A-Za-z0-9_\-]{20,}"\],\[\[1\],/;
  const RPC_TIMEOUT_MS = 15000;
  const selectedRegistry = new Map();
  let selectionOrderCounter = 0;
  let lastPathKey = "";
  let lastFullPathname = "";
  const changeListeners = new Set();

  let cachedViewerAccountName = null;
  let cachedViewerGaiaId = null;
  let cachedViewerActorId = null;
  const rpcOwnershipCache = new Map();

  const getScripts = () =>
    typeof document !== "undefined" && typeof document.querySelectorAll === "function"
      ? Array.from(document.querySelectorAll("script"))
      : [];

  const getPhotoLinks = () =>
    typeof document !== "undefined" && typeof document.querySelectorAll === "function"
      ? Array.from(document.querySelectorAll('a[href*="/photo/"]'))
      : [];

  function notifyListeners() {
    for (const fn of changeListeners) {
      try {
        fn();
      } catch (e) {}
    }
  }

  function getAccountPathPrefix(pathname = location.pathname) {
    const match = pathname.match(ACCOUNT_PREFIX_REGEX);
    return match ? `/${match[1]}` : "";
  }

  function buildPhotoUrl(pathname, photoId) {
    return `https://photos.google.com${getAccountPathPrefix(pathname)}/photo/${photoId}`;
  }

  function parsePhotoIdFromPath(pathname = location.pathname) {
    if (typeof pathname !== "string") return null;
    return pathname.match(/\/photo\/([^/?#]+)/)?.[1] || null;
  }

  function isAlbumPage(pathname = location.pathname) {
    return /^(?:\/u\/\d+)?\/(?:album|share)\/([^/?#]+)/.test(pathname) && !pathname.includes("/photo/");
  }

  function findTileLink(el) {
    if (!el) return null;
    if (typeof el.getAttribute === "function" && (el.getAttribute("href") || "").includes("/photo/")) return el;
    let cur = el;
    for (let i = 0; i < 6 && cur; i++) {
      const link = cur.querySelector?.('a[href*="/photo/"]');
      if (link) return link;
      cur = cur.parentElement;
    }
    return null;
  }

  function resolveMediaId(checkboxOrTile) {
    const link = findTileLink(checkboxOrTile);
    return link ? parsePhotoIdFromPath(link.getAttribute?.("href") || "") : null;
  }

  function tileHasDurationBadge(checkboxOrTile) {
    const container = findTileLink(checkboxOrTile)?.parentElement;
    if (!container) return false;
    for (const node of container.querySelectorAll("div, span")) {
      if (node.children.length === 0 && DURATION_REGEX.test((node.textContent || "").trim())) return true;
    }
    return false;
  }

  function resolveViewerAccountName() {
    if (cachedViewerAccountName !== null) return cachedViewerAccountName;
    if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return null;
    for (const el of Array.from(document.querySelectorAll('a[role="button"][aria-label], button[aria-label]'))) {
      const label = el.getAttribute?.("aria-label") || "";
      const direct = label.match(/(?:Google Account|Compte Google|Cuenta de Google)\s*:\s*([^(\n]+)/i)?.[1]?.trim();
      if (direct) return (cachedViewerAccountName = direct);
      if (/\([^()\s]+@[^()\s]+\)/.test(label)) {
        const emailLabel = label.match(/:\s*([^(\n]+?)\s*(?:\n|\()/)?.[1]?.trim();
        if (emailLabel) return (cachedViewerAccountName = emailLabel);
      }
    }
    return null;
  }

  function resolveTileOwnerName(checkboxOrTile) {
    const link = findTileLink(checkboxOrTile);
    const container = link?.parentElement;
    if (!container || typeof container.querySelectorAll !== "function") return null;
    for (const node of Array.from(container.querySelectorAll("div, span"))) {
      if (node.children?.length > 0 || link.contains?.(node)) continue;
      const text = (node.textContent || "").trim();
      if (text.length >= 2 && text.length <= 50 && /\p{L}/u.test(text) && !/\p{Nd}/u.test(text)) return text;
    }
    return null;
  }

  function isSameOwnerName(tileOwner, viewerName) {
    if (!tileOwner || !viewerName) return true;
    const a = tileOwner.trim().toLowerCase();
    const b = viewerName.trim().toLowerCase();
    return a === b || b.startsWith(a + " ") || a.startsWith(b + " ");
  }

  function findInScripts(regex) {
    for (const script of getScripts()) {
      const m = regex.exec(script.textContent || "");
      if (m) return m[1];
    }
    return null;
  }

  function resolveViewerGaiaId() {
    if (cachedViewerGaiaId !== null) return cachedViewerGaiaId;
    const gaiaId = findInScripts(/"S06Grb":"(\d{15,25})"/);
    if (gaiaId) cachedViewerGaiaId = gaiaId;
    return cachedViewerGaiaId;
  }

  function resolveViewerActorId(extraText = "") {
    if (cachedViewerActorId !== null) return cachedViewerActorId;
    const gaiaId = resolveViewerGaiaId();
    if (!gaiaId) return null;
    const pairRe = new RegExp(`"(AF1Qip[A-Za-z0-9_\\-]{20,})","${gaiaId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
    const hit = (extraText && pairRe.exec(extraText)?.[1]) || findInScripts(pairRe);
    if (hit) cachedViewerActorId = hit;
    return cachedViewerActorId;
  }

  function evaluateSliceOwnership(slice, viewerActorId = null) {
    if (!slice || typeof slice !== "string") return null;
    const actorMatch = ACTOR_SLICE_RE.exec(slice);
    if (!actorMatch) return null;
    if (!VIEWER_LIB_RE.test(slice)) return false;
    return !(viewerActorId && actorMatch[1] !== viewerActorId);
  }

  function isSnAcKcRowOwnedByViewer(row, viewerActorId = null) {
    if (!Array.isArray(row) || row.length < 2) return null;
    try {
      return evaluateSliceOwnership(JSON.stringify(row.slice(1)), viewerActorId);
    } catch (e) {
      return null;
    }
  }

  function isOwnedByViewerInScripts(mediaId) {
    if (!mediaId) return null;
    if (rpcOwnershipCache.has(mediaId)) return rpcOwnershipCache.get(mediaId);
    const scripts = getScripts();
    if (scripts.length === 0) return null;

    const viewerActorId = resolveViewerActorId();
    const ds7Marker = "AF_initDataCallback({key: 'ds:7'";
    const ordered = [];
    for (const s of scripts) {
      const t = s.textContent || "";
      if (t.includes(ds7Marker)) ordered.unshift({ text: t, isDs7: true });
      else if (t.includes("AF_initDataCallback")) ordered.push({ text: t, isDs7: false });
    }

    for (const { text, isDs7 } of ordered) {
      const pos = text.indexOf(`"${mediaId}"`, isDs7 ? text.indexOf(ds7Marker) : 0);
      if (pos < 0) continue;
      const slice = text.slice(pos + mediaId.length + 2, pos + 2500);
      let owned = evaluateSliceOwnership(slice, viewerActorId);
      if (owned === null && isDs7) owned = VIEWER_LIB_RE.test(slice);
      if (owned !== null) {
        rpcOwnershipCache.set(mediaId, owned);
        return owned;
      }
    }
    return null;
  }

  function isUnownedSharedItem(mediaId, checkboxOrTile) {
    const scriptOwned = isOwnedByViewerInScripts(mediaId);
    if (scriptOwned !== null) return !scriptOwned;
    const targetEl =
      checkboxOrTile || getPhotoLinks().find((l) => parsePhotoIdFromPath(l.getAttribute?.("href") || "") === mediaId);
    if (targetEl) {
      const tileOwner = resolveTileOwnerName(targetEl);
      const viewerName = resolveViewerAccountName();
      if (tileOwner && viewerName && !isSameOwnerName(tileOwner, viewerName)) return true;
    }
    return false;
  }

  function classifyAriaLabel(label, checkboxEl) {
    if (checkboxEl && tileHasDurationBadge(checkboxEl)) return "skipped_video";
    const link = checkboxEl ? findTileLink(checkboxEl) : null;
    const linkLabel = link?.getAttribute?.("aria-label") || "";
    const combinedLabel = [label || "", linkLabel].filter(Boolean).join(" - ");
    const mediaId = link ? parsePhotoIdFromPath(link.getAttribute?.("href") || "") : null;

    if (!combinedLabel) {
      return link ? (isUnownedSharedItem(mediaId, checkboxEl) ? "skipped_unowned" : "eligible") : "skipped_unsupported";
    }
    if (VIDEO_LABEL_RE.test(combinedLabel)) return "skipped_video";
    if (/ - (Shared by|Partagé par|Compartido por) /i.test(combinedLabel) || isUnownedSharedItem(mediaId, checkboxEl)) {
      return "skipped_unowned";
    }
    if (PHOTO_LABEL_RE.test(combinedLabel) || / - (Photo stack|Top shot|Pile de photos|Mejor toma)\b/i.test(combinedLabel)) {
      return "eligible";
    }
    return link ? "eligible" : "skipped_unsupported";
  }

  function syncCheckboxElement(checkboxEl) {
    if (!checkboxEl || checkboxEl.getAttribute?.("role") !== "checkbox") return false;
    const id = resolveMediaId(checkboxEl);
    if (!id) return false;
    const isChecked = checkboxEl.getAttribute("aria-checked") === "true";

    if (isChecked) {
      if (!selectedRegistry.has(id)) {
        const label = checkboxEl.getAttribute("aria-label") || findTileLink(checkboxEl)?.getAttribute?.("aria-label") || "";
        selectedRegistry.set(id, {
          id,
          order: selectionOrderCounter++,
          classification: classifyAriaLabel(label, checkboxEl)
        });
        return true;
      }
      const existing = selectedRegistry.get(id);
      if (existing?.classification === "eligible" && isUnownedSharedItem(id, checkboxEl)) {
        existing.classification = "skipped_unowned";
        return true;
      }
    } else if (selectedRegistry.has(id)) {
      selectedRegistry.delete(id);
      return true;
    }
    return false;
  }

  function scanVisibleCheckboxes() {
    let changed = false;
    if (typeof document === "undefined") return false;
    const checkedNodes = document.querySelectorAll('[role="checkbox"][aria-checked="true"]');
    for (const node of checkedNodes) {
      if (syncCheckboxElement(node)) changed = true;
    }
    if (checkedNodes.length === 0 && selectedRegistry.size > 0) {
      const clearBtn = document.querySelector(
        'button[aria-label="Clear selection"], button[aria-label="Annuler la sélection"], button[aria-label="Borrar selección"], button[jslog*="8886"]'
      );
      if (!clearBtn || clearBtn.offsetParent === null) {
        selectedRegistry.clear();
        selectionOrderCounter = 0;
        changed = true;
      }
    }
    return changed;
  }

  function checkNavigationReset() {
    if (typeof location === "undefined") return false;
    const fullPath = location.pathname || "";
    const pathChanged = Boolean(lastFullPathname && fullPath !== lastFullPathname);
    lastFullPathname = fullPath;
    const currentKey = fullPath.replace(/\/photo\/[^/?#]+.*$/, "");
    if (lastPathKey && currentKey !== lastPathKey) {
      lastPathKey = currentKey;
      selectedRegistry.clear();
      rpcOwnershipCache.clear();
      cachedViewerGaiaId = null;
      cachedViewerActorId = null;
      selectionOrderCounter = 0;
      return true;
    }
    lastPathKey = currentKey;
    return pathChanged;
  }

  const sortedEntries = () => Array.from(selectedRegistry.values()).sort((a, b) => a.order - b.order);

  function getIdsByEligibility(wantEligible) {
    if (parsePhotoIdFromPath()) return [];
    scanVisibleCheckboxes();
    return sortedEntries()
      .filter((item) => (item.classification === "eligible") === wantEligible)
      .map((item) => item.id);
  }

  const getEligibleIds = () => getIdsByEligibility(true);
  const getSkippedIds = () => getIdsByEligibility(false);

  function getSummary() {
    const viewerId = parsePhotoIdFromPath();
    if (viewerId) {
      return { mode: "viewer", eligible: 0, videos: 0, skipped: 0, total: 0, viewerPhotoId: viewerId, inAlbum: false };
    }
    scanVisibleCheckboxes();
    const entries = sortedEntries();
    let eligible = 0, videos = 0, skipped = 0;
    for (const item of entries) {
      if (item.classification === "eligible") eligible++;
      else {
        skipped++;
        if (item.classification === "skipped_video") videos++;
      }
    }
    const inAlbum = isAlbumPage();
    return {
      mode: entries.length > 0 ? "selection" : inAlbum ? "album" : "none",
      eligible,
      videos,
      skipped,
      total: entries.length,
      viewerPhotoId: null,
      inAlbum
    };
  }

  function extractPageTokens(keys) {
    const tokens = {};
    let left = keys.length;
    for (const script of getScripts()) {
      const text = script.textContent;
      if (!text) continue;
      for (const key of keys) {
        if (key in tokens || !text.includes(`"${key}"`)) continue;
        const m = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
        if (m) {
          try {
            tokens[key] = JSON.parse(`"${m[1]}"`);
          } catch (e) {
            tokens[key] = m[1];
          }
          if (--left === 0) return tokens;
        }
      }
    }
    return tokens;
  }

  async function enumerateAlbumViaRpc(albumKey) {
    const { SNlM0e: at, FdrFJe: sid, cfb2h: bl, eptZe: path } = extractPageTokens([
      "SNlM0e", "FdrFJe", "cfb2h", "eptZe"
    ]);
    if (!at || !sid || !bl || !path) throw new Error("missing_page_tokens");

    const renderedTiles = new Map();
    for (const link of getPhotoLinks()) {
      const id = parsePhotoIdFromPath(link.getAttribute?.("href") || "");
      if (id && !renderedTiles.has(id)) renderedTiles.set(id, link);
    }

    const ids = [];
    const skippedIds = [];
    const seen = new Set();
    let pageToken = null;
    let pages = 0;

    do {
      const payload = [[["snAcKc", JSON.stringify([albumKey, pageToken, null, null]), null, "generic"]]];
      const body = `f.req=${encodeURIComponent(JSON.stringify(payload))}&at=${encodeURIComponent(at)}&`;
      const queryStr = Object.entries({
        rpcids: "snAcKc",
        "source-path": location.pathname,
        "f.sid": sid,
        bl,
        pageId: "none",
        rt: "c"
      })
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join("&");

      const ctrl = typeof AbortController === "function" ? new AbortController() : null;
      const tStart = typeof performance !== "undefined" ? performance.now() : Date.now();
      const timer = ctrl
        ? setTimeout(() => {
            if ((typeof performance !== "undefined" ? performance.now() : Date.now()) - tStart >= RPC_TIMEOUT_MS * 0.5) {
              ctrl.abort();
            }
          }, RPC_TIMEOUT_MS)
        : null;
      let text;
      try {
        const resp = await fetch(`https://photos.google.com${path}data/batchexecute?${queryStr}`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
          body,
          ...(ctrl ? { signal: ctrl.signal } : {})
        });
        if (!resp.ok) throw new Error(`http_${resp.status}`);
        text = await resp.text();
      } finally {
        if (timer !== null) clearTimeout(timer);
      }

      const wrbLine = text.split("\n").find((line) => line.includes("wrb.fr"));
      if (!wrbLine) throw new Error("missing_wrb_envelope");
      const rawInnerJson = JSON.parse(wrbLine).find((row) => row?.[0] === "wrb.fr")?.[2] || "";
      const parsed = JSON.parse(rawInnerJson);
      const rows = Array.isArray(parsed?.[1]) ? parsed[1] : [];
      const viewerActorId = resolveViewerActorId(rawInnerJson);

      for (const row of rows) {
        const mediaKey = row?.[0];
        if (typeof mediaKey !== "string" || seen.has(mediaKey)) continue;
        seen.add(mediaKey);
        const meta = Array.isArray(row) ? row[row.length - 1] : null;
        const durationMs = meta?.[76647426]?.[0] ?? null;
        const rowOwned = isSnAcKcRowOwnedByViewer(row, viewerActorId);
        if (rowOwned !== null) rpcOwnershipCache.set(mediaKey, rowOwned);
        const scriptOwned = rowOwned === null ? isOwnedByViewerInScripts(mediaKey) : rowOwned;
        const domTile = renderedTiles.get(mediaKey) || null;
        const domCls = domTile ? classifyAriaLabel(domTile.getAttribute?.("aria-label") || "", domTile) : "eligible";
        (durationMs !== null || rowOwned === false || scriptOwned === false || domCls !== "eligible"
          ? skippedIds
          : ids
        ).push(mediaKey);
      }
      pageToken = parsed?.[2] ?? null;
      pages++;
    } while (pageToken && pages < 50 && ids.length < 1000);

    return { ids, skippedIds };
  }

  async function enumerateAlbumViaDom() {
    const ids = [];
    const skippedIds = [];
    const seen = new Set();

    const collectVisible = () => {
      for (const link of getPhotoLinks()) {
        if (link.offsetParent === null) continue;
        const id = parsePhotoIdFromPath(link.getAttribute("href") || "");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const cls = classifyAriaLabel(link.getAttribute("aria-label") || "", link);
        (cls === "eligible" ? ids : skippedIds).push(id);
      }
    };

    collectVisible();

    let scrollEl = null;
    let cur = document.querySelector('a[href*="/photo/"]')?.parentElement;
    while (cur && cur !== document.body) {
      const style = getComputedStyle(cur);
      if ((style.overflowY === "auto" || style.overflowY === "scroll") && cur.scrollHeight > cur.clientHeight + 20) {
        scrollEl = cur;
        break;
      }
      cur = cur.parentElement;
    }

    if (scrollEl) {
      const initialTop = scrollEl.scrollTop;
      for (let step = 0; step < 25; step++) {
        const prevTop = scrollEl.scrollTop;
        scrollEl.scrollTop += Math.max(400, Math.floor(scrollEl.clientHeight * 0.8));
        await new Promise((r) => setTimeout(r, 180));
        collectVisible();
        if (scrollEl.scrollTop === prevTop) break;
      }
      scrollEl.scrollTop = initialTop;
    }
    return { ids, skippedIds };
  }

  async function enumerateCurrentAlbum() {
    const albumKey = location.pathname.match(/^(?:\/u\/\d+)?\/(?:album|share)\/([^/?#]+)/)?.[1] || null;
    if (!albumKey) return { ids: [], skippedIds: [], error: "not_in_album" };
    try {
      const res = await enumerateAlbumViaRpc(albumKey);
      if (res.ids.length > 0 || res.skippedIds.length > 0) return res;
    } catch (e) {}
    return await enumerateAlbumViaDom();
  }

  function clearAll() {
    selectedRegistry.clear();
    rpcOwnershipCache.clear();
    cachedViewerAccountName = null;
    cachedViewerGaiaId = null;
    cachedViewerActorId = null;
    selectionOrderCounter = 0;
    notifyListeners();
  }

  if (typeof MutationObserver !== "undefined" && typeof document !== "undefined" && document.documentElement) {
    const OWN_IDS = new Set(["wphoto-menu-card", "wphoto-status-bar", "wphoto-trigger-btn"]);
    const OWN_SEL = "#wphoto-menu-card, #wphoto-status-bar, #wphoto-trigger-btn";
    const observer = new MutationObserver((mutations) => {
      let changed = checkNavigationReset();
      let needScan = false;
      const onViewer = Boolean(parsePhotoIdFromPath());
      for (const m of mutations) {
        if (m.target?.nodeType === 1 && m.target.closest?.(OWN_SEL)) continue;
        if (m.type === "attributes" && m.target) {
          if (!onViewer && syncCheckboxElement(m.target)) changed = true;
        } else if (m.type === "childList") {
          const nodes = [...m.addedNodes, ...m.removedNodes];
          if (nodes.length === 0 || !nodes.every((n) => OWN_IDS.has(n?.id))) needScan = true;
        }
      }
      if (needScan && !onViewer && scanVisibleCheckboxes()) changed = true;
      if (changed) notifyListeners();
    });

    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-checked", "aria-label"]
    });
  }

  window.WPhotoSelection = {
    getAccountPathPrefix,
    buildPhotoUrl,
    parsePhotoIdFromPath,
    isAlbumPage,
    classifyAriaLabel,
    getSummary,
    getEligibleIds,
    getSkippedIds,
    enumerateCurrentAlbum,
    clearAll,
    scanVisibleCheckboxes,
    onChange(fn) {
      changeListeners.add(fn);
      return () => changeListeners.delete(fn);
    }
  };
})();
