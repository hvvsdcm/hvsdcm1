// 렌더러를 **실제로 실행**해 결과 마크업과 "런타임에 읽힌 필드"를 얻는 공용 모듈.
//
// 왜 필요한가 (review 라운드 2, R2-B-1)
//   필드 이름을 소스 정규식으로 긁는 방식은 표현에 취약하다. `const alias = note` 뒤에
//   `alias.gateGhost`를 쓰면 정규식은 못 보고, 그 필드는 계약에도 데이터에도 없는 채
//   화면에 undefined로 나간다. 그래서 접근을 뒤집는다 —
//   데이터를 Proxy로 감싸 **렌더 중 실제로 읽힌 키를 런타임에 수집**하고,
//   동시에 **출력 마크업에 undefined·null·빈 슬롯이 없는지** 본다.
//   이름을 몰라도 누락이 잡히고, 어떤 변수 별칭을 거쳐도 get 트랩은 반드시 지난다.
//
// 정규식 도출(derivedRenderedFields)은 폐기하지 않고 **보조 수단**으로 남겨 합집합을 쓴다.
// 여기서 실행하지 않는 경로를 소스 스캔이 대신 덮기 때문이다.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = process.cwd();

export const APP_SOURCE = 'smstudy/assets/js/app.js';
export const DIAGRAM_SOURCE = 'smstudy/assets/js/diagram.js';
export const DATA_SOURCE = '_learning/smstudy/data.js';
export const NOTEBOOK_SOURCE = '_learning/smstudy/notebook-data.js';
export const EXPLANATION_SOURCE = '_learning/smstudy/explanation-data.js';
export const UTILS_SOURCE = 'assets/js/study-utils.js';

// R3-M-1 — `core.autocrlf=true` 체크아웃에서 소스가 CRLF로 내려와도 판정이 같아야 한다.
// 함수 경계 정규식·스냅샷 생성·문자열 매칭이 모두 이 함수를 지나므로 여기서 LF로 접는다.
export function readSource(file) {
  return readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/gu, '\n');
}

// 브라우저 전역에 얹히는 데이터 파일을 격리 VM에서 평가해 export 객체를 돌려준다.
export function evaluateBrowserData(file, exportedName) {
  const context = {};
  context.window = context;
  vm.createContext(context);
  vm.runInContext(readSource(file), context, { filename: file });
  return context[exportedName];
}

// 다이어그램은 콘텐츠 시각화만 렌더한다. UI 아이콘은 app.js가 공통 스프라이트에서 직접 쓴다.
export function evaluateDiagramRenderer() {
  const context = {};
  context.window = context;
  vm.createContext(context);
  vm.runInContext(readSource(DIAGRAM_SOURCE), context, { filename: DIAGRAM_SOURCE });
  return context.SMSTUDY_DIAGRAM;
}

// ---- 런타임 필드 수집 Proxy -------------------------------------------------

const TRACK_SKIP = new Set([
  'length', 'constructor', 'toString', 'valueOf', 'toJSON', 'then', 'inspect',
]);

// 원본 원소를 그대로 담은 새 배열을 돌려주는 메서드 — 결과도 계속 추적한다.
// map/flatMap은 여기 없다. 결과가 **파생 객체**라 추적하면 데이터에 없는 경로가 잡힌다
// (예: tags.map((tag) => ({tag, hits}))가 exam.tags[].hits로 잘못 기록됐다).
const ARRAY_VIEW_METHODS = new Set([
  'slice', 'filter', 'concat', 'flat', 'reverse', 'sort', 'toSorted', 'toReversed',
]);
// 원본 원소 하나를 돌려주는 메서드.
const ARRAY_ELEMENT_METHODS = new Set(['find', 'at', 'pop', 'shift']);

