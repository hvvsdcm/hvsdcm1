# 도구와 플러그인 인벤토리

CEO가 Phase 3에서 브리프의 "사용 가능한 도구·플러그인" 칸을 채울 때 읽는다.
부서 에이전트도 작업 시작 전에 자기 행만 확인하면 된다.

여기 적힌 플러그인 id는 마켓플레이스에서 확인된 것만이다. 표에 없는 이름을 지어내지 마라.
없는 플러그인을 브리프에 적으면 에이전트가 찾다가 시간을 버리고 대체 경로도 놓친다.

## 1. 플러그인 이용 규칙 4가지

1. `ListPlugins`로 세션에 활성화된 플러그인을 먼저 확인한다. 없으면 `SearchPlugins`로 찾고,
   `SuggestPluginInstall`이 있으면 설치 카드를 제시한다. 사용자가 설치할 때까지 기다리지 않는다.
2. 대체 경로로 바로 진행한다. 기본 대체는 `WebSearch`/`WebFetch` + 내장 스킬(xlsx, docx, pptx, pdf, dataviz, design)
   + `Bash`(python, node)다. 플러그인이 없다고 부서 산출물을 비워두지 마라.
3. MCP 커넥터(HubSpot, Notion, Slack, Figma, Gmail 등)는 `ListConnectors`로 연결 상태를 확인한다.
   미연결이면 사용자 데이터 접근 없이 "공개 정보 기반"으로 진행하고, 그 사실을 산출물에 적는다.
4. 외부 서비스에 사용자 데이터를 보내는 동작(메일 발송, CRM 쓰기, 광고 집행, 결제)은 기획과 초안까지만 한다.
   실행은 사용자 승인 후다. 승인 없이 나간 메일은 되돌릴 수 없다.

## 2. 내장 도구 인벤토리

| 도구 | 쓰는 곳 | 주의 |
|---|---|---|
| `Read`, `Grep`, `Glob` | 저장소·사용자 제공 파일 조사 | 경로는 절대경로로 |
| `Write`, `Edit` | 산출물 저장, 코드 수정 | 저장 경로는 브리프에 적힌 곳만 |
| `Bash` | 계산, python/pandas 분석, `npm test`, `git diff --check` | 저장소 규약(AGENTS.md) 준수 |
| `WebSearch` | 시장·경쟁·법령·트렌드 1차 조사 | 결과에 출처 URL 필수 |
| `WebFetch` | 특정 페이지 원문 확인(가격 페이지, 공시, 논문 초록) | 검색 스니펫만 보고 단정하지 마라 |
| `Artifact` | 목업, 대시보드, 인터랙티브 산출물 게시 | 민감정보 포함 금지 |
| `Agent` | 부서 소집(CEO 전용) | 부서 에이전트는 쓰지 않는다. 깊이 1 |
| `SendMessage` | 이미 돌린 부서 에이전트에 재질의 | 새로 부르면 조사가 처음부터 다시 돈다 |
| `TaskCreate`, `TaskList`, `TaskUpdate` | 일정·의존성 추적 | project-management 중심 |
| `ListPlugins`, `SearchPlugins`, `ListConnectors` | 가용성 확인 | 작업 시작 전 1회 |
| GitHub MCP | 이슈·PR·파일 조회와 생성 | 쓰기 동작은 사용자 승인 후 |
| xlsx 스킬 | 재무 모델, 예산표, 리드 리스트 | 수식과 단위를 셀에 남긴다 |
| docx 스킬 | 배포용 문서, 제안서 | |
| pptx 스킬 | 발표 자료 | |
| pdf 스킬 | 논문·공시·계약서 원문 읽기 | 스캔본은 OCR 필요 |
| dataviz 스킬 | 차트, 지표 시각화 | 축 단위와 기준 시점 표기 |
| design 스킬 | 화면 목업, 브랜드 시안 캔버스 | |
| Playwright | 웹 UI 동작 확인 | engineering 한정, 설치되어 있을 때만 |

## 3. 부서별 매핑

