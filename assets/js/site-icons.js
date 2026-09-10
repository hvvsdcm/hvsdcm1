// 사이트 공통 아이콘 매핑 — DESIGN.md §5.1의 단일 원본 (v14).
//
// 값은 assets/ui-icons.svg의 심볼 id다. 랜딩 드로어(home.js)가 이 매핑에서 아이콘을 고르고,
// 같은 대상은 사이트 어디서나 같은 아이콘이다. 이모지 값은 두지 않는다 — 화면에 이모지를
// 렌더하지 않는다(§5). 키는 앱 디렉터리 이름이다(WordMaster / smstudy / plstudy / gichul).
// 이 파일이 랜딩 드로어의 사이트 공통 아이콘 매핑 단일 원본이다.
window.SITE_ICONS = Object.freeze({
  WordMaster: 'icon-book-open',
  smstudy: 'icon-layers',
  plstudy: 'icon-scale',
  gichul: 'icon-file',
  behaviorLab: 'icon-bolt',
  usage: 'icon-trophy',
  admin: 'icon-shield',
});
