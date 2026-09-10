// docs/_snapshots/*.html 생성기.
//
// 왜 생성기인가 (review 라운드 2, R2-M-1)
//   손으로 얼린 스냅샷은 낡아도 게이트가 모른다. 실제로 concept-sample.html의 키워드를
//   '낡은공유성'으로 바꾼 변형이 13204 checks로 통과했다. 그래서 스냅샷을 **소스에서
//   재생성 가능한 산출물**로 바꾼다. scripts/validate.mjs가 같은 함수로 다시 만들어
//   커밋된 파일과 바이트 단위로 대조하므로, 데이터·렌더러·CSS 중 무엇이 바뀌든
//   스냅샷을 다시 만들기 전에는 게이트가 실패한다.
//
// 왜 밑줄 디렉터리인가 (review 라운드 4, R4-B-1)
//   저장소 루트가 곧 GitHub Pages 배포 루트다. docs/snapshots/*.html은 로그인 검사 없이
//   개념 본문·표·회상 문제를 렌더하는 **공개 페이지**였고, 미로그인 학습 내용 비노출
//   계약을 정면으로 깼다. Jekyll(.nojekyll 없음)은 경로 조각이 '_'로 시작하면 출력하지
//   않으므로 docs/_snapshots로 옮긴다. 이 전제가 무너지는 순간(=.nojekyll이 생기는 순간)
//   validate.mjs의 publishedHtml()이 이 파일들을 검사 대상으로 끌어와 게이트가 실패한다.
//
// 사용법:  node scripts/snapshot.mjs   (파일을 덮어쓴다)

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  createAppSandbox, evaluateBrowserData, evaluateDiagramRenderer,
  NOTEBOOK_SOURCE, readSource, renderGichulScreen, renderWordMasterHome,
} from './render-sandbox.mjs';

const ROOT = process.cwd();

export const SNAPSHOT_DIR = 'docs/_snapshots';

// 화면(게시되는 진입 HTML) → 스냅샷 파일. 완료 조건 "4개 화면 전부"(plan.md §4)의
// 근거이고, validate.mjs가 게시 진입 HTML 목록과 이 표를 대조한다 (R4-M-1).
export const SNAPSHOT_BY_SCREEN = {
  'index.html': `${SNAPSHOT_DIR}/landing.html`,
  'WordMaster/index.html': `${SNAPSHOT_DIR}/wordmaster.html`,
  'smstudy/index.html': `${SNAPSHOT_DIR}/concept-sample.html`,
  'plstudy/index.html': `${SNAPSHOT_DIR}/politics-law.html`,
  'admin/index.html': `${SNAPSHOT_DIR}/admin.html`,
  'usage/index.html': `${SNAPSHOT_DIR}/usage.html`,
  'gichul/index.html': `${SNAPSHOT_DIR}/gichul.html`,
  'behavior-lab/index.html': `${SNAPSHOT_DIR}/behavior-lab.html`,
};

export const SNAPSHOT_FILES = {
  ...SNAPSHOT_BY_SCREEN,
  DIAGRAMS: `${SNAPSHOT_DIR}/diagrams.html`,
};

// 개념 화면 스냅샷이 담는 중단원. 바꾸면 파일도 함께 다시 만들어야 한다.
const CONCEPT_SAMPLE_ID = 'III-01';

