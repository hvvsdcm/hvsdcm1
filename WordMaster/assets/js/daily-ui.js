(() => {
  'use strict';

  function create({ app, words, scheduler, getDb, save, start, resume, settings, stats, toast }) {
    const esc = (value) => window.HvsStudyUtils.escapeHtml(value);
    const icon = (id) => `<svg class="ui-icon" aria-hidden="true"><use href="/assets/ui-icons.svg?v=20260904-icons-v2#${id}"></use></svg>`;
    const weekday = (key) => ['일', '월', '화', '수', '목', '금', '토'][new Date(`${key}T12:00:00Z`).getUTCDay()];
    let reviewLimit = 30;

    function goalDialog(learning) {
      return `<dialog id="dailyGoalDialog" class="wm-dialog" aria-labelledby="dailyGoalTitle">
        <form id="dailyGoalForm" class="wm-dialog-form">
          <div class="wm-section-title"><h2 id="dailyGoalTitle">나의 하루 목표</h2><button id="closeGoalDialog" type="button" class="btn btn-ghost btn-sm" aria-label="목표 설정 닫기">닫기</button></div>
          <p class="text-secondary">새 단어와 복습을 합쳐 하루에 공부할 단어 수예요.</p>
          <div class="wm-goal-presets" role="group" aria-label="하루 목표 빠른 선택">
            ${[10, 20, 30, 50].map((goal) => `<button class="btn btn-secondary" type="button" data-goal="${goal}" aria-pressed="${goal === learning.settings.goal}">${goal}개</button>`).join('')}
          </div>
          <div class="field"><label class="field-label" for="dailyGoalInput">하루 목표 (5–200개)</label><input id="dailyGoalInput" class="field-input" type="number" inputmode="numeric" min="5" max="200" step="1" required value="${learning.settings.goal}"></div>
          <fieldset class="wm-day-fields"><legend>새 단어 학습 범위</legend>
            <div class="field"><label class="field-label" for="dailyStartDay">시작 DAY</label><input id="dailyStartDay" class="field-input" type="number" inputmode="numeric" min="1" max="50" step="1" required value="${learning.settings.startDay}"></div>
            <div class="field"><label class="field-label" for="dailyEndDay">끝 DAY</label><input id="dailyEndDay" class="field-input" type="number" inputmode="numeric" min="1" max="50" step="1" required value="${learning.settings.endDay}"></div>
          </fieldset>
          <p class="wm-hint">복습은 범위와 관계없이 필요한 단어를 챙겨요. 하루 기록은 한국시간 자정에 바뀌어요.</p>
          <button class="btn btn-primary wm-wide-button" type="submit">목표 저장하기</button>
        </form>
      </dialog>`;
    }

    function bindGoal() {
      const dialog = document.getElementById('dailyGoalDialog');
      document.getElementById('editDailyGoal').addEventListener('click', () => dialog.showModal());
      document.getElementById('closeGoalDialog').addEventListener('click', () => dialog.close());
      dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
      const input = document.getElementById('dailyGoalInput');
      const highlight = () => dialog.querySelectorAll('[data-goal]').forEach((button) => button.setAttribute('aria-pressed', String(Number(button.dataset.goal) === Number(input.value))));
      input.addEventListener('input', highlight);
      dialog.querySelectorAll('[data-goal]').forEach((button) => button.addEventListener('click', () => { input.value = button.dataset.goal; highlight(); }));
      document.getElementById('dailyGoalForm').addEventListener('submit', (event) => {
        event.preventDefault();
        if (!event.target.reportValidity()) return;
        let startDay = Number(document.getElementById('dailyStartDay').value);
        let endDay = Number(document.getElementById('dailyEndDay').value);
        if (startDay > endDay) [startDay, endDay] = [endDay, startDay];
        const learning = getDb().learning;
        learning.settings = { goal: Number(input.value), startDay, endDay };
        const today = learning.days[scheduler.dayKey()];
        if (today) today.goal = learning.settings.goal;
        save();
        dialog.close();
        home();
        toast('하루 목표를 저장했어요.');
      });
    }

    function home() {
      const learning = getDb().learning;
      const s = scheduler.summary(words, learning);
      const plan = scheduler.plan(words, learning);
      const active = scheduler.restoreSession(learning.activeSession, words);
      const goal = learning.settings.goal;
      const count = s.today.count;
      const complete = count >= goal;
      const remaining = Math.max(0, goal - count);
      const canStart = Boolean(active || plan.questions.length);
      const primary = active ? '이어서 학습하기' : complete ? '조금 더 학습하기' : '바로 시작하기';
      const explanation = active
        ? `${active.index + 1} / ${active.questions.length}문제부터 이어서 풀어요`
        : plan.questions.length ? `이번 학습: 복습 ${plan.reviewCount}개 · 새 단어 ${plan.newCount}개`
          : s.nextDueAt ? `다음 복습은 ${scheduler.dueLabel(s.nextDueAt)}예요. 범위를 넓혀 새 단어도 배울 수 있어요.`
            : '선택한 범위의 단어를 모두 학습했어요. 목표 설정에서 범위를 바꿔보세요.';
      app.innerHTML = `
        <header class="view-head"><div class="view-head-main"><div><span class="kicker">WORDMASTER 2000</span><h1>오늘의 학습</h1></div></div><button id="editDailyGoal" class="btn btn-secondary btn-sm" type="button">목표 설정</button></header>
        <div class="wm-today-layout">
          <section class="wm-goal-card" aria-labelledby="dailyGoalHeading">
            <div class="wm-section-title"><h2 id="dailyGoalHeading">하루 목표</h2><span class="wm-streak">${icon('icon-bolt')} ${s.streak}일 연속 학습</span></div>
            <div class="wm-goal-number"><strong>${count}</strong><span> / ${goal}개</span></div>
            <p class="wm-goal-message">${complete ? '오늘 목표 달성! 오늘의 공부를 해냈어요.' : count ? `${remaining}개만 더 공부하면 오늘 목표를 달성해요.` : '오늘도 한 단어씩, 기억에 남겨볼까요?'}</p>
            <progress class="wm-daily-progress" max="${goal}" value="${Math.min(count, goal)}" aria-label="오늘 학습 목표" aria-valuetext="${count}개 학습, 목표 ${goal}개">${Math.min(100, Math.round(count / goal * 100))}%</progress>
            <div class="wm-today-breakdown"><span>새 단어 ${s.today.newCount}개</span><span>복습 ${s.today.reviewCount}개</span><span>${Math.min(100, Math.round(count / goal * 100))}% 달성</span></div>
            <button id="dailyStartBtn" class="btn btn-primary wm-wide-button wm-start-button" type="button" ${canStart ? '' : 'disabled'}>${primary}</button>
            <p id="dailyPlanSummary" class="wm-plan-summary">${explanation}</p>
            ${active ? '<button id="discardActiveSession" type="button" class="btn btn-ghost btn-sm">이어서 학습 기록만 비우기</button>' : ''}
          </section>
          <section class="wm-review-card" aria-labelledby="dailyReviewHeading">
            <span class="wm-card-icon">${icon('icon-refresh')}</span>
            <h2 id="dailyReviewHeading">잊기 전에 복습</h2>
            <p class="wm-review-count"><strong>${s.due}</strong>개</p>
            <p class="text-secondary">${s.due ? '복습할 시간이 된 단어예요. 오래 기다린 단어부터 다시 만나요.' : s.nextDueAt ? `지금은 복습을 마쳤어요. 다음 복습은 ${scheduler.dueLabel(s.nextDueAt)}예요.` : '단어를 학습하면 나에게 맞는 복습 일정이 생겨요.'}</p>
            <button id="dailyReviewBtn" class="btn btn-secondary wm-wide-button" type="button">${s.due ? '복습하기' : '복습 일정 보기'}</button>
            <span class="wm-hint">정답과 난이도에 따라 복습 간격이 달라져요.</span>
          </section>
        </div>
        <section class="wm-week-section" aria-labelledby="dailyWeekHeading">
          <div class="wm-section-title"><h2 id="dailyWeekHeading">차곡차곡, 최근 7일</h2><span class="text-secondary">하루 한 번의 작은 성취</span></div>
          <div class="wm-week">${s.week.map((day) => `<div class="wm-week-day ${day.today ? 'is-today' : ''} ${day.count >= day.goal ? 'is-complete' : day.count ? 'is-studied' : ''}" aria-label="${day.day}, ${day.count}개 학습, 목표 ${day.goal}개${day.count >= day.goal ? ', 목표 달성' : ''}"><span>${day.today ? '오늘' : weekday(day.day)}</span><span class="wm-week-dot">${day.count >= day.goal ? '완료' : day.count || '·'}</span><small>${day.day.slice(5).replace('-', '.')}</small></div>`).join('')}</div>
        </section>
        <section aria-labelledby="dailyCollectionHeading"><div class="wm-section-title"><h2 id="dailyCollectionHeading">나의 단어장</h2><span class="text-secondary">${s.learned.toLocaleString()} / ${words.length.toLocaleString()}개 학습</span></div>
          <div class="list-group"><button id="dailyRangeBtn" class="list-row list-row-nav" type="button"><span class="list-row-lead">${icon('icon-book-open')}</span><span class="list-row-body"><span class="list-row-title">DAY별로 직접 학습하기</span><span class="list-row-sub">범위와 문제 수를 골라 시험 보기</span></span></button>
          <button id="dailyStatsBtn" class="list-row list-row-nav" type="button"><span class="list-row-lead">${icon('icon-chart')}</span><span class="list-row-body"><span class="list-row-title">학습 기록 · 오답 노트</span><span class="list-row-sub">검색, 오답 재시험, 기록 백업</span></span></button></div>
        </section>
        <p class="wm-hint">오늘 학습 수는 서로 다른 단어 기준이에요. 같은 단어를 다시 풀어도 목표 수는 중복으로 늘지 않아요.</p>
        ${goalDialog(learning)}`;
      document.getElementById('dailyStartBtn').addEventListener('click', () => active ? resume() : start('daily'));
      document.getElementById('dailyReviewBtn').addEventListener('click', () => window.dispatchEvent(new CustomEvent('wordmaster:review')));
      document.getElementById('dailyRangeBtn').addEventListener('click', settings);
      document.getElementById('dailyStatsBtn').addEventListener('click', stats);
      document.getElementById('discardActiveSession')?.addEventListener('click', () => {
        if (!window.confirm('이어서 풀기 목록만 비울까요? 이미 푼 단어, 정답률과 복습 일정은 그대로 남아요.')) return;
        getDb().learning.activeSession = null;
        save(); home();
      });
      bindGoal();
    }

    function review() {
      const learning = getDb().learning;
      const s = scheduler.summary(words, learning);
      const scheduled = words.filter((word) => learning.cards[word.id]).sort((a, b) => learning.cards[a.id].dueAt - learning.cards[b.id].dueAt);
      app.innerHTML = `<header class="view-head"><div class="view-head-main"><div><span class="kicker">나에게 맞는 복습 주기</span><h1>복습하기</h1></div></div><button id="startScheduledReview" class="btn btn-primary" type="button" ${s.due ? '' : 'disabled'}>복습 시작</button></header>
        <section class="wm-review-overview"><h2>지금 복습할 단어 <strong>${s.due}개</strong></h2><p>${s.due ? '한 번에 최대 20개씩, 복습 시간이 지난 단어부터 학습해요.' : s.nextDueAt ? `지금은 모두 복습했어요. 다음 복습은 ${scheduler.dueLabel(s.nextDueAt)}예요.` : '아직 복습할 단어가 없어요. 오늘의 학습에서 새 단어를 먼저 만나보세요.'}</p></section>
        <details class="wm-how-review"><summary>복습 주기는 어떻게 정해지나요?</summary><p>모르는 단어는 10분 뒤 다시 복습해요. 정답을 기억하면 기본 1일, 3일, 그다음에는 기억 난이도에 따라 간격이 늘어나요. 정답을 본 직후의 재풀이는 긴 간격으로 건너뛰지 않아요.</p><p>정답 확인 후 ‘어려움 / 보통 / 쉬움’을 선택하면 다음 복습 시간을 조절할 수 있어요. 틀린 단어는 이번 학습 안에서도 한 번 더 만나고, 하루 목표에는 한 번만 계산해요.</p></details>
        <section aria-labelledby="reviewScheduleHeading"><h2 id="reviewScheduleHeading" class="list-group-head">내 복습 일정 · ${scheduled.length}개</h2><div class="list-group">${scheduled.length ? scheduled.slice(0, reviewLimit).map((word) => {
          const card = learning.cards[word.id];
          return `<div class="list-row"><span class="list-row-body"><span class="list-row-title wm-term">${esc(word.word)}</span><span class="list-row-sub">DAY ${String(word.day).padStart(2, '0')} · 복습 ${card.repetitions}단계</span></span><span class="list-row-value ${card.dueAt <= Date.now() ? 'wm-due-now' : ''}">${scheduler.dueLabel(card.dueAt)}</span></div>`;
        }).join('') : '<p class="wm-empty">첫 학습을 마치면 여기에 복습 일정이 보여요.</p>'}</div>
        ${scheduled.length > reviewLimit ? '<button id="moreReviewSchedule" type="button" class="btn btn-secondary wm-more-button">30개 더 보기</button>' : ''}</section>`;
      document.getElementById('startScheduledReview').addEventListener('click', () => start('scheduled'));
      document.getElementById('moreReviewSchedule')?.addEventListener('click', () => { reviewLimit += 30; review(); });
    }

    return Object.freeze({ home, review });
  }

  globalThis.HvsWordmasterDailyUi = Object.freeze({ create });
})();
