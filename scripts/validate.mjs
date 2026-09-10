import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync as readFileRaw, statSync } from 'node:fs';
import path from 'node:path';
import {
  APP_SOURCE, DIAGRAM_SOURCE,
  createAppSandbox, evaluateBrowserData, evaluateDiagramRenderer, functionBody, readSource, trackReads,
} from './render-sandbox.mjs';
import { findDesignHeadingSequenceErrors } from './design-heading-sequence.mjs';
import { DEFAULT_AVAILABILITY } from './gichul/availability.mjs';
import { buildSnapshots, SNAPSHOT_BY_SCREEN, SNAPSHOT_FILES } from './snapshot.mjs';
import {
  findIconBackgroundViolations, findInvalidIconMarkup, findMissingIconReferences, findRenderedEmoji,
  findUnversionedIconSpriteReferences, ICON_SPRITE_URL, inspectSprite, referencedIconIds,
} from './icon-gates.mjs';

const ROOT = process.cwd();
const DESIGN_HEADING_PATH = process.env.HVSDCM_VALIDATE_DESIGN_PATH
  ? path.resolve(process.env.HVSDCM_VALIDATE_DESIGN_PATH)
  : path.join(ROOT, 'docs/DESIGN.md');
const failures = [];
let checks = 0;

// ---- R3-M-1. 줄바꿈 정규화 ----
// 윈도우 기본값 `core.autocrlf=true`로 체크아웃하면 소스가 CRLF로 내려온다. 함수 경계
// 정규식과 스냅샷 바이트 대조는 LF를 전제하므로, 정상 커밋이 머신에 따라 거짓 실패했다.
// 텍스트로 읽는 순간 CRLF를 LF로 접어 판정이 체크아웃 설정에 좌우되지 않게 한다.
// 인코딩 인자가 없는 호출(Buffer)은 손대지 않는다 — 해시 잠금과 WebP 파싱은 원본 바이트를 봐야 한다.
function readFileSync(file, encoding) {
  if (!encoding) return readFileRaw(file);
  return readFileRaw(file, encoding).replace(/\r\n/gu, '\n');
}

function check(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
}

// 검사 대상은 이 체크아웃의 소스뿐이다. `.claude/`는 에이전트가 만든 중첩 워크트리가
// 사는 곳이라 저장소 전체의 사본이 그 안에 또 들어 있다 — 걸러내지 않으면 남의 브랜치
// 파일이 이 체크아웃의 위반으로 보고돼 게이트가 상시 빨간불이 된다(2026-08-30 실측).
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', '.wrangler', '.claude']);

function walk(directory, predicate) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute, predicate));
    else if (predicate(absolute)) files.push(absolute);
  }
  return files;
}

// ---- B-1. "실제로 게시되는 HTML"을 저장소 상태에서 도출한다 ----
// 저장소 루트가 곧 GitHub Pages의 배포 루트다. 그래서 "이 디렉터리는 배포면이 아니다"를
// 손으로 적을 수 없다 — 이전 walk()가 docs/snapshots를 그렇게 제외했고, 그 전제가 틀려서
// 로그인 없이 열리는 개념 본문이 공개됐다(B-1).
// 게시 여부는 Pages의 규칙이 정한다: .nojekyll이 없으면 Jekyll이 빌드하고, Jekyll은
// 경로의 어느 조각이든 '_'나 '.'로 시작하면 출력하지 않는다. .nojekyll이 생기는 순간
// 저장소의 모든 HTML이 그대로 게시되므로 밑줄 디렉터리도 검사 대상이 된다.
// 즉 배포 설정이 바뀌면 이 함수의 결과가 따라 바뀌고, 게이트가 자동으로 더 넓어진다.
const JEKYLL_DISABLED = () => existsSync(path.join(ROOT, '.nojekyll'));
function isJekyllHidden(relativePath) {
  return relativePath.split('/').some((segment) => segment.startsWith('_') || segment.startsWith('.'));
}
function publishedHtml() {
  const jekyllOff = JEKYLL_DISABLED();
  return walk(ROOT, (item) => item.endsWith('.html'))
    .filter((file) => jekyllOff || !isJekyllHidden(relative(file)));
}

function scriptReferences(source) {
  return [...source.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/giu)].map(([, src]) => src);
}

// 게시되는 HTML이 **실제로 로드하는** 로컬 스크립트. 검사 대상 JS 목록을 손으로 적으면
// 새 화면(/usage/ 같은)이 생겨도 게이트가 그 화면의 스크립트를 보지 않는다 —
// 목록을 마크업에서 도출해 화면이 늘면 검사도 함께 늘어나게 한다 (LESSONS 규칙 5).
function publishedScripts() {
  const scripts = new Set();
  for (const file of publishedHtml()) {
    for (const source of scriptReferences(readFileSync(file, 'utf8'))) {
      if (/^https?:/iu.test(source)) continue;
      const absolute = resolveAsset(file, source);
      if (existsSync(absolute)) scripts.add(relative(absolute));
    }
  }
  return [...scripts].sort();
}

// ---- 로그인 게이트의 판정 ----------------------------------------------------
// 파일 이름(account.js / admin.js)을 적는 대신 **게이트가 하는 일**을 스크립트 소스에서
// 찾는다: 랜딩으로 되돌리는 리다이렉트이거나, 관리자 토큰을 요구하거나.
// 게이트 스크립트를 새로 만들거나 이름을 바꿔도 계약이 따라온다.
//
// 이 판정이 **못 보는 것**: 게이트가 *실제로 렌더 전에 도는지*(코드 순서), 조건이
// 올바른지, 그리고 서버가 같은 규칙을 강제하는지. 여기서 보는 것은 "가리려는 코드가
// 이 화면에 실려 있는가"까지다.
const GATE_MARKERS = [
  { name: 'login redirect', test: (js) => /location\.replace\(/u.test(js) && js.includes('login=1') },
  { name: 'admin token', test: (js) => js.includes('hvsdcm.admin') },
  { name: 'owner bearer gate', test: (js) => js.includes("localStorage.getItem('hvsdcm.token')")
    && js.includes('authorization: `Bearer ${ownerToken()}`') && js.includes('ownerVerified') },
];
function loginGateOf(htmlFile, source) {
  for (const reference of scriptReferences(source)) {
    if (/^https?:/iu.test(reference)) continue;
    const absolute = resolveAsset(htmlFile, reference);
    if (!existsSync(absolute)) continue;
    const js = readFileSync(absolute, 'utf8');
    const marker = GATE_MARKERS.find((candidate) => candidate.test(js));
    if (marker) return { script: relative(absolute), marker: marker.name };
  }
  return null;
}

// 미로그인 방문자에게 학습 내용을 노출하지 않는다는 계약을 **게시되는 모든 HTML**에 건다
// (plan.md §3). 랜딩은 로그인 뒤 JS가 링크를 만들고, 나머지 화면은 자기 게이트 스크립트로
// 가려진다. 그 어느 쪽도 아닌 게시 HTML은 학습 문구를 담고 있으면 안 된다.
const STUDY_KEYWORDS = ['학습', 'WordMaster', 'smstudy', 'Study'];
function validateStudyExposure() {
  const pages = publishedHtml();
  check(!JEKYLL_DISABLED(), 'learning content: .nojekyll would publish the protected _learning directory');
  const jekyllConfigPath = path.join(ROOT, '_config.yml');
  const jekyllConfig = existsSync(jekyllConfigPath) ? readFileSync(jekyllConfigPath, 'utf8') : '';
  check(!/include\s*:[^\n]*_learning/u.test(jekyllConfig), 'learning content: _config.yml must not include the protected _learning directory');
  check(!existsSync(path.join(ROOT, 'smstudy/assets/kice')), 'learning content: public smstudy/assets/kice must stay absent');
  const wordLoader = readFileSync(path.join(ROOT, 'WordMaster/assets/js/words.js'), 'utf8');
  const smstudyLoader = readFileSync(path.join(ROOT, 'smstudy/assets/js/data.js'), 'utf8');
  const plstudyLoader = readFileSync(path.join(ROOT, 'plstudy/assets/js/data.js'), 'utf8');
  check(wordLoader.includes('/api/learning/wordmaster') && !wordLoader.includes('d01-01'),
    'learning content: public WordMaster loader must contain only the authenticated API bootstrap');
  check(smstudyLoader.includes('/api/learning/smstudy') && !smstudyLoader.includes('QUESTION_ROWS'),
    'learning content: public smstudy loader must contain only the authenticated API bootstrap');
  check(plstudyLoader.includes('/api/learning/plstudy') && !plstudyLoader.includes('PLSTUDY_DATA'),
    'learning content: public plstudy loader must contain only the authenticated API bootstrap');
  for (const file of walk(path.join(ROOT, '_learning'), () => true)) {
    check(isJekyllHidden(relative(file)), `${relative(file)}: protected source escaped the Jekyll-hidden _learning boundary`);
  }
  check(pages.length >= 4, `study exposure: only ${pages.length} published HTML files were derived — this check is inert`);
  for (const file of pages) {
    const name = relative(file);
    if (name === 'index.html') continue;   // validateLandingGating()이 따로 본다
    const source = readFileSync(file, 'utf8');
    if (loginGateOf(file, source)) continue;
    for (const keyword of STUDY_KEYWORDS) {
      check(!source.includes(keyword),
        `${name}: published without a login gate but contains study keyword "${keyword}" — move it out of the published surface (a "_" directory) or gate it (plan.md §3)`);
    }
  }
}

// hidden 속성이 붙은 채로 렌더되는 요소의 class 토큰을 뽑는다 (템플릿 보간 토큰은 제외).
function hiddenClassTokens(markup) {
  const tokens = new Set();
  for (const tag of markup.match(/<[a-z][\w-]*\b[^>]*>/gu) || []) {
    if (!/\shidden(?=[\s>])/u.test(tag)) continue;
    const classMatch = tag.match(/\sclass="([^"]*)"/u);
    if (!classMatch) continue;
    for (const token of classMatch[1].split(/\s+/u)) {
      if (token && !token.includes('$') && !token.includes('{')) tokens.add(token);
    }
  }
  return [...tokens];
}

// '.token { ... }' 단독 선택자 규칙의 display 값을 돌려준다 (규칙이나 선언이 없으면 null).
function baseRuleDisplay(css, token) {
  const rule = new RegExp(`(?:^|\\})\\s*\\.${token}\\s*\\{([^}]*)\\}`, 'su').exec(css);
  if (!rule) return null;
  const display = /display\s*:\s*([a-z-]+)/u.exec(rule[1]);
  return display ? display[1] : null;
}

function relative(absolute) {
  return path.relative(ROOT, absolute).split(path.sep).join('/');
}

function validateJavaScriptSyntax() {
  for (const file of walk(ROOT, (item) => item.endsWith('.js') || item.endsWith('.mjs'))) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      check(true, '');
    } catch (error) {
      check(false, `${relative(file)}: JavaScript syntax error\n${error.stderr?.toString() || error.message}`);
    }
  }
}

