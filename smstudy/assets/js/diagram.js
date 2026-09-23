(() => {
  'use strict';

  // 개념 다이어그램 렌더러 (plan.md §4.3, kice-analysis.md 부록 D).
  //
  // 조판 원칙 — 사이클3 후속 재설계
  // - **레이아웃은 브라우저가 한다.** 좌표를 손으로 계산해 SVG <text>를 찍으면 글자 길이가
  //   조금만 달라져도 도형·선·글자가 겹치고, 균등 배치된 상자와 화살표는 SmartArt로 보인다.
  //   그래서 관계가 곧 기하학인 두 형식(venn·scale)만 SVG를 남기고, 나머지 다섯 형식은
  //   HTML+CSS 조판(그리드·플렉스·일반 흐름)으로 낸다. 줄바꿈을 브라우저가 하므로
  //   겹침이 원리적으로 발생하지 않는다.
  // - **그림은 도형이 데이터에 없는 관계를 보일 때만 남긴다.** 남은 것은 venn 하나다 —
  //   원의 겹침은 목록으로 옮길 수 없는 정보다. scale의 저울 그림은 지웠다: 두 열 대비
  //   조판이 이미 대립을 말하므로 저울은 같은 말을 그림으로 반복할 뿐이었다.
  // - 남긴 SVG에도 **문장을 넣지 않는다.** venn은 원 안에 한 글자짜리 번호만 둔다.
  // - 레퍼런스는 docs/DESIGN.md §1의 **문제집·참고서 조판**이다. 상자와 화살표 범벅이 아니라
  //   표, 들여쓰기 위계, 얇은 구분선, 여백으로 관계를 말한다.
  // - 색 리터럴을 쓰지 않는다. 색은 style.css의 클래스와 currentColor만 정한다.
  // - **화면에 기획 메모를 내지 않는다.** 형식 이름표 칩과 '왜 이 형식인가'(why)는 제거했다.
  //   학습자에게 필요한 정보가 아니다. 형식 선택 근거는 docs/kice-analysis.md 부록 D에 있다.
  // - **아이콘을 쓰지 않는다.** 노드마다 하나씩 붙는 아이콘은 항목을 구별해 주지 못하고
  //   번호와 겹쳐 장식만 늘린다 (DESIGN.md §4). UI 아이콘은 app.js가 공통 스프라이트에서 직접 쓴다.
  // - 글자 수 상한은 더 이상 좌표가 아니라 **가독성**이 정한다 (아래 게이트 주석 참고).
  //   scripts/validate.mjs의 DIAGRAM_TEXT_LIMITS와 같은 값이어야 한다:
  //     label 14자 / items 28자 / center 14자 / title 20자
  // - 좁은 화면 분기는 venn의 장식 SVG를 숨기는 컨테이너 쿼리 하나뿐이다.
  //   나머지 형식은 CSS 조판이 이미 반응형이라 폴백 목록이 필요 없다.

  // 공통 유틸은 항상 이 파일보다 먼저 로드된다(index.html의 순서 계약). 스냅샷·검증
  // 샌드박스(scripts/render-sandbox.mjs)도 같은 순서로 평가한다. 여기에 폴백 사본을 두면
  // 이스케이프 규칙이 두 벌이 되어 한쪽만 고치는 일이 생긴다.
  const { escapeHtml: esc } = window.HvsStudyUtils;

  // 순서가 의미를 갖는 형식은 <ol>로 낸다. matrix2x2·venn의 번호는 순서가 아니라
  // 도형과 라벨을 짝짓는 열쇠지만, 번호를 화면에 내므로 같은 <ol>을 쓴다.
  const NUMBERED_KINDS = new Set(['flow', 'timeline', 'pyramid', 'matrix2x2', 'venn']);

  // 노드 하나의 제목 줄. 번호는 동그라미 뱃지가 아니라 그냥 숫자이고, 아이콘은 붙이지 않는다
  // (DESIGN.md §4 장식 상한 — 번호와 아이콘을 함께 다는 조판이 이번 피드백의 지적 대상이었다).
  function nodeHead(node, index, numbered) {
    const number = numbered ? `<span class="sm-d-n">${index + 1}</span>` : '';
    return `<p class="sm-d-head">${number}<strong>${esc(node.label)}</strong></p>`;
  }

  function nodeItems(node) {
    const list = node.items || [];
    if (!list.length) return '';
    return `<ul class="sm-d-items">${list.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`;
  }

  // 모든 형식이 공유하는 노드 컨테이너. data-node는 게이트가 "출력 노드 수 = 데이터 노드 수"를
  // 세는 표지이자 CSS 선택자다.
  function nodeCell(node, index, numbered, className = '') {
    return `<li class="sm-d-node${className ? ` ${className}` : ''}" data-node>`
      + `${nodeHead(node, index, numbered)}${nodeItems(node)}</li>`;
  }

  function nodeList(kind, nodes, listClass, cellClass) {
    const numbered = NUMBERED_KINDS.has(kind);
    const tag = numbered ? 'ol' : 'ul';
    const cells = nodes.map((node, index) => nodeCell(node, index, numbered, cellClass)).join('');
    return `<${tag} class="${listClass}">${cells}</${tag}>`;
  }

  function art(viewBox, body) {
    return `<div class="sm-d-art">`
      + `<svg class="sm-d-svg" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">${body}</svg>`
      + `</div>`;
  }

  // ---- kind별 레이아웃 -------------------------------------------------------

  // 판별 순서를 세로 스테퍼로 조판한다. 번호 거터를 지나는 얇은 연결선(CSS)이
  // 단계의 이어짐을 말하고, 각 단계의 판정 결과는 라벨 바로 아래 들여쓰기로 붙는다.
  function layoutFlow(diagram) {
    return nodeList('flow', diagram.nodes, 'sm-d-flow');
  }

  // 대립하는 두 극 — **대립 2열**. 예전에는 여기에 저울 SVG를 얹었지만, 두 열을 나란히 놓은
  // 조판이 이미 "같은 축의 정반대"를 말한다. 저울 그림은 같은 말을 반복하는 장식이라 지웠다.
  // kind 이름 'scale'은 데이터 계약이라 유지하고, 조판만 두 열 대비로 바꿨다.
  function layoutScale(diagram) {
    return nodeList('scale', diagram.nodes.slice(0, 2), 'sm-d-poles');
  }

  // 두 기준이 교차해 만드는 네 칸. nodes 순서는 좌상·우상·좌하·우하다(부록 D).
  // 축 이름은 데이터에 없으므로 라벨을 붙이지 않는다. 교차는 칸 사이 실선이 말한다.
  function layoutMatrix2x2(diagram) {
    return nodeList('matrix2x2', diagram.nodes.slice(0, 4), 'sm-d-quads');
  }

  // 원의 교집합이 곧 의미이므로 원은 SVG로 그린다. 원 안에는 한 글자짜리 번호만 두고
  // (계약 상한 14자짜리 라벨은 3원 벤의 배타 영역에 들어가지 않는다) 이름과 세부는 아래 범례로 뺀다.
  // 번호 자리는 각 원의 배타 영역 중심이라 어떤 데이터에서도 선·다른 원과 겹치지 않는다.
  function layoutVenn(diagram) {
    const nodes = diagram.nodes.slice(0, 3);
    const three = nodes.length >= 3;
    const circles = three
      ? [[185, 135], [295, 135], [240, 225]]
      : [[180, 150], [300, 150]];
    const radius = three ? 95 : 105;
    const marks = three
      ? [[135, 108], [345, 108], [240, 282]]
      : [[135, 150], [345, 150]];
    const shapes = circles
      .map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="${radius}" class="sm-d-venn"/>`)
      .join('');
    const digits = nodes
      .map((node, index) => `<text x="${marks[index][0]}" y="${marks[index][1]}" class="sm-d-mark" text-anchor="middle" dominant-baseline="central">${index + 1}</text>`)
      .join('');
    return art(three ? '0 0 480 340' : '0 0 480 300', shapes + digits)
      + nodeList('venn', nodes, 'sm-d-legend');
  }

  // 시간 축 위의 단계. 위아래 교대 배치(겹침의 주원인)를 없애고 그리드 열로 편다.
  // grid-auto-flow가 열을 만들므로 단계 수를 마크업이 알 필요가 없다.
  function layoutTimeline(diagram) {
    return nodeList('timeline', diagram.nodes, 'sm-d-timeline');
  }

  // 위가 좁고 아래가 넓은 층. 폭이 줄어드는 가로 막대를 CSS가 그리고, 글자는 일반 흐름으로
  // 막대 안에 들어간다. 사다리꼴 안에 글자를 맞춰 넣는 계산이 사라진다.
  function layoutPyramid(diagram) {
    return nodeList('pyramid', diagram.nodes, 'sm-d-pyramid');
  }

  // 중심 개념 하나에서 대등한 갈래가 뻗는 지도. 바퀴살 자체는 정보를 주지 않으므로
  // 중심을 제목 줄로 올리고 갈래는 카드 그리드로 편다.
  function layoutRadial(diagram) {
    const center = diagram.center || diagram.title;
    return `<p class="sm-d-center"><strong>${esc(center)}</strong></p>`
      + nodeList('radial', diagram.nodes, 'sm-d-cards');
  }

  const LAYOUTS = {
    flow: layoutFlow,
    scale: layoutScale,
    matrix2x2: layoutMatrix2x2,
    venn: layoutVenn,
    timeline: layoutTimeline,
    pyramid: layoutPyramid,
    radial: layoutRadial,
  };

  // ---- 설명문 ---------------------------------------------------------------

  function labelsOf(diagram) {
    return diagram.nodes.map((node) => node.label);
  }

  // 조사 선택 — 데이터의 라벨을 문장에 넣을 때 받침 유무로 이/가, 과/와, 을/를을 고른다.
  // 이 처리가 없으면 '반문화이', '공공 부조과' 같은 문장이 캡션에 그대로 나간다.
  function hasFinalConsonant(word) {
    const text = String(word).trim();
    const code = text.charCodeAt(text.length - 1);
    if (Number.isNaN(code) || code < 0xac00 || code > 0xd7a3) return false;
    return (code - 0xac00) % 28 !== 0;
  }

  function withParticle(word, afterConsonant, afterVowel) {
    return `${word}${hasFinalConsonant(word) ? afterConsonant : afterVowel}`;
  }

  // 둘이면 '과/와'로, 셋 이상이면 쉼표로 잇는다 ('A과 B과 C'는 한국어 문장이 아니다).
  function joinWith(words) {
    if (words.length <= 1) return words[0] || '';
    if (words.length === 2) return `${withParticle(words[0], '과', '와')} ${words[1]}`;
    return words.join(', ');
  }

  function narrative(diagram) {
    const labels = labelsOf(diagram);
    const first = labels[0];
    const last = labels[labels.length - 1];
    switch (diagram.kind) {
      case 'flow':
        return `${first}부터 ${last}까지 ${labels.length}단계를 위에서 아래로 차례로 판정한다.`;
      case 'scale':
        return `${withParticle(joinWith(labels), '이', '가')} 하나의 축에서 정반대에 놓인다.`;
      case 'matrix2x2':
        return `두 기준이 교차해 ${labels.join(', ')}의 네 칸이 만들어진다.`;
      case 'venn':
        return `${withParticle(joinWith(labels), '이', '가')} 서로 겹칠 수 있다는 점을 원의 교집합으로 보인다.`;
      case 'timeline':
        return `${first}에서 ${last}까지 ${labels.length}단계가 시간 순서로 이어진다.`;
      case 'pyramid':
        return `위의 ${first}에서 아래의 ${last}까지 ${labels.length}층으로 쌓인 구조다.`;
      case 'radial':
        return `${withParticle(diagram.center || diagram.title, '을', '를')} ${labels.length}갈래로 나눠 우열 없이 나란히 놓는다.`;
      default:
        return `${labels.join(', ')}의 관계를 보인다.`;
    }
  }

  // ---- 공개 API -------------------------------------------------------------

  function renderDiagram(diagram) {
    const layout = LAYOUTS[diagram.kind];
    if (!layout || !Array.isArray(diagram.nodes) || diagram.nodes.length === 0) return '';
    // figure 하나에 figcaption은 하나만 올 수 있고 첫째 또는 마지막 자식이어야 한다
    // (HTML 콘텐츠 모델, review 3c M-3). 제목 줄은 일반 div로 내리고, 서술형 설명을
    // 유일한 figcaption으로 남겨 figure의 접근 가능한 이름이 그 문장이 되게 한다.
    // figcaption은 **화면에서 감춘다**(.sm-diagram-note가 시각적으로 숨긴다) — 제목과 조판이
    // 이미 같은 내용을 말하므로 눈으로 읽을 사람에게는 중복이고, 스크린리더에는 필요하다.
    return `
      <figure class="sm-diagram sm-diagram--${esc(diagram.kind)}">
        <div class="sm-diagram-head"><strong>${esc(diagram.title)}</strong></div>
        ${layout(diagram)}
        <figcaption class="sm-diagram-note">${esc(diagram.title)} — ${esc(narrative(diagram))}</figcaption>
      </figure>`;
  }

  window.SMSTUDY_DIAGRAM = Object.freeze({
    KINDS: Object.freeze(Object.keys(LAYOUTS)),
    renderDiagram,
  });
})();