// ---- 기출 화면 fixture ------------------------------------------------------
// 기출 목록도 저장소에 원본이 없다(로그인 뒤 R2에서 온다). 표본의 **모양**은 손으로
// 지어내지 않고 scripts/gichul/build-manifest.mjs가 실제로 쓰는 레코드 계약을 그대로
// 따른다: id = `<시행년>-<회차>-<과목>[-<선택과목>]-<종류>`, 같은 파일에서 갈라진
// 선택과목은 r2_key와 pages를 공유하고 sections.common도 같다.
//
// 표본은 계약의 갈래를 한 번씩 지난다: 신체제 국어(공통 + 화작·언매), 구체제 국어
// (선택과목 없음 → 발췌 불가 행), 신체제 수학 3갈래, 단일 체제 영어·탐구 2과목,
// 그리고 정답표(kind: 'answer').
const GICHUL_FIXTURE = {
  exams: [
    { id: '2020-csat-korean-question', subject: 'korean', year: 2020, grade_year: 2021, round: 'csat', track: null, kind: 'question', r2_key: '2020-csat-korean-question.pdf', pages: 12 },
    { id: '2020-csat-korean-answer', subject: 'korean', year: 2020, grade_year: 2021, round: 'csat', track: null, kind: 'answer', r2_key: '2020-csat-korean-answer.pdf', pages: 1 },
    { id: '2023-06-korean-hwajak-question', subject: 'korean', year: 2023, grade_year: 2024, round: '06', track: 'hwajak', kind: 'question', r2_key: '2023-06-korean-question.pdf', pages: 16, sections: { common: [1, 8], selection: [9, 12] } },
    { id: '2023-06-korean-eonmae-question', subject: 'korean', year: 2023, grade_year: 2024, round: '06', track: 'eonmae', kind: 'question', r2_key: '2023-06-korean-question.pdf', pages: 16, sections: { common: [1, 8], selection: [13, 16] } },
    { id: '2023-06-korean-hwajak-answer', subject: 'korean', year: 2023, grade_year: 2024, round: '06', track: 'hwajak', kind: 'answer', r2_key: '2023-06-korean-answer.pdf', pages: 2 },
    { id: '2023-06-korean-eonmae-answer', subject: 'korean', year: 2023, grade_year: 2024, round: '06', track: 'eonmae', kind: 'answer', r2_key: '2023-06-korean-answer.pdf', pages: 2 },
    { id: '2023-csat-korean-hwajak-question', subject: 'korean', year: 2023, grade_year: 2024, round: 'csat', track: 'hwajak', kind: 'question', r2_key: '2023-csat-korean-question.pdf', pages: 16, sections: { common: [1, 8], selection: [9, 12] } },
    { id: '2023-csat-korean-eonmae-question', subject: 'korean', year: 2023, grade_year: 2024, round: 'csat', track: 'eonmae', kind: 'question', r2_key: '2023-csat-korean-question.pdf', pages: 16, sections: { common: [1, 8], selection: [13, 16] } },
    { id: '2023-csat-math-hwaktong-question', subject: 'math', year: 2023, grade_year: 2024, round: 'csat', track: 'hwaktong', kind: 'question', r2_key: '2023-csat-math-question.pdf', pages: 20, sections: { common: [1, 12], selection: [13, 15] } },
    { id: '2023-csat-math-mijeok-question', subject: 'math', year: 2023, grade_year: 2024, round: 'csat', track: 'mijeok', kind: 'question', r2_key: '2023-csat-math-question.pdf', pages: 20, sections: { common: [1, 12], selection: [16, 18] } },
    { id: '2023-csat-math-giha-question', subject: 'math', year: 2023, grade_year: 2024, round: 'csat', track: 'giha', kind: 'question', r2_key: '2023-csat-math-question.pdf', pages: 20, sections: { common: [1, 12], selection: [19, 20] } },
    { id: '2023-csat-english-question', subject: 'english', year: 2023, grade_year: 2024, round: 'csat', track: null, kind: 'question', r2_key: '2023-csat-english-question.pdf', pages: 12 },
    { id: '2023-csat-soc_culture-question', subject: 'soc_culture', year: 2023, grade_year: 2024, round: 'csat', track: null, kind: 'question', r2_key: '2023-csat-soc_culture-question.pdf', pages: 12 },
    { id: '2023-csat-politics_law-question', subject: 'politics_law', year: 2023, grade_year: 2024, round: 'csat', track: null, kind: 'question', r2_key: '2023-csat-politics_law-question.pdf', pages: 12 },
  ],
};

// 발췌 모드 + 정답표 포함으로 얼린다. 선택과목 구간이 붙은 행과 그 구간이 없어
// 비활성으로 내려앉는 구체제 행을 함께 지난다.
const GICHUL_STATE = {
  subject: 'korean',
  mode: 'excerpt',
  includeAnswers: true,
  selected: ['2023-06-korean-hwajak-question', '2023-csat-korean-hwajak-question'],
};

