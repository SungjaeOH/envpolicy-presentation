/* ============================================================
   ① 설정
   ============================================================ */
const CONFIG = {
  /* Firebase 연결 (한 번만 하면 됨)
       1. console.firebase.google.com 에서 프로젝트 만들기
       2. Databases & Storage > Realtime Database > Create database
          (위치는 싱가포르 asia-southeast1 권장. 한국에서 가장 가깝고 나중에 바꿀 수 없음)
       3. Realtime Database 의 규칙(Rules) 탭에 firebase-rules.json 내용을 붙여 넣고 게시
       4. 프로젝트 개요에서 웹 앱(</>)을 등록하면 나오는 firebaseConfig 값을 아래에 붙여 넣기
          (통째로 바꿔 넣어도 됨. databaseURL 이 없으면 Realtime Database 화면 위쪽에 보이는
           https://....firebaseio.com 또는 https://....firebasedatabase.app 주소를 넣기)
       5. 페이지를 https 주소로 올리기(깃허브 페이지 등). 학생 휴대폰은 그 주소로 들어옴
     databaseURL 이 비어 있으면 "데모 모드"로 돌아갑니다.
     (데모 모드 = 서버 없이 같은 브라우저의 탭끼리만 연결. 흐름 확인용) */
  firebase: {
    apiKey: '',
    authDomain: '',
    databaseURL: 'https://dgd-game-7fa24-default-rtdb.asia-southeast1.firebasedatabase.app',
    projectId: '',
    appId: '',
  },
  firebaseSdk: 'https://www.gstatic.com/firebasejs/13.1.0',

  /* 세션 이름. 주소 뒤에 ?s=이름 을 붙이면 다른 세션이 됩니다. (예: 리허설은 ?s=test)
     실제 수업은 발표자 화면의 "관리 > 새 세션으로 시작"으로 여는 것을 권함:
     세션 이름을 모르는 사람은 그 세션의 응답(이름·학과·투표)을 읽을 수 없음 */
  session: 'main',

  /* 반 전체 점수로 루트를 정하는 경계 (팀 환산표 기준)
     비율 = 반 전체 점수 ÷ 만점(2차 투표를 한 사람 수 × 2점).  A 이하 → 루트 A,  C 이상 → 루트 C,  그 사이 → 루트 B
     한 사람의 Stage 점수: 2차에서 배제 0점 / 1차부터 직접 수용이고 2차도 수용 2점 / 그 밖에 2차 수용 1점 */
  routeCut: { A: 0.375, C: 0.625 },

  /* 개인 점수(0~4점)로 보는 루트 (컨셉 2 표: 0~1점 A / 2~3점 B / 4점 C).
     각자 휴대폰에 본인 루트가 나오고, 발표 화면에는 루트별 인원만 나옴. 안 쓰려면 false */
  showPersonalRoute: true,
  personalCut: { A: 1, B: 3 },

  showPolicyOnVote: true,  /* 투표할 때 대사 아래에 원래 선택지 문구(배제·검증·수용 등)를 같이 보여 줌. 대사만 보이려면 false */
  reasonMax: 100,          /* 한 줄 이유 최대 글자 수 (늘리려면 firebase-rules.json 의 100 도 같이 바꿔야 함) */
  reasonRequired: true,    /* 투표할 때 이유를 꼭 적게 함(1차·2차 모두). 안 적어도 되게 하려면 false */
  reasonMin: 2,            /* 이유의 최소 글자 수(공백 제외) */
  reasonAnonymous: true,   /* 발표 화면·발표자 화면의 이유 창에 이름과 학과를 안 보여 줌. 이름을 같이 보이려면 false
                              (응답 내려받기 CSV 에는 누가 쓴 이유인지 그대로 들어감) */
  reasonsPerPage: 6,       /* 결과 장면의 이유 창에 한 장에 보이는 개수. ↓ 키나 "이유 다음 장" 버튼으로 넘김 */
  reasonsLive: 4,          /* 투표 중 이유 창에 보이는 개수(방금 들어온 것부터) */
  showDraftMarks: true,    /* 임시 문구 옆에 "임시" 표시 (발표 전에는 false) */
  hostKey: '',             /* 값을 넣으면 발표자 화면 주소에 &key=값 이 있어야 열림 (간단한 가림막 수준) */
};
