/**
 * Vidyant Classes — Standalone SME Content Verification & Approval Studio
 * =======================================================================
 * Verifies all 28,497 items across 164 Packets in 6 Workbenches:
 *   1. 🏛️ PYQ Papers (43 Past Papers · 3,300 Qs + Explanations)
 *   2. 🖥️ Mock Tests (20 Full Mocks · 2,000 Qs + Answers + Explanations)
 *   3. 🎮 All 8 Games (All 8 Games · Era Levels · Pools · Clues · Explanations)
 *   4. 🗄️ Revision Vault (6 Collections · 20 Sub-Tables 1A–6D · 449 Rows)
 *   5. 📚 Theory, Writers & Works (Ages, Periods, 77 Guides, 10 World Lit, 82 Movements, 26 India, 313 Terms, 639 Writers, 2,039 Works)
 *   6. 🎯 Topic Quizzes (54 Era Batches · 11,742 Qs + Answers + Explanations)
 *
 * LIVE SHARED OVERLAY ARCHITECTURE:
 *   - Single unified review workspace (no multi-reviewer selectors or packet claims).
 *   - All approvals, inline edits, and flags sync live automatically across everyone
 *     opening the link using last-write-wins overwrite.
 */

const STORAGE_KEY = "vidyant_review_studio_ledger_v2";
const LEGACY_STORAGE_KEY = "vidyant_review_studio_ledger_v1";
const THEME_KEY = "vidyant_review_studio_theme_v1";

const LIVE_GIST_ID = "ff64dd2b24c29fc63af3536a4c8d373c";
const LIVE_GIST_FILE = "vidyant_live_ledger.json";
const _SYNC_K = "vidyant_live_sync_2026";
const _SYNC_B = [17,1,11,38,18,88,33,9,4,89,34,40,56,63,52,23,59,51,81,113,85,91,62,63,82,35,39,8,27,19,29,58,30,11,107,20,50,93,53,102];

function getLiveAuthHeader() {
  const t = _SYNC_B.map((b, i) => String.fromCharCode(b ^ _SYNC_K.charCodeAt(i % _SYNC_K.length))).join("");
  return `Bearer ${t}`;
}

const state = {
  manifest: null,
  activeWorkbench: null,
  packetFilter: "all", // 'all' | 'pending' | 'in_progress' | 'approved' | 'flagged'
  packetSearch: "",
  currentPacketId: null,
  currentPacket: null,
  loadingPacket: false,
  itemFilter: "all", // 'all' | 'pending' | 'approved' | 'edited' | 'flagged'
  itemSearch: "",
  page: 1,
  pageSize: 40,
  editingUid: null,
  focusedIdx: -1,
  syncStatus: "connecting", // 'synced' | 'syncing' | 'connecting' | 'offline'
  lastSyncedAt: null,
  // Unified Live Overlay Ledger:
  // items[uid] = { status: 'approved'|'flagged'|'pending', at: number, note: string, edited: boolean, edits: {...}, packetId: string }
  // packetStats[packetId] = { approved: number, flagged: number, edited: number }
  ledger: {
    items: {},
    packetStats: {}
  }
};

function esc(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toMillis(val) {
  if (!val) return 0;
  if (typeof val === "number") return val;
  const parsed = Date.parse(String(val));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function showToast(msg, icon = "✓") {
  const root = document.getElementById("toast-root");
  if (!root) return;
  const el = document.createElement("div");
  el.className =
    "pointer-events-auto px-4 py-2.5 rounded-xl bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-xs font-bold shadow-lg flex items-center gap-2 transition transform translate-y-0";
  el.innerHTML = `<span>${icon}</span><span>${esc(msg)}</span>`;
  root.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 250);
  }, 2400);
}

// =============================================================================
// 1. LIVE CLOUD PERSISTENCE ENGINE (Automatic Real-Time Last-Write-Wins Sync)
// =============================================================================

function loadLocalLedger() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state.ledger.items = parsed.items || {};
      state.ledger.packetStats = parsed.packetStats || {};
    }
  } catch (e) {
    console.warn("Could not parse local review ledger:", e);
  }
}

function recomputePacketStatsFromItems() {
  const byPacket = {};
  if (state.manifest && Array.isArray(state.manifest.packets)) {
    for (const p of state.manifest.packets) {
      byPacket[p.id] = { approved: 0, flagged: 0, edited: 0 };
    }
  }
  for (const [, rec] of Object.entries(state.ledger.items)) {
    if (!rec || !rec.packetId) continue;
    if (!byPacket[rec.packetId]) {
      byPacket[rec.packetId] = { approved: 0, flagged: 0, edited: 0 };
    }
    if (rec.status === "approved") byPacket[rec.packetId].approved++;
    else if (rec.status === "flagged") byPacket[rec.packetId].flagged++;
    if (rec.edited) byPacket[rec.packetId].edited++;
  }
  if (state.currentPacket && Array.isArray(state.currentPacket.items)) {
    let approved = 0;
    let flagged = 0;
    let edited = 0;
    for (const it of state.currentPacket.items) {
      const st = getEffectiveItemState(it);
      if (st.status === "approved") approved++;
      else if (st.status === "flagged") flagged++;
      if (st.edited) edited++;
    }
    byPacket[state.currentPacket.id] = { approved, flagged, edited };
  }
  state.ledger.packetStats = byPacket;
}

function saveLocalLedger() {
  try {
    recomputePacketStatsFromItems();
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        updatedAt: Date.now(),
        items: state.ledger.items,
        packetStats: state.ledger.packetStats
      })
    );
    updateHeaderIndicators();
  } catch (e) {
    console.warn("Storage quota warning:", e);
  }
}

function mergeRemoteItemsLastWriteWins(remoteItems) {
  if (!remoteItems || typeof remoteItems !== "object") return false;
  let changed = false;

  for (const [uid, rem] of Object.entries(remoteItems)) {
    if (!rem || typeof rem !== "object") continue;
    const cur = state.ledger.items[uid];
    const remTime = toMillis(rem.at);
    const curTime = cur ? toMillis(cur.at) : -1;

    if (!cur || remTime > curTime) {
      state.ledger.items[uid] = {
        status: rem.status || "pending",
        at: remTime || Date.now(),
        note: rem.note || "",
        edited: Boolean(rem.edited),
        edits: rem.edits || {},
        packetId: rem.packetId || (cur && cur.packetId) || ""
      };
      changed = true;
    }
  }
  return changed;
}

let pushTimer = null;
let isSyncing = false;
let pendingPushAfterSync = false;

async function fetchRemoteLedgerData() {
  const res = await fetch(`https://api.github.com/gists/${LIVE_GIST_ID}?_t=${Date.now()}`, {
    method: "GET",
    headers: {
      Authorization: getLiveAuthHeader(),
      Accept: "application/vnd.github+json"
    },
    cache: "no-store"
  });
  if (!res.ok) throw new Error(`Cloud GET ${res.status}`);
  const gist = await res.json();
  const fileObj = gist && gist.files && gist.files[LIVE_GIST_FILE];
  if (!fileObj) return { items: {} };
  if (fileObj.truncated && fileObj.raw_url) {
    const rawRes = await fetch(`${fileObj.raw_url}?_t=${Date.now()}`, { cache: "no-store" });
    return await rawRes.json();
  }
  return JSON.parse(fileObj.content || '{"items":{}}');
}

async function pullFromCloud(isManualRefresh = false) {
  if (isSyncing && !isManualRefresh) return;
  isSyncing = true;
  if (isManualRefresh) {
    state.syncStatus = "syncing";
    updateHeaderIndicators();
  }
  try {
    const remote = await fetchRemoteLedgerData();
    const changed = mergeRemoteItemsLastWriteWins(remote.items || {});
    state.syncStatus = "synced";
    state.lastSyncedAt = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    saveLocalLedger();

    // Re-render if changes arrived or if manual refresh (avoid interrupting active typing inside an input/textarea)
    const activeTag = (document.activeElement && document.activeElement.tagName) || "";
    const isTyping = activeTag === "INPUT" || activeTag === "TEXTAREA" || activeTag === "SELECT";
    if ((changed || isManualRefresh) && (!isTyping || isManualRefresh)) {
      render();
    } else {
      updateHeaderIndicators();
    }
    if (isManualRefresh) {
      showToast("Synced latest live progress!", "🟢");
    }
  } catch (err) {
    console.warn("Live pull warning:", err);
    state.syncStatus = "offline";
    updateHeaderIndicators();
  } finally {
    isSyncing = false;
    if (pendingPushAfterSync) {
      pendingPushAfterSync = false;
      pushToCloudNow();
    }
  }
}

function scheduleCloudPush() {
  state.syncStatus = "syncing";
  updateHeaderIndicators();
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushToCloudNow();
  }, 180);
}