function resolveAsset(htmlFile, reference) {
  const clean = reference.split(/[?#]/u, 1)[0];
  const absolute = clean.startsWith('/')
    ? path.join(ROOT, clean.slice(1))
    : path.resolve(path.dirname(htmlFile), clean);
  if (existsSync(absolute) && statSync(absolute).isDirectory()) return path.join(absolute, 'index.html');
  return absolute;
}

function validateHtmlAssets() {
  for (const file of publishedHtml()) {
    const source = readFileSync(file, 'utf8');
    check(!/<style\b/iu.test(source), `${relative(file)}: inline <style> is not allowed`);
    check(!/<script(?![^>]*\bsrc=)[^>]*>/iu.test(source), `${relative(file)}: inline executable <script> is not allowed`);

    const references = source.matchAll(/<(?:script|link|img)\b[^>]*(?:src|href)=["']([^"']+)["']/giu);
    for (const [, reference] of references) {
      if (/^(?:https?:|data:|#)/iu.test(reference)) continue;
      const target = resolveAsset(file, reference);
      check(existsSync(target), `${relative(file)}: missing local asset ${reference}`);
    }
  }
}

function validateUiContracts() {
  // 랜딩 검사는 Apple Dark v2 구조(사이클 #2 재작성)의 훅을 검사한다 (plan.md D2).
  const homeHtml = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const homeCss = readFileSync(path.join(ROOT, 'assets/css/home.css'), 'utf8');
  const homeJs = readFileSync(path.join(ROOT, 'assets/js/home.js'), 'utf8');
  const systemCss = readFileSync(path.join(ROOT, 'assets/css/system.css'), 'utf8');
  const wordMasterCss = readFileSync(path.join(ROOT, 'WordMaster/assets/css/style.css'), 'utf8');
  const wordMasterJs = readFileSync(path.join(ROOT, 'WordMaster/assets/js/app.js'), 'utf8');
  const smstudyJs = readFileSync(path.join(ROOT, 'smstudy/assets/js/app.js'), 'utf8');
  const wordMasterHtml = readFileSync(path.join(ROOT, 'WordMaster/index.html'), 'utf8');
  const smstudyHtml = readFileSync(path.join(ROOT, 'smstudy/index.html'), 'utf8');
  const smstudyCss = readFileSync(path.join(ROOT, 'smstudy/assets/css/style.css'), 'utf8');
  const adminHtml = readFileSync(path.join(ROOT, 'admin/index.html'), 'utf8');
  const adminCss = readFileSync(path.join(ROOT, 'admin/assets/css/admin.css'), 'utf8');
  const adminJs = readFileSync(path.join(ROOT, 'admin/assets/js/admin.js'), 'utf8');
  const usageHtml = readFileSync(path.join(ROOT, 'usage/index.html'), 'utf8');
  const usageCss = readFileSync(path.join(ROOT, 'usage/assets/css/usage.css'), 'utf8');
  const competitionPageJs = readFileSync(path.join(ROOT, 'usage/assets/js/page.js'), 'utf8');

  // 랜딩의 본문은 워드마크 하나뿐이고, 로그인한 경우에만 빈 드로어에 링크를 조립한다.
  check(/<main id="main">\s*<button id="wordmark"[^]*?HVSDCM1[^]*?<\/button>\s*<\/main>/u.test(homeHtml),
    'home: visible landing must contain only the HVSDCM1 wordmark');
  check(homeHtml.includes('id="studyLinks"') && homeHtml.includes('id="ownerLinks"'),
    'home: signed-in navigation mount points are missing');
  // 대화상자 의미는 백드롭이 아니라 시트 본체(form.sheet)에 붙는다 (review-3a N-7).
  check(/id="loginForm"[^>]*class="[^"]*\bsheet\b[^"]*"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="loginTitle"/u.test(homeHtml),
    'home: login sheet itself must carry role="dialog" aria-modal="true" aria-labelledby="loginTitle"');
  check(!/id="loginModal"[^>]*(?:role="dialog"|aria-modal=)/u.test(homeHtml),
    'home: sheet backdrop must not carry dialog semantics — they belong on the .sheet form');
  check(/id="loginTitle"/u.test(homeHtml), 'home: login dialog label target #loginTitle is missing');
  check(homeHtml.includes('data-login-trigger'), 'home: login trigger hook is missing');
  check(/if \(signedIn\) mountSignedInLinks\(\)/u.test(homeJs),
    'home: signed-in navigation must mount only inside the authenticated branch');
  check(homeJs.includes('setBackgroundInert(true)') && homeJs.includes('setBackgroundInert(false)'),
    'home: the modal must make page siblings inert only while it is open');
  check(homeJs.includes("event.key !== 'Tab'") && homeJs.includes('trapLoginFocus(event)'),
    'home: the login dialog must trap Tab and Shift+Tab focus');
  check(homeJs.includes('opener?.focus()'),
    'home: closing the login dialog must restore focus to its opener');

  check(wordMasterJs.includes('wrongVisible: 50')
    && wordMasterJs.includes('.slice(0, state.wrongVisible)')
    && wordMasterJs.includes('state.wrongVisible += 50'),
  'WordMaster: wrong-answer history must render in bounded 50-row batches');
  check(smstudyJs.includes('data-mistake-id=')
    && smstudyJs.includes('data-mistake-body')
    && smstudyJs.includes('bindMistakeDisclosures'),
  'smstudy: wrong-answer detail cards must render lazily inside disclosures');

  // 앱 진입은 모두 드로어의 두 빈 마운트 지점으로만 들어간다.
  const drawerMarkup = /<aside id="drawer"[^]*?<\/aside>/u.exec(homeHtml)?.[0] ?? '';
  check(drawerMarkup.length > 0,
    'home: the drawer landmark could not be located — the drawer-only study contract cannot be checked');
  check(drawerMarkup.includes('id="studyLinks"') && drawerMarkup.includes('id="ownerLinks"'),
    'home: navigation may mount only inside the drawer');
  check(homeJs.includes('appendLinks(elements.studyLinks') && homeJs.includes('appendLinks(elements.ownerLinks'),
    'home: signed-in and owner-only entries must target their scoped drawer mounts');
  check(homeJs.includes("if (!ownerUsernames.has(String(savedUsername).toLowerCase())) return;"),
    'home: owner-only links must never be created for a non-owner');

  // `/usage/` 경로는 공모전 자동화가 이미 사용하므로 유지하지만, 화면은 공모전 전용이다.
  check(usageHtml.includes('id="competitionBody"') && !usageHtml.includes('id="usageBody"'),
    'competition: the retained /usage/ screen must expose competition only');
  check(competitionPageJs.includes("request('/api/competitions')") || competitionPageJs.includes("path === '/api/competitions'"),
    'competition: the page controller must use only the competition read route');
  check(!competitionPageJs.includes('/api/usage') && !competitionPageJs.includes('/api/harness'),
    'competition: archived usage and harness routes must not return to the active page');
  check(usageCss.includes('.cp-body') && !usageCss.includes('.us-command-layout'),
    'competition: the stylesheet must keep competition rules without the archived command center');

  // system.css 공통 프리미티브 — 3b에서 앱 3면이 이 위에 얹힌다.
  for (const primitive of ['.btn ', '.btn-primary ', '.field-input ', '.card ', '.sheet ', '.sheet-backdrop ', '.table ', '.badge ', '.segmented ', '.toolbar ', '.sidebar ', '.toast ', '.topbar ', '.app-shell ', '.segmented-btn ', '.sidebar-item ']) {
    check(systemCss.includes(primitive.trimEnd() + ' {') || systemCss.includes(primitive.trimEnd() + ','), `system.css: primitive ${primitive.trim()} is missing`);
  }

  // 앱 3면 공통 셸 (사이클 #2 3b 재작성): topbar + app-shell + 사이드바 + 접근성 훅.
  const appSurfaces = {
    'WordMaster/index.html': wordMasterHtml,
    'smstudy/index.html': smstudyHtml,
    'admin/index.html': adminHtml,
  };
  for (const [name, source] of Object.entries(appSurfaces)) {
    check(/<header class="topbar">/u.test(source), `${name}: shared topbar landmark is missing`);
    check(/class="brand"[^>]*><img\b[^>]*src="\/assets\/logo\.svg"[^>]*>hvsdcm</u.test(source), `${name}: topbar must use the shared logo before the hvsdcm wordmark`);
    check(source.includes('class="skip-link"'), `${name}: skip navigation link is missing`);
    check(source.includes('class="app-shell"'), `${name}: app shell layout is missing`);
    check(/<aside class="sidebar"[^>]*aria-label=/u.test(source), `${name}: labelled sidebar landmark is missing`);
    check(/<main [^>]*class="app-main"[^>]*tabindex="-1"/u.test(source), `${name}: focusable main region is missing`);
    check(!source.includes('site-nav.css'), `${name}: stale site-nav.css link`);
  }

  // 학습 앱 2면: 사이드바 화면 전환 훅과 토스트 상태 영역.
  const studySurfaces = {
    'WordMaster/index.html': [wordMasterHtml, 'homeLogo', 'openStatsBtn'],
    'smstudy/index.html': [smstudyHtml, 'homeLogo', 'openStats'],
  };
  for (const [name, [source, homeId, statsId]] of Object.entries(studySurfaces)) {
    check(new RegExp(`id="${homeId}"[^>]*data-nav="home"`, 'u').test(source), `${name}: sidebar home switch hook is missing`);
    check(new RegExp(`id="${statsId}"[^>]*data-nav="stats"`, 'u').test(source), `${name}: sidebar stats switch hook is missing`);
    check(/<div id="toast" class="toast" role="status" aria-live="polite">/u.test(source), `${name}: polite toast region is missing`);
  }

  // 3c에서 앱 셸 보조 규칙(.app-main / .view-head / .side-* / .app-footer / .app-page)을
  // system.css로 승격했다. 화면마다 같은 규칙을 다시 두지 않으므로 단일 원본에서 확인한다.
  // 조판이 아니라 규칙을 본다 — 포매터가 한 줄 규칙을 펼쳐도 계약은 그대로다 (review WP1 M-4).
  check(/\.app-main:focus\s*\{\s*outline:\s*none;?\s*\}/u.test(systemCss), 'system.css: programmatic main focus must not paint an outline');
  for (const primitive of ['.app-page', '.app-main', '.view-head', '.view-head-main', '.side-facts', '.side-note', '.app-footer', '.sr-only', '.list-row-stretch', '.list-row-accessory', '.disclosure', '.disclosure-head', '.disclosure-body', '.list-group-head-row',
    // 사이클5 — 콘솔 대시보드 프리미티브 (plan.md §3.4). admin과 usage가 공유한다.
    '.sidebar-label', '.summary-strip', '.summary-cell', '.status-dot', '.gauge-track', '.gauge-fill']) {
    check(systemCss.includes(primitive + ' {') || systemCss.includes(primitive + ','),
      `system.css: primitive ${primitive} is missing`);
  }
  // 승격된 규칙이 화면 CSS에 되살아나면(같은 모양의 재구현) 톤이 다시 갈라진다.
  // 인쇄 블록은 제외한다 — 거기서 프리미티브를 숨기는 것은 재구현이 아니라 소비다.
  const withoutPrint = (css) => css.replace(/@media\s+print\s*\{[\s\S]*$/u, '');
  for (const [name, css] of [['WordMaster', wordMasterCss], ['smstudy', withoutPrint(smstudyCss)], ['admin', adminCss], ['usage', usageCss]]) {
    for (const primitive of ['.app-main', '.view-head', '.side-facts', '.side-note', '.app-footer',
      '.summary-strip', '.summary-cell', '.status-dot', '.gauge-track', '.gauge-fill']) {
      check(!new RegExp(`(^|[\\s,}])\\${primitive}\\s*(\\{|,)`, 'mu').test(css),
        `${name}: ${primitive} is promoted to system.css — do not redefine it in a screen stylesheet (DESIGN.md §7)`);
    }
  }
  check(wordMasterCss.includes('grid-template-columns: minmax(0, 1fr) auto'), 'WordMaster: answer row must use a shrink-safe column');
  check(wordMasterJs.includes('function setNav('), 'WordMaster: sidebar state must follow the rendered view');
  check(wordMasterJs.includes("toast.classList.add('open')"), 'WordMaster: toast must use the shared .toast.open contract');
  check(wordMasterJs.includes('wrongCount: cumulativeWrongCount'), 'WordMaster: wrong-rate ties must use cumulative mistakes');

  check(smstudyCss.includes('@media print'), 'smstudy: printable concept-note stylesheet is missing');
  check(smstudyCss.includes('.sm-media-fallback'), 'smstudy: KICE image fallback styling is missing');
  check(smstudyJs.includes('function setNav('), 'smstudy: sidebar state must follow the rendered view');
  check(smstudyJs.includes("toast.classList.add('open')"), 'smstudy: toast must use the shared .toast.open contract');
  // 이미지 폴백 — 존재 검사 두 개를 AND로 묶으면 서로 다른 요소를 봐도 통과한다 (LESSONS 규칙 4).
  // 실제로 마크업의 속성만 바꿔도 바인더 쪽 선택자 문자열이 남아 모든 검사가 통과했다 (review B-4).
  // 그래서 선택자를 **바인더에서 도출**해 그 값으로 마크업 한 덩어리를 검사한다.
  // 어느 한쪽만 이름을 바꾸면 도출값과 마크업이 어긋나 즉시 실패한다.
  const binderBody = /function bindQuestionImages\([^)]*\)\s*\{([\s\S]*?)\n {2}\}/u.exec(smstudyJs)?.[1] ?? '';
  const imageHook = /querySelectorAll\('\[([\w-]+)\]'\)/u.exec(binderBody)?.[1];
  const figureClass = /closest\('\.([\w-]+)'\)/u.exec(binderBody)?.[1];
  const fallbackClass = /querySelector\('\.([\w-]+)'\)/u.exec(binderBody)?.[1];
  check(Boolean(imageHook && figureClass && fallbackClass),
    `smstudy: could not derive the image-fallback selectors from bindQuestionImages() (hook=${imageHook}, figure=${figureClass}, fallback=${fallbackClass})`);
  if (imageHook && figureClass && fallbackClass) {
    // 마크업 쪽 대상은 **renderQuestionMedia() 함수 본문 안**으로 한정한다.
    // 소스 전체 정규식은 함수 앞에 놓인 같은 모양의 미사용 문자열을 먼저 잡아, 실제로 깨진
    // 이미지 바인딩을 가린다 (review R2-B-3에서 이 우회가 13204 checks로 통과했다).
    const mediaBody = functionBody(smstudyJs, 'renderQuestionMedia') ?? '';
    check(mediaBody.length > 0, 'smstudy: renderQuestionMedia() body could not be located in app.js — the media contract cannot be checked');
    const mediaFigure = new RegExp(`<figure class="${figureClass}[^"]*"[\\s\\S]*?</figure>`, 'u').exec(mediaBody)?.[0] ?? '';
    check(mediaFigure.length > 0, `smstudy: renderQuestionMedia() must emit a <figure class="${figureClass}"> that the binder can find with closest()`);
    // 같은 모양의 <figure>가 함수 밖에 또 있으면 검사 대상이 흔들린다 — 하나뿐이어야 한다.
    const figureOpen = new RegExp(`<figure class="${figureClass}[^"]*"`, 'gu');
    check((smstudyJs.match(figureOpen) || []).length === (mediaBody.match(figureOpen) || []).length,
      `smstudy: app.js emits <figure class="${figureClass}"> outside renderQuestionMedia() — the image-fallback contract must have exactly one target`);
    check(new RegExp(`<img\\b[^>]*\\s${imageHook}(?:="[^"]*")?(?=[\\s>])`, 'u').test(mediaFigure),
      `smstudy: the question <img> inside <figure class="${figureClass}"> must carry the ${imageHook} attribute the binder selects on`);
    check(new RegExp(`<div\\b[^>]*class="${fallbackClass}"[^>]*\\shidden(?=[\\s>])`, 'u').test(mediaFigure),
      `smstudy: the same <figure> must hold a <div class="${fallbackClass}" hidden> for the binder to unhide`);
    check(/\.sm-media\.is-failed \.sm-media-fallback \{[^}]*display: grid/su.test(smstudyCss), 'smstudy: fallback must be revealed by an explicit failure-state rule');
    check(baseRuleDisplay(smstudyCss, fallbackClass) === 'none', `smstudy: .${fallbackClass} must default to display: none so a rendered-but-hidden fallback stays invisible`);
    check(smstudyCss.includes(`.${fallbackClass}`), `smstudy: KICE image fallback styling for .${fallbackClass} is missing`);
  }
  check(smstudyJs.includes("HvsAccount.request(`/api/learning/smstudy/image/"), 'smstudy: question images must cross the authenticated Worker boundary');
  check(smstudyJs.includes("addEventListener('error', () =>"), 'smstudy: protected image error handler must be bound');
  check(smstudyJs.includes("addEventListener('load', () =>"), 'smstudy: protected image success handler must be bound');
  check(smstudyJs.includes('URL.revokeObjectURL(objectUrl)'), 'smstudy: protected image object URLs must be released');
  check(/markLoaded = \(\) => \{[^}]*fallback\.hidden = true/su.test(smstudyJs), 'smstudy: image success path must re-hide the fallback block');

  // 회귀 방지: hidden 속성으로 렌더되는 블록을 저자 CSS의 display 선언이 되살리는 결함을 잡는다.
  // UA 스타일시트의 [hidden] { display: none } 은 저자 규칙에 항상 지므로, hidden 만으로는 숨겨지지 않는다.
  for (const [surface, markup, css] of [
    ['smstudy', smstudyJs + smstudyHtml, smstudyCss],
    ['WordMaster', wordMasterJs + wordMasterHtml, wordMasterCss],
  ]) {
    for (const token of hiddenClassTokens(markup)) {
      const display = baseRuleDisplay(css, token);
      if (display === null || display === 'none') continue;
      const guarded = css.includes(`.${token}[hidden]`) || /\[hidden\]\s*\{[^}]*display\s*:\s*none/su.test(css);
      check(guarded, `${surface}: .${token} renders with a hidden attribute but its CSS sets display: ${display}; add a [hidden] guard or default it to none`);
    }
  }
  check(smstudyJs.includes('wrongCount: cumulativeWrongCount'), 'smstudy: wrong-rate ties must use cumulative mistakes');

  check(adminHtml.includes('content="noindex, nofollow"'), 'admin: dashboard must stay unindexed');
  check(/<table class="table">/u.test(adminHtml), 'admin: tables must use the shared table primitive');
  check(/id="adminShell"[^>]*\bhidden\b/u.test(adminHtml), 'admin: dashboard shell must start hidden');
  // 로그인 전에는 셸 전체가 렌더 트리에서 빠져야 한다. 공용 .hidden 유틸 대신 실제
  // hidden 속성을 쓰고, author display:grid가 UA 규칙을 이기지 못하게 셸에 직접 잠근다.
  check(/\.app-shell\[hidden\]\s*\{\s*display:\s*none;?\s*\}/u.test(adminCss),
    'admin: .app-shell[hidden] must collapse the dashboard shell');
  check(adminJs.includes('btn btn-danger btn-sm delete-user'), 'admin: destructive user action must use the danger button primitive');

  // ---- 어드민 카테고리 뷰 (plan.md §3 요구사항 3 / §3.4) ----
  // 뷰 목록을 여기에 적지 않는다 — 사이드바의 data-view가 원본이고, 뷰 컨테이너와 초기
  // 표시 상태를 거기서 도출한다. 사이드바에 항목을 더하면 짝이 되는 뷰가 없을 때 실패한다.
  //
  // 이 검사가 **못 보는 것**: 런타임의 뷰 전환(클릭했을 때 정말 하나만 남는지)과 각 뷰의
  // 내용 적절성. 정적으로 볼 수 있는 것은 "문서 초기 상태에서 뷰가 하나만 열려 있는가"와
  // "hidden이 CSS에 지지 않는가"까지다. 나머지는 사람이 스냅샷과 화면에서 본다.
  const adminNavViews = [...adminHtml.matchAll(/<button class="sidebar-item"[^>]*\sdata-view="([\w-]+)"/gu)]
    .map(([, name]) => name);
  const adminViewSections = [...adminHtml.matchAll(/<section class="ad-view" data-view="([\w-]+)"([^>]*)>/gu)];
  check(adminNavViews.length >= 3,
    `admin: only ${adminNavViews.length} sidebar views were derived — the category check is inert`);
  check(adminViewSections.length === adminNavViews.length,
    `admin: ${adminNavViews.length} sidebar entries but ${adminViewSections.length} view containers — every category needs exactly one view (plan.md §3.4)`);
  for (const name of adminNavViews) {
    check(adminViewSections.some(([, view]) => view === name),
      `admin: sidebar entry data-view="${name}" has no matching <section class="ad-view">`);
  }
  const adminVisibleViews = adminViewSections.filter(([, , attributes]) => !/\shidden(?=[\s>]|$)/u.test(attributes));
  check(adminVisibleViews.length === 1,
    `admin: ${adminVisibleViews.length} views render without the hidden attribute — exactly one category may be on screen at a time (plan.md §3 requirement 3)`);
  // UA 스타일시트의 [hidden] { display: none }은 저자 규칙에 항상 진다. 뷰 컨테이너의
  // 기본 display가 none이어야 hidden이 실제로 숨긴다 (사이클4의 같은 결함 계열).
  check(/\.ad-view\s*\{[^}]*display:\s*none/su.test(adminCss),
    'admin: .ad-view must default to display: none so the hidden attribute actually hides a view');
  check((adminHtml.match(/<p class="sidebar-label">/gu) || []).length >= 3,
    'admin: sidebar entries must be grouped under uppercase section labels (plan.md §3.4)');
  check(adminHtml.includes('id="stats" class="summary-strip"'),
    'admin: the overview view must open with the shared summary strip (plan.md §3.4)');
  check(adminJs.includes('class="summary-cell"'),
    'admin: the summary strip must be filled with .summary-cell tiles derived from /api/admin/stats');
  check(/<header class="view-head">[^]*?<div class="toolbar-group">\s*<button/u.test(adminHtml),
    'admin: the content header must carry its action buttons on the right (plan.md §3.4)');
}

function validateMigrations() {
  const migrationDirectory = path.join(ROOT, 'worker/migrations');
  const migrations = readdirSync(migrationDirectory)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  migrations.forEach((file, index) => {
    const expectedPrefix = String(index + 1).padStart(4, '0');
    check(file.startsWith(expectedPrefix), `worker: migration sequence gap at ${file}`);
  });
  const sessionIpMigration = readFileSync(path.join(migrationDirectory, '0004_session_ip_address.sql'), 'utf8');
  check(sessionIpMigration.includes('ip_address'), 'worker: migration 0004 must add session IP storage');
  const usageMigration = readFileSync(path.join(migrationDirectory, '0005_usage_snapshots.sql'), 'utf8');
  check(
    /CREATE TABLE usage_snapshots[\s\S]*source TEXT PRIMARY KEY[\s\S]*captured_at TEXT NOT NULL[\s\S]*payload TEXT NOT NULL/u
      .test(usageMigration),
    'worker: migration 0005 must define the usage snapshot contract',
  );
  const harnessMigration = readFileSync(path.join(migrationDirectory, '0006_harness_tasks.sql'), 'utf8');
  check(
    /CREATE TABLE harness_tasks[\s\S]*task_id TEXT PRIMARY KEY[\s\S]*status TEXT NOT NULL[\s\S]*updated_at TEXT NOT NULL[\s\S]*payload TEXT NOT NULL/u
      .test(harnessMigration),
    'worker: migration 0006 must define the harness task contract',
  );
  const loginLimitsMigration = readFileSync(path.join(migrationDirectory, '0008_login_attempt_limits.sql'), 'utf8');
  check(
    /CREATE TABLE login_attempt_limits[\s\S]*key_hash TEXT PRIMARY KEY[\s\S]*minute_attempts INTEGER NOT NULL[\s\S]*failure_count INTEGER NOT NULL[\s\S]*locked_until INTEGER NOT NULL/u
      .test(loginLimitsMigration),
    'worker: migration 0008 must define hashed login attempt and lockout counters',
  );
}

function validateGichulBackend() {
  const requiredFiles = [
    'scripts/gichul/availability.mjs',
    'scripts/gichul/fetch-kice.mjs',
    'scripts/gichul/build-manifest.mjs',
    'scripts/gichul/output-contract.e2e.mjs',
    'scripts/gichul/upload-r2.mjs',
    'scripts/gichul/overrides.json',
    'scripts/gichul/gichul.test.mjs',
  ];
  for (const file of requiredFiles) {
    check(existsSync(path.join(ROOT, file)), `${file}: gichul backend artifact is missing`);
  }

  const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check(Boolean(packageJson.devDependencies?.['pdfjs-dist']),
    'package.json: pdfjs-dist must be declared as a devDependency for manifest extraction');
  check(Boolean(packageJson.devDependencies?.['@napi-rs/canvas']),
    'package.json: @napi-rs/canvas must be declared for image-only answer table extraction');
  check(!packageJson.dependencies?.['pdfjs-dist'],
    'package.json: pdfjs-dist must not be a production dependency');
  check(String(packageJson.scripts?.test || '').includes('scripts/gichul/gichul.test.mjs'),
    'package.json: npm test must include the gichul script tests');

  const ignoreLines = readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
    .split('\n').map((line) => line.trim());
  check(ignoreLines.includes('gichul-src/'), '.gitignore: gichul-src/ must stay outside Git');
  check(!existsSync(path.join(ROOT, 'scripts/gichul/sources.json')),
    'scripts/gichul/sources.json: hard-coded post seeds are forbidden; the KICE list page is the source');

  const fetchSource = readFileSync(path.join(ROOT, 'scripts/gichul/fetch-kice.mjs'), 'utf8');
  const availabilitySource = readFileSync(path.join(ROOT, 'scripts/gichul/availability.mjs'), 'utf8');
  const crawlContractSource = `${availabilitySource}\n${fetchSource}`;
  for (const marker of ['1500234', '1500236', 'C01', 'C02', 'C03', 'fileDown.do']) {
    check(crawlContractSource.includes(marker), `scripts/gichul: missing crawl-contract marker ${marker}`);
  }
  check(availabilitySource.includes('academic_years: { from: 2020, to: 2027 }'),
    'scripts/gichul/availability.mjs: academic years 2020-2027 must be one bounded descriptor range');
  const fetchProduction = /export async function fetchKice\([^]*?\n\}\n\nfunction cliOptions/u.exec(fetchSource)?.[0] || '';
  const inventoryWriteIndex = fetchProduction.indexOf('await writeInventory(inventoryPath, outputs, availability, allowPartial)');
  const coverageGateIndex = fetchProduction.indexOf('validateAssignmentCoverage(outputs, availability)');
  check(fetchSource.includes('crawl-inventory.json')
    && inventoryWriteIndex >= 0
    && coverageGateIndex > inventoryWriteIndex
    && fetchSource.includes('previous?.fileSeq === attachment.fileSeq'),
    'scripts/gichul/fetch-kice.mjs: current fileSeq inventory and complete-corpus gates are missing');
  for (const { id: subject } of DEFAULT_AVAILABILITY.subjects) {
    check(availabilitySource.includes(`id: '${subject}'`),
      `scripts/gichul/availability.mjs: target subject ${subject} is missing`);
  }

  const manifestSource = readFileSync(path.join(ROOT, 'scripts/gichul/build-manifest.mjs'), 'utf8');
  check(manifestSource.includes("import('pdfjs-dist/legacy/build/pdf.mjs')"),
    'scripts/gichul/build-manifest.mjs: pdfjs-dist must be loaded only by the real extractor');
  check(manifestSource.includes('extractText = extractPdfText'),
    'scripts/gichul/build-manifest.mjs: PDF text extraction must remain injectable for fixture tests');
  const manifestProduction = /export async function buildManifest\([^]*?\n\}\n\nfunction cliOptions/u.exec(manifestSource)?.[0] || '';
  check(manifestProduction.includes('validateManifest(exams, activeAvailability)'),
    'scripts/gichul/build-manifest.mjs: generated exams must pass range validation before write');
  check(manifestProduction.includes('validateCrawlInventory(')
    && manifestProduction.includes('validateCorpusManifest(')
    && manifestProduction.includes('unusedOverrides'),
    'scripts/gichul/build-manifest.mjs: crawl inventory, corpus, or exact override gate is missing');

  const uploadSource = readFileSync(path.join(ROOT, 'scripts/gichul/upload-r2.mjs'), 'utf8');
  check(uploadSource.includes('.r2-upload-state.json') && uploadSource.includes("'--remote'"),
    'scripts/gichul/upload-r2.mjs: remote uploads must use a local content-hash checkpoint');
  check(uploadSource.includes("left.key === 'manifest.json'")
    && uploadSource.indexOf('await run(') < uploadSource.indexOf('await writeState('),
    'scripts/gichul/upload-r2.mjs: manifest-last ordering or post-success checkpoint is missing');

  const wrangler = readFileSync(path.join(ROOT, 'worker/wrangler.toml'), 'utf8');
  check(/\[\[r2_buckets\]\][^]*?binding\s*=\s*"GICHUL"[^]*?bucket_name\s*=\s*"hvsdcm-gichul"/u.test(wrangler),
    'worker/wrangler.toml: the GICHUL R2 binding is missing or incomplete');

  const router = readFileSync(path.join(ROOT, 'worker/src/router.js'), 'utf8');
  check(router.includes('/api/gichul/manifest'),
    'worker/src/router.js: missing /api/gichul/manifest route');
  check(router.includes('const gichulPdfMatch = path.match(') && router.includes('return gichulPdf('),
    'worker/src/router.js: missing /api/gichul/pdf/:id route');
  check(router.includes("'cache-control': 'no-store'"),
    'worker/src/router.js: gichul responses must disable caching');

  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const architecture = readFileSync(path.join(ROOT, 'docs/ARCHITECTURE.md'), 'utf8');
  check(readme.includes('/gichul/'), 'README.md: the gichul screen is missing from the application list');
  check(architecture.includes('GET /api/gichul/manifest') && architecture.includes('GET /api/gichul/pdf/:id'),
    'docs/ARCHITECTURE.md: the authenticated gichul API surface is incomplete');
}

// ---- WP2. 기출 프런트 ----
// 이 게이트가 **못 보는 것**을 먼저 적는다 (승격 규칙 "자동 게이트 사각지대 점검"):
//   - 실제 병합 결과물. pdf-lib은 브라우저에서 돌고, 페이지 구간이 실 PDF와 맞는지는
//     매니페스트 생성기가 실 PDF로 대조한다. 여기서는 "부분 병합 금지" 계약이 코드에
//     남아 있는지까지만 본다.
//   - R2·Worker 실접근, 그리고 화면의 시각 품질. 후자는 docs/_snapshots/gichul.html이
//     사람 눈으로 볼 수 있게 남긴다.
//   - 벤더 번들의 내용. 압축된 한 줄이라 읽을 수 없으므로 **바이트 해시로 잠근다** —
//     번들을 갈아치우려면 이 해시를 같은 커밋에서 갱신해야 한다.
function validateGichulFrontend() {
  for (const file of ['gichul/index.html', 'gichul/app.js', 'gichul/gichul.css',
    'assets/vendor/pdf-lib/pdf-lib.min.js', 'assets/vendor/pdf-lib/LICENSE']) {
    check(existsSync(path.join(ROOT, file)), `${file}: gichul frontend artifact is missing`);
    if (!existsSync(path.join(ROOT, file))) return;
  }

  const PDF_LIB_LOCK = {
    version: 'pdf-lib@1.17.1',
    sha256: '36f3a04b9f61f15bc06a32182cb576c4f188d88ed99427ee9857e59ba46a713d',
  };
  const bundle = readFileSync(path.join(ROOT, 'assets/vendor/pdf-lib/pdf-lib.min.js'), 'utf8');
  check(createHash('sha256').update(readFileSync(path.join(ROOT, 'assets/vendor/pdf-lib/pdf-lib.min.js'))).digest('hex') === PDF_LIB_LOCK.sha256,
    'assets/vendor/pdf-lib/pdf-lib.min.js: bytes do not match PDF_LIB_LOCK.sha256 — re-vendor from npm and update the lock in the same commit');
  check(bundle.includes(PDF_LIB_LOCK.version) && bundle.includes('assets/vendor/pdf-lib/LICENSE'),
    `assets/vendor/pdf-lib/pdf-lib.min.js: the provenance header must name ${PDF_LIB_LOCK.version} and point at the vendored LICENSE`);
  check(readFileSync(path.join(ROOT, 'assets/vendor/pdf-lib/LICENSE'), 'utf8').includes('MIT License'),
    'assets/vendor/pdf-lib/LICENSE: the upstream MIT text is missing');

  // 과목·선택과목·시행의 어휘는 매니페스트 생성기가 단일 원본이다. 화면의 라벨 표를
  // 손으로 적은 사본으로 두면, 백엔드가 과목을 늘려도 화면은 그 항목을 코드값 그대로
  // 노출하거나 아예 빠뜨린다 (승격 규칙 "파생 가능한 것을 손으로 적지 않는다").
  const appSource = readFileSync(path.join(ROOT, 'gichul/app.js'), 'utf8');
  const labelKeys = (name) => {
    const block = new RegExp(`const ${name} = \\{([^}]*)\\}`, 'u').exec(appSource)?.[1] || '';
    return [...block.matchAll(/(?:^|\s)([\w']+):/gu)].map(([, key]) => key.replaceAll("'", ''));
  };
  const vocabulary = [
    {
      name: 'subject',
      keys: DEFAULT_AVAILABILITY.subjects.map(({ id }) => id),
      maps: ['SUBJECT_LABEL'],
    },
    {
      name: 'track',
      keys: [...new Set(DEFAULT_AVAILABILITY.subjects.flatMap(({ tracks }) => tracks.map(({ id }) => id)))]
        .filter((key) => key !== null),
      maps: ['TRACK_LABEL', 'TRACK_SHORT'],
    },
    { name: 'round', keys: DEFAULT_AVAILABILITY.rounds.map(({ id }) => id), maps: ['ROUND_LABEL', 'ROUND_FILE'] },
  ];
  for (const { name, keys, maps } of vocabulary) {
    check(keys.length >= 3,
      `gichul: only ${keys.length} ${name} keys were derived from scripts/gichul/build-manifest.mjs — this check is inert`);
    for (const map of maps) {
      const declared = labelKeys(map);
      check(declared.length >= 3, `gichul/app.js: ${map} could not be parsed — the vocabulary check is inert`);
      for (const key of declared) {
        check(keys.includes(key),
          `gichul/app.js: ${map} carries "${key}", which the availability descriptor never produces — dead label`);
      }
    }
    // 그 어휘가 정적 문서에 있으면, 미로그인 방문자의 DOM에 시험 목록의 일부가 있는 것이다.
    // 낱말 경계로 본다 — 'na'(나형) 같은 두 글자 키는 부분 문자열로 보면 'nav'에도 걸린다.
    const staticDocument = readFileSync(path.join(ROOT, 'gichul/index.html'), 'utf8');
    for (const key of keys) {
      check(!new RegExp(`\\b${key}\\b`, 'u').test(staticDocument),
        `gichul/index.html: the static document carries manifest vocabulary "${key}" — exam data must arrive only from GET /api/gichul/manifest`);
    }
  }

  // 데이터 경로와 계약이 코드에 남아 있는지.
  check(appSource.includes("'/api/gichul/manifest'"),
    'gichul/app.js: the exam list must be fetched from /api/gichul/manifest');
  check(appSource.includes('/api/gichul/pdf/'),
    'gichul/app.js: PDFs must be fetched through the authenticated worker route');
  check(appSource.includes('id="gichulRetry"') && appSource.includes("closest('#gichulRetry')"),
    'gichul/app.js: a manifest failure must provide an in-place retry action');
  check(/location\.replace\(loginPath\(\)\)/u.test(appSource) && appSource.includes('login=1'),
    'gichul/app.js: the login redirect gate is missing — the screen must not render for anonymous visitors');
  check(appSource.includes('window.GICHUL_RENDER'),
    'gichul/app.js: renderers must be reachable as window.GICHUL_RENDER so the snapshot renders the real markup');
  check(appSource.includes('window.PDFLib'),
    'gichul/app.js: merging must use the vendored window.PDFLib');
  const renderSection = appSource.slice(
    appSource.indexOf('function renderFilters'),
    appSource.indexOf('function planSegments'),
  );
  check(appSource.includes('class="disclosure gi-filter" open data-group=')
    && appSource.includes('class="list-row-value"')
    && appSource.includes('list-row-nav" type="button" data-open='),
  'gichul/app.js: filters and result rows must use disclosure, value and navigation primitives');
  check(!/list-row-sub|list-group-foot|side-note/u.test(renderSection),
    'gichul/app.js: filter and result renderers must not restore repeated descriptions');
  check(appSource.includes("matchMedia('(max-width: 860px)')")
    && appSource.includes("querySelectorAll('.gi-filter[open]')"),
  'gichul/app.js: mobile disclosures must preserve their open state across paint()');
  // 부분 병합 금지 — 실패 목록을 만든 뒤 PDFDocument.create()에 도달하기 전에 되돌아야 한다.
  check(appSource.includes('Promise.allSettled')
    && appSource.indexOf('if (failures.length)') !== -1
    && appSource.indexOf('if (failures.length)') < appSource.indexOf('PDFDocument.create()'),
    'gichul/app.js: a failed fetch must abort before any merging — no partial merge may be produced (plan.md §4)');
  check(appSource.includes('isExcerptable'),
    'gichul/app.js: items without sections.selection must be rejected in excerpt mode (plan.md §4)');
  check(!/\bstate\.includeCommon\b/u.test(appSource)
    && !appSource.includes('data-option="includeCommon"')
    && !appSource.includes('공통 파트 포함'),
    'gichul/app.js: excerpt mode must ignore the removed includeCommon state and emit selection pages only');
  check(appSource.includes('questionRange: exam.sections.common')
    && appSource.includes('questionRange: exam.sections.selection'),
  'gichul/app.js: full modern papers must be planned from common plus the selected track range');
  check(appSource.includes('answer.canonical_form !== exam.canonical_form')
    && appSource.includes("answerField: 'answer_common'")
    && appSource.includes("answerField: 'answer_selection'")
    && appSource.includes('answer?.[answerField]')
    && appSource.includes('planned.clips.push')
    && appSource.includes('setCropBox'),
  'gichul/app.js: answers must share the question canonical form and mirror common/selection question parts');

  const css = readFileSync(path.join(ROOT, 'gichul/gichul.css'), 'utf8');
  check(!/box-shadow|backdrop-filter|linear-gradient|radial-gradient/u.test(css),
    'gichul/gichul.css: shadows, blur and gradients are forbidden (DESIGN.md §3·§4)');
  check(appSource.includes('class="list-row-stretch gi-pick-hit"')
    && /\.gi-pick-hit\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*width:\s*auto;/u.test(css),
    'gichul: the row-wide pick label must be an overlay, not a 100%-wide flex item');
}

function validateDesignHeadingSequence() {
  const errors = findDesignHeadingSequenceErrors(
    readFileSync(DESIGN_HEADING_PATH, 'utf8'),
  );
  check(
    errors.length === 0,
    `docs/DESIGN.md: numbered headings must be continuous and nested under their current parent\n${errors.join('\n')}`,
  );
}

function readWebpDimensions(file) {
  const buffer = readFileSync(file);
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const type = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (type === 'VP8X' && size >= 10) {
      return {
        width: 1 + buffer.readUIntLE(start + 4, 3),
        height: 1 + buffer.readUIntLE(start + 7, 3)
      };
    }
    if (type === 'VP8 ' && size >= 10 && buffer[start + 3] === 0x9d && buffer[start + 4] === 0x01 && buffer[start + 5] === 0x2a) {
      return {
        width: buffer.readUInt16LE(start + 6) & 0x3fff,
        height: buffer.readUInt16LE(start + 8) & 0x3fff
      };
    }
    if (type === 'VP8L' && size >= 5 && buffer[start] === 0x2f) {
      const b1 = buffer[start + 1];
      const b2 = buffer[start + 2];
      const b3 = buffer[start + 3];
      const b4 = buffer[start + 4];
      return {
        width: 1 + b1 + ((b2 & 0x3f) << 8),
        height: 1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10)
      };
    }
    offset = start + size + (size % 2);
  }
  return null;
}

function validateWordMasterData() {
  const words = evaluateBrowserData('_learning/wordmaster/words.js', 'WORDMASTER_WORDS');
  check(Array.isArray(words), 'WordMaster: exported data must be an array');
  if (!Array.isArray(words)) return;

  check(words.length === 2_000, `WordMaster: expected 2,000 words, found ${words.length}`);
  check(new Set(words.map((word) => word.id)).size === words.length, 'WordMaster: IDs must be unique');

  // WordMaster content owner: audited stable IDs lock confirmed transcription repairs.
  const auditedSpellings = new Map([
    ['d46-15', 'cuisine'],
    ['d50-15', 'insane'],
  ]);
  for (const [id, spelling] of auditedSpellings) {
    const word = words.find((entry) => entry.id === id);
    check(word?.word === spelling, `WordMaster: ${id} must remain ${spelling}`);
  }

  for (let day = 1; day <= 50; day += 1) {
    const dailyWords = words.filter((word) => word.day === day);
    check(dailyWords.length === 40, `WordMaster: DAY ${day} must contain 40 words`);
    check(
      new Set(dailyWords.map((word) => word.number)).size === 40,
      `WordMaster: DAY ${day} question numbers must be unique`,
    );
  }

  for (const word of words) {
    check(/^d\d{2}-\d{2}$/u.test(word.id), `WordMaster: invalid ID ${word.id}`);
    check(Boolean(word.word && word.meaning), `WordMaster: ${word.id} has empty content`);
  }
}

// ---- smstudy 개념 노트 구조 계약 (plan.md §5) --------------------------------
// 콘텐츠 문자열 하드코딩을 대신하는 검사들이다. 검사 대상 목록(허용 kind, 아이콘 키,
// 길이를 잴 필드)을 여기에 열거하지 않고 전부 단일 원본에서 도출한다 (LESSONS 규칙 5).

// 필드 이름 → 길이 상한 (plan.md §4.1). 표에 없는 문자열은 본문으로 보고 60자를 적용하므로
// 스키마에 필드가 새로 생겨도 검사가 자동으로 따라간다.
const NOTEBOOK_STRING_LIMITS = {
  headline: 30,
  label: 12,
  items: 20,
  title: 20,
  term: 20,
  tags: 24,
  headers: 24,
  rows: 24,
};

// 다이어그램 *안쪽* 문자열 상한. 이 값은 smstudy/assets/js/diagram.js 머리 주석과
// **같은 숫자여야 한다** (review 3c M-2).
// 사이클3 후속에서 완화했다: 조판이 SVG 좌표에서 CSS 그리드로 바뀌어 줄바꿈을 브라우저가
// 하므로, 상한을 정하는 것은 더 이상 "도형 안에 들어가는가"가 아니라 가독성이다.
// label 8 -> 14 (한국어 명사구 한 어절 + 수식어), items 16 -> 28 (한 줄에 담기는 짧은 문장),
// center 8 -> 14 (label과 같은 성격). 예전 값은 SVG 좌표 계산의 부산물이었다.
const DIAGRAM_TEXT_LIMITS = {
  label: 14,
  items: 28,
  center: 14,
  title: 20,
};

// kind별 nodes 개수와 node.items 개수 상·하한 (docs/kice-analysis.md 부록 D).
// kind 목록 자체는 여기서 정하지 않는다 — 아래 derivedDiagramKinds()가 렌더러에서 뽑고,
// 뽑힌 kind에 여기 항목이 없으면 실패시킨다. 즉 레이아웃을 새로 만들면 상·하한을 함께
// 적는 일이 강제된다.
// nodes 개수는 형식의 의미가 정한다(2×2는 넷, 저울은 둘). items 상한은 사이클3 후속에서
// 완화했다 — CSS 조판은 줄이 늘면 컨테이너가 같이 늘어나므로 "그릴 수 있는 줄 수" 제약이
// 사라졌고, 남은 것은 한 칸에 담아 읽을 만한 양이다.
// art: 이 kind가 장식 SVG(.sm-d-art)를 내는가. **venn 하나만 true다** — 원의 겹침은
// 목록으로 옮길 수 없는 정보다. scale의 저울 그림은 두 열 조판이 이미 말하는 대립을
// 반복할 뿐이라 제거했다(사이클3 후속 사용자 피드백).
// 이 값이 있어야 "layoutVenn의 원 그리기를 통째로 지운" 변형이 잡히고, 반대로
// 존재 이유 없는 그림이 슬그머니 되살아나는 것도 잡힌다 (R2-B-2의 후신).
const DIAGRAM_SHAPE_BOUNDS = {
  flow: { nodes: [3, 5], items: [0, 4], art: false },        // 세로 단계 조판 (좌: 기준 / 우: 결과)
  scale: { nodes: [2, 2], items: [0, 6], art: false },       // 대립 2열 (저울 그림 없음)
  matrix2x2: { nodes: [4, 4], items: [0, 6], art: false },   // 2×2 그리드
  venn: { nodes: [2, 3], items: [0, 5], art: true },         // 원 SVG(번호만) + 범례 — 유일한 그림
  timeline: { nodes: [3, 5], items: [0, 4], art: false },    // 그리드 열
  pyramid: { nodes: [3, 5], items: [0, 4], art: false },     // 폭이 줄어드는 가로 막대
  radial: { nodes: [3, 5], items: [0, 4], art: false },      // 중심 제목 + 카드 그리드
};

// 마크업 구조를 세는 선택자.
// - 노드는 kind와 무관하게 data-node를 단 <li> 하나다 (조판이 SVG에서 CSS로 바뀌며 통일됐다).
// - UI 아이콘은 **다이어그램에 하나도 없어야 한다.** 노드마다 붙는 장식을 전부 걷어냈다.
//   콘텐츠 시각화용 .sm-d-svg는 별개이며 LIST_ICON_PATTERN은 .ui-icon만 잠근다.
const NODE_PATTERN = /<li class="sm-d-node[^"]*" data-node>/gu;
const ITEM_PATTERN = /<ul class="sm-d-items">/gu;
const LIST_ICON_PATTERN = /<svg\b[^>]*class="[^"]*\bui-icon\b/gu;
const ART_PATTERN = /<div class="sm-d-art">/gu;
// 조판을 CSS에 넘긴 뒤로 SVG 안에 남는 글자는 벤의 한 글자짜리 번호뿐이다.
// 문장이 다시 SVG로 들어가면(= 좌표 조판이 부활하면) 여기서 잡힌다.
const SVG_TEXT_PATTERN = /<text\b[^>]*>([^<]*)<\/text>/gu;
const countMatches = (markup, pattern) => (markup.match(pattern) || []).length;

// 렌더러가 실제로 읽는 필드의 구조 계약 (B-2). 배열 길이만 세던 검사를 대체한다.
// **이 표는 하드코딩된 "검사 대상 목록"이 아니다** — 아래 derivedRenderedFields()가
// 렌더러 소스에서 읽는 필드를 도출해 이 표와 양방향으로 대조하므로, 렌더러가 새 필드를
// 읽기 시작하거나 읽기를 그만두면 표를 고치기 전까지 게이트가 실패한다 (LESSONS 규칙 5).
//   min/max: 배열 길이. cell: 배열 원소 타입. optional: 값이 없어도 되지만 있으면 타입을 지킨다.
const NOTEBOOK_FIELD_CONTRACT = {
  headline: { type: 'string' },
  summary: { type: 'array', cell: 'string', min: 2, max: 3 },
  keyPoints: { type: 'array', cell: 'object', min: 3, max: 3 },
  'keyPoints[].label': { type: 'string' },
  'keyPoints[].text': { type: 'string' },
  // keyPoints[].icon / deepDive[].icon은 계약에 없다 — 아이콘을 화면에서 걷어내 렌더되지 않는다.
  // 아래 양방향 대조가 "렌더러가 다시 읽으면 계약을 적어라"를 강제한다.
  'exam.trend': { type: 'string' },
  'exam.trap': { type: 'string' },
  'exam.tags': { type: 'array', cell: 'string', min: 1 },
  diagrams: { type: 'array', cell: 'object', min: 1, max: 2 },
  'matrix.title': { type: 'string' },
  'matrix.headers': { type: 'array', cell: 'string', min: 3 },
  'matrix.rows': { type: 'array', cell: 'array', min: 4 },
  decision: { type: 'array', cell: 'string', min: 4, max: 5 },
  deepDive: { type: 'array', cell: 'object', min: 4, max: 5 },
  'deepDive[].term': { type: 'string' },
  'deepDive[].points': { type: 'array', cell: 'string', min: 2, max: 4 },
  recall: { type: 'array', cell: 'object', min: 3, max: 4 },
  'recall[].question': { type: 'string' },
  'recall[].answer': { type: 'string' },
};

// diagram.js가 읽는 필드. 개수 상·하한은 DIAGRAM_SHAPE_BOUNDS가 kind별로 따로 본다.
// why는 계약에서 뺐다 — 화면에 낼 정보가 아니어서 데이터에서도 제거했다.
// 단원별 형식 선택 근거는 docs/kice-analysis.md 부록 D가 소유한다.
const DIAGRAM_FIELD_CONTRACT = {
  kind: { type: 'string' },
  title: { type: 'string' },
  center: { type: 'string', optional: true },
  nodes: { type: 'array', cell: 'object', min: 2, max: 5 },
  'nodes[].label': { type: 'string' },
  'nodes[].items': { type: 'array', cell: 'string', optional: true },
};

// 프로퍼티 경로 도출에서 잘라 낼 JS 내장 멤버. 여기서 끊어야 note.matrix.headers.length가
// 'matrix.headers.length'가 아니라 'matrix.headers'로 잡힌다.
const JS_MEMBERS = new Set([
  'length', 'map', 'filter', 'join', 'some', 'every', 'slice', 'forEach', 'reduce',
  'find', 'findIndex', 'sort', 'includes', 'concat', 'flatMap', 'flat', 'indexOf', 'at',
  'toString', 'push', 'keys', 'values', 'entries', 'split', 'trim', 'replace',
  'startsWith', 'endsWith', 'padStart', 'reverse',
]);

// openIndex가 가리키는 '(' 부터 짝이 맞는 ')' 까지의 본문을 돌려준다.
function balancedSlice(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === '(') depth += 1;
    else if (source[index] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  return source.slice(openIndex + 1);
}

// 렌더러 소스에서 "root 객체의 어떤 필드를 읽는가"를 도출한다.
//   root.a.b       -> 'a.b'
//   root.a.map((x) => x.b)  -> 'a[].b'
function derivedRenderedFields(source, root) {
  const fields = new Set();
  const addChain = (chain) => {
    const clean = [];
    for (const segment of chain.split(/\??\./u).filter(Boolean)) {
      if (JS_MEMBERS.has(segment)) break;
      clean.push(segment);
    }
    if (clean.length > 0) fields.add(clean.join('.'));
  };
  for (const [, chain] of source.matchAll(new RegExp(`\\b${root}((?:\\??\\.[A-Za-z_$][\\w$]*)+)`, 'gu'))) {
    addChain(chain);
  }
  for (const match of source.matchAll(new RegExp(`\\b${root}\\.([A-Za-z_$][\\w$]*)\\.map\\(\\(\\s*([A-Za-z_$][\\w$]*)`, 'gu'))) {
    const open = source.indexOf('(', match.index + `${root}.${match[1]}.map`.length);
    const body = balancedSlice(source, open);
    for (const [, member] of body.matchAll(new RegExp(`\\b${match[2]}\\??\\.([A-Za-z_$][\\w$]*)`, 'gu'))) {
      if (JS_MEMBERS.has(member)) continue;
      fields.add(`${match[1]}[].${member}`);
    }
  }
  return fields;
}

// 계약이 다루는 필드 집합 (부모 경로 포함). 'exam.trend'가 있으면 'exam'도 다뤄진 것으로 본다.
function contractCoverage(contract) {
  const covered = new Set();
  for (const key of Object.keys(contract)) {
    const segments = key.split('.');
    for (let index = 1; index <= segments.length; index += 1) covered.add(segments.slice(0, index).join('.'));
  }
  return covered;
}

// 문자열 리터럴과 템플릿 리터럴의 *텍스트*만 뽑는다 (주석·식별자·${식} 제외).
// ${...} 자리는 한 글자 placeholder로 접는다 — 그 안의 값은 스키마 길이 계약이 따로 잰다.
function extractLiteralText(source) {
  const chunks = [];
  let index = 0;
  const readString = (quote) => {
    let text = '';
    index += 1;
    while (index < source.length && source[index] !== quote) {
      if (source[index] === '\\') { text += source[index + 1] === 'n' ? '\n' : source[index + 1]; index += 2; continue; }
      text += source[index];
      index += 1;
    }
    index += 1;
    chunks.push(text);
  };
  const readTemplate = () => {
    let text = '';
    index += 1;
    while (index < source.length && source[index] !== '`') {
      if (source[index] === '\\') { text += source[index + 1]; index += 2; continue; }
      if (source[index] === '$' && source[index + 1] === '{') {
        let depth = 0;
        while (index < source.length) {
          if (source[index] === '{') depth += 1;
          else if (source[index] === '}') { depth -= 1; if (depth === 0) { index += 1; break; } }
          index += 1;
        }
        text += '§';
        continue;
      }
      text += source[index];
      index += 1;
    }
    index += 1;
    chunks.push(text);
  };
  // 정규식 리터럴을 건너뛴다. /[&<>"']/ 같은 리터럴 안의 따옴표를 문자열 시작으로 오인하면
  // 그 뒤 전체가 어긋나 주석이 문구로 잡힌다. 앞의 유효 토큰으로 나눗셈과 구분한다.
  const readRegExp = () => {
    let inClass = false;
    index += 1;
    while (index < source.length) {
      const char = source[index];
      if (char === '\\') { index += 2; continue; }
      if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      else if (char === '/' && !inClass) { index += 1; break; }
      else if (char === '\n') break;
      index += 1;
    }
    while (index < source.length && /[a-z]/u.test(source[index])) index += 1;
  };
  const REGEXP_PRECEDERS = new Set(['=', '(', '[', '{', ',', ';', ':', '!', '&', '|', '?', '+', '-', '*', '%', '~', '^', '<', '>', '\n']);
  const REGEXP_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await']);
  let lastSignificant = '\n';
  let lastWord = '';
  while (index < source.length) {
    const char = source[index];
    if (char === '/' && source[index + 1] === '/') { while (index < source.length && source[index] !== '\n') index += 1; continue; }
    if (char === '/' && source[index + 1] === '*') { const end = source.indexOf('*/', index + 2); index = end === -1 ? source.length : end + 2; continue; }
    if (char === '"' || char === "'") { readString(char); lastSignificant = char; lastWord = ''; continue; }
    if (char === '`') { readTemplate(); lastSignificant = '`'; lastWord = ''; continue; }
    if (char === '/' && (REGEXP_PRECEDERS.has(lastSignificant) || REGEXP_KEYWORDS.has(lastWord))) { readRegExp(); lastSignificant = '/'; lastWord = ''; continue; }
    if (/\s/u.test(char)) { if (char === '\n') { lastSignificant = '\n'; lastWord = ''; } index += 1; continue; }
    lastWord = /[A-Za-z_$]/u.test(char) ? lastWord + char : '';
    lastSignificant = char;
    index += 1;
  }
  return chunks;
}

// 마크업 조각에서 태그를 걷어내고 화면에 실제로 읽히는 텍스트 런만 남긴다.
function visibleTextRuns(chunk) {
  return chunk
    .replace(/<[^>]*>/gu, '\n')
    .split('\n')
    .map((run) => run.replace(/\s+/gu, ' ').trim())
    .filter((run) => /[가-힣]/u.test(run));
}

// 허용 kind는 렌더러의 레이아웃 함수 이름에서 뽑는다. LAYOUTS 등록부와 교차 대조해
// "함수는 있는데 등록이 안 된" 또는 그 반대의 상태를 잡는다.
function derivedDiagramKinds() {
  const source = readSource(DIAGRAM_SOURCE);
  const kinds = new Set(
    [...source.matchAll(/function layout([A-Z][\w$]*)\s*\(/gu)]
      .map(([, name]) => name[0].toLowerCase() + name.slice(1)),
  );
  const layoutBlock = /const LAYOUTS = \{([^}]*)\}/su.exec(source);
  const registered = new Set(
    [...(layoutBlock?.[1] ?? '').matchAll(/^\s*([\w$]+)\s*:/gmu)].map(([, name]) => name),
  );
  return { kinds, registered, source };
}

// 스키마를 재귀 순회하며 모든 문자열에 방문자를 적용한다 (검사할 필드를 열거하지 않는다).
function walkNotebookStrings(node, location, key, visit) {
  if (typeof node === 'string') {
    visit(node, location, key);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => walkNotebookStrings(item, `${location}[${index}]`, key, visit));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [childKey, value] of Object.entries(node)) {
      walkNotebookStrings(value, `${location}.${childKey}`, childKey, visit);
    }
  }
}

// 실제 데이터가 들고 있는 필드 경로를 모은다 ('keyPoints[].icon' 같은 형태).
// 계약 표와 대조해 "데이터에는 있는데 아무도 안 읽는" 죽은 필드를 잡는다.
function collectDataFields(node, prefix, into, stopAt) {
  if (Array.isArray(node)) {
    for (const item of node) collectDataFields(item, `${prefix}[]`, into, stopAt);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    into.add(path);
    if (!stopAt.has(key) && value && typeof value === 'object') collectDataFields(value, path, into, stopAt);
  }
}

// 계약 키('keyPoints[].label')를 실제 값들로 펼친다.
function resolveContractTargets(root, key, location) {
  let nodes = [[root, location]];
  for (const segment of key.split('.')) {
    const isArray = segment.endsWith('[]');
    const name = isArray ? segment.slice(0, -2) : segment;
    const next = [];
    for (const [value, where] of nodes) {
      const child = value === null || value === undefined ? undefined : value[name];
      if (!isArray) { next.push([child, `${where}.${name}`]); continue; }
      if (!Array.isArray(child)) { next.push([undefined, `${where}.${name}[]`]); continue; }
      child.forEach((item, index) => next.push([item, `${where}.${name}[${index}]`]));
    }
    nodes = next;
  }
  return nodes;
}

function applyFieldRule(value, rule, where) {
  if (value === undefined || value === null) {
    check(Boolean(rule.optional), `smstudy: ${where} is read by the renderer but missing (render contract)`);
    return;
  }
  if (rule.type === 'string') {
    const ok = typeof value === 'string' && value.trim().length > 0;
    check(ok, `smstudy: ${where} must be a non-empty string (render contract)`);
    return;
  }
  check(Array.isArray(value), `smstudy: ${where} must be an array (render contract)`);
  if (!Array.isArray(value)) return;
  if (rule.min !== undefined) check(value.length >= rule.min, `smstudy: ${where} must hold at least ${rule.min} entries, found ${value.length}`);
  if (rule.max !== undefined) check(value.length <= rule.max, `smstudy: ${where} must hold at most ${rule.max} entries, found ${value.length}`);
  value.forEach((item, index) => {
    if (rule.cell === 'string') check(typeof item === 'string' && item.trim().length > 0, `smstudy: ${where}[${index}] must be a non-empty string`);
    else if (rule.cell === 'array') check(Array.isArray(item), `smstudy: ${where}[${index}] must be an array`);
    else if (rule.cell === 'object') check(Boolean(item) && typeof item === 'object' && !Array.isArray(item), `smstudy: ${where}[${index}] must be an object`);
  });
}

function enforceContract(contract, root, location) {
  for (const [key, rule] of Object.entries(contract)) {
    for (const [value, where] of resolveContractTargets(root, key, location)) applyFieldRule(value, rule, where);
  }
}

// 화면에 그대로 나가는 렌더러 고정 문구도 R1(한 문장 60자)을 지켜야 한다.
// 데이터 순회만으로는 app.js·diagram.js의 문구가 검사 밖에 남는다 (review B-1).
function validateRenderedCopy() {
  for (const file of [APP_SOURCE, DIAGRAM_SOURCE]) {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    let sentences = 0;
    for (const chunk of extractLiteralText(source)) {
      for (const run of visibleTextRuns(chunk)) {
        for (const sentence of run.split(/(?<=[.!?])\s+/u)) {
          const text = sentence.trim();
          if (!/[가-힣]/u.test(text)) continue;
          sentences += 1;
          const length = [...text].length;
          check(length <= 60, `${file}: rendered copy is ${length} characters, over the 60 limit — "${text}"`);
        }
      }
    }
    // 도출이 조용히 깨지면 이 검사가 통째로 무력해진다. 기대치는 파일에서 직접 뽑는다 —
    // 주석이 아닌 줄 중 한글이 있는 줄 수의 절반은 문구로 잡혀야 한다 (하드코딩 금지, LESSONS 5).
    const hangulCodeLines = source.split('\n')
      .filter((line) => /[가-힣]/u.test(line) && !/^\s*(?:\/\/|\*|\/\*)/u.test(line)).length;
    check(sentences >= Math.floor(hangulCodeLines / 2),
      `${file}: rendered-copy scan looks truncated (found ${sentences} sentences for ${hangulCodeLines} Korean code lines) — extractLiteralText may be broken`);
  }
}

function validateSmStudyData() {
  const data = evaluateBrowserData('_learning/smstudy/data.js', 'SMSTUDY_DATA');
  const notebookData = evaluateBrowserData('_learning/smstudy/notebook-data.js', 'SMSTUDY_NOTEBOOK');
  const explanationData = evaluateBrowserData('_learning/smstudy/explanation-data.js', 'SMSTUDY_EXPLANATIONS');
  check(Boolean(data), 'smstudy: SMSTUDY_DATA export is missing');
  check(Boolean(notebookData), 'smstudy: SMSTUDY_NOTEBOOK export is missing');
  check(Boolean(explanationData), 'smstudy: SMSTUDY_EXPLANATIONS export is missing');
  if (!data || !notebookData || !explanationData) return;

  const subunits = data.UNITS.flatMap((unit) => unit.subs);
  const subunitIds = new Set(subunits.map((subunit) => subunit.id));
  const questionIds = new Set(data.QUESTIONS.map((question) => question.id));
  check(data.UNITS.length === 5, `smstudy: expected 5 units, found ${data.UNITS.length}`);
  check(subunits.length === 17, `smstudy: expected 17 subunits, found ${subunits.length}`);
  check(subunitIds.size === subunits.length, 'smstudy: subunit IDs must be unique');
  check(data.QUESTION_ROWS.length === 78, `smstudy: expected 78 questions, found ${data.QUESTION_ROWS.length}`);
  check(data.PRACTICE_ROWS.length === 20, `smstudy: expected 20 concept practice questions, found ${data.PRACTICE_ROWS.length}`);
  check(data.QUESTIONS.length === 98, `smstudy: expected 98 total questions, found ${data.QUESTIONS.length}`);
  check(questionIds.size === data.QUESTIONS.length, 'smstudy: question IDs must be unique');
  check(data.CHOICE_MARKS.join('') === '12345', 'smstudy: answer choices must use plain 1-5 labels');
  const notebookIds = Object.keys(notebookData.NOTEBOOKS || {});
  check(notebookIds.length === 17, `smstudy: expected 17 concept notebooks, found ${notebookIds.length}`);
  check(notebookData.LEARNING_DESIGN?.steps?.length === 4, 'smstudy: learning design must contain four study steps');
  check(notebookData.LEARNING_DESIGN?.evidence?.length >= 3, 'smstudy: learning design evidence is incomplete');

  // ---- 구조 계약 (plan.md §5) : 콘텐츠 문자열 하드코딩 검사를 대체한다 ----
  const { kinds: diagramKinds, registered: registeredKinds, source: diagramSource } = derivedDiagramKinds();

  // 도출이 조용히 깨지면 아래 계약이 통째로 무력해지므로 도출 결과 자체를 먼저 검사한다.
  check(diagramKinds.size >= 4, `smstudy: diagram kind derivation looks broken (parsed ${diagramKinds.size} layout functions in ${DIAGRAM_SOURCE})`);
  for (const kind of diagramKinds) {
    check(registeredKinds.has(kind), `smstudy: ${DIAGRAM_SOURCE} defines layout ${kind} but never registers it in LAYOUTS`);
    check(Array.isArray(DIAGRAM_SHAPE_BOUNDS[kind]?.nodes) && Array.isArray(DIAGRAM_SHAPE_BOUNDS[kind]?.items),
      `smstudy: diagram kind ${kind} has no node/item bound — add it to DIAGRAM_SHAPE_BOUNDS in scripts/validate.mjs`);
    check(typeof DIAGRAM_SHAPE_BOUNDS[kind]?.art === 'boolean',
      `smstudy: diagram kind ${kind} does not declare art — say whether it draws a decorative SVG in DIAGRAM_SHAPE_BOUNDS`);
  }
  for (const kind of registeredKinds) {
    check(diagramKinds.has(kind), `smstudy: LAYOUTS registers ${kind} but ${DIAGRAM_SOURCE} has no layout${kind[0].toUpperCase()}${kind.slice(1)} function`);
  }

  // 다이어그램은 콘텐츠 시각화만 낸다. UI 아이콘은 app.js가 공통 스프라이트에서 직접 소비한다.
  const probeRenderer = evaluateDiagramRenderer();
  check(typeof probeRenderer?.renderDiagram === 'function',
    `smstudy: ${DIAGRAM_SOURCE} must publish renderDiagram on window.SMSTUDY_DIAGRAM`);
  // kind 하나(radial)만 보면 다른 레이아웃이 통째로 비어도 초록이다
  // (R2-B-2: layoutFlow()의 아이콘 한 줄을 지운 변형이 통과했다).
  // 그래서 **도출된 kind 전부**를 렌더해 데이터의 노드·항목·아이콘 개수와 출력 개수를 맞춰 본다.
  // 조판이 SVG 좌표에서 CSS 그리드로 바뀌었으므로 "캔버스가 무엇을 그렸는가" 대신
  // **"출력 요소 수 = 데이터 노드 수"** 라는 구조 검사를 쓴다. kind 목록은 여기서 정하지 않는다.
  if (typeof probeRenderer?.renderDiagram === 'function') {
    for (const kind of diagramKinds) {
      const bounds = DIAGRAM_SHAPE_BOUNDS[kind];
      if (!bounds) continue;
      const nodeCount = bounds.nodes[1];
      const itemCount = bounds.items[1];
      const probeDiagram = {
        kind, title: '게이트 탐침', center: '탐침',
        nodes: Array.from({ length: nodeCount }, (item, index) => ({
          label: `갈래${index + 1}`,
          items: Array.from({ length: itemCount }, (cell, cellIndex) => `항목${cellIndex + 1}`),
        })),
      };
      const markup = probeRenderer.renderDiagram(probeDiagram);
      const kindLabel = `layout${kind[0].toUpperCase()}${kind.slice(1)}()`;
      const nodes = countMatches(markup, NODE_PATTERN);
      const itemLists = countMatches(markup, ITEM_PATTERN);
      const listIcons = countMatches(markup, LIST_ICON_PATTERN);
      const arts = countMatches(markup, ART_PATTERN);
      check(nodes === nodeCount,
        `smstudy: ${DIAGRAM_SOURCE} ${kindLabel} emitted ${nodes} node cells for ${nodeCount} data nodes — the layout dropped nodes`);
      check(itemLists === nodeCount,
        `smstudy: ${DIAGRAM_SOURCE} ${kindLabel} emitted ${itemLists} item lists for ${nodeCount} nodes carrying items — the layout dropped node.items`);
      // 항목 텍스트가 실제로 마크업에 도달하는지도 본다 (<ul>만 남기고 <li>를 비운 변형 차단).
      for (let index = 1; index <= itemCount; index += 1) {
        check(markup.split(`<li>항목${index}</li>`).length - 1 === nodeCount,
          `smstudy: ${DIAGRAM_SOURCE} ${kindLabel} did not render item ${index} of every node`);
      }
      // 다이어그램에는 UI 아이콘이 하나도 나오면 안 된다.
      check(listIcons === 0,
        `smstudy: ${DIAGRAM_SOURCE} ${kindLabel} emitted ${listIcons} icons — diagram layouts must render no icons (DESIGN.md §4)`);
      check(arts === (bounds.art ? 1 : 0),
        `smstudy: ${DIAGRAM_SOURCE} ${kindLabel} emitted ${arts} decorative SVG blocks but DIAGRAM_SHAPE_BOUNDS declares art: ${bounds.art}`);
      // 겹침의 근원이던 "SVG 안 문장"이 되살아나지 않는지 본다 — 한 글자짜리 표지만 허용한다.
      for (const [, text] of markup.matchAll(SVG_TEXT_PATTERN)) {
        check([...text].length <= 1,
          `smstudy: ${DIAGRAM_SOURCE} ${kindLabel} put "${text}" inside the SVG — labels belong in the CSS layout, not in hand-placed <text>`);
      }
    }
  }
  const liveRenderer = probeRenderer;

  // ---- B-2 / R2-B-1. 계약표가 렌더러보다 뒤처지지 않게 양방향으로 대조한다 (LESSONS 규칙 5) ----
  // 라운드 1은 필드 이름을 **소스 정규식**으로 긁었다. 그 방식은 표현에 취약해서
  // `const alias = note` 뒤 `alias.gateGhost`를 화면에 추가한 변형이 그대로 통과했다 (R2-B-1).
  // 그래서 접근을 뒤집는다 — 렌더러를 **실제 데이터로 실행**하고, 데이터를 Proxy로 감싸
  // 렌더 중 읽힌 키를 런타임에 모은다. 어떤 별칭·구조분해를 거치든 get 트랩은 반드시 지난다.
  // 정규식 도출은 버리지 않고 **보조**로 합집합에 넣는다 (여기서 실행되지 않는 경로를 덮는다).
  const smstudyJsSource = readSource(APP_SOURCE);
  const notebookCoverage = contractCoverage(NOTEBOOK_FIELD_CONTRACT);
  const diagramCoverage = contractCoverage(DIAGRAM_FIELD_CONTRACT);

  const runtimeNotebookFields = new Set();
  // diagrams 아래는 diagram.js의 계약이 따로 보므로 여기서는 더 내려가지 않는다.
  const sandbox = createAppSandbox({ trackNoteFields: runtimeNotebookFields, stopAt: new Set(['diagrams']) });
  let conceptMarkup = '';
  for (const id of sandbox.notebookIds) {
    const markup = sandbox.renderConcept(id);
    check(markup.length > 5000, `smstudy: renderConcept('${id}') produced ${markup.length} characters — the concept screen did not render`);
    conceptMarkup += markup;
  }
  // 이름을 몰라도 누락이 잡히는 출력 검사. 계약에 없는 필드를 화면에 새로 끼우면
  // 값이 없어 undefined·null이 그대로 텍스트로 나가거나 빈 슬롯이 남는다.
  const undefinedSlot = /\bundefined\b|\bnull\b|\bNaN\b/u.exec(conceptMarkup);
  check(!undefinedSlot, `smstudy: rendered concept markup contains "${undefinedSlot?.[0]}" — a template reads a field the data does not carry`);
  const emptySlot = /<(strong|p|li|h1|h2|h3|h4|td|th|dd|dt|summary|figcaption)\b[^>]*>\s*<\/\1>/u.exec(conceptMarkup);
  check(!emptySlot, `smstudy: rendered concept markup holds an empty <${emptySlot?.[1]}> slot — a template renders a field with no value`);

  const runtimeDiagramFields = new Set();
  for (const notebook of Object.values(notebookData.NOTEBOOKS || {})) {
    for (const diagram of notebook.diagrams || []) liveRenderer.renderDiagram(trackReads(diagram, runtimeDiagramFields));
  }

  const renderedNotebookFields = new Set([
    ...runtimeNotebookFields,
    ...derivedRenderedFields(smstudyJsSource, 'note'),
  ]);
  const renderedDiagramFields = new Set([
    ...runtimeDiagramFields,
    ...derivedRenderedFields(diagramSource, 'diagram'),
    ...[...diagramSource.matchAll(/\bnode\??\.([A-Za-z_$][\w$]*)/gu)]
      .map(([, member]) => member).filter((member) => !JS_MEMBERS.has(member)).map((member) => `nodes[].${member}`),
  ]);
  check(runtimeNotebookFields.size >= 15,
    `smstudy: runtime notebook field collection looks broken (observed ${runtimeNotebookFields.size} reads while rendering ${sandbox.notebookIds.length} concept screens)`);
  check(runtimeDiagramFields.size >= 6,
    `smstudy: runtime diagram field collection looks broken (observed ${runtimeDiagramFields.size} reads)`);
  check(renderedNotebookFields.size >= 15,
    `smstudy: notebook field derivation looks broken (parsed ${renderedNotebookFields.size} fields from ${APP_SOURCE})`);
  check(renderedDiagramFields.size >= 6,
    `smstudy: diagram field derivation looks broken (parsed ${renderedDiagramFields.size} fields from ${DIAGRAM_SOURCE})`);
  for (const field of renderedNotebookFields) {
    check(notebookCoverage.has(field),
      `smstudy: ${APP_SOURCE} renders note.${field} but NOTEBOOK_FIELD_CONTRACT in scripts/validate.mjs does not declare it`);
  }
  for (const field of Object.keys(NOTEBOOK_FIELD_CONTRACT)) {
    check(renderedNotebookFields.has(field),
      `smstudy: NOTEBOOK_FIELD_CONTRACT declares ${field} but ${APP_SOURCE} never reads it — drop the contract entry or the field is dead`);
  }
  for (const field of renderedDiagramFields) {
    check(diagramCoverage.has(field),
      `smstudy: ${DIAGRAM_SOURCE} renders diagram.${field} but DIAGRAM_FIELD_CONTRACT in scripts/validate.mjs does not declare it`);
  }
  for (const field of Object.keys(DIAGRAM_FIELD_CONTRACT)) {
    check(renderedDiagramFields.has(field),
      `smstudy: DIAGRAM_FIELD_CONTRACT declares ${field} but ${DIAGRAM_SOURCE} never reads it — drop the contract entry or the field is dead`);
  }

  // 문자열 계약 — 길이 상한 / 1문장 / 평문. 스키마를 재귀 순회해 전 문자열에 적용한다.
  // 아이콘 키 정합도 같은 순회에서 본다 (icon 값이 곧 문자열이므로 별도 목록이 필요 없다).
  // 순회 대상은 노트뿐 아니라 **화면에 실제로 렌더되는 data.js의 개념 섹션·시각 가이드**까지다
  // (review B-1: NOTEBOOKS·LEARNING_DESIGN만 보던 순회가 60자 초과 본문을 통과시켰다).
  let visitedStrings = 0;
  let visitedIcons = 0;
  let visitedHrefs = 0;
  const inspectString = (value, location, key) => {
    if (key === 'href') {
      // href는 esc()가 아니라 URL 형식으로 잠근다. 건너뛰면 속성 삽입 지점이 계약 사각지대가 된다.
      visitedHrefs += 1;
      check(/^https:\/\/[\w.-]+(?:\/[\w\-./~%+=&?#:@!$'()*,;]*)?$/u.test(value),
        `smstudy: ${location} must be a plain https URL without quotes, spaces or angle brackets — "${value}"`);
      return;
    }
    if (key === 'icon') {
      // 아이콘은 이제 데이터가 아니라 렌더러가 고정한다 (app.js의 두 콜아웃뿐).
      // 콘텐츠 데이터에 icon 키가 되살아나면 실패시킨다.
      visitedIcons += 1;
      check(false, `smstudy: ${location} carries an icon key "${value}" — icons are chosen by the renderer, not by content data`);
      return;
    }
    visitedStrings += 1;
    // 다이어그램 안쪽 문자열은 SVG 좌표가 걸려 있어 더 좁은 상한을 쓴다 (M-2).
    const inDiagram = location.includes('.diagrams[');
    const limit = (inDiagram ? DIAGRAM_TEXT_LIMITS[key] : undefined) ?? NOTEBOOK_STRING_LIMITS[key] ?? 60;
    const length = [...value].length;
    check(length <= limit, `smstudy: ${location} is ${length} characters, over the ${limit} limit — "${value}"`);
    check((value.match(/[.!?]/gu) || []).length <= 1, `smstudy: ${location} must be a single sentence — "${value}"`);
    check(!/[<>\r\n]/u.test(value), `smstudy: ${location} must be plain text without angle brackets or line breaks — "${value}"`);
  };
  walkNotebookStrings(notebookData.NOTEBOOKS, 'NOTEBOOKS', '', inspectString);
  walkNotebookStrings(notebookData.LEARNING_DESIGN, 'LEARNING_DESIGN', '', inspectString);
  for (const subunit of subunits) {
    walkNotebookStrings(subunit.sections, `UNITS.${subunit.id}.sections`, 'sections', inspectString);
    walkNotebookStrings(subunit.visual, `VISUAL_GUIDES.${subunit.id}`, 'visual', inspectString);
    walkNotebookStrings(subunit.keywords, `UNITS.${subunit.id}.keywords`, 'keywords', inspectString);
  }
  // explanationData.GUIDES는 이 순회에 넣지 않는다 — 오답 해설은 개념 파트가 아니라
  // 퀴즈 피드백이고, R1의 "한 문장 60자"는 개념 파트 본문에 건 계약이다 (plan.md §1).
  check(visitedStrings >= 800, `smstudy: notebook string walk looks truncated (visited ${visitedStrings} strings)`);
  check(visitedIcons === 0, `smstudy: notebook data still carries ${visitedIcons} icon keys — icons belong to the renderer, not the content`);
  check(visitedHrefs >= 3, `smstudy: href walk looks truncated (visited ${visitedHrefs} URLs)`);
  // 속성 보간 지점 — URL을 이스케이프 없이 속성에 넣으면 값이 깨질 때 뒤 마크업까지 깨진다.
  for (const [attribute, expression] of smstudyJsSource.matchAll(/\s(?:href|src)="\$\{([^}]+)\}/gu)) {
    check(expression.trim().startsWith('esc('),
      `smstudy: URL attribute interpolation must be escaped — found ${attribute.trim()} in ${APP_SOURCE}`);
  }

  // 형식 다양성 하한(최소 4종)은 **제거했다.** 그 게이트는 "형식을 채우기 위해 형식을 쓰는"
  // 압력을 만들었고, 존재 이유 없는 장식(저울 그림)이 그렇게 들어왔다. 형식은 내용이 고르며,
  // 그 근거는 docs/kice-analysis.md 부록 D가 단원별로 기록한다. 게이트가 재는 것은
  // "쓴 형식이 렌더러에 존재하는가"뿐이다 (아래 단원별 kind 검사).

  for (const subunit of subunits) {
    const questions = data.QUESTIONS.filter((question) => question.sub === subunit.id);
    const notebook = notebookData.NOTEBOOKS?.[subunit.id];
    const explanation = explanationData.GUIDES?.[subunit.id];
    // 3a에서 sub 오분류 5건을 정정해 단원별 문항 수가 2~10으로 갈라졌다 (kice-analysis.md §3).
    // 총합 78은 위에서 따로 검사하므로 여기서는 "빈 단원이 없다"만 본다.
    check(questions.length >= 1, `smstudy: ${subunit.id} must contain at least one question`);
    check(subunit.sections.length > 0, `smstudy: ${subunit.id} has no concept sections`);
    check(Boolean(subunit.visual?.question), `smstudy: ${subunit.id} has no visual-guide question`);
    check(subunit.visual?.flow?.length === 3, `smstudy: ${subunit.id} visual guide must contain 3 flow steps`);
    check(subunit.visual?.checks?.length === 3, `smstudy: ${subunit.id} visual guide must contain 3 checks`);
    // ---- B-2. 렌더 필수 필드의 존재·타입·개수를 계약표로 검사한다 ----
    // (배열 길이만 세던 이전 검사는 matrix.title / deepDive[].term·icon / recall[].answer를
    //  통째로 지워도 초록이었다.)
    enforceContract(NOTEBOOK_FIELD_CONTRACT, notebook || {}, subunit.id);
    check(notebook?.matrix?.rows?.every((row) => Array.isArray(row) && row.length === notebook.matrix.headers.length),
      `smstudy: ${subunit.id} comparison matrix row width mismatch`);
    // 수기 count가 자동 집계로 대체됐으므로 옛 필드가 되살아나면 실패시킨다 (plan.md §4.1).
    check(!('oneLine' in (notebook || {})) && !('examInsight' in (notebook || {})) && !('patterns' in (notebook || {})),
      `smstudy: ${subunit.id} still carries a removed field (oneLine / examInsight / patterns)`);
    // 렌더되지 않는 필드가 데이터에 남는 것도 막는다 — D-3의 keyPoints[].icon이 이 사례였다.
    const notebookFields = new Set();
    collectDataFields(notebook || {}, '', notebookFields, new Set(['diagrams']));
    for (const field of notebookFields) {
      check(notebookCoverage.has(field),
        `smstudy: NOTEBOOKS.${subunit.id}.${field} is not read by any renderer — remove it or declare it in NOTEBOOK_FIELD_CONTRACT`);
    }
    // 다이어그램 형태 — kind 허용 집합, nodes/items 개수 상·하한, 렌더 필수 필드 (plan.md §5, M-2).
    (notebook?.diagrams || []).forEach((diagram, index) => {
      const where = `${subunit.id}.diagrams[${index}]`;
      check(diagramKinds.has(diagram.kind), `smstudy: ${where} uses kind "${diagram.kind}" but ${DIAGRAM_SOURCE} has no layout for it`);
      enforceContract(DIAGRAM_FIELD_CONTRACT, diagram, where);
      const bounds = DIAGRAM_SHAPE_BOUNDS[diagram.kind];
      const nodeCount = Array.isArray(diagram.nodes) ? diagram.nodes.length : 0;
      check(Boolean(bounds) && nodeCount >= bounds.nodes[0] && nodeCount <= bounds.nodes[1],
        `smstudy: ${where} (${diagram.kind}) must hold ${bounds ? `${bounds.nodes[0]}-${bounds.nodes[1]}` : '?'} nodes, found ${nodeCount}`);
      (diagram.nodes || []).forEach((node, nodeIndex) => {
        const itemCount = Array.isArray(node.items) ? node.items.length : 0;
        check(Boolean(bounds) && itemCount >= bounds.items[0] && itemCount <= bounds.items[1],
          `smstudy: ${where}.nodes[${nodeIndex}] (${diagram.kind}) must hold ${bounds ? `${bounds.items[0]}-${bounds.items[1]}` : '?'} items, found ${itemCount} — the SVG layout has no room for more`);
      });
      check(diagram.kind !== 'radial' || Boolean(diagram.center), `smstudy: ${where} is radial and must carry a center label`);
      const diagramFields = new Set();
      collectDataFields(diagram, '', diagramFields, new Set());
      for (const field of diagramFields) {
        check(diagramCoverage.has(field),
          `smstudy: ${where}.${field} is not read by ${DIAGRAM_SOURCE} — remove it or declare it in DIAGRAM_FIELD_CONTRACT`);
      }
      // 렌더러를 실제로 돌려 마크업까지 확인한다 (아이콘 도달 + figure 콘텐츠 모델).
      if (typeof liveRenderer?.renderDiagram === 'function') {
        const markup = liveRenderer.renderDiagram(diagram);
        check(countMatches(markup, LIST_ICON_PATTERN) === 0,
          `smstudy: ${where} renders ${countMatches(markup, LIST_ICON_PATTERN)} icons — diagrams carry no icons (DESIGN.md §4)`);
        // 형식 이름표 칩과 '왜 이 형식인가' 문장은 화면에서 걷어냈다. 되살아나면 실패시킨다.
        check(!/<span class="badge">/u.test(markup),
          `smstudy: ${where} renders a kind-label chip — the format name is not learner-facing`);
        check(!/이 형식으로 그렸다/u.test(markup),
          `smstudy: ${where} renders the planning note "why" — that belongs in docs/kice-analysis.md 부록 D`);
        // 출력 노드 수 = 데이터 노드 수. matrix2x2·venn·scale은 렌더러가 앞에서 잘라 쓰므로
        // 데이터 개수 상한(DIAGRAM_SHAPE_BOUNDS.nodes[1])까지만 기대한다.
        const drawnNodes = Math.min(nodeCount, DIAGRAM_SHAPE_BOUNDS[diagram.kind]?.nodes[1] ?? nodeCount);
        check(countMatches(markup, NODE_PATTERN) === drawnNodes,
          `smstudy: ${where} emits ${countMatches(markup, NODE_PATTERN)} node cells for ${drawnNodes} nodes`);
        for (const [, text] of markup.matchAll(SVG_TEXT_PATTERN)) {
          check([...text].length <= 1,
            `smstudy: ${where} put "${text}" inside the SVG — labels belong in the CSS layout, not in hand-placed <text>`);
        }
        check((markup.match(/<figcaption\b/gu) || []).length === 1,
          `smstudy: ${where} must render exactly one <figcaption> — a <figure> may hold only one caption (HTML content model)`);
      }
    });
    check(Boolean(explanation?.focus && explanation?.correctReason && explanation?.wrongReason), `smstudy: ${subunit.id} explanation guide is incomplete`);
    check(explanation?.checks?.length === 3, `smstudy: ${subunit.id} explanation guide must contain three checks`);
  }

  for (const notebookId of notebookIds) check(subunitIds.has(notebookId), `smstudy: notebook ${notebookId} references unknown subunit`);
  // 콘텐츠 문자열 하드코딩 검사는 전부 구조 계약으로 대체했다 (plan.md R7, review M-7).
  // 기준선 2c49cb5에 있던 7건(NOTEBOOKS 5건 + explanation-data 2건)이 모두 사라졌다.
  check(Object.keys(explanationData.GUIDES || {}).length === 17, 'smstudy: expected 17 explanation guides');
  check(Boolean(explanationData.EBS_PAST_EXAMS?.startsWith('https://www.ebsi.co.kr/')), 'smstudy: EBS explanation source link is missing');

  // 태그 양방향 정합 — 문항의 태그는 전부 그 단원의 exam.tags 안에 있어야 하고,
  // 역으로 exam.tags는 전부 최소 1문항에 쓰여야 한다 (죽은 태그 금지, plan.md §5).
  const tagUsage = new Set();
  for (const question of data.QUESTIONS) {
    const declared = notebookData.NOTEBOOKS?.[question.sub]?.exam?.tags || [];
    check(Array.isArray(question.tags) && question.tags.length >= 1 && question.tags.length <= 3,
      `smstudy: ${question.id} must carry 1-3 concept tags`);
    for (const tag of question.tags || []) {
      check(declared.includes(tag), `smstudy: ${question.id} tag "${tag}" is not declared in NOTEBOOKS.${question.sub}.exam.tags`);
      tagUsage.add(`${question.sub}|${tag}`);
    }
  }
  for (const [notebookId, notebook] of Object.entries(notebookData.NOTEBOOKS || {})) {
    for (const tag of notebook.exam?.tags || []) {
      check(tagUsage.has(`${notebookId}|${tag}`), `smstudy: NOTEBOOKS.${notebookId}.exam.tags "${tag}" is never used by any question (dead tag)`);
    }
  }

  const referencedImages = new Set();
  for (const question of data.QUESTION_ROWS) {
    const source = data.KICE_SOURCES[`${question.year}|${question.session}`];
    check(subunitIds.has(question.sub), `smstudy: ${question.id} references unknown subunit ${question.sub}`);
    check(Number.isInteger(question.answerNumber) && question.answerNumber >= 1 && question.answerNumber <= 5, `smstudy: ${question.id} has invalid answer`);
    check(question.correctRate + question.wrongRate === 100, `smstudy: ${question.id} rates must total 100`);
    check(Boolean(source?.question && source?.answer), `smstudy: ${question.id} source links are missing`);
    const imagePath = path.join(ROOT, '_learning/smstudy/kice', path.basename(question.image));
    check(existsSync(imagePath), `smstudy: ${question.id} image is missing`);
    if (existsSync(imagePath)) {
      const dimensions = readWebpDimensions(imagePath);
      check(Boolean(dimensions), `smstudy: ${question.id} is not a readable WebP image`);
      check(dimensions?.width >= 700, `smstudy: ${question.id} image is too narrow to preserve the printed question`);
      // A shorter crop previously left "위 연구" visible but omitted its shared passage.
      check(dimensions?.height >= 500, `smstudy: ${question.id} image may omit its stem, passage or choices`);
    }
    referencedImages.add(path.basename(question.image));
  }

  for (const question of data.PRACTICE_ROWS) {
    check(subunitIds.has(question.sub), `smstudy: ${question.id} references unknown subunit ${question.sub}`);
    check(Array.isArray(question.choices) && question.choices.length === 5, `smstudy: ${question.id} must have five choices`);
    check(Number.isInteger(question.answerNumber) && question.answerNumber >= 1 && question.answerNumber <= 5, `smstudy: ${question.id} has invalid answer`);
    check(typeof question.stem === 'string' && question.stem.length >= 10, `smstudy: ${question.id} stem is incomplete`);
  }

  const imageDirectory = path.join(ROOT, '_learning/smstudy/kice');
  const imageFiles = readdirSync(imageDirectory).filter((file) => file.endsWith('.webp'));
  check(imageFiles.length === 78, `smstudy: expected 78 WebP images, found ${imageFiles.length}`);
  check(imageFiles.every((file) => referencedImages.has(file)), 'smstudy: unreferenced WebP images exist');
}

function validatePlStudyData() {
  const data = evaluateBrowserData('_learning/plstudy/data.js', 'PLSTUDY_DATA');
  check(Boolean(data), 'plstudy: PLSTUDY_DATA export is missing');
  if (!data) return;
  const subunits = data.UNITS?.flatMap((unit) => unit.subs || []) || [];
  const subunitIds = new Set(subunits.map((subunit) => subunit.id));
  check(data.UNITS?.length === 6, `plstudy: expected 6 units, found ${data.UNITS?.length || 0}`);
  check(subunits.length === 18, `plstudy: expected 18 subunits, found ${subunits.length}`);
  check(subunitIds.size === 18, 'plstudy: subunit IDs must be unique');
  check(data.QUESTIONS?.length === 90, `plstudy: expected 90 questions, found ${data.QUESTIONS?.length || 0}`);
  const plstudyHtml = readFileSync(path.join(ROOT, 'plstudy/index.html'), 'utf8');
  const sidebarUnitTitles = [...plstudyHtml.matchAll(/<a\b[^>]*\bhref="#pl-unit-[^"]+"[^>]*>[\s\S]*?<\/span>([^<]+)<\/a>/gu)]
    .map(([, title]) => title.trim());
  check(JSON.stringify(sidebarUnitTitles) === JSON.stringify(data.UNITS.map((unit) => unit.title)),
    'plstudy: sidebar unit titles must exactly match PLSTUDY_DATA.UNITS titles');
  const questionIds = new Set();
  const coverage = new Map([...subunitIds].map((id) => [id, 0]));
  for (const question of data.QUESTIONS || []) {
    check(typeof question.id === 'string' && !questionIds.has(question.id), `plstudy: duplicate or empty question id ${question.id}`);
    questionIds.add(question.id);
    check(subunitIds.has(question.sub), `plstudy: ${question.id} points to unknown subunit ${question.sub}`);
    if (coverage.has(question.sub)) coverage.set(question.sub, coverage.get(question.sub) + 1);
    check(typeof question.prompt === 'string' && question.prompt.trim().length >= 8, `plstudy: ${question.id} prompt is incomplete`);
    check(Array.isArray(question.choices) && question.choices.length === 5, `plstudy: ${question.id} must have five choices`);
    check(new Set(question.choices || []).size === 5, `plstudy: ${question.id} choices must be distinct`);
    check(Number.isInteger(question.answer) && question.answer >= 0 && question.answer < 5, `plstudy: ${question.id} answer index is invalid`);
    check(typeof question.explanation === 'string' && question.explanation.trim().length >= 12, `plstudy: ${question.id} explanation is incomplete`);
  }
  for (const [subunit, count] of coverage) check(count === 5, `plstudy: ${subunit} must have exactly five questions, found ${count}`);
}

// CSS를 중괄호 깊이로 훑어 커스텀 프로퍼티 *정의*를 셀렉터·at-rule 맥락과 함께 모은다.
// 이전의 stripPrint 정규식(/@media print\s*\{[\s\S]*?\n\}/)은 닫는 중괄호가 0열에 있다고 가정해
// 중첩 @media·다중 print 블록·들여쓰기 규약 변경에 조용히 오작동할 수 있었다
// (review-3a N-10, review-3b §4 nit). 깊이 계산으로 대체한다.
function collectCustomProperties(cssSource) {
  const text = cssSource.replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, ' '));
  const definitions = [];
  const stack = [];
  let buffer = '';
  let bufferStart = 0;

  const flush = () => {
    const match = buffer.match(/^\s*(--[\w-]+)\s*:([\s\S]*)$/u);
    if (match) {
      const offset = bufferStart + buffer.indexOf(match[1]);
      definitions.push({
        name: match[1],
        value: match[2].trim(),
        selector: stack.length > 0 ? stack[stack.length - 1] : '',
        atRules: stack.filter((entry) => entry.startsWith('@')),
        depth: stack.length,
        line: text.slice(0, offset).split('\n').length,
      });
    }
    buffer = '';
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' || char === "'") {
      const close = text.indexOf(char, index + 1);
      const end = close === -1 ? text.length - 1 : close;
      buffer += text.slice(index, end + 1);
      index = end;
      continue;
    }
    if (char === '{') {
      stack.push(buffer.trim().replace(/\s+/gu, ' '));
      buffer = '';
      bufferStart = index + 1;
      continue;
    }
    if (char === '}') {
      flush();
      stack.pop();
      bufferStart = index + 1;
      continue;
    }
    if (char === ';') {
      flush();
      bufferStart = index + 1;
      continue;
    }
    buffer += char;
  }
  return definitions;
}

function validateDesignTokens() {
  // 토큰 단일 원본 = assets/css/system.css (plan.md D5, C-3).
  // 재작성 완료 표면의 CSS는 :root를 정의하지 않는다. 앱 3면(WordMaster·smstudy·admin)은
  // 3b 재작성 전까지 레거시 토큰 검사(값 일치)로 유지하고, 3b에서 :root 금지로 전환한다.
  const systemCss = readFileSync(path.join(ROOT, 'assets/css/system.css'), 'utf8');
  const systemRoots = [...systemCss.matchAll(/:root\s*\{([^}]*)\}/gsu)];
  check(systemRoots.length === 1, `system.css: exactly one :root block must exist, found ${systemRoots.length}`);
  const canonical = {
    '--bg': '#000',
    '--surface': '#161617',
    '--surface-2': '#1d1d1f',
    '--text': '#f5f5f7',
    '--text-2': '#a1a1a6',
    '--line': 'rgba(255,255,255,.12)',
    '--green': '#d6d6d8',
    '--red': '#e5e5e7',
    '--accent': '#f5f5f7',
  };
  const systemRoot = systemRoots[0]?.[1] ?? '';
  for (const [name, expectedValue] of Object.entries(canonical)) {
    const match = systemRoot.match(new RegExp(`${name}\\s*:\\s*([^;\\r\\n]+)`, 'u'));
    check(Boolean(match), `system.css: canonical token ${name} is not defined`);
    if (match) {
      check(
        match[1].trim().replace(/\s+/gu, '').toLowerCase() === expectedValue,
        `system.css: ${name} is ${match[1].trim()}, expected ${expectedValue}`,
      );
    }
  }

  // 로드 계약: 모든 표면은 system.css를 자기 스타일보다 먼저 링크한다 (4면 전체).
  const styleOrder = {
    'index.html': '/assets/css/home.css',
    'WordMaster/index.html': 'assets/css/style.css',
    'smstudy/index.html': 'assets/css/style.css',
    'admin/index.html': '/admin/assets/css/admin.css',
  };
  for (const [file, ownStylesheet] of Object.entries(styleOrder)) {
    const html = readFileSync(path.join(ROOT, file), 'utf8');
    const systemIndex = html.indexOf('/assets/css/system.css');
    const ownIndex = html.indexOf(ownStylesheet);
    check(systemIndex !== -1, `${file}: system.css must be linked`);
    check(ownIndex !== -1 && systemIndex < ownIndex, `${file}: system.css must load before ${ownStylesheet}`);
  }

  // site-nav.css는 system.css .topbar가 흡수했다 — 파일도 링크도 남으면 안 된다.
  check(!existsSync(path.join(ROOT, 'assets/css/site-nav.css')), 'assets/css/site-nav.css must be deleted (absorbed by system.css .topbar)');

  // C-3 / D5 — 디자인 토큰 단일 원본. 검사 대상 토큰 목록은 system.css의 :root에서 자동 도출한다.
  // 하드코딩하면 토큰이 늘어날 때마다 게이트가 조용히 뒤처진다 — 실제로 색 토큰 9종만 지키고
  // --text-3 등 나머지는 아무 셀렉터에서나 재정의 가능했다 (review-3b §4 major, review-3a M-7).
  const legacyPalette = /#2997ff|41, ?151, ?255|#87f5b0|#86efac|#6dff9a|#5fe391|#4ade80|#ff7a7a|#fb7185|#7dd3fc|#a8f5bf|#8fffb0|#facc15|#fb923c|135, ?245, ?176|134, ?239, ?172|95, ?227, ?145|74, ?222, ?128|255, ?122, ?122|251, ?113, ?133|109, ?255, ?154|125, ?211, ?252|250, ?204, ?21/iu;
  const systemTokens = new Set(
    [...systemRoot.matchAll(/(?:^|[;{\s])(--[\w-]+)\s*:/gu)].map(([, token]) => token),
  );
  // 도출이 깨지면 아래 재정의 금지가 통째로 무력해지므로 도출 결과 자체를 검사한다.
  check(systemTokens.size >= 60, `system.css: :root token set looks truncated (parsed ${systemTokens.size}, expected >= 60)`);
  for (const name of Object.keys(canonical)) {
    check(systemTokens.has(name), `system.css: canonical token ${name} must appear in the parsed :root token set`);
  }

  // 자체 작성 CSS 목록은 **파일 시스템에서 도출한다** (review WP1 M-3 / LESSONS 규칙 5).
  // 손으로 적은 등록부는 새 화면의 CSS를 빠뜨리는 순간 토큰 검사 전체가 그 파일을
  // 조용히 건너뛴다 — 검사가 초록불인 채 결함이 통과하는 형태다.
  //
  // 서드파티 차단 목적은 등록부 없이도 산다: (1) 저장소 안의 CSS는 **전부** 검사 대상이고
  // (벤더 경로만 규칙으로 제외), (2) 게시 HTML이 참조하는 스타일시트가 저장소 파일 집합의
  // 부분집합인지 아래에서 확인한다. 즉 외부 CSS를 끼워 넣으면 (2)에서 걸린다.
  const isVendorCss = (name) => name.includes('assets/vendor/');
  const isHistoricalCss = (name) => name.startsWith('docs/archive/');
  const repoCss = walk(ROOT, (item) => item.endsWith('.css')).map(relative);
  const firstPartyCss = new Set(repoCss.filter((name) => !isVendorCss(name) && !isHistoricalCss(name)));
  const vendorCss = new Set(repoCss.filter(isVendorCss));
  check(firstPartyCss.size >= 5,
    `design tokens: only ${firstPartyCss.size} first-party stylesheets were derived from the repository — this check is inert`);

  // 게시 HTML이 로드하는 **로컬** 스타일시트는 전부 저장소 파일이어야 한다. 저장소 밖
  // 경로(../../)를 가리키면 위 도출 집합에 없으므로 토큰 검사를 통째로 비껴간다.
  //
  // 이 검사가 **못 보는 것**: 외부 호스트 스타일시트(현재는 Pretendard 웹폰트 CDN 하나뿐이고
  // 폰트 @font-face만 들어 있다 — 자산을 받아오지 않으면 내용을 볼 수 없다),
  // @import로 끌어오는 CSS, 런타임에 주입되는 <link>.
  const publishedCss = new Set();
  for (const file of publishedHtml()) {
    for (const [, href] of readFileSync(file, 'utf8').matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/gu)) {
      if (/^https?:/iu.test(href)) continue;
      publishedCss.add(relative(resolveAsset(file, href)));
    }
  }
  check(publishedCss.size >= 2,
    `design tokens: only ${publishedCss.size} local stylesheet links were derived from the published pages — this check is inert`);
  for (const name of publishedCss) {
    check(firstPartyCss.has(name) || vendorCss.has(name),
      `${name}: a published page links this stylesheet but it is not a file in the repository — the design token gate cannot see it`);
  }

  // 유일한 정당한 재정의: smstudy 개념노트 인쇄용 라이트 팔레트 (plan.md §2).
  // 파일 + @media print + html 셀렉터 + at-rule 1겹 + system.css가 아는 토큰 — 5중으로 좁혀
  // 화이트리스트가 다른 파일·다른 위치의 위반을 덮지 않게 한다.
  const printPalette = { file: 'smstudy/assets/css/style.css', selector: 'html' };
  const isPrintPalette = (name, definition) => name === printPalette.file
    && definition.selector === printPalette.selector
    && definition.depth === 2
    && definition.atRules.length === 1
    && /^@media\b[^{]*\bprint\b/u.test(definition.atRules[0])
    && systemTokens.has(definition.name);
  let printPaletteOverrides = 0;

  for (const file of walk(ROOT, (item) => item.endsWith('.css'))) {
    const name = relative(file);
    const source = readFileSync(file, 'utf8');

    if (name === 'assets/css/system.css' || isHistoricalCss(name)) continue;
    const executableCss = source.replace(/\/\*[\s\S]*?\*\//gu, '');
    check(!legacyPalette.test(executableCss), `${name}: legacy palette literal found`);

    if (firstPartyCss.has(name)) check(/var\(--/u.test(source), `${name}: stylesheet must consume system.css tokens`);
    check(!/:root\s*\{/u.test(source), `${name}: tokens must come from system.css only (no :root block)`);

    // 토큰 이름도 셀렉터도 가리지 않는다 — system.css 밖의 커스텀 프로퍼티 *정의*는 전면 금지.
    const redefinitions = collectCustomProperties(source).filter((definition) => {
      if (!isPrintPalette(name, definition)) return true;
      printPaletteOverrides += 1;
      return false;
    });
    check(redefinitions.length === 0,
      `${name}: design tokens must be defined only in assets/css/system.css — `
      + redefinitions.map((item) => `${item.name} at line ${item.line} in "${item.selector || '(top level)'}"`).join('; '));
  }

  // 화이트리스트가 죽은 채 남아 다른 위반을 덮는 일이 없도록 실제 사용을 확인한다.
  check(printPaletteOverrides >= 20,
    `smstudy: @media print light palette must remap the shared tokens on html (found ${printPaletteOverrides})`);

  for (const file of publishedHtml()) {
    const source = readFileSync(file, 'utf8');
    check(!legacyPalette.test(source.replace(/<!--[\s\S]*?-->/gu, '')), `${relative(file)}: legacy palette literal found`);
    // style="--token: …" 인라인 정의도 같은 우회로다.
    check(!/style="[^"]*--[\w-]+\s*:/u.test(source), `${relative(file)}: inline style must not define design tokens`);
  }
}

// DESIGN.md §5.2 v14 — 데이터 원본의 emoji 필드는 유지하되, 게시 화면과 그 화면이
// 로드하는 렌더러에는 그림문자가 하나도 없어야 한다.
function validateNoRenderedEmoji() {
  const surfaces = [
    ...publishedHtml().map((file) => ({ file: relative(file), source: readFileSync(file, 'utf8') })),
    ...publishedScripts().filter((file) => !file.startsWith('assets/vendor/'))
      .map((file) => ({ file, source: readFileSync(path.join(ROOT, file), 'utf8') })),
  ];
  check(surfaces.length >= 12,
    `icon gate: only ${surfaces.length} published HTML/JS surfaces were derived — the emoji scan is inert`);
  for (const failure of findRenderedEmoji(surfaces)) {
    check(false, `${failure.file}:${failure.line}: rendered pictograph "${failure.glyph}" is forbidden (DESIGN.md §5.2)`);
  }
}

function iconSpriteState() {
  const file = 'assets/ui-icons.svg';
  const source = readFileSync(path.join(ROOT, file), 'utf8');
  const symbols = inspectSprite(source);
  return { file, source, symbols, ids: new Set(symbols.map((symbol) => symbol.id).filter(Boolean)) };
}

function iconReferenceSurfaces() {
  return [
    ...publishedHtml().map((file) => ({ file: relative(file), source: readFileSync(file, 'utf8') })),
    ...publishedScripts().filter((file) => !file.startsWith('assets/vendor/'))
      .map((file) => ({ file, source: readFileSync(path.join(ROOT, file), 'utf8') })),
  ];
}

// 정적 <use href>와 런타임 키→id 매핑의 icon-* 리터럴을 함께 검사한다. 후자를 빼면
// WordMaster처럼 href를 보간하는 렌더러의 잘못된 id가 게이트 밖에 남는다.
function validateIconReferences() {
  const sprite = iconSpriteState();
  const surfaces = iconReferenceSurfaces();
  let references = 0;
  for (const surface of surfaces) references += (surface.source.match(/\bicon-[a-z0-9-]+\b/gu) || []).length;
  check(references >= 35, `icon gate: only ${references} icon references were derived — the href/map check is inert`);
  for (const failure of findMissingIconReferences(surfaces, sprite.ids)) {
    check(false, `${failure.file}:${failure.line}: ${failure.id} does not exist in ${sprite.file} (DESIGN.md §5.2)`);
  }
  const allowedNonUi = new Map([[DIAGRAM_SOURCE, new Set(['sm-d-svg'])]]);
  for (const failure of findInvalidIconMarkup(surfaces, allowedNonUi)) {
    check(false, `${failure.file}:${failure.line}: inline SVG must be class="ui-icon" with one <use href="${ICON_SPRITE_URL}#icon-…"> (content visualization allowlist excepted)`);
  }
  for (const failure of findUnversionedIconSpriteReferences(surfaces)) {
    check(false, `${failure.file}:${failure.line}: ${failure.value} must use the pinned sprite URL ${ICON_SPRITE_URL}#…`);
  }
  check(!existsSync(path.join(ROOT, 'assets/vendor/lucide')), 'assets/vendor/lucide must be deleted after the single-sprite migration');
  for (const surface of surfaces) {
    check(!/assets\/vendor\/lucide|window\.SM_ICONS|\bsm-icon\b|\bgi-icon\b/u.test(surface.source),
      `${surface.file}: second icon-set code/reference remains after the single-sprite migration`);
  }
}

function validateIconSprite() {
  const { file, symbols } = iconSpriteState();
  const referenced = referencedIconIds(iconReferenceSurfaces());
  check(referenced.size >= 20, `${file}: only ${referenced.size} referenced symbol ids were derived — the reference scan is inert`);
  check(symbols.length === referenced.size,
    `${file}: referenced symbol count ${referenced.size} must equal sprite symbol count ${symbols.length} (dead symbols 0)`);
  const seen = new Set();
  for (const symbol of symbols) {
    check(Boolean(symbol.id), `${file}: every symbol needs an id`);
    check(!seen.has(symbol.id), `${file}: duplicate symbol id "${symbol.id}"`);
    seen.add(symbol.id);
    check(symbol.fill === 'none' && symbol.stroke === 'currentColor',
      `${file}#${symbol.id}: symbols must set fill="none" and stroke="currentColor"`);
    check(symbol.strokeWidth === '1.75' && symbol.strokeLinecap === 'round' && symbol.strokeLinejoin === 'round',
      `${file}#${symbol.id}: symbols must use the Lucide 1.75 round stroke contract`);
    check(referenced.has(symbol.id), `${file}#${symbol.id}: symbol is not referenced by published HTML/JS (dead symbol)`);
  }
}

function validateIconBackgrounds() {
  const stylesheets = walk(ROOT, (file) => file.endsWith('.css'))
    .filter((file) => !relative(file).startsWith('docs/archive/') && !relative(file).includes('assets/vendor/'))
    .map((file) => ({ file: relative(file), source: readFileSync(file, 'utf8') }));
  const snapshots = walk(path.join(ROOT, 'docs/_snapshots'), (file) => file.endsWith('.html'))
    .map((file) => ({ file: relative(file), source: readFileSync(file, 'utf8') }));
  check(stylesheets.length >= 8,
    `icon gate: only ${stylesheets.length} stylesheets were derived — the background scan is inert`);
  check(snapshots.length >= 8,
    `icon gate: only ${snapshots.length} rendered snapshots were derived — the ancestor scan is inert`);
  for (const failure of findIconBackgroundViolations(snapshots, stylesheets)) {
    check(false, `${failure.file}:${failure.line}: ${failure.selector} gives a rendered ui-icon ancestor (${failure.classes.join(', ')}) an accent/status background (DESIGN.md §5.2)`);
  }
}

function validateBrandName() {
  // 브랜드는 hvsdcm 또는 새 워드마크 HVSDCM1 한 덩어리로만 쓴다.
  const separated = /(?:HVS|hvs)[\s\-_]+(?:DCM|dcm)/u;
  for (const file of [...publishedHtml(), ...walk(ROOT, (item) => item.endsWith('.css'))]) {
    check(!separated.test(readFileSync(file, 'utf8')), `${relative(file)}: separated brand name found`);
  }

  // 슬래시·가운뎃점·마침표 분리만 금지한다. 랜딩 워드마크는 의도적으로 HVSDCM1이다.
  const separator = /hvs\s*[/·.]\s*dcm/iu;
  const brandSurfaces = [
    ...[...publishedHtml(), ...walk(ROOT, (item) => item.endsWith('.css'))].map(relative),
    ...publishedScripts(),
  ];
  for (const file of brandSurfaces) {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    check(!separator.test(source), `${file}: brand must not be split (use "hvsdcm" in one piece)`);
  }
  check(/id="wordmark"[^>]*>[^]*?HVSDCM1[^]*?<\/button>/u.test(readFileSync(path.join(ROOT, 'index.html'), 'utf8')),
    'index.html: the landing wordmark must be exactly HVSDCM1');

  // R-5의 "자간 분해 금지"는 문자열 스캔으로 잡히지 않는다 — .brand 규칙의 letter-spacing을 직접 본다
  // (review-3a N-8). h v s d c m 처럼 벌어진 워드마크는 문자열상 "hvsdcm"이라 통과해 버린다.
  check(/^\.brand\s*\{[^}]*letter-spacing\s*:\s*normal\s*;/mu.test(readFileSync(path.join(ROOT, 'assets/css/system.css'), 'utf8')),
    'system.css: .brand must pin letter-spacing: normal (R-5 forbids a spaced-out wordmark)');
  for (const cssFile of walk(ROOT, (item) => item.endsWith('.css'))) {
    for (const [, selector, body] of readFileSync(cssFile, 'utf8').matchAll(/([^{}]*\.brand[^{}]*)\{([^{}]*)\}/gu)) {
      const spacing = body.match(/letter-spacing\s*:\s*([^;]+)/u);
      check(!spacing || spacing[1].trim() === 'normal',
        `${relative(cssFile)}: ${selector.replace(/\/\*[\s\S]*?\*\//gu, " ").trim()} must not spread the wordmark (letter-spacing: ${spacing?.[1].trim()})`);
    }
  }
}

function validateGlobalsAndOrder() {
  // C-6: classic script + window 전역 유지 (plan.md §3.1, D6). type="module" 전면 금지.
  for (const file of publishedHtml()) {
    check(!/type=["']module["']/u.test(readFileSync(file, 'utf8')), `${relative(file)}: type="module" is forbidden`);
  }

  const scriptSources = (file) =>
    [...readFileSync(path.join(ROOT, file), 'utf8').matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/giu)].map(([, src]) => src);

  // 표면별 스크립트 로드 순서 (§3.1)
  const expectedOrders = {
    'index.html': ['/assets/js/site-icons.js?v=20260904-icons-v1', '/assets/js/home.js?v=20260904-icons-v2'],
    'WordMaster/index.html': ['/account.js?v=20260904-auth-gate-v1', 'assets/js/words.js?v=20260904-icons-v2', '/assets/js/study-utils.js', 'assets/js/app.js?v=20260904-icons-v2'],
    'smstudy/index.html': ['/account.js?v=20260904-auth-gate-v1', 'assets/js/data.js', 'assets/js/notebook-data.js', 'assets/js/explanation-data.js', '/assets/js/study-utils.js', 'assets/js/diagram.js?v=20260904-icons-v2', 'assets/js/app.js?v=20260908-study-refresh'],
    'plstudy/index.html': ['/account.js?v=20260904-auth-gate-v1', 'assets/js/data.js', 'assets/js/app.js?v=20260908-study-refresh'],
    'admin/index.html': ['/admin/assets/js/admin.js?v=20260904-icons-v1'],
    'usage/index.html': ['/usage/assets/js/competition.js?v=20260904-icons-v2', '/usage/assets/js/page.js?v=20260904-icons-v2'],
    // 기출은 전역 데이터 선행 계약을 따른다: 세션(account) → pdf-lib → 컨트롤러.
    // 목록 데이터는 이 순서 어디에도 없다 — 로그인 뒤 API에서만 온다 (plan.md §3).
    'gichul/index.html': ['/account.js?v=20260904-auth-gate-v1', '/assets/vendor/pdf-lib/pdf-lib.min.js', '/gichul/app.js?v=20260904-icons-v2'],
    'behavior-lab/index.html': ['/behavior-lab/assets/js/app.js?v=20260901-v16'],
    // 정시 진단은 게이트 전용 세션(account) → 공개 통계 데이터 → 계산 엔진 → 컨트롤러 순이다.
    'ipsi/index.html': ['/account.js?v=20260904-auth-gate-v1', '/ipsi/assets/js/data.js?v=20260910-ipsi-v1', '/ipsi/assets/js/engine.js?v=20260910-ipsi-v1', '/ipsi/assets/js/app.js?v=20260910-ipsi-v1'],
  };
  for (const [file, order] of Object.entries(expectedOrders)) {
    check(scriptSources(file).join(' → ') === order.join(' → '), `${file}: script load order must be ${order.join(' → ')}`);
  }
  // 화면 목록을 손으로 적으면 새 화면이 검사 밖에 남는다 — 게시되는 진입 HTML에서 도출해
  // 위 표와 대조한다 (LESSONS "파생 가능한 것을 손으로 적지 않는다").
  for (const screen of publishedHtml().map(relative).filter((file) => file === 'index.html' || file.endsWith('/index.html'))) {
    check(Object.prototype.hasOwnProperty.call(expectedOrders, screen),
      `${screen}: no script load order is declared — add it to expectedOrders in scripts/validate.mjs (load order is the deployment contract)`);
  }

  // 수정 라운드 M-1: 상태 계약이 CSS에만 있는 경우(.is-accent/.is-idle 등)는 구캐시
  // 스타일시트만으로도 화면이 어긋난다 — 스크립트처럼 스타일시트 href(버전 쿼리 포함)도
  // 표면별로 고정한다. usage는 JS와 같은 ?v= 토큰을 CSS 두 장 모두에 싣는다.
  const stylesheetSources = (file) =>
    [...readFileSync(path.join(ROOT, file), 'utf8').matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["']/giu)].map(([, href]) => href);
  const expectedStylesheets = {
    'index.html': ['/assets/css/system.css?v=20260904-icons-v2', '/assets/css/home.css?v=20260904-icons-v1'],
    'WordMaster/index.html': ['/assets/css/system.css?v=20260904-icons-v2', 'assets/css/style.css?v=20260904-mobile-v1'],
    'smstudy/index.html': ['/assets/css/system.css?v=20260904-icons-v2', 'assets/css/style.css?v=20260908-study-refresh'],
    'plstudy/index.html': ['/assets/css/system.css?v=20260904-icons-v2', 'assets/css/style.css?v=20260908-study-refresh'],
    'admin/index.html': ['/assets/css/system.css?v=20260904-icons-v2', '/admin/assets/css/admin.css?v=20260904-icons-v1'],
    'usage/index.html': ['/assets/css/system.css?v=20260904-icons-v2', '/usage/assets/css/usage.css?v=20260904-icons-v2'],
    'gichul/index.html': ['/assets/css/system.css?v=20260904-icons-v2', '/gichul/gichul.css?v=20260904-icons-v2'],
    'behavior-lab/index.html': ['/assets/css/system.css?v=20260904-icons-v2', '/behavior-lab/assets/css/app.css?v=20260904-ui-v1'],
    'ipsi/index.html': ['/assets/css/system.css?v=20260904-icons-v2', '/ipsi/ipsi.css?v=20260910-ipsi-v1'],
  };
  for (const [file, order] of Object.entries(expectedStylesheets)) {
    check(stylesheetSources(file).join(' → ') === order.join(' → '), `${file}: stylesheet hrefs (order + cache-buster) must be ${order.join(' → ')}`);
  }
  for (const screen of publishedHtml().map(relative).filter((file) => file === 'index.html' || file.endsWith('/index.html'))) {
    check(Object.prototype.hasOwnProperty.call(expectedStylesheets, screen),
      `${screen}: no stylesheet contract is declared — add it to expectedStylesheets in scripts/validate.mjs (href + version query is the cache contract)`);
  }
  // usage의 JS·CSS 버전 토큰이 서로 어긋나면 절반만 새로 실리는 배포가 된다 — 같은 토큰인지 잠근다.
  {
    const versionOf = (src) => (src.split('?v=')[1] || '');
    const usageJsVersion = versionOf(expectedOrders['usage/index.html'][0]);
    const usageCssVersions = expectedStylesheets['usage/index.html'].map(versionOf);
    check(usageJsVersion && usageCssVersions.every((token) => token === usageJsVersion),
      'usage/index.html: JS and CSS cache-buster tokens must be one identical ?v= value');
  }

  const homeHtml = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  check(/<script\b[^>]*src="\/assets\/js\/home\.js(?:\?[^"']*)?"[^>]*\bdefer\b/u.test(homeHtml),
    'index.html: home.js must load with defer');
  check(readFileSync(path.join(ROOT, 'WordMaster/index.html'), 'utf8').includes('data-app="wordmaster"'), 'WordMaster: account.js must declare data-app="wordmaster"');
  check(readFileSync(path.join(ROOT, 'smstudy/index.html'), 'utf8').includes('data-app="smstudy"'), 'smstudy: account.js must declare data-app="smstudy"');
  check(readFileSync(path.join(ROOT, 'plstudy/index.html'), 'utf8').includes('data-app="plstudy"'), 'plstudy: account.js must declare data-app="plstudy"');
  // 기출은 계정에 저장할 진도가 없다 — account.js를 게이트 전용 모드(data-key 없음)로 싣는다.
  // data-key가 붙는 순간 없는 진도를 /api/progress/gichul에 밀고, Worker의 VALID_APPS에
  // 없는 앱이라 매 방문이 404가 된다.
  {
    const gichulHtml = readFileSync(path.join(ROOT, 'gichul/index.html'), 'utf8');
    const accountTag = /<script\b[^>]*\bsrc="\/account\.js(?:\?[^"]*)?"[^>]*>/u.exec(gichulHtml)?.[0] || '';
    check(accountTag.includes('data-app="gichul"'), 'gichul: account.js must declare data-app="gichul"');
    check(!accountTag.includes('data-key'), 'gichul: account.js must load in gate-only mode (no data-key — there is no study progress to sync)');
  }

  // 저장 키 보존 (§3.2 — 이름 변경 금지)
  const homeJs = readFileSync(path.join(ROOT, 'assets/js/home.js'), 'utf8');
  for (const key of ['hvsdcm.token', 'hvsdcm.user', 'hvsdcm.api']) {
    check(homeJs.includes(`'${key}'`), `home.js: storage key ${key} is missing`);
  }
  const accountJs = readFileSync(path.join(ROOT, 'account.js'), 'utf8');
  check(accountJs.includes('hvsdcm.token') && accountJs.includes('hvsdcm.loaded.'), 'account.js: sync storage keys are missing');
  check(accountJs.includes("classList.remove('auth-pending')") && accountJs.includes("api('/api/me')"),
    'account.js: first-paint login cover and gate-only session validation must stay wired');
  const systemCss = readFileSync(path.join(ROOT, 'assets/css/system.css'), 'utf8');
  check(/html\.auth-pending body\s*\{[^}]*visibility:\s*hidden/u.test(systemCss),
    'system.css: learning pages must stay hidden until account validation');
  for (const file of ['WordMaster/index.html', 'smstudy/index.html', 'plstudy/index.html', 'gichul/index.html', 'ipsi/index.html']) {
    check(/<html\b[^>]*class="[^"]*auth-pending/u.test(readFileSync(path.join(ROOT, file), 'utf8')),
      `${file}: first-paint account cover is missing`);
  }
  const wordMasterHtml = readFileSync(path.join(ROOT, 'WordMaster/index.html'), 'utf8');
  check(!wordMasterHtml.includes('/behavior-lab/') && !wordMasterHtml.includes('/usage/'),
    'WordMaster: general learner navigation must not advertise owner-only routes');
  const plstudyApp = readFileSync(path.join(ROOT, 'plstudy/assets/js/app.js'), 'utf8');
  check(plstudyApp.includes('window.HvsAccount?.scheduleProgressSync(serialized)'),
    'plstudy: local progress must schedule account synchronization');
  check(readFileSync(path.join(ROOT, 'admin/assets/js/admin.js'), 'utf8').includes('hvsdcm.admin'), 'admin.js: admin session key is missing');
  check(readFileSync(path.join(ROOT, 'WordMaster/index.html'), 'utf8').includes('data-key="wordmaster2000.quiz.v1"'), 'WordMaster: study DB key is missing');
  check(readFileSync(path.join(ROOT, 'smstudy/index.html'), 'utf8').includes('data-key="samun2027.study.v1"'), 'smstudy: study DB key is missing');
  check(readFileSync(path.join(ROOT, 'plstudy/index.html'), 'utf8').includes('data-key="politicslaw2027.study.v1"'), 'plstudy: study DB key is missing');
}

function validateOgImageLock() {
  // B-1 재발 방지 — og.png 픽셀 속 글자는 텍스트 스캔(validateBrandName)이 볼 수 없다.
  // 그래서 "랜딩 워드마크 문자열 <-> assets/og.png 바이트 해시"를 잠금쌍으로 고정한다.
  // 브랜드 표기를 바꾸는 커밋은 (1) 아래 brand가 어긋나 즉시 실패하고,
  // (2) 잠금을 갱신하려면 og.png를 실제로 재생성해 sha256을 다시 계산해야 한다.
  const OG_LOCK = {
    sha256: '4d702de6f212f303c88a51d99eb63344ed0503bce69bb255ddb490fe61dcf6ad',
  };
  const homeHtml = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  check(/id="wordmark"[^>]*>[^]*?HVSDCM1[^]*?<\/button>/u.test(homeHtml),
    'og lock: index.html must preserve the HVSDCM1 wordmark');
  check(/property="og:image"[^>]*assets\/og\.png/u.test(homeHtml) && /name="twitter:image"[^>]*assets\/og\.png/u.test(homeHtml),
    'og lock: index.html og:image/twitter:image must reference assets/og.png');
  check(createHash('sha256').update(readFileSync(path.join(ROOT, 'assets/og.png'))).digest('hex') === OG_LOCK.sha256,
    'og lock: assets/og.png bytes do not match OG_LOCK.sha256 — regenerate the image and update the lock in one commit');
}

// ---- R4-M-3. 섹션 라벨은 제목이어야 한다 ----
// 사이클4 재조판에서 WordMaster의 rangeHead / sessionMistakes / wrongNoteTitle이 h2에서
// 시각용 p로 바뀌었다. aria-labelledby는 그대로라 이름은 붙었지만, 스크린리더의 제목
// 탐색점과 문서 위계는 사라졌다 — 문자열 검사로는 보이지 않는 종류의 회귀다.
// 대상 목록을 하드코딩하지 않는다: 표면에서 aria-labelledby 값을 전부 뽑아 같은 소스 안의
// id 정의와 맞춘다.
//
// 이 검사가 **못 보는 것**: 제목 레벨의 논리적 순서(h2 아래 h4), 라벨 문구의 적절성,
// 런타임에 조립한 id, 그리고 다른 파일에 정의된 id. <summary> 안의 span처럼 제목이
// 아니어도 정당한 라벨이 있으므로 "p 금지 + .list-group-head는 제목"까지만 강제한다.
function validateLabelledBy() {
  const surfaces = [...publishedHtml().map(relative), ...publishedScripts()];
  let resolved = 0;
  for (const file of surfaces) {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    for (const [, id] of source.matchAll(/aria-labelledby="([^"]+)"/gu)) {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const target = new RegExp(`<([a-z][\\w-]*)\\b([^>]*\\sid="${escaped}"[^>]*)>`, 'u').exec(source);
      if (!target) continue;
      resolved += 1;
      const [, tag, attributes] = target;
      const isHeading = /^h[1-6]$/u.test(tag);
      const isGroupHead = /\sclass="[^"]*\blist-group-head\b/u.test(attributes);
      check(tag !== 'p',
        `${file}: aria-labelledby="${id}" points at a <p> — a section label must be a heading (DESIGN.md §7.1)`);
      check(!isGroupHead || isHeading,
        `${file}: aria-labelledby="${id}" is a .list-group-head on <${tag}> — section labels must be h1–h6 so the heading outline survives`);
    }
  }
  check(resolved >= 15, `aria-labelledby: only ${resolved} targets resolved — this check is inert`);
}

// ---- R4-M-9. 대비표를 손으로 적지 않는다 ----
// system.css 상단 대비표의 숫자 9개가 실제 알파 합성값과 어긋나 있었다. 주석은 사람이
// 적는 순간 낡으므로, 여기서 주석을 **파싱해** :root 토큰에서 다시 계산한 값과 대조한다.
// 검사 대상 목록은 표 자신에서 도출한다 — 표에 행을 추가하면 그 행도 자동으로 검산된다.
//
// 이 검사가 **못 보는 것**: (1) 어떤 조합이 실제 화면에 등장하는지 — 표에 없는 조합은
// 검산되지 않으므로 아래 "모든 색 토큰이 표에 등장하는가"를 함께 건다. (2) 글자 크기에
// 따른 하한 분기(큰 글자 3:1)와 ✗ 표시의 타당성. (3) opacity·filter로 합성되는 상태.
// (4) CSS가 그 토큰을 실제로 규칙에 얹었는지 — 값이 맞아도 잘못된 곳에 쓰면 못 본다.
const CONTRAST_SURFACES_LINE = /전경 \\ 배경\s+(.+)/u;
function srgbToLinear(channel) {
  const scaled = channel / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}
function relativeLuminance([r, g, b]) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}
function contrastRatio(a, b) {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
function compositeOver(color, background) {
  return color.rgb.map((channel, index) => channel * color.alpha + background[index] * (1 - color.alpha));
}
function parseCssColor(value) {
  const text = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(text);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((d) => d + d) : [0, 2, 4].map((i) => hex[1].slice(i, i + 2));
    return { rgb: digits.map((pair) => parseInt(pair, 16)), alpha: 1 };
  }
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/iu.exec(text);
  if (rgba) {
    return { rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])], alpha: rgba[4] === undefined ? 1 : Number(rgba[4]) };
  }
  return null;
}
function validateContrastTable() {
  const css = readFileSync(path.join(ROOT, 'assets/css/system.css'), 'utf8');
  const header = /\/\*[^]*?대비 전수표[^]*?\*\//u.exec(css);
  check(Boolean(header), 'system.css: the contrast table comment is missing — DESIGN.md §3.1 requires it');
  if (!header) return;
  const table = header[0];

  const rootBlock = /:root\s*\{([^]*?)\n\}/u.exec(css);
  const tokens = new Map();
  for (const [, name, value] of (rootBlock?.[1] || '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)) {
    const color = parseCssColor(value.replace(/\/\*[^]*?\*\//gu, '').trim());
    if (color) tokens.set(name, color);
  }
  check(tokens.size >= 15, `system.css: only ${tokens.size} color tokens were parsed from :root — the contrast gate is inert`);

  const opaque = (name) => {
    const token = tokens.get(name.startsWith('--') ? name : `--${name}`);
    if (!token || token.alpha !== 1) return null;
    return token.rgb;
  };
  const stated = (value) => Number(value).toFixed(2);
  const computed = (ratio) => ratio.toFixed(2);
  let compared = 0;
  const compare = (label, expectedRatio, statedValue) => {
    compared += 1;
    check(computed(expectedRatio) === stated(statedValue),
      `system.css contrast table: ${label} says ${stated(statedValue)} but the tokens compute ${computed(expectedRatio)}`);
  };

  // 1) 전경 × 배경 격자
  const surfaceNames = (CONTRAST_SURFACES_LINE.exec(table)?.[1] || '').trim().split(/\s+/u);
  check(surfaceNames.length >= 4, 'system.css contrast table: the surface header row could not be parsed');
  for (const line of table.split('\n')) {
    const row = /^\s*(--[\w-]+)\s+((?:\d+\.\d+\s+)*\d+\.\d+)/u.exec(line);
    if (!row) continue;
    const foreground = opaque(row[1]);
    if (!foreground) continue;
    const values = row[2].trim().split(/\s+/u);
    if (values.length !== surfaceNames.length) continue;
    surfaceNames.forEach((surface, index) => {
      const background = opaque(surface);
      if (!background) return;
      compare(`${row[1]} on ${surface}`, contrastRatio(foreground, background), values[index]);
    });
  }

  // 2) -soft 뱃지 (알파 배경을 부모 표면과 합성)
  const softRows = table.matchAll(/(--[\w-]+)\s*\+\s*(--[\w-]+)((?:[^\n]*\n\s*\/[^\n]*)*[^\n]*)/gu);
  for (const [, softName, foregroundName, body] of softRows) {
    const soft = tokens.get(softName);
    const foreground = opaque(foregroundName);
    if (!soft || !foreground) continue;
    for (const [, surface, value] of body.matchAll(/\b([a-z][\w-]*)\s+(\d+\.\d+)/gu)) {
      const background = opaque(surface);
      if (!background) continue;
      compare(`${softName} + ${foregroundName} on ${surface}`,
        contrastRatio(foreground, compositeOver(soft, background)), value);
    }
  }

  // 3) "X on (TOKEN .aa over SURFACE) = N" — 알파 오버레이 위 전경
  for (const [, foregroundName, tintName, alpha, surface, value] of
    table.matchAll(/(--[\w-]+|#[0-9a-f]{3,6})\s+on\s+\((--[\w-]+)\s+(\.\d+)\s+over\s+([\w-]+)\)\s*=\s*(\d+\.\d+)/giu)) {
    const foreground = parseCssColor(foregroundName)?.rgb || opaque(foregroundName);
    const tint = tokens.get(tintName);
    const background = opaque(surface);
    if (!foreground || !tint || !background) continue;
    compare(`${foregroundName} on (${tintName} ${alpha} over ${surface})`,
      contrastRatio(foreground, compositeOver({ rgb: tint.rgb, alpha: Number(alpha) }, background)), value);
  }

  // 4) "X on Y = N" — 불투명 면 위 전경
  for (const [, foregroundName, backgroundName, value] of
    table.matchAll(/(--[\w-]+|#[0-9a-f]{3,6})\s+on\s+(--[\w-]+|#[0-9a-f]{3,6})(?:\s+#[0-9a-f]{3,6})?\s*=\s*(\d+\.\d+)/giu)) {
    const foreground = parseCssColor(foregroundName)?.rgb || opaque(foregroundName);
    const background = parseCssColor(backgroundName)?.rgb || opaque(backgroundName);
    if (!foreground || !background) continue;
    compare(`${foregroundName} on ${backgroundName}`, contrastRatio(foreground, background), value);
  }

  // 5) 헤어라인의 범위 표기 (min~max)
  for (const [, lineName, low, high] of table.matchAll(/(--line[\w-]*)\s+(\d+\.\d+)~(\d+\.\d+)/gu)) {
    const hairline = tokens.get(lineName);
    if (!hairline) continue;
    const ratios = surfaceNames
      .map((surface) => opaque(surface))
      .filter(Boolean)
      .map((background) => contrastRatio(compositeOver(hairline, background), background));
    compare(`${lineName} min`, Math.min(...ratios), low);
    compare(`${lineName} max`, Math.max(...ratios), high);
  }

  check(compared >= 60, `system.css contrast table: only ${compared} values were re-computed — the parser lost the table`);

  // 6) 전수 검산 — :root의 모든 색 토큰이 표에 등장해야 한다 (DESIGN.md §3.1).
  for (const name of tokens.keys()) {
    check(table.includes(name.slice(2)),
      `system.css contrast table: ${name} is defined but never appears in the table — every color token needs its contrast recorded (DESIGN.md §3.1)`);
  }

  // 7) .btn-danger의 normal·hover는 CSS 선언에서 직접 재계산한다 (R4-M-10).
  //    표의 숫자가 아니라 **규칙이 실제로 쓰는 토큰**을 본다 — 값이 맞아도 규칙이 다른
  //    토큰을 쓰면 화면은 미달이다. :disabled는 WCAG 1.4.3 비활성 예외라 하한을 걸지 않는다.
  const dangerForeground = /\.btn-danger\s*\{[^}]*color:\s*var\((--[\w-]+)\)/u.exec(css);
  const dangerBase = /\.btn-danger\s*\{[^}]*background:\s*var\((--[\w-]+)\)/u.exec(css);
  const dangerHover = /\.btn-danger:hover\s*\{[^}]*background:\s*var\((--[\w-]+)\)/u.exec(css);
  check(Boolean(dangerForeground && dangerBase && dangerHover),
    'system.css: .btn-danger normal/hover declarations could not be read — the danger contrast check is inert');
  if (dangerForeground && dangerBase && dangerHover) {
    const foreground = opaque(dangerForeground[1]);
    for (const [state, rule] of [['normal', dangerBase], ['hover', dangerHover]]) {
      const background = opaque(rule[1]);
      check(Boolean(foreground && background),
        `system.css: .btn-danger ${state} uses a non-opaque surface (${rule[1]}) — an alpha fill makes contrast depend on the parent (R4-M-10)`);
      if (!foreground || !background) continue;
      const ratio = contrastRatio(foreground, background);
      check(ratio >= 4.5,
        `system.css: .btn-danger ${state} is ${computed(ratio)}:1 (${dangerForeground[1]} on ${rule[1]}) — 14px semibold needs 4.5:1`);
    }
  }
  check(/\.btn:disabled[^{]*\{[^}]*opacity:/u.test(css),
    'system.css: .btn disabled state must be opacity-based (WCAG 1.4.3 exempts inactive controls from the contrast floor)');
}

function validateLandingGating() {
  // 미로그인 랜딩은 HVSDCM1 워드마크 하나만 보인다. 앱 링크는 HTML에 두지 않고
  // 로그인 상태를 확인한 뒤 home.js가 드로어에 생성한다.
  const homeHtml = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const homeJs = readFileSync(path.join(ROOT, 'assets/js/home.js'), 'utf8');
  const dynamicTargets = [...new Set(
    [...homeJs.matchAll(/\['(\/[\w./-]+\/?(?:#[\w-]+)?)',\s*'[^']+'/gu)].map(([, href]) => href),
  )];
  check(dynamicTargets.length >= 7,
    `home.js: only ${dynamicTargets.length} signed-in entries were derived — this check is inert`);

  for (const target of dynamicTargets) {
    const appPath = target.split('#')[0];
    check(!new RegExp(`(?:href|src|action)=["']${appPath.replaceAll('/', '\\/')}`, 'u').test(homeHtml),
      `index.html: logged-out static markup must not link to gated path ${appPath}`);
  }
  for (const keyword of STUDY_KEYWORDS) {
    check(!homeHtml.includes(keyword),
      `index.html: logged-out static markup must not contain study keyword "${keyword}"`);
  }
  check(!/Contact|Workspace|Private first|Personal command center|서브타이틀/iu.test(homeHtml),
    'index.html: removed landing clutter returned');
  check(/<main id="main">\s*<button id="wordmark"[^]*?HVSDCM1[^]*?<\/button>\s*<\/main>/u.test(homeHtml),
    'index.html: the visible landing main must contain only the HVSDCM1 wordmark button');
  for (const required of ['/WordMaster/', '/smstudy/', '/plstudy/', '/gichul/', '/usage/', '/admin/']) {
    check(dynamicTargets.some((target) => target.startsWith(required)),
      `home.js: signed-in navigation must restore ${required}`);
  }
  check(homeJs.includes('if (signedIn) mountSignedInLinks()'),
    'home.js: signed-in entries must mount only after a local session is present');

  const configuredOwners = /(?:^|\n)OWNER_USERNAME\s*=\s*"([^"]*)"/u
    .exec(readFileSync(path.join(ROOT, 'worker/wrangler.toml'), 'utf8'))?.[1]
    ?.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean) || [];
  const renderedOwners = [...homeJs.matchAll(/const ownerUsernames = new Set\(\[([^\]]*)\]\)/gu)]
    .flatMap((match) => [...match[1].matchAll(/'([^']+)'/gu)].map((owner) => owner[1].toLowerCase()));
  check(configuredOwners.length === 1 && configuredOwners[0] === 'hvsdcm'
    && JSON.stringify(renderedOwners) === JSON.stringify(configuredOwners),
    'owner boundary: Worker and landing UI must expose owner controls to the sole human owner only');
  check(homeJs.includes("if (!ownerUsernames.has(String(savedUsername).toLowerCase())) return;")
    && homeJs.includes("['/behavior-lab/#paper', 'Behavior Lab', 'behaviorLab']"),
    'home.js: owner-only navigation must stay behind the exact owner check');

  for (const target of dynamicTargets) {
    const appPath = target.split('#')[0];
    const entry = path.join(ROOT, appPath.slice(1), 'index.html');
    check(existsSync(entry), `index.html: the drawer links to ${target} but ${target}index.html does not exist`);
    if (!existsSync(entry)) continue;
    check(Boolean(loginGateOf(entry, readFileSync(entry, 'utf8'))),
      `${target}index.html: it is opened from the login-gated drawer but no script gates it — an anonymous visitor could read it (plan.md §3.3)`);
  }
}

function validateBehaviorLab() {
  const files = [
    'behavior-lab/index.html',
    'behavior-lab/assets/css/app.css',
    'behavior-lab/assets/js/app.js',
  ];
  for (const file of files) check(existsSync(path.join(ROOT, file)), `${file}: Behavior Lab artifact is missing`);
  if (files.some((file) => !existsSync(path.join(ROOT, file)))) return;

  const homeHtml = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const pageHtml = readFileSync(path.join(ROOT, 'behavior-lab/index.html'), 'utf8');
  const appSource = readFileSync(path.join(ROOT, 'behavior-lab/assets/js/app.js'), 'utf8');
  const routerSource = readFileSync(path.join(ROOT, 'worker/src/router.js'), 'utf8');
  check(!existsSync(path.join(ROOT, 'behavior-lab/assets/js/core.js'))
    && !existsSync(path.join(ROOT, 'worker/src/behavior-lab.js'))
    && !routerSource.includes('/api/behavior-lab/dashboard')
    && !appSource.includes('/api/behavior-lab/dashboard'),
  'behavior-lab: retired market dashboard assets and API must stay removed');
  check(!appSource.includes('api.bitget.com') && !/<form\b|type=["']submit["']|\baction=/iu.test(pageHtml)
    && !/marketTab|runBacktest|copyDraft|core\.js/iu.test(pageHtml),
  'behavior-lab: browser-direct exchange calls and retired market/draft surfaces are forbidden');
  check(homeHtml.includes('id="ownerLinks"')
    && readFileSync(path.join(ROOT, 'assets/js/home.js'), 'utf8').includes("if (!ownerUsernames.has(String(savedUsername).toLowerCase())) return;")
    && readFileSync(path.join(ROOT, 'assets/js/home.js'), 'utf8').includes("['/behavior-lab/#paper', 'Behavior Lab', 'behaviorLab']"),
    'landing: private Behavior Lab must be created only inside the signed-in exact-owner drawer');
  check(pageHtml.includes('content="noindex, nofollow, noarchive"')
    && /id="labShell"[^>]*\bhidden\b/u.test(pageHtml)
    && appSource.includes("localStorage.getItem('hvsdcm.token')")
    && appSource.includes('authorization: `Bearer ${ownerToken()}`')
    && appSource.includes('/api/behavior-lab/paper'),
  'behavior-lab: owner gate, bearer reads, noindex, and paper tab contract are incomplete');
  check(!pageHtml.includes('id="paperReport"') && !pageHtml.includes('id="paperAdaptive"')
    && appSource.includes('PAPER_REFRESH_MS = 30_000') && appSource.includes('LIVE_REFRESH_MS = 60_000')
    && !appSource.includes('setInterval(') && appSource.includes("document.visibilityState === 'hidden'")
    && appSource.includes('renderEquityChart')
    && appSource.includes("['starting', 'active'].includes(payload.experiment.status)")
    && appSource.includes('curve.length <= 64') && appSource.includes("setAttribute('role', 'img')")
    && appSource.includes("'multi-paper-experiment-v3'")
    && appSource.includes("details.querySelector('.abc-arm-details-body')")
    && routerSource.includes("method === 'GET' && path === '/api/behavior-lab/paper'")
    && routerSource.includes("method === 'GET' && path === '/api/behavior-lab/live'"),
  'behavior-lab: bounded active paper/live dashboard contract is incomplete');

  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const architecture = readFileSync(path.join(ROOT, 'docs/ARCHITECTURE.md'), 'utf8');
  check(readme.includes('/behavior-lab/'), 'README.md: Behavior Lab is missing from the application list');
  check(architecture.includes('GET /api/behavior-lab/paper') && architecture.includes('GET /api/behavior-lab/live'),
    'docs/ARCHITECTURE.md: the private paper/live Behavior Lab API boundary is missing');
}

validateJavaScriptSyntax();
validateHtmlAssets();
validateUiContracts();
validateLandingGating();
validateStudyExposure();
validateLabelledBy();
validateContrastTable();
validateDesignHeadingSequence();
validateDesignTokens();
validateBrandName();
validateNoRenderedEmoji();
validateIconReferences();
validateIconSprite();
validateIconBackgrounds();
validateOgImageLock();
validateGlobalsAndOrder();
validateMigrations();
validateGichulBackend();
validateGichulFrontend();
validateBehaviorLab();
validateWordMasterData();
// M-6 — 스크린샷 대신 남긴 정적 스냅샷. 존재와 "파일 단독으로 열림"을 계약으로 건다.
// 스냅샷이 조용히 사라지거나 외부 자산에 의존하게 되면 시각 확인 근거가 없어진다.
function validateDocSnapshots() {
  // ---- R2-M-1. 스냅샷이 낡으면 실패해야 한다 ----
  // 이전 검사는 파일 존재·인라인 표식·figure 수·다이어그램 제목만 봤다. 그래서 스냅샷 본문의
  // 키워드를 '낡은공유성'으로 바꾼 변형이 13204 checks로 통과했다. 이제 scripts/snapshot.mjs가
  // **현재 커밋의 소스로 스냅샷을 다시 만들어** 커밋된 파일과 그대로 대조한다.
  // 데이터·렌더러·CSS 중 무엇이 바뀌든 `node scripts/snapshot.mjs`를 다시 돌리기 전에는 실패한다.
  const regenerated = buildSnapshots();
  for (const [file, html] of Object.entries(regenerated)) {
    const absolute = path.join(ROOT, file);
    if (!existsSync(absolute)) continue;
    const committed = readFileSync(absolute, 'utf8');
    if (committed === html) {
      check(true, `${file}: snapshot matches the current sources`);
      continue;
    }
    const at = [...html].findIndex((character, index) => committed[index] !== character);
    check(false, `${file}: snapshot is stale — it does not match what scripts/snapshot.mjs produces from the current sources`
      + ` (first difference at offset ${at}: expected "${html.slice(at, at + 60).replace(/\n/gu, '\n')}",`
      + ` found "${committed.slice(at, at + 60).replace(/\n/gu, '\n')}") — run: node scripts/snapshot.mjs`);
  }

  // ---- R4-M-1. 화면 커버리지 ----
  // 완료 조건(plan.md §4)은 4개 화면 **전부**의 스냅샷을 요구했는데, 이전 게이트는
  // diagrams/concept 두 파일만 확인해 화면 두 개가 통째로 없어도 통과했다.
  // 화면 목록을 손으로 적으면 화면이 늘어도 게이트는 모른다 — 게시되는 **진입 HTML**에서
  // 도출해 생성기의 화면→스냅샷 표와 대조한다.
  //
  // 이 검사가 **못 보는 것**: 스냅샷이 그 화면의 "대표 상태"를 담고 있는지(예: 로그인
  // 상태인지, 표에 행이 있는지). 각 스냅샷의 주석 상자가 반영한 상태를 사람이 읽도록 적는다.
  // 그리고 뷰포트별(320/768/1280) 기하는 레이아웃 엔진이 필요해 여기서 재지 못한다.
  const published = publishedHtml().map(relative);
  const screens = published.filter((file) => file === 'index.html' || file.endsWith('/index.html'));
  check(screens.length >= 4, `snapshot coverage: only ${screens.length} entry screens were derived — this check is inert`);
  for (const screen of screens) {
    const snapshot = SNAPSHOT_BY_SCREEN[screen];
    check(Boolean(snapshot),
      `${screen}: no snapshot is declared for this screen — add it to SNAPSHOT_BY_SCREEN in scripts/snapshot.mjs (docs/plan.md §4)`);
    if (!snapshot) continue;
    check(Object.prototype.hasOwnProperty.call(regenerated, snapshot),
      `${snapshot}: scripts/snapshot.mjs no longer produces the snapshot for ${screen}`);
    check(existsSync(path.join(ROOT, snapshot)),
      `${snapshot}: the snapshot for ${screen} is missing — run: node scripts/snapshot.mjs`);
  }

  // ---- B-1. 스냅샷은 공개 배포면 밖에 있어야 한다 ----
  for (const file of Object.values(SNAPSHOT_FILES)) {
    check(!published.includes(file),
      `${file}: the snapshot is on the published surface — it renders study content with no login gate (plan.md §3)`);
  }

  // 아래는 재생성 대조가 깨졌을 때에도 남는 구조 계약이다 (생성기 자체가 잘못될 수 있다).
  for (const file of Object.keys(regenerated)) {
    const absolute = path.join(ROOT, file);
    check(existsSync(absolute), `${file}: visual snapshot is missing — regenerate it (docs/plan.md §4)`);
    if (!existsSync(absolute)) continue;
    const source = readFileSync(absolute, 'utf8');
    check(!/<link\b[^>]*rel=["']stylesheet/iu.test(source) && !/<script\b[^>]*\bsrc=/iu.test(source),
      `${file}: snapshot must inline every stylesheet and carry no scripts so the file opens standalone`);
    check(source.includes('assets/css/system.css (inlined)'),
      `${file}: snapshot must inline /assets/css/system.css`);
  }
  const figuresIn = (file) => (readFileSync(path.join(ROOT, file), 'utf8').match(/<figure class="sm-diagram\b/gu) || []).length;
  const captionsIn = (file) => (readFileSync(path.join(ROOT, file), 'utf8').match(/<figcaption\b/gu) || []).length;
  for (const file of [SNAPSHOT_FILES.DIAGRAMS, SNAPSHOT_BY_SCREEN['smstudy/index.html']]) {
    // 한 figure에 figcaption은 하나뿐이어야 한다 (M-3 회귀 잠금 — 얼린 DOM에서도 확인한다).
    check(figuresIn(file) > 0, `${file}: no rendered diagram found — the frozen DOM lost its figures`);
    check(captionsIn(file) === figuresIn(file),
      `${file}: expected one <figcaption> per <figure>, found ${captionsIn(file)} for ${figuresIn(file)} figures`);
  }
  const diagrams = readFileSync(path.join(ROOT, SNAPSHOT_FILES.DIAGRAMS), 'utf8');
  const notebookData = evaluateBrowserData('_learning/smstudy/notebook-data.js', 'SMSTUDY_NOTEBOOK');
  for (const [id, notebook] of Object.entries(notebookData?.NOTEBOOKS || {})) {
    for (const diagram of notebook.diagrams || []) {
      check(diagrams.includes(`${id} — ${diagram.title} (${diagram.kind}`),
        `${SNAPSHOT_FILES.DIAGRAMS}: missing heading for ${id} — ${diagram.title} (${diagram.kind}) — regenerate the snapshot`);
    }
  }
}

validateSmStudyData();
validatePlStudyData();
validateRenderedCopy();
validateDocSnapshots();

if (failures.length > 0) {
  console.error(`Validation failed (${failures.length}/${checks})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Validation passed (${checks} checks)`);
}
