/* ============================================================
   ③ 동작 — 화면 전환, 투표, 집계, 실시간 연결
   화면은 세 가지:
     참가자 화면  (기본. 학생이 QR로 여는 화면)
     발표자 화면  (주소 뒤에 ?view=host)   = 발표 화면 + 아래 조작 버튼
     발표 화면    (주소 뒤에 ?view=screen) = 조작 버튼 없이 따라가기만 하는 화면
   ============================================================ */
(function () {
  'use strict';

  /* ---------- 주소에서 읽는 값 ---------- */
  const Q = new URLSearchParams(location.search);
  const DEFAULT_SESSION = CONFIG.session || 'main';
  const SESSION = (Q.get('s') || DEFAULT_SESSION).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'main';
  const DEMO = Q.has('demo') || !(CONFIG.firebase && CONFIG.firebase.databaseURL);
  const MAX_SCORE = 2;                       // 한 번의 선택에서 받을 수 있는 최고 점수
  const NUM = ['①', '②', '③', '④'];
  let VIEW = 'play';

  /* ---------- 내용 찾아보기용 표 ---------- */
  const CHAR = {}; CONTENT.characters.forEach(function (c) { CHAR[c.id] = c; });
  const CASE = {}; CONTENT.cases.forEach(function (c) { CASE[c.id] = c; });
  const STAGE = {};                          // 'saemangeum_s1' → { c: 사례, st: 스테이지, i: 순번 }
  CONTENT.cases.forEach(function (c) {
    c.stages.forEach(function (st, i) { STAGE[c.id + '_' + st.id] = { c: c, st: st, i: i, key: c.id + '_' + st.id }; });
  });
  const STAGE_KEYS = Object.keys(STAGE);
  let AFF_MAX = 1;                           // 호감도 막대의 최대 범위(한 사례 기준)
  CONTENT.cases.forEach(function (c) {
    let m = 0;
    c.stages.forEach(function (st) {
      let stageMax = 0;
      st.choices.forEach(function (ch) {
        Object.keys(ch.affinity || {}).forEach(function (k) { stageMax = Math.max(stageMax, Math.abs(ch.affinity[k])); });
      });
      m += stageMax;
    });
    AFF_MAX = Math.max(AFF_MAX, m);
  });

  /* ---------- 장면 목록 (발표자가 "다음"을 누르면 이 순서대로 넘어감) ---------- */
  const SCENES = [];
  function addScene(o) { o.index = SCENES.length; SCENES.push(o); }
  addScene({ id: 'lobby', type: 'lobby', label: '입장' });
  addScene({ id: 'question', type: 'question', label: '핵심 질문' });
  addScene({ id: 'cast', type: 'cast', label: '등장인물' });
  addScene({ id: 'howto', type: 'howto', label: '진행 방식' });
  CONTENT.cases.forEach(function (c) {
    addScene({ id: c.id + '-intro', type: 'caseIntro', caseId: c.id, label: c.short + ' · 배경' });
    c.stages.forEach(function (st, i) {
      const key = c.id + '_' + st.id;
      const pre = c.short + ' · Stage ' + (i + 1) + ' · ';
      addScene({ id: key + '-situation', type: 'situation', caseId: c.id, key: key, label: pre + '상황' });
      addScene({ id: key + '-vote', type: 'vote', caseId: c.id, key: key, label: pre + '투표' });
      addScene({ id: key + '-result', type: 'result', caseId: c.id, key: key, label: pre + '결과' });
      addScene({ id: key + '-extra', type: 'extra', caseId: c.id, key: key, label: pre + (st.extra.kind === 'hidden' ? '히든 이벤트' : '추가 자료') });
      addScene({ id: key + '-actual', type: 'actual', caseId: c.id, key: key, label: pre + '실제 선택' });
    });
    addScene({ id: c.id + '-unlock', type: 'unlock', caseId: c.id, label: c.short + ' · 루트 해금' });
    addScene({ id: c.id + '-cutscene', type: 'cutscene', caseId: c.id, label: c.short + ' · 엔딩 대화' });
    addScene({ id: c.id + '-aftermath', type: 'aftermath', caseId: c.id, label: c.short + ' · 4인 호감도 결과' });
    addScene({ id: c.id + '-frame', type: 'frame', caseId: c.id, label: c.short + ' · 3대 지식 분석 프레임' });
    addScene({ id: c.id + '-tradeoff', type: 'tradeoff', caseId: c.id, label: c.short + ' · 얻은 것과 치른 대가' });
    addScene({ id: c.id + '-ask', type: 'ask', caseId: c.id, label: c.short + ' · 엔딩 후속 질문' });
  });
  addScene({ id: 'compare', type: 'compare', label: '두 사례 비교' });
  addScene({ id: 'conclusion', type: 'conclusion', label: '결론' });
  const SCENE_BY_ID = {}; SCENES.forEach(function (s) { SCENE_BY_ID[s.id] = s; });
  const ENDING_TYPES = { cutscene: 1, aftermath: 1, frame: 1, tradeoff: 1, ask: 1 };

  /* ---------- 지금 이 브라우저가 알고 있는 것 ---------- */
  const S = {
    sync: null, connected: false, fatal: '', flash: '',
    state: null,          // 발표자가 정하는 진행 상태 { scene, step, open, peek, feed }
    results: {},          // 발표자 화면이 계산해서 올려 두는 집계 (참가자 휴대폰이 읽음)
    players: {}, votes: {}, hide: {},     // 발표자/발표 화면만 읽음
    me: { id: '', name: '', dept: '', joined: false, checked: false, editing: false, notice: '', error: '' },
    myVotes: {},          // 참가자 본인의 투표
    draft: {},            // 참가자가 고르는 중인 값
    sends: {},            // 스테이지별 제출 상태 { sending, slow, error }
    ui: { resetArmed: false },
    loaded: {},           // 서버에서 한 번이라도 받아 온 항목
  };

  /* ============================================================
     작은 도구
     ============================================================ */
  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        const v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden' || k === 'open') el[k] = !!v;
        else el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    for (let i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, kid) {
    if (kid == null || kid === false || kid === true) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { append(el, k); }); return; }
    el.appendChild(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  /* 내용의 글 한 조각을 화면에 넣기. D('...')로 감싼 임시 문구는 표시를 붙임.
     학생이 입력한 글도 전부 글자 그대로 들어감(태그로 해석되지 않음). */
  function T(x) {
    if (x && typeof x === 'object' && 't' in x) {
      return h('span', { class: x.draft && CONFIG.showDraftMarks ? 'is-draft' : null }, x.t);
    }
    return document.createTextNode(x == null ? '' : String(x));
  }
  /* 입력란에서 Enter를 누르면 fn 실행. 한글 조합 중의 Enter는 무시.
     (미리보기 창처럼 form 제출이 막힌 곳에서도 되도록 제출 이벤트 대신 클릭·키 입력을 직접 받음) */
  function onEnter(form, fn) {
    form.addEventListener('submit', function (e) { e.preventDefault(); });
    form.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
      if (!e.target || e.target.tagName !== 'INPUT') return;
      e.preventDefault(); fn();
    });
  }
  function plain(x) { return x && typeof x === 'object' && 't' in x ? x.t : (x == null ? '' : String(x)); }
  function fmtSigned(v) { v = Math.round(v * 10) / 10; return (v > 0 ? '+' : '') + v; }
  function signClass(v) { return v > 0 ? 'is-up' : v < 0 ? 'is-down' : 'is-flat'; }
  function stable(v) {
    if (v === undefined) return 'null';
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + stable(v[k]); }).join(',') + '}';
  }
  function randomId() {
    const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = 'p';
    let bytes = null;
    try { bytes = new Uint8Array(11); crypto.getRandomValues(bytes); } catch (e) { bytes = null; }
    for (let i = 0; i < 11; i++) s += a[(bytes ? bytes[i] : Math.floor(Math.random() * 256)) % a.length];
    return s;
  }
  /* 브라우저 저장소. 막혀 있으면(미리보기 창 등) 메모리에만 둠 */
  function makeStore(kind) {
    const mem = {};
    let s = null;
    try { s = window[kind + 'Storage']; s.setItem('__dgd_t', '1'); s.removeItem('__dgd_t'); } catch (e) { s = null; }
    return {
      get: function (k) { try { if (s) return s.getItem(k); } catch (e) { /* 메모리로 */ } return k in mem ? mem[k] : null; },
      set: function (k, v) { try { if (s) { s.setItem(k, v); return; } } catch (e) { /* 메모리로 */ } mem[k] = v; },
      del: function (k) { try { if (s) s.removeItem(k); } catch (e) { /* 무시 */ } delete mem[k]; },
    };
  }

  /* ============================================================
     실시간 연결부
     둘 다 같은 모양: onValue(경로, 함수) / set / update / remove / onConnection
     경로는 세션 안에서의 위치. 예) 'state', 'players/abc', 'votes/saemangeum_s1/abc'
     ============================================================ */

  /* (1) 데모 모드: 서버 없이 같은 브라우저의 탭끼리 연결 */
  function createLocalSync(sessionId) {
    const KEY = 'dgd:' + sessionId + ':data';
    const store = makeStore('local');
    const subs = [];
    let tree = load();
    let bc = null;
    try { bc = new BroadcastChannel(KEY); bc.onmessage = function () { tree = load(); emit(); }; } catch (e) { bc = null; }
    window.addEventListener('storage', function (e) { if (e.key === KEY) { tree = load(); emit(); } });

    function load() { try { return JSON.parse(store.get(KEY) || '{}') || {}; } catch (e) { return {}; } }
    function save() { store.set(KEY, JSON.stringify(tree)); if (bc) { try { bc.postMessage(1); } catch (e) { /* 무시 */ } } }
    function parts(path) { return String(path || '').split('/').filter(Boolean); }
    function getAt(path) {
      let node = tree;
      const p = parts(path);
      for (let i = 0; i < p.length; i++) { if (node == null || typeof node !== 'object') return null; node = node[p[i]]; }
      return node === undefined ? null : node;
    }
    function clean(v) {                       // Firebase처럼 null·빈 객체는 없는 것으로 취급
      if (v === null || v === undefined) return undefined;
      if (typeof v !== 'object') return v;
      const out = {};
      Object.keys(v).forEach(function (k) { const c = clean(v[k]); if (c !== undefined) out[k] = c; });
      return Object.keys(out).length ? out : undefined;
    }
    function setAt(path, value) {
      const p = parts(path);
      const v = clean(value);
      if (!p.length) { tree = v === undefined ? {} : v; return; }
      const chain = [tree];
      let node = tree;
      for (let i = 0; i < p.length - 1; i++) {
        if (node[p[i]] == null || typeof node[p[i]] !== 'object') node[p[i]] = {};
        node = node[p[i]]; chain.push(node);
      }
      if (v === undefined) delete node[p[p.length - 1]]; else node[p[p.length - 1]] = v;
      for (let i = chain.length - 1; i > 0; i--) {            // 비게 된 상위 칸 정리
        if (Object.keys(chain[i]).length === 0) delete chain[i - 1][p[i - 1]]; else break;
      }
    }
    function emit() {
      subs.slice().forEach(function (s) {
        if (s.dead) return;
        const j = JSON.stringify(getAt(s.path));
        if (j !== s.last) { s.last = j; s.cb(JSON.parse(j)); }
      });
    }
    return {
      mode: 'local',
      onValue: function (path, cb) {
        const s = { path: path, cb: cb, last: undefined, dead: false };
        subs.push(s);
        setTimeout(function () { if (s.dead || s.last !== undefined) return; s.last = JSON.stringify(getAt(path)); cb(JSON.parse(s.last)); }, 0);
        return function () { s.dead = true; const i = subs.indexOf(s); if (i >= 0) subs.splice(i, 1); };
      },
      set: function (path, value) { tree = load(); setAt(path, value); save(); emit(); return Promise.resolve(); },
      update: function (path, patch) {
        tree = load();
        Object.keys(patch).forEach(function (k) { setAt((path ? path + '/' : '') + k, patch[k]); });
        save(); emit(); return Promise.resolve();
      },
      remove: function (path) { tree = load(); setAt(path, null); save(); emit(); return Promise.resolve(); },
      onConnection: function (cb) { setTimeout(function () { cb(true); }, 0); return function () {}; },
    };
  }

  /* (2) Firebase Realtime Database */
  function createFirebaseSync(config, sessionId) {
    const base = CONFIG.firebaseSdk.replace(/\/$/, '');
    return Promise.all([import(base + '/firebase-app.js'), import(base + '/firebase-database.js')]).then(function (m) {
      const app = m[0].initializeApp(config);
      const fdb = m[1];
      const database = fdb.getDatabase(app);
      const root = 'sessions/' + sessionId;
      function r(path) { return fdb.ref(database, path ? root + '/' + path : root); }
      return {
        mode: 'firebase',
        onValue: function (path, cb) {
          return fdb.onValue(r(path), function (snap) { cb(snap.val()); }, function (err) { reportReadError(err); });
        },
        set: function (path, value) { return fdb.set(r(path), value); },
        update: function (path, patch) { return fdb.update(r(path), patch); },
        remove: function (path) { return fdb.remove(r(path)); },
        onConnection: function (cb) {
          return fdb.onValue(fdb.ref(database, '.info/connected'), function (snap) { cb(!!snap.val()); });
        },
      };
    });
  }

  function createSync() {
    if (DEMO) return Promise.resolve(createLocalSync(SESSION));
    return createFirebaseSync(CONFIG.firebase, SESSION);
  }

  /* 읽기가 거절되면 화면이 멈춘 것처럼 보이므로 사라지지 않는 안내를 띄움 */
  function reportReadError(err) {
    if (window.console) console.error(err);
    S.fatal = '서버에서 자료를 읽지 못했습니다. Firebase 규칙이 만료됐거나 잘못 들어갔는지 확인해 주세요.';
    requestRender();
  }
  function reportError(err) {
    if (window.console) console.error(err);
    const msg = err && (err.code || err.message) ? String(err.code || err.message) : String(err);
    S.flash = /permission/i.test(msg) ? '서버가 요청을 거절했습니다 (권한 규칙 확인)' : '오류: ' + msg;
    requestRender();
    setTimeout(function () { S.flash = ''; requestRender(); }, 6000);
  }

  /* ============================================================
     진행 상태 읽기
     ============================================================ */
  function sceneOf(id) { return SCENE_BY_ID[id] || SCENES[0]; }

  function stepsOf(sc) {
    if (sc.type === 'situation') return 1 + STAGE[sc.key].st.dialogue.length;
    if (sc.type === 'unlock') return 3;                         // 점수 → 루트 → 실제 역사
    if (sc.type === 'cutscene') {
      const r = endingRouteFor(sc.caseId);
      return r ? Math.max(1, CASE[sc.caseId].routes[r].cutscene.length) : 1;
    }
    if (sc.type === 'conclusion') return CONTENT.conclusion.paragraphs.length;
    return 1;
  }
  function cur() {
    const st = S.state || {};
    const sc = sceneOf(st.scene);
    const steps = stepsOf(sc);
    const step = Math.min(Math.max(0, st.step | 0), steps - 1);
    return { idx: sc.index, sc: sc, step: step, steps: steps, open: st.open || null, peek: st.peek || null, feed: st.feed !== false };
  }

  /* ============================================================
     집계 (발표자·발표 화면에서 계산)
     ============================================================ */
  function playerIds() { return Object.keys(S.players || {}); }
  function playerCount() { return playerIds().length; }

  /* 한 스테이지의 표 수, 반 점수, 4인 호감도 변화(반 평균) */
  function stageSummary(key) {
    const st = STAGE[key].st;
    const v = (S.votes && S.votes[key]) || {};
    const n = st.choices.map(function () { return 0; });
    let total = 0, voters = 0;
    Object.keys(v).forEach(function (pid) {
      if (!S.players[pid]) return;                              // 지워진 참가자의 표는 세지 않음
      const c = v[pid] ? v[pid].c : null;
      if (typeof c !== 'number' || !st.choices[c]) return;
      n[c] += 1; voters += 1; total += st.choices[c].score;
    });
    const aff = {};
    CONTENT.characters.forEach(function (ch) {
      let sum = 0;
      st.choices.forEach(function (choice, i) { sum += n[i] * ((choice.affinity || {})[ch.id] || 0); });
      aff[ch.id] = voters ? Math.round(sum / voters * 10) / 10 : 0;
    });
    return { n0: n[0] || 0, n1: n[1] || 0, n2: n[2] || 0, total: total, voters: voters, max: voters * MAX_SCORE, aff: aff };
  }

  /* 반 전체 점수 ÷ 만점 → 루트 */
  function routeOf(total, max) {
    if (!max) return null;
    const ratio = total / max;
    if (ratio <= CONFIG.routeCut.A + 1e-9) return 'A';
    if (ratio >= CONFIG.routeCut.C - 1e-9) return 'C';
    return 'B';
  }
  /* 개인 점수(0~4) → 루트 */
  function personalRoute(score) {
    return score <= CONFIG.personalCut.A ? 'A' : score <= CONFIG.personalCut.B ? 'B' : 'C';
  }

  /* 한 사례의 합계. 만점 = 실제로 들어온 표 수 × 2점 (투표 안 한 사람은 계산에서 빠짐) */
  function caseSummary(caseId) {
    const c = CASE[caseId];
    let total = 0, max = 0;
    c.stages.forEach(function (st) { const s = stageSummary(c.id + '_' + st.id); total += s.total; max += s.max; });
    if (!max) return null;
    return { total: total, max: max, pct: Math.round(total / max * 1000) / 10, route: routeOf(total, max) };
  }

  /* 각자 점수로 본 루트 분포 (두 스테이지 모두 투표한 사람만) */
  function personalSpread(caseId) {
    const c = CASE[caseId];
    const out = { A: 0, B: 0, C: 0, n: 0 };
    playerIds().forEach(function (pid) {
      let score = 0, ok = true;
      c.stages.forEach(function (st) {
        const v = ((S.votes || {})[c.id + '_' + st.id] || {})[pid];
        if (!v || !st.choices[v.c]) { ok = false; return; }
        score += st.choices[v.c].score;
      });
      if (!ok) return;
      out[personalRoute(score)] += 1; out.n += 1;
    });
    return out;
  }

  /* 한 사례에서 지금까지 끝난 스테이지의 호감도 합(반 평균 기준) */
  function classAffinity(caseId, uptoIdx) {
    const sums = {};
    CONTENT.characters.forEach(function (ch) { sums[ch.id] = 0; });
    CASE[caseId].stages.forEach(function (st) {
      const key = caseId + '_' + st.id;
      if (SCENE_BY_ID[key + '-result'].index > uptoIdx) return;
      const a = stageSummary(key).aff;
      CONTENT.characters.forEach(function (ch) { sums[ch.id] += a[ch.id]; });
    });
    return sums;
  }

  function endingRouteFor(caseId) {
    const st = S.state || {};
    if (st.peek) return st.peek;
    const sum = VIEW === 'play' ? S.results[caseId] : caseSummary(caseId);
    return sum && sum.route ? sum.route : null;
  }

  /* 참가자 본인 기록 */
  function myCase(caseId) {
    const c = CASE[caseId];
    let score = 0, done = 0;
    const aff = {};
    CONTENT.characters.forEach(function (ch) { aff[ch.id] = 0; });
    c.stages.forEach(function (st) {
      const v = S.myVotes[c.id + '_' + st.id];
      if (!v || !st.choices[v.c]) return;
      done += 1; score += st.choices[v.c].score;
      CONTENT.characters.forEach(function (ch) { aff[ch.id] += (st.choices[v.c].affinity || {})[ch.id] || 0; });
    });
    const complete = done === c.stages.length;
    return { score: score, done: done, complete: complete, route: complete ? personalRoute(score) : null, aff: aff };
  }

  /* ============================================================
     발표자 조작
     ============================================================ */
  function setState(patch) {
    patch.t = Date.now();
    return S.sync.update('state', patch).catch(reportError);
  }
  function enter(idx, step) {
    const sc = SCENES[Math.max(0, Math.min(SCENES.length - 1, idx))];
    const c = cur();
    // 같은 사례의 엔딩 장면 안에서 움직일 때는 "루트 보기"에서 고른 루트를 유지
    const keepPeek = c.peek && ENDING_TYPES[sc.type] && ENDING_TYPES[c.sc.type] && sc.caseId === c.sc.caseId;
    // 투표 장면에 들어가면 그 스테이지 투표가 열리고, 나가면 닫힘
    return setState({ scene: sc.id, step: step || 0, open: sc.type === 'vote' ? sc.key : null, peek: keepPeek ? c.peek : null });
  }
  function go(delta) {
    if (!S.sync || VIEW !== 'host') return;
    const c = cur();
    if (delta > 0) {
      if (c.step < c.steps - 1) return setState({ step: c.step + 1 });
      if (c.idx < SCENES.length - 1) return enter(c.idx + 1, 0);
    } else {
      if (c.step > 0) return setState({ step: c.step - 1 });
      if (c.idx > 0) return enter(c.idx - 1, stepsOf(SCENES[c.idx - 1]) - 1);   // 앞 장면의 마지막 단계로
    }
  }
  function setPeek(route) { return setState({ peek: route || null, step: 0 }); }
  function toggleFeed() { return setState({ feed: !cur().feed }); }

  /* 집계를 서버에 올려 둠 → 참가자 휴대폰이 "우리 반 결과"를 볼 수 있음.
     아직 화면에 공개하지 않은 결과는 올리지 않음. */
  let lastPublishTry = '';
  function publishResults() {
    if (VIEW !== 'host' || !S.sync || !S.state) return;
    if (!S.loaded.players || !S.loaded.votes || !S.loaded.results) return;   // 다 받아 온 뒤에만
    const c = cur();
    const want = {};
    SCENES.forEach(function (sc) {
      if (sc.type === 'result' && sc.index <= c.idx) want[sc.key] = stageSummary(sc.key);
      if (sc.type === 'unlock' && (sc.index < c.idx || (sc.index === c.idx && c.step >= 1))) {
        const sum = caseSummary(sc.caseId);
        if (sum) want[sc.caseId] = sum;
      }
    });
    const next = stable(want);
    if (next === stable(S.results || {}) || next === lastPublishTry) return;
    lastPublishTry = next;
    setTimeout(function () { if (lastPublishTry === next) lastPublishTry = ''; }, 1500);
    S.sync.set('results', Object.keys(want).length ? want : null).catch(reportError);
  }

  function clearStageVotes(key) { return S.sync.remove('votes/' + key).catch(reportError); }
  function removePlayer(pid) {
    const jobs = [S.sync.remove('players/' + pid)];
    STAGE_KEYS.forEach(function (k) { if (S.votes[k] && S.votes[k][pid]) jobs.push(S.sync.remove('votes/' + k + '/' + pid)); });
    return Promise.all(jobs).catch(reportError);
  }
  function setHidden(key, pid, hidden) { return S.sync.set('hide/' + key + '/' + pid, hidden ? true : null).catch(reportError); }
  function unhideAll(key) { return S.sync.remove('hide/' + key).catch(reportError); }
  function resetAll() { return S.sync.remove('').catch(reportError); }

  /* 리허설용 가상 참가자 */
  function addBots(count) {
    const patch = {};
    const have = playerIds().filter(function (id) { return S.players[id].bot; }).length;
    for (let i = 1; i <= count; i++) {
      patch['bot' + randomId().slice(1, 8)] = { name: '가상 참가자 ' + (have + i), dept: '테스트', bot: true, t: Date.now() };
    }
    return S.sync.update('players', patch).catch(reportError);
  }
  function botVote() {
    const c = cur();
    if (c.sc.type !== 'vote') return;
    const patch = {};
    playerIds().forEach(function (pid) {
      if (!S.players[pid].bot) return;
      const pick = Math.floor(Math.random() * STAGE[c.sc.key].st.choices.length);
      const v = { c: pick, t: Date.now() };
      if (Math.random() < 0.5) v.r = '테스트 의견 ' + NUM[pick];
      patch[pid] = v;
    });
    if (!Object.keys(patch).length) return;
    return S.sync.update('votes/' + c.sc.key, patch).catch(reportError);
  }
  function removeBots() {
    return Promise.all(playerIds().filter(function (id) { return S.players[id].bot; }).map(removePlayer));
  }

  /* 응답 내려받기 (엑셀에서 열리는 CSV) */
  function buildCsv() {
    const head = ['이름', '학과', '가상 참가자'];
    STAGE_KEYS.forEach(function (k) {
      const p = STAGE[k].c.short + ' S' + (STAGE[k].i + 1);
      head.push(p + ' 선택', p + ' 점수', p + ' 이유');
    });
    CONTENT.cases.forEach(function (c) { head.push(c.short + ' 개인 합계'); });
    const rows = [head];
    playerIds().sort(function (a, b) { return (S.players[a].t || 0) - (S.players[b].t || 0); }).forEach(function (pid) {
      const p = S.players[pid];
      const row = [p.name || '', p.dept || '', p.bot ? 'Y' : ''];
      const sums = {};
      STAGE_KEYS.forEach(function (k) {
        const v = (S.votes[k] || {})[pid];
        const ch = v ? STAGE[k].st.choices[v.c] : null;
        if (ch) {
          row.push(NUM[v.c] + ' ' + ch.tag, ch.score, v.r || '');
          sums[STAGE[k].c.id] = (sums[STAGE[k].c.id] || 0) + ch.score;
        } else { row.push('', '', ''); }
      });
      CONTENT.cases.forEach(function (c) { row.push(sums[c.id] == null ? '' : sums[c.id]); });
      rows.push(row);
    });
    return '﻿' + rows.map(function (r) {
      return r.map(function (cell) {
        let s = String(cell);
        if (/^[=+\-@]/.test(s)) s = "'" + s;                    // 엑셀 수식으로 읽히지 않게
        return '"' + s.replace(/"/g, '""') + '"';
      }).join(',');
    }).join('\r\n');
  }
  function downloadCsv() {
    const blob = new Blob([buildCsv()], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: 'dgd-' + SESSION + '.csv' });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  /* ============================================================
     참가자 조작
     ============================================================ */
  const idStore = makeStore(DEMO ? 'session' : 'local');       // 데모 모드에서는 탭마다 다른 사람으로 취급
  const ME_KEY = 'dgd:' + SESSION + ':me';
  function loadIdentity() {
    let saved = null;
    try { saved = JSON.parse(idStore.get(ME_KEY) || 'null'); } catch (e) { saved = null; }
    S.me.id = (saved && saved.id) || randomId();
    S.me.name = (saved && saved.name) || '';
    S.me.dept = (saved && saved.dept) || '';
    saveIdentity();
  }
  function saveIdentity() { idStore.set(ME_KEY, JSON.stringify({ id: S.me.id, name: S.me.name, dept: S.me.dept })); }
  function join(name, dept) {
    S.me.name = name.slice(0, 20); S.me.dept = dept.slice(0, 30);
    S.me.editing = false; S.me.notice = ''; S.me.error = '';
    saveIdentity();
    return S.sync.set('players/' + S.me.id, { name: S.me.name, dept: S.me.dept, t: Date.now() }).catch(function (err) {
      S.me.error = '입장하지 못했습니다. 잠시 뒤 다시 눌러 주세요.';
      reportError(err);
    });
  }
  function submitVote(key, choice, reason) {
    const v = { c: choice, t: Date.now() };
    const r = String(reason || '').trim().slice(0, CONFIG.reasonMax);
    if (r) v.r = r;
    return S.sync.set('votes/' + key + '/' + S.me.id, v);
  }

  /* ============================================================
     화면 조각 (발표 화면)
     ============================================================ */
  function gameTitle() {
    return h('h1', { class: 'game-title' }, CONTENT.title, ' ', h('small', null, CONTENT.titleSub));
  }
  function sceneHead(c, sub) {
    const cs = c.sc.caseId ? CASE[c.sc.caseId] : null;
    const sg = c.sc.key ? STAGE[c.sc.key] : null;
    return h('header', { class: 'scene__head' },
      cs ? h('p', { class: 'scene__case' }, cs.title) : null,
      sg ? h('h2', { class: 'scene__title' }, 'Stage ' + (sg.i + 1) + '. ', T(sg.st.title), ' ', h('small', null, '(' + sg.st.period + ')')) : null,
      sub ? h('p', { class: 'scene__sub' }, sub) : null);
  }
  /* 호감도 막대. 가운데가 0, 오른쪽이 오름, 왼쪽이 내림 */
  function meter(v) {
    const half = Math.max(0, Math.min(50, Math.abs(v) / AFF_MAX * 50));
    const left = v >= 0 ? 50 : 50 - half;
    return h('span', { class: 'meter ' + signClass(v) },
      h('span', { class: 'meter__track' },
        h('span', { class: 'meter__fill', style: 'left:' + left.toFixed(1) + '%;width:' + half.toFixed(1) + '%' })),
      h('span', { class: 'meter__value' }, fmtSigned(v)));
  }
  /* 4인의 현재 호감도. delta 를 주면 이번 변화량도 같이 표시 */
  function castBar(caseId, sums, delta) {
    return h('ul', { class: 'cast' }, CONTENT.characters.map(function (ch) {
      return h('li', { class: 'cast__char', 'data-char': ch.id },
        h('span', { class: 'cast__emoji' }, ch.emoji),
        h('span', { class: 'cast__name' }, ch.name),
        ch.id === 'field' && caseId ? h('span', { class: 'cast__role' }, CASE[caseId].fieldRole) : null,
        meter(sums[ch.id] || 0),
        delta ? h('span', { class: 'cast__delta ' + signClass(delta[ch.id]) }, '이번 Stage ' + fmtSigned(delta[ch.id])) : null);
    }));
  }
  /* 대화창. step 번째 줄까지 보여 줌. 지나간 줄은 is-past (디자인에서 숨겨도 됨) */
  function dialogueBox(lines, step, caseId) {
    const box = h('div', { class: 'dialogue' });
    lines.forEach(function (ln, i) {
      if (i > step) return;
      const ch = CHAR[ln.who];
      box.appendChild(h('p', { class: 'dialogue__line ' + (i === step ? 'is-current' : 'is-past') + (ch ? '' : ' dialogue__line--system'), 'data-char': ln.who },
        ch ? h('span', { class: 'dialogue__who' }, ch.emoji + ' ' + ch.name,
          ln.who === 'field' && caseId ? ' · ' + CASE[caseId].fieldRole : '',
          ln.mood ? h('em', { class: 'dialogue__mood' }, ' (' + ln.mood + ')') : null) : null,
        h('span', { class: 'dialogue__text' }, T(ln.text))));
    });
    return box;
  }
  function choiceList(st) {
    return h('ol', { class: 'choices' }, st.choices.map(function (ch, i) {
      return h('li', { class: 'choice', 'data-choice': i },
        h('span', { class: 'choice__num' }, NUM[i]),
        h('span', { class: 'choice__line' }, '“', T(ch.line), '”'),
        CONFIG.showPolicyOnVote ? h('span', { class: 'choice__policy' }, ch.tag + ' · ', T(ch.policy)) : null);
    }));
  }
  /* 학생들이 적은 한 줄 이유. filterChoice 를 주면 그 선택지만 */
  function reasons(key, opt) {
    const v = S.votes[key] || {};
    const hid = S.hide[key] || {};
    let items = Object.keys(v).filter(function (pid) {
      return S.players[pid] && v[pid] && v[pid].r && !hid[pid] && (opt.filterChoice == null || v[pid].c === opt.filterChoice);
    }).map(function (pid) { return { pid: pid, name: S.players[pid].name, dept: S.players[pid].dept, c: v[pid].c, r: v[pid].r, t: v[pid].t || 0 }; });
    items.sort(function (a, b) { return b.t - a.t; });
    if (opt.limit) items = items.slice(0, opt.limit);
    if (!items.length) return null;
    return h('ul', { class: 'feed' }, items.map(function (it) {
      return h('li', { class: 'feed__item', 'data-pid': it.pid,
        title: VIEW === 'host' ? '누르면 화면에서 숨김' : null,
        onclick: VIEW === 'host' ? function () { setHidden(key, it.pid, true); } : null },
        h('span', { class: 'feed__who' }, it.name, ' ', h('small', null, it.dept)),
        h('span', { class: 'feed__text' }, it.r));
    }));
  }
  function routeBanner(cs, r, withIntro) {
    return h('div', { class: 'route-banner', 'data-route': r },
      h('p', { class: 'route-banner__badge' }, T(cs.routes[r].badge)),
      h('h2', { class: 'route-banner__name' }, CONTENT.routes[r].name + ' 〈' + CONTENT.routes[r].title + '〉'),
      h('p', { class: 'route-banner__outcome' }, '기존 시나리오: ' + cs.outcomes[r][0] + ' — ' + cs.outcomes[r][1]),
      withIntro ? h('p', { class: 'route-banner__intro' }, T(cs.routes[r].intro)) : null,
      h('p', { class: 'route-banner__relation' }, CONTENT.routes[r].relation));
  }
  function playerList() {
    const ids = playerIds().sort(function (a, b) { return (S.players[a].t || 0) - (S.players[b].t || 0); });
    if (!ids.length) return h('p', { class: 'empty' }, '아직 입장한 사람이 없습니다.');
    return h('ul', { class: 'players' }, ids.map(function (pid) {
      const p = S.players[pid];
      return h('li', { class: 'players__item' + (p.bot ? ' is-bot' : '') },
        h('span', { class: 'players__name' }, p.name), ' ', h('small', { class: 'players__dept' }, p.dept),
        VIEW === 'host' ? h('button', { type: 'button', class: 'link players__remove', title: '이 참가자 지우기', onclick: function () { removePlayer(pid); } }, '×') : null);
    }));
  }

  /* QR 코드 (맨 아래에 넣어 둔 QR 라이브러리 사용) */
  const qrCache = {};
  function joinUrl() {
    let u;
    try { u = new URL(location.href); } catch (e) { return location.href; }
    u.search = ''; u.hash = '';
    if (SESSION !== DEFAULT_SESSION) u.searchParams.set('s', SESSION);
    if (Q.has('demo')) u.searchParams.set('demo', '1');
    return u.toString();
  }
  function qrBox(url, cls) {
    const box = h('div', { class: 'qr ' + (cls || '') });
    try {
      if (!qrCache[url]) {
        const qr = window.qrcode(0, 'M');
        qr.addData(url); qr.make();
        const n = qr.getModuleCount(), m = 4;                   // m = 둘레 여백(칸)
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', '0 0 ' + (n + 2 * m) + ' ' + (n + 2 * m));
        svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', '접속 QR 코드');
        svg.setAttribute('shape-rendering', 'crispEdges');
        const bg = document.createElementNS(NS, 'rect');
        bg.setAttribute('width', '100%'); bg.setAttribute('height', '100%'); bg.setAttribute('fill', '#fff');
        let d = '';
        for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) if (qr.isDark(row, col)) d += 'M' + (col + m) + ' ' + (row + m) + 'h1v1h-1z';
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', d); path.setAttribute('fill', '#000');
        svg.appendChild(bg); svg.appendChild(path);
        qrCache[url] = svg;
      }
      box.appendChild(qrCache[url].cloneNode(true));
    } catch (e) {
      box.appendChild(h('p', { class: 'qr__fail' }, 'QR을 만들지 못했습니다. 주소를 직접 입력해 주세요.'));
    }
    return box;
  }

  /* ============================================================
     장면별 화면 (발표 화면). 장면 종류 하나에 함수 하나.
     ============================================================ */
  const SCREEN = {
    lobby: function () {
      const url = joinUrl();
      return h('section', { class: 'scene scene--lobby' },
        gameTitle(),
        h('p', { class: 'game-subtitle' }, CONTENT.subtitle),
        h('p', { class: 'game-team' }, CONTENT.team),
        h('div', { class: 'lobby__join' },
          qrBox(url, 'qr--large'),
          h('div', { class: 'lobby__how' },
            h('p', null, '휴대폰으로 QR을 찍고 이름과 학과를 입력해 주세요.'),
            h('p', { class: 'lobby__url' }, url),
            DEMO ? h('p', { class: 'notice' }, '데모 모드라서 휴대폰으로는 접속되지 않습니다. 맨 위의 "참가자 화면 새 탭으로 열기"를 쓰세요.') : null,
            h('p', { class: 'lobby__count' }, '입장 ', h('strong', null, String(playerCount())), '명'))),
        playerList());
    },
    question: function () {
      return h('section', { class: 'scene scene--question' },
        h('h2', { class: 'scene__title' }, '핵심 질문'),
        h('p', { class: 'big-question' }, T(CONTENT.question)),
        h('p', { class: 'role' }, T(CONTENT.role)));
    },
    cast: function () {
      return h('section', { class: 'scene scene--cast' },
        h('h2', { class: 'scene__title' }, '등장인물'),
        h('ul', { class: 'cast-intro' }, CONTENT.characters.map(function (ch) {
          return h('li', { class: 'cast-intro__char', 'data-char': ch.id },
            h('span', { class: 'cast__emoji' }, ch.emoji),
            h('strong', { class: 'cast__name' }, ch.name), ' ', h('span', { class: 'cast__job' }, '(' + ch.job + ')'),
            h('p', { class: 'cast-intro__criterion' }, ch.criterion + ' · ' + ch.archetype),
            h('p', { class: 'cast-intro__line' }, '“', T(ch.line), '”'));
        })));
    },
    howto: function () {
      const hw = CONTENT.howto;
      return h('section', { class: 'scene scene--howto' },
        h('h2', { class: 'scene__title' }, '진행 방식'),
        h('p', null, T(hw.lead)),
        h('ol', { class: 'steps' }, hw.steps.map(function (s) { return h('li', null, h('strong', null, T(s[0])), ' — ', T(s[1])); })),
        h('h3', null, '점수'),
        h('ul', { class: 'bullets' }, hw.scoring.map(function (s) { return h('li', null, h('strong', null, s[0]), ' ' + s[1] + ' — ' + s[2]); })),
        h('h3', null, '루트'),
        h('p', { class: 'score-rule' }, T(hw.rule)));
    },
    caseIntro: function (c) {
      const cs = CASE[c.sc.caseId];
      return h('section', { class: 'scene scene--case-intro' },
        h('header', { class: 'scene__head' },
          h('h2', { class: 'scene__title' }, cs.title),
          h('p', { class: 'scene__sub' }, T(cs.tagline))),
        h('p', { class: 'background' }, T(cs.background)),
        h('dl', { class: 'timeline' }, cs.timeline.map(function (r) { return [h('dt', null, r[0]), h('dd', null, T(r[1]))]; })));
    },
    situation: function (c) {
      const sg = STAGE[c.sc.key];
      return h('section', { class: 'scene scene--situation' },
        sceneHead(c),
        h('p', { class: 'scene__question' }, T(sg.st.question)),
        h('ul', { class: 'bullets' }, sg.st.situation.map(function (s) { return h('li', null, T(s)); })),
        h('p', { class: 'scene__narration' }, T(sg.st.scene)),
        castBar(c.sc.caseId, classAffinity(c.sc.caseId, c.idx)),
        c.step >= 1 ? dialogueBox(sg.st.dialogue, c.step - 1, c.sc.caseId) : null);
    },
    vote: function (c) {
      const sg = STAGE[c.sc.key];
      const sum = stageSummary(c.sc.key);
      return h('section', { class: 'scene scene--vote' },
        sceneHead(c),
        h('p', { class: 'scene__question' }, T(sg.st.question)),
        h('p', { class: 'vote__prompt' }, '어떤 대사로 답할까요? 휴대폰에서 골라 주세요.'),
        choiceList(sg.st),
        h('div', { class: 'vote__status' },
          h('p', { class: 'vote__count' }, '투표 ', h('strong', null, String(sum.voters)), ' / ' + playerCount() + '명',
            c.open === c.sc.key ? '' : ' · 마감'),
          qrBox(joinUrl(), 'qr--small')),
        c.feed ? reasons(c.sc.key, { limit: 8 }) : null);
    },
    result: function (c) {
      const sg = STAGE[c.sc.key];
      const sum = stageSummary(c.sc.key);
      const counts = [sum.n0, sum.n1, sum.n2];
      const top = Math.max.apply(null, counts);
      return h('section', { class: 'scene scene--result' },
        sceneHead(c),
        h('p', { class: 'scene__question' }, T(sg.st.question)),
        h('ol', { class: 'tally' }, sg.st.choices.map(function (ch, i) {
          const n = counts[i];
          const pct = sum.voters ? Math.round(n / sum.voters * 100) : 0;
          return h('li', { class: 'tally__row' + (n > 0 && n === top ? ' is-top' : ''), 'data-choice': i },
            h('div', { class: 'tally__label' },
              h('span', { class: 'choice__num' }, NUM[i]),
              h('span', { class: 'choice__line' }, '“', T(ch.line), '”'),
              h('span', { class: 'choice__policy' }, ch.tag + ' · ' + ch.score + '점')),
            h('div', { class: 'tally__bar' }, h('span', { class: 'tally__fill', style: 'width:' + pct + '%' })),
            h('div', { class: 'tally__num' }, n + '명 (' + pct + '%)'),
            reasons(c.sc.key, { filterChoice: i }));
        })),
        h('p', { class: 'result__score' }, '이번 Stage 반 점수 ', h('strong', null, sum.total + '점'),
          ' / 만점 ' + sum.max + '점 (' + sum.voters + '명 × ' + MAX_SCORE + '점)'),
        castBar(c.sc.caseId, classAffinity(c.sc.caseId, c.idx), sum.aff));
    },
    extra: function (c) {
      const ex = STAGE[c.sc.key].st.extra;
      return h('section', { class: 'scene scene--extra', 'data-kind': ex.kind },
        sceneHead(c),
        ex.kind === 'hidden'
          ? h('p', { class: 'hidden-banner' }, '💌 HIDDEN EVENT UNLOCKED : ', T(ex.title))
          : h('h3', { class: 'extra__title' }, T(ex.title)),
        ex.lead ? h('p', { class: 'extra__lead' }, T(ex.lead)) : null,
        h('dl', { class: 'facts' }, ex.rows.map(function (r) { return [h('dt', null, T(r[0])), h('dd', null, T(r[1]))]; })),
        ex.note ? h('p', { class: 'extra__note' }, T(ex.note)) : null);
    },
    actual: function (c) {
      const sg = STAGE[c.sc.key];
      const ac = sg.st.actual;
      const sum = stageSummary(c.sc.key);
      const counts = [sum.n0, sum.n1, sum.n2];
      return h('section', { class: 'scene scene--actual' },
        sceneHead(c),
        h('h3', null, '실제 선택'),
        h('ul', { class: 'bullets' }, ac.lines.map(function (l) { return h('li', null, T(l)); })),
        h('p', { class: 'actual__match' }, '가까운 선택지: ', h('strong', null, NUM[ac.choice] + ' ' + sg.st.choices[ac.choice].tag),
          ac.note ? [' — ', T(ac.note)] : null),
        h('p', { class: 'actual__class' }, '우리 반: ' + sg.st.choices.map(function (ch, i) { return NUM[i] + ' ' + ch.tag + ' ' + counts[i] + '명'; }).join(' / ')));
    },
    unlock: function (c) {
      const cs = CASE[c.sc.caseId];
      const sum = caseSummary(cs.id);
      const el = h('section', { class: 'scene scene--unlock' },
        h('header', { class: 'scene__head' },
          h('p', { class: 'scene__case' }, cs.title),
          h('h2', { class: 'scene__title' }, '점수 합산')));
      if (!sum) { el.appendChild(h('p', { class: 'empty' }, '투표가 없어 루트를 정할 수 없습니다.')); return el; }
      el.appendChild(h('ul', { class: 'score-sum' },
        cs.stages.map(function (st, i) {
          const s = stageSummary(cs.id + '_' + st.id);
          return h('li', null, 'Stage ' + (i + 1) + ': ' + s.total + '점 / ' + s.max + '점 (' + s.voters + '명)');
        }),
        h('li', { class: 'score-sum__total' }, '합계: ', h('strong', null, sum.total + '점'), ' / 만점 ' + sum.max + '점 = ', h('strong', null, sum.pct + '%'))));
      el.appendChild(h('p', { class: 'score-rule' }, T(CONTENT.howto.rule)));
      if (c.step >= 1) {
        el.appendChild(routeBanner(cs, sum.route, true));
        const sp = personalSpread(cs.id);
        if (CONFIG.showPersonalRoute && sp.n) el.appendChild(h('p', { class: 'spread' }, '각자 점수로 보면: 루트 A ' + sp.A + '명 · 루트 B ' + sp.B + '명 · 루트 C ' + sp.C + '명'));
      }
      if (c.step >= 2) {
        const ar = cs.actual.route;
        el.appendChild(h('div', { class: 'actual-history' },
          h('h3', null, '실제 역사'),
          h('p', null, h('strong', null, CONTENT.routes[ar].name + ' 〈' + CONTENT.routes[ar].title + '〉' + (cs.actual.near ? '에 근접' : '')),
            ' · ' + cs.outcomes[ar][0]),
          h('p', null, T(cs.actual.text)),
          h('p', { class: 'actual-history__match' }, sum.route === ar ? '우리 반의 선택은 실제 역사와 같은 루트입니다.' : '우리 반의 선택은 실제 역사와 다른 루트입니다.')));
      }
      return el;
    },
    cutscene: function (c) {
      return endingScene(c, '엔딩 대화', function (cs, rt) {
        return [h('p', { class: 'route-banner__intro' }, T(rt.intro)), dialogueBox(rt.cutscene, c.step, cs.id)];
      });
    },
    aftermath: function (c) {
      return endingScene(c, '4인 호감도 최종 결과', function (cs, rt) {
        return [
          h('ul', { class: 'aftermath' }, rt.affinity.map(function (a) {
            const ch = CHAR[a.who];
            return h('li', { class: 'aftermath__row', 'data-char': a.who },
              h('strong', { class: 'aftermath__who' }, ch.emoji + ' ' + ch.name), ' ',
              h('span', { class: 'aftermath__level' }, T(a.level)),
              h('p', { class: 'aftermath__log' }, T(a.log)));
          })),
          h('p', { class: 'aftermath__source' }, '후일담 로그: ', T(rt.logLabel)),
        ];
      });
    },
    frame: function (c) {
      return endingScene(c, '3대 지식 분석 프레임', function (cs, rt) {
        return h('dl', { class: 'facts' }, rt.frame.map(function (f, i) { return [h('dt', null, CONTENT.frameLabels[i]), h('dd', null, T(f))]; }));
      });
    },
    tradeoff: function (c) {
      return endingScene(c, '얻은 것과 치른 대가', function (cs, rt) {
        return h('dl', { class: 'facts' }, h('dt', null, '얻은 것'), h('dd', null, T(rt.gain)), h('dt', null, '치른 대가'), h('dd', null, T(rt.cost)));
      });
    },
    ask: function (c) {
      return endingScene(c, '엔딩 후속 질문', function (cs, rt) {
        return h('p', { class: 'big-question' }, T(rt.question));
      });
    },
    compare: function () {
      return h('section', { class: 'scene scene--compare' },
        h('h2', { class: 'scene__title' }, '두 사례 비교'),
        h('ul', { class: 'compare' }, CONTENT.cases.map(function (cs) {
          const sum = caseSummary(cs.id);
          const ar = cs.actual.route;
          return h('li', { class: 'compare__case', 'data-case': cs.id },
            h('h3', null, cs.title),
            h('p', null, '우리 반: ', sum
              ? h('strong', null, CONTENT.routes[sum.route].name + ' 〈' + CONTENT.routes[sum.route].title + '〉')
              : h('span', { class: 'empty' }, '투표 없음'),
              sum ? ' · ' + cs.outcomes[sum.route][0] + ' (' + sum.total + '점 / ' + sum.max + '점, ' + sum.pct + '%)' : ''),
            h('p', null, '실제 역사: ', h('strong', null, CONTENT.routes[ar].name + ' 〈' + CONTENT.routes[ar].title + '〉' + (cs.actual.near ? '에 근접' : '')), ' · ' + cs.outcomes[ar][0]));
        })));
    },
    conclusion: function (c) {
      return h('section', { class: 'scene scene--conclusion' },
        h('h2', { class: 'scene__title' }, T(CONTENT.conclusion.title)),
        CONTENT.conclusion.paragraphs.map(function (p, i) {
          return i <= c.step ? h('p', { class: 'conclusion__p ' + (i === c.step ? 'is-current' : 'is-past') }, T(p)) : null;
        }));
    },
  };
  /* 엔딩 장면 공통 틀: 반 루트(또는 발표자가 고른 미리보기 루트)의 내용을 보여 줌 */
  function endingScene(c, label, body) {
    const cs = CASE[c.sc.caseId];
    const sum = caseSummary(cs.id);
    const r = endingRouteFor(cs.id);
    const el = h('section', { class: 'scene scene--ending scene--' + c.sc.type, 'data-route': r || '' });
    if (!r) {
      el.appendChild(h('header', { class: 'scene__head' }, h('p', { class: 'scene__case' }, cs.title), h('h2', { class: 'scene__title' }, label)));
      el.appendChild(h('p', { class: 'empty' }, '투표가 없어 루트를 정할 수 없습니다. 아래 "루트 보기"에서 A·B·C를 골라 볼 수 있습니다.'));
      return el;
    }
    el.appendChild(h('header', { class: 'scene__head' },
      h('p', { class: 'scene__case' }, cs.title),
      h('h2', { class: 'scene__title' }, CONTENT.routes[r].name + ' 〈' + CONTENT.routes[r].title + '〉'),
      h('p', { class: 'scene__sub' }, label,
        c.peek && (!sum || sum.route !== c.peek) ? ' · 다른 루트 미리보기' + (sum ? ' (우리 반은 루트 ' + sum.route + ')' : '') : '')));
    append(el, body(cs, cs.routes[r]));
    return el;
  }

  function renderScreen() {
    const c = cur();
    const main = h('main', { class: 'stage', 'data-scene': c.sc.id, 'data-type': c.sc.type, 'data-case': c.sc.caseId || '', 'data-step': c.step });
    main.appendChild(SCREEN[c.sc.type](c));
    return main;
  }

  /* ============================================================
     장면별 화면 (참가자 휴대폰)
     ============================================================ */
  function pHead(c) {
    const cs = c.sc.caseId ? CASE[c.sc.caseId] : null;
    const sg = c.sc.key ? STAGE[c.sc.key] : null;
    return h('header', { class: 'pscene__head' },
      cs ? h('p', { class: 'pscene__case' }, cs.title) : null,
      sg ? h('h2', { class: 'pscene__title' }, 'Stage ' + (sg.i + 1) + '. ', T(sg.st.title)) : null);
  }
  function myChoice(key) {
    const mine = S.myVotes[key];
    const ch = mine ? STAGE[key].st.choices[mine.c] : null;
    if (!ch) return null;
    return h('div', { class: 'my-choice' },
      h('p', { class: 'my-choice__line' }, '내 선택: ', h('span', { class: 'choice__num' }, NUM[mine.c]), ' “', T(ch.line), '”'),
      mine.r ? h('p', { class: 'my-choice__reason' }, '이유: ' + mine.r) : null);
  }
  function affinityList(aff, label) {
    return h('div', { class: 'my-affinity' },
      h('p', { class: 'my-affinity__label' }, label),
      h('ul', { class: 'my-affinity__list' }, CONTENT.characters.map(function (ch) {
        return h('li', { class: signClass(aff[ch.id]), 'data-char': ch.id }, ch.emoji + ' ' + ch.name + ' ' + fmtSigned(aff[ch.id]));
      })));
  }
  function classRouteLine(cs) {
    const res = S.results[cs.id];
    if (!res || !res.route) return h('p', { class: 'notice' }, '점수를 합산하고 있습니다.');
    return h('p', { class: 'class-route' }, '우리 반: ',
      h('strong', null, CONTENT.routes[res.route].name + ' 〈' + CONTENT.routes[res.route].title + '〉'),
      ' (' + res.total + '점 / ' + res.max + '점, ' + res.pct + '%)');
  }
  function myRouteLine(cs) {
    if (!CONFIG.showPersonalRoute) return null;
    const mc = myCase(cs.id);
    if (!mc.complete) return h('p', { class: 'my-route' }, '내 선택만 보면: 두 Stage를 모두 투표해야 나옵니다.');
    return h('p', { class: 'my-route' }, '내 선택만 보면: ' + mc.score + '점 → ',
      h('strong', null, CONTENT.routes[mc.route].name + ' 〈' + CONTENT.routes[mc.route].title + '〉'));
  }
  const WATCH = '앞의 화면을 봐 주세요.';

  const PLAY = {
    wait: function (c) {
      return h('section', { class: 'pscene pscene--wait' },
        pHead(c),
        c.sc.type === 'lobby' ? h('p', { class: 'notice notice--ok' }, '입장했습니다. 곧 시작합니다.') : null,
        c.sc.type === 'situation' ? h('p', { class: 'pscene__question' }, T(STAGE[c.sc.key].st.question)) : null,
        h('p', { class: 'pscene__hint' }, c.sc.type === 'situation' ? '곧 투표가 열립니다. ' + WATCH : WATCH));
    },
    vote: function (c) {
      const key = c.sc.key, sg = STAGE[key], mine = S.myVotes[key];
      const wrap = h('section', { class: 'pscene pscene--vote' }, pHead(c), h('p', { class: 'pscene__question' }, T(sg.st.question)));
      if (c.open !== key) {
        wrap.appendChild(h('p', { class: 'notice' }, '투표가 마감되었습니다.'));
        append(wrap, myChoice(key));
        return wrap;
      }
      const d = S.draft[key] || (S.draft[key] = { c: mine ? mine.c : null, r: mine && mine.r ? mine.r : '', editing: !mine, touched: false });
      const sn = S.sends[key] || (S.sends[key] = { sending: false, slow: false, error: '' });   // 이 스테이지의 제출 상태
      if (mine && !d.editing && !sn.sending) {
        wrap.appendChild(h('p', { class: 'notice notice--ok' }, '제출했습니다.'));
        append(wrap, myChoice(key));
        wrap.appendChild(h('button', { type: 'button', class: 'secondary', onclick: function () { d.editing = true; d.touched = true; d.c = mine.c; d.r = mine.r || ''; requestRender(); } }, '선택 바꾸기'));
        return wrap;
      }
      const form = h('form', { class: 'ballot', novalidate: true });
      const send = function () {
        if (sn.sending) return;
        if (d.c == null) { sn.error = '대사를 하나 골라 주세요.'; requestRender(); return; }
        sn.sending = true; sn.slow = false; sn.error = ''; requestRender();
        const slowTimer = setTimeout(function () { if (sn.sending) { sn.slow = true; requestRender(); } }, 8000);
        submitVote(key, d.c, d.r).then(function () {
          clearTimeout(slowTimer); sn.sending = false; sn.slow = false; d.editing = false; d.touched = false; requestRender();
        }, function (err) {
          // 연결이 끊긴 동안 누른 표가 마감 뒤에 도착하면 서버가 받지 않음
          clearTimeout(slowTimer); sn.sending = false; sn.slow = false;
          sn.error = '제출하지 못했습니다. 투표가 마감되었는지 확인해 주세요.';
          if (window.console) console.error(err);
          requestRender();
        });
      };
      onEnter(form, send);
      form.appendChild(h('p', { class: 'ballot__prompt' }, '어떤 대사로 답할까요?'));
      sg.st.choices.forEach(function (ch, i) {
        const input = h('input', { type: 'radio', name: 'choice', value: String(i), id: 'choice-' + i, checked: d.c === i,
          onchange: function () {
            d.c = i; d.touched = true;
            Array.prototype.forEach.call(form.querySelectorAll('.ballot__choice'), function (el, j) { el.classList.toggle('is-selected', j === i); });
          } });
        form.appendChild(h('label', { class: 'ballot__choice' + (d.c === i ? ' is-selected' : ''), for: 'choice-' + i },
          input,
          h('span', { class: 'choice__num' }, NUM[i]),
          h('span', { class: 'choice__line' }, '“', T(ch.line), '”'),
          CONFIG.showPolicyOnVote ? h('span', { class: 'choice__policy' }, ch.tag + ' · ', T(ch.policy)) : null));
      });
      const reason = h('input', { type: 'text', id: 'reason', class: 'ballot__reason', maxlength: String(CONFIG.reasonMax), value: d.r, autocomplete: 'off',
        oninput: function () { d.r = reason.value; d.touched = true; } });
      form.appendChild(h('label', { for: 'reason', class: 'ballot__reason-label' }, '이유 한 줄 (안 적어도 됩니다)'));
      form.appendChild(reason);
      if (sn.error) form.appendChild(h('p', { class: 'notice notice--error' }, sn.error));
      if (sn.slow) form.appendChild(h('p', { class: 'notice' }, '연결이 느립니다. 투표가 열려 있는 동안 다시 연결되면 제출됩니다.'));
      form.appendChild(h('button', { type: 'button', class: 'primary ballot__send', disabled: sn.sending, onclick: send }, sn.sending ? '보내는 중…' : (mine ? '다시 제출' : '제출')));
      wrap.appendChild(form);
      return wrap;
    },
    afterVote: function (c) {
      const key = c.sc.key, sg = STAGE[key], mine = S.myVotes[key], res = S.results[key];
      const wrap = h('section', { class: 'pscene pscene--result' }, pHead(c));
      if (mine && sg.st.choices[mine.c]) {
        append(wrap, myChoice(key));
        wrap.appendChild(affinityList(sg.st.choices[mine.c].affinity || {}, '내 선택에 대한 반응'));
      } else {
        wrap.appendChild(h('p', { class: 'notice' }, '이번 Stage는 투표하지 않았습니다.'));
      }
      if (res) {
        wrap.appendChild(h('p', { class: 'class-result' }, '우리 반: ' +
          sg.st.choices.map(function (ch, i) { return NUM[i] + ' ' + (res['n' + i] || 0) + '명'; }).join(' · ') +
          ' · 반 점수 ' + res.total + '점 / ' + res.max + '점'));
      }
      wrap.appendChild(h('p', { class: 'pscene__hint' }, WATCH));
      return wrap;
    },
    ending: function (c) {
      const cs = CASE[c.sc.caseId];
      const mc = myCase(cs.id);
      return h('section', { class: 'pscene pscene--ending' },
        pHead(c),
        classRouteLine(cs),
        myRouteLine(cs),
        mc.done ? affinityList(mc.aff, '내 선택으로 쌓인 호감도') : null,
        h('p', { class: 'pscene__hint' }, WATCH));
    },
    summary: function () {
      return h('section', { class: 'pscene pscene--summary' },
        h('h2', { class: 'pscene__title' }, '내 기록'),
        CONTENT.cases.map(function (cs) {
          return h('div', { class: 'summary__case', 'data-case': cs.id },
            h('h3', null, cs.title),
            cs.stages.map(function (st, i) {
              const key = cs.id + '_' + st.id;
              const mine = S.myVotes[key];
              const ch = mine ? st.choices[mine.c] : null;
              return h('p', { class: 'summary__stage' }, 'Stage ' + (i + 1) + ': ', ch ? [NUM[mine.c] + ' ', ch.tag] : '투표 안 함');
            }),
            classRouteLine(cs),
            myRouteLine(cs));
        }),
        h('p', { class: 'pscene__hint' }, WATCH));
    },
  };
  PLAY.result = PLAY.afterVote; PLAY.extra = PLAY.afterVote; PLAY.actual = PLAY.afterVote;
  PLAY.unlock = PLAY.ending;
  Object.keys(ENDING_TYPES).forEach(function (t) { PLAY[t] = PLAY.ending; });
  PLAY.compare = PLAY.summary; PLAY.conclusion = PLAY.summary;

  function joinForm() {
    const name = h('input', { id: 'join-name', type: 'text', maxlength: '20', autocomplete: 'name', value: S.me.name || '' });
    const dept = h('input', { id: 'join-dept', type: 'text', maxlength: '30', autocomplete: 'organization', value: S.me.dept || '' });
    const enter = function () {
      const n = name.value.trim(), d = dept.value.trim();
      S.me.name = n; S.me.dept = d;
      if (!n || !d) { S.me.error = '이름과 학과를 모두 적어 주세요.'; requestRender(); return; }
      join(n, d);
      requestRender();
    };
    const form = h('form', { class: 'join', novalidate: true },
      gameTitle(),
      S.me.notice ? h('p', { class: 'notice' }, S.me.notice) : null,
      h('label', { for: 'join-name' }, '이름'), name,
      h('label', { for: 'join-dept' }, '학과'), dept,
      S.me.error ? h('p', { class: 'notice notice--error' }, S.me.error) : null,
      h('button', { type: 'button', class: 'primary join__enter', onclick: enter }, S.me.editing ? '저장' : '입장'));
    onEnter(form, enter);
    return form;
  }

  function renderPlay() {
    const root = h('div', { class: 'play' });
    if (!S.me.checked) { root.appendChild(h('p', { class: 'boot' }, '불러오는 중…')); return root; }
    if (!S.me.joined || S.me.editing) { root.appendChild(joinForm()); return root; }
    const c = cur();
    root.appendChild(h('header', { class: 'play__me' },
      h('span', null, h('strong', null, S.me.name), ' · ' + S.me.dept),
      h('button', { type: 'button', class: 'link', onclick: function () { S.me.editing = true; S.me.error = ''; requestRender(); } }, '수정')));
    root.appendChild((PLAY[c.sc.type] || PLAY.wait)(c));
    return root;
  }

  /* ============================================================
     바깥 틀: 상단 표시줄, 발표자 조작 버튼
     ============================================================ */
  let chrome = null;
  function buildChrome() {
    const app = document.getElementById('app');
    app.replaceChildren();
    chrome = {};
    chrome.title = h('span', { class: 'topbar__title' }, CONTENT.title);
    chrome.scene = h('span', { class: 'topbar__scene' });
    chrome.count = h('span', { class: 'topbar__count' });
    chrome.conn = h('span', { class: 'topbar__conn' });
    chrome.flash = h('p', { class: 'flash', hidden: true });
    if (DEMO) app.appendChild(buildDemoBar());
    app.appendChild(h('div', { class: 'topbar' }, chrome.title, chrome.scene, chrome.count, chrome.conn));
    app.appendChild(chrome.flash);
    chrome.view = h('div', { id: 'view' });
    app.appendChild(chrome.view);
    if (VIEW === 'host') app.appendChild(buildControls());
  }
  function updateChrome() {
    if (!chrome) return;
    const c = cur();
    chrome.scene.textContent = VIEW === 'play' ? '' : c.sc.label + (c.steps > 1 ? ' (' + (c.step + 1) + '/' + c.steps + ')' : '') +
      (VIEW === 'host' && SESSION !== DEFAULT_SESSION ? ' · 세션 ' + SESSION : '');
    chrome.count.textContent = VIEW === 'play' ? '' : '입장 ' + playerCount() + '명';
    chrome.conn.textContent = DEMO ? '데모 모드' : (S.connected ? '연결됨' : '연결 중…');
    chrome.conn.className = 'topbar__conn ' + (DEMO ? 'is-demo' : S.connected ? 'is-on' : 'is-off');
    chrome.flash.hidden = !(S.flash || S.fatal);
    chrome.flash.textContent = S.fatal || S.flash;
  }

  let ctl = null;
  function buildControls() {
    ctl = {};
    ctl.prev = h('button', { type: 'button', onclick: function () { go(-1); } }, '◀ 이전');
    ctl.next = h('button', { type: 'button', class: 'primary', onclick: function () { go(1); } }, '다음 ▶');
    ctl.pos = h('span', { class: 'controls__pos' });
    ctl.jump = h('select', { 'aria-label': '장면 이동', onchange: function () { enter(Number(ctl.jump.value), 0); ctl.jump.blur(); } },
      SCENES.map(function (s) { return h('option', { value: String(s.index) }, (s.index + 1) + '. ' + s.label); }));

    ctl.routeBox = h('span', { class: 'controls__group', hidden: true }, '루트 보기: ');
    ctl.routeBtns = {};
    [['', '우리 반'], ['A', 'A'], ['B', 'B'], ['C', 'C']].forEach(function (r) {
      const b = h('button', { type: 'button', onclick: function () { setPeek(r[0]); } }, r[1]);
      ctl.routeBtns[r[0]] = b; ctl.routeBox.appendChild(b);
    });

    ctl.voteBox = h('span', { class: 'controls__group', hidden: true });
    ctl.feedBtn = h('button', { type: 'button', onclick: toggleFeed });
    ctl.unhideBtn = h('button', { type: 'button', hidden: true, onclick: function () { const c = cur(); if (c.sc.key) unhideAll(c.sc.key); } });
    ctl.clearBtn = h('button', { type: 'button', onclick: function () { const c = cur(); if (c.sc.key) clearStageVotes(c.sc.key); } }, '이 Stage 투표 지우기');
    append(ctl.voteBox, [ctl.feedBtn, ctl.unhideBtn, ctl.clearBtn]);

    ctl.resetBtn = h('button', { type: 'button', onclick: function () { S.ui.resetArmed = true; requestRender(); } }, '전체 초기화');
    ctl.resetYes = h('button', { type: 'button', class: 'danger', hidden: true, onclick: function () { S.ui.resetArmed = false; resetAll(); requestRender(); } }, '정말 지움 (참가자·투표 전부)');
    ctl.resetNo = h('button', { type: 'button', hidden: true, onclick: function () { S.ui.resetArmed = false; requestRender(); } }, '취소');

    return h('div', { class: 'controls' },
      h('div', { class: 'controls__main' }, ctl.prev, ctl.next, ctl.pos, ctl.jump, ctl.routeBox, ctl.voteBox),
      h('details', { class: 'controls__more' },
        h('summary', null, '테스트 도구'),
        h('button', { type: 'button', onclick: function () { addBots(5); } }, '가상 참가자 5명 추가'),
        h('button', { type: 'button', onclick: botVote }, '가상 투표 넣기 (투표 장면에서)'),
        h('button', { type: 'button', onclick: removeBots }, '가상 참가자 지우기')),
      h('details', { class: 'controls__more' },
        h('summary', null, '관리'),
        h('button', { type: 'button', onclick: function () { const u = newSessionUrl(); if (u) location.href = u; } }, '새 세션으로 시작'),
        h('button', { type: 'button', onclick: downloadCsv }, '응답 내려받기 (CSV)'),
        h('button', { type: 'button', onclick: function () {
          const el = document.documentElement;
          if (document.fullscreenElement) document.exitFullscreen(); else if (el.requestFullscreen) el.requestFullscreen().catch(function () {});
        } }, '전체 화면'),
        ctl.resetBtn, ctl.resetYes, ctl.resetNo));
  }
  function updateControls() {
    if (!ctl) return;
    const c = cur();
    ctl.prev.disabled = c.idx === 0 && c.step === 0;
    ctl.next.disabled = c.idx === SCENES.length - 1 && c.step === c.steps - 1;
    ctl.pos.textContent = '장면 ' + (c.idx + 1) + ' / ' + SCENES.length;
    if (document.activeElement !== ctl.jump) ctl.jump.value = String(c.idx);

    const ending = !!ENDING_TYPES[c.sc.type];
    ctl.routeBox.hidden = !ending;
    Object.keys(ctl.routeBtns).forEach(function (r) { ctl.routeBtns[r].classList.toggle('is-on', (c.peek || '') === r); });

    const staged = !!c.sc.key;
    ctl.voteBox.hidden = !staged;
    if (staged) {
      const hiddenCount = Object.keys(S.hide[c.sc.key] || {}).length;
      ctl.feedBtn.textContent = '투표 중 이유 표시: ' + (c.feed ? '켬' : '끔');
      ctl.feedBtn.hidden = c.sc.type !== 'vote';
      ctl.unhideBtn.hidden = !hiddenCount;
      ctl.unhideBtn.textContent = '숨긴 이유 ' + hiddenCount + '개 다시 보이기';
      ctl.clearBtn.hidden = !(c.sc.type === 'vote' || c.sc.type === 'result');
    }
    ctl.resetBtn.hidden = S.ui.resetArmed;
    ctl.resetYes.hidden = !S.ui.resetArmed;
    ctl.resetNo.hidden = !S.ui.resetArmed;
  }

  /* 데모 모드에서만 보이는 화면 바꾸기 줄 */
  function viewUrl(view) {
    let u;
    try { u = new URL(location.href); } catch (e) { return '#'; }
    u.hash = '';
    if (view === 'play') u.searchParams.delete('view'); else u.searchParams.set('view', view);
    return u.toString();
  }
  function buildDemoBar() {
    function link(view, text) {
      return h('a', { href: viewUrl(view), class: VIEW === view ? 'is-on' : null, onclick: function (e) { e.preventDefault(); start(view, true); } }, text);
    }
    return h('nav', { class: 'demobar' },
      h('span', null, '데모 모드 · 화면 바꾸기: '),
      link('host', '발표자 화면'), link('screen', '발표 화면'), link('play', '참가자 화면'),
      h('a', { href: viewUrl('play'), target: '_blank', rel: 'noopener' }, '참가자 화면 새 탭으로 열기'));
  }

  /* ============================================================
     그리기
     ============================================================ */
  let renderQueued = false, lastSig = null, lastScene = null;
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(function () { renderQueued = false; render(); }, 0);
  }
  /* 화면에 영향을 주는 값이 그대로면 다시 그리지 않음 (입력 중인 글자가 지워지지 않게) */
  function signature() {
    if (VIEW !== 'play') return stable({ s: S.state, p: S.players, v: S.votes, h: S.hide });
    if (!S.me.checked) return 'boot';
    if (!S.me.joined || S.me.editing) return stable({ join: 1, n: S.me.notice, e: S.me.error, ed: S.me.editing });
    const st = S.state || {};
    const editing = {};
    Object.keys(S.draft).forEach(function (k) { editing[k] = !!S.draft[k].editing; });
    return stable({ me: [S.me.name, S.me.dept], sc: st.scene, step: st.step, open: st.open, peek: st.peek,
      my: S.myVotes, res: S.results, sends: S.sends, ed: editing });
  }
  function render() {
    if (!chrome) return;
    updateChrome();
    updateControls();
    const sig = signature();
    if (sig === lastSig) return;
    lastSig = sig;
    chrome.view.replaceChildren(VIEW === 'play' ? renderPlay() : renderScreen());
    const sceneNow = (S.state && S.state.scene) || '';
    if (sceneNow !== lastScene) { lastScene = sceneNow; try { window.scrollTo(0, 0); } catch (e) { /* 무시 */ } }   // 장면이 바뀌면 맨 위로
  }

  /* ============================================================
     서버 값 받아 오기
     ============================================================ */
  let unsubs = [];
  function listen(path, cb) { unsubs.push(S.sync.onValue(path, cb)); }
  function afterData() { publishResults(); requestRender(); }
  function subscribe() {
    unsubs.push(S.sync.onConnection(function (ok) { S.connected = ok; requestRender(); }));
    listen('state', function (v) {
      S.state = v;
      if (!v && VIEW === 'host') enter(0, 0);                   // 새 세션이면 입장 장면부터
      afterData();
    });
    listen('results', function (v) { S.results = v || {}; S.loaded.results = true; afterData(); });
    if (VIEW === 'play') {
      listen('players/' + S.me.id, function (v) {
        const was = S.me.joined;
        S.me.checked = true;
        S.me.joined = !!v;
        if (was && !v) { S.me.notice = '입장 정보가 지워졌습니다. 다시 입장해 주세요.'; S.draft = {}; S.sends = {}; }
        requestRender();
      });
      STAGE_KEYS.forEach(function (k) {
        listen('votes/' + k + '/' + S.me.id, function (v) {
          const d = S.draft[k];
          if (v) {
            S.myVotes[k] = v;
            if (d && !d.touched) { d.c = v.c; d.r = v.r || ''; d.editing = false; }
          } else {
            delete S.myVotes[k];
            if (d) d.editing = true;                              // 발표자가 투표를 지웠으면 다시 고를 수 있게
          }
          requestRender();
        });
      });
    } else {
      listen('players', function (v) { S.players = v || {}; S.loaded.players = true; afterData(); });
      listen('votes', function (v) { S.votes = v || {}; S.loaded.votes = true; afterData(); });
      listen('hide', function (v) { S.hide = v || {}; afterData(); });
    }
  }

  /* 화면 종류를 정하고 시작. 데모 모드에서는 새로 고침 없이 화면을 바꿀 수 있음 */
  function start(view, pushUrl) {
    unsubs.forEach(function (off) { try { off(); } catch (e) { /* 무시 */ } });
    unsubs = [];
    if (view !== 'host' && view !== 'screen') view = 'play';
    if (view === 'host' && CONFIG.hostKey && Q.get('key') !== CONFIG.hostKey) view = 'play';
    VIEW = view;
    S.state = null; S.results = {}; S.players = {}; S.votes = {}; S.hide = {};
    S.myVotes = {}; S.draft = {}; S.sends = {};
    S.me.checked = false; S.me.joined = false; S.me.editing = false;
    S.loaded = {};
    lastSig = null; ctl = null;
    document.body.className = 'view-' + VIEW + (DEMO ? ' is-demo' : '');
    if (pushUrl) { try { history.replaceState(null, '', viewUrl(view)); } catch (e) { /* 미리보기 창에서는 주소를 못 바꿈 */ } }
    buildChrome();
    if (S.sync) subscribe();
    requestRender();
  }

  function boot() {
    loadIdentity();
    start(Q.get('view') || 'play', false);
    createSync().then(function (sync) {
      S.sync = sync;
      subscribe();
      requestRender();
    }, function (err) {
      if (window.console) console.error(err);
      S.fatal = '실시간 서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 새로 고침해 주세요.';
      requestRender();
    });
    // 발표자 화면 단축키: → / PageDown / Space = 다음, ← / PageUp = 이전
    document.addEventListener('keydown', function (e) {
      if (VIEW !== 'host' || e.altKey || e.ctrlKey || e.metaKey) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); go(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(-1); }
      else if (e.key === ' ' && tag !== 'BUTTON' && tag !== 'A' && tag !== 'SUMMARY') { e.preventDefault(); go(1); }
    });
    window.__dgdReady = true;                                   // 여기까지 왔으면 파일은 정상적으로 읽힌 것
  }

  /* 새 세션: 추측하기 어려운 세션 이름으로 발표자 화면을 다시 엶 (QR 주소에도 그 이름이 들어감).
     세션 이름을 모르면 그 세션의 자료를 읽을 수 없으므로, 실제 수업은 새 세션으로 진행하는 것을 권함 */
  function newSessionUrl() {
    let u;
    try { u = new URL(location.href); } catch (e) { return ''; }
    u.hash = '';
    u.searchParams.set('view', 'host');
    u.searchParams.set('s', 's' + randomId().slice(1, 9));
    return u.toString();
  }

  /* 점검용으로 몇 가지를 밖에서 볼 수 있게 둠 (브라우저 콘솔에서 DGD 입력) */
  window.DGD = { S: S, SCENES: SCENES, routeOf: routeOf, personalRoute: personalRoute, buildCsv: buildCsv, session: SESSION, demo: DEMO };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