// 화면마다 얹히는 CSS가 다르다. 여기를 한 벌로 두면 WordMaster 스냅샷이 smstudy의
// 스타일로 조판돼 실제와 다른 화면을 보여 준다(실측으로 확인: .wm-layout 규칙이 없어
// 320px에서 366px로 넘쳤다).
const SMSTUDY_CSS = ['assets/css/system.css', 'smstudy/assets/css/style.css'];
const WORDMASTER_CSS = ['assets/css/system.css', 'WordMaster/assets/css/style.css'];

const SNAPSHOT_CSS = `/* ---- 스냅샷 전용 (원본 CSS 아님) ---- */
body { background: var(--bg); color: var(--text); margin: 0; padding: 32px 24px 64px; }
.snap-wrap { max-width: 900px; margin: 0 auto; container-type: inline-size; }
.snap-note { border: 1px solid var(--line); border-radius: var(--radius-m, 12px); padding: 16px 18px; margin-bottom: 32px; color: var(--text-2); font-size: 14px; line-height: 1.7; }
.snap-note code { color: var(--text); }
.snap-item { padding: 28px 0; border-top: 1px solid var(--line); }
.snap-item:first-of-type { border-top: 0; }
.snap-head { font-size: 15px; font-weight: 600; color: var(--text-2); margin: 0 0 14px; letter-spacing: normal; }`;

// 문서 스냅샷(원본 HTML을 그대로 얼리는 쪽)은 페이지 자신의 레이아웃을 건드리면 안 되므로
// 주석 상자 하나만 얹는다.
const DOCUMENT_SNAPSHOT_CSS = `/* ---- 스냅샷 전용 (원본 CSS 아님) ---- */
.snap-note { position: relative; z-index: 300; margin: 0; padding: 14px 18px; border-bottom: 1px solid var(--line); background: var(--surface); color: var(--text-2); font-size: 14px; line-height: 1.7; }
.snap-note code { color: var(--text); }`;

// 생성물이므로 줄 끝 공백을 남기지 않는다 (git diff --check).
function normalize(html) {
  return `${html.split('\n').map((line) => line.replace(/[ \t]+$/u, '')).join('\n').replace(/\n+$/u, '')}\n`;
}

function inlineStyles(files) {
  return files
    .map((file) => `<style>/* ${file} (inlined) */\n${readSource(file).trimEnd()}\n</style>`)
    .join('\n');
}

function page(title, note, items, styles = SMSTUDY_CSS) {
  return normalize(`<!doctype html>
<html lang="ko" data-snapshot="1">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
${inlineStyles(styles)}
<style>
${SNAPSHOT_CSS}
</style>
</head>
<body>
<div class="snap-wrap">
<div class="snap-note">${note}</div>
${items.join('\n')}
</div>
</body>
</html>`);
}

const GENERATED_NOTE = '<br><strong>기준</strong> — 이 파일은 <code>node scripts/snapshot.mjs</code>가 만든 생성물이다. 손으로 고치지 않는다.'
  + ' <code>npm run validate</code>가 같은 생성기를 다시 돌려 이 파일과 대조하므로, 데이터·렌더러·CSS를 바꾸면 반드시 다시 만들어야 한다.'
  + ' 이 디렉터리는 밑줄로 시작하므로 GitHub Pages(Jekyll)가 게시하지 않는다 — 학습 내용이 들어 있어도 공개면에 오르지 않는다.';

function section(heading, body) {
  return `<section class="snap-item"><h2 class="snap-head">${heading}</h2>${body}</section>`;
}