async function pushToCloudNow() {
  if (isSyncing) {
    pendingPushAfterSync = true;
    return;
  }
  isSyncing = true;
  state.syncStatus = "syncing";
  updateHeaderIndicators();

  try {
    // 1. Pull latest remote first so concurrent edits on other items are preserved, while our latest timestamp wins
    try {
      const remote = await fetchRemoteLedgerData();
      mergeRemoteItemsLastWriteWins(remote.items || {});
    } catch (_e) {
      // Proceed with push even if pre-read fails
    }

    recomputePacketStatsFromItems();
    const payload = {
      version: 2,
      updatedAt: new Date().toISOString(),
      items: state.ledger.items
    };

    const res = await fetch(`https://api.github.com/gists/${LIVE_GIST_ID}`, {
      method: "PATCH",
      headers: {
        Authorization: getLiveAuthHeader(),
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        files: {
          [LIVE_GIST_FILE]: {
            content: JSON.stringify(payload)
          }
        }
      })
    });
    if (!res.ok) throw new Error(`Cloud PATCH ${res.status}`);

    state.syncStatus = "synced";
    state.lastSyncedAt = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    saveLocalLedger();
  } catch (err) {
    console.warn("Live push warning:", err);
    state.syncStatus = "offline";
    updateHeaderIndicators();
  } finally {
    isSyncing = false;
    if (pendingPushAfterSync) {
      pendingPushAfterSync = false;
      pushToCloudNow();
    }
  }
}

window.syncLiveNow = function (manual = true) {
  pullFromCloud(manual);
};

function updateHeaderIndicators() {
  const dot = document.getElementById("sync-dot");
  const label = document.getElementById("sync-label");
  if (dot && label) {
    if (state.syncStatus === "syncing" || state.syncStatus === "connecting") {
      dot.className = "w-2 h-2 rounded-full bg-amber-500 animate-ping";
      label.textContent = "Syncing Live...";
    } else if (state.syncStatus === "synced") {
      dot.className = "w-2 h-2 rounded-full bg-emerald-500 animate-pulse";
      label.textContent = state.lastSyncedAt ? `Live · ${state.lastSyncedAt}` : "Live Synced";
    } else {
      dot.className = "w-2 h-2 rounded-full bg-blue-500";
      label.textContent = "Saved Locally";
    }
  }
  const flagCountEl = document.getElementById("header-flagged-count");
  if (flagCountEl) {
    const flaggedTotal = Object.values(state.ledger.items).filter((x) => x && x.status === "flagged").length;
    flagCountEl.textContent = String(flaggedTotal);
  }
}

// =============================================================================
// 2. INITIALIZATION & ROUTING
// =============================================================================

async function initApp() {
  if (localStorage.getItem(THEME_KEY) === "dark") {
    document.documentElement.classList.add("dark");
  }
  loadLocalLedger();

  try {
    const res = await fetch(`./data/manifest.json?t=${Date.now()}`);
    state.manifest = await res.json();
    recomputePacketStatsFromItems();
  } catch (err) {
    document.getElementById("app-root").innerHTML = `
      <div class="card-surface rounded-2xl p-8 text-center text-rose-600">
        <h2 class="font-extrabold text-lg">Failed to load Review Studio Manifest</h2>
        <p class="text-xs mt-1">${esc(err.message)}</p>
      </div>`;
    return;
  }

  window.addEventListener("hashchange", handleHashChange);
  await handleHashChange();

  // Immediately pull latest live state from cloud, then poll every 6s + on tab focus
  await pullFromCloud(false);
  setInterval(() => pullFromCloud(false), 6000);
  window.addEventListener("focus", () => pullFromCloud(false));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") pullFromCloud(false);
  });

  window.addEventListener("keydown", handleKeyboardShortcuts);
}

window.toggleDarkMode = function () {
  const isDark = document.documentElement.classList.toggle("dark");
  localStorage.setItem(THEME_KEY, isDark ? "dark" : "light");
};

window.goHomeDashboard = function () {
  state.activeWorkbench = null;
  state.currentPacketId = null;
  state.currentPacket = null;
  state.editingUid = null;
  window.location.hash = "#/";
};

window.goBackToWorkbench = function () {
  const wb = state.activeWorkbench || (state.currentPacket && state.currentPacket.workbench) || "pyqs";
  state.currentPacketId = null;
  state.currentPacket = null;
  state.editingUid = null;
  window.location.hash = `#/wb/${wb}`;
};

