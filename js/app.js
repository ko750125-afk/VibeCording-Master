(function(){
  "use strict";

  var TRACK = "intermediate";

  function isActive(topic, s){
    if(TRACK === "intermediate") return true;
    var isUserAdded = s.id.indexOf(topic.id + "-c") === 0;
    return !!BEGINNER_IDS[s.id] || isUserAdded;
  }

  var STORE_KEY = "vibecoding_map_v1";
  var LIST_KEY = "vibecoding_list_v1";
  var SEED_VER_KEY = "vibecoding_seed_version";
  var BODY_VER_KEY = "vibecoding_body_version";
  var STATE = {};
  var LIST = {};
  var saveTimer = null;
  var listSaveTimer = null;

  function loadState(){
    try{
      var raw = localStorage.getItem(STORE_KEY);
      STATE = raw ? JSON.parse(raw) : {};
    }catch(e){ STATE = {}; }
  }
  function persist(){
    try{ localStorage.setItem(STORE_KEY, JSON.stringify(STATE)); }catch(e){}
  }
  function scheduleSave(){
    if(saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 400);
  }
  function loadList(){
    var hadList = false, storedVer = 0, raw = null;
    try{
      raw = localStorage.getItem(LIST_KEY);
      hadList = !!raw;
      storedVer = Number(localStorage.getItem(SEED_VER_KEY) || (hadList ? 1 : 0));
    }catch(e){}
    var parsed = {};
    try{ parsed = raw ? JSON.parse(raw) : {}; }catch(e){ parsed = {}; }
    LIST = reconcileList(parsed, storedVer);

    if(storedVer < SEED_VERSION){
      persistListLocal();
      try{ localStorage.setItem(SEED_VER_KEY, String(SEED_VERSION)); }catch(e){}
    }
  }

  // Bring a saved list up to the current seed (used for local and server data alike).
  function reconcileList(list, storedVer){
    var offered = previouslyOfferedIds(storedVer);
    var out = {};
    Object.keys(list || {}).forEach(function(k){ out[k] = list[k]; });
    TOPICS.forEach(function(t){
      var oldList = out[t.id];
      if(!oldList){
        out[t.id] = t.subtopics.map(function(s){ return { id:s.id, title:s.title }; });
      }else if(storedVer < SEED_VERSION){
        out[t.id] = migrateTopic(t, oldList, offered);
      }
    });
    return out;
  }

  // Seed ids the user has already been given, so a deleted one is not brought back.
  function previouslyOfferedIds(storedVer){
    var ids = {};
    if(storedVer >= 1){
      Object.keys(V1_SEED_COUNTS).forEach(function(k){
        var spec = V1_SEED_COUNTS[k];
        for(var i = 1; i <= spec[1]; i++) ids[spec[0] + "-" + i] = true;
      });
    }
    if(storedVer >= 2){
      TOPICS.forEach(function(t){
        t.subtopics.forEach(function(s){ if(!ADDED_IN_V3[s.id]) ids[s.id] = true; });
      });
    }
    return ids;
  }

  // Rebuild a topic from the new seed while keeping: user titles, user-added items,
  // and any removed seed item that already has notes or a status.
  function migrateTopic(topic, oldList, offered){
    var oldById = {};
    oldList.forEach(function(o){ oldById[o.id] = o; });
    var seedIds = {};
    var result = [];

    topic.subtopics.forEach(function(s){
      seedIds[s.id] = true;
      if(oldById[s.id]) result.push({ id:s.id, title:oldById[s.id].title });
      else if(!offered[s.id]) result.push({ id:s.id, title:s.title });
    });
    oldList.forEach(function(o){
      if(seedIds[o.id]) return;
      var st = STATE[o.id];
      var hasData = st && ((st.notes && st.notes !== (BODIES[o.id] || "")) || st.status);
      if(!offered[o.id] || hasData) result.push(o);
    });
    return result;
  }

  // Fill the default body into items whose body is still empty; runs once per BODY_VERSION.
  function applySeedBodies(){
    var stored = 0;
    try{ stored = Number(localStorage.getItem(BODY_VER_KEY) || 0); }catch(e){}
    if(stored >= BODY_VERSION) return;
    TOPICS.forEach(function(t){
      getSubtopics(t).forEach(function(s){
        var body = BODIES[s.id];
        if(!body) return;
        var e = entry(s.id);
        if(!e.notes) e.notes = body;
      });
    });
    persist();
    try{ localStorage.setItem(BODY_VER_KEY, String(BODY_VERSION)); }catch(e){}
  }
  function persistListLocal(){
    try{ localStorage.setItem(LIST_KEY, JSON.stringify(LIST)); }catch(e){}
  }
  function persistList(){
    persistListLocal();
    saveListRemote();
  }
  function scheduleListSave(){
    if(listSaveTimer) clearTimeout(listSaveTimer);
    listSaveTimer = setTimeout(flushListSave, 400);
  }
  function flushListSave(){
    if(!listSaveTimer) return;
    clearTimeout(listSaveTimer);
    listSaveTimer = null;
    persistList();
  }
  function entry(subId){
    if(!STATE[subId]) STATE[subId] = { status:0, notes:"", updatedAt:null };
    return STATE[subId];
  }
  function getSubtopics(topic){
    return LIST[topic.id] || [];
  }
  function addSubtopic(topicId, title){
    var id = topicId + "-c" + Date.now().toString(36) + Math.random().toString(36).slice(2,5);
    if(!LIST[topicId]) LIST[topicId] = [];
    LIST[topicId].push({ id:id, title:title });
    persistList();
    return id;
  }
  function renameSubtopic(topicId, subId, title){
    var item = (LIST[topicId] || []).filter(function(x){ return x.id === subId; })[0];
    if(item){ item.title = title; scheduleListSave(); }
  }
  function deleteSubtopic(topicId, subId){
    LIST[topicId] = (LIST[topicId] || []).filter(function(x){ return x.id !== subId; });
    persistList();
    delete STATE[subId];
    persist();
    deleteItemRemote(subId);
  }

  /* ── Server sync (db capability) ──
     Each signed-in viewer's data lives in their private subtree:
       data/users/<id>/profile                 { list, seedVersion }
       data/users/<id>/profile/items/<itemId>  { status, notes, updatedAt }  (only touched items)
     localStorage stays as this device's cache and as the fallback when the server is unavailable. */
  var SYNC = { ready:false, profileRef:null, itemsRef:null };
  var pendingWrites = {};
  var pendingOrder = [];
  var writing = false;

  function queueWrite(key, ref, build){
    if(!SYNC.ready) return;
    if(!pendingWrites[key]) pendingOrder.push(key);
    pendingWrites[key] = { ref:ref, build:build, retried:false };
    pumpWrites();
  }
  function pumpWrites(){
    if(writing) return;
    var key = pendingOrder.shift();
    if(!key) return;
    var job = pendingWrites[key];
    delete pendingWrites[key];
    writing = true;
    var payload = job.build();
    var op = payload === null ? job.ref.delete() : job.ref.set(payload);
    op.then(function(){
      writing = false;
      pumpWrites();
    }, function(err){
      writing = false;
      if(err && err.code === "unavailable" && !job.retried){
        job.retried = true;
        setTimeout(function(){
          if(!pendingWrites[key]){ pendingWrites[key] = job; pendingOrder.push(key); }
          pumpWrites();
        }, 700 + Math.random() * 800);
      }
      pumpWrites();
    });
  }

  function listPayload(){
    return { list: LIST, seedVersion: SEED_VERSION, updatedAt: Date.now() };
  }
  function itemPayload(subId){
    var e = STATE[subId];
    if(!e) return null;
    return { status: e.status || 0, notes: e.notes || "", updatedAt: e.updatedAt || null };
  }
  function saveListRemote(){
    queueWrite("profile", SYNC.profileRef, listPayload);
  }
  function saveItemRemote(subId){
    if(!SYNC.ready) return;
    queueWrite("item:" + subId, SYNC.itemsRef.doc(subId), function(){ return itemPayload(subId); });
  }
  function deleteItemRemote(subId){
    if(!SYNC.ready) return;
    queueWrite("item:" + subId, SYNC.itemsRef.doc(subId), function(){ return null; });
  }
  function isTouched(subId){
    var e = STATE[subId];
    if(!e) return false;
    return (e.status || 0) !== 0 || (e.notes || "") !== (BODIES[subId] || "");
  }

  async function startSync(user){
    if(!user) {
      SYNC.ready = false;
      return;
    }
    var db = window.fbDb;
    var uid = user.uid;

    try{
      var profileRef = db.doc("data/users/" + uid + "/profile");
      var itemsRef = profileRef.collection("items");
      var profileSnap = await profileRef.get();
      var itemsSnap = await itemsRef.limit(1000).get();

      SYNC.profileRef = profileRef;
      SYNC.itemsRef = itemsRef;

      if(profileSnap.exists){
        var data = profileSnap.data() || {};
        var storedVer = Number(data.seedVersion || 0);
        LIST = reconcileList(data.list || {}, storedVer);
        var next = {};
        itemsSnap.docs.forEach(function(d){
          var v = d.data() || {};
          next[d.id] = {
            status: Number(v.status) || 0,
            notes: typeof v.notes === "string" ? v.notes : "",
            updatedAt: v.updatedAt || null
          };
        });
        Object.keys(LIST).forEach(function(k){
          LIST[k].forEach(function(s){
            if(!next[s.id]) next[s.id] = { status:0, notes: BODIES[s.id] || "", updatedAt:null };
          });
        });
        STATE = next;
        SYNC.ready = true;
        if(storedVer < SEED_VERSION) saveListRemote();
      }else{
        // First connection: move this device's records to the server once.
        SYNC.ready = true;
        saveListRemote();
        Object.keys(LIST).forEach(function(k){
          LIST[k].forEach(function(s){ if(isTouched(s.id)) saveItemRemote(s.id); });
        });
      }

      persist();
      persistListLocal();
      renderHeader();
      renderDiagram();
      renderListView();
      if(drawer.classList.contains("open") && drawerTopic) renderSubList(drawerTopic);
    }catch(err){
      console.error(err);
      SYNC.ready = false;
    }
  }

  // Auth UI & Flow
  var loginBtn = document.getElementById("loginBtn");
  var loginLabel = document.getElementById("loginLabel");
  
  if (loginBtn) {
    loginBtn.addEventListener("click", function() {
      if (window.fbAuth.currentUser) {
        if(confirm("로그아웃 하시겠습니까?")) {
          window.fbAuth.signOut();
        }
      } else {
        var provider = new firebase.auth.GoogleAuthProvider();
        window.fbAuth.signInWithPopup(provider).catch(function(error) {
          console.error(error);
          alert("로그인 중 오류가 발생했습니다.");
        });
      }
    });
  }

  if (window.fbAuth) {
    window.fbAuth.onAuthStateChanged(function(user) {
      if (user) {
        loginLabel.textContent = "로그아웃";
        startSync(user);
      } else {
        loginLabel.textContent = "Google 로그인";
        SYNC.ready = false;
        loadState();
        loadList();
        renderHeader();
        renderDiagram();
        renderListView();
      }
    });
  }

  function topicProgress(topic){
    var subs = getSubtopics(topic).filter(function(s){ return isActive(topic, s); });
    var done = 0;
    subs.forEach(function(s){
      var st = entry(s.id).status;
      if(st === 2) done += 1;
      else if(st === 1) done += 0.5;
    });
    return { done: done, total: subs.length };
  }

  function overallProgress(){
    var done = 0, total = 0;
    TOPICS.forEach(function(t){
      var p = topicProgress(t);
      done += p.done;
      total += p.total;
    });
    return { done: done, total: total };
  }

  function fmtTime(ts){
    if(!ts) return "—";
    var d = new Date(ts);
    var hh = String(d.getHours()).padStart(2,"0");
    var mm = String(d.getMinutes()).padStart(2,"0");
    return hh + ":" + mm;
  }

  function renderHeader(){
    var o = overallProgress();
    document.getElementById("doneCount").textContent = Math.round(o.done);
    document.getElementById("totalCount").textContent = o.total;
    var pct = o.total ? (o.done / o.total * 100) : 0;
    document.getElementById("headerFill").style.width = pct + "%";
  }

  function renderDiagram(){
    TOPICS.forEach(function(t){
      var p = topicProgress(t);
      var pct = p.total ? (p.done / p.total) : 0;
      var fillEl = document.querySelector('.node-fill[data-fill="'+t.id+'"]');
      if(fillEl){
        var trackEl = fillEl.previousElementSibling;
        var fullW = parseFloat(trackEl.getAttribute("width"));
        fillEl.setAttribute("width", Math.max(0, fullW * pct));
      }
      var countEl = document.querySelector('.node-count[data-count="'+t.id+'"]');
      if(countEl){ countEl.textContent = Math.round(p.done) + "/" + p.total; }
    });
  }

  function renderListView(){
    var wrap = document.getElementById("listView");
    wrap.innerHTML = "";
    TOPICS.forEach(function(t){
      var p = topicProgress(t);
      var pct = p.total ? (p.done / p.total * 100) : 0;
      var card = document.createElement("button");
      card.className = "list-card";
      card.setAttribute("data-topic", t.id);
      card.innerHTML =
        '<span class="list-body">'+
          '<span class="list-title">'+t.name+'</span>'+
          '<span class="list-sub">'+t.sub+'</span>'+
          '<span class="progress-track small list-track"><span class="progress-fill" style="width:'+pct+'%"></span></span>'+
        '</span>'+
        '<span class="list-count mono">'+Math.round(p.done)+'/'+p.total+'</span>';
      card.addEventListener("click", function(){ openDrawer(t.id); });
      wrap.appendChild(card);
    });
  }

  var drawer = document.getElementById("drawer");
  var scrim = document.getElementById("scrim");
  var drawerTopic = null;

  function openDrawer(topicId){
    var topic = TOPICS.filter(function(t){ return t.id === topicId; })[0];
    if(!topic) return;
    drawerTopic = topic;
    document.getElementById("drawerTitle").textContent = topic.name;
    document.getElementById("drawerDesc").textContent = topic.desc;
    renderSubList(topic);
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden","false");
    scrim.classList.add("open");
  }
  function closeDrawer(){
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden","true");
    scrim.classList.remove("open");
  }

  var noteModal = document.getElementById("noteModal");
  var noteScrim = document.getElementById("noteScrim");
  var noteTextarea = document.getElementById("noteTextarea");
  var noteChip = document.getElementById("noteChip");
  var noteTitleInput = document.getElementById("noteTitleInput");
  var noteSaveHint = document.getElementById("noteSaveHint");
  var noteSaveBtn = document.getElementById("noteSaveBtn");
  var currentNote = null;
  var DRAFTS = {}; // subId -> unsaved text, kept only for this session until "저장" is pressed

  function openNoteModal(topic, sub){
    currentNote = { topicId: topic.id, subId: sub.id };
    var e = entry(sub.id);
    noteTitleInput.value = sub.title;
    setChip(noteChip, e.status);
    var draft = DRAFTS[sub.id];
    noteTextarea.value = draft !== undefined ? draft : (e.notes || "");
    setNoteDirty(draft !== undefined);
    showNoteModal();
    setTimeout(function(){ noteTextarea.focus(); }, 60);
  }
  // New item: nothing is created until "저장" is pressed, so cancelling leaves no empty card.
  function openNewNoteModal(topic){
    currentNote = { topicId: topic.id, subId: null, isNew: true, status: 0 };
    noteTitleInput.value = "";
    noteTextarea.value = "";
    setChip(noteChip, 0);
    setNoteDirty(false);
    showNoteModal();
    setTimeout(function(){ noteTitleInput.focus(); }, 60);
  }
  function showNoteModal(){
    noteTitleInput.classList.remove("need-title");
    noteModal.classList.add("open");
    noteModal.setAttribute("aria-hidden","false");
    noteScrim.classList.add("open");
  }
  function refreshNoteNewState(){
    var hasInput = noteTitleInput.value.trim() !== "" || noteTextarea.value.trim() !== "";
    setNoteDirty(hasInput);
  }
  function closeNoteModal(){
    noteModal.classList.remove("open");
    noteModal.setAttribute("aria-hidden","true");
    noteScrim.classList.remove("open");
    currentNote = null;
  }
  function nudgeSaveBtn(){
    noteSaveBtn.classList.remove("nudge");
    void noteSaveBtn.offsetWidth; // restart animation
    noteSaveBtn.classList.add("nudge");
  }
  function attemptCloseNoteModal(){
    if(noteSaveHint.classList.contains("dirty")){
      showConfirm(
        "변경사항 취소", 
        "저장하지 않은 내용은 모두 사라집니다. 편집을 취소하고 나가시겠습니까?", 
        function(){
          if(currentNote && currentNote.subId) delete DRAFTS[currentNote.subId];
          closeNoteModal();
        }
      );
      return;
    }
    closeNoteModal();
  }
  function currentTopic(){
    return TOPICS.filter(function(t){ return t.id === currentNote.topicId; })[0];
  }
  function setNoteDirty(dirty){
    if(dirty){
      noteSaveHint.textContent = "저장되지 않은 변경사항이 있습니다";
      noteSaveHint.classList.add("dirty");
    }else if(currentNote.isNew){
      noteSaveHint.textContent = "새 항목 — 제목과 본문을 입력하고 저장하세요";
      noteSaveHint.classList.remove("dirty");
    }else{
      var e = entry(currentNote.subId);
      noteSaveHint.textContent = "마지막 저장: " + fmtTime(e.updatedAt);
      noteSaveHint.classList.remove("dirty");
    }
  }
  function refreshAfterChange(){
    renderDiagram();
    renderListView();
    renderHeader();
    var topic = currentTopic();
    if(topic){ renderDrawerProgress(topic); if(drawer.classList.contains("open")) renderSubList(topic); }
  }

  noteTextarea.addEventListener("input", function(){
    if(!currentNote) return;
    if(currentNote.isNew){ refreshNoteNewState(); return; }
    DRAFTS[currentNote.subId] = noteTextarea.value;
    setNoteDirty(true);
  });
  noteTitleInput.addEventListener("input", function(){
    if(!currentNote) return;
    noteTitleInput.classList.remove("need-title");
    if(currentNote.isNew){ refreshNoteNewState(); return; }
    renameSubtopic(currentNote.topicId, currentNote.subId, noteTitleInput.value);
    var topic = currentTopic();
    if(topic && drawer.classList.contains("open")) renderSubList(topic);
  });
  noteTitleInput.addEventListener("blur", flushListSave);
  noteSaveBtn.addEventListener("click", function(){
    if(!currentNote) return;
    if(currentNote.isNew){
      var title = noteTitleInput.value.trim();
      if(!title){
        noteTitleInput.classList.add("need-title");
        noteTitleInput.focus();
        nudgeSaveBtn();
        return;
      }
      currentNote.subId = addSubtopic(currentNote.topicId, title);
      entry(currentNote.subId).status = currentNote.status;
      currentNote.isNew = false;
    }
    var e = entry(currentNote.subId);
    e.notes = noteTextarea.value;
    e.updatedAt = Date.now();
    persist();
    saveItemRemote(currentNote.subId);
    delete DRAFTS[currentNote.subId];
    setNoteDirty(false);
    refreshAfterChange();
    var original = noteSaveBtn.textContent;
    noteSaveBtn.textContent = "저장됨";
    setTimeout(function(){ noteSaveBtn.textContent = original; }, 1100);
  });
  noteChip.addEventListener("click", function(){
    if(!currentNote) return;
    if(currentNote.isNew){
      currentNote.status = (currentNote.status + 1) % 3;
      setChip(noteChip, currentNote.status);
      return;
    }
    var e = entry(currentNote.subId);
    e.status = (e.status + 1) % 3;
    e.updatedAt = Date.now();
    setChip(noteChip, e.status);
    scheduleSave();
    saveItemRemote(currentNote.subId);
    refreshAfterChange();
  });
  document.getElementById("noteClose").addEventListener("click", attemptCloseNoteModal);
  noteScrim.addEventListener("click", attemptCloseNoteModal);

  var confirmScrim = document.getElementById("confirmScrim");
  var confirmDialog = document.getElementById("confirmDialog");
  var confirmTitleEl = document.getElementById("confirmTitle");
  var confirmBodyEl = document.getElementById("confirmBody");
  var confirmOkBtn = document.getElementById("confirmOk");
  var confirmCancelBtn = document.getElementById("confirmCancel");
  var pendingConfirm = null;

  function showConfirm(title, body, onConfirm){
    confirmTitleEl.textContent = title;
    confirmBodyEl.textContent = body;
    pendingConfirm = onConfirm;
    confirmDialog.classList.add("open");
    confirmDialog.setAttribute("aria-hidden","false");
    confirmScrim.classList.add("open");
  }
  function hideConfirm(){
    confirmDialog.classList.remove("open");
    confirmDialog.setAttribute("aria-hidden","true");
    confirmScrim.classList.remove("open");
    pendingConfirm = null;
  }
  confirmOkBtn.addEventListener("click", function(){
    var fn = pendingConfirm;
    hideConfirm();
    if(fn) fn();
  });
  confirmCancelBtn.addEventListener("click", hideConfirm);
  confirmScrim.addEventListener("click", hideConfirm);

  function renderSubList(topic){
    var list = document.getElementById("subList");
    list.innerHTML = "";
    var subs = getSubtopics(topic);

    subs.forEach(function(s){
      var e = entry(s.id);
      var row = document.createElement("div");
      row.className = "sub-row";
      row.tabIndex = 0;
      row.setAttribute("role","button");
      row.setAttribute("aria-label", s.title + " 열기");

      var chip = document.createElement("button");
      chip.className = "status-chip";
      chip.type = "button";
      setChip(chip, e.status);
      chip.addEventListener("click", function(ev){
        ev.stopPropagation();
        e.status = (e.status + 1) % 3;
        e.updatedAt = Date.now();
        setChip(chip, e.status);
        scheduleSave();
        saveItemRemote(s.id);
        renderDiagram();
        renderListView();
        renderDrawerProgress(topic);
        renderHeader();
      });

      var title = document.createElement("span");
      title.className = "sub-card-title";
      title.textContent = s.title;


      if(!isActive(topic, s)){
        row.className = "sub-row is-disabled";
        row.removeAttribute("role");
        row.tabIndex = -1;
        row.setAttribute("aria-disabled","true");
        row.setAttribute("aria-label", s.title + " (중급 과정, 비활성)");
        chip.disabled = true;
        var levelTag = document.createElement("span");
        levelTag.className = "level-tag";
        levelTag.textContent = "중급";
        row.appendChild(chip);
        row.appendChild(title);
        row.appendChild(levelTag);
        list.appendChild(row);
        return;
      }

      var del = document.createElement("button");
      del.className = "del-btn";
      del.type = "button";
      del.setAttribute("aria-label","항목 삭제");
      del.textContent = "삭제";
      del.addEventListener("click", function(ev){
        ev.stopPropagation();
        showConfirm(
          "항목을 삭제할까요?",
          '"'+s.title+'" 항목과 작성한 메모가 함께 삭제되며, 되돌릴 수 없습니다.',
          function(){
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

      row.addEventListener("click", function(){ openNoteModal(topic, s); });
      row.addEventListener("keydown", function(ev){
        if(ev.key === "Enter" || ev.key === " "){
          ev.preventDefault();
          openNoteModal(topic, s);
        }
      });

      list.appendChild(row);
    });

    var addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "add-row";
    addBtn.textContent = "+ 새 항목 추가";
    addBtn.addEventListener("click", function(){ openNewNoteModal(topic); });
    list.appendChild(addBtn);

    renderDrawerProgress(topic);
  }

  function setChip(chip, status){
    chip.setAttribute("data-status", status);
    chip.textContent = status === 2 ? "● 완료" : status === 1 ? "◐ 학습중" : "○ 미학습";
  }

  function renderDrawerProgress(topic){
    var p = topicProgress(topic);
    var pct = p.total ? (p.done / p.total * 100) : 0;
    document.getElementById("drawerFill").style.width = pct + "%";
    document.getElementById("drawerCount").textContent = Math.round(p.done) + "/" + p.total;
  }

  document.querySelectorAll(".node").forEach(function(node){
    node.addEventListener("click", function(){ openDrawer(node.getAttribute("data-topic")); });
    node.addEventListener("keydown", function(ev){
      if(ev.key === "Enter" || ev.key === " "){
        ev.preventDefault();
        openDrawer(node.getAttribute("data-topic"));
      }
    });
  });
  document.getElementById("closeDrawer").addEventListener("click", closeDrawer);
  scrim.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", function(ev){
    if(ev.key === "Escape"){
      if(confirmDialog.classList.contains("open")) hideConfirm();
      else if(noteModal.classList.contains("open")) attemptCloseNoteModal();
      else closeDrawer();
    }
  });

  var trackBtn = document.getElementById("trackBtn");
  function applyTrack(){
    var beginner = TRACK === "beginner";
    document.documentElement.setAttribute("data-track", TRACK);
    document.getElementById("trackLabel").textContent = beginner ? "초보자용" : "중급자용";
    trackBtn.title = beginner ? "클릭하면 중급자용으로 전환합니다" : "클릭하면 초보자용으로 전환합니다";
    document.getElementById("legendOff").hidden = !beginner;
    renderHeader();
    renderDiagram();
    renderListView();
    if(drawer.classList.contains("open") && drawerTopic) renderSubList(drawerTopic);
  }
  trackBtn.addEventListener("click", function(){
    TRACK = TRACK === "beginner" ? "intermediate" : "beginner";
    applyTrack();
  });

  loadState();
  loadList();
  applySeedBodies();
  // startSync() is now triggered by onAuthStateChanged
  document.documentElement.setAttribute("data-track", TRACK);
  renderHeader();
  renderDiagram();
  renderListView();
})();
