// 기출 화면 컨트롤러 (WP2).
//
// 계약 (sessions/2026-08-28-기출-탭/plan.md §4)
//   - 시험 목록 데이터는 오직 GET /api/gichul/manifest에서 온다. 정적 문서·이 파일에
//     시험 목록을 적지 않는다. 과목·학년도·시행·선택과목 필터의 **선택지 자체도**
//     매니페스트에서 도출한다 (승격 규칙 "파생 가능한 것을 손으로 적지 않는다").
//   - 미로그인은 렌더 전에 랜딩으로 되돌린다. account.js와 같은 판정이며, 서버도
//     같은 규칙을 강제한다(매니페스트·PDF 모두 bearer 세션 검사 뒤에만 존재).
//   - 병합 순서는 목록 표시 순서다: 학년도 오름차순 → 6월·9월·수능 → 과목 → 선택과목.
//   - fetch가 하나라도 실패하면 **부분 병합 파일을 만들지 않고** 실패 항목을 나열한다.
//
// 이 파일이 **하지 않는 것**: PDF 페이지 구간의 옳고 살핌(그것은 매니페스트 생성기가
// 실 PDF와 대조한다), 권한 판정(Worker가 한다), 진도 저장(기출은 저장할 진도가 없어
// account.js를 게이트 전용 모드로 싣는다).
(() => {
  'use strict';

  const FILTER_KEY = 'hvsdcm.gichul.filters.v1';

  // pdf-lib은 병합 버튼을 실제로 눌렀을 때만 필요하다. 예전에는 index.html이
  // <script src>로 항상 먼저 받아서 첫 화면 전송량의 78%(526KB raw / 207KB gzip)를
  // 차지했다. 이제 병합 시점에 동적으로 받고, 같은 문서 안에서는 한 번만 받는다.
  const PDF_LIB_SRC = '/assets/vendor/pdf-lib/pdf-lib.min.js';
  let pdfLibPromise = null;
  function loadPdfLib() {
    if (window.PDFLib) return Promise.resolve(window.PDFLib);
    if (!pdfLibPromise) {
      pdfLibPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = PDF_LIB_SRC;
        script.onload = () => (window.PDFLib
          ? resolve(window.PDFLib)
          : reject(new Error('PDF 라이브러리를 읽지 못했습니다.')));
        script.onerror = () => {
          // 다음 시도가 다시 받을 수 있게 실패한 약속은 버린다.
          pdfLibPromise = null;
          reject(new Error('PDF 라이브러리를 받지 못했습니다.'));
        };
        document.head.append(script);
      });
    }
    return pdfLibPromise;
  }

  // 라벨은 화면 표기의 단일 원본이다. 매니페스트는 코드(korean/hwajak/06)만 담고,
  // 사람이 읽는 이름은 여기 한 곳에서만 정의한다.
  const SUBJECT_LABEL = {
    korean: '국어',
    math: '수학',
    english: '영어',
    soc_culture: '사회·문화',
    politics_law: '정치와 법',
  };
  // 2022학년도 이전 명칭이 다른 과목의 각주. 같은 과목 계보를 필터 하나로 노출한다.
  const SUBJECT_NOTE = {
    politics_law: '2022학년도 이전 명칭은 “법과 정치”입니다.',
    korean: '2022학년도부터 공통 + 화법과 작문 · 언어와 매체 체제입니다.',
    math: '2022학년도부터 공통 + 확률과 통계 · 미적분 · 기하, 그 이전은 가형 · 나형입니다.',
  };
  const TRACK_LABEL = {
    hwajak: '화법과 작문',
    eonmae: '언어와 매체',
    hwaktong: '확률과 통계',
    mijeok: '미적분',
    giha: '기하',
    ga: '가형',
    na: '나형',
  };
  // 파일명에 들어가는 짧은 표기 (예: 2024-06-국어-화작.pdf).
  const TRACK_SHORT = {
    hwajak: '화작', eonmae: '언매', hwaktong: '확통', mijeok: '미적', giha: '기하', ga: '가', na: '나',
  };
  const ROUND_LABEL = { '06': '6월', '09': '9월', csat: '수능' };
  const ROUND_FILE = { '06': '06', '09': '09', csat: '수능' };

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  // 오류 배너 아이콘 — 사이트 공통 스프라이트(assets/ui-icons.svg) 하나뿐이다(DESIGN.md §5).
  // 선 색은 .ui-icon 기본값(--text-3)이고 상태는 배너 제목과 보더가 말한다.
  function alertIcon() {
    return '<svg class="ui-icon" aria-hidden="true"><use href="/assets/ui-icons.svg?v=20260904-icons-v2#icon-alert-triangle"></use></svg>';
  }

  // ---- 매니페스트에서 도출하는 것들 -----------------------------------------

  const questionsOf = (manifest) => (manifest?.exams || []).filter((exam) => exam?.kind === 'question');

  function preferredValues(manifest, type, subject) {
    const availability = manifest?.availability;
    if (type === 'subjects') return (availability?.subjects || []).map(({ id }) => id);
    if (type === 'rounds') return (availability?.rounds || []).map(({ id }) => id);
    if (type === 'tracks') {
      return (availability?.subjects || []).find(({ id }) => id === subject)?.tracks?.map(({ id }) => id) || [];
    }
    return [];
  }

  function comparePreferred(left, right, preferred) {
    const leftIndex = preferred.indexOf(left);
    const rightIndex = preferred.indexOf(right);
    const leftRank = leftIndex === -1 ? preferred.length : leftIndex;
    const rightRank = rightIndex === -1 ? preferred.length : rightIndex;
    return leftRank - rightRank || String(left ?? '').localeCompare(String(right ?? ''));
  }

  function orderedDistinct(values, preferred) {
    return [...new Set(values)].sort((left, right) => comparePreferred(left, right, preferred));
  }

  function compareExams(left, right, manifest) {
    return left.grade_year - right.grade_year
      || comparePreferred(left.round, right.round, preferredValues(manifest, 'rounds'))
      || comparePreferred(left.subject, right.subject, preferredValues(manifest, 'subjects'))
      || comparePreferred(left.track, right.track, preferredValues(manifest, 'tracks', left.subject));
  }

  // 필터 선택지. 하드코딩하면 매니페스트가 늘어도 화면은 모른다.
  function facetsOf(manifest, subject) {
    const questions = questionsOf(manifest);
    const forSubject = questions.filter((exam) => exam.subject === subject);
    return {
      subjects: orderedDistinct(questions.map((exam) => exam.subject), preferredValues(manifest, 'subjects')),
      years: [...new Set(forSubject.map((exam) => exam.grade_year))].sort((a, b) => a - b),
      rounds: orderedDistinct(forSubject.map((exam) => exam.round), preferredValues(manifest, 'rounds')),
      tracks: orderedDistinct(
        forSubject.map((exam) => exam.track).filter((track) => track !== null),
        preferredValues(manifest, 'tracks', subject),
      ),
    };
  }

  // 빈 집합 = 제한 없음. "아무것도 안 고른 상태"가 곧 "전부"라 첫 화면이 비지 않는다.
  const passes = (values, value) => values.length === 0 || values.includes(value);

  function visibleExams(manifest, state) {
    return questionsOf(manifest)
      .filter((exam) => exam.subject === state.subject
        && passes(state.years, exam.grade_year)
        && passes(state.rounds, exam.round)
        && (exam.track === null || passes(state.tracks, exam.track)))
      .sort((left, right) => compareExams(left, right, manifest));
  }

  const examLabel = (exam) => `${exam.grade_year}학년도 ${ROUND_LABEL[exam.round] || exam.round}`
    + ` ${SUBJECT_LABEL[exam.subject] || exam.subject}`
    + `${exam.track ? ` (${TRACK_LABEL[exam.track] || exam.track})` : ''}`;

  const isExcerptable = (exam) => Array.isArray(exam?.sections?.selection);

  // ---- 렌더 -------------------------------------------------------------------

  // 사이드바 필터 그룹 하나 = system.css의 .disclosure(DESIGN.md §7.2). 그룹 자체가 둥근
  // 컨테이너라 안에 .list-group을 한 번 더 두르지 않고 행을 본문에 직접 넣는다.
  // 항상 open으로 그린다 — 템플릿은 뷰포트 폭을 모른다. 모바일에서 첫 그룹만 남기고
  // 접는 것은 paint()가 matchMedia로 결정한다(data-group이 그 열쇠다).
  // note는 접힌 각주다(§6.1 ②): 사이드바에 서술문을 두지 않고 summary의 툴팁으로 내린다.
  function renderDisclosure(key, title, hint, body, note) {
    return `<details class="disclosure gi-filter" open data-group="${escapeHtml(key)}">`
      + `<summary class="disclosure-head"${note ? ` title="${escapeHtml(note)}"` : ''}>`
      + `<span class="disclosure-title">${escapeHtml(title)}</span>`
      + `<span class="disclosure-hint">${escapeHtml(hint)}</span></summary>`
      + `<div class="disclosure-body gi-filter-body">${body}</div></details>`;
  }

  function renderFilterGroup(title, name, options, chosen, note) {
    if (!options.length) return '';
    // 행에 다른 컨트롤이 없으므로 행 자체를 <label>로 둔다 — 체크박스와 보이는 이름이
    // 하나의 라벨로 묶여 sr-only 사본을 만들 필요가 없다 (DESIGN.md §7.1).
    const rows = options.map(({ value, label }) => `<label class="list-row">`
      + `<span class="list-row-body"><span class="list-row-title">${escapeHtml(label)}</span></span>`
      + `<span class="list-row-accessory">`
      + `<input type="checkbox" data-facet="${escapeHtml(name)}"`
      + ` value="${escapeHtml(value)}"${chosen.includes(value) ? ' checked' : ''}>`
      + `</span></label>`).join('');
    // 빈 선택 = 제한 없음. 그 설명문("고르지 않으면 전부입니다")은 힌트 '전체'가 대신한다.
    const hint = chosen.length ? `${chosen.length}개` : '전체';
    return renderDisclosure(name, title, hint, rows, note);
  }

  function renderFilters(manifest, state) {
    const facets = facetsOf(manifest, state.subject);
    const subjectItems = facets.subjects.map((key) => `<button class="sidebar-item" type="button"`
      + ` data-subject="${escapeHtml(key)}"${key === state.subject ? ' aria-current="page"' : ''}>`
      + `${escapeHtml(SUBJECT_LABEL[key] || key)}</button>`).join('');

    // 옵션 행은 라벨 한 줄이다 — "정답표 포함"은 익숙한 말이라 설명 부제를 달지 않는다(§6.1 ①).
    const downloadRows = [
      {
        key: 'includeAnswers',
        title: '정답표 포함',
        disabled: false,
        checked: state.includeAnswers,
      },
    ].map((option) => {
      const tag = option.disabled ? 'div' : 'label';
      return `<${tag} class="list-row"${option.disabled ? ' aria-disabled="true"' : ''}>`
        + `<span class="list-row-body"><span class="list-row-title">${escapeHtml(option.title)}</span></span>`
        + `<span class="list-row-accessory"><input type="checkbox" data-option="${option.key}"`
        + `${option.checked ? ' checked' : ''}${option.disabled ? ' disabled' : ''}></span></${tag}>`;
    }).join('');

    // 저작권 문장은 푸터가 정본이다 — 같은 문자열을 사이드바에 한 번 더 세우지 않는다.
    return renderDisclosure('subject', '과목', SUBJECT_LABEL[state.subject] || state.subject,
      `<nav class="gi-subjects" aria-label="과목 선택">${subjectItems}</nav>`, '')
      + renderFilterGroup('시행', 'rounds', facets.rounds.map((value) => ({ value, label: ROUND_LABEL[value] || value })), state.rounds, '')
      + renderFilterGroup('학년도', 'years', facets.years.map((value) => ({ value: String(value), label: `${value}학년도` })), state.years.map(String), '')
      + renderFilterGroup('선택과목', 'tracks', facets.tracks.map((value) => ({ value, label: TRACK_LABEL[value] || value })), state.tracks, SUBJECT_NOTE[state.subject] || '')
      + `<div class="sidebar-group"><div class="list-group">${downloadRows}</div></div>`;
  }

  function renderRow(exam, state) {
    const blocked = state.mode === 'excerpt' && !isExcerptable(exam);
    // 반복 메타를 행마다 다시 쓰지 않는다: 과목은 사이드바가, 학년도는 그룹 머리가 이미
    // 말한다. 행 제목은 시행(+선택과목)뿐이고 sr-only 라벨만 전체 이름을 갖는다.
    const title = `${ROUND_LABEL[exam.round] || exam.round}`
      + `${exam.track ? ` · ${TRACK_LABEL[exam.track] || exam.track}` : ''}`;
    // 행 우측 값 한 조각(.list-row-value) — 부제 서술문이 아니라 데이터 값이다(§6.1).
    let value = `${exam.pages}쪽`;
    if (state.mode === 'excerpt') {
      if (blocked) value = '발췌 불가';
      else {
        const [from, to] = exam.sections.selection;
        value = `선택과목만 ${from}–${to}쪽`;
      }
    }
    const id = `gi-pick-${exam.id}`;
    const lead = blocked
      ? ''
      : `<label class="list-row-stretch gi-pick-hit" for="${escapeHtml(id)}">`
        + `<span class="sr-only">${escapeHtml(examLabel(exam))} 선택</span></label>`;
    // chevron(.list-row-nav)은 실제로 이동하는 컨트롤인 "열기"에만 붙인다 — 행 전체의
    // 기본 동작은 선택(체크)이므로 행에 chevron을 달면 거짓 신호가 된다.
    return `<div class="list-row"${blocked ? ' aria-disabled="true"' : ''}>${lead}`
      + `<span class="list-row-body"><span class="list-row-title">${escapeHtml(title)}</span></span>`
      + `<span class="list-row-value">${escapeHtml(value)}</span>`
      + `<span class="list-row-accessory gi-accessory">`
      + `<button class="btn btn-ghost btn-sm list-row-nav" type="button" data-open="${escapeHtml(exam.id)}">열기</button>`
      + `<input type="checkbox" id="${escapeHtml(id)}" data-pick="${escapeHtml(exam.id)}"`
      + `${state.selected.includes(exam.id) ? ' checked' : ''}${blocked ? ' disabled' : ''}></span></div>`;
  }

  function renderResults(exams, state) {
    if (!exams.length) {
      return `<p class="gi-empty">조건에 맞는 시험지가 없습니다. 학년도나 시행을 넓혀 보세요.</p>`;
    }
    const groups = [];
    for (const exam of exams) {
      const last = groups[groups.length - 1];
      if (last && last.year === exam.grade_year) last.items.push(exam);
      else groups.push({ year: exam.grade_year, items: [exam] });
    }
    return groups.map(({ year, items }) => {
      const headingId = `gi-year-${year}`;
      return `<section class="gi-group">`
        + `<h2 class="list-group-head" id="${headingId}">${year}학년도</h2>`
        + `<div class="list-group" role="group" aria-labelledby="${headingId}">`
        + items.map((exam) => renderRow(exam, state)).join('')
        + `</div></section>`;
    }).join('');
  }

  function renderToolbar(exams, state) {
    const pickable = exams.filter((exam) => state.mode !== 'excerpt' || isExcerptable(exam));
    const count = state.selected.length;
    const allPicked = pickable.length > 0 && pickable.every((exam) => state.selected.includes(exam.id));
    return `<div class="toolbar gi-mode-toolbar">`
      + `<div class="segmented" role="group" aria-label="내려받기 범위">`
      + `<button class="segmented-btn" type="button" data-mode="full" aria-pressed="${state.mode === 'full'}">전체 시험지</button>`
      + `<button class="segmented-btn" type="button" data-mode="excerpt" aria-pressed="${state.mode === 'excerpt'}">선택과목 발췌</button>`
      + `</div></div><div class="gi-download-bar" aria-label="선택한 시험지 내려받기">`
      + `<span class="gi-count">선택 ${count}개 / ${pickable.length}개</span>`
      + `<button class="btn btn-secondary btn-sm" type="button" data-bulk="${allPicked ? 'none' : 'all'}"`
      + `${pickable.length ? '' : ' disabled'}>${allPicked ? '전체 해제' : '전체 선택'}</button>`
      + `<button class="btn btn-primary btn-sm" type="button" id="gichulMerge"${count ? '' : ' disabled'}>`
      + `PDF로 병합 내려받기</button></div>`;
  }

  function renderBody(manifest, state) {
    const exams = visibleExams(manifest, state);
    return renderToolbar(exams, state)
      + `<div id="gichulStatus" class="gi-status" role="status" aria-live="polite"></div>`
      + renderResults(exams, state);
  }

  // ---- 병합 계획 ---------------------------------------------------------------

  const answerIdOf = (exam) => `${exam.id.replace(/-question$/u, '')}-answer`;

  // 문제지에 넣는 문항 집합과 그 문항의 답 위치를 한 계약으로 표현한다.
  // 모드별 판단은 여기서만 하고, 문제지와 답안 planner는 같은 part 목록을 소비한다.
  function includedOutputParts(exam, mode, seenQuestionParts) {
    if (mode === 'excerpt') {
      return isExcerptable(exam)
        ? [{ kind: 'selection', questionRange: exam.sections.selection, answerField: 'answer_selection' }]
        : [];
    }
    if (!isExcerptable(exam) || !Array.isArray(exam.sections.common)) {
      const key = `whole\u0000${exam.r2_key}`;
      if (seenQuestionParts.has(key)) return [];
      seenQuestionParts.add(key);
      return [{ kind: 'whole', questionRange: [1, exam.pages], answerField: 'answer_pages' }];
    }

    const parts = [];
    const commonKey = `common\u0000${exam.r2_key}`;
    if (!seenQuestionParts.has(commonKey)) {
      seenQuestionParts.add(commonKey);
      parts.push({ kind: 'common', questionRange: exam.sections.common, answerField: 'answer_common' });
    }
    parts.push({ kind: 'selection', questionRange: exam.sections.selection, answerField: 'answer_selection' });
    return parts;
  }

  // 선택된 항목을 "PDF 조각"의 목록으로 바꾼다. 1-based 포함 구간이며, 순서가 곧 병합 순서다.
  //
  // 같은 PDF를 두 번 담지 않는다: 2022학년도 이후 국어·수학은 화작/언매(확통/미적/기하)가
  // **같은 파일**의 다른 페이지 구간이므로, 전체 모드에서 둘을 함께 고르면 같은 시험지가
  // 두 벌 들어간다. 공통 파트와 정답표도 같은 이유로 파일당 한 번만 담는다.
  function planSegments(exams, manifest, state) {
    const byId = new Map((manifest?.exams || []).map((exam) => [exam.id, exam]));
    const papers = [];
    const answerByPaper = new Map();
    const missingAnswers = [];
    const seenQuestionParts = new Set();
    const reportedMissing = new Set();

    for (const exam of exams) {
      const outputParts = includedOutputParts(exam, state.mode, seenQuestionParts);
      if (!outputParts.length) continue;
      papers.push({
        id: exam.id,
        key: exam.r2_key,
        label: examLabel(exam),
        ranges: outputParts.map(({ questionRange }) => questionRange),
      });

      if (!state.includeAnswers) continue;
      const answer = byId.get(answerIdOf(exam));
      const selectionAnswer = outputParts.every(({ kind }) => kind !== 'whole');
      const answerPagesValid = Array.isArray(answer?.answer_pages) && answer.answer_pages.length > 0;
      const answerRegionsByPart = selectionAnswer
        ? outputParts.map(({ answerField }) => answer?.[answerField])
        : [];
      const answerRegions = answerRegionsByPart.filter((regions) => (
        Array.isArray(regions) && regions.length > 0
      ));
      const missingAnswerPart = selectionAnswer && answerRegions.length !== answerRegionsByPart.length;
      // 정답표가 자체 판정하지 않고 같은 문제지의 provenance-derived canonical_form을 공유한다.
      // 구형/불일치 manifest는 다른 형을 섞지 않고 missing으로 보고한다.
      // 한 part의 crop이 비어 있어도 검증된 나머지 part까지 통째로 버리지는 않는다.
      if (!answer || answer.canonical_form !== exam.canonical_form || !answerPagesValid
        || (selectionAnswer && answerRegions.length === 0)) {
        // 같은 시험지에서 갈라진 선택과목마다 같은 말을 반복하지 않는다.
        if (!reportedMissing.has(exam.r2_key)) {
          reportedMissing.add(exam.r2_key);
          missingAnswers.push(examLabel(exam));
        }
        continue;
      }
      if (missingAnswerPart && !reportedMissing.has(exam.r2_key)) {
        reportedMissing.add(exam.r2_key);
        missingAnswers.push(examLabel(exam));
      }
      let planned = answerByPaper.get(exam.r2_key);
      if (!planned) {
        planned = {
          id: answer.id,
          key: answer.r2_key,
          label: `${examLabel(exam)} 정답표`,
          ...(selectionAnswer ? { clips: [] } : { ranges: [] }),
        };
        answerByPaper.set(exam.r2_key, planned);
      } else if (planned.key !== answer.r2_key) {
        throw new Error(`${examLabel(exam)}: 같은 문제지의 정답표 파일이 서로 다릅니다.`);
      }
      if (selectionAnswer) {
        for (const regions of answerRegions) {
          for (const clip of regions) {
            if (!planned.clips.some((candidate) => candidate.page === clip.page
              && candidate.x?.[0] === clip.x?.[0] && candidate.x?.[1] === clip.x?.[1]
              && candidate.y?.[0] === clip.y?.[0] && candidate.y?.[1] === clip.y?.[1])) {
              planned.clips.push(clip);
            }
          }
        }
      } else {
        for (const page of answer.answer_pages) {
          if (!planned.ranges.some(([from, to]) => from === page && to === page)) {
            planned.ranges.push([page, page]);
          }
        }
      }
    }

    // 정답표는 그 시험지의 조각이 **전부 끝난 뒤**에 온다. 항목마다 바로 뒤에 붙이면
    // 같은 시험지의 화작 발췌와 언매 발췌 사이에 정답표가 끼어 문서가 읽히지 않는다.
    const segments = [];
    papers.forEach((segment, index) => {
      segments.push(segment);
      const lastOfPaper = !papers.slice(index + 1).some((later) => later.key === segment.key);
      const answer = answerByPaper.get(segment.key);
      if (lastOfPaper && answer) segments.push(answer);
    });
    return { segments, missingAnswers };
  }

  function mergedFilename(exams, state) {
    const safe = (value) => String(value).replace(/[\\/:*?"<>|]/gu, '');
    const suffix = state.mode === 'excerpt' ? '-발췌' : '';
    if (exams.length === 1) {
      const [exam] = exams;
      return safe(`${exam.grade_year}-${ROUND_FILE[exam.round] || exam.round}`
        + `-${SUBJECT_LABEL[exam.subject] || exam.subject}`
        + `${exam.track ? `-${TRACK_SHORT[exam.track] || exam.track}` : ''}${suffix}.pdf`);
    }
    const years = exams.map((exam) => exam.grade_year);
    const first = Math.min(...years);
    const last = Math.max(...years);
    const span = first === last ? `${first}` : `${first}~${last}`;
    const subjects = [...new Set(exams.map((exam) => SUBJECT_LABEL[exam.subject] || exam.subject))];
    const tracks = [...new Set(exams.map((exam) => exam.track).filter(Boolean))]
      .map((track) => TRACK_SHORT[track] || track);
    const rounds = [...new Set(exams.map((exam) => exam.round))].map((round) => ROUND_FILE[round] || round);
    const head = subjects.length === 1
      ? `${subjects[0]}${tracks.length === 1 ? `-${tracks[0]}` : ''}`
      : '기출';
    return safe(`${head}-${span}-${rounds.join('_')}${suffix}.pdf`);
  }

  // ---- 화면 배선 ----------------------------------------------------------------

  function loginPath() {
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return `/?login=1&next=${next}`;
  }

  const defaultState = () => ({
    subject: 'korean',
    years: [],
    rounds: [],
    tracks: [],
    mode: 'full',
    includeAnswers: false,
    selected: [],
  });

  window.GICHUL_RENDER = { renderFilters, renderBody, defaultState, visibleExams, facetsOf, planSegments, mergedFilename };

  // 렌더 전에 세션을 확인한다. 토큰이 없으면 화면을 만들지 않는다 — 목록은 서버가
  // 인증 뒤에만 내려주므로 DOM에 시험 데이터가 사전 존재하는 경로 자체가 없다.
  if (!localStorage.getItem('hvsdcm.token')) {
    location.replace(loginPath());
    return;
  }

  const elements = {
    filters: document.getElementById('gichulFilters'),
    body: document.getElementById('gichulBody'),
    toast: document.getElementById('toast'),
  };

  let manifest = { exams: [] };
  let state = defaultState();
  let busy = false;
  let toastTimer = 0;

  function toast(message) {
    if (!elements.toast) return;
    elements.toast.textContent = message;
    elements.toast.classList.add('open');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => elements.toast.classList.remove('open'), 2600);
  }

  function restoreFilters() {
    try {
      const saved = JSON.parse(localStorage.getItem(FILTER_KEY) || 'null');
      if (!saved || typeof saved !== 'object') return;
      const merged = { ...defaultState(), ...saved, selected: [] };
      // v1 저장값의 includeCommon은 발췌 계약에서 삭제됐다. 펼쳐 합친 뒤에도 명시적으로
      // 지워 오래된 localStorage가 planner나 화면에 다시 들어올 여지를 없앤다.
      delete merged.includeCommon;
      merged.years = Array.isArray(merged.years) ? merged.years.map(Number).filter(Number.isFinite) : [];
      merged.rounds = Array.isArray(merged.rounds)
        ? merged.rounds.filter((value) => typeof value === 'string' && value) : [];
      merged.tracks = Array.isArray(merged.tracks)
        ? merged.tracks.filter((value) => typeof value === 'string' && value) : [];
      if (typeof merged.subject !== 'string' || !merged.subject) merged.subject = 'korean';
      if (merged.mode !== 'excerpt') merged.mode = 'full';
      merged.includeAnswers = merged.includeAnswers === true;
      state = merged;
    } catch {
      state = defaultState();
    }
  }

  function saveFilters() {
    const { selected, ...rest } = state;
    void selected;
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(rest));
    } catch {
      // 저장 실패는 화면 동작과 무관하다 (프라이빗 모드 등).
    }
  }

  // 화면에서 사라진 항목은 선택에서 뺀다. 보이지 않는 시험지가 병합에 섞이면
  // 사용자가 무엇을 받는지 화면으로 확인할 수 없다.
  function pruneSelection() {
    const allowed = new Set(visibleExams(manifest, state)
      .filter((exam) => state.mode !== 'excerpt' || isExcerptable(exam))
      .map((exam) => exam.id));
    state.selected = state.selected.filter((id) => allowed.has(id));
  }

  function paint() {
    pruneSelection();
    const wasOpen = new Set([...elements.filters.querySelectorAll('.gi-filter[open]')]
      .map((details) => details.dataset.group));
    const firstPaint = !elements.filters.children.length;
    elements.filters.innerHTML = renderFilters(manifest, state);
    elements.body.innerHTML = renderBody(manifest, state);
    const summary = document.getElementById('studyFilterSummary');
    if (summary) summary.textContent = `${SUBJECT_LABEL[state.subject] || state.subject} · ${visibleExams(manifest, state).length}개 시험지`;
    if (matchMedia('(max-width: 860px)').matches) {
      elements.filters.querySelectorAll('.gi-filter').forEach((details, index) => {
        details.open = firstPaint ? true : wasOpen.has(details.dataset.group);
      });
    }
  }

  function status(html) {
    const node = document.getElementById('gichulStatus');
    if (node) node.innerHTML = html;
  }

  function failureBanner(title, items) {
    return `<div class="gi-alert" role="alert">${alertIcon()}`
      + `<div class="gi-alert-body"><p class="gi-alert-title">${escapeHtml(title)}</p>`
      + `<ul class="gi-alert-list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      + `</div></div>`;
  }

  async function fetchPdf(id) {
    const response = await window.HvsAccount.request(`/api/gichul/pdf/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.arrayBuffer();
  }

  async function merge() {
    if (busy) return;
    const exams = visibleExams(manifest, state).filter((exam) => state.selected.includes(exam.id));
    if (!exams.length) return;

    const { segments, missingAnswers } = planSegments(exams, manifest, state);
    if (!segments.length) {
      status(failureBanner('내려받을 페이지가 없습니다.', ['선택한 항목에 담을 페이지 구간이 없습니다.']));
      return;
    }

    busy = true;
    const button = document.getElementById('gichulMerge');
    if (button) button.disabled = true;
    status(`<p class="gi-progress">${escapeHtml(`${segments.length}개 파일을 받는 중입니다…`)}</p>`);

    // 라이브러리 내려받기를 PDF 받기와 겹쳐서 대기 시간을 숨긴다. 실패는 아래 catch가
    // "병합에 실패했습니다" 배너로 내보낸다 — 부분 병합 파일은 여전히 만들지 않는다.
    const pdfLibReady = loadPdfLib();

    // 파일 단위로 한 번씩만 받는다. 그리고 **전부 성공한 뒤에만** 병합한다 —
    // 부분 병합 파일은 내놓지 않는다는 계약(plan.md §4)이 여기 구현된다.
    const keys = [...new Set(segments.map((segment) => segment.key))];
    const representative = new Map();
    for (const segment of segments) {
      if (!representative.has(segment.key)) representative.set(segment.key, segment);
    }
    const results = await Promise.allSettled(keys.map((key) => fetchPdf(representative.get(key).id)));
    const failures = [];
    const bytesByKey = new Map();
    results.forEach((result, index) => {
      const key = keys[index];
      if (result.status === 'fulfilled') bytesByKey.set(key, result.value);
      else failures.push(`${representative.get(key).label} — ${result.reason?.message || '받기 실패'}`);
    });

    if (failures.length) {
      busy = false;
      paint();
      status(failureBanner('일부 파일을 받지 못해 병합을 중단했습니다.', failures));
      return;
    }

    try {
      const { PDFDocument } = await pdfLibReady;
      const merged = await PDFDocument.create();
      const loaded = new Map();
      for (const segment of segments) {
        if (!loaded.has(segment.key)) {
          loaded.set(segment.key, await PDFDocument.load(bytesByKey.get(segment.key), { ignoreEncryption: true }));
        }
        const source = loaded.get(segment.key);
        const total = source.getPageCount();
        for (const [from, to] of (segment.ranges || [])) {
          if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > total || from > to) {
            throw new Error(`${segment.label}: 페이지 구간 ${from}–${to}이 실제 문서(${total}쪽)와 맞지 않습니다.`);
          }
          const indices = [];
          for (let page = from; page <= to; page += 1) indices.push(page - 1);
          const copied = await merged.copyPages(source, indices);
          for (const page of copied) merged.addPage(page);
        }
        for (const clip of (segment.clips || [])) {
          const page = clip?.page;
          const from = clip?.x?.[0];
          const to = clip?.x?.[1];
          const bottom = clip?.y?.[0];
          const top = clip?.y?.[1];
          if (!Number.isInteger(page) || page < 1 || page > total
            || !Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > 1 || from >= to
            || !Number.isFinite(bottom) || !Number.isFinite(top) || bottom < 0 || top > 1 || bottom >= top) {
            throw new Error(`${segment.label}: 답안 crop이 실제 문서(${total}쪽)와 맞지 않습니다.`);
          }
          const [copied] = await merged.copyPages(source, [page - 1]);
          const { width, height } = copied.getSize();
          copied.setCropBox(width * from, height * bottom, width * (to - from), height * (top - bottom));
          merged.addPage(copied);
        }
      }

      const blob = new Blob([await merged.save()], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = mergedFilename(exams, state);
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);

      busy = false;
      paint();
      const note = missingAnswers.length
        ? failureBanner('정답표가 없어 건너뛴 회차가 있습니다.', missingAnswers)
        : '';
      status(`<p class="gi-progress">${escapeHtml(`${merged.getPageCount()}쪽을 ${anchor.download}으로 저장했습니다.`)}</p>${note}`);
      toast('병합한 PDF를 내려받았습니다.');
    } catch (error) {
      busy = false;
      paint();
      status(failureBanner('병합에 실패했습니다.', [error?.message || '알 수 없는 오류']));
    }
  }

  async function openOne(id) {
    try {
      const bytes = await fetchPdf(id);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      toast(error?.message === 'unauthorized' ? '로그인이 필요합니다.' : '문제지를 열지 못했습니다.');
    }
  }

  function toggleFacet(name, value, checked) {
    const current = new Set(state[name].map(String));
    if (checked) current.add(String(value));
    else current.delete(String(value));
    state[name] = name === 'years'
      ? [...current].map(Number).sort((a, b) => a - b)
      : [...current];
  }

  function onClick(event) {
    if (event.target.closest('#gichulRetry')) {
      load();
      return;
    }
    const subject = event.target.closest('[data-subject]');
    if (subject) {
      state.subject = subject.dataset.subject;
      // 과목이 바뀌면 그 과목에 없는 선택과목·학년도가 남아 결과를 0건으로 만든다.
      state.tracks = [];
      state.years = [];
      state.selected = [];
      saveFilters();
      paint();
      return;
    }
    const mode = event.target.closest('[data-mode]');
    if (mode) {
      state.mode = mode.dataset.mode;
      saveFilters();
      paint();
      return;
    }
    const bulk = event.target.closest('[data-bulk]');
    if (bulk) {
      const pickable = visibleExams(manifest, state)
        .filter((exam) => state.mode !== 'excerpt' || isExcerptable(exam));
      state.selected = bulk.dataset.bulk === 'all' ? pickable.map((exam) => exam.id) : [];
      paint();
      return;
    }
    const open = event.target.closest('[data-open]');
    if (open) {
      openOne(open.dataset.open);
      return;
    }
    if (event.target.closest('#gichulMerge')) merge();
  }

  function onChange(event) {
    const target = event.target;
    if (target.dataset.facet) {
      toggleFacet(target.dataset.facet, target.value, target.checked);
      state.selected = [];
      saveFilters();
      paint();
      return;
    }
    if (target.dataset.option) {
      state[target.dataset.option] = target.checked;
      saveFilters();
      paint();
      return;
    }
    if (target.dataset.pick) {
      const id = target.dataset.pick;
      state.selected = target.checked
        ? [...new Set([...state.selected, id])]
        : state.selected.filter((value) => value !== id);
      paint();
    }
  }

  async function load() {
    elements.filters.innerHTML = '';
    elements.body.innerHTML = '<p class="gi-empty">시험 목록을 불러오는 중입니다…</p>';
    try {
      const data = await window.HvsAccount.api('/api/gichul/manifest');
      manifest = {
        availability: data?.availability,
        exams: Array.isArray(data?.exams) ? data.exams : [],
      };
      const subjects = facetsOf(manifest, state.subject).subjects;
      if (subjects.length && !subjects.includes(state.subject)) state.subject = subjects[0];
      const facets = facetsOf(manifest, state.subject);
      state.years = state.years.filter((value) => facets.years.includes(value));
      state.rounds = state.rounds.filter((value) => facets.rounds.includes(value));
      state.tracks = state.tracks.filter((value) => facets.tracks.includes(value));
      paint();
      if (!manifest.exams.length) {
        status(failureBanner('아직 올라온 시험지가 없습니다.', ['매니페스트가 비어 있습니다.']));
      }
    } catch (error) {
      if (error?.message === 'unauthorized') return;
      elements.filters.innerHTML = '';
      elements.body.innerHTML = `${failureBanner('시험 목록을 받지 못했습니다.', [error?.message || '알 수 없는 오류'])}
        <div class="toolbar"><button id="gichulRetry" class="btn btn-secondary btn-sm" type="button">다시 받기</button></div>`;
    }
  }

  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);

  restoreFilters();
  // 목록이 오기 전에는 결과 자리를 만들지 않는다 — 빈 결과 그룹을 먼저 그리면
  // "조건에 맞는 시험지가 없습니다"가 잠깐 스쳤다가 뒤집힌다.
  load();
})();
