# 라우팅: 아이디어 유형에서 소집 부서로

CEO가 Phase 2에서 읽는다. 부서 명부만으로 소집 판단이 서면 이 파일은 건너뛰어도 된다.

기호: `●` 필수, `○` 선택(그 건의 성격에 따라), `-` 제외(부르면 중복이거나 빈 보고서가 온다).

## 1. 유형 x 부서 매트릭스

| 아이디어 유형 | strategy | product | engineering | design | marketing | paid-media | sales | finance | project-management | support | specialized | academic |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 신규 앱/SaaS | ● | ● | ● | ● | ○ | ○ | ○ | ● | ● | ○ | ○ | - |
| 이커머스/D2C 상품 | ● | ○ | - | ● | ● | ● | ○ | ● | ○ | ○ | ○ | - |
| 콘텐츠 채널(유튜브·뉴스레터) | ○ | ○ | - | ○ | ● | ○ | - | ○ | ○ | ○ | - | ○ |
| 오프라인 매장/서비스 | ● | ○ | - | ○ | ● | ○ | ○ | ● | ● | ● | ● | - |
| B2B 서비스 | ● | ● | ○ | ○ | ○ | - | ● | ● | ● | ○ | ○ | - |
| 투자·재무 판단 | ● | - | - | - | - | - | - | ● | - | ○ | ● | ○ |
| 학술·인문 주제 탐구 | ○ | - | - | - | - | - | - | - | - | - | ○ | ● |
| 기존 제품 개선 | ○ | ● | ● | ● | ○ | - | ○ | ○ | ● | ● | - | - |
| 캠페인/런칭 | ○ | ○ | - | ● | ● | ● | ○ | ○ | ● | ○ | ○ | - |
| 채용·조직 | ○ | - | - | - | ○ | - | - | ● | ● | ○ | ● | ○ |
| 부동산·자산 | ● | - | - | - | - | - | - | ● | ○ | - | ● | ○ |
| 공모전·제안서 | ● | ● | ○ | ● | ○ | - | ○ | ● | ● | - | ○ | ● |

매트릭스는 후보를 좁히는 도구다. `●`가 8개 나와도 3~7개로 줄여라. 줄이는 기준은 아래 2절이다.

## 2. 몇 개를 부를지 정하는 법

우선 이 질문 하나로 자른다. **이 부서가 없으면 결론이 달라지는가.**
달라지지 않으면 빼고, 나중에 필요해지면 후속 요청으로 다시 부르면 된다.

| 요청 규모 | 부서 수 | 웨이브 |
|---|---|---|
| 한 줄 질문, 빠른 판단 | 2~3 | 1 |
| 아이디어 검증 | 3~5 | 2 |
| 사업 계획 전체 | 5~7 | 2~3 |
| 구현까지 요구 | 5~7 | 3 |

상한은 7이다. 12개 전부 소집은 금지한다. 부서가 늘수록 같은 조사를 여러 부서가 중복 수행하고,
교차 검토에서 충돌만 늘어난다.

## 3. 웨이브 배치 규칙 (요약)

| 웨이브 | 성격 | 부서 |
|---|---|---|
| Wave 1 | 조사·판단 | strategy, academic, finance, sales, specialized, support(데이터) |
| Wave 2 | 기획 | product, design(컨셉), marketing(포지셔닝), paid-media, project-management |
| Wave 3 | 제작 | engineering, design(화면), marketing(콘텐츠 실물) |

같은 웨이브는 한 응답에서 Agent를 여러 개 호출해 병렬로 돌린다.
다음 웨이브 브리프에는 이전 웨이브 산출물 경로와 3줄 요약을 첨부한다.
작은 요청이면 웨이브를 합쳐 한 번에 끝낸다.

design과 marketing은 웨이브에 두 번 등장할 수 있다. 컨셉과 실물 제작은 다른 일이다.
같은 부서를 두 웨이브에 부를 때는 브리프를 나누고, 2차 브리프에 1차 산출물을 첨부한다.

## 4. 키워드 트리거

사용자 입력에 아래 표현이 있으면 해당 부서를 후보에 올린다. 트리거는 후보 추가일 뿐 확정이 아니다.