// value를 감싸 "읽힌 경로"를 into에 모은다.
//   note.matrix.title          -> 'matrix', 'matrix.title'
//   note.recall.map((x) => …)  -> 'recall', 'recall[].question', …
// stopAt에 든 경로에서는 더 내려가지 않는다 (diagrams는 diagram.js의 계약이 따로 본다).
export function trackReads(value, into, stopAt = new Set(), path = '') {
  if (value === null || typeof value !== 'object') return value;
  if (stopAt.has(path)) return value;

  if (Array.isArray(value)) {
    return new Proxy(value, {
      get(target, key, receiver) {
        const raw = Reflect.get(target, key, receiver);
        if (typeof key === 'symbol') return raw;
        if (/^\d+$/u.test(key)) return trackReads(raw, into, stopAt, `${path}[]`);
        if (typeof raw !== 'function') return raw;
        // map/filter/forEach/slice… 의 콜백 인자와 배열 결과도 계속 추적한다.
        // 추적을 여기서 끊으면 diagram.js의 `nodes.slice(0, 4).forEach(...)` 같은
        // 경로가 통째로 빠져 별칭 우회와 같은 사각지대가 다시 생긴다.
        return (...args) => {
          const wrapped = args.map((argument) => (typeof argument === 'function'
            ? (element, ...rest) => argument(trackReads(element, into, stopAt, `${path}[]`), ...rest)
            : argument));
          const result = raw.apply(target, wrapped);
          if (ARRAY_VIEW_METHODS.has(key) && Array.isArray(result)) return trackReads(result, into, stopAt, path);
          if (ARRAY_ELEMENT_METHODS.has(key)) return trackReads(result, into, stopAt, `${path}[]`);
          return result;
        };
      },
    });
  }

  return new Proxy(value, {
    get(target, key, receiver) {
      const raw = Reflect.get(target, key, receiver);
      if (typeof key === 'symbol' || TRACK_SKIP.has(key)) return raw;
      const next = path ? `${path}.${key}` : key;
      if (typeof raw === 'function') return raw;
      into.add(next);
      return trackReads(raw, into, stopAt, next);
    },
  });
}

// ---- app.js 실행 샌드박스 ---------------------------------------------------

// app.js는 IIFE라 내부 렌더러를 밖에서 부를 수 없다. 마지막 `})();` 직전에 export 한 줄을
// 끼워 넣어 **원본 소스 그대로** 평가하고 닫힘(closure) 상태까지 실제와 같게 만든다.
// (함수 본문만 오려 붙이면 모듈 상단의 상수·파생 데이터가 빠져 실제 렌더와 달라진다.)
const RENDERER_NAMES = ['renderConcept', 'renderQuestionMedia', 'renderHome', 'renderStats'];

