// Selection & Album Scope Tracker for Google Photos AI Description Extension
// Supports Technique 1 (Grid Checkbox Selection & Single Photo Viewer) and Technique 2 (Entire Album Scope).

(function () {
  const DURATION_REGEX = /^\p{Nd}{1,2}:\p{Nd}{2}$/u;
  const ACCOUNT_PREFIX_REGEX = /^\/(u\/\d+)\//;
  const selectedRegistry = new Map();
  let selectionOrderCounter = 0;
  let lastPathKey = "";
  let lastFullPathname = "";
  const changeListeners = new Set();

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
    const prefix = getAccountPathPrefix(pathname);
    return `https://photos.google.com${prefix}/photo/${photoId}`;
  }

  function parsePhotoIdFromPath(pathname = location.pathname) {
    if (typeof pathname !== "string") return null;
    const match = pathname.match(/\/photo\/([^/?#]+)/);
    return match ? match[1] : null;
  }

  function isAlbumPage(pathname = location.pathname) {
    return /^(?:\/u\/\d+)?\/(?:album|share)\/([^/?#]+)/.test(pathname) && !pathname.includes("/photo/");
  }

  function findTileLink(el) {
    if (!el) return null;
    if (typeof el.getAttribute === "function" && (el.getAttribute("href") || "").includes("/photo/")) {
      return el;
    }
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
    if (!link) return null;
    const href = link.getAttribute("href") || "";
    const match = href.match(/\/photo\/([^/?#]+)/);
    return match ? match[1] : null;
  }

  function tileHasDurationBadge(checkboxOrTile) {
    const link = findTileLink(checkboxOrTile);
    const container = link?.parentElement;
    if (!container) return false;
    for (const node of container.querySelectorAll("div, span")) {
      if (node.children.length === 0 && DURATION_REGEX.test((node.textContent || "").trim())) {
        return true;
      }
    }
    return false;
  }

  let cachedViewerAccountName = null;
  const rpcOwnershipCache = new Map();

  function resolveViewerAccountName() {
    if (cachedViewerAccountName !== null) return cachedViewerAccountName;
    if (typeof document === "undefined" || typeof document.querySelector !== "function") return null;
    const accBtn = document.querySelector(
      'a[role="button"][aria-label*="Google Account:"], button[aria-label*="Google Account:"], a[role="button"][aria-label*="Compte Google"], button[aria-label*="Compte Google"], a[role="button"][aria-label*="Cuenta de Google"], button[aria-label*="Cuenta de Google"]'
    );
    if (accBtn) {
      const label = accBtn.getAttribute?.("aria-label") || "";
      const m = label.match(/(?:Google Account|Compte Google|Cuenta de Google)\s*:\s*([^(\n]+)/i);
      const name = m?.[1]?.trim();
      if (name) {
        cachedViewerAccountName = name;
        return name;
      }
    }
    if (typeof document.querySelectorAll === "function") {
      for (const el of Array.from(document.querySelectorAll('a[role="button"][aria-label], button[aria-label]'))) {
        const label = el.getAttribute?.("aria-label") || "";
        if (!/\([^()\s]+@[^()\s]+\)/.test(label)) continue;
        const m = label.match(/:\s*([^(\n]+?)\s*(?:\n|\()/);
        const name = m?.[1]?.trim();
        if (name) {
          cachedViewerAccountName = name;
          return name;
        }
      }
    }
    return null;
  }

  function resolveTileOwnerName(checkboxOrTile) {
    const link = findTileLink(checkboxOrTile);
    const container = link?.parentElement;
    if (!container || typeof container.querySelectorAll !== "function") return null;
    for (const node of Array.from(container.querySelectorAll("div, span"))) {
      if ((node.children && node.children.length > 0) || link.contains?.(node)) continue;
      const text = (node.textContent || "").trim();
      if (text.length >= 2 && text.length <= 50 && /\p{L}/u.test(text) && !/\p{Nd}/u.test(text)) {
        return text;
      }
    }
    return null;
  }

  function isSameOwnerName(tileOwner, viewerName) {
    if (!tileOwner || !viewerName) return true;
    const a = tileOwner.trim().toLowerCase();
    const b = viewerName.trim().toLowerCase();
    if (a === b) return true;
    if (b.startsWith(a + " ") || a.startsWith(b + " ")) return true;
    return false;
  }

  function resolveViewerGaiaId() {
    if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return null;
    const gaiaRegex = /"S06Grb":"(\d{15,25})"/;
    for (const script of Array.from(document.querySelectorAll("script"))) {
      const text = script.textContent || "";
      const m = gaiaRegex.exec(text);
      if (m) return m[1];
    }
    return null;
  }

  function resolveViewerActorId(extraText = "") {
    const gaiaId = resolveViewerGaiaId();
    if (!gaiaId) return null;
    const escapedGaia = gaiaId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pairRegex = new RegExp(`"(AF1Qip[A-Za-z0-9_\\-]{20,})","${escapedGaia}"`);
    if (extraText) {
      const m = pairRegex.exec(extraText);
      if (m) return m[1];
    }
    if (typeof document !== "undefined" && typeof document.querySelectorAll === "function") {
      for (const script of Array.from(document.querySelectorAll("script"))) {
        const text = script.textContent || "";
        const m = pairRegex.exec(text);
        if (m) return m[1];
      }
    }
    return null;
  }

  function evaluateSliceOwnership(slice, viewerActorId = null) {
    if (!slice || typeof slice !== "string") return null;
    const actorMatch = /\["(AF1Qip[A-Za-z0-9_\-]{20,})"\]/.exec(slice);
    if (!actorMatch) return null;
    const inViewerLibrary = /\["AF1Qip[A-Za-z0-9_\-]{20,}"\],\[\[1\],/.test(slice);
    if (!inViewerLibrary) return false;
    if (viewerActorId && actorMatch[1] !== viewerActorId) return false;
    return true;
  }

  function isSnAcKcRowOwnedByViewer(row, viewerActorId = null) {
    if (!Array.isArray(row) || row.length < 2) return null;
    try {
      const rowTail = JSON.stringify(row.slice(1));
      return evaluateSliceOwnership(rowTail, viewerActorId);
    } catch (e) {
      return null;
    }
  }

  function isOwnedByViewerInScripts(mediaId) {
    if (!mediaId) return null;
    if (rpcOwnershipCache.has(mediaId)) {
      return rpcOwnershipCache.get(mediaId);
    }
    if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") {
      return null;
    }
    const viewerActorId = resolveViewerActorId();
    const ds7Marker = "AF_initDataCallback({key: 'ds:7'";
    const scripts = Array.from(document.querySelectorAll("script"));

    for (const script of scripts) {
      const text = script.textContent || "";
      const ds7Idx = text.indexOf(ds7Marker);
      if (ds7Idx < 0) continue;
      const pos = text.indexOf(`"${mediaId}"`, ds7Idx);
      if (pos < 0) continue;
      const slice = text.slice(pos + mediaId.length + 2, pos + 2500);
      const owned = evaluateSliceOwnership(slice, viewerActorId);
      if (owned !== null) {
        rpcOwnershipCache.set(mediaId, owned);
        return owned;
      }
      const fallback = /\["AF1Qip[A-Za-z0-9_\-]{20,}"\],\[\[1\],/.test(slice);
      rpcOwnershipCache.set(mediaId, fallback);
      return fallback;
    }

    for (const script of scripts) {
      const text = script.textContent || "";
      if (!text.includes("AF_initDataCallback")) continue;
      const pos = text.indexOf(`"${mediaId}"`);
      if (pos < 0) continue;
      const slice = text.slice(pos + mediaId.length + 2, pos + 2500);
      const owned = evaluateSliceOwnership(slice, viewerActorId);
      if (owned !== null) {
        rpcOwnershipCache.set(mediaId, owned);
        return owned;
      }
    }
    return null;
  }

  function findRenderedTileByMediaId(mediaId) {
    if (!mediaId || typeof document === "undefined" || typeof document.querySelectorAll !== "function") {
      return null;
    }
    for (const link of Array.from(document.querySelectorAll('a[href*="/photo/"]'))) {
      const href = link.getAttribute?.("href") || "";
      const m = href.match(/\/photo\/([^/?#]+)/);
      if (m && m[1] === mediaId) {
        return link;
      }
    }
    return null;
  }

  function isUnownedSharedItem(mediaId, checkboxOrTile) {
    const scriptOwned = isOwnedByViewerInScripts(mediaId);
    if (scriptOwned === false) return true;
    if (scriptOwned === true) return false;
    const targetEl = checkboxOrTile || findRenderedTileByMediaId(mediaId);
    if (targetEl) {
      const tileOwner = resolveTileOwnerName(targetEl);
      const viewerName = resolveViewerAccountName();
      if (tileOwner && viewerName && !isSameOwnerName(tileOwner, viewerName)) {
        return true;
      }
    }
    return false;
  }

  function classifyAriaLabel(label, checkboxEl) {
    if (checkboxEl && tileHasDurationBadge(checkboxEl)) {
      return "skipped_video";
    }
    const linkLabel = checkboxEl ? findTileLink(checkboxEl)?.getAttribute?.("aria-label") || "" : "";
    const combinedLabel = [label || "", linkLabel].filter(Boolean).join(" - ");
    if (!combinedLabel) {
      if (checkboxEl && findTileLink(checkboxEl)) {
        const mediaId = resolveMediaId(checkboxEl);
        return isUnownedSharedItem(mediaId, checkboxEl) ? "skipped_unowned" : "eligible";
      }
      return "skipped_unsupported";
    }
    const hasPrefix = (prefix) =>
      combinedLabel.startsWith(prefix) || combinedLabel.includes(` - ${prefix}`);
    if (
      hasPrefix("Video - ") ||
      hasPrefix("Vidéo - ") ||
      hasPrefix("Vídeo - ") ||
      hasPrefix("Animation - ") ||
      hasPrefix("Animación - ")
    ) {
      return "skipped_video";
    }
    if (/ - (Shared by|Partagé par|Compartido por) /i.test(combinedLabel)) {
      return "skipped_unowned";
    }
    const mediaId = checkboxEl ? resolveMediaId(checkboxEl) : null;
    if (isUnownedSharedItem(mediaId, checkboxEl)) {
      return "skipped_unowned";
    }
    if (
      hasPrefix("Photo - ") ||
      hasPrefix("Foto - ") ||
      hasPrefix("Burst photo - ") ||
      hasPrefix("Raw photo - ") ||
      / - (Photo stack|Top shot|Pile de photos|Mejor toma)\b/i.test(combinedLabel)
    ) {
      return "eligible";
    }
    return checkboxEl && findTileLink(checkboxEl) ? "eligible" : "skipped_unsupported";
  }

  function syncCheckboxElement(checkboxEl) {
    if (!checkboxEl || checkboxEl.getAttribute?.("role") !== "checkbox") return false;
    const id = resolveMediaId(checkboxEl);
    if (!id) return false;
    const isChecked = checkboxEl.getAttribute("aria-checked") === "true";

    if (isChecked) {
      if (!selectedRegistry.has(id)) {
        const label =
          checkboxEl.getAttribute("aria-label") ||
          findTileLink(checkboxEl)?.getAttribute("aria-label") ||
          "";
        const classification = classifyAriaLabel(label, checkboxEl);
        selectedRegistry.set(id, {
          id,
          order: selectionOrderCounter++,
          classification
        });
        return true;
      } else {
        const existing = selectedRegistry.get(id);
        if (existing && existing.classification === "eligible" && isUnownedSharedItem(id, checkboxEl)) {
          existing.classification = "skipped_unowned";
          return true;
        }
      }
    } else if (selectedRegistry.has(id)) {
      selectedRegistry.delete(id);
      return true;
    }
    return false;
  }

  function scanVisibleCheckboxes() {
    let changed = false;
    if ( typeof document === "undefined" ) return false;
    const checkedNodes = document.querySelectorAll('[role="checkbox"][aria-checked="true"]');
    for (const node of checkedNodes) {
      if (syncCheckboxElement(node)) changed = true;
    }
    // If no checkboxes are checked on screen and the "Clear selection" button is absent, clear stale registry
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
      selectionOrderCounter = 0;
      return true;
    }
    lastPathKey = currentKey;
    return pathChanged;
  }

  function sortedEntries() {
    return Array.from(selectedRegistry.values()).sort((a, b) => a.order - b.order);
  }

  function getEligibleIds() {
    if (parsePhotoIdFromPath()) return [];
    scanVisibleCheckboxes();
    return sortedEntries()
      .filter((item) => item.classification === "eligible")
      .map((item) => item.id);
  }

  function getSkippedIds() {
    if (parsePhotoIdFromPath()) return [];
    scanVisibleCheckboxes();
    return sortedEntries()
      .filter((item) => item.classification !== "eligible")
      .map((item) => item.id);
  }

  function getSummary() {
    const viewerId = parsePhotoIdFromPath();
    if (viewerId) {
      return {
        mode: "viewer",
        eligible: 0,
        videos: 0,
        skipped: 0,
        total: 0,
        viewerPhotoId: viewerId,
        inAlbum: false
      };
    }

    scanVisibleCheckboxes();
    const entries = sortedEntries();
    let eligible = 0;
    let videos = 0;
    let skipped = 0;
    for (const item of entries) {
      if (item.classification === "eligible") {
        eligible++;
      } else {
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

  function extractPageToken(key) {
    const regex = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`);
    for (const script of Array.from(document.querySelectorAll("script"))) {
      const text = script.textContent;
      if (!text || !text.includes(`"${key}"`)) continue;
      const m = regex.exec(text);
      if (m) {
        try {
          return JSON.parse(`"${m[1]}"`);
        } catch (e) {
          return m[1];
        }
      }
    }
    return null;
  }

  async function enumerateAlbumViaRpc(albumKey) {
    const at = extractPageToken("SNlM0e");
    const sid = extractPageToken("FdrFJe");
    const bl = extractPageToken("cfb2h");
    const path = extractPageToken("eptZe");
    if (!at || !sid || !bl || !path) {
      throw new Error("missing_page_tokens");
    }

    const ids = [];
    const skippedIds = [];
    let pageToken = null;
    let pages = 0;

    do {
      const payload = [[["snAcKc", JSON.stringify([albumKey, pageToken, null, null]), null, "generic"]]];
      const body = `f.req=${encodeURIComponent(JSON.stringify(payload))}&at=${encodeURIComponent(at)}&`;
      const queryParams = {
        rpcids: "snAcKc",
        "source-path": location.pathname,
        "f.sid": sid,
        bl: bl,
        pageId: "none",
        rt: "c"
      };
      const queryStr = Object.entries(queryParams)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&");
      const url = `https://photos.google.com${path}data/batchexecute?${queryStr}`;
      const resp = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body
      });
      if (!resp.ok) throw new Error(`http_${resp.status}`);
      const text = await resp.text();
      const wrbLine = text.split("\n").find((line) => line.includes("wrb.fr"));
      if (!wrbLine) throw new Error("missing_wrb_envelope");
      const outer = JSON.parse(wrbLine);
      const entry = outer.find((row) => row?.[0] === "wrb.fr");
      const rawInnerJson = entry?.[2] || "";
      const parsed = JSON.parse(rawInnerJson);
      const rows = Array.isArray(parsed?.[1]) ? parsed[1] : [];
      const viewerActorId = resolveViewerActorId(rawInnerJson);

      for (const row of rows) {
        const mediaKey = row?.[0];
        if (typeof mediaKey !== "string") continue;
        const meta = Array.isArray(row) ? row[row.length - 1] : null;
        const durationMs = meta?.[76647426]?.[0] ?? null;
        const rowOwned = isSnAcKcRowOwnedByViewer(row, viewerActorId);
        if (rowOwned !== null) {
          rpcOwnershipCache.set(mediaKey, rowOwned);
        }
        const scriptOwned = isOwnedByViewerInScripts(mediaKey);
        const domTile = findRenderedTileByMediaId(mediaKey);
        const domClassification = domTile
          ? classifyAriaLabel(domTile.getAttribute?.("aria-label") || "", domTile)
          : "eligible";
        if (
          durationMs !== null ||
          rowOwned === false ||
          scriptOwned === false ||
          domClassification !== "eligible"
        ) {
          skippedIds.push(mediaKey);
        } else {
          ids.push(mediaKey);
        }
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
      const links = document.querySelectorAll('a[href*="/photo/"]');
      for (const link of links) {
        if (link.offsetParent === null) continue;
        const href = link.getAttribute("href") || "";
        const m = href.match(/\/photo\/([^/?#]+)/);
        if (!m) continue;
        const id = m[1];
        if (seen.has(id)) continue;
        seen.add(id);
        const label = link.getAttribute("aria-label") || "";
        const cls = classifyAriaLabel(label, link);
        if (cls === "eligible") {
          ids.push(id);
        } else {
          skippedIds.push(id);
        }
      }
    };

    collectVisible();

    // Find scrollable container if album has more items
    let scrollEl = null;
    const firstLink = document.querySelector('a[href*="/photo/"]');
    let cur = firstLink?.parentElement;
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
    const match = location.pathname.match(/^(?:\/u\/\d+)?\/(?:album|share)\/([^/?#]+)/);
    const albumKey = match ? match[1] : null;
    if (!albumKey) {
      return { ids: [], skippedIds: [], error: "not_in_album" };
    }
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
    selectionOrderCounter = 0;
    notifyListeners();
  }

  if (typeof MutationObserver !== "undefined" && typeof document !== "undefined" && document.documentElement) {
    const observer = new MutationObserver((mutations) => {
      let changed = checkNavigationReset();
      for (const m of mutations) {
        if (m.type === "attributes" && m.target) {
          if (syncCheckboxElement(m.target)) changed = true;
        } else if (m.type === "childList") {
          if (scanVisibleCheckboxes()) changed = true;
        }
      }
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