| 부서 | 한국어 트리거 | 영어 트리거 |
|---|---|---|
| strategy | 시장, 경쟁사, 될까, 진입, 포지션, 사업성, 트렌드 | market size, TAM, competitor, positioning, feasibility |
| product | 기능, 스펙, 요구사항, MVP, 로드맵, 사용자 문제, 우선순위 | spec, PRD, roadmap, MVP, user story, backlog |
| engineering | 개발, 구현, 코드, 아키텍처, API, 배포, 성능, 버그 | build, implement, architecture, API, deploy, refactor |
| design | 화면, UI, UX, 디자인, 로고, 브랜딩, 목업, 접근성 | UI, UX, mockup, wireframe, design system, accessibility |
| marketing | 마케팅, 홍보, 콘텐츠, SEO, 블로그, SNS, 브랜드 메시지 | marketing, content, SEO, newsletter, brand voice |
| paid-media | 광고, 예산 집행, 퍼포먼스, 전환율, 소재, 타겟팅 | ads, CAC, ROAS, campaign budget, creative, retargeting |
| sales | 영업, 고객사, 리드, 제안, 가격 협상, 파트너십, 계약 | sales, lead, outbound, pipeline, pricing, partnership |
| finance | 수익, 원가, 비용, 손익, 자금, 투자, 세금, 밸류에이션 | unit economics, P&L, cash flow, burn, valuation, pricing model |
| project-management | 일정, 마일스톤, 몇 개월, 리스크, 담당, 스프린트, 순서 | timeline, milestone, sprint, dependency, risk register |
| support | 운영, 고객 응대, CS, 문의, 데이터 분석, 지표 대시보드 | operations, support, ticket, churn, retention, analytics |
| specialized | 법, 규제, 계약서, 허가, 개인정보, 보안, 채용, 부동산 | legal, compliance, regulation, privacy, security, HR, real estate |
| academic | 논문, 연구, 역사, 심리, 사회, 이론, 문헌, 왜 그런가 | paper, literature review, theory, history, psychology, research |

여러 부서가 동시에 트리거되면 매트릭스로 확정한다. 트리거 개수가 많다고 부서를 늘리지 마라.

## 5. 제외 판단

- 사용자가 "빠르게", "간단히"라고 했으면 부서를 2~3개로 줄이고 웨이브를 1로 합친다.
- 결론이 나기 전 단계의 부서는 뺀다. 타당성이 안 나온 상태의 engineering, 제품이 없는 상태의 paid-media가 대표적이다.
- 사용자 데이터나 계정 접근이 필요한데 커넥터가 없으면, 그 부서는 부르되 "공개 정보 기반"으로 범위를 좁혀 브리프에 명시한다.
- academic은 근거가 문헌이어야 하는 질문에만 부른다. 시장 조사를 학술팀에 시키면 논문만 뒤지다 끝난다.
- specialized는 법·규제·보안·HR·부동산 중 실제 쟁점이 있을 때만 부른다. 예방적 소집은 일반론만 돌아온다.

## 6. 예시 3개

### 예시 1. "동네 필라테스 스튜디오 차리려는데 어때?"

- 유형: 오프라인 매장/서비스
- 소집: strategy(상권·경쟁 밀도), finance(초기 투자·손익분기 회원 수), specialized(체육시설업 신고·환불 규정),
  marketing(지역 유입 채널), project-management(오픈까지 일정)
- 제외: engineering, design, paid-media, sales, support, academic, product
- 웨이브: Wave 1 병렬로 strategy, finance, specialized. Wave 2에서 marketing, project-management

### 예시 2. "우리 SaaS 이탈률이 높은데 원인 찾고 개선안 줘"

- 유형: 기존 제품 개선
- 소집: support(이탈 데이터·문의 로그 분석), product(문제 정의·개선 스펙), design(온보딩 화면),
  engineering(구현), project-management(릴리스 순서)
- 제외: strategy(시장이 아니라 자사 제품이 쟁점), finance, marketing, paid-media, sales, specialized, academic
- 웨이브: Wave 1은 support 단독. Wave 2에서 product, project-management. Wave 3에서 design, engineering

### 예시 3. "조선 후기 신분제 해체가 지금 한국 사회 계층 인식에 남긴 영향"

- 유형: 학술·인문 주제 탐구
- 소집: academic(역사·사회학 문헌), strategy(현대 데이터로의 연결은 선택)
- 제외: 나머지 10개. 사업 부서를 부르면 주제와 무관한 시장 분석이 붙는다
- 웨이브: Wave 1 단일. academic 중심으로 끝내고 필요하면 후속 질의