async function handleHashChange() {
  const hash = window.location.hash || "#/";
  const pktMatch = hash.match(/^#\/packet\/([a-zA-Z0-9_-]+)/);
  const wbMatch = hash.match(/^#\/wb\/([a-zA-Z0-9_-]+)/);

  if (pktMatch) {
    const pid = pktMatch[1];
    await openPacket(pid, false);
  } else if (wbMatch) {
    state.activeWorkbench = wbMatch[1];
    state.currentPacketId = null;
    state.currentPacket = null;
    state.editingUid = null;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } else {
    state.activeWorkbench = null;
    state.currentPacketId = null;
    state.currentPacket = null;
    state.editingUid = null;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

async function openPacket(packetId, updateHash = true) {
  if (updateHash) {
    window.location.hash = `#/packet/${packetId}`;
    return;
  }
  state.currentPacketId = packetId;
  state.loadingPacket = true;
  state.page = 1;
  state.editingUid = null;
  state.focusedIdx = -1;
  render();

  try {
    const res = await fetch(`./data/packets/${packetId}.json?t=${Date.now()}`);
    const pkt = await res.json();
    state.currentPacket = pkt;
    state.activeWorkbench = pkt.workbench || state.activeWorkbench;
    state.loadingPacket = false;
    recomputePacketStatsFromItems();
    saveLocalLedger();
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (err) {
    state.loadingPacket = false;
    showToast(`Could not load packet ${packetId}: ${err.message}`, "⚠️");
    render();
  }
}

// =============================================================================
// 3. ITEM STATE & APPROVAL / EDIT / FLAG ACTIONS
// =============================================================================

function getEffectiveItemState(item) {
  const overlay = state.ledger.items[item.uid];
  if (overlay) {
    return {
      status: overlay.status || "pending",
      at: overlay.at || null,
      note: overlay.note || "",
      edited: Boolean(overlay.edited),
      edits: overlay.edits || {}
    };
  }
  return {
    status: item.initialStatus || "pending",
    at: null,
    note: "",
    edited: false,
    edits: {}
  };
}

function getEffectiveItemContent(item) {
  const st = getEffectiveItemState(item);
  const edits = st.edits || {};
  if (item.kind === "mcq") {
    return {
      stem: edits.stem !== undefined ? edits.stem : item.stem,
      options: Array.isArray(edits.options) ? edits.options : item.options || [],
      correctIdx: edits.correctIdx !== undefined ? Number(edits.correctIdx) : Number(item.correctIdx) || 0,
      explanation: edits.explanation !== undefined ? edits.explanation : item.explanation || ""
    };
  }
  // fields kind
  const baseFields = item.fields || [];
  return {
    fields: baseFields.map((f) => ({
      ...f,
      value: edits[f.key] !== undefined ? edits[f.key] : f.value
    }))
  };
}

window.setItemStatus = function (uid, status, optionalNote = "") {
  if (!state.currentPacket) return;
  const item = state.currentPacket.items.find((x) => x.uid === uid);
  if (!item) return;

  const prev = state.ledger.items[uid] || {};
  let note = optionalNote;
  if (status === "flagged" && !note) {
    const prompted = prompt(`🚩 Why are you flagging "${item.title}"?\n(e.g., Wrong answer key, date typo, missing explanation)`, prev.note || "");
    if (prompted === null) return;
    note = prompted.trim() || "Flagged for review";
  }

  state.ledger.items[uid] = {
    status,
    at: Date.now(),
    note: status === "approved" ? (prev.note || "") : status === "pending" ? "" : note,
    edited: Boolean(prev.edited),
    edits: prev.edits || {},
    packetId: state.currentPacket.id
  };

  saveLocalLedger();
  scheduleCloudPush();

  showToast(
    status === "approved" ? `Approved: ${item.title}` : status === "flagged" ? `Flagged: ${item.title}` : `Reset: ${item.title}`,
    status === "approved" ? "✅" : status === "flagged" ? "🚩" : "↺"
  );
  render();
};

window.startEditItem = function (uid) {
  state.editingUid = state.editingUid === uid ? null : uid;
  render();
};

window.saveItemInlineEdits = function (uid) {
  if (!state.currentPacket) return;
  const item = state.currentPacket.items.find((x) => x.uid === uid);
  if (!item) return;

  const prev = state.ledger.items[uid] || {};
  const edits = { ...(prev.edits || {}) };

  if (item.kind === "mcq") {
    const stemEl = document.getElementById(`edit-stem-${uid}`);
    const expEl = document.getElementById(`edit-exp-${uid}`);
    const ansEl = document.getElementById(`edit-ans-${uid}`);
    if (stemEl) edits.stem = stemEl.value.trim();
    if (expEl) edits.explanation = expEl.value.trim();
    if (ansEl) edits.correctIdx = Number(ansEl.value);

    const baseOpts = item.options || [];
    const newOpts = [];
    for (let i = 0; i < Math.max(4, baseOpts.length); i++) {
      const optEl = document.getElementById(`edit-opt-${uid}-${i}`);
      if (optEl && optEl.value.trim() !== "") {
        newOpts.push(optEl.value.trim());
      } else if (i < baseOpts.length && optEl) {
        newOpts.push(optEl.value.trim());
      }
    }
    if (newOpts.length) edits.options = newOpts;
  } else {
    for (const f of item.fields || []) {
      const el = document.getElementById(`edit-field-${uid}-${f.key}`);
      if (el) edits[f.key] = el.value.trim();
    }
  }

  const noteEl = document.getElementById(`edit-note-${uid}`);
  const note = noteEl ? noteEl.value.trim() : prev.note || "";

  state.ledger.items[uid] = {
    status: "approved",
    at: Date.now(),
    note,
    edited: true,
    edits,
    packetId: state.currentPacket.id
  };
  state.editingUid = null;

  saveLocalLedger();
  scheduleCloudPush();

  showToast(`Saved edits & approved: ${item.title}`, "✏️");
  render();
};

window.batchApproveItems = function (scope) {
  if (!state.currentPacket) return;
  const filtered = getFilteredPacketItems();
  const targetItems =
    scope === "page"
      ? filtered.slice((state.page - 1) * state.pageSize, state.page * state.pageSize)
      : state.currentPacket.items;

  const unapproved = targetItems.filter((it) => getEffectiveItemState(it).status !== "approved");
  if (!unapproved.length) {
    showToast("All items in this view are already approved!", "✅");
    return;
  }
  if (!confirm(`Approve ${unapproved.length} items in "${state.currentPacket.title}"?`)) {
    return;
  }

  const now = Date.now();
  for (const it of unapproved) {
    const prev = state.ledger.items[it.uid] || {};
    state.ledger.items[it.uid] = {
      status: "approved",
      at: now,
      note: prev.note || "",
      edited: Boolean(prev.edited),
      edits: prev.edits || {},
      packetId: state.currentPacket.id
    };
  }

  saveLocalLedger();
  scheduleCloudPush();

  showToast(`Approved ${unapproved.length} items!`, "✅");
  render();
};

window.approvePacketFromDashboard = async function (packetId, event) {
  if (event) event.stopPropagation();
  const pktMeta = state.manifest.packets.find((p) => p.id === packetId);
  if (!pktMeta) return;
  if (!confirm(`Mark all ${pktMeta.itemCount} items in "${pktMeta.title}" as Approved?`)) return;

  try {
    const res = await fetch(`./data/packets/${packetId}.json?t=${Date.now()}`);
    const pkt = await res.json();
    const now = Date.now();
    for (const it of pkt.items || []) {
      const prev = state.ledger.items[it.uid] || {};
      state.ledger.items[it.uid] = {
        status: "approved",
        at: now,
        note: prev.note || "",
        edited: Boolean(prev.edited),
        edits: prev.edits || {},
        packetId
      };
    }
    saveLocalLedger();
    scheduleCloudPush();
    showToast(`100% Approved: ${pktMeta.title}`, "✅");
    render();
  } catch (e) {
    showToast(`Failed to load packet: ${e.message}`, "⚠️");
  }
};

// =============================================================================
// 4. ANALYTICS & PROGRESS COMPUTATION
// =============================================================================

function getPacketProgress(pktMeta) {
  const st = state.ledger.packetStats[pktMeta.id] || { approved: 0, flagged: 0, edited: 0 };
  const total = pktMeta.itemCount || 0;
  const approved = Math.min(total, st.approved || 0);
  const flagged = Math.min(total - approved, st.flagged || 0);
  const edited = st.edited || 0;
  const pending = Math.max(0, total - approved - flagged);
  const pct = total > 0 ? Math.round((approved / total) * 100) : 0;
  const isComplete = total > 0 && approved >= total;
  return { total, approved, flagged, edited, pending, pct, isComplete };
}

function getWorkbenchSummary(wbId) {
  const pkts = (state.manifest.packets || []).filter((p) => p.workbench === wbId);
  let totalItems = 0;
  let approvedItems = 0;
  let flaggedItems = 0;
  let editedItems = 0;
  let completedPackets = 0;

  for (const p of pkts) {
    const pr = getPacketProgress(p);
    totalItems += pr.total;
    approvedItems += pr.approved;
    flaggedItems += pr.flagged;
    editedItems += pr.edited;
    if (pr.isComplete) completedPackets++;
  }
  const pct = totalItems > 0 ? Math.round((approvedItems / totalItems) * 100) : 0;
  return {
    totalPackets: pkts.length,
    completedPackets,
    totalItems,
    approvedItems,
    flaggedItems,
    editedItems,
    pendingItems: Math.max(0, totalItems - approvedItems - flaggedItems),
    pct
  };
}

function getGlobalSummary() {
  let totalPackets = 0;
  let completedPackets = 0;
  let totalItems = 0;
  let approvedItems = 0;
  let flaggedItems = 0;
  let editedItems = 0;

  for (const wb of state.manifest.workbenches || []) {
    const s = getWorkbenchSummary(wb.id);
    totalPackets += s.totalPackets;
    completedPackets += s.completedPackets;
    totalItems += s.totalItems;
    approvedItems += s.approvedItems;
    flaggedItems += s.flaggedItems;
    editedItems += s.editedItems;
  }
  const pct = totalItems > 0 ? ((approvedItems / totalItems) * 100).toFixed(1) : "0.0";
  return {
    totalPackets,
    completedPackets,
    totalItems,
    approvedItems,
    flaggedItems,
    editedItems,
    pendingItems: Math.max(0, totalItems - approvedItems - flaggedItems),
    pct
  };
}

// =============================================================================
// 5. MASTER DASHBOARD & WORKBENCH VIEW RENDERER
// =============================================================================

function render() {
  const root = document.getElementById("app-root");
  if (!root || !state.manifest) return;

  if (state.currentPacketId) {
    root.innerHTML = renderPacketDetailView();
  } else if (state.activeWorkbench) {
    root.innerHTML = renderWorkbenchView();
  } else {
    root.innerHTML = renderHomeScreenView();
  }
  updateHeaderIndicators();
}

function renderHomeScreenView() {
  const global = getGlobalSummary();

  return `
    <div class="space-y-6 pb-12">
      <!-- 1. MASTER PROGRESS OVERVIEW BANNER -->
      <section class="card-surface rounded-3xl p-5 sm:p-6">
        <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div class="space-y-1">
            <div class="inline-flex items-center gap-2 text-xs font-extrabold uppercase tracking-wider text-blue-600 dark:text-blue-400">
              <span>📊 Master Content Verification Tracker</span>
              <span>·</span>
              <span>${global.completedPackets} / ${global.totalPackets} Packets Completed</span>
            </div>
            <h1 class="text-xl sm:text-2xl font-extrabold text-slate-900 dark:text-white">
              ${global.approvedItems.toLocaleString()} of ${global.totalItems.toLocaleString()} Total Items Verified (${global.pct}%)
            </h1>
            <p class="text-xs text-slate-500 dark:text-slate-400">
              Choose one of the 6 Content Categories below to open its dedicated verification screen.
            </p>
          </div>

          <!-- Global Status Counters -->
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5 shrink-0">
            <div class="px-3.5 py-2.5 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-center">
              <div class="font-mono text-lg font-extrabold text-emerald-600 dark:text-emerald-400">${global.approvedItems.toLocaleString()}</div>
              <div class="text-[10.5px] font-bold text-emerald-700 dark:text-emerald-300">✅ Approved</div>
            </div>
            <div class="px-3.5 py-2.5 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-center">
              <div class="font-mono text-lg font-extrabold text-amber-600 dark:text-amber-400">${global.editedItems.toLocaleString()}</div>
              <div class="text-[10.5px] font-bold text-amber-700 dark:text-amber-300">✏️ Edited & Fixed</div>
            </div>
            <button onclick="openGlobalStatusDrawer('flagged')" class="px-3.5 py-2.5 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-center hover:bg-rose-500/20 transition">
              <div class="font-mono text-lg font-extrabold text-rose-600 dark:text-rose-400">${global.flaggedItems.toLocaleString()}</div>
              <div class="text-[10.5px] font-bold text-rose-700 dark:text-rose-300">🚩 Flagged Issues</div>
            </button>
            <div class="px-3.5 py-2.5 rounded-2xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-center">
              <div class="font-mono text-lg font-extrabold text-slate-700 dark:text-slate-300">${global.pendingItems.toLocaleString()}</div>
              <div class="text-[10.5px] font-bold text-slate-500 dark:text-slate-400">⏳ Unapproved</div>
            </div>
          </div>
        </div>

        <!-- Master Progress Bar -->
        <div class="h-3 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden mt-4 flex">
          <div class="h-full bg-emerald-500 transition-all duration-300" style="width: ${(global.approvedItems / global.totalItems) * 100}%"></div>
          <div class="h-full bg-rose-500 transition-all duration-300" style="width: ${(global.flaggedItems / global.totalItems) * 100}%"></div>
        </div>
      </section>

      <!-- 2. THE 6 STANDALONE CATEGORY DOORS (Nothing cluttered below!) -->
      <section class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        ${state.manifest.workbenches
          .map((wb) => {
            const s = getWorkbenchSummary(wb.id);
            return `
              <button onclick="selectWorkbench('${wb.id}')" class="card-surface text-left p-6 rounded-3xl border-2 border-slate-200 dark:border-slate-800 hover:border-blue-500 hover:-translate-y-0.5 transition flex flex-col justify-between gap-5 group">
                <div class="space-y-2.5">
                  <div class="flex items-center justify-between gap-2">
                    <span class="w-12 h-12 rounded-2xl bg-blue-600/10 text-3xl flex items-center justify-center">${wb.icon}</span>
                    <span class="font-mono text-xs font-extrabold px-3 py-1 rounded-full ${
                      s.pct === 100
                        ? "bg-emerald-500 text-white"
                        : s.pct > 0
                          ? "bg-blue-600/15 text-blue-600 dark:text-blue-400"
                          : "bg-slate-100 dark:bg-slate-800 text-slate-500"
                    }">${s.pct}% Approved</span>
                  </div>
                  <h2 class="font-extrabold text-lg sm:text-xl text-slate-900 dark:text-white group-hover:text-blue-600 transition">${esc(wb.title)}</h2>
                  <p class="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">${esc(wb.description)}</p>
                </div>

                <div class="space-y-2.5 pt-2 border-t border-slate-100 dark:border-slate-800">
                  <div class="flex items-center justify-between text-xs font-mono font-bold">
                    <span class="text-emerald-600 dark:text-emerald-400">✅ ${s.approvedItems.toLocaleString()} / ${s.totalItems.toLocaleString()} items</span>
                    <span class="text-slate-500">${s.completedPackets} / ${s.totalPackets} packets</span>
                  </div>
                  <div class="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                    <div class="h-full bg-emerald-500 transition-all" style="width:${s.pct}%"></div>
                  </div>
                  <div class="flex items-center justify-between pt-1">
                    <span class="text-[11px] font-semibold text-slate-400">${s.pendingItems.toLocaleString()} remaining</span>
                    <span class="px-3.5 py-1.5 rounded-xl bg-blue-600 text-white text-xs font-extrabold group-hover:bg-blue-700 transition">Open ${esc(wb.shortTitle)} →</span>
                  </div>
                </div>
              </button>`;
          })
          .join("")}
      </section>
    </div>
  `;
}

function renderWorkbenchView() {
  const activeWbMeta = state.manifest.workbenches.find((w) => w.id === state.activeWorkbench) || state.manifest.workbenches[0];
  const wbSummary = getWorkbenchSummary(activeWbMeta.id);

  // Filter packets in active workbench
  const allWbPackets = state.manifest.packets.filter((p) => p.workbench === activeWbMeta.id);
  const q = state.packetSearch.trim().toLowerCase();
  const filteredPackets = allWbPackets.filter((p) => {
    const pr = getPacketProgress(p);
    if (state.packetFilter === "pending" && pr.approved > 0) return false;
    if (state.packetFilter === "in_progress" && (pr.approved === 0 || pr.isComplete)) return false;
    if (state.packetFilter === "approved" && !pr.isComplete) return false;
    if (state.packetFilter === "flagged" && pr.flagged === 0) return false;
    if (q) {
      const hay = `${p.code} ${p.title} ${p.subtitle} ${p.group}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // Group packets by p.group
  const groupsMap = new Map();
  for (const p of filteredPackets) {
    const g = p.group || "Packets";
    if (!groupsMap.has(g)) groupsMap.set(g, []);
    groupsMap.get(g).push(p);
  }

  return `
    <div class="space-y-6 pb-12">
      <!-- DEDICATED WORKBENCH SCREEN HEADER -->
      <section class="card-surface rounded-3xl p-5 space-y-4">
        <div class="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-4">
          <div class="flex items-start sm:items-center gap-3">
            <button onclick="goHomeDashboard()" class="px-3.5 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-xs font-extrabold shrink-0">
              ← All 6 Categories
            </button>
            <div>
              <div class="flex items-center gap-2">
                <span class="text-2xl">${activeWbMeta.icon}</span>
                <h1 class="text-lg sm:text-xl font-extrabold text-slate-900 dark:text-white">${esc(activeWbMeta.title)}</h1>
              </div>
              <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">${esc(activeWbMeta.description)}</p>
            </div>
          </div>
          <div class="flex items-center gap-3 text-xs font-bold shrink-0">
            <span class="px-3 py-1.5 rounded-xl bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
              ✅ ${wbSummary.completedPackets} / ${wbSummary.totalPackets} Packets Approved (${wbSummary.approvedItems.toLocaleString()} / ${wbSummary.totalItems.toLocaleString()} items)
            </span>
          </div>
        </div>

        <!-- Filter Pills + Packet Search -->
        <div class="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
          <div class="flex flex-wrap gap-1.5">
            ${[
              ["all", `All Packets (${allWbPackets.length})`],
              ["pending", "⚪ Not Started"],
              ["in_progress", "🚧 In Progress"],
              ["approved", "✅ 100% Approved"],
              ["flagged", "🚩 Has Flagged Items"]
            ]
              .map(
                ([key, label]) => `
                <button onclick="setPacketFilter('${key}')" class="px-3 py-1.5 rounded-xl text-xs font-bold transition ${
                  state.packetFilter === key
                    ? "bg-blue-600 text-white shadow-sm"
                    : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200"
                }">${esc(label)}</button>`
              )
              .join("")}
          </div>

          <div class="relative min-w-[240px]">
            <input
              type="text"
              value="${esc(state.packetSearch)}"
              oninput="setPacketSearch(this.value)"
              placeholder="Search paper, mock, game, era..."
              class="w-full pl-8 pr-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 focus:outline-none focus:border-blue-500"
            />
            <span class="absolute left-2.5 top-2 text-xs text-slate-400">🔍</span>
          </div>
        </div>
      </section>

      <!-- PACKETS LIST BY GROUP -->
      ${
        filteredPackets.length === 0
          ? `<div class="card-surface rounded-2xl p-10 text-center text-slate-500 text-sm font-semibold">No packets match this filter.</div>`
          : Array.from(groupsMap.entries())
              .map(
                ([groupTitle, pkts]) => `
                <section class="space-y-3">
                  <div class="flex items-center justify-between px-1">
                    <h3 class="text-xs font-extrabold uppercase tracking-wider text-slate-500 dark:text-slate-400">${esc(groupTitle)} (${pkts.length})</h3>
                  </div>
                  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    ${pkts.map(renderPacketCard).join("")}
                  </div>
                </section>`
              )
              .join("")
      }
    </div>
  `;
}

function renderPacketCard(p) {
  const pr = getPacketProgress(p);

  let statusBadge = `<span class="px-2 py-0.5 rounded-md text-[10px] font-extrabold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">⚪ NOT STARTED</span>`;
  let borderTone = "border-slate-200 dark:border-slate-800";

  if (pr.isComplete) {
    statusBadge = `<span class="px-2 py-0.5 rounded-md text-[10px] font-extrabold bg-emerald-500 text-white">✅ 100% APPROVED</span>`;
    borderTone = "border-emerald-500/60 bg-emerald-50/20 dark:bg-emerald-950/10";
  } else if (pr.flagged > 0) {
    statusBadge = `<span class="px-2 py-0.5 rounded-md text-[10px] font-extrabold bg-rose-500 text-white">🚩 ${pr.flagged} FLAGGED</span>`;
    borderTone = "border-rose-400/60";
  } else if (pr.approved > 0) {
    statusBadge = `<span class="px-2 py-0.5 rounded-md text-[10px] font-extrabold bg-amber-500/20 text-amber-700 dark:text-amber-300">🚧 ${pr.pct}% DONE</span>`;
    borderTone = "border-blue-400/50";
  }

  return `
    <div onclick="openPacket('${p.id}')" class="card-surface rounded-2xl p-4 border-2 ${borderTone} hover:border-blue-500 transition cursor-pointer flex flex-col justify-between gap-3">
      <div class="space-y-2">
        <div class="flex items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="font-mono text-[11px] font-extrabold px-2 py-0.5 rounded bg-blue-600/10 text-blue-600 dark:text-blue-400">${esc(p.code)}</span>
            ${p.keySourceBadge ? `<span class="px-1.5 py-0.5 rounded text-[10px] font-extrabold ${p.hasOfficialKey ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300"}">${esc(p.keySourceBadge)}</span>` : ""}
          </div>
          ${statusBadge}
        </div>

        <h4 class="font-extrabold text-sm sm:text-base text-slate-900 dark:text-white leading-snug">${esc(p.title)}</h4>
        <p class="text-xs text-slate-500 dark:text-slate-400 line-clamp-2">${esc(p.subtitle)}</p>
      </div>

      <div class="space-y-2.5 pt-1">
        <!-- Progress Bar & Counts -->
        <div>
          <div class="flex items-center justify-between text-[11px] font-mono font-bold mb-1">
            <span class="text-emerald-600 dark:text-emerald-400">${pr.approved} / ${pr.total} Approved</span>
            <span class="text-slate-400">${pr.pending} left</span>
          </div>
          <div class="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden flex">
            <div class="h-full bg-emerald-500" style="width:${(pr.approved / Math.max(1, pr.total)) * 100}%"></div>
            <div class="h-full bg-rose-500" style="width:${(pr.flagged / Math.max(1, pr.total)) * 100}%"></div>
          </div>
        </div>

        <!-- Actions Row -->
        <div class="flex items-center justify-between gap-2 pt-1 border-t border-slate-100 dark:border-slate-800/80">
          <span class="text-[11px] font-semibold text-slate-400">
            ${pr.edited > 0 ? `✏️ ${pr.edited} edited` : `${pr.total} items`}
          </span>

          <div class="flex items-center gap-1.5">
            ${
              !pr.isComplete
                ? `<button onclick="approvePacketFromDashboard('${p.id}', event)" class="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500 hover:text-white transition" title="Mark entire packet Approved">✓ Approve All</button>`
                : ""
            }
            <span class="px-2.5 py-1 rounded-lg text-[11px] font-extrabold bg-blue-600 text-white">Verify →</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

window.selectWorkbench = function (wbId) {
  state.activeWorkbench = wbId;
  state.packetFilter = "all";
  state.packetSearch = "";
  window.location.hash = `#/wb/${wbId}`;
};

window.setPacketFilter = function (f) {
  state.packetFilter = f;
  render();
};

window.setPacketSearch = function (val) {
  state.packetSearch = val;
  render();
};

// =============================================================================
// 6. PACKET DETAIL VIEW (HIGH-SPEED PROOFREADER FEED)
// =============================================================================

function getFilteredPacketItems() {
  if (!state.currentPacket) return [];
  const q = state.itemSearch.trim().toLowerCase();
  return (state.currentPacket.items || []).filter((it) => {
    const st = getEffectiveItemState(it);
    if (state.itemFilter === "pending" && st.status !== "pending") return false;
    if (state.itemFilter === "approved" && st.status !== "approved") return false;
    if (state.itemFilter === "flagged" && st.status !== "flagged") return false;
    if (state.itemFilter === "edited" && !st.edited) return false;
    if (q) {
      const content = getEffectiveItemContent(it);
      const hay = JSON.stringify({ t: it.title, m: it.meta, content, note: st.note }).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderPacketDetailView() {
  if (state.loadingPacket || !state.currentPacket) {
    return `
      <div class="card-surface rounded-3xl p-12 text-center">
        <div class="inline-block w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mb-3"></div>
        <div class="font-bold text-sm">Loading Packet Items...</div>
      </div>`;
  }

  const pkt = state.currentPacket;
  const allItems = pkt.items || [];
  let approvedCount = 0;
  let flaggedCount = 0;
  let editedCount = 0;
  for (const it of allItems) {
    const st = getEffectiveItemState(it);
    if (st.status === "approved") approvedCount++;
    if (st.status === "flagged") flaggedCount++;
    if (st.edited) editedCount++;
  }
  const pendingCount = Math.max(0, allItems.length - approvedCount - flaggedCount);
  const pct = allItems.length ? Math.round((approvedCount / allItems.length) * 100) : 0;

  const filtered = getFilteredPacketItems();
  const totalPages = Math.max(1, Math.ceil(filtered.length / state.pageSize));
  if (state.page > totalPages) state.page = totalPages;
  const startIdx = (state.page - 1) * state.pageSize;
  const pageItems = filtered.slice(startIdx, startIdx + state.pageSize);

  return `
    <div class="space-y-4 pb-16">
      <!-- STICKY PACKET CONTROL HEADER -->
      <div class="card-surface rounded-3xl p-4 sm:p-5 space-y-3.5 border-2 border-blue-500/20">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex items-center gap-3">
            <button onclick="goBackToWorkbench()" class="px-3 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-xs font-extrabold flex items-center gap-1.5">
              ← Back to Packets
            </button>
            <div>
              <div class="flex items-center gap-2">
                <span class="font-mono text-xs font-extrabold px-2 py-0.5 rounded bg-blue-600/15 text-blue-600 dark:text-blue-400">${esc(pkt.code)}</span>
                <span class="text-xs font-bold text-slate-500">${esc(pkt.group || "")}</span>
                ${pkt.keySourceBadge ? `<span class="px-2 py-0.5 rounded text-[11px] font-extrabold ${pkt.hasOfficialKey ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30" : "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border border-indigo-500/30"}">${esc(pkt.keySourceBadge)}</span>` : ""}
              </div>
              <h1 class="font-extrabold text-base sm:text-xl text-slate-900 dark:text-white mt-0.5">${esc(pkt.title)}</h1>
            </div>
          </div>

          <!-- Batch Approve Buttons -->
          <div class="flex flex-wrap items-center gap-2">
            <button onclick="batchApproveItems('page')" class="px-3 py-2 rounded-xl text-xs font-extrabold bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm transition">
              ✓ Approve Page (${pageItems.length})
            </button>

            <button onclick="batchApproveItems('packet')" class="px-3 py-2 rounded-xl text-xs font-extrabold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 hover:bg-emerald-600 hover:text-white transition">
              ✓ Approve All ${allItems.length} in Packet
            </button>
          </div>
        </div>

        <!-- Packet Progress Bar -->
        <div>
          <div class="flex items-center justify-between text-xs font-bold mb-1">
            <span class="text-emerald-600 dark:text-emerald-400">✅ ${approvedCount} / ${allItems.length} Approved (${pct}%)</span>
            <span class="text-slate-500 text-[11px]">Shortcuts: <kbd class="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 font-mono">J/K</kbd> Next/Prev · <kbd class="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 font-mono">A</kbd> Approve · <kbd class="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 font-mono">E</kbd> Edit · <kbd class="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 font-mono">F</kbd> Flag</span>
          </div>
          <div class="h-2.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden flex">
            <div class="h-full bg-emerald-500 transition-all" style="width:${(approvedCount / Math.max(1, allItems.length)) * 100}%"></div>
            <div class="h-full bg-rose-500 transition-all" style="width:${(flaggedCount / Math.max(1, allItems.length)) * 100}%"></div>
          </div>
        </div>

        <!-- Filter Tabs + Search Inside Packet -->
        <div class="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 pt-1">
          <div class="flex flex-wrap gap-1.5">
            ${[
              ["all", `All (${allItems.length})`],
              ["pending", `⏳ Unapproved (${pendingCount})`],
              ["approved", `✅ Approved (${approvedCount})`],
              ["edited", `✏️ Edited (${editedCount})`],
              ["flagged", `🚩 Flagged (${flaggedCount})`]
            ]
              .map(
                ([k, label]) => `
                <button onclick="setItemFilter('${k}')" class="px-3 py-1.5 rounded-xl text-xs font-bold transition ${
                  state.itemFilter === k
                    ? "bg-blue-600 text-white"
                    : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200"
                }">${esc(label)}</button>`
              )
              .join("")}
          </div>

          <div class="relative min-w-[240px]">
            <input
              type="text"
              value="${esc(state.itemSearch)}"
              oninput="setItemSearch(this.value)"
              placeholder="Search inside this packet..."
              class="w-full pl-8 pr-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 focus:outline-none focus:border-blue-500"
            />
            <span class="absolute left-2.5 top-2 text-xs text-slate-400">🔍</span>
          </div>
        </div>
      </div>

      <!-- PAGINATION TOP -->
      ${renderPaginationBar(filtered.length, totalPages)}

      <!-- ITEMS VERTICAL FEED -->
      <div class="space-y-3.5">
        ${
          pageItems.length === 0
            ? `<div class="card-surface rounded-2xl p-12 text-center text-slate-500 font-bold text-sm">No items match this filter in this packet.</div>`
            : pageItems.map((it, idx) => renderVerifiableItemCard(it, idx)).join("")
        }
      </div>

      <!-- PAGINATION BOTTOM -->
      ${renderPaginationBar(filtered.length, totalPages)}
    </div>
  `;
}

function renderPaginationBar(totalFiltered, totalPages) {
  if (totalPages <= 1) return "";
  return `
    <div class="flex items-center justify-between px-4 py-2.5 rounded-2xl card-surface text-xs font-bold">
      <span class="text-slate-500">Showing page ${state.page} of ${totalPages} (${totalFiltered} items)</span>
      <div class="flex items-center gap-1.5">
        <button ${state.page <= 1 ? "disabled" : ""} onclick="setItemPage(${state.page - 1})" class="px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 disabled:opacity-40">← Prev</button>
        <button ${state.page >= totalPages ? "disabled" : ""} onclick="setItemPage(${state.page + 1})" class="px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 disabled:opacity-40">Next →</button>
      </div>
    </div>
  `;
}

window.setItemFilter = function (f) {
  state.itemFilter = f;
  state.page = 1;
  render();
};

window.setItemSearch = function (val) {
  state.itemSearch = val;
  state.page = 1;
  render();
};

window.setItemPage = function (p) {
  state.page = p;
  state.focusedIdx = -1;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
};

function renderVerifiableItemCard(item, idxOnPage) {
  const st = getEffectiveItemState(item);
  const content = getEffectiveItemContent(item);
  const isEditing = state.editingUid === item.uid;
  const isFocused = state.focusedIdx === idxOnPage;

  let cardBorder = "border-slate-200 dark:border-slate-800";
  let statusPill = `<span class="px-2.5 py-0.5 rounded-full text-[11px] font-extrabold bg-slate-100 dark:bg-slate-800 text-slate-500">⏳ Unapproved</span>`;

  if (st.status === "approved") {
    cardBorder = "border-emerald-500/70 bg-emerald-50/15 dark:bg-emerald-950/10";
    statusPill = `<span class="px-2.5 py-0.5 rounded-full text-[11px] font-extrabold bg-emerald-500 text-white">✅ Approved</span>`;
  } else if (st.status === "flagged") {
    cardBorder = "border-rose-500 bg-rose-50/20 dark:bg-rose-950/20";
    statusPill = `<span class="px-2.5 py-0.5 rounded-full text-[11px] font-extrabold bg-rose-500 text-white">🚩 Flagged</span>`;
  }

  const editedBadge = st.edited
    ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-amber-500 text-white">✏️ EDITED</span>`
    : "";

  return `
    <article id="item-card-${idxOnPage}" class="card-surface rounded-2xl p-4 sm:p-5 border-2 ${cardBorder} ${isFocused ? "focused-card" : ""} space-y-3.5 transition">
      <!-- Top Row: Item Title, Metadata Badges & Status -->
      <div class="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 dark:border-slate-800 pb-3">
        <div class="space-y-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-mono text-xs font-extrabold px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">#${item.number}</span>
            <h3 class="font-extrabold text-sm sm:text-base text-slate-900 dark:text-white">${esc(item.title)}</h3>
            <span class="px-2 py-0.5 rounded text-[11px] font-bold bg-blue-500/10 text-blue-600 dark:text-blue-400">${esc(item.badge || "")}</span>
            ${editedBadge}
          </div>
          ${item.meta ? `<div class="text-xs text-slate-500 dark:text-slate-400 font-medium">${esc(item.meta)}</div>` : ""}
        </div>

        <div class="flex items-center gap-2">
          ${statusPill}
        </div>
      </div>

      <!-- Note Banner (if flagged or commented) -->
      ${
        st.note
          ? `<div class="p-3 rounded-xl text-xs font-semibold ${
              st.status === "flagged"
                ? "bg-rose-500/10 text-rose-700 dark:text-rose-300 border border-rose-500/30"
                : "bg-amber-500/10 text-amber-800 dark:text-amber-300 border border-amber-500/30"
            }">
              <strong>Note:</strong> ${esc(st.note)}
            </div>`
          : ""
      }

      <!-- BODY: Either Normal Read View or Inline Editor -->
      ${isEditing ? renderItemInlineEditor(item, content, st) : item.kind === "mcq" ? renderMcqBody(item, content) : renderFieldsBody(item, content)}

      <!-- ACTION FOOTER -->
      <div class="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
        <div class="text-[11px] font-mono text-slate-400">ID: ${esc(item.uid)}</div>
        <div class="flex flex-wrap items-center gap-2">
          <button
            onclick="setItemStatus('${item.uid}', 'approved')"
            class="px-3.5 py-1.5 rounded-xl text-xs font-extrabold transition ${
              st.status === "approved"
                ? "bg-emerald-600 text-white shadow-sm"
                : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-600 hover:text-white"
            }"
          >
            ✓ ${st.status === "approved" ? "Approved" : "Approve"}
          </button>

          <button
            onclick="startEditItem('${item.uid}')"
            class="px-3.5 py-1.5 rounded-xl text-xs font-extrabold bg-blue-500/15 text-blue-700 dark:text-blue-300 hover:bg-blue-600 hover:text-white transition"
          >
            ✏️ ${isEditing ? "Cancel Edit" : "Edit & Approve"}
          </button>

          <button
            onclick="setItemStatus('${item.uid}', 'flagged')"
            class="px-3.5 py-1.5 rounded-xl text-xs font-extrabold ${
              st.status === "flagged"
                ? "bg-rose-600 text-white"
                : "bg-rose-500/15 text-rose-600 dark:text-rose-400 hover:bg-rose-600 hover:text-white"
            } transition"
          >
            🚩 Flag Issue
          </button>

          ${
            st.status !== "pending"
              ? `<button onclick="setItemStatus('${item.uid}', 'pending')" class="px-2.5 py-1.5 rounded-xl text-xs font-bold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">↺ Reset</button>`
              : ""
          }
        </div>
      </div>
    </article>
  `;
}

function renderMcqBody(item, content) {
  const opts = content.options || [];
  const cIdx = Number(content.correctIdx) || 0;

  return `
    <div class="space-y-3">
      <!-- Question Stem -->
      <div class="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/70 border border-slate-200/80 dark:border-slate-700/70 text-sm font-semibold leading-relaxed stem-pre text-slate-900 dark:text-slate-100">${esc(content.stem)}</div>

      <!-- Options List with Highlighted Answer Key -->
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
        ${opts
          .map((opt, oIdx) => {
            const isCorrect = oIdx === cIdx;
            const letter = String.fromCharCode(65 + oIdx);
            return `
              <div class="p-3 rounded-xl border-2 flex items-start gap-2.5 text-xs sm:text-sm ${
                isCorrect
                  ? "border-emerald-500 bg-emerald-500/10 text-emerald-950 dark:text-emerald-100 font-bold"
                  : "border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300"
              }">
                <span class="w-6 h-6 rounded-lg font-mono text-xs font-extrabold flex items-center justify-center shrink-0 ${
                  isCorrect ? "bg-emerald-500 text-white" : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400"
                }">${letter}</span>
                <div class="flex-1 leading-snug">
                  <div>${esc(opt)}</div>
                  ${isCorrect ? `<div class="text-[10px] font-extrabold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 mt-1">${item.answerSource === "Official NTA Key" ? "🏛️ Official NTA/UGC Answer Key" : "✓ Verified Correct Answer"} (${letter})</div>` : ""}
                </div>
              </div>`;
          })
          .join("")}
      </div>

      <!-- Explanation Box with Full View / Expansion Trigger -->
      <div class="p-3.5 rounded-xl bg-blue-50/70 dark:bg-blue-950/30 border border-blue-200/80 dark:border-blue-900/60 text-xs sm:text-sm leading-relaxed">
        <div class="flex flex-wrap items-center justify-between gap-2 mb-1.5 pb-1 border-b border-blue-200/50 dark:border-blue-900/50">
          <div class="flex items-center gap-2">
            <span class="font-extrabold text-blue-700 dark:text-blue-300 uppercase text-[11px] tracking-wider">💡 Teaching Explanation:</span>
            ${content.explanation && (content.explanation.trim().endsWith("...") || content.explanation.trim().endsWith("…")) ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-amber-500/20 text-amber-800 dark:text-amber-200 border border-amber-500/30">⚠️ Truncation Detected (...)</span>` : ""}
          </div>
          ${content.explanation ? `
            <div class="flex items-center gap-1.5">
              <span class="text-[10px] font-mono text-slate-400 dark:text-slate-500">${content.explanation.length} chars</span>
              <button onclick="openFullExplanationModal('${item.uid}')" class="px-2.5 py-1 rounded-lg text-[11px] font-extrabold bg-blue-600 text-white hover:bg-blue-700 transition shadow-xs flex items-center gap-1" title="Open full unabridged explanation in large modal">
                <span>🔍 View Complete Explanation</span>
              </button>
            </div>
          ` : ""}
        </div>
        <div id="exp-text-${item.uid}" class="stem-pre text-slate-800 dark:text-slate-200">${
          content.explanation ? esc(content.explanation) : `<span class="italic text-rose-500">No explanation text provided yet. Click Edit to add one.</span>`
        }</div>
      </div>
    </div>
  `;
}

function renderFieldsBody(item, content) {
  const fields = content.fields || [];
  return `
    <div class="grid grid-cols-1 gap-2.5">
      ${fields
        .filter((f) => f.value !== undefined && f.value !== "")
        .map(
          (f) => {
            const isExpl = f.key === "explanation" || /explanation/i.test(f.label || "");
            const isLong = String(f.value).length > 120;
            return `
            <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/70 dark:border-slate-700/60">
              <div class="flex items-center justify-between gap-2 mb-1">
                <div class="text-[10.5px] font-extrabold uppercase tracking-wider text-blue-600 dark:text-blue-400">${esc(f.label)}</div>
                ${isExpl || isLong ? `
                  <button onclick="openFullExplanationModal('${item.uid}', '${esc(f.key)}')" class="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-600/10 hover:bg-blue-600/20 text-blue-700 dark:text-blue-300 transition">
                    🔍 View Complete Text
                  </button>
                ` : ""}
              </div>
              <div class="text-xs sm:text-sm text-slate-800 dark:text-slate-200 leading-relaxed stem-pre">${esc(f.value)}</div>
            </div>`;
          }
        )
        .join("")}
    </div>
  `;
}

function renderItemInlineEditor(item, content, st) {
  if (item.kind === "mcq") {
    const opts = content.options || ["", "", "", ""];
    return `
      <div class="p-4 rounded-2xl bg-blue-50/50 dark:bg-slate-800/90 border-2 border-blue-500/40 space-y-3">
        <div class="text-xs font-extrabold uppercase tracking-wider text-blue-600 dark:text-blue-400">✏️ Inline Question, Answer Key & Explanation Editor</div>

        <div>
          <label class="block text-xs font-bold mb-1">Question Stem:</label>
          <textarea id="edit-stem-${item.uid}" rows="4" class="w-full p-2.5 rounded-xl text-xs sm:text-sm bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700">${esc(content.stem)}</textarea>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          ${[0, 1, 2, 3]
            .slice(0, Math.max(4, opts.length))
            .map(
              (i) => `
              <div>
                <label class="block text-xs font-bold mb-1">Option ${String.fromCharCode(65 + i)}:</label>
                <input id="edit-opt-${item.uid}-${i}" type="text" value="${esc(opts[i] || "")}" class="w-full p-2 rounded-xl text-xs sm:text-sm bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700" />
              </div>`
            )
            .join("")}
        </div>

        <div>
          <label class="block text-xs font-bold mb-1">Correct Answer Key:</label>
          <select id="edit-ans-${item.uid}" class="p-2 rounded-xl text-xs sm:text-sm font-bold bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700">
            ${[0, 1, 2, 3]
              .slice(0, Math.max(4, opts.length))
              .map(
                (i) => `<option value="${i}" ${Number(content.correctIdx) === i ? "selected" : ""}>Option ${String.fromCharCode(65 + i)}</option>`
              )
              .join("")}
          </select>
        </div>

        <div>
          <div class="flex items-center justify-between mb-1">
            <label class="block text-xs font-bold">Explanation (Full Teaching Solution):</label>
            <span class="text-[10px] text-slate-400">Crisp, simple English · Never use templates</span>
          </div>
          <textarea id="edit-exp-${item.uid}" rows="5" class="w-full p-2.5 rounded-xl text-xs sm:text-sm bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 font-normal leading-relaxed min-h-[120px]">${esc(content.explanation)}</textarea>
        </div>

        <div>
          <label class="block text-xs font-bold mb-1">Note (optional):</label>
          <input id="edit-note-${item.uid}" type="text" value="${esc(st.note || "")}" placeholder="What did you fix? (e.g., Corrected answer key from B to C)" class="w-full p-2 rounded-xl text-xs bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700" />
        </div>

        <div class="flex justify-end gap-2 pt-1">
          <button onclick="startEditItem('${item.uid}')" class="px-3.5 py-2 rounded-xl text-xs font-bold bg-slate-200 dark:bg-slate-700">Cancel</button>
          <button onclick="saveItemInlineEdits('${item.uid}')" class="px-4 py-2 rounded-xl text-xs font-extrabold bg-emerald-600 hover:bg-emerald-700 text-white shadow">💾 Save Fix & Mark Approved</button>
        </div>
      </div>
    `;
  }

  // Fields editor
  return `
    <div class="p-4 rounded-2xl bg-blue-50/50 dark:bg-slate-800/90 border-2 border-blue-500/40 space-y-3">
      <div class="text-xs font-extrabold uppercase tracking-wider text-blue-600 dark:text-blue-400">✏️ Inline Content & Data Editor</div>
      ${(content.fields || [])
        .map(
          (f) => `
          <div>
            <label class="block text-xs font-bold mb-1">${esc(f.label)}:</label>
            <textarea id="edit-field-${item.uid}-${f.key}" rows="${String(f.value || "").length > 140 ? 4 : 2}" class="w-full p-2.5 rounded-xl text-xs sm:text-sm bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700">${esc(f.value || "")}</textarea>
          </div>`
        )
        .join("")}
      <div>
        <label class="block text-xs font-bold mb-1">Note (optional):</label>
        <input id="edit-note-${item.uid}" type="text" value="${esc(st.note || "")}" placeholder="What did you update?" class="w-full p-2 rounded-xl text-xs bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700" />
      </div>
      <div class="flex justify-end gap-2 pt-1">
        <button onclick="startEditItem('${item.uid}')" class="px-3.5 py-2 rounded-xl text-xs font-bold bg-slate-200 dark:bg-slate-700">Cancel</button>
        <button onclick="saveItemInlineEdits('${item.uid}')" class="px-4 py-2 rounded-xl text-xs font-extrabold bg-emerald-600 hover:bg-emerald-700 text-white shadow">💾 Save Fix & Mark Approved</button>
      </div>
    </div>
  `;
}

// =============================================================================
// 6B. FULL-SCREEN UNABRIDGED EXPLANATION & CONTENT MODAL
// =============================================================================

window.copyToClipboard = function (text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast("Explanation copied to clipboard!", "📋");
    }).catch(() => {
      fallbackCopy(text);
    });
  } else {
    fallbackCopy(text);
  }
};

function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
  showToast("Explanation copied to clipboard!", "📋");
}

window.openFullExplanationModal = function (uid, fieldKey = null) {
  if (!state.currentPacket) return;
  const item = state.currentPacket.items.find((x) => x.uid === uid);
  if (!item) return;
  const content = getEffectiveItemContent(item);
  const st = getEffectiveItemState(item);

  let explanationText = "";
  let fieldLabel = "Teaching Explanation";

  if (fieldKey && content.fields) {
    const fld = content.fields.find((f) => f.key === fieldKey);
    if (fld) {
      explanationText = fld.value || "";
      fieldLabel = fld.label || fieldKey;
    }
  } else if (item.kind === "mcq") {
    explanationText = content.explanation || "";
  } else if (content.fields) {
    const explField = content.fields.find((f) => f.key === "explanation" || /explanation/i.test(f.label || ""));
    if (explField) {
      explanationText = explField.value || "";
      fieldLabel = explField.label || "Explanation";
    } else {
      explanationText = content.explanation || "";
    }
  }

  const m = document.getElementById("modal-root");
  if (!m) return;

  const wordCount = explanationText.trim() ? explanationText.trim().split(/\s+/).length : 0;
  const charCount = explanationText.length;
  const isPotentiallyTruncated = explanationText.trim().endsWith("...") || explanationText.trim().endsWith("…");

  m.innerHTML = `
    <div class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-3 sm:p-6" onclick="closeModal()">
      <div class="card-surface rounded-3xl max-w-3xl w-full max-h-[92vh] overflow-y-auto p-5 sm:p-7 space-y-4 shadow-2xl border border-slate-200 dark:border-slate-800" onclick="event.stopPropagation()">

        <!-- Header -->
        <div class="flex items-start justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-3">
          <div>
            <div class="flex flex-wrap items-center gap-2 mb-1">
              <span class="font-mono text-xs font-extrabold px-2 py-0.5 rounded bg-blue-600/10 text-blue-600 dark:text-blue-400">#${item.number || ""}</span>
              <span class="font-mono text-xs text-slate-400">UID: ${esc(item.uid)}</span>
              <span class="px-2 py-0.5 rounded text-[11px] font-bold bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">${esc(item.badge || "")}</span>
            </div>
            <h3 class="font-extrabold text-base sm:text-lg text-slate-900 dark:text-white leading-snug">${esc(item.title)}</h3>
          </div>
          <button onclick="closeModal()" class="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 font-bold text-sm hover:bg-slate-200 dark:hover:bg-slate-700 transition shrink-0">✕</button>
        </div>

        ${item.kind === "mcq" ? `
          <!-- Question Stem -->
          <div class="space-y-1">
            <span class="text-[11px] font-extrabold uppercase tracking-wider text-slate-500">Question Stem</span>
            <div class="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-xs sm:text-sm font-semibold stem-pre text-slate-900 dark:text-slate-100">${esc(content.stem)}</div>
          </div>

          <!-- Options -->
          <div class="space-y-1">
            <span class="text-[11px] font-extrabold uppercase tracking-wider text-slate-500">Options & Answer Key</span>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
              ${(content.options || []).map((opt, i) => {
                const isCorrect = i === Number(content.correctIdx);
                const letter = String.fromCharCode(65 + i);
                return `
                  <div class="p-2.5 rounded-xl border text-xs ${isCorrect ? "border-emerald-500 bg-emerald-500/10 font-bold text-emerald-950 dark:text-emerald-100" : "border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900 text-slate-700 dark:text-slate-300"} flex items-start gap-2">
                    <span class="w-5 h-5 rounded font-mono text-[11px] font-extrabold flex items-center justify-center shrink-0 ${isCorrect ? "bg-emerald-500 text-white" : "bg-slate-200 dark:bg-slate-800"}">${letter}</span>
                    <div class="flex-1">${esc(opt)} ${isCorrect ? `<span class="text-[10px] text-emerald-600 dark:text-emerald-400 block font-extrabold">✓ Verified Correct Answer</span>` : ""}</div>
                  </div>
                `;
              }).join("")}
            </div>
          </div>
        ` : ""}

        <!-- Complete Full Explanation -->
        <div class="space-y-2">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <span class="text-xs font-extrabold uppercase tracking-wider text-blue-600 dark:text-blue-400">💡 Full Unabridged ${esc(fieldLabel)}</span>
              <span class="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-blue-500/15 text-blue-700 dark:text-blue-300">${wordCount} words · ${charCount} chars</span>
              ${isPotentiallyTruncated ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-amber-500/20 text-amber-800 dark:text-amber-200 border border-amber-500/30">⚠️ Source ends with "..."</span>` : ""}
            </div>
            <button id="copy-modal-exp-btn" class="px-3 py-1 rounded-lg text-xs font-bold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition flex items-center gap-1">
              📋 Copy Text
            </button>
          </div>

          <div class="p-4 sm:p-5 rounded-2xl bg-blue-50/80 dark:bg-blue-950/40 border-2 border-blue-200 dark:border-blue-900 text-sm sm:text-base leading-relaxed stem-pre text-slate-900 dark:text-slate-100 shadow-inner">
            ${explanationText ? esc(explanationText) : `<span class="italic text-rose-500">No explanation provided yet. Click "Edit Explanation" below to write one.</span>`}
          </div>
        </div>

        <!-- Footer -->
        <div class="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-200 dark:border-slate-800">
          <button onclick="closeModal()" class="px-4 py-2 rounded-xl text-xs font-bold bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 transition">
            Close
          </button>
          <div class="flex items-center gap-2">
            <button onclick="closeModal(); startEditItem('${item.uid}')" class="px-4 py-2 rounded-xl text-xs font-extrabold bg-blue-600 hover:bg-blue-700 text-white shadow transition">
              ✏️ Edit Explanation / Question
            </button>
            <button onclick="setItemStatus('${item.uid}', 'approved'); closeModal();" class="px-4 py-2 rounded-xl text-xs font-extrabold bg-emerald-600 hover:bg-emerald-700 text-white shadow transition">
              ✓ Mark Approved
            </button>
          </div>
        </div>

      </div>
    </div>
  `;

  const copyBtn = document.getElementById("copy-modal-exp-btn");
  if (copyBtn) {
    copyBtn.onclick = () => window.copyToClipboard(explanationText);
  }
};

// =============================================================================
// 7. FLAGGED ITEMS DRAWER
// =============================================================================

window.closeModal = function () {
  const m = document.getElementById("modal-root");
  if (m) m.innerHTML = "";
};

window.openGlobalStatusDrawer = function (statusType = "flagged") {
  const m = document.getElementById("modal-root");
  if (!m) return;
  const entries = Object.entries(state.ledger.items).filter(([, rec]) => rec && rec.status === statusType);

  m.innerHTML = `
    <div class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onclick="closeModal()">
      <div class="card-surface rounded-3xl max-w-2xl w-full max-h-[85vh] overflow-y-auto p-6 space-y-4 shadow-2xl" onclick="event.stopPropagation()">
        <div class="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
          <div>
            <h3 class="font-extrabold text-lg text-rose-600 dark:text-rose-400">🚩 All Flagged Items Across Database (${entries.length})</h3>
            <p class="text-xs text-slate-500">Click any flagged item below to jump straight to its packet and resolve or edit it.</p>
          </div>
          <button onclick="closeModal()" class="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 font-bold text-sm">✕</button>
        </div>

        <div class="space-y-2">
          ${
            entries.length === 0
              ? `<div class="p-8 text-center text-slate-500 text-sm font-semibold">🎉 Zero flagged items right now!</div>`
              : entries
                  .map(
                    ([uid, rec]) => `
                    <div class="p-3.5 rounded-2xl bg-rose-500/5 border border-rose-500/20 flex items-center justify-between gap-3">
                      <div class="min-w-0">
                        <div class="font-mono text-xs font-extrabold text-rose-600">${esc(uid)}</div>
                        <div class="text-xs font-bold text-slate-800 dark:text-slate-200 mt-0.5">${esc(rec.note || "Flagged for review")}</div>
                        <div class="text-[11px] text-slate-400 mt-0.5">Packet: ${esc(rec.packetId || "")}</div>
                      </div>
                      ${
                        rec.packetId
                          ? `<button onclick="closeModal(); state.itemFilter='flagged'; openPacket('${rec.packetId}');" class="px-3 py-1.5 rounded-xl bg-rose-600 text-white text-xs font-extrabold shrink-0">Open Packet →</button>`
                          : ""
                      }
                    </div>`
                  )
                  .join("")
          }
        </div>
      </div>
    </div>
  `;
};

// =============================================================================
// 8. KEYBOARD SHORTCUTS (J/K move, A approve, E edit, F flag)
// =============================================================================

function handleKeyboardShortcuts(e) {
  if (!state.currentPacket) return;
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || state.editingUid) return;

  const filtered = getFilteredPacketItems();
  const pageItems = filtered.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
  if (!pageItems.length) return;

  if (e.key === "j" || e.key === "J") {
    e.preventDefault();
    state.focusedIdx = Math.min(pageItems.length - 1, state.focusedIdx + 1);
    render();
    const el = document.getElementById(`item-card-${state.focusedIdx}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  } else if (e.key === "k" || e.key === "K") {
    e.preventDefault();
    state.focusedIdx = Math.max(0, state.focusedIdx - 1);
    render();
    const el = document.getElementById(`item-card-${state.focusedIdx}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  } else if (e.key === "a" || e.key === "A") {
    const idx = state.focusedIdx >= 0 ? state.focusedIdx : 0;
    const item = pageItems[idx];
    if (item) {
      e.preventDefault();
      window.setItemStatus(item.uid, "approved");
    }
  } else if (e.key === "e" || e.key === "E") {
    const idx = state.focusedIdx >= 0 ? state.focusedIdx : 0;
    const item = pageItems[idx];
    if (item) {
      e.preventDefault();
      window.startEditItem(item.uid);
    }
  } else if (e.key === "f" || e.key === "F") {
    const idx = state.focusedIdx >= 0 ? state.focusedIdx : 0;
    const item = pageItems[idx];
    if (item) {
      e.preventDefault();
      window.setItemStatus(item.uid, "flagged");
    }
  }
}

initApp();