// ---- 원본 HTML 문서를 그대로 얼리는 스냅샷 ---------------------------------
// 랜딩·admin은 마크업 자체가 화면이다. 렌더러를 통과시키는 대신 문서를 손대지 않고
// (1) 외부 CSS·스크립트 참조를 인라인 스타일로 바꾸고, (2) 스크립트가 하는 일 중 화면
// 상태에 해당하는 것만 정적으로 반영한다. 무엇을 반영했는지는 각 파일의 주석 상자에 적는다.
function documentSnapshot(file, { note, mutate = (html) => html }) {
  const source = readSource(file);
  // 외부 호스트의 스타일시트(Pretendard CDN)는 인라인할 수 없다 — 링크째 걷어내고
  // 시스템 폰트 폴백으로 둔다. 조판 검증 대상은 --font-sans의 첫 순위(시스템 서체)다.
  const hrefs = [...source.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/gu)]
    .map(([, href]) => href)
    .filter((href) => !/^https?:/iu.test(href))
    .map((href) => {
      const clean = href.replace(/[?#].*$/u, '');
      return clean.startsWith('/') ? clean.slice(1) : path.posix.join(path.posix.dirname(file), clean);
    });
  let html = source
    .replace(/\n?\s*<link\b[^>]*rel="stylesheet"[^>]*>/gu, '')
    .replace(/\n?\s*<script\b[^>]*>\s*<\/script>/gu, '');
  html = html.replace('</head>', `${inlineStyles(hrefs)}\n<style>\n${DOCUMENT_SNAPSHOT_CSS}\n</style>\n</head>`);
  html = html.replace('<html lang="ko">', '<html lang="ko" data-snapshot="1">');
  html = mutate(html);
  html = html.replace(/<body([^>]*)>/u, `<body$1>\n  <div class="snap-note">${note}</div>`);
  return normalize(html);
}

function uiIcon(id) {
  return `<svg class="ui-icon" aria-hidden="true"><use href="/assets/ui-icons.svg?v=20260904-icons-v2#${id}"></use></svg>`;
}

function drawerGroup(heading, links) {
  const rows = links.map(([href, label, icon]) => `<a class="list-row list-row-nav" href="${href}"><span class="list-row-lead">${uiIcon(icon)}</span><span class="list-row-body"><span class="list-row-title">${label}</span></span></a>`).join('');
  return `<h2 class="list-group-head">${heading}</h2><div class="list-group">${rows}</div>`;
}

export function buildSnapshots() {
  const notebooks = evaluateBrowserData(NOTEBOOK_SOURCE, 'SMSTUDY_NOTEBOOK').NOTEBOOKS;
  const renderer = evaluateDiagramRenderer();

  const diagramItems = [];
  let diagramCount = 0;
  for (const [id, notebook] of Object.entries(notebooks)) {
    for (const diagram of notebook.diagrams || []) {
      const markup = renderer.renderDiagram(diagram);
      diagramCount += 1;
      diagramItems.push(section(
        `${id} — ${diagram.title} (${diagram.kind})`,
        `<div class="sm-diagrams">${markup}</div>`,
      ));
    }
  }

  const sandbox = createAppSandbox();
  const conceptMarkup = sandbox.renderConcept(CONCEPT_SAMPLE_ID);
  const subunitTitle = evaluateBrowserData('_learning/smstudy/data.js', 'SMSTUDY_DATA')
    .UNITS.flatMap((unit) => unit.subs).find((sub) => sub.id === CONCEPT_SAMPLE_ID).title;

  return {
    [SNAPSHOT_FILES.DIAGRAMS]: page(
      `개념 다이어그램 스냅샷 — ${Object.keys(notebooks).length}단원 ${diagramCount}개`,
      '<strong>무엇인가</strong> — <code>smstudy/assets/js/diagram.js</code>가 실제로 낸 마크업을 그대로 얼린 정적 스냅샷이다.'
      + ` ${Object.keys(notebooks).length}개 중단원의 다이어그램 ${diagramCount}개를 <code>단원ID — title (kind)</code> 소제목과 함께 모두 담았다.`
      + ' CSS 두 개(<code>/assets/css/system.css</code>, <code>/smstudy/assets/css/style.css</code>)를 인라인했으므로 이 파일만 열면 된다.'
      + '\n  <br><strong>왜 있나</strong> — 이 환경에서 스크린샷을 찍을 수 없어(브라우저 pane 뷰포트 0px) DESIGN.md §6의 시각 확인을 대신한다.'
      + '\n  스크린샷의 완전한 대체는 아니지만, 조판·겹침·잘림을 사람이 눈으로 볼 수 있는 산출물이다.'
      + `\n  ${GENERATED_NOTE}`,
      diagramItems,
    ),
    [SNAPSHOT_BY_SCREEN['smstudy/index.html']]: page(
      `개념 화면 스냅샷 — ${CONCEPT_SAMPLE_ID} ${subunitTitle}`,
      `<strong>무엇인가</strong> — <code>smstudy/assets/js/app.js</code>의 <code>renderConcept('${CONCEPT_SAMPLE_ID}')</code>가 <code>#app</code>에 쓰는 마크업 전체다.`
      + '\n  히어로·구조도·기출 분석·비교표·문제 푸는 순서·개념 설명·회상 점검·학습 설계까지 화면 전체가 들어 있다.'
      + '\n  CSS 두 개(<code>/assets/css/system.css</code>, <code>/smstudy/assets/css/style.css</code>)를 인라인했으므로 이 파일만 열면 된다.'
      + '\n  <br><strong>주의</strong> — 정적 사본이라 버튼·아코디언은 동작하지 않는다(회상 점검의 <code>&lt;details&gt;</code>는 열린다).'
      + '\n  기출 이미지는 저장소 상대 경로를 참조하므로 저장소 안에서 열어야 보인다.'
      + `\n  ${GENERATED_NOTE}`,
      [section(
        `${CONCEPT_SAMPLE_ID} — ${subunitTitle} (개념 화면 #app 전체)`,
        `<div class="app-main">${conceptMarkup}</div>`,
      )],
    ),
    [SNAPSHOT_BY_SCREEN['WordMaster/index.html']]: page(
      'WordMaster 화면 스냅샷 — 시험 설정(첫 화면)',
      '<strong>무엇인가</strong> — <code>WordMaster/assets/js/app.js</code>가 로드 직후 <code>#app</code>에 쓰는 첫 화면(시험 설정) 마크업 전체다.'
      + '\n  출제 범위·학습 현황·오답 다루기 그룹과 행 안의 값 컨트롤(<code>.field-input-inline</code>)이 들어 있다.'
      + '\n  <br><strong>주의</strong> — 학습 기록이 비어 있는 새 브라우저 상태다(localStorage 없음). 정적 사본이라 버튼은 동작하지 않는다.'
      + `\n  ${GENERATED_NOTE}`,
      [section('WordMaster — 시험 설정 (#app 전체)', `<div class="app-main">${renderWordMasterHome()}</div>`)],
      WORDMASTER_CSS,
    ),
    [SNAPSHOT_BY_SCREEN['plstudy/index.html']]: documentSnapshot('plstudy/index.html', {
      note: '<strong>무엇인가</strong> — 정치와 법 학습 화면의 반응형 셸을 얼린 스냅샷이다.'
        + '\n  실제 6단원 · 18중단원 · 90문항은 로그인 뒤 보호 API에서 로드한다.'
        + `\n  ${GENERATED_NOTE}`,
    }),
    [SNAPSHOT_BY_SCREEN['index.html']]: documentSnapshot('index.html', {
      note: '<strong>무엇인가</strong> — 랜딩(<code>/index.html</code>) 문서를 그대로 얼린 스냅샷이다. 링크된 CSS를 인라인하고 스크립트를 걷어냈다.'
        + '\n  <br><strong>정적으로 반영한 상태</strong> — <code>home.js</code>가 사람 소유자 로그인 뒤 만드는 드로어의 학습·운영 그룹 리스트와 테두리형 아이콘을 주입했다.'
        + ' 즉 <strong>사람 소유자 계정으로 로그인한 화면</strong>이다.'
        + '\n  <br><strong>여기서 확인할 것</strong> — 본문에는 학습 콘텐츠가 노출되지 않고, 사람 소유자 전용 Behavior Lab 카드만 연락 섹션 앞에 나타나는지.'
        + ' 일반 학습·사용량 진입은 드로어에 있고, 드로어는 닫힌 상태(화면 밖)다.'
        + '\n  <br><strong>주의</strong> — 등장 애니메이션(<code>.reveal</code>)은 <code>html.js</code>가 없어 처음부터 보인 상태로 조판된다.'
        + `\n  ${GENERATED_NOTE}`,
      mutate: (html) => html
        .replace('<div id="studyLinks" class="drawer-group"></div>', `<div id="studyLinks" class="drawer-group">${drawerGroup('학습', [
          ['/WordMaster/', 'WordMaster', 'icon-book-open'],
          ['/smstudy/', '사회·문화', 'icon-layers'],
          ['/plstudy/', '정치와 법', 'icon-scale'],
          ['/gichul/', '기출', 'icon-file'],
        ])}</div>`)
        .replace('<div id="ownerLinks" class="drawer-group"></div>', `<div id="ownerLinks" class="drawer-group">${drawerGroup('운영', [
          ['/behavior-lab/#paper', 'Behavior Lab', 'icon-bolt'],
          ['/usage/', '공모전', 'icon-trophy'],
          ['/admin/', '관리자', 'icon-shield'],
        ])}</div>`)
        .replace('<body>', '<body class="logged">')
        .replace('<aside id="drawer" class="drawer"', '<aside id="drawer" class="drawer logged"')
        .replace('<div id="account" class="account hero-actions">', '<div id="account" class="account hero-actions logged">'),
    }),
    [SNAPSHOT_BY_SCREEN['admin/index.html']]: documentSnapshot('admin/index.html', {
      note: '<strong>무엇인가</strong> — 관리자(<code>/admin/index.html</code>) 문서를 그대로 얼린 스냅샷이다. 링크된 CSS를 인라인하고 스크립트를 걷어냈다.'
        + '\n  <br><strong>정적으로 반영한 상태</strong> — 인증 후 화면을 보기 위해 <code>#login</code>을 감추고 <code>#adminShell</code>의 <code>hidden</code>을 풀었으며,'
        + ' 사이드바의 <strong>개요</strong> 항목에 <code>aria-current</code>를 얹었다(활성 필). 즉 <strong>개요 뷰</strong> 하나만 보이는 상태다.'
        + ' 사이드바 최상단에는 흰 헤어라인 로고 엠블럼(<code>.sidebar-emblem</code>)이 있고, 그 아래 각 항목은 아이콘 없이 <strong>텍스트 전용 행</strong>이다(DESIGN.md §8/v5 — 이모지 슬롯 폐지).'
        + '\n  <br><strong>여기서 확인할 것</strong> — 뷰가 하나만 렌더된다(나머지 <code>.ad-view</code>는 <code>hidden</code>).'
        + ' 사이드바가 대문자 소제목으로 묶여 있고, 엠블럼이 로고와 같은 사각형 3개 기하를 그대로 쓰는지.'
        + '\n  <br><strong>주의</strong> — 요약 스트립과 표의 행은 Worker API가 채우므로 이 사본에서는 비어 있다. 검증 대상은 셸·사이드바·툴바·표 머리의 조판이다.'
        + `\n  ${GENERATED_NOTE}`,
      mutate: (html) => html
        .replace('<section id="login" class="ad-gate"', '<section id="login" class="ad-gate" hidden')
        .replace('<div id="adminShell" class="app-shell" hidden>', '<div id="adminShell" class="app-shell">')
        .replace(/(<button class="sidebar-item" type="button" data-view="overview"[^>]*?)>/u, '$1 aria-current="page">'),
    }),
    [SNAPSHOT_BY_SCREEN['usage/index.html']]: documentSnapshot('usage/index.html', {
      note: '<strong>무엇인가</strong> — 소유자 전용 공모전 화면의 반응형 셸이다.'
        + '\n  사용량과 harness 화면은 2026-09-04에 보관했고, 이 경로에는 공모전 후보와 승인 흐름만 남는다.'
        + '\n  <br><strong>주의</strong> — 후보와 승인 데이터는 로그인 뒤 <code>GET /api/competitions</code>에서 온다. 정적 사본이라 비어 있다.'
        + `\n  ${GENERATED_NOTE}` ,
    }),
    [SNAPSHOT_BY_SCREEN['gichul/index.html']]: documentSnapshot('gichul/index.html', {
      note: '<strong>무엇인가</strong> — 기출(<code>/gichul/index.html</code>) 문서를 얼린 스냅샷이다. 링크된 CSS를 인라인하고 스크립트를 걷어냈다.'
        + '\n  <br><strong>정적으로 반영한 상태</strong> — 필터와 결과는 <code>gichul/app.js</code>의 <code>renderFilters()</code>·<code>renderBody()</code>를'
        + ' <strong>실제로 실행</strong>해 얻은 마크업이다. 입력은 <code>scripts/snapshot.mjs</code>의 고정 표본(<code>GICHUL_FIXTURE</code>)이고,'
        + ' 과목은 국어 · 범위는 <strong>선택과목 발췌</strong> · 정답표 포함 · 두 항목 선택 상태다.'
        + '\n  <br><strong>여기서 확인할 것</strong> — 필터가 표본에서 도출한 값(학년도 · 시행 · 선택과목)만 내는지,'
        + ' 발췌 모드에서 선택과목 구간이 없는 2021학년도 수능 행이 <strong>비활성</strong>으로 내려앉고 체크박스가 잠기는지,'
        + ' 행마다 선택과목 전용 구간이 우측 값 한 조각으로 읽히는지, 툴바의 선택 개수와 버튼 상태가 선택과 맞는지,'
        + ' 그리고 그룹 리스트 · 세그먼티드 · 툴바가 전부 <code>system.css</code>의 프리미티브를 그대로 쓰는지.'
        + '\n  <br><strong>주의</strong> — 미로그인 접근은 <code>account.js</code>와 <code>app.js</code>가 랜딩으로 되돌린다. 이 사본은 로그인한 방문자가 보는 화면이다.'
        + ' 실제 시험 목록은 이 문서가 아니라 로그인 뒤 <code>GET /api/gichul/manifest</code>에서 온다 — 표본은 계약의 모양을 보여주기 위한 것이지 실제 수록 범위가 아니다.'
        + ' 정적 사본이라 체크박스 · 버튼 · 병합 내려받기는 동작하지 않는다.'
        + `\n  ${GENERATED_NOTE}`,
      mutate: (html) => {
        const { filters, body } = renderGichulScreen(GICHUL_FIXTURE, GICHUL_STATE);
        return html
          .replace('<aside id="gichulFilters" class="sidebar" aria-label="기출 필터"></aside>',
            `<aside id="gichulFilters" class="sidebar" aria-label="기출 필터">${filters}</aside>`)
          .replace('<div id="gichulBody" class="gi-body"></div>',
            `<div id="gichulBody" class="gi-body">${body}</div>`);
      },
    }),
    [SNAPSHOT_BY_SCREEN['behavior-lab/index.html']]: documentSnapshot('behavior-lab/index.html', {
      note: '<strong>무엇인가</strong> — 공용 Behavior Lab의 정적 화면 셸을 얼린 스냅샷이다. CSS는 인라인하고 실행 스크립트는 걷어냈다.'
        + '\n  <br><strong>정적으로 반영한 상태</strong> — Worker 응답 전의 fail-closed 초기 상태다. 심볼·주기 컨트롤, 가격·행동·신호, 백테스트, 위험 한도, 텍스트 초안 영역의 전체 조판을 담는다.'
        + '\n  <br><strong>주의</strong> — live dashboard와 버튼 상호작용은 API 응답이 필요하므로 이 사본에서는 비어 있다. 실제 desktop/mobile 상호작용은 별도 로컬 HTTP 브라우저 증거로 확인한다.'
        + `\n  ${GENERATED_NOTE}`,
      mutate: (html) => html,
    }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT, 'scripts/snapshot.mjs')) {
  for (const [file, html] of Object.entries(buildSnapshots())) {
    writeFileSync(path.join(ROOT, file), html, 'utf8');
    console.log(`wrote ${file} (${html.length} bytes)`);
  }
}
