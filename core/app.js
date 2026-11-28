/* ============================================================
   ③ 동작 — 화면 전환, 투표, 집계, 실시간 연결
   한 Stage의 흐름: 상황 → 1차 투표(3선지) → 1차 결과 → 추가 자료 공개 → 2차 투표(2선지) → 2차 결과·점수 → 실제 선택
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
  const MAX_SCORE = 2;                       // 한 Stage에서 받을 수 있는 최고 점수
  const SCORE_WHY = ['배제', '추가 자료를 보고 수용', '처음부터 수용'];   // 0점·1점·2점이 되는 경우
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
  /* 스테이지마다 투표가 두 번. 1차는 votes/<스테이지 키>, 2차는 votes/<스테이지 키>_r2 에 저장 */
  const R2 = '_r2';
  const VOTE_KEYS = [];
  STAGE_KEYS.forEach(function (k) { VOTE_KEYS.push(k, k + R2); });
  /* 2차 투표 내용(final)이 내용 파일에 없거나 선택지가 둘이 아니면 기본 문구로 채움 */
  STAGE_KEYS.forEach(function (k) {
    const st = STAGE[k].st;
    const f = st.final || (st.final = {});
    if (!Array.isArray(f.choices) || f.choices.length !== 2) {
      f.choices = [
        { accept: false, tag: '배제', line: '받아들이지 않겠습니다.', policy: '' },
        { accept: true, tag: '수용', line: '받아들이겠습니다.', policy: '' },
      ];
    }
    if (!f.question) f.question = st.question;
  });
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
  const GLOSSARY = CONTENT.glossary || {};
  const SCENES = [];
  function addScene(o) { o.index = SCENES.length; SCENES.push(o); }
  addScene({ id: 'lobby', type: 'lobby', label: '입장' });
  addScene({ id: 'question', type: 'question', label: '핵심 질문' });
  addScene({ id: 'cast', type: 'cast', label: '등장인물' });
  addScene({ id: 'howto', type: 'howto', label: '진행 방식' });
  CONTENT.cases.forEach(function (c) {
    addScene({ id: c.id + '-intro', type: 'caseIntro', caseId: c.id, label: c.short + ' · 프롤로그' });
    c.stages.forEach(function (st, i) {
      const key = c.id + '_' + st.id;
      const pre = c.short + ' · Stage ' + (i + 1) + ' · ';
      // 상황 → 1차 투표(3선지) → 1차 결과 → 추가 자료 공개 → 2차 투표(2선지) → 2차 결과·점수 → 실제 선택
      // vkey = 그 장면이 다루는 투표가 저장되는 칸
      addScene({ id: key + '-situation', type: 'situation', caseId: c.id, key: key, label: pre + '상황' });
      addScene({ id: key + '-vote1', type: 'vote', round: 1, caseId: c.id, key: key, vkey: key, label: pre + '1차 투표' });
      addScene({ id: key + '-result1', type: 'result1', round: 1, caseId: c.id, key: key, vkey: key, label: pre + '1차 결과' });
      addScene({ id: key + '-extra', type: 'extra', caseId: c.id, key: key, label: pre + (st.extra.kind === 'hidden' ? '히든 이벤트' : '추가 자료') });
      addScene({ id: key + '-vote2', type: 'vote', round: 2, caseId: c.id, key: key, vkey: key + R2, label: pre + '2차 투표' });
      addScene({ id: key + '-result2', type: 'result2', round: 2, caseId: c.id, key: key, vkey: key + R2, label: pre + '2차 결과' });
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
    sends: {},            // 투표별 제출 상태 { sending, slow, error }
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
  /* 글 안의 표시
       ==이렇게==        → 형광펜(노란 밑줄)
       [[용어]]           → 용어 풀이(content.js 의 glossary)가 있는 말. 발표자 화면에서 누르면 발표 화면에도 풀이가 크게 뜸
       [[보이는 말|용어]] → 화면에는 '보이는 말'을 쓰고, 풀이는 glossary 의 '용어' 항목을 씀
     휴대폰에서는 용어 표시 없이 글만 보임 */
  const TOKEN = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|==([^=]+)==/g;
  function marked(str) {
    str = String(str);
    const out = []; let last = 0, m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(str))) {
      if (m.index > last) out.push(document.createTextNode(str.slice(last, m.index)));
      out.push(m[3] != null ? h('mark', { class: 'hl' }, m[3]) : termNode(m[1], m[2] || m[1]));
      last = TOKEN.lastIndex;
    }
    if (last < str.length || !out.length) out.push(document.createTextNode(str.slice(last)));
    return out;
  }
  function termNode(label, id) {
    if (!GLOSSARY[id] || VIEW === 'play') return document.createTextNode(label);
    if (VIEW === 'host') return h('button', { type: 'button', class: 'term', 'data-term': id, title: '눌러서 풀이 보기',
      onclick: function (e) { e.stopPropagation(); showInfo('g:' + id); } }, label);
    return h('span', { class: 'term', 'data-term': id }, label);
  }
  function T(x) {
    if (x && typeof x === 'object' && 't' in x) {
      return h('span', { class: x.draft && CONFIG.showDraftMarks ? 'is-draft' : null }, marked(x.t));
    }
    if (x == null) return document.createTextNode('');
    const m = marked(x);
    return m.length === 1 ? m[0] : h('span', null, m);
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
  function plain(x) {
    return (x && typeof x === 'object' && 't' in x ? x.t : (x == null ? '' : String(x)))
      .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1').replace(/==([^=]+)==/g, '$1');
  }
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
    if (sc.type === 'cast') return CONTENT.characters.length + 1;    // 한 명씩 → 네 명 정리
    if (sc.type === 'unlock') return 3;                         // 점수와 세 루트 개요 → 루트 해금 → 실제 역사
    if (sc.type === 'result2') return 2;                        // 표 수·점수·호감도 → 투표한 이유
    if (sc.type === 'compare') return 2;                        // 우리 반과 실제 역사의 루트 → 실제 역사를 세 기준으로
    if (sc.type === 'cutscene') {
      const r = endingRouteFor(sc.caseId);
      return r ? Math.max(1, CASE[sc.caseId].routes[r].cutscene.length) : 1;
    }
    if (sc.type === 'conclusion') return CONTENT.conclusion.paragraphs.length + 1;   // 문단들 → THE END
    return 1;
  }
  function cur() {
    const st = S.state || {};
    const sc = sceneOf(st.scene);
    const steps = stepsOf(sc);
    const step = Math.min(Math.max(0, st.step | 0), steps - 1);
    return { idx: sc.index, sc: sc, step: step, steps: steps, open: st.open || null, peek: st.peek || null, feed: st.feed !== false, rp: st.rp | 0,
      zoom: st.zoom && st.zoom.k && st.zoom.p ? { k: String(st.zoom.k), p: String(st.zoom.p) } : null,
      wall: st.wall ? String(st.wall) : null, typed: st.typed ? String(st.typed) : null,
      info: typeof st.info === 'string' ? st.info : null };
  }

  /* ============================================================
     집계 (발표자·발표 화면에서 계산)
     ============================================================ */
  function playerIds() { return Object.keys(S.players || {}); }
  function playerCount() { return playerIds().length; }

  function validPick(v, n) { return !!v && typeof v.c === 'number' && v.c >= 0 && v.c < n && v.c % 1 === 0; }
  function choicesOf(key, round) { const st = STAGE[key].st; return round === 2 ? st.final.choices : st.choices; }

  /* 한 사람의 한 Stage 점수 (팀 문서 6-3의 표). v1 = 1차 투표, v2 = 2차 투표
       2차에서 배제                          → 0점
       1차부터 직접 수용(2점짜리)이고 2차도 수용 → 2점
       그 밖에 2차에서 수용 (자료를 보고 수용)    → 1점
     2차 투표를 하지 않았으면 점수 없음(null). 점수 방식을 바꾸려면 이 함수만 고치면 됨 */
  function stageScore(key, v1, v2) {
    const st = STAGE[key].st;
    if (!validPick(v2, st.final.choices.length)) return null;
    if (!st.final.choices[v2.c].accept) return 0;
    return validPick(v1, st.choices.length) && st.choices[v1.c].score === MAX_SCORE ? MAX_SCORE : 1;
  }
  /* 그 점수에 대한 4인의 반응 = 그 점수가 붙은 1차 선택지의 호감도 값 */
  function affinityOf(key, score) {
    const list = STAGE[key].st.choices;
    for (let i = 0; i < list.length; i++) if (list[i].score === score) return list[i].affinity || {};
    return {};
  }

  /* 한 스테이지의 집계
       n1·voters1 = 1차 선택지별 표 수와 투표 인원 / n2·voters2 = 2차
       move[i][j] = 1차에서 i번, 2차에서 j번을 고른 사람 수 / byScore[점수] = 그 점수를 받은 사람 수
       total·max·voters = 반 점수, 만점, 점수가 매겨진 인원(= 2차 투표자) / aff = 4인 호감도 변화(반 평균) */
  function stageSummary(key) {
    const st = STAGE[key].st;
    const a = (S.votes && S.votes[key]) || {}, b = (S.votes && S.votes[key + R2]) || {};
    const n1 = st.choices.map(function () { return 0; });
    const n2 = st.final.choices.map(function () { return 0; });
    const move = st.choices.map(function () { return st.final.choices.map(function () { return 0; }); });
    const byScore = [0, 0, 0];
    let voters1 = 0, voters2 = 0, total = 0;
    Object.keys(a).forEach(function (pid) {
      if (!S.players[pid] || !validPick(a[pid], n1.length)) return;   // 지워진 참가자의 표는 세지 않음
      n1[a[pid].c] += 1; voters1 += 1;
    });
    Object.keys(b).forEach(function (pid) {
      if (!S.players[pid]) return;
      const sc = stageScore(key, a[pid], b[pid]);
      if (sc == null) return;
      n2[b[pid].c] += 1; voters2 += 1; total += sc; byScore[sc] += 1;
      if (validPick(a[pid], n1.length)) move[a[pid].c][b[pid].c] += 1;
    });
    const aff = {};
    CONTENT.characters.forEach(function (ch) {
      let sum = 0;
      byScore.forEach(function (cnt, sc) { sum += cnt * (affinityOf(key, sc)[ch.id] || 0); });
      aff[ch.id] = voters2 ? Math.round(sum / voters2 * 10) / 10 : 0;
    });
    return { n1: n1, voters1: voters1, n2: n2, voters2: voters2, move: move, byScore: byScore,
      total: total, voters: voters2, max: voters2 * MAX_SCORE, aff: aff };
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

  /* 한 사례의 합계. 만점 = 2차 투표를 한 사람 수 × 2점 (2차 투표를 안 한 사람은 계산에서 빠짐) */
  function caseSummary(caseId) {
    const c = CASE[caseId];
    let total = 0, max = 0;
    c.stages.forEach(function (st) { const s = stageSummary(c.id + '_' + st.id); total += s.total; max += s.max; });
    if (!max) return null;
    return { total: total, max: max, pct: Math.round(total / max * 1000) / 10, route: routeOf(total, max) };
  }

  /* 각자 점수로 본 루트 분포 (두 스테이지 모두 2차 투표까지 한 사람만) */
  function personalSpread(caseId) {
    const c = CASE[caseId];
    const out = { A: 0, B: 0, C: 0, n: 0 };
    playerIds().forEach(function (pid) {
      let score = 0, ok = true;
      c.stages.forEach(function (st) {
        const key = c.id + '_' + st.id;
        const sc = stageScore(key, ((S.votes || {})[key] || {})[pid], ((S.votes || {})[key + R2] || {})[pid]);
        if (sc == null) { ok = false; return; }
        score += sc;
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
      if (SCENE_BY_ID[key + '-result2'].index > uptoIdx) return;       // 2차 결과를 공개한 스테이지까지만
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
      const key = c.id + '_' + st.id;
      const sc = stageScore(key, S.myVotes[key], S.myVotes[key + R2]);
      if (sc == null) return;
      done += 1; score += sc;
      const a = affinityOf(key, sc);
      CONTENT.characters.forEach(function (ch) { aff[ch.id] += a[ch.id] || 0; });
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
    // 투표 장면에 들어가면 그 투표(1차 또는 2차)가 열리고, 나가면 닫힘
    return setState({ scene: sc.id, step: step || 0, open: sc.type === 'vote' ? sc.vkey : null, peek: keepPeek ? c.peek : null, rp: 0, zoom: null, wall: null, typed: null, info: null });
  }
  function go(delta) {
    if (!S.sync || VIEW !== 'host') return;
    const c = cur();
    if (delta > 0 && typingActive()) return finishTyping();      // 대사가 아직 타자 중이면 → 는 그 줄을 다 보여 주기만 함
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
  /* 결과 장면의 이유 창을 다음 장으로 (마지막 장 다음은 첫 장) */
  function reasonWindowShown(c) { return c.sc.type === 'result1' || (c.sc.type === 'result2' && c.step >= 1); }
  /* 타자 효과: 대사가 한 글자씩 나옴. 발표자가 → 를 누르면 먼저 그 줄을 다 보여 주고(발표 화면도 같이), 한 번 더 누르면 다음 대사.
     자동 검사(브라우저 자동화)에서는 주소에 typing=1 이 있을 때만 켬 */
  const TYPE_ON = (CONFIG.typeSpeed | 0) > 0 && (!navigator.webdriver || Q.has('typing'));
  let typing = { key: '', start: 0, raf: 0, done: true };
  function typeKey(c) { return c.sc.id + ':' + c.step; }
  function typingActive() { return TYPE_ON && !typing.done && typing.key === typeKey(cur()); }
  function finishTyping() { typing.done = true; return setState({ typed: typeKey(cur()) }); }
  function runTyping() {
    if (typing.raf) cancelAnimationFrame(typing.raf);
    typing.raf = 0;
    const el = document.querySelector('.vn .dialogue__line.is-current .dialogue__text');
    if (!TYPE_ON || !el || VIEW === 'play') { typing.done = true; return; }
    const c = cur(), key = typeKey(c);
    if (typing.key !== key) typing = { key: key, start: performance.now(), raf: 0, done: false };
    if (c.typed === key) typing.done = true;
    if (typing.done) return;
    const orig = Array.prototype.slice.call(el.childNodes), full = el.textContent;
    const shown = h('span', { class: 'typed' }), rest = h('span', { class: 'untyped' });
    el.replaceChildren(shown, rest);
    el.classList.add('is-typing');
    const tick = function () {
      if (!el.isConnected) return;
      const n = Math.floor((performance.now() - typing.start) / CONFIG.typeSpeed);
      if (typing.done || n >= full.length || cur().typed === key) {
        typing.done = true; typing.raf = 0;
        el.replaceChildren.apply(el, orig); el.classList.remove('is-typing');
        return;
      }
      shown.textContent = full.slice(0, n); rest.textContent = full.slice(n);
      typing.raf = requestAnimationFrame(tick);
    };
    tick();
  }
  /* 이유 모아 보기: 이 투표의 이유를 한 화면에 흩어 놓음(발표 화면도 같이). 투표 중이거나 이유 창이 보일 때만 */
  function wallAllowed(c) { return !!c.sc.vkey && (c.sc.type === 'vote' || reasonWindowShown(c)); }
  function openWall(vkey) { return setState({ wall: vkey, zoom: null }); }
  function closeWall() { return setState({ wall: null, zoom: null }); }
  function nextReasonPage() {
    const c = cur();
    if (!reasonWindowShown(c)) return;
    return setState({ rp: (c.rp + 1) % reasonPages(c.sc.vkey), zoom: null });
  }
  /* 이유 하나를 화면 가운데에 크게 띄움(발표 화면도 같이). pid 를 비우면 닫음 */
  function zoomReason(vkey, pid) { return setState({ zoom: pid ? { k: vkey, p: pid } : null }); }
  /* 용어 풀이·선택지 크게 보기. info = 'g:용어' 또는 'c:선택지 번호'. 장면이 바뀌면 닫힘 */
  function showInfo(v) { if (VIEW === 'host' && S.sync) return setState({ info: v || null }); }
  /* 지금 장면의 이유 창에 보이는 순서대로의 목록 (확대한 채 앞뒤로 넘길 때 씀) */
  function reasonOrder(c) {
    const items = reasonItems(c.sc.vkey);
    if (c.sc.type === 'vote') items.sort(function (a, b) { return b.t - a.t; });
    else items.sort(function (a, b) { return a.c - b.c || a.t - b.t; });
    return items;
  }
  function zoomStep(delta) {
    const c = cur();
    if (!c.zoom || !c.sc.vkey) return;
    const items = reasonOrder(c);
    const i = items.findIndex(function (it) { return it.pid === c.zoom.p; });
    if (i < 0 || !items.length) return zoomReason(c.sc.vkey, null);
    const j = (i + delta + items.length) % items.length;
    const per = CONFIG.reasonsPerPage || 6;
    return setState({ zoom: { k: c.sc.vkey, p: items[j].pid }, rp: c.sc.type === 'vote' ? c.rp : Math.floor(j / per) });   // 이유 창의 장도 따라감
  }

  /* 집계를 서버에 올려 둠 → 참가자 휴대폰이 "우리 반 결과"를 볼 수 있음.
     아직 화면에 공개하지 않은 결과는 올리지 않음. */
  let lastPublishTry = '';
  function publishResults() {
    if (VIEW !== 'host' || !S.sync || !S.state) return;
    if (!S.loaded.players || !S.loaded.votes || !S.loaded.results) return;   // 다 받아 온 뒤에만
    const c = cur();
    const want = {};
    SCENES.forEach(function (sc) {
      if (sc.type === 'result1' && sc.index <= c.idx) {            // 1차 결과: 선택지별 표 수
        const s1 = stageSummary(sc.key);
        want[sc.key] = { n0: s1.n1[0] || 0, n1: s1.n1[1] || 0, n2: s1.n1[2] || 0, voters1: s1.voters1 };
      }
      if (sc.type === 'result2' && sc.index <= c.idx) {            // 2차 결과: 표 수와 반 점수
        const s2 = stageSummary(sc.key);
        const w = want[sc.key] || (want[sc.key] = {});
        w.m0 = s2.n2[0] || 0; w.m1 = s2.n2[1] || 0; w.voters = s2.voters; w.total = s2.total; w.max = s2.max;
      }
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

  function clearVotes(vkey) { return S.sync.remove('votes/' + vkey).catch(reportError); }
  function removePlayer(pid) {
    const jobs = [S.sync.remove('players/' + pid)];
    VOTE_KEYS.forEach(function (k) { if (S.votes[k] && S.votes[k][pid]) jobs.push(S.sync.remove('votes/' + k + '/' + pid)); });
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
  const BOT_REASONS = ['현장에서 본 사람 말을 먼저 들어야 한다고 생각합니다', '근거가 확인돼야 정책에 쓸 수 있다고 봅니다', '조사해 보고 정해도 늦지 않습니다',
    '시간과 예산을 생각하면 이쪽이 현실적입니다', '틀릴 수는 있어도 빼 버릴 이유는 아닙니다', '테스트 의견'];
  function botVote() {
    const c = cur();
    if (c.sc.type !== 'vote') return;
    const list = choicesOf(c.sc.key, c.sc.round);
    const patch = {};
    playerIds().forEach(function (pid) {
      if (!S.players[pid].bot) return;
      const pick = Math.floor(Math.random() * list.length);
      const v = { c: pick, t: Date.now() };
      v.r = BOT_REASONS[Math.floor(Math.random() * BOT_REASONS.length)];
      patch[pid] = v;
    });
    if (!Object.keys(patch).length) return;
    return S.sync.update('votes/' + c.sc.vkey, patch).catch(reportError);
  }
  function removeBots() {
    return Promise.all(playerIds().filter(function (id) { return S.players[id].bot; }).map(removePlayer));
  }

  /* 응답 내려받기 (엑셀에서 열리는 CSV) */
  function buildCsv() {
    const head = ['이름', '학과', '가상 참가자'];
    STAGE_KEYS.forEach(function (k) {
      const p = STAGE[k].c.short + ' S' + (STAGE[k].i + 1);
      head.push(p + ' 1차 선택', p + ' 1차 이유', p + ' 2차 선택', p + ' 2차 이유', p + ' 점수');
    });
    CONTENT.cases.forEach(function (c) { head.push(c.short + ' 개인 합계'); });
    const rows = [head];
    playerIds().sort(function (a, b) { return (S.players[a].t || 0) - (S.players[b].t || 0); }).forEach(function (pid) {
      const p = S.players[pid];
      const row = [p.name || '', p.dept || '', p.bot ? 'Y' : ''];
      const sums = {};
      STAGE_KEYS.forEach(function (k) {
        const st = STAGE[k].st;
        const v1 = (S.votes[k] || {})[pid], v2 = (S.votes[k + R2] || {})[pid];
        const c1 = validPick(v1, st.choices.length) ? st.choices[v1.c] : null;
        const c2 = validPick(v2, st.final.choices.length) ? st.final.choices[v2.c] : null;
        const sc = stageScore(k, v1, v2);
        row.push(c1 ? NUM[v1.c] + ' ' + c1.tag : '', c1 ? v1.r || '' : '',
          c2 ? NUM[v2.c] + ' ' + c2.tag : '', c2 ? v2.r || '' : '', sc == null ? '' : sc);
        if (sc != null) sums[STAGE[k].c.id] = (sums[STAGE[k].c.id] || 0) + sc;
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
  /* 이유가 충분한지. 꼭 적게 해 두었으면(config.js 의 reasonRequired) 공백을 뺀 글자 수가 reasonMin 이상이어야 함 */
  function reasonOk(reason) {
    if (!CONFIG.reasonRequired) return true;
    return String(reason || '').replace(/\s+/g, '').length >= (CONFIG.reasonMin || 1);
  }
  function submitVote(vkey, choice, reason) {
    const v = { c: choice, t: Date.now() };
    const r = String(reason || '').trim().slice(0, CONFIG.reasonMax);
    if (!reasonOk(r)) return Promise.reject(new Error('이유가 비어 있음'));
    if (r) v.r = r;
    return S.sync.set('votes/' + vkey + '/' + S.me.id, v);
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
  /* 화면에 보일 인물 정보. 현장지기는 사례·Stage마다 다른 사람(이름 = 그 Stage의 fieldAs 또는 사례의 fieldRole, 작은 글씨로 '현장지기') */
  function who(id, caseId, key) {
    const ch = CHAR[id];
    if (!ch) return null;
    if (id !== 'field' || !caseId) return { id: id, emoji: ch.emoji, name: ch.name, tag: null, image: ch.image };
    const cs = CASE[caseId], sg = key ? STAGE[key] : null;
    return { id: id, emoji: cs.fieldEmoji || ch.emoji, name: plain((sg && sg.st.fieldAs) || cs.fieldRole) || ch.name, tag: ch.name, image: cs.fieldImage || ch.image };
  }
  function whoName(w) { return [w.name, w.tag ? h('small', { class: 'who__tag' }, ' ' + w.tag) : null]; }
  function castBar(caseId, sums, delta) {
    return h('ul', { class: 'cast' }, CONTENT.characters.map(function (ch) {
      const w = who(ch.id, caseId);
      return h('li', { class: 'cast__char', 'data-char': ch.id },
        h('span', { class: 'cast__emoji' }, w.emoji),
        h('span', { class: 'cast__name' }, w.tag || w.name),
        w.tag ? h('span', { class: 'cast__role' }, w.name) : null,
        meter(sums[ch.id] || 0),
        delta ? h('span', { class: 'cast__delta ' + signClass(delta[ch.id]) }, '이번 Stage ' + fmtSigned(delta[ch.id])) : null,
        delta ? h('span', { class: 'cast__pop ' + signClass(delta[ch.id]), 'aria-hidden': 'true' },
          (delta[ch.id] > 0 ? '❤️ ' : delta[ch.id] < 0 ? '💔 ' : '💬 ') + fmtSigned(delta[ch.id])) : null);
    }));
  }
  /* 대화창. step 번째 줄까지 보여 줌. 지나간 줄은 is-past (디자인에서 숨겨도 됨) */
  /* 근거 표시: 화면 구석에 작게. 팀 문서 탭 번호와 원문 쪽수 */
  function sourceLine(src) { return plain(src) ? h('p', { class: 'source' }, '근거: ', T(src)) : null; }
  /* 자료 그림. bars = 막대, people = 사람 수 */
  function figureBox(fig) {
    const box = h('figure', { class: 'figure figure--' + fig.type });
    box.appendChild(h('figcaption', { class: 'figure__title' }, T(fig.title)));
    if (fig.type === 'bars') {
      const max = fig.max || Math.max.apply(null, fig.items.map(function (it) { return it.value; }));
      box.appendChild(h('ul', { class: 'figure__bars' }, fig.items.map(function (it) {
        return h('li', null, h('span', { class: 'figure__label' }, T(it.label)),
          h('span', { class: 'figure__track' }, h('span', { class: 'figure__fill', style: 'width:' + Math.max(0, Math.min(100, it.value / max * 100)).toFixed(1) + '%' })),
          h('span', { class: 'figure__value' }, it.value + (fig.unit || '')));
      })));
    } else if (fig.type === 'people') {
      const dots = [];
      for (let i = 0; i < fig.total; i++) dots.push(h('span', { class: 'figure__dot' + (i < fig.mark ? ' is-mark' : '') }));
      box.appendChild(h('div', { class: 'figure__people' }, dots));
      if (fig.legend) box.appendChild(h('p', { class: 'figure__legend' },
        h('span', { class: 'figure__dot' }), ' ', T(fig.legend[0]), ' · ', h('span', { class: 'figure__dot is-mark' }), ' ', T(fig.legend[1])));
    }
    if (plain(fig.source)) box.appendChild(sourceLine(fig.source));
    return box;
  }
  /* 인물 그림 자리. 지금은 이모지가 들어가 있고, 그림이 생기면 style.css 에서
     [data-char="haesol"][data-mood] 같은 고리로 배경 그림을 넣으면 됨 (mood = 대사에 붙은 표정 글) */
  function portrait(ch, cls, mood) {
    const img = plain(ch.image);                                 // content.js 의 인물에 image: 'img/파일.png' 를 적으면 이모지 대신 그 그림
    return h('span', { class: 'portrait ' + (cls || '') + (img ? ' has-image' : ''), 'data-char': ch.id, 'data-mood': mood || null, 'aria-hidden': 'true' },
      img ? h('img', { src: img, alt: '' }) : ch.emoji);
  }
  /* 대사가 나올 때 네 인물을 세워 두고, 지금 말하는 인물만 크게. 시스템 알림 줄에서는 아무도 커지지 않음 */
  function speakerRow(lines, step, caseId, key) {
    const ln = lines[Math.min(step, lines.length - 1)] || {};
    return h('ul', { class: 'speakers', 'data-speaker': CHAR[ln.who] ? ln.who : '' }, CONTENT.characters.map(function (ch) {
      const on = ln.who === ch.id, w = who(ch.id, caseId, key);
      return h('li', { class: 'speakers__char' + (on ? ' is-speaking' : ''), 'data-char': ch.id },
        portrait(w, 'speakers__portrait', on ? plain(ln.mood) || null : null),
        h('span', { class: 'speakers__name' }, whoName(w)),
        on && plain(ln.mood) ? h('span', { class: 'speakers__mood' }, T(ln.mood)) : null);
    }));
  }
  /* 미연시 화면: 위는 인물이 선 무대(사례별 배경 자리), 아래는 이름표가 붙은 대화창. 대화창에는 지금 대사만 보임 */
  function vnStage(lines, step, caseId, key) {
    const ln = lines[Math.min(step, lines.length - 1)] || {};
    const w = who(ln.who, caseId, key);
    return [
      h('div', { class: 'vn__stage', 'data-bg': caseId || '' }, speakerRow(lines, step, caseId, key)),
      h('div', { class: 'vn__box', 'data-char': w ? ln.who : 'system' },
        w ? h('p', { class: 'vn__name' }, w.emoji + ' ', whoName(w)) : null,
        dialogueBox(lines, step, caseId, key),
        h('span', { class: 'vn__next', 'aria-hidden': 'true' }, '▼')),
    ];
  }
  function dialogueBox(lines, step, caseId, key) {
    const box = h('div', { class: 'dialogue' });
    lines.forEach(function (ln, i) {
      if (i > step) return;
      const w = who(ln.who, caseId, key);
      box.appendChild(h('p', { class: 'dialogue__line ' + (i === step ? 'is-current' : 'is-past') + (w ? '' : ' dialogue__line--system'), 'data-char': ln.who },
        w ? h('span', { class: 'dialogue__who' }, w.emoji + ' ' + w.name, w.tag ? ' · ' + w.tag : '',
          plain(ln.mood) ? h('em', { class: 'dialogue__mood' }, ' (', T(ln.mood), ')') : null) : null,
        h('span', { class: 'dialogue__text' }, T(ln.text))));
    });
    return box;
  }
  function choiceList(list) {
    return h('ol', { class: 'choices', 'data-count': list.length }, list.map(function (ch, i) {
      return h('li', { class: 'choice' + (VIEW === 'host' ? ' is-clickable' : ''), 'data-choice': i,
          title: VIEW === 'host' ? '눌러서 크게 보기' : null, onclick: VIEW === 'host' ? function () { showInfo('c:' + i); } : null },
        h('span', { class: 'choice__num' }, NUM[i]),
        h('span', { class: 'choice__line' }, '“', T(ch.line), '”'),
        CONFIG.showPolicyOnVote ? h('span', { class: 'choice__policy' }, ch.tag, plain(ch.policy) ? [' · ', T(ch.policy)] : null) : null);
    }));
  }
  /* 선택지별 표 수 막대. counts[i] = i번 선택지의 표 수 */
  function tallyList(list, counts, voters, vkey) {
    const top = Math.max.apply(null, counts);
    return h('ol', { class: 'tally', 'data-count': list.length }, list.map(function (ch, i) {
      const n = counts[i] || 0;
      const pct = voters ? Math.round(n / voters * 100) : 0;
      return h('li', { class: 'tally__row' + (n > 0 && n === top ? ' is-top' : ''), 'data-choice': i },
        h('div', { class: 'tally__label' },
          h('span', { class: 'choice__num' }, NUM[i]),
          h('span', { class: 'choice__line' }, '“', T(ch.line), '”'),
          h('span', { class: 'choice__policy' }, ch.tag)),
        h('div', { class: 'tally__bar' }, h('span', { class: 'tally__fill', style: 'width:' + pct + '%' })),
        h('div', { class: 'tally__num' }, n + '명 (' + pct + '%)'));
    }));
  }
  /* 1차에서 고른 것 → 2차에서 고른 것 (두 번 다 투표한 사람 수) */
  /* 1차에서 i번, 2차에서 j번을 고른 사람들 (입장한 순서) */
  function moversOf(key, i, j) {
    const a = S.votes[key] || {}, b = S.votes[key + R2] || {}, st = STAGE[key].st;
    return Object.keys(b).filter(function (pid) {
      return S.players[pid] && validPick(b[pid], st.final.choices.length) && b[pid].c === j && validPick(a[pid], st.choices.length) && a[pid].c === i;
    }).sort(function (x, y) { return (S.players[x].t || 0) - (S.players[y].t || 0); })
      .map(function (pid) { return { pid: pid, name: S.players[pid].name, dept: S.players[pid].dept }; });
  }
  /* 발표자 화면에서만: 표의 칸을 누르면 그 칸에 든 사람 이름이 표 아래에 나옴 (직접 이유를 물어볼 때 씀).
     이 발표자 화면에만 보이고 발표 화면과 휴대폰에는 가지 않음. 장면이 바뀌면 닫힘 */
  function toggleCell(key, i, j) {
    const id = key + ':' + i + ':' + j;
    S.ui.cell = S.ui.cell === id ? null : id;
    lastSig = null; requestRender();
  }
  function shiftNames(key, st) {
    if (VIEW !== 'host' || !S.ui.cell || S.ui.cell.indexOf(key + ':') !== 0) return null;
    const p = S.ui.cell.slice(key.length + 1).split(':'), i = Number(p[0]), j = Number(p[1]);
    if (!st.choices[i] || !st.final.choices[j]) return null;
    const list = moversOf(key, i, j);
    return h('div', { class: 'shift-names', 'data-from': i, 'data-to': j },
      h('p', { class: 'shift-names__title' }, '1차 ' + NUM[i] + ' ' + st.choices[i].tag + ' → 2차 ' + NUM[j] + ' ' + st.final.choices[j].tag + ' · ' + list.length + '명 ',
        h('small', null, '(이 발표자 화면에만 보입니다) '),
        h('button', { type: 'button', class: 'link shift-names__close', onclick: function () { S.ui.cell = null; lastSig = null; requestRender(); } }, '닫기')),
      list.length ? h('ul', { class: 'players' }, list.map(function (m) {
        return h('li', { class: 'players__item', 'data-pid': m.pid }, h('span', { class: 'players__name' }, m.name), ' ', h('small', { class: 'players__dept' }, m.dept));
      })) : h('p', { class: 'empty' }, '이 칸에는 아무도 없습니다.'));
  }
  function shiftTable(st, sum, key) {
    const cellId = function (i, j) { return key + ':' + i + ':' + j; };
    return h('table', { class: 'shift' },
      h('caption', null, '1차 선택 → 2차 선택', VIEW === 'host' && key ? h('small', null, ' · 칸을 누르면 이름 확인') : null),
      h('thead', null, h('tr', null, h('th', null, '1차'),
        st.final.choices.map(function (ch, j) { return h('th', null, '2차 ' + NUM[j] + ' ' + ch.tag); }))),
      h('tbody', null, st.choices.map(function (ch, i) {
        return h('tr', { 'data-choice': i }, h('th', null, NUM[i] + ' ' + ch.tag),
          sum.move[i].map(function (n, j) {
            return h('td', { 'data-to': j, class: VIEW === 'host' && key && S.ui.cell === cellId(i, j) ? 'is-on' : null },
              VIEW === 'host' && key ? h('button', { type: 'button', class: 'link shift__who', title: '이름 확인', onclick: function () { toggleCell(key, i, j); } }, n + '명') : n + '명');
          }));
      })));
  }
  /* 학생들이 적은 한 줄 이유. vkey = 투표가 저장된 칸(1차는 스테이지 키, 2차는 뒤에 _r2). 발표자가 숨긴 것은 빠짐 */
  function reasonItems(vkey) {
    const v = S.votes[vkey] || {};
    const hid = S.hide[vkey] || {};
    return Object.keys(v).filter(function (pid) { return S.players[pid] && v[pid] && v[pid].r && !hid[pid]; })
      .map(function (pid) { return { pid: pid, name: S.players[pid].name, dept: S.players[pid].dept, c: v[pid].c, r: v[pid].r, t: v[pid].t || 0 }; });
  }
  function reasonPages(vkey) { return Math.max(1, Math.ceil(reasonItems(vkey).length / (CONFIG.reasonsPerPage || 6))); }
  /* 이유 창. 미연시의 대화창처럼 이름과 한 줄 이유를 보여 줌
     opt.live  = 투표 중: 방금 들어온 것부터 한 장만. 무엇을 골랐는지는 안 보임
     opt.list  = 결과: 선택지 목록. 선택지 순서(①②③)대로 한 장에 reasonsPerPage 개씩, opt.page 번째 장. 고른 선택지를 앞에 붙임 */
  function reasonWindow(vkey, opt) {
    const per = CONFIG.reasonsPerPage || 6;
    let items = reasonItems(vkey);
    const total = items.length;
    let pages = 1, page = 0;
    if (opt.live) {
      items.sort(function (a, b) { return b.t - a.t; });
      items = items.slice(0, CONFIG.reasonsLive || 4);
    } else {
      items.sort(function (a, b) { return a.c - b.c || a.t - b.t; });
      pages = Math.max(1, Math.ceil(total / per));
      page = Math.min(Math.max(0, opt.page | 0), pages - 1);
      items = items.slice(page * per, page * per + per);
    }
    return h('div', { class: 'reason-window' + (CONFIG.reasonAnonymous ? ' reason-window--anon' : ''), 'data-live': opt.live ? '1' : null, 'data-page': page, 'data-pages': pages },
      h('p', { class: 'reason-window__title', title: VIEW === 'host' ? '누르면 한 화면에 모아 보기' : null,
        onclick: VIEW === 'host' ? function () { openWall(vkey); } : null },
        opt.live ? '방금 들어온 이유' : '투표한 이유', ' ',
        h('small', null, total + '개' + (pages > 1 ? ' · ' + (page + 1) + ' / ' + pages + '장' : '')),
        VIEW === 'host' && total ? h('button', { type: 'button', class: 'link reason-window__all', onclick: function (e) { e.stopPropagation(); openWall(vkey); } }, '모아 보기 ⤢') : null),
      total ? h('ul', { class: 'feed' }, items.map(function (it) {
        const ch = opt.list && opt.list[it.c];
        return h('li', { class: 'feed__item', 'data-pid': it.pid, 'data-choice': opt.live ? null : it.c,
          title: VIEW === 'host' ? '누르면 크게 보기' : null,
          onclick: VIEW === 'host' ? function () { zoomReason(vkey, it.pid); } : null },
          CONFIG.reasonAnonymous ? null : h('span', { class: 'feed__who' }, it.name, ' ', h('small', null, it.dept)),   // 익명이면 이름·학과를 화면에 넣지 않음
          ch ? h('span', { class: 'feed__pick' }, NUM[it.c] + ' ' + ch.tag) : null,
          h('span', { class: 'feed__text' }, it.r),
          VIEW === 'host' ? h('span', { class: 'feed__tools' },
            h('button', { type: 'button', class: 'link feed__zoom', onclick: function (e) { e.stopPropagation(); zoomReason(vkey, it.pid); } }, '확대'),
            h('button', { type: 'button', class: 'link feed__hide', onclick: function (e) { e.stopPropagation(); setHidden(vkey, it.pid, true); } }, '숨김')) : null);
      })) : h('p', { class: 'empty reason-window__empty' }, opt.live ? '아직 들어온 이유가 없습니다.' : '적힌 이유가 없습니다.'));
  }
  function routeBanner(cs, r, withIntro) {
    return h('div', { class: 'route-banner', 'data-route': r },
      h('p', { class: 'route-banner__badge' }, T(cs.routes[r].badge)),
      h('h2', { class: 'route-banner__name' }, CONTENT.routes[r].name + ' 〈' + CONTENT.routes[r].title + '〉'),
      h('p', { class: 'route-banner__outcome' }, '기존 시나리오: ' + cs.outcomes[r][0] + ' — ' + cs.outcomes[r][1]),
      withIntro ? h('p', { class: 'route-banner__intro' }, T(cs.routes[r].intro)) : null,
      h('p', { class: 'route-banner__relation' }, CONTENT.routes[r].relation));
  }
  /* 엔딩 목록: 세 루트의 개요를 모두 보여 줌 (자세한 엔딩 장면은 해금된 루트만 이어짐)
     opt.open = 해금된 루트(아직 공개 전이면 비움) / opt.actual = 실제 역사 루트(표시할 때만)
     opt.brief = 한 줄씩만(루트 이름 · 기존 시나리오 이름). 개요를 이미 본 뒤에 씀 */
  function routeList(cs, opt) {
    return h('ol', { class: 'routes' + (opt.brief ? ' routes--brief' : '') }, ['A', 'B', 'C'].map(function (r) {
      const isOpen = opt.open === r, isActual = opt.actual === r;
      return h('li', { class: 'routes__item' + (isOpen ? ' is-open' : '') + (opt.open && !isOpen ? ' is-locked' : '') + (isActual ? ' is-actual' : ''), 'data-route': r },
        opt.open ? h('span', { class: 'routes__mark' }, isOpen ? '🔓 해금' : '🔒 미해금') : null,
        h('strong', { class: 'routes__name' }, CONTENT.routes[r].name + ' 〈' + CONTENT.routes[r].title + '〉'),
        opt.brief
          ? h('span', { class: 'routes__short' }, ' · ' + cs.outcomes[r][0])
          : [h('span', { class: 'routes__outcome' }, cs.outcomes[r][0] + ' — ' + cs.outcomes[r][1]),
             h('span', { class: 'routes__relation' }, CONTENT.routes[r].relation)],
        isActual ? h('span', { class: 'routes__actual' }, cs.actual.near ? '실제 역사에 가까움' : '실제 역사') : null);
    }));
  }
  function timelineList(rows, cls) {
    return h('dl', { class: 'timeline' + (cls ? ' ' + cls : '') }, rows.map(function (r) {
      return h('div', { class: 'timeline__row' }, h('dt', null, r[0]), h('dd', null, T(r[1])));
    }));
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
        h('p', { class: 'lobby__press' }, '▶ PRESS START — 휴대폰으로 QR을 찍어 입장'),
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
    /* 등장인물: 한 명씩 크게 소개(0~3단계) → 네 명을 나란히 정리(마지막 단계) */
    cast: function (c) {
      const list = CONTENT.characters;
      const el = h('section', { class: 'scene scene--cast' }, h('h2', { class: 'scene__title' }, '등장인물'));
      const card = function (ch) {
        return h('li', { class: 'cast-intro__char', 'data-char': ch.id },
          h('span', { class: 'cast__emoji' }, ch.emoji),
          h('strong', { class: 'cast__name' }, ch.name), ' ', h('span', { class: 'cast__job' }, '(' + ch.job + ')'),
          h('p', { class: 'cast-intro__criterion' }, ch.criterion + ' · ' + ch.archetype),
          plain(ch.standard) ? h('p', { class: 'cast-intro__standard' }, '정당성 기준 ', T(ch.standard)) : null,
          h('p', { class: 'cast-intro__line' }, '“', T(ch.line), '”'));
      };
      if (c.step >= list.length) { el.appendChild(h('ul', { class: 'cast-intro' }, list.map(card))); return el; }
      const ch = list[c.step];
      el.appendChild(h('div', { class: 'cast-focus', 'data-char': ch.id },
        portrait(ch, 'cast-focus__portrait'),
        h('div', { class: 'cast-focus__body' },
          h('p', { class: 'cast-focus__no' }, (c.step + 1) + ' / ' + list.length),
          h('p', { class: 'cast-focus__name' }, h('strong', null, ch.name), ' ', h('span', { class: 'cast__job' }, ch.job)),
          h('p', { class: 'cast-focus__criterion' }, ch.criterion),
          plain(ch.standard) ? h('p', { class: 'cast-focus__standard' }, '정당성 기준 ', T(ch.standard)) : null,
          h('p', { class: 'cast-focus__archetype' }, ch.archetype),
          plain(ch.note) ? h('p', { class: 'cast-focus__note' }, T(ch.note)) : null,
          h('p', { class: 'cast-focus__line' }, '“', T(ch.line), '”'))));
      el.appendChild(h('ul', { class: 'cast-seen' }, list.map(function (x, i) {            // 지나간 인물은 아래에 작게, 아직 안 나온 인물은 ?
        return h('li', { class: 'cast-seen__char' + (i === c.step ? ' is-current' : i < c.step ? ' is-past' : ' is-next'), 'data-char': x.id },
          i <= c.step ? [h('span', { class: 'cast__emoji' }, x.emoji), h('span', { class: 'cast__name' }, x.name)] : '?');
      })));
      return el;
    },
    howto: function () {
      const hw = CONTENT.howto;
      return h('section', { class: 'scene scene--howto' },
        h('h2', { class: 'scene__title' }, '진행 방식'),
        h('p', null, T(hw.lead)),
        h('ol', { class: 'steps' }, hw.steps.map(function (s) { return h('li', null, h('strong', null, T(s[0])), ' — ', T(s[1])); })),
        h('h3', null, '점수'),
        h('ul', { class: 'bullets' }, hw.scoring.map(function (s) {
          return h('li', null, h('strong', null, s[0]), ' ' + s[1] + ' — ' + s[2], s[3] ? h('span', { class: 'score-how' }, T(s[3])) : null);
        })),
        h('h3', null, '루트'),
        h('p', { class: 'score-rule' }, T(hw.rule)));
    },
    /* 사례 소개 = 프롤로그. 투표 전에 결말이 보이지 않게 Stage 1 직전까지만 보여 줌
       (그 뒤의 연표와 결말이 담긴 문구는 루트 해금 장면의 '실제 역사'에서 나옴) */
    caseIntro: function (c) {
      const cs = CASE[c.sc.caseId];
      const first = cs.stages[0], fd = who('field', cs.id);
      return [h('section', { class: 'scene scene--case-intro' },
        h('header', { class: 'scene__head' },
          plain(cs.episode) ? h('p', { class: 'scene__case' }, T(cs.episode)) : null,
          h('h2', { class: 'scene__title' }, cs.title),
          plain(cs.teaser) ? h('p', { class: 'scene__sub' }, T(cs.teaser)) : null),
        h('p', { class: 'background' }, T(cs.background)),
        cs.figure ? figureBox(cs.figure) : null,
        h('h3', null, '지금까지의 이야기'),
        timelineList(cs.timeline || []),
        fd ? h('p', { class: 'intro__field' }, '이번 사례의 현장지기: ' + fd.emoji + ' ' + fd.name) : null,
        first ? h('p', { class: 'intro__next' }, '이야기는 Stage 1. ', T(first.title), ' (' + first.period + ')에서 시작합니다.') : null),
        h('div', { class: 'title-card', 'aria-hidden': 'true' },
          plain(cs.episode) ? h('p', { class: 'title-card__ep' }, T(cs.episode)) : null,
          h('p', { class: 'title-card__title' }, cs.title))];
    },
    /* 상황: 첫 단계는 상황 설명, 그다음부터는 미연시 화면(인물이 선 무대 + 아래 대화창) */
    situation: function (c) {
      const sg = STAGE[c.sc.key];
      if (c.step >= 1) {
        return h('section', { class: 'scene scene--situation scene--vn vn' },
          sceneHead(c),
          h('p', { class: 'vn__narration' }, T(sg.st.scene)),
          vnStage(sg.st.dialogue, c.step - 1, c.sc.caseId, c.sc.key));
      }
      return h('section', { class: 'scene scene--situation' },
        sceneHead(c),
        h('p', { class: 'scene__question' }, T(sg.st.question)),
        h('ul', { class: 'bullets' }, sg.st.situation.map(function (s) { return h('li', null, T(s)); })),
        sg.st.figure ? figureBox(sg.st.figure) : null,
        h('p', { class: 'scene__narration' }, T(sg.st.scene)),
        castBar(c.sc.caseId, classAffinity(c.sc.caseId, c.idx)));
    },
    /* 1차 투표(3선지)와 2차 투표(2선지)가 같은 틀을 씀. c.sc.round 로 구분 */
    vote: function (c) {
      const sg = STAGE[c.sc.key], second = c.sc.round === 2;
      const sum = stageSummary(c.sc.key);
      return h('section', { class: 'scene scene--vote', 'data-round': c.sc.round },
        sceneHead(c, second ? '2차 투표 · 추가 자료를 본 뒤의 최종 선택. 휴대폰에서 다시 고르고 이유를 적어 주세요' : '1차 투표 · 휴대폰에서 대사를 고르고 이유를 한 줄 적어 주세요'),
        h('p', { class: 'scene__question' }, T(second ? sg.st.final.question : sg.st.question)),
        choiceList(choicesOf(c.sc.key, c.sc.round)),
        h('div', { class: 'vote__status' },
          c.feed ? reasonWindow(c.sc.vkey, { live: true }) : null,
          h('div', { class: 'vote__side' },
            h('p', { class: 'vote__count' }, '투표 ', h('strong', null, String(second ? sum.voters2 : sum.voters1)), ' / ' + playerCount() + '명',
              c.open === c.sc.vkey ? '' : ' · 마감'),
            qrBox(joinUrl(), 'qr--small'))));
    },
    result1: function (c) {
      const sg = STAGE[c.sc.key];
      const sum = stageSummary(c.sc.key);
      return h('section', { class: 'scene scene--result scene--result1', 'data-round': 1 },
        sceneHead(c, '1차 투표 결과'),
        h('p', { class: 'scene__question' }, T(sg.st.question)),
        tallyList(sg.st.choices, sum.n1, sum.voters1, c.sc.vkey),
        reasonWindow(c.sc.vkey, { list: sg.st.choices, page: c.rp }),
        h('p', { class: 'result__note' }, '점수는 추가 자료를 보고 2차 투표까지 마친 뒤에 매겨집니다.'));
    },
    result2: function (c) {
      const sg = STAGE[c.sc.key];
      const sum = stageSummary(c.sc.key);
      return h('section', { class: 'scene scene--result scene--result2', 'data-round': 2 },
        sceneHead(c, c.step >= 1 ? '2차 투표 결과 · 왜 그렇게 골랐나요' : '2차 투표 결과'),
        h('p', { class: 'scene__question' }, T(sg.st.final.question)),
        tallyList(sg.st.final.choices, sum.n2, sum.voters2, c.sc.vkey),
        c.step >= 1 ? reasonWindow(c.sc.vkey, { list: sg.st.final.choices, page: c.rp }) : null,
        c.step >= 1 ? null : h('div', { class: 'result__detail' },
          shiftTable(sg.st, sum, c.sc.key),
          h('div', { class: 'result__points' },
            h('p', { class: 'result__breakdown' }, '2점(' + SCORE_WHY[2] + ') ' + sum.byScore[2] + '명 · 1점(' + SCORE_WHY[1] + ') ' + sum.byScore[1] + '명 · 0점(' + SCORE_WHY[0] + ') ' + sum.byScore[0] + '명'),
            h('p', { class: 'result__score' }, '이번 Stage 반 점수 ', h('strong', null, sum.total + '점'),
              ' / 만점 ' + sum.max + '점 (' + sum.voters + '명 × ' + MAX_SCORE + '점)'))),
        c.step >= 1 ? null : shiftNames(c.sc.key, sg.st),
        c.step >= 1 ? null : castBar(c.sc.caseId, classAffinity(c.sc.caseId, c.idx), sum.aff));
    },
    extra: function (c) {
      const ex = STAGE[c.sc.key].st.extra;
      return h('section', { class: 'scene scene--extra', 'data-kind': ex.kind },
        sceneHead(c),
        h('p', { class: 'pinned-q' }, h('span', { class: 'pinned-q__label' }, '이번 질문'), T(STAGE[c.sc.key].st.question)),
        ex.kind === 'hidden'
          ? h('p', { class: 'hidden-banner' }, '💌 HIDDEN EVENT UNLOCKED : ', T(ex.title))
          : h('h3', { class: 'extra__title' }, T(ex.title)),
        ex.lead ? h('p', { class: 'extra__lead' }, T(ex.lead)) : null,
        h('dl', { class: 'facts' }, ex.rows.map(function (r) { return [h('dt', null, T(r[0])), h('dd', null, T(r[1]))]; })),
        ex.note ? h('p', { class: 'extra__note' }, T(ex.note)) : null,
        sourceLine(ex.source));
    },
    actual: function (c) {
      const st = STAGE[c.sc.key].st, ac = st.actual;
      const sum = stageSummary(c.sc.key);
      const f1 = st.choices[ac.first], f2 = st.final.choices[ac.final];
      const line = function (list, counts) { return list.map(function (ch, i) { return NUM[i] + ' ' + ch.tag + ' ' + counts[i] + '명'; }).join(' / '); };
      return h('section', { class: 'scene scene--actual' },
        sceneHead(c),
        h('h3', null, '실제 선택'),
        h('ul', { class: 'bullets' }, ac.lines.map(function (l) { return h('li', null, T(l)); })),
        h('p', { class: 'actual__match' }, '가까운 선택: ',
          h('strong', null, (f1 ? '1차 ' + NUM[ac.first] + ' ' + f1.tag : '') + (f1 && f2 ? ' → ' : '') + (f2 ? '2차 ' + NUM[ac.final] + ' ' + f2.tag : '')),
          ac.note ? [' — ', T(ac.note)] : null),
        h('p', { class: 'actual__class' }, '우리 반: 1차 ' + line(st.choices, sum.n1) + ' → 2차 ' + line(st.final.choices, sum.n2)),
        sourceLine(ac.source));
    },
    /* 0단계: 점수 합산과 세 루트의 개요 → 1단계: 해금된 루트 → 2단계: 실제 역사(결말 문구와 나머지 연표) */
    unlock: function (c) {
      const cs = CASE[c.sc.caseId];
      const sum = caseSummary(cs.id);
      const ar = cs.actual.route;
      const el = h('section', { class: 'scene scene--unlock' },
        h('header', { class: 'scene__head' },
          h('p', { class: 'scene__case' }, cs.title),
          h('h2', { class: 'scene__title' }, c.step >= 1 && sum ? '루트 해금' : '점수 합산'),
          c.step === 1 && sum ? h('p', { class: 'scene__sub score-line' }, '합계 ' + sum.total + '점 / 만점 ' + sum.max + '점 = ' + sum.pct + '%') : null));
      if (!sum) { el.appendChild(h('p', { class: 'empty' }, '투표가 없어 루트를 정할 수 없습니다.')); return el; }
      const totalLine = h('li', { class: 'score-sum__total' }, '합계: ', h('strong', null, sum.total + '점'), ' / 만점 ' + sum.max + '점 = ', h('strong', null, sum.pct + '%'));
      if (c.step === 0) {
        el.appendChild(h('ul', { class: 'score-sum' },
          cs.stages.map(function (st, i) {
            const s = stageSummary(cs.id + '_' + st.id);
            return h('li', null, 'Stage ' + (i + 1) + ': ' + s.total + '점 / ' + s.max + '점 (' + s.voters + '명)');
          }),
          totalLine));
        el.appendChild(h('p', { class: 'score-rule' }, T(CONTENT.howto.rule)));
        el.appendChild(h('h3', null, '엔딩 목록 ', h('small', null, '이 중 하나가 열립니다')));
        el.appendChild(routeList(cs, {}));
        return el;
      }
      el.appendChild(h('h3', { class: 'routes-title' }, '엔딩 목록'));
      el.appendChild(routeList(cs, { open: sum.route, actual: c.step >= 2 ? ar : null, brief: true }));
      if (c.step === 1) {
        el.appendChild(h('p', { class: 'route-clear', 'data-route': sum.route }, 'ROUTE ' + sum.route + ' CLEAR'));
        el.appendChild(routeBanner(cs, sum.route, true));
        const sp = personalSpread(cs.id);
        if (CONFIG.showPersonalRoute && sp.n) el.appendChild(h('p', { class: 'spread' }, '각자 점수로 보면: 루트 A ' + sp.A + '명 · 루트 B ' + sp.B + '명 · 루트 C ' + sp.C + '명'));
      }
      if (c.step >= 2) {
        const after = cs.timelineAfter || [];
        el.appendChild(h('div', { class: 'actual-history' },
          h('h3', null, '실제 역사', plain(cs.tagline) ? [' — ', T(cs.tagline)] : null),
          h('p', null, h('strong', null, CONTENT.routes[ar].name + ' 〈' + CONTENT.routes[ar].title + '〉' + (cs.actual.near ? '에 근접' : '')),
            ' · ' + cs.outcomes[ar][0]),
          h('p', null, T(cs.actual.text)),
          after.length ? timelineList(after, 'timeline--after') : null,
          h('p', { class: 'actual-history__match' }, sum.route === ar ? '우리 반의 선택은 실제 역사와 같은 루트입니다.' : '우리 반의 선택은 실제 역사와 다른 루트입니다.')));
      }
      return el;
    },
    cutscene: function (c) {
      return endingScene(c, '엔딩 대화', function (cs, rt) {
        return [h('p', { class: 'vn__narration route-banner__intro' }, T(rt.intro)), vnStage(rt.cutscene, c.step, cs.id)];
      });
    },
    aftermath: function (c) {
      return endingScene(c, '4인 호감도 최종 결과', function (cs, rt) {
        return [
          h('ul', { class: 'aftermath' }, rt.affinity.map(function (a) {
            const w = who(a.who, cs.id);
            return h('li', { class: 'aftermath__row', 'data-char': a.who },
              h('strong', { class: 'aftermath__who' }, w.emoji + ' ', whoName(w)), ' ',
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
    /* 0단계: 사례별 우리 반 루트와 실제 역사 루트 → 1단계: 실제 역사를 세 기준(3대 프레임)으로 나란히 */
    compare: function (c) {
      const routeName = function (r) { return CONTENT.routes[r].name + ' 〈' + CONTENT.routes[r].title + '〉'; };
      const el = h('section', { class: 'scene scene--compare' },
        h('header', { class: 'scene__head' },
          h('h2', { class: 'scene__title' }, '두 사례 비교'),
          h('p', { class: 'scene__sub' }, c.step === 0 ? '우리 반이 연 엔딩과 실제 역사'
            : '실제 역사(' + CONTENT.cases.map(function (cs) { return cs.short + ' 루트 ' + cs.actual.route + (cs.actual.near ? '에 근접' : ''); }).join(' · ') + ')를 세 기준으로 나란히 놓으면')));
      if (c.step === 0) {
        el.appendChild(h('ul', { class: 'compare' }, CONTENT.cases.map(function (cs) {
          const sum = caseSummary(cs.id);
          const ar = cs.actual.route;
          return h('li', { class: 'compare__case', 'data-case': cs.id },
            h('h3', null, cs.title),
            h('p', null, '우리 반: ', sum
              ? h('strong', null, routeName(sum.route))
              : h('span', { class: 'empty' }, '투표 없음'),
              sum ? ' · ' + cs.outcomes[sum.route][0] + ' (' + sum.total + '점 / ' + sum.max + '점, ' + sum.pct + '%)' : ''),
            h('p', null, '실제 역사: ', h('strong', null, routeName(ar) + (cs.actual.near ? '에 근접' : '')), ' · ' + cs.outcomes[ar][0]));
        })));
        return el;
      }
      const cmp = CONTENT.compare || {};
      el.appendChild(h('div', { class: 'criteria' }, (cmp.rows || []).map(function (row, i) {
        return [
          h('h3', null, CONTENT.frameLabels[i] || '', cmp.questions && cmp.questions[i] ? h('small', null, ' ', T(cmp.questions[i])) : null),
          h('ul', { class: 'bullets' }, CONTENT.cases.map(function (cs) {
            return plain(row[cs.id]) ? h('li', { 'data-case': cs.id }, h('strong', null, cs.short), ' — ', T(row[cs.id])) : null;
          })),
        ];
      })));
      el.appendChild(h('h3', null, '실제 역사에서 네 사람의 호감도'));
      el.appendChild(h('ul', { class: 'bullets compare__affinity' }, CONTENT.cases.map(function (cs) {
        const rt = cs.routes[cs.actual.route];
        return h('li', { 'data-case': cs.id }, h('strong', null, cs.short), ' — ',
          rt.affinity.map(function (a, k) {
            const w = who(a.who, cs.id);
            return [k ? ' · ' : '', h('span', { 'data-char': a.who }, w.emoji + ' ' + (w.tag || w.name) + ' ', T(a.level))];
          }));
      })));
      return el;
    },
    conclusion: function (c) {
      const n = CONTENT.conclusion.paragraphs.length;
      if (c.step >= n) {
        return h('section', { class: 'scene scene--the-end' },
          h('p', { class: 'the-end__title' }, 'THE END'),
          h('p', { class: 'the-end__game' }, CONTENT.title, ' ', h('small', null, CONTENT.titleSub)),
          h('p', { class: 'the-end__credit' }, CONTENT.team));
      }
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
    const el = h('section', { class: 'scene scene--ending scene--' + c.sc.type + (c.sc.type === 'cutscene' ? ' scene--vn vn' : ''), 'data-route': r || '' });
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
    const main = h('main', { class: 'stage', 'data-scene': c.sc.id, 'data-type': c.sc.type, 'data-case': c.sc.caseId || '', 'data-step': c.step, 'data-round': c.sc.round || '' });
    // 전환 효과: 장면이나 단계가 막 바뀐 그리기에만 data-enter 를 붙임 (표가 들어와 다시 그릴 때는 효과가 되풀이되지 않게)
    const at = c.sc.id + ':' + c.step;
    if (at !== lastShown) {
      main.setAttribute('data-enter', lastShown && lastShown.split(':')[0] === c.sc.id ? 'step' : 'scene');
      lastShown = at;
    }
    append(main, SCREEN[c.sc.type](c));
    const wall = reasonWall(c);
    if (wall) main.appendChild(wall);
    const zoom = reasonZoom(c);
    if (zoom) main.appendChild(zoom);
    const info = infoCard(c);
    if (info) main.appendChild(info);
    return main;
  }
  let lastShown = '', lastZoom = '', lastWall = '', lastInfo = '';
  /* 용어 풀이 카드 / 선택지 크게 보기 카드 */
  function infoCard(c) {
    if (!c.info) { lastInfo = ''; return null; }
    let card = null;
    if (c.info.slice(0, 2) === 'g:') {
      const g = GLOSSARY[c.info.slice(2)];
      if (g) card = [
        h('p', { class: 'info__kind' }, '용어 풀이'),
        h('h3', { class: 'info__title' }, T(g.term || c.info.slice(2))),
        h('ul', { class: 'info__lines' }, (g.lines || []).map(function (l) { return h('li', null, T(l)); })),
        sourceLine(g.source)];
    } else if (c.info.slice(0, 2) === 'c:' && c.sc.type === 'vote') {
      const list = choicesOf(c.sc.key, c.sc.round), i = Number(c.info.slice(2)), ch = list[i];
      if (ch) card = [
        h('p', { class: 'info__kind' }, (c.sc.round === 2 ? '2차' : '1차') + ' 선택지 ' + NUM[i]),
        h('p', { class: 'info__line' }, '“', T(ch.line), '”'),
        h('p', { class: 'info__policy' }, h('strong', null, ch.tag), plain(ch.policy) ? [' · ', T(ch.policy)] : null)];
    }
    if (!card) { lastInfo = ''; return null; }
    const fresh = lastInfo !== c.info; lastInfo = c.info;
    return h('div', { class: 'info' + (fresh ? ' is-fresh' : ''), onclick: VIEW === 'host' ? function () { showInfo(null); } : null },
      h('div', { class: 'info__card', onclick: function (e) { e.stopPropagation(); } },
        card,
        VIEW === 'host' ? h('p', { class: 'info__tools' },
          h('button', { type: 'button', class: 'primary info__close', onclick: function () { showInfo(null); } }, '닫기 (Esc)')) : null));
  }
  /* 흩어 놓을 자리를 정하는 데 쓰는 값. 같은 사람의 이유는 늘 같은 자리 근처에 오도록 pid 로 정함 */
  function hashStr(s) { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return x >>> 0; }
  function seeded(seed) {
    return function () { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  /* 이유 모아 보기. 쪽지 크기는 글 길이에 따라 다르고, 자리는 그린 뒤 fitWall 이 겹치지 않게 흩어 놓음 */
  function reasonWall(c) {
    if (!c.wall || c.wall !== c.sc.vkey || !wallAllowed(c)) { lastWall = ''; return null; }
    const sg = STAGE[c.sc.key], live = c.sc.type === 'vote';
    const list = live ? null : choicesOf(c.sc.key, c.sc.round);
    const items = reasonItems(c.sc.vkey).sort(function (a, b) { return hashStr(a.pid) - hashStr(b.pid); });
    const n = items.length;
    const fresh = lastWall !== c.wall; lastWall = c.wall;
    const roundLabel = c.sc.round === 2 ? '2차' : '1차';
    return h('div', { class: 'reason-wall' + (fresh ? ' is-fresh' : '') + (CONFIG.reasonAnonymous ? ' reason-wall--anon' : ''), 'data-live': live ? '1' : null },
      h('div', { class: 'reason-wall__head' },
        h('p', { class: 'reason-wall__title' }, 'Stage ' + (sg.i + 1) + '. ', T(sg.st.title), ' · ' + roundLabel + ' 투표 이유 ', h('small', null, n + '개' + (live ? ' · 투표 중' : ''))),
        list ? h('ul', { class: 'reason-wall__legend' }, list.map(function (ch, i) {
          return h('li', { 'data-choice': i }, h('span', { class: 'reason-wall__swatch' }), NUM[i] + ' ' + ch.tag);
        })) : null,
        VIEW === 'host' ? h('button', { type: 'button', class: 'primary reason-wall__close', onclick: closeWall }, '닫기 (Esc)') : null),
      h('div', { class: 'reason-wall__board' },
        n ? items.map(function (it, k) {
          const rnd = seeded(hashStr(it.pid + '/look'));
          const rot = (rnd() - 0.5) * 9;
          const len = String(it.r).length, size = len <= 14 ? 1.25 : len <= 30 ? 1.08 : len >= 60 ? 0.9 : 1;
          const ch = list && list[it.c];
          return h('div', { class: 'wall-note', 'data-pid': it.pid, 'data-choice': ch ? it.c : null,
            style: 'font-size:' + size + 'em;--rot:' + rot.toFixed(1) + 'deg;--delay:' + Math.min(900, k * 35) + 'ms',
            title: VIEW === 'host' ? '누르면 크게 보기' : null,
            onclick: VIEW === 'host' ? function () { zoomReason(c.sc.vkey, it.pid); } : null },
            ch ? h('span', { class: 'wall-note__pick' }, NUM[it.c] + ' ' + ch.tag) : null,
            CONFIG.reasonAnonymous ? null : h('span', { class: 'wall-note__who' }, it.name),
            h('span', { class: 'wall-note__text' }, it.r));
        }) : h('p', { class: 'empty reason-wall__empty' }, '아직 들어온 이유가 없습니다.')));
  }
  /* 쪽지를 판 위에 흩어 놓음. 큰 쪽지부터 사람마다 정해진 무작위 자리 후보를 차례로 대 보고 겹치지 않는 첫 자리에 둠.
     다 못 놓으면 글자를 줄여 다시. 같은 사람은 같은 화면 크기에서 늘 같은 자리 */
  function fitWall() {
    const board = document.querySelector('.reason-wall__board');
    if (!board) return;
    const notes = Array.prototype.slice.call(board.querySelectorAll('.wall-note'));
    if (!notes.length) return;
    const W = board.clientWidth, H = board.clientHeight, MIN = 9;
    let fs = Math.max(MIN, Math.min(34, Math.sqrt(W * H / notes.length) * 0.085));
    for (let attempt = 0; attempt < 14; attempt++) {
      board.style.fontSize = fs + 'px';
      const GAP = fs < 14 ? 6 : 12;                                // 사람이 많아 글자가 작아지면 쪽지 사이도 좁힘
      const sized = notes.map(function (el) { return { el: el, w: el.offsetWidth, h: el.offsetHeight }; })
        .sort(function (a, b) { return b.w * b.h - a.w * a.h || (a.el.dataset.pid < b.el.dataset.pid ? -1 : 1); });
      const placed = []; let bad = 0;
      sized.forEach(function (s) {
        const rnd = seeded(hashStr(s.el.dataset.pid + '/' + attempt));
        let best = null, bestOv = Infinity;
        for (let t = 0; t < 120 && bestOv > 0; t++) {
          const x = rnd() * Math.max(0, W - s.w), y = rnd() * Math.max(0, H - s.h);
          let ov = 0;
          for (let i = 0; i < placed.length; i++) {
            const b = placed[i];
            const ox = Math.min(x + s.w + GAP, b.x + b.w) - Math.max(x, b.x - GAP);
            const oy = Math.min(y + s.h + GAP, b.y + b.h) - Math.max(y, b.y - GAP);
            if (ox > 0 && oy > 0) ov += ox * oy;
          }
          if (ov < bestOv) { bestOv = ov; best = { x: x, y: y }; }
        }
        if (bestOv > 0) bad++;
        placed.push({ x: best.x, y: best.y, w: s.w, h: s.h });
        s.el.style.left = (best.x + s.w / 2).toFixed(1) + 'px';
        s.el.style.top = (best.y + s.h / 2).toFixed(1) + 'px';
      });
      if (!bad || fs <= MIN) break;
      fs = Math.max(MIN, fs * 0.9);
    }
  }
  /* 확대한 이유. 발표자 화면에서는 닫기·이전·다음 버튼이 붙음 */
  function reasonZoom(c) {
    if (!c.zoom || c.zoom.k !== c.sc.vkey) { lastZoom = ''; return null; }
    const items = reasonOrder(c);
    const i = items.findIndex(function (it) { return it.pid === c.zoom.p; });
    if (i < 0) { lastZoom = ''; return null; }
    const it = items[i], live = c.sc.type === 'vote';
    const list = live ? null : choicesOf(c.sc.key, c.sc.round);
    const ch = list && list[it.c];
    const fresh = lastZoom !== c.zoom.k + ':' + c.zoom.p;          // 새로 띄운 것일 때만 효과
    lastZoom = c.zoom.k + ':' + c.zoom.p;
    return h('div', { class: 'reason-zoom' + (fresh ? ' is-fresh' : ''), 'data-pid': it.pid,
      onclick: VIEW === 'host' ? function () { zoomReason(c.sc.vkey, null); } : null },
      h('div', { class: 'reason-zoom__card', onclick: function (e) { e.stopPropagation(); } },
        h('p', { class: 'reason-zoom__meta' }, ch ? h('span', { class: 'feed__pick' }, NUM[it.c] + ' ' + ch.tag) : null,
          h('span', { class: 'reason-zoom__pos' }, (i + 1) + ' / ' + items.length)),
        h('p', { class: 'reason-zoom__text' }, it.r),
        // 발표자가 골라 크게 띄운 이유에는 쓴 사람 이름을 같이 보여 줌 (config.js 의 reasonZoomName)
        CONFIG.reasonZoomName || !CONFIG.reasonAnonymous ? h('p', { class: 'reason-zoom__who' }, '— ', h('strong', null, it.name), ' ', h('small', null, it.dept)) : null,
        VIEW === 'host' ? h('p', { class: 'reason-zoom__tools' },
          h('button', { type: 'button', class: 'reason-zoom__prev', onclick: function () { zoomStep(-1); } }, '◀ 이전 이유'),
          h('button', { type: 'button', class: 'reason-zoom__next', onclick: function () { zoomStep(1); } }, '다음 이유 ▶'),
          h('button', { type: 'button', class: 'primary reason-zoom__close', onclick: function () { zoomReason(c.sc.vkey, null); } }, '닫기 (Esc)')) : null));
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
  /* 내가 고른 것. round = 1(1차) 또는 2(2차). 투표하지 않았으면 null */
  function myChoice(key, round) {
    const list = choicesOf(key, round);
    const mine = S.myVotes[round === 2 ? key + R2 : key];
    if (!validPick(mine, list.length)) return null;
    return h('div', { class: 'my-choice', 'data-round': round },
      h('p', { class: 'my-choice__line' }, '내 ' + round + '차 선택: ', h('span', { class: 'choice__num' }, NUM[mine.c]), ' “', T(list[mine.c].line), '”'),
      mine.r ? h('p', { class: 'my-choice__reason' }, '이유: ' + mine.r) : null);
  }
  /* 2차 투표 화면 위에 작게 보여 주는 1차 선택 */
  function myFirst(key) {
    const st = STAGE[key].st, mine = S.myVotes[key];
    if (!validPick(mine, st.choices.length)) return h('div', { class: 'my-first' }, h('p', { class: 'my-first__label' }, '처음 고른 대사'), h('p', null, '1차 투표는 하지 않았습니다.'));
    return h('div', { class: 'my-first' },
      h('p', { class: 'my-first__label' }, '처음 고른 대사'),
      h('p', null, h('span', { class: 'choice__num' }, NUM[mine.c]), ' “', T(st.choices[mine.c].line), '”'),
      mine.r ? h('p', { class: 'my-first__reason' }, '내 이유: ', mine.r) : null);
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
    if (!mc.complete) return h('p', { class: 'my-route' }, '내 선택만 보면: 두 Stage 모두 2차 투표까지 해야 나옵니다.');
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
    /* 1차·2차 투표가 같은 틀을 씀. key = 스테이지, vk = 이번 투표가 저장되는 칸 */
    vote: function (c) {
      const key = c.sc.key, vk = c.sc.vkey, round = c.sc.round, second = round === 2, sg = STAGE[key];
      const list = choicesOf(key, round);
      const mine = validPick(S.myVotes[vk], list.length) ? S.myVotes[vk] : null;
      const wrap = h('section', { class: 'pscene pscene--vote', 'data-round': round }, pHead(c),
        h('p', { class: 'pscene__round' }, second ? '2차 투표 · 최종 선택' : '1차 투표'),
        h('p', { class: 'pscene__question' }, T(second ? sg.st.final.question : sg.st.question)));
      if (second) wrap.appendChild(myFirst(key));
      if (c.open !== vk) {
        wrap.appendChild(h('p', { class: 'notice' }, '투표가 마감되었습니다.'));
        append(wrap, myChoice(key, round));
        return wrap;
      }
      const d = S.draft[vk] || (S.draft[vk] = { c: mine ? mine.c : null, r: mine && mine.r ? mine.r : '', editing: !mine, touched: false });
      const sn = S.sends[vk] || (S.sends[vk] = { sending: false, slow: false, error: '' });   // 이 투표의 제출 상태
      if (mine && !d.editing && !sn.sending) {
        wrap.appendChild(h('p', { class: 'notice notice--ok' }, '제출했습니다.'));
        append(wrap, myChoice(key, round));
        wrap.appendChild(h('button', { type: 'button', class: 'secondary', onclick: function () { d.editing = true; d.touched = true; d.c = mine.c; d.r = mine.r || ''; requestRender(); } }, '선택 바꾸기'));
        return wrap;
      }
      const form = h('form', { class: 'ballot', novalidate: true });
      const send = function () {
        if (sn.sending) return;
        if (d.c == null) { sn.error = '대사를 하나 골라 주세요.'; requestRender(); return; }
        if (!reasonOk(d.r)) {
          sn.error = '고른 이유를 한 줄 적어 주세요.' + ((CONFIG.reasonMin || 1) > 1 ? ' (' + CONFIG.reasonMin + '자 이상)' : '');
          S.ui.focusReason = true; requestRender(); return;
        }
        sn.sending = true; sn.slow = false; sn.error = ''; requestRender();
        const slowTimer = setTimeout(function () { if (sn.sending) { sn.slow = true; requestRender(); } }, 8000);
        submitVote(vk, d.c, d.r).then(function () {
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
      form.appendChild(h('p', { class: 'ballot__prompt' }, second ? '추가 자료를 보고 생각이 달라졌나요? 최종 대사를 골라 주세요.' : '어떤 대사로 답할까요?'));
      list.forEach(function (ch, i) {
        const input = h('input', { type: 'radio', name: 'choice', value: String(i), id: 'choice-' + i, checked: d.c === i,
          onchange: function () {
            d.c = i; d.touched = true;
            Array.prototype.forEach.call(form.querySelectorAll('.ballot__choice'), function (el, j) { el.classList.toggle('is-selected', j === i); });
          } });
        form.appendChild(h('label', { class: 'ballot__choice' + (d.c === i ? ' is-selected' : ''), for: 'choice-' + i },
          input,
          h('span', { class: 'choice__num' }, NUM[i]),
          h('span', { class: 'choice__line' }, '“', T(ch.line), '”'),
          CONFIG.showPolicyOnVote ? h('span', { class: 'choice__policy' }, ch.tag, plain(ch.policy) ? [' · ', T(ch.policy)] : null) : null));
      });
      const reason = h('input', { type: 'text', id: 'reason', class: 'ballot__reason', maxlength: String(CONFIG.reasonMax), value: d.r, autocomplete: 'off',
        oninput: function () { d.r = reason.value; d.touched = true; } });
      form.appendChild(h('label', { for: 'reason', class: 'ballot__reason-label' },
        CONFIG.reasonRequired ? '고른 이유 한 줄 (꼭 적어 주세요)' : '이유 한 줄 (안 적어도 됩니다)'));
      form.appendChild(reason);
      form.appendChild(h('p', { class: 'ballot__reason-note' }, CONFIG.reasonAnonymous ? '적은 이유는 발표 화면에 이름 없이 나옵니다.' + (CONFIG.reasonZoomName ? ' 발표자가 골라 크게 띄울 때는 이름이 함께 나옵니다.' : '') : '적은 이유는 발표 화면에 이름과 함께 나옵니다.'));
      if (S.ui.focusReason) { S.ui.focusReason = false; setTimeout(function () { try { reason.focus(); } catch (e) {} }, 0); }
      if (sn.error) form.appendChild(h('p', { class: 'notice notice--error' }, sn.error));
      if (sn.slow) form.appendChild(h('p', { class: 'notice' }, '연결이 느립니다. 투표가 열려 있는 동안 다시 연결되면 제출됩니다.'));
      form.appendChild(h('button', { type: 'button', class: 'primary ballot__send', disabled: sn.sending, onclick: send }, sn.sending ? '보내는 중…' : (mine ? '다시 제출' : '제출')));
      wrap.appendChild(form);
      return wrap;
    },
    /* 1차 결과·추가 자료 장면: 내 1차 선택과 반의 1차 결과 */
    afterVote1: function (c) {
      const key = c.sc.key, sg = STAGE[key], res = S.results[key];
      const wrap = h('section', { class: 'pscene pscene--result', 'data-round': 1 }, pHead(c));
      const pick = myChoice(key, 1);
      wrap.appendChild(pick || h('p', { class: 'notice' }, '1차 투표를 하지 않았습니다.'));
      if (res && res.voters1 != null) {
        wrap.appendChild(h('p', { class: 'class-result' }, '우리 반 1차: ' +
          sg.st.choices.map(function (ch, i) { return NUM[i] + ' ' + (res['n' + i] || 0) + '명'; }).join(' · ')));
      }
      wrap.appendChild(h('p', { class: 'pscene__hint' }, c.sc.type === 'extra' ? '추가 자료가 공개됩니다. 곧 2차 투표가 열립니다. ' + WATCH : WATCH));
      return wrap;
    },
    /* 2차 결과·실제 선택 장면: 내 1차→2차 선택, 이번 Stage 내 점수, 반 결과 */
    afterVote2: function (c) {
      const key = c.sc.key, sg = STAGE[key], res = S.results[key];
      const sc = stageScore(key, S.myVotes[key], S.myVotes[key + R2]);
      const wrap = h('section', { class: 'pscene pscene--result', 'data-round': 2 }, pHead(c));
      wrap.appendChild(myFirst(key));
      if (sc == null) {
        wrap.appendChild(h('p', { class: 'notice' }, '2차 투표를 하지 않아 이번 Stage 점수가 없습니다.'));
      } else {
        append(wrap, myChoice(key, 2));
        wrap.appendChild(h('p', { class: 'my-score' }, '이번 Stage 내 점수: ', h('strong', null, sc + '점'), ' (' + SCORE_WHY[sc] + ')'));
        wrap.appendChild(affinityList(affinityOf(key, sc), '내 선택에 대한 반응'));
      }
      if (res && res.voters != null) {
        wrap.appendChild(h('p', { class: 'class-result' }, '우리 반 2차: ' +
          sg.st.final.choices.map(function (ch, i) { return NUM[i] + ' ' + (res['m' + i] || 0) + '명'; }).join(' · ') +
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
              const v1 = S.myVotes[key], v2 = S.myVotes[key + R2];
              const c1 = validPick(v1, st.choices.length) ? st.choices[v1.c] : null;
              const c2 = validPick(v2, st.final.choices.length) ? st.final.choices[v2.c] : null;
              const sc = stageScore(key, v1, v2);
              return h('p', { class: 'summary__stage' }, 'Stage ' + (i + 1) + ': ', !c1 && !c2 ? '투표 안 함'
                : '1차 ' + (c1 ? NUM[v1.c] + ' ' + c1.tag : '안 함') + ' → 2차 ' + (c2 ? NUM[v2.c] + ' ' + c2.tag : '안 함') + (sc == null ? '' : ' (' + sc + '점)'));
            }),
            classRouteLine(cs),
            myRouteLine(cs));
        }),
        h('p', { class: 'pscene__hint' }, WATCH));
    },
  };
  PLAY.result1 = PLAY.afterVote1; PLAY.extra = PLAY.afterVote1;
  PLAY.result2 = PLAY.afterVote2; PLAY.actual = PLAY.afterVote2;
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
      h('p', { class: 'join__note' }, '이름은 입장 확인용입니다. 투표 이유는 발표 화면에 이름 없이 나오고, 발표자가 골라 크게 띄울 때만 이름이 함께 나옵니다.'),
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
  /* Stage 안에서는 상단 표시줄에 7단계(상황 → … → 실제 선택)를 줄로 보여 주고 지금 단계를 칠함 */
  function stageFlow(c) {
    if (!c.sc.key) return null;
    const sg = STAGE[c.sc.key], cs = CASE[c.sc.caseId];
    const ids = ['situation', 'vote1', 'result1', 'extra', 'vote2', 'result2', 'actual'];
    const now = ids.indexOf(c.sc.id.slice(c.sc.key.length + 1));
    return h('span', { class: 'flow' },
      h('span', { class: 'flow__where' }, cs.short + ' · Stage ' + (sg.i + 1)),
      h('ol', { class: 'flow__list' }, ids.map(function (id, i) {
        const label = SCENE_BY_ID[c.sc.key + '-' + id].label.split(' · ').pop();
        return h('li', { class: 'flow__item' + (i === now ? ' is-now' : i < now ? ' is-done' : '') }, h('span', { class: 'flow__label' }, label, i === now && c.steps > 1 ? h('small', { class: 'flow__step' }, ' (' + (c.step + 1) + '/' + c.steps + ')') : null));
      })));
  }
  function updateChrome() {
    if (!chrome) return;
    const c = cur();
    const flow = VIEW === 'play' ? null : stageFlow(c);
    if (flow) chrome.scene.replaceChildren(flow, h('span', { class: 'topbar__session' }, ' · 세션 ' + SESSION));
    else chrome.scene.textContent = VIEW === 'play' ? '' : c.sc.label + (c.steps > 1 ? ' (' + (c.step + 1) + '/' + c.steps + ')' : '') +
      (VIEW !== 'play' ? ' · 세션 ' + SESSION : '');                  // 발표자 화면과 발표 화면의 세션이 같은지 눈으로 맞춰 볼 수 있게
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
    ctl.unhideBtn = h('button', { type: 'button', hidden: true, onclick: function () { const c = cur(); if (c.sc.vkey) unhideAll(c.sc.vkey); } });
    ctl.clearBtn = h('button', { type: 'button', onclick: function () { const c = cur(); if (c.sc.vkey) clearVotes(c.sc.vkey); } }, '투표 지우기');
    ctl.pageBtn = h('button', { type: 'button', hidden: true, onclick: nextReasonPage });
    ctl.wallBtn = h('button', { type: 'button', hidden: true, onclick: function () { const c = cur(); if (c.wall) closeWall(); else if (wallAllowed(c)) openWall(c.sc.vkey); } });
    append(ctl.voteBox, [ctl.feedBtn, ctl.wallBtn, ctl.pageBtn, ctl.unhideBtn, ctl.clearBtn]);

    ctl.resetBtn = h('button', { type: 'button', onclick: function () { S.ui.resetArmed = true; requestRender(); } }, '전체 초기화');
    ctl.resetYes = h('button', { type: 'button', class: 'danger', hidden: true, onclick: function () { S.ui.resetArmed = false; resetAll(); requestRender(); } }, '정말 지움 (참가자·투표 전부)');
    ctl.resetNo = h('button', { type: 'button', hidden: true, onclick: function () { S.ui.resetArmed = false; requestRender(); } }, '취소');

    ctl.note = h('p', { class: 'controls__note', hidden: true });     // 발표자 메모(발표 화면에는 안 나옴)
    return h('div', { class: 'controls' },
      ctl.note,
      h('div', { class: 'controls__main' }, ctl.prev, ctl.next, ctl.pos, ctl.jump, ctl.routeBox, ctl.voteBox),
      h('details', { class: 'controls__more' },
        h('summary', null, '테스트 도구'),
        h('button', { type: 'button', onclick: function () { addBots(5); } }, '가상 참가자 5명 추가'),
        h('button', { type: 'button', onclick: botVote }, '가상 투표 넣기 (투표 장면에서)'),
        h('button', { type: 'button', onclick: removeBots }, '가상 참가자 지우기')),
      h('details', { class: 'controls__more' },
        h('summary', null, '관리'),
        h('button', { type: 'button', onclick: function () { const u = newSessionUrl(); if (u) location.href = u; } }, '새 세션으로 시작'),
        h('button', { type: 'button', title: '지금 세션의 발표 화면을 새 창으로 엽니다. 프로젝터 쪽으로 옮겨 전체 화면(F11)으로 쓰세요.',
          onclick: function () { window.open(viewUrl('screen'), 'dgd-screen'); } }, '발표 화면 열기 (새 창)'),
        h('button', { type: 'button', onclick: downloadCsv }, '응답 내려받기 (CSV)'),
        h('button', { type: 'button', onclick: function () {
          const el = document.documentElement;
          if (document.fullscreenElement) document.exitFullscreen(); else if (el.requestFullscreen) el.requestFullscreen().catch(function () {});
        } }, '전체 화면'),
        ctl.resetBtn, ctl.resetYes, ctl.resetNo));
  }
  /* 발표자 메모: 지금 장면에 맞는 메모(Stage → 사례 → 공통 순으로 찾음) */
  function hostNote(c) {
    const t = c.sc.type, sg = c.sc.key ? STAGE[c.sc.key] : null, cs = c.sc.caseId ? CASE[c.sc.caseId] : null;
    const sn = (sg && sg.st.notes) || {};
    let n = null;
    if (sg) {
      if (t === 'situation') n = c.step >= 1 ? (sn.dialogue || sn.situation) : sn.situation;
      else if (t === 'vote') n = c.sc.round === 2 ? sn.vote2 : sn.vote1;
      else n = sn[t];
    } else if (cs && t === 'caseIntro') n = cs.notes && cs.notes.intro;
    else if (cs && t === 'unlock') n = cs.notes && cs.notes.unlock;
    if (!plain(n) && CONTENT.notes) n = CONTENT.notes[t];
    return plain(n) ? n : null;
  }
  function updateControls() {
    if (!ctl) return;
    const c = cur();
    const note = hostNote(c);
    ctl.note.hidden = !note;
    ctl.note.replaceChildren(h('strong', null, '메모 '), note ? T(note) : '');
    ctl.prev.disabled = c.idx === 0 && c.step === 0;
    ctl.next.disabled = c.idx === SCENES.length - 1 && c.step === c.steps - 1;
    ctl.pos.textContent = '장면 ' + (c.idx + 1) + ' / ' + SCENES.length;
    if (document.activeElement !== ctl.jump) ctl.jump.value = String(c.idx);

    const ending = !!ENDING_TYPES[c.sc.type];
    ctl.routeBox.hidden = !ending;
    Object.keys(ctl.routeBtns).forEach(function (r) { ctl.routeBtns[r].classList.toggle('is-on', (c.peek || '') === r); });

    const staged = !!c.sc.vkey;                                 // 투표 장면과 그 결과 장면
    ctl.voteBox.hidden = !staged;
    if (staged) {
      const hiddenCount = Object.keys(S.hide[c.sc.vkey] || {}).length;
      ctl.feedBtn.textContent = '투표 중 이유 표시: ' + (c.feed ? '켬' : '끔');
      ctl.feedBtn.hidden = c.sc.type !== 'vote';
      const pages = reasonWindowShown(c) ? reasonPages(c.sc.vkey) : 1;      // 이유 창이 보이고 한 장을 넘으면 넘기는 버튼
      ctl.pageBtn.hidden = pages < 2;
      ctl.wallBtn.hidden = !wallAllowed(c);
      ctl.wallBtn.textContent = c.wall ? '모아 보기 닫기' : '이유 모아 보기';
      ctl.pageBtn.textContent = '이유 다음 장 (' + (Math.min(c.rp, pages - 1) + 1) + ' / ' + pages + ')';
      ctl.unhideBtn.hidden = !hiddenCount;
      ctl.unhideBtn.textContent = '숨긴 이유 ' + hiddenCount + '개 다시 보이기';
      ctl.clearBtn.textContent = '이 ' + c.sc.round + '차 투표 지우기';
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
    if (VIEW !== 'play') { fitWall(); runTyping(); }
    const sceneNow = (S.state && S.state.scene) || '';
    if (sceneNow !== lastScene) { lastScene = sceneNow; S.ui.cell = null; try { window.scrollTo(0, 0); } catch (e) { /* 무시 */ } }   // 장면이 바뀌면 맨 위로
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
      VOTE_KEYS.forEach(function (k) {
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
    window.addEventListener('resize', fitWall);
    document.addEventListener('keydown', function (e) {
      if (VIEW !== 'host' || e.altKey || e.ctrlKey || e.metaKey) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (cur().info && e.key === 'Escape') { e.preventDefault(); showInfo(null); return; }   // 용어 풀이·선택지 크게 보기 닫기
      if (cur().zoom) {                                           // 이유를 확대해 둔 동안: Esc 닫기, ← → ↑ ↓ 로 앞뒤 이유
        if (e.key === 'Escape') { e.preventDefault(); zoomReason(cur().sc.vkey, null); return; }
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); zoomStep(1); return; }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); zoomStep(-1); return; }
      }
      if (cur().wall && e.key === 'Escape') { e.preventDefault(); closeWall(); return; }   // 모아 보기 닫기
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); go(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(-1); }
      else if (e.key === 'ArrowDown' && reasonWindowShown(cur())) { e.preventDefault(); nextReasonPage(); }   // 이유 창이 보일 때: 이유 다음 장
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
  window.DGD = { S: S, submitVote: submitVote, SCENES: SCENES, VOTE_KEYS: VOTE_KEYS, routeOf: routeOf, personalRoute: personalRoute, stageScore: stageScore, buildCsv: buildCsv, session: SESSION, demo: DEMO };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