function stubElement(store, id) {
  const element = {
    id,
    innerHTML: '',
    outerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    hidden: false,
    disabled: false,
    complete: false,
    naturalWidth: 0,
    dataset: {},
    style: {},
    files: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    listeners: {},
    addEventListener(type, handler) { this.listeners[type] = handler; },
    removeEventListener(type) { delete this.listeners[type]; },
    setAttribute() {},
    removeAttribute() {},
    getAttribute() { return null; },
    focus() {},
    blur() {},
    click() {},
    scrollIntoView() {},
    scrollTo() {},
    appendChild() {},
    removeChild() {},
    remove() {},
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  if (store && id) store.set(id, element);
  return element;
}

function stubDocument(store) {
  const documentStub = {
    getElementById(id) { return store.get(id) || stubElement(store, id); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement(tag) { return stubElement(null, tag); },
    addEventListener() {},
    removeEventListener() {},
    activeElement: null,
    body: stubElement(null, 'body'),
    documentElement: stubElement(null, 'html'),
  };
  return documentStub;
}

// notebooks를 Proxy로 감싸 단원별로 "읽힌 필드"를 모으는 객체를 만든다.
function trackedNotebooks(notebooks, into, stopAt) {
  const wrapped = {};
  for (const [id, notebook] of Object.entries(notebooks)) {
    Object.defineProperty(wrapped, id, {
      enumerable: true,
      get: () => trackReads(notebook, into, stopAt),
    });
  }
  return wrapped;
}

/**
 * app.js를 실제 데이터로 실행해 렌더러 핸들을 돌려준다.
 * @param {{trackNoteFields?: Set<string>, stopAt?: Set<string>}} options
 */
export function createAppSandbox(options = {}) {
  const store = new Map();
  const context = {};
  context.window = context;
  context.document = stubDocument(store);
  context.navigator = { userAgent: 'gate', clipboard: { writeText: () => Promise.resolve() } };
  context.location = { href: 'about:blank', hash: '', search: '' };
  context.localStorage = {
    store: new Map(),
    getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
    setItem(key, value) { this.store.set(key, String(value)); },
    removeItem(key) { this.store.delete(key); },
  };
  context.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  context.requestAnimationFrame = (callback) => { callback(0); return 0; };
  context.setTimeout = (callback) => { void callback; return 0; };
  context.clearTimeout = () => {};
  context.confirm = () => false;
  context.alert = () => {};
  context.URL = URL;
  context.Blob = class { constructor() { this.size = 0; } };
  context.console = { log() {}, warn() {}, error() {} };
  vm.createContext(context);

  for (const file of [UTILS_SOURCE, DIAGRAM_SOURCE, DATA_SOURCE, NOTEBOOK_SOURCE, EXPLANATION_SOURCE]) {
    vm.runInContext(readSource(file), context, { filename: file });
  }

  if (options.trackNoteFields) {
    const notebook = context.SMSTUDY_NOTEBOOK;
    context.SMSTUDY_NOTEBOOK = {
      ...notebook,
      NOTEBOOKS: trackedNotebooks(notebook.NOTEBOOKS, options.trackNoteFields, options.stopAt || new Set()),
    };
  }

  const source = readSource(APP_SOURCE);
  const readyMarker = '\n  const ready = window.SMSTUDY_CONTENT_READY;';
  const exportLine = `\n  window.__GATE_RENDERERS__ = { ${RENDERER_NAMES.join(', ')} };\n  }\n${readyMarker}`;
  const patched = source.replace(`\n  }\n${readyMarker}`, exportLine);
  if (patched === source) throw new Error(`${APP_SOURCE}: could not append the gate export line inside start() — the bootstrap tail changed shape`);
  vm.runInContext(patched, context, { filename: APP_SOURCE });

  const renderers = context.__GATE_RENDERERS__;
  if (!renderers || typeof renderers.renderConcept !== 'function') {
    throw new Error(`${APP_SOURCE}: renderConcept is not reachable — the render sandbox is broken`);
  }
  return {
    renderers,
    context,
    // renderConcept()는 반환값이 아니라 #app의 innerHTML에 쓴다.
    renderConcept(id) {
      renderers.renderConcept(id);
      return store.get('app')?.innerHTML || '';
    },
    notebookIds: Object.keys(context.SMSTUDY_NOTEBOOK.NOTEBOOKS),
  };
}

// WordMaster의 app.js도 IIFE이고, 로드 끝에서 스스로 renderHome()을 불러 #app에 쓴다.
// 그래서 export 라인을 끼울 필요 없이 **원본 그대로** 평가하고 #app의 innerHTML을 읽으면
// 실제 첫 화면이 그대로 나온다. window.HvsAccount 접근은 전부 옵셔널 체이닝이라
// account.js 없이도 안전하다 (계정 동기화는 스냅샷의 대상이 아니다).
export const WORDMASTER_APP_SOURCE = 'WordMaster/assets/js/app.js';
export function renderWordMasterHome() {
  const store = new Map();
  const context = {};
  context.window = context;
  context.document = stubDocument(store);
  context.navigator = { userAgent: 'gate' };
  context.location = { href: 'about:blank', hash: '', search: '' };
  context.localStorage = {
    store: new Map(),
    getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
    setItem(key, value) { this.store.set(key, String(value)); },
    removeItem(key) { this.store.delete(key); },
  };
  context.setTimeout = (callback) => { void callback; return 0; };
  context.clearTimeout = () => {};
  context.requestAnimationFrame = (callback) => { callback(0); return 0; };
  context.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  context.confirm = () => false;
  context.alert = () => {};
  context.console = { log() {}, warn() {}, error() {} };
  vm.createContext(context);
  for (const file of [UTILS_SOURCE, '_learning/wordmaster/words.js', WORDMASTER_APP_SOURCE]) {
    vm.runInContext(readSource(file), context, { filename: file });
  }
  const markup = store.get('app')?.innerHTML || '';
  if (!markup.includes('view-head')) {
    throw new Error(`${WORDMASTER_APP_SOURCE}: the first view did not render — the WordMaster snapshot sandbox is broken`);
  }
  return markup;
}

// 기출의 app.js도 IIFE다. 필터와 결과를 문자열로 만드는 렌더러를 window.GICHUL_RENDER에
// 얹어 두었으므로, 소스를 **그대로** 평가하고 fixture로 부르면 실제 화면 마크업이 나온다.
// 로그인 게이트 때문에 토큰을 미리 심고, 매니페스트 fetch는 영원히 대기하는 프라미스로
// 둔다 — 스냅샷의 입력은 네트워크가 아니라 고정 표본이다.
export const GICHUL_APP_SOURCE = 'gichul/app.js';
export function createGichulRenderers(options = {}) {
  const store = new Map();
  const context = {};
  context.window = context;
  context.document = stubDocument(store);
  context.navigator = { userAgent: 'gate' };
  context.location = {
    href: 'https://hvsdcm1.xyz/gichul/',
    pathname: '/gichul/',
    search: '',
    hash: '',
    replace() { throw new Error(`${GICHUL_APP_SOURCE}: the login gate fired inside the snapshot sandbox`); },
    assign() {},
    reload() {},
  };
  context.localStorage = {
    store: new Map([['hvsdcm.token', 'gate-token']]),
    getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
    setItem(key, value) { this.store.set(key, String(value)); },
    removeItem(key) { this.store.delete(key); },
  };
  // account.js는 스냅샷 대상이 아니다 — 화면이 쓰는 계약(api/request)만 대신 세운다.
  context.HvsAccount = { api: () => new Promise(() => {}), request: () => new Promise(() => {}) };
  context.setTimeout = (callback) => { void callback; return 0; };
  context.clearTimeout = () => {};
  context.console = { log() {}, warn() {}, error() {} };
  vm.createContext(context);
  const originalSource = readSource(GICHUL_APP_SOURCE);
  const source = typeof options.sourceTransform === 'function'
    ? options.sourceTransform(originalSource)
    : originalSource;
  if (typeof source !== 'string' || !source.length) {
    throw new Error(`${GICHUL_APP_SOURCE}: sourceTransform이 유효한 소스를 반환하지 않았습니다.`);
  }
  vm.runInContext(source, context, { filename: GICHUL_APP_SOURCE });

  const renderers = context.GICHUL_RENDER;
  if (typeof renderers?.renderFilters !== 'function'
    || typeof renderers?.renderBody !== 'function'
    || typeof renderers?.defaultState !== 'function') {
    throw new Error(`${GICHUL_APP_SOURCE}: renderFilters/renderBody are not reachable — the gichul snapshot sandbox is broken`);
  }
  return renderers;
}

export function renderGichulScreen(manifest, state) {
  const renderers = createGichulRenderers();
  const merged = { ...renderers.defaultState(), ...state };
  const filters = renderers.renderFilters(manifest, merged);
  const body = renderers.renderBody(manifest, merged);
  if (!filters.includes('sidebar-item') || !body.includes('list-group')) {
    throw new Error(`${GICHUL_APP_SOURCE}: the gichul screen rendered without its filter or result contracts`);
  }
  return { filters, body };
}

// 함수 **본문 경계**를 잡는다. 소스 전체 정규식으로 마크업을 찾으면 함수 밖의 같은 모양
// 문자열을 잡을 수 있다 (review R2-B-3: 앞선 미사용 <figure> 문자열이 진짜 검사를 가렸다).
export function functionBody(source, name) {
  // 호출자가 정규화하지 않은 문자열을 넘겨도 안전하도록 여기서도 CRLF를 접는다 (R3-M-1).
  const text = source.replace(/\r\n/gu, '\n');
  const header = new RegExp(`^(\\s*)(?:async )?function ${name}\\s*\\(`, 'mu').exec(text);
  if (!header) return null;
  const indent = header[1];
  const tail = new RegExp(`\\n${indent}\\}`, 'u').exec(text.slice(header.index));
  if (!tail) return null;
  return text.slice(header.index, header.index + tail.index + tail[0].length);
}
