(function () {
  "use strict";

  /* ════════════════════════════════════════════════
   * 1. 전역 상태 & 상수
   * ════════════════════════════════════════════════ */
  var TRACK = "intermediate";

  // LocalStorage 키
  var STORE_KEY    = "vibecoding_map_v1";
  var LIST_KEY     = "vibecoding_list_v1";
  var SEED_VER_KEY = "vibecoding_seed_version";
  var BODY_VER_KEY = "vibecoding_body_version";

  // 학습 상태 상수 (0: 미학습, 1: 학습중, 2: 완료)
  var STATUS = { TODO: 0, LEARNING: 1, DONE: 2 };
  var STATUS_LABELS = {
    0: "○ Preview",
    1: "◐ Study",
    2: "● Clear",
  };

  var STATE = {};     // { [subId]: { status, notes, updatedAt } }
  var LIST  = {};     // { [topicId]: [{ id, title }, ...] }

  var saveTimer     = null;
  var listSaveTimer = null;
  var DRAFTS        = {}; // 세션 내 미저장 임시 초안


  /* ════════════════════════════════════════════════
   * 2. LocalStorage 퍼시스턴스
   * ════════════════════════════════════════════════ */
  function loadState() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      STATE = raw ? JSON.parse(raw) : {};
    } catch (e) {
      STATE = {};
    }
  }

  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(STATE)); } catch (e) {}
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 400);
  }

  function persistListLocal() {
    try { localStorage.setItem(LIST_KEY, JSON.stringify(LIST)); } catch (e) {}
  }

  function persistList() {
    persistListLocal();
    saveListRemote();
  }

  function scheduleListSave() {
    if (listSaveTimer) clearTimeout(listSaveTimer);
    listSaveTimer = setTimeout(flushListSave, 400);
  }

  function flushListSave() {
    if (!listSaveTimer) return;
    clearTimeout(listSaveTimer);
    listSaveTimer = null;
    persistList();
  }


  /* ════════════════════════════════════════════════
   * 3. 데이터 접근 헬퍼
   * ════════════════════════════════════════════════ */
  function entry(subId) {
    if (!STATE[subId]) STATE[subId] = { status: STATUS.TODO, notes: "", updatedAt: null };
    return STATE[subId];
  }

  function getSubtopics(topic) {
    return LIST[topic.id] || [];
  }

  function isActive(topic, s) {
    if (TRACK === "intermediate") return true;
    var isUserAdded = s.id.indexOf(topic.id + "-c") === 0;
    return !!BEGINNER_IDS[s.id] || isUserAdded;
  }

  function isTouched(subId) {
    var e = STATE[subId];
    if (!e) return false;
    return (e.status || STATUS.TODO) !== STATUS.TODO || (e.notes || "") !== (BODIES[subId] || "");
  }


  /* ════════════════════════════════════════════════
   * 4. 목록(LIST) CRUD
   * ════════════════════════════════════════════════ */
  function loadList() {
    var hadList = false, storedVer = 0, raw = null;
    try {
      raw = localStorage.getItem(LIST_KEY);
      hadList = !!raw;
      storedVer = Number(localStorage.getItem(SEED_VER_KEY) || (hadList ? 1 : 0));
    } catch (e) {}

    var parsed = {};
    try { parsed = raw ? JSON.parse(raw) : {}; } catch (e) { parsed = {}; }
    LIST = reconcileList(parsed, storedVer);

    if (storedVer < SEED_VERSION) {
      persistListLocal();
      try { localStorage.setItem(SEED_VER_KEY, String(SEED_VERSION)); } catch (e) {}
    }
  }

  function reconcileList(list, storedVer) {
    var offered = previouslyOfferedIds(storedVer);
    var out = {};
    Object.keys(list || {}).forEach(function (k) { out[k] = list[k]; });
    TOPICS.forEach(function (t) {
      var oldList = out[t.id];
      if (!oldList) {
        out[t.id] = t.subtopics.map(function (s) { return { id: s.id, title: s.title }; });
      } else if (storedVer < SEED_VERSION) {
        out[t.id] = migrateTopic(t, oldList, offered);
      }
    });
    return out;
  }

  function previouslyOfferedIds(storedVer) {
    var ids = {};
    if (storedVer >= 1) {
      Object.keys(V1_SEED_COUNTS).forEach(function (k) {
        var spec = V1_SEED_COUNTS[k];
        for (var i = 1; i <= spec[1]; i++) ids[spec[0] + "-" + i] = true;
      });
    }
    if (storedVer >= 2) {
      TOPICS.forEach(function (t) {
        t.subtopics.forEach(function (s) { if (!ADDED_IN_V3[s.id]) ids[s.id] = true; });
      });
    }
    return ids;
  }

  function migrateTopic(topic, oldList, offered) {
    var oldById = {};
    oldList.forEach(function (o) { oldById[o.id] = o; });

    var seedIds = {};
    var result  = [];

    topic.subtopics.forEach(function (s) {
      seedIds[s.id] = true;
      if (oldById[s.id]) result.push({ id: s.id, title: oldById[s.id].title });
      else if (!offered[s.id]) result.push({ id: s.id, title: s.title });
    });

    oldList.forEach(function (o) {
      if (seedIds[o.id]) return;
      var st = STATE[o.id];
      var hasData = st && ((st.notes && st.notes !== (BODIES[o.id] || "")) || st.status);
      if (!offered[o.id] || hasData) result.push(o);
    });
    return result;
  }

  function applySeedBodies() {
    var stored = 0;
    try { stored = Number(localStorage.getItem(BODY_VER_KEY) || 0); } catch (e) {}
    if (stored >= BODY_VERSION) return;
    TOPICS.forEach(function (t) {
      getSubtopics(t).forEach(function (s) {
        var body = BODIES[s.id];
        if (!body) return;
        var e = entry(s.id);
        if (!e.notes) e.notes = body;
      });
    });
    persist();
    try { localStorage.setItem(BODY_VER_KEY, String(BODY_VERSION)); } catch (e) {}
  }

  function addSubtopic(topicId, title) {
    var id = topicId + "-c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    if (!LIST[topicId]) LIST[topicId] = [];
    LIST[topicId].push({ id: id, title: title });
    persistList();
    return id;
  }

  function renameSubtopic(topicId, subId, title) {
    var item = (LIST[topicId] || []).filter(function (x) { return x.id === subId; })[0];
    if (item) { item.title = title; scheduleListSave(); }
  }

  function deleteSubtopic(topicId, subId) {
    LIST[topicId] = (LIST[topicId] || []).filter(function (x) { return x.id !== subId; });
    persistList();
    delete STATE[subId];
    persist();
    deleteItemRemote(subId);
  }


  /* ════════════════════════════════════════════════
   * 5. Firebase 원격 동기화 (큐 기반)
   * ════════════════════════════════════════════════ */
  var SYNC         = { ready: false, profileRef: null, itemsRef: null };
  var pendingWrites = {};
  var pendingOrder  = [];
  var writing       = false;

  function queueWrite(key, ref, build) {
    if (!SYNC.ready) return;
    if (!pendingWrites[key]) pendingOrder.push(key);
    pendingWrites[key] = { ref: ref, build: build, retried: false };
    pumpWrites();
  }

  function pumpWrites() {
    if (writing) return;
    var key = pendingOrder.shift();
    if (!key) return;
    var job = pendingWrites[key];
    delete pendingWrites[key];
    writing = true;
    var payload = job.build();
    var op = payload === null ? job.ref.delete() : job.ref.set(payload);
    op.then(function () {
      writing = false;
      pumpWrites();
    }, function (err) {
      writing = false;
      if (err && err.code === "unavailable" && !job.retried) {
        job.retried = true;
        setTimeout(function () {
          if (!pendingWrites[key]) { pendingWrites[key] = job; pendingOrder.push(key); }
          pumpWrites();
        }, 700 + Math.random() * 800);
      }
      pumpWrites();
    });
  }

  function listPayload() {
    return { list: LIST, seedVersion: SEED_VERSION, updatedAt: Date.now() };
  }

  function itemPayload(subId) {
    var e = STATE[subId];
    if (!e) return null;
    return { status: e.status || STATUS.TODO, notes: e.notes || "", updatedAt: e.updatedAt || null };
  }

  function saveListRemote() {
    queueWrite("profile", SYNC.profileRef, listPayload);
  }

  function saveItemRemote(subId) {
    if (!SYNC.ready) return;
    queueWrite("item:" + subId, SYNC.itemsRef.doc(subId), function () { return itemPayload(subId); });
  }

  function deleteItemRemote(subId) {
    if (!SYNC.ready) return;
    queueWrite("item:" + subId, SYNC.itemsRef.doc(subId), function () { return null; });
  }


  /* ════════════════════════════════════════════════
   * 6. Firebase 인증 & 데이터 싱크
   * ════════════════════════════════════════════════ */
  var profileUnsub = null;   // 실시간 리스너 해제 함수
  var itemsUnsub   = null;

  async function startSync(user) {
    if (!user) { stopSync(); return; }

    var db  = window.fbDb;
    var uid = user.uid;

    try {
      var profileRef = db.doc("data/users/" + uid + "/profile");
      var itemsRef   = profileRef.collection("items");

      SYNC.profileRef = profileRef;
      SYNC.itemsRef   = itemsRef;

      // ── 최초 1회: 프로필 + 아이템 읽기 ──
      var profileSnap = await profileRef.get();
      var itemsSnap   = await itemsRef.limit(1000).get();

      if (profileSnap.exists) {
        var data      = profileSnap.data() || {};
        var storedVer = Number(data.seedVersion || 0);
        LIST = reconcileList(data.list || {}, storedVer);

        // 서버 아이템 병합
        var next = {};
        itemsSnap.docs.forEach(function (d) {
          var v = d.data() || {};
          next[d.id] = {
            status:    Number(v.status) || STATUS.TODO,
            notes:     typeof v.notes === "string" ? v.notes : "",
            updatedAt: v.updatedAt || null,
          };
        });
        // 서버에 없는 항목은 기본값 채우기
        Object.keys(LIST).forEach(function (k) {
          LIST[k].forEach(function (s) {
            if (!next[s.id]) next[s.id] = { status: STATUS.TODO, notes: BODIES[s.id] || "", updatedAt: null };
          });
        });
        STATE = next;
        SYNC.ready = true;
        if (storedVer < SEED_VERSION) saveListRemote();

      } else {
        // 최초 연결: 이 기기의 데이터를 서버로 업로드
        SYNC.ready = true;
        saveListRemote();
        Object.keys(LIST).forEach(function (k) {
          LIST[k].forEach(function (s) { if (isTouched(s.id)) saveItemRemote(s.id); });
        });
      }

      persist();
      persistListLocal();
      renderAll();
      if (drawer.classList.contains("open") && drawerTopic) renderSubList(drawerTopic);

      // ── 실시간 리스너: 프로필(LIST) 변경 감지 ──
      if (profileUnsub) profileUnsub();
      var firstProfileSnap = true;
      profileUnsub = profileRef.onSnapshot(function (snap) {
        if (firstProfileSnap) { firstProfileSnap = false; return; } // 최초는 이미 처리함
        if (!snap.exists) return;
        var d = snap.data() || {};
        var ver = Number(d.seedVersion || 0);
        LIST = reconcileList(d.list || {}, ver);
        persistListLocal();
        renderAll();
        if (drawer.classList.contains("open") && drawerTopic) renderSubList(drawerTopic);
      });

      // ── 실시간 리스너: 아이템(STATE) 변경 감지 ──
      if (itemsUnsub) itemsUnsub();
      var firstItemsSnap = true;
      itemsUnsub = itemsRef.onSnapshot(function (snap) {
        if (firstItemsSnap) { firstItemsSnap = false; return; }
        snap.docChanges().forEach(function (change) {
          var id = change.doc.id;
          var v  = change.doc.data() || {};
          if (change.type === "removed") {
            delete STATE[id];
          } else {
            STATE[id] = {
              status:    Number(v.status) || STATUS.TODO,
              notes:     typeof v.notes === "string" ? v.notes : "",
              updatedAt: v.updatedAt || null,
            };
          }
        });
        persist();
        renderAll();
        if (drawer.classList.contains("open") && drawerTopic) renderSubList(drawerTopic);
      });

    } catch (err) {
      console.error(err);
      SYNC.ready = false;
      renderAll();
    }
  }

  function stopSync() {
    SYNC.ready = false;
    if (profileUnsub) { profileUnsub(); profileUnsub = null; }
    if (itemsUnsub)   { itemsUnsub();   itemsUnsub   = null; }
  }

  function initAuth() {
    var loginBtn   = document.getElementById("loginBtn");
    var loginLabel = document.getElementById("loginLabel");
    if (!loginBtn) return;

    loginBtn.addEventListener("click", function () {
      if (window.fbAuth.currentUser) {
        if (confirm("로그아웃 하시겠습니까?")) window.fbAuth.signOut();
      } else {
        var provider = new firebase.auth.GoogleAuthProvider();
        window.fbAuth.signInWithPopup(provider).catch(function (error) {
          console.error(error);
          alert("로그인 중 오류가 발생했습니다.");
        });
      }
    });

    window.fbAuth.onAuthStateChanged(function (user) {
      if (user) {
        loginLabel.textContent = "로그아웃";
        startSync(user);
      } else {
        loginLabel.textContent = "Google 로그인";
        stopSync();
        loadState();
        loadList();
        renderAll();
      }
    });
  }


  /* ════════════════════════════════════════════════
   * 7. 진행률 계산
   * ════════════════════════════════════════════════ */
  function requireLogin() {
    if (!window.fbAuth || !window.fbAuth.currentUser) {
      alert("항목을 수정하려면 구글 로그인이 필요합니다.");
      return false;
    }
    return true;
  }

  function topicProgress(topic) {
    var subs = getSubtopics(topic).filter(function (s) { return isActive(topic, s); });
    var done = 0;
    subs.forEach(function (s) {
      var st = entry(s.id).status;
      if (st === STATUS.DONE) done += 1;
    });
    return { done: done, total: subs.length };
  }

  function overallProgress() {
    var done = 0, total = 0;
    TOPICS.forEach(function (t) {
      var p = topicProgress(t);
      done  += p.done;
      total += p.total;
    });
    return { done: done, total: total };
  }


  /* ════════════════════════════════════════════════
   * 8. 렌더링
   * ════════════════════════════════════════════════ */
  function fmtTime(ts) {
    if (!ts) return "—";
    var d  = new Date(ts);
    var hh = String(d.getHours()).padStart(2, "0");
    var mm = String(d.getMinutes()).padStart(2, "0");
    return hh + ":" + mm;
  }

  /** 헤더 진행률 바 & 수치 갱신 */
  function renderHeader() {
    var o   = overallProgress();
    var pct = o.total ? (o.done / o.total * 100) : 0;
    document.getElementById("doneCount").textContent  = Math.round(o.done);
    document.getElementById("totalCount").textContent = o.total;
    document.getElementById("headerFill").style.width = pct + "%";
  }

  /** SVG 다이어그램 노드 진행률 갱신 */
  function renderDiagram() {
    TOPICS.forEach(function (t) {
      var p   = topicProgress(t);
      var pct = p.total ? (p.done / p.total) : 0;

      var fillEl = document.querySelector('.node-fill[data-fill="' + t.id + '"]');
      if (fillEl) {
        var trackEl = fillEl.previousElementSibling;
        var fullW   = parseFloat(trackEl.getAttribute("width"));
        fillEl.setAttribute("width", Math.max(0, fullW * pct));
      }

      var countEl = document.querySelector('.node-count[data-count="' + t.id + '"]');
      if (countEl) countEl.textContent = Math.round(p.done) + "/" + p.total;
    });
  }

  /** 모바일 리스트 뷰 재렌더링 */
  function renderListView() {
    var wrap = document.getElementById("listView");
    wrap.innerHTML = "";
    TOPICS.forEach(function (t) {
      var p   = topicProgress(t);
      var pct = p.total ? (p.done / p.total * 100) : 0;
      var card = document.createElement("button");
      card.className = "list-card";
      card.setAttribute("data-topic", t.id);
      card.innerHTML =
        '<span class="list-body">' +
          '<span class="list-title">' + t.name + '</span>' +
          '<span class="list-sub">'   + t.sub  + '</span>' +
          '<span class="progress-track small list-track"><span class="progress-fill" style="width:' + pct + '%"></span></span>' +
        '</span>' +
        '<span class="list-count mono">' + Math.round(p.done) + '/' + p.total + '</span>';
      card.addEventListener("click", function () { openDrawer(t.id); });
      wrap.appendChild(card);
    });
  }

  /** 드로어 진행률 바 갱신 */
  function renderDrawerProgress(topic) {
    var p   = topicProgress(topic);
    var pct = p.total ? (p.done / p.total * 100) : 0;
    document.getElementById("drawerFill").style.width  = pct + "%";
    document.getElementById("drawerCount").textContent = Math.round(p.done) + "/" + p.total;
  }

  /** 헤더 + 다이어그램 + 리스트 한번에 갱신 */
  function renderAll() {
    renderHeader();
    renderDiagram();
    renderListView();
  }

  /** 상태 칩 텍스트 & data-status 갱신 */
  function setChip(chip, status) {
    chip.setAttribute("data-status", status);
    chip.textContent = STATUS_LABELS[status] || STATUS_LABELS[STATUS.TODO];
  }


  /* ════════════════════════════════════════════════
   * 9. 드로어 패널
   * ════════════════════════════════════════════════ */
  var drawer      = document.getElementById("drawer");
  var scrim       = document.getElementById("scrim");
  var drawerTopic = null;

  function openDrawer(topicId) {
    var topic = TOPICS.filter(function (t) { return t.id === topicId; })[0];
    if (!topic) return;
    drawerTopic = topic;
    document.getElementById("drawerTitle").textContent = topic.name;
    document.getElementById("drawerDesc").textContent  = topic.desc;
    renderSubList(topic);
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    scrim.classList.add("open");
  }

  function closeDrawer() {
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    scrim.classList.remove("open");
  }

  function renderSubList(topic) {
    var list = document.getElementById("subList");
    list.innerHTML = "";
    var subs = getSubtopics(topic);

    subs.forEach(function (s) {
      var e   = entry(s.id);
      var row = document.createElement("div");
      row.className = "sub-row";
      row.tabIndex  = 0;
      row.setAttribute("role",       "button");
      row.setAttribute("aria-label", s.title + " 열기");

      // 상태 칩
      var chip = document.createElement("button");
      chip.className = "status-chip";
      chip.type      = "button";
      setChip(chip, e.status);
      chip.addEventListener("click", function (ev) {
        ev.stopPropagation();
        if (!requireLogin()) return;
        e.status    = (e.status + 1) % 3;
        e.updatedAt = Date.now();
        setChip(chip, e.status);
        scheduleSave();
        saveItemRemote(s.id);
        renderDiagram();
        renderListView();
        renderDrawerProgress(topic);
        renderHeader();
      });

      // 제목
      var title = document.createElement("span");
      title.className   = "sub-card-title";
      title.textContent = s.title;

      // 비활성(중급 전용) 처리
      if (!isActive(topic, s)) {
        row.className = "sub-row is-disabled";
        row.removeAttribute("role");
        row.tabIndex = -1;
        row.setAttribute("aria-disabled", "true");
        row.setAttribute("aria-label",    s.title + " (중급 과정, 비활성)");
        chip.disabled = true;
        var levelTag = document.createElement("span");
        levelTag.className   = "level-tag";
        levelTag.textContent = "중급";
        row.appendChild(chip);
        row.appendChild(title);
        row.appendChild(levelTag);
        list.appendChild(row);
        return;
      }

      // 삭제 버튼
      var del = document.createElement("button");
      del.className = "del-btn";
      del.type      = "button";
      del.setAttribute("aria-label", "항목 삭제");
      del.textContent = "삭제";
      del.addEventListener("click", function (ev) {
        ev.stopPropagation();
        if (!requireLogin()) return;
        showConfirm(
          "항목을 삭제할까요?",
          '"' + s.title + '" 항목과 작성한 메모가 함께 삭제되며, 되돌릴 수 없습니다.',
          function () {
            deleteSubtopic(topic.id, s.id);
            renderSubList(topic);
            renderDiagram();
            renderListView();
            renderHeader();
          }
        );
      });

      row.appendChild(chip);
      row.appendChild(title);
      row.appendChild(del);

      row.addEventListener("click", function () { openNoteModal(topic, s); });
      row.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openNoteModal(topic, s); }
      });

      list.appendChild(row);
    });

    // 새 항목 추가 버튼
    var addBtn = document.createElement("button");
    addBtn.type      = "button";
    addBtn.className = "add-row";
    addBtn.textContent = "+ 새 항목 추가";
    addBtn.addEventListener("click", function () { 
      if (!requireLogin()) return;
      openNewNoteModal(topic); 
    });
    list.appendChild(addBtn);

    renderDrawerProgress(topic);
  }


  /* ════════════════════════════════════════════════
   * 10. 노트 모달
   * ════════════════════════════════════════════════ */
  var noteModal      = document.getElementById("noteModal");
  var noteScrim      = document.getElementById("noteScrim");
  var noteTextarea   = document.getElementById("noteTextarea");
  var noteChip       = document.getElementById("noteChip");
  var noteTitleInput = document.getElementById("noteTitleInput");
  var noteSaveHint   = document.getElementById("noteSaveHint");
  var noteSaveBtn    = document.getElementById("noteSaveBtn");
  var currentNote    = null;

  function openNoteModal(topic, sub) {
    currentNote = { topicId: topic.id, subId: sub.id };
    var e = entry(sub.id);
    noteTitleInput.value = sub.title;
    setChip(noteChip, e.status);
    var draft = DRAFTS[sub.id];
    noteTextarea.value = draft !== undefined ? draft : (e.notes || "");
    setNoteDirty(draft !== undefined);
    
    var loggedIn = window.fbAuth && window.fbAuth.currentUser;
    noteTitleInput.readOnly = !loggedIn;
    noteTextarea.readOnly = !loggedIn;
    noteSaveBtn.style.display = loggedIn ? "" : "none";
    
    showNoteModal();
    setTimeout(function () { if (loggedIn) noteTextarea.focus(); }, 60);
  }

  function openNewNoteModal(topic) {
    currentNote = { topicId: topic.id, subId: null, isNew: true, status: STATUS.TODO };
    noteTitleInput.value = "";
    noteTextarea.value   = "";
    setChip(noteChip, STATUS.TODO);
    setNoteDirty(false);
    
    noteTitleInput.readOnly = false;
    noteTextarea.readOnly = false;
    noteSaveBtn.style.display = "";
    
    showNoteModal();
    setTimeout(function () { noteTitleInput.focus(); }, 60);
  }

  function showNoteModal() {
    noteTitleInput.classList.remove("need-title");
    noteModal.classList.add("open");
    noteModal.setAttribute("aria-hidden", "false");
    noteScrim.classList.add("open");
  }

  function closeNoteModal() {
    noteModal.classList.remove("open");
    noteModal.setAttribute("aria-hidden", "true");
    noteScrim.classList.remove("open");
    currentNote = null;
  }

  function attemptCloseNoteModal() {
    if (noteSaveHint.classList.contains("dirty")) {
      showConfirm(
        "변경사항 취소",
        "저장하지 않은 내용은 모두 사라집니다. 편집을 취소하고 나가시겠습니까?",
        function () {
          if (currentNote && currentNote.subId) delete DRAFTS[currentNote.subId];
          closeNoteModal();
        }
      );
      return;
    }
    closeNoteModal();
  }

  function setNoteDirty(dirty) {
    if (dirty) {
      noteSaveHint.textContent = "저장되지 않은 변경사항이 있습니다";
      noteSaveHint.classList.add("dirty");
    } else if (currentNote && currentNote.isNew) {
      noteSaveHint.textContent = "새 항목 — 제목과 본문을 입력하고 저장하세요";
      noteSaveHint.classList.remove("dirty");
    } else {
      var e = currentNote ? entry(currentNote.subId) : null;
      noteSaveHint.textContent = "마지막 저장: " + (e ? fmtTime(e.updatedAt) : "—");
      noteSaveHint.classList.remove("dirty");
    }
  }

  function refreshNoteNewState() {
    var hasInput = noteTitleInput.value.trim() !== "" || noteTextarea.value.trim() !== "";
    setNoteDirty(hasInput);
  }

  function nudgeSaveBtn() {
    noteSaveBtn.classList.remove("nudge");
    void noteSaveBtn.offsetWidth;
    noteSaveBtn.classList.add("nudge");
  }

  function currentTopic() {
    if (!currentNote) return null;
    return TOPICS.filter(function (t) { return t.id === currentNote.topicId; })[0] || null;
  }

  function refreshAfterChange() {
    renderDiagram();
    renderListView();
    renderHeader();
    var topic = currentTopic();
    if (topic) {
      renderDrawerProgress(topic);
      if (drawer.classList.contains("open")) renderSubList(topic);
    }
  }


  /* ════════════════════════════════════════════════
   * 11. 확인 다이얼로그
   * ════════════════════════════════════════════════ */
  var confirmScrim    = document.getElementById("confirmScrim");
  var confirmDialog   = document.getElementById("confirmDialog");
  var confirmTitleEl  = document.getElementById("confirmTitle");
  var confirmBodyEl   = document.getElementById("confirmBody");
  var confirmOkBtn    = document.getElementById("confirmOk");
  var confirmCancelBtn = document.getElementById("confirmCancel");
  var pendingConfirm  = null;

  function showConfirm(title, body, onConfirm) {
    confirmTitleEl.textContent = title;
    confirmBodyEl.textContent  = body;
    pendingConfirm = onConfirm;
    confirmDialog.classList.add("open");
    confirmDialog.setAttribute("aria-hidden", "false");
    confirmScrim.classList.add("open");
  }

  function hideConfirm() {
    confirmDialog.classList.remove("open");
    confirmDialog.setAttribute("aria-hidden", "true");
    confirmScrim.classList.remove("open");
    pendingConfirm = null;
  }


  /* ════════════════════════════════════════════════
   * 12. 이벤트 리스너 초기화
   * ════════════════════════════════════════════════ */
  function initEvents() {
    // ── 드로어 ──
    document.getElementById("closeDrawer").addEventListener("click", closeDrawer);
    scrim.addEventListener("click", closeDrawer);

    // ── SVG 다이어그램 노드 클릭 ──
    document.querySelectorAll(".node").forEach(function (node) {
      node.addEventListener("click", function () { openDrawer(node.getAttribute("data-topic")); });
      node.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          openDrawer(node.getAttribute("data-topic"));
        }
      });
    });

    // ── 노트 모달 ──
    document.getElementById("noteClose").addEventListener("click", attemptCloseNoteModal);
    noteScrim.addEventListener("click", attemptCloseNoteModal);

    noteTextarea.addEventListener("input", function () {
      if (!currentNote) return;
      if (currentNote.isNew) { refreshNoteNewState(); return; }
      DRAFTS[currentNote.subId] = noteTextarea.value;
      setNoteDirty(true);
    });

    noteTitleInput.addEventListener("input", function () {
      if (!currentNote) return;
      noteTitleInput.classList.remove("need-title");
      if (currentNote.isNew) { refreshNoteNewState(); return; }
      renameSubtopic(currentNote.topicId, currentNote.subId, noteTitleInput.value);
      var topic = currentTopic();
      if (topic && drawer.classList.contains("open")) renderSubList(topic);
    });
    noteTitleInput.addEventListener("blur", flushListSave);

    noteSaveBtn.addEventListener("click", function () {
      if (!currentNote) return;
      if (currentNote.isNew) {
        var title = noteTitleInput.value.trim();
        if (!title) {
          noteTitleInput.classList.add("need-title");
          noteTitleInput.focus();
          nudgeSaveBtn();
          return;
        }
        currentNote.subId   = addSubtopic(currentNote.topicId, title);
        entry(currentNote.subId).status = currentNote.status;
        currentNote.isNew   = false;
      }
      var e = entry(currentNote.subId);
      e.notes     = noteTextarea.value;
      e.updatedAt = Date.now();
      persist();
      saveItemRemote(currentNote.subId);
      delete DRAFTS[currentNote.subId];
      setNoteDirty(false);
      refreshAfterChange();
      var original = noteSaveBtn.textContent;
      noteSaveBtn.textContent = "저장됨";
      setTimeout(function () { noteSaveBtn.textContent = original; }, 1100);
    });

    noteChip.addEventListener("click", function () {
      if (!currentNote) return;
      if (!requireLogin()) return;
      if (currentNote.isNew) {
        currentNote.status = (currentNote.status + 1) % 3;
        setChip(noteChip, currentNote.status);
        return;
      }
      var e = entry(currentNote.subId);
      e.status    = (e.status + 1) % 3;
      e.updatedAt = Date.now();
      setChip(noteChip, e.status);
      scheduleSave();
      saveItemRemote(currentNote.subId);
      refreshAfterChange();
    });

    // ── 확인 다이얼로그 ──
    confirmOkBtn.addEventListener("click", function () {
      var fn = pendingConfirm;
      hideConfirm();
      if (fn) fn();
    });
    confirmCancelBtn.addEventListener("click", hideConfirm);
    confirmScrim.addEventListener("click", hideConfirm);

    // ── 트랙 전환 버튼 ──
    var trackBtn = document.getElementById("trackBtn");
    trackBtn.addEventListener("click", function () {
      TRACK = TRACK === "beginner" ? "intermediate" : "beginner";
      applyTrack();
    });

    // ── Escape 키 ──
    document.addEventListener("keydown", function (ev) {
      if (ev.key !== "Escape") return;
      if (confirmDialog.classList.contains("open")) hideConfirm();
      else if (noteModal.classList.contains("open")) attemptCloseNoteModal();
      else closeDrawer();
    });
  }


  /* ════════════════════════════════════════════════
   * 13. 트랙(초보자/중급자) 전환
   * ════════════════════════════════════════════════ */
  function applyTrack() {
    var beginner = TRACK === "beginner";
    document.documentElement.setAttribute("data-track", TRACK);
    document.getElementById("trackLabel").textContent = beginner ? "초보자용" : "중급자용";
    document.getElementById("trackBtn").title = beginner
      ? "클릭하면 중급자용으로 전환합니다"
      : "클릭하면 초보자용으로 전환합니다";
    document.getElementById("legendOff").hidden = !beginner;
    renderAll();
    if (drawer.classList.contains("open") && drawerTopic) renderSubList(drawerTopic);
  }


  /* ════════════════════════════════════════════════
   * 14. 앱 초기화
   * ════════════════════════════════════════════════ */
  function init() {
    loadState();
    loadList();
    applySeedBodies();
    initEvents();
    if (window.fbAuth) initAuth();
    document.documentElement.setAttribute("data-track", TRACK);
    renderAll();
  }

  init();
})();