| 부서 | 1순위 플러그인 (id: 주요 스킬) | 2순위/보조 | 내장 도구 |
|---|---|---|---|
| strategy | product-management: competitive-brief / marketing: competitive-brief | bigdata-com(산업분석), similarweb MCP, brightdata-plugin(competitive-intel), tavily(research) | WebSearch, WebFetch, dataviz |
| product | product-management: write-spec, product-brainstorming, synthesize-research, roadmap-update, metrics-review | design: user-research, research-synthesis; airtable: product-ops; figma | WebSearch, Artifact(프로토타입), design 스킬 |
| engineering | (내장 코딩 도구가 1순위) modern-web-guidance, security-guidance | figma: figma-design-to-code; buildkite; twilio-developer-kit(메시징 필요 시); auth0 | Read/Edit/Write/Bash, GitHub MCP, npm test, Playwright |
| design | design: design-critique, design-system, accessibility-review, ux-copy, design-handoff | figma: figma-generate-design; canva: canva-bulk-create, resize-for-social-media; brand-voice | design 스킬(캔버스), Artifact, dataviz(팔레트) |
| marketing | marketing: campaign-plan, draft-content, content-creation, seo-audit, email-sequence, brand-review | searchfit-seo: keyword-clustering, content-strategy; brand-voice; canva; activecampaign | WebSearch(트렌드), WebFetch |
| paid-media | adspirer-ads-agent: adspirer-google-ads/meta-ads/tiktok-ads/linkedin-ads, write-ad-copy, wasted-spend | marketing: performance-report; supermetrics MCP | xlsx(예산·ROAS 모델), dataviz |
| sales | sales: account-research, draft-outreach, pipeline-review, forecast, competitive-intelligence | zoominfo(build-list, tam-sizer), lusha, common-room, monday-crm, hubspot MCP | WebSearch, xlsx(리드 리스트) |
| finance | finance: financial-statements, variance-analysis | daloopa(dcf, unit-economics, comps), bigdata-com(valuation), small-business(cash-flow-snapshot, margin-analyzer, price-check, tax-prep) | xlsx(3-statement, 단위경제), dataviz |
| project-management | product-management: sprint-planning, stakeholder-update | airtable, linear/atlassian/asana/monday MCP | TaskCreate/TaskList, markdown 간트 |
| support | customer-support: ticket-triage, draft-response, kb-article, customer-research | small-business(customer-pulse, ticket-deflector), intercom/hubspot MCP, airtable | xlsx/dataviz(데이터 분석), Bash(python/pandas) |
| specialized | legal: review-contract, compliance-check, legal-risk-assessment / human-resources: job-post(small-business), interview-prep, comp-analysis | security-guidance(보안), carta-*(지분), bio-research(생명과학) | WebSearch(법령: law.go.kr 등) |
| academic | (전용 플러그인 없음) tavily: tavily-research | bio-research(pubmed/consensus MCP, 생명과학 한정), brightdata(search) | WebSearch, WebFetch(Google Scholar, RISS, KCI, DBpia, JSTOR 초록), pdf 스킬 |

## 4. 플러그인이 없을 때의 대체 경로

플러그인 미설치는 정상 상황이다. 아래 경로로 같은 결과를 만든다.

| 부서 | 대체 경로 |
|---|---|
| strategy | WebSearch로 경쟁사 목록과 가격 페이지 수집 → WebFetch로 원문 확인 → 비교표를 markdown으로 |
| product | 사용자 인터뷰 대신 앱스토어·커뮤니티 리뷰를 WebFetch로 수집해 문제 목록화, 스펙은 Write로 작성 |
| engineering | 플러그인 없이 내장 코딩 도구만으로 충분하다. 저장소 규약과 `npm test`가 기준 |
| design | design 스킬 캔버스 또는 HTML 목업 Artifact. 접근성은 WCAG 기준을 직접 점검 |
| marketing | WebSearch로 검색어 수요와 경쟁 콘텐츠 확인, 콘텐츠 초안은 Write |
| paid-media | 채널 API 대신 공개 벤치마크 범위를 인용하고 xlsx로 예산·ROAS 시나리오 계산 |
| sales | 리드 DB 대신 공개 기업 정보(홈페이지, 채용공고, 공시)로 리스트를 만들고 xlsx로 정리 |
| finance | xlsx로 단위경제와 3-statement 요약을 직접 계산. 가정값은 출처와 함께 명시 |
| project-management | TaskCreate/TaskList와 markdown 간트 표로 일정과 의존성 관리 |
| support | Bash(python/pandas)로 CSV 분석, 결과는 dataviz로 시각화 |
| specialized | 법령은 국가법령정보센터(law.go.kr), 판례·해석례는 공개 DB를 WebFetch로 확인. 결론에 "검토 필요" 표시 |
| academic | WebSearch + WebFetch로 RISS, KCI, DBpia, Google Scholar 초록 확인. 전문 PDF는 pdf 스킬로 읽는다 |

## 5. 공통 주의

- 유료 채널 집행, CRM 쓰기, 메일 발송, 저장소 push는 사용자 승인 전까지 초안 상태로 둔다.
- 커넥터로 읽은 사용자 데이터는 산출물에 원문 그대로 옮기지 말고 필요한 만큼만 요약한다.
  `work/`는 커밋 대상이므로 개인정보, 토큰, 자격증명이 파일에 들어가면 그대로 저장소에 남는다.
- 도구 확인 결과는 브리프에 "확인함: ListPlugins 결과 X 활성, Y 미설치 → 대체 경로 Z" 형태로 한 줄 남긴다.
