# FEIVEN R20.1 Windows 플레이테스트 — 배포 준비 상태 보고

작성일: 2026-09-17 · 대상: `hsdc1258/feiven-playtest` r20.1-playtest (설치파일 SHA-256 `fc4b5f18…2bf01`, 게임 빌드 `feiven-20260915-r20`) · 백엔드 `https://feiven.teniv.kr`
이 문서는 공개 저장소에 올라가는 것을 전제로 작성했으며, 원본 서버 IP·내부 API 경로·명령줄 스위치 이름은 의도적으로 적지 않았다.

## 1. 결론

**현재 상태로는 DCInside 공지 불가.** 설치파일 자체(UE 5.8 Shipping, 무결성 25/25 일치, 사용자 계정 폴더 설치, 관리자 권한 불필요)와 GitHub 다운로드 경로는 문제가 없다.
그러나 확인 시점에 `GET /health`가 `gameServerReady:false`를 반환해 **누구도 경기에 들어갈 수 없는 상태**이고, 정상 가동 시에도 수용량이 **동시 플레이 18명 + 대기열 48명**뿐이라 디시 글 하나가 부르는 인원을 받을 수 없다.
여기에 r19 구버전 설치파일이 아직 내려받기 가능하고, 개인정보 안내와 테스트 일정이 어디에도 없다. 아래 3절의 차단 항목 4건을 해결하고 6절 체크리스트를 통과한 뒤 공지하는 것을 권한다.
4절의 서버·인프라 항목은 게임/서버 소스가 이 세션에서 접근 불가능하므로(운영자 PC에만 존재) 코드 수정 없이 **운영자 권고**로만 남겼다.

## 2. 검토 범위와 방법

| 구분 | 한 일 | 근거 파일 |
|---|---|---|
| 설치파일 | Inno Setup 6.7.0 헤더 디코딩(innoextract PR #210 빌드), 26개 페이로드 추출·해시 대조, `.pak` 언팩(repak + Oodle), 실행파일 문자열 분석 | `feiven/inventory.md`, `installer-debug.txt`, `pak-list.txt` |
| 백엔드 | 읽기 전용·저용량 프로브(HTTP 약 32회): DNS, RDAP, TLS SAN, `/health`, 공개 경로 401/403 확인, 15회 병렬 버스트, Discord 초대 유효성, GitHub 릴리스 CDN | `feiven/probe/probe-report.md` + raw `doh.txt` `burst.txt` `http-2.txt` `gh.txt` `tls-*.txt` |
| 배포 문서 | README, 릴리스 본문 r19/r20/r20.1, `PLAYTEST-GUIDE.ko.txt`, `release-info.json`, `SHA256SUMS.txt` 검토(24건) | `docs-review.md` |
| 수정 적용 | README·이슈 템플릿을 브랜치 `claude/playtest-readiness-r20.1`에 커밋(391c936) | feiven-playtest 브랜치의 `README.md`, `.github/ISSUE_TEMPLATE/*.yml`, 이 폴더의 `dc-post-draft.md` |

**검토할 수 없었던 것**
- 게임·서버 소스 코드: 이 세션에서 도달 가능한 저장소에 없음. 바이너리 문자열과 HTTP 응답으로만 판단.
- TLS 인증서 발급자·만료일·실제 cipher: 샌드박스 egress 게이트웨이가 TLS를 재종단하므로 관측 불가. SAN(`*.teniv.kr`, `feiven.teniv.kr`, IP SAN 없음)만 신뢰 가능(`tls-feiven.txt`, `tls-ip.txt`).
- 인증 후 엔드포인트의 요청 제한(릴리스 노트의 PC방/NAT 공유 버킷 수정 포함): 로그인·계정 생성을 시도하지 않았으므로 미확인.
- 게임 UDP 17777 실제 수신 여부: `nc -u`는 ICMP 미응답만 알려주므로 증명 불가.
- 부하 테스트: 하지 않음. 7절은 관측 사실에서만 추론.

## 3. 차단(Blocker) 항목

| # | 항목 | 근거 | 조치 |
|---|---|---|---|
| B1 | **게임 서버 not-ready** | `GET /health` 200: `gameServerConfigured:true, gameServerReady:false, activeMatches:0` (probe-report B1). API는 살아 있지만 전용 서버가 경기를 받지 않음. | 공지 전 전용 서버 기동 후 `gameServerReady:true` 확인. 운영 시간 외에는 이 상태가 정상이므로 공지에 운영 시간을 반드시 명시(B4). |
| B2 | **수용량 vs 디시 유입량** | `/health`: `maxConcurrentMatches:3`, `gamePorts` 3개, `maxQueuedPlayers:48`, `queueLeaseMs:60000`. `release-manifest.json`: `maxPlayersPerMatch 6`. 클라이언트 오류 코드에 `queue_full` 존재(inventory §6a). 즉 동시 18명 + 대기 48명, 그 이후는 거절. | (a) 시간대 슬롯 분할 공지, (b) 대기열 만석 시 게임 내 문구·재시도 간격을 README/디시 글에 기재(플레이스홀더 준비됨), (c) 가능하면 `maxConcurrentMatches`·포트 수 상향. 수용량을 늘릴 수 없다면 공지 문구에서 "소규모"를 첫 줄에 둘 것. |
| B3 | **r19 구버전 내려받기 가능 + r20/r20.1 중복 + `releases/latest` 동점** | r19-playtest: `prerelease:false`, 356,705,306 B 다른 설치파일(sha256 `bf6586cc…`) 링크 활성. r20 자산은 r20.1과 바이트 동일. 세 태그 모두 커밋 de70889 → `latest` 선정 기준(`created_at`) 동점(docs-review A1·A2·B5). | r19: Pre-release 전환 + exe 자산 삭제 + 상단 "사용 중지" 배너. r20: Pre-release 전환 + "r20.1과 같은 파일, 재다운로드 불필요" 배너. 공지 링크는 `releases/tag/r20.1-playtest`로 고정(latest 사용 금지). |
| B4 | **개인정보 안내·테스트 일정 부재** | 네 문서 모두 수집 항목·보유 기간·삭제 창구·문의처 없음. 날짜·시간·서버 지역 없음(docs-review A3·A4). Google 로그인 브리지(`/account/google/start`)가 실제로 살아 있음(probe INFO). | README §6·§9 플레이스홀더를 운영자가 채운 뒤 머지. 계정을 받는 순간 필요한 법적 최소 사항(수집 항목·목적·보유 기간·삭제 요청 이메일·제3자 제공 여부). |

## 4. 수정 권고(Should-fix) — 서버·인프라·빌드

소스가 없으므로 모두 운영자 측 작업이다. 증거는 괄호 안 파일.

**서버 / 네트워크**
1. **원본 서버가 CDN/WAF/요청 제한 없이 직접 노출** — `teniv.kr` 아펙스는 Cloudflare 프록시(172.67.x / 104.21.x)인데 `feiven.teniv.kr`은 DNS-only로 원본 서버 IP(49.247.x.x, 국내 IDC 단일 VPS)를 그대로 가리킴(`doh.txt`, `rdap.txt`). 15회 병렬 `/health`에 15/15 200, 429·`RateLimit-*`·`Retry-After` 없음(`burst.txt`). 로그인·Google 브리지·매치메이킹·health가 nginx 한 대에 그대로 떨어짐. → **권장: Cloudflare 오렌지 클라우드(프록시) 전환**(UDP 게임 포트는 프록시 대상이 아니므로 API·`/account`만 해당). 불가하면 최소 nginx `limit_req`/`limit_conn` + fail2ban.
2. **클라이언트에 컴파일된 raw-IP HTTPS 원본** — Shipping exe에 `https://feiven.teniv.kr` 바로 앞에 `https://<원본 서버 IP>` 문자열이 있음(inventory §6a). 인증서에 IP SAN이 없고, SNI 없이 접속하면 `CN=default.domain` 플레이스홀더 인증서가 나옴(`tls-ip.txt`). 이 경로로 폴백하면 호스트명 검증 실패이거나, 통과한다면 검증을 끄고 있다는 뜻(MITM 위험). → 다음 빌드에서 raw-IP 원본 제거, 항상 호스트명+SNI로 접속. 1번(Cloudflare 전환)을 하면 원본 IP 노출도 함께 사라진다.
3. **HSTS 없음** — 80→308→https는 동작하지만 `Strict-Transport-Security` 헤더가 어느 응답에도 없음(`http-1.txt`). `/account` 로그인 페이지가 http로 먼저 열릴 수 있음. → `add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;`.
4. **nginx 1.18.0 버전 노출** — 모든 응답 `Server: nginx/1.18.0 (Ubuntu)`(2020년 릴리스). → 패키지 업데이트 + `server_tokens off;`.
5. **`/health`가 공개·상세·무제한** — 인증 없이 buildId, 게임 UDP 포트 목록, 수용량, 실시간 ready 상태 노출, 버스트 제한 없음(`burst.txt`). → 공개 응답은 `status`·`gameServerReady` 정도로 축소하고 상세는 토큰 게이트, `limit_req` 적용. 운영자 모니터링에는 그대로 쓰되 외부에는 최소 필드.
6. **`HEAD /v1/guest`가 15초 동안 연결을 잡음** — 401 상태줄만 보내고 Content-Length/EOF 없이 keep-alive 유지, curl exit 28 at 15.002 s(`http-2.txt` 133–146행). GET은 1.1 s에 정상 401. → 앱/nginx에서 HEAD를 GET과 동일하게 종료하거나 405로 즉시 응답. 모니터링 도구·다운로드 매니저가 HEAD를 쓰면 연결이 낭비된다.

**빌드 (다음 R21 빌드에서)**
7. **테스트 하네스와 API 원본 오버라이드가 Shipping 빌드에 남아 있음** — 약 150개 `GP*Probe` 검증 클래스, `Verification/<Suite>/…` 결과 출력 경로, "creating_test_account"·"isolated_test_profile" 등 테스트 문자열, 그리고 **온라인 API 원본을 명령줄로 바꾸는 스위치**(https 또는 loopback으로 정규식 제한됨)와 다수의 시나리오 스위치가 인식됨(inventory §6c; 이름은 여기 적지 않음). 전용 서버 사이드채널(로컬 에이전트 포트 17881, 내부 경로 다수)과 서버 환경변수 이름도 클라이언트 exe에 포함. → **서버가 빌드 ID·티켓 검증을 반드시 강제**할 것(현재 빌드에서는 서버 측 조치로만 막을 수 있음). 다음 빌드에서는 프로브 클래스·스위치·서버 전용 코드를 `#if !UE_BUILD_SHIPPING`으로 제외.
8. **32비트/ARM 설치 가드 없음** — 설치 헤더에 Architectures 항목이 비어 있어 32-bit/ARM32 Windows에 설치는 되고 실행만 실패(`installer-debug.txt`). → `ArchitecturesAllowed=x64compatible` + `ArchitecturesInstallIn64BitMode=x64compatible`.
9. **코드 서명 없음** — `release-info.json` `authenticode: NotSigned`. SmartScreen·브라우저 다운로드 차단 2단계를 매번 겪는다. README에 클릭 경로를 적어 두었지만 서명이 근본 해결. 당장 불가하면 다음 빌드 목표로.
10. **MetaHuman 플러그인이 불필요하게 쿡됨** — 스톡 `DefaultMetaHumanSDK.ini`에 Epic이 모든 UE 5.8에 배포하는 EOS 클라이언트 상수(ProductId/SandboxId/DeploymentId/ClientCredentials)가 그대로 들어 있음(inventory §5, 값은 기재하지 않음). FEIVEN 비밀은 아니지만 공개 저장소·백신·시크릿 스캐너가 반드시 경고한다. → `.uproject`에서 MetaHuman 계열 플러그인 비활성화 후 재쿡.
11. **`d3d12SDKLayers.dll`(D3D12 디버그 레이어, 4.9 MB) 동봉** — `-d3ddebug`에서만 쓰이는 개발용 DLL(inventory §4). 기본 RHI가 DX11이라 더 불필요. → 스테이징에서 제외.
12. **(정보) pak/IoStore 비암호화** — 모든 에셋·설정이 그대로 읽힘. 게임 비밀은 없어 노출 범위는 콘텐츠뿐(inventory §8-4). 필요하면 pak 암호화·서명 검토.

## 5. 이미 적용한 수정

브랜치 **`claude/playtest-readiness-r20.1`** (커밋 391c936, `main` 대비 3 files, +229/−10). **머지되지 않았고 PR도 만들지 않았다.** 운영자가 플레이스홀더를 채운 뒤 머지해야 한다.

| 파일 | 변경 |
|---|---|
| `README.md` | 전면 개정: 상단 상태 배너, 태그 고정 릴리스 링크, 302 MB/435 MB 용량, 소문자 해시 + `certutil`/`Get-FileHash` 확인 명령, R20=R20.1 동일 파일 안내, Windows 10 1809+/64비트 전용·ARM 미지원, SmartScreen/Edge/UAC 클릭 경로("UAC 창은 뜨지 않음" — 설치 헤더 `privileges lowest`로 확인), 방화벽 안내(UDP 17777 나가는 방향), 로그인 페이지 도메인 확인 문구, 혼잡 시 안내(18+48, 재시도 예절), 로그·저장 데이터 경로(`%LOCALAPPDATA%\GroundedPVP\Saved`), 작업 관리자 프로세스 이름 안내, 개인정보 절, 제거 방법, Discord 대체 제보 창구 |
| `.github/ISSUE_TEMPLATE/bug_report.yml` | 필수 필드: 문제 유형, 설치파일 버전/해시 앞 8자리, `winver`, GPU/드라이버, 발생 시각(KST), 재현 단계, 기대/실제; 선택: CPU/RAM, 닉네임, 접속 환경, 빈도, 로그·스크린샷; 확인 체크박스(R20.1 사용, 개인정보 미포함) |
| `.github/ISSUE_TEMPLATE/config.yml` | 빈 이슈 비활성, Discord·README 연락 링크 |

**운영자가 채워야 할 플레이스홀더(`<<운영자 기입>>`)** — README와 디시 글 초안 공통:
최소/권장 사양 · 테스트 기간·서버 여는 시간(KST)·서버 지역 · Google 로그인 제공 여부(제공/미제공으로 단정) · 개인정보 수집 항목·용도·보유 기간·삭제 요청 이메일 · 대기열 만석 시 게임 내 실제 문구 · 평균 경기 시간 · 연령·이용 등급 안내

**디시 글 초안**: 이 폴더의 `dc-post-draft.md`. 링크는 릴리스 페이지(태그 고정)이며 exe 직링크를 쓰지 않는다. 상단 "현재 서버 상태" 줄은 운영자가 수시로 수정하는 용도.

릴리스 본문 r20.1의 `검증 범위` 절(테스트 개수, "비용 보호", "요청 제한", `final3` 등 내부 정보)은 브랜치에서 손대지 않았다 — 릴리스 본문은 GitHub UI에서 운영자가 직접 수정(docs-review B10 참고).

## 6. 배포 전 체크리스트 (운영자, 순서대로)

1. [ ] 전용 서버 기동 → `curl -s https://feiven.teniv.kr/health`에서 `gameServerReady:true` 확인. 내부 테스트 한 판 돌려 `activeMatches`가 1로 올라갔다 0으로 내려오는지 확인.
2. [ ] 운영 시간 슬롯 결정(예: 하루 2–3개, 각 2–3시간) — 슬롯 밖에는 서버를 내리든 올리든 공지와 일치시킬 것. README §6·디시 글에 기입.
3. [ ] `feiven.teniv.kr`을 Cloudflare 프록시(오렌지 클라우드)로 전환, 또는 nginx `limit_req`/`limit_conn` + fail2ban 적용. `server_tokens off;`와 HSTS 헤더도 같은 편집에서 처리.
4. [ ] `/health` 공개 응답 축소(또는 토큰 게이트) 및 `HEAD /v1/guest` 15초 지연 해소.
5. [ ] GitHub 릴리스: r19 → Pre-release + exe 자산 삭제 + 배너; r20 → Pre-release + "r20.1과 동일" 배너. `get_latest_release`가 r20.1을 가리키는지 재확인.
6. [ ] r20.1 릴리스 본문 수정: `검증 범위` 사용자 관점 3문장으로 축약, 해시 소문자, "302,278,948 bytes (약 302 MB)", Google 로그인 문장 단정형.
7. [ ] 이슈 `[공지] 서버 상태 · 혼잡 · 점검 안내` 생성 → **Pin** + **Lock**. 이 URL을 README 배너·릴리스 본문·디시 글에 삽입.
8. [ ] 브랜치 `claude/playtest-readiness-r20.1`의 플레이스홀더(5절 목록) 전부 채우기 → `config.yml`의 링크가 유효한지 확인 → `main`에 머지. 이번 README 갱신 커밋에 태그를 붙여 두면 다음 릴리스부터 `created_at` 순서가 보장된다.
9. [ ] Discord 서버 정비: 현재 멤버 1명·온라인 0명(`discord.txt`). 최소 `#공지`, `#버그제보` 채널과 상태 메시지 하나. 초대 링크 만료 2026-10-13 — 테스트 기간이 그 이후면 무기한 초대로 교체.
10. [ ] "혼잡" 상태 문구를 미리 작성(README 배너·고정 이슈·디시 글 상단·Discord 공지 4곳에 동일하게 붙일 한 줄).
11. [ ] 디시 글 게시 — 링크는 `https://github.com/hsdc1258/feiven-playtest/releases/tag/r20.1-playtest` (exe 직링크·`releases/latest` 금지). 첫 줄에 서버 규모(18+48)와 운영 시간.
12. [ ] 게시 후 첫 1시간: `/health`를 30초 간격으로 폴링(`activeMatches`, `gameServerReady`), nginx access/error 로그 tail, `queue_full`·`server_unavailable` 응답 비율 확인. 대기열이 지속 만석이면 10번 문구로 즉시 상태 갱신.
13. [ ] 다음 빌드(R21) 백로그에 4절 7–11번 등록: 프로브/스위치 제거, MetaHuman 비활성, SDKLayers 제외, 64비트 가드, 코드 서명, raw-IP 원본 제거.

## 7. 부하 관점 메모 (관측 증거 기반)

디시 규모(수백 명 동시 유입)에서 먼저 무너지는 순서:

1. **좌석(seating)** — 서버가 ready라도 3경기×6명=18명. 대기열 48명은 `queueLeaseMs:60000`(60초 리스) 기준으로 순환하므로, 유입이 분당 66명을 넘는 순간부터 `queue_full` 거절이 기본 경험이 된다. 이는 장애가 아니라 **용량 불일치**이며, 공지 문구와 시간대 분할로만 완화 가능하다.
2. **단일 VPS의 로그인 브리지** — 계정 생성·Google 로그인은 브라우저 `/account?t=…` 페이지를 거치는데, 이 페이지·API·매치메이킹·health가 모두 CDN/WAF 없는 nginx/1.18 한 대에서 종단된다(`doh.txt`: DNS-only; `burst.txt`: 제한 없음). 게임에 못 들어간 사람들이 로그인을 반복하면 이 부분이 먼저 느려질 가능성이 가장 높다. UDP 게임 트래픽은 18명 상한이라 여기서는 병목이 아니다.
3. **용량 불일치 자체** — 약 66명이 서비스되고 나머지는 전부 실패 경험. 첫날 평판은 "서버 터짐"으로 굳는다. B2·체크리스트 2·10·11로 기대치를 먼저 낮추는 것이 유일한 대응.
4. **다운로드는 안전** — GitHub 릴리스 자산은 `objects.githubusercontent.com` CDN으로 302, `Accept-Ranges: bytes`, `Content-Range: bytes 0-0/302278948`(이어받기 가능, 크기 일치)(`gh.txt`, `gh-range-hdr.txt`). 수백 명 규모에서 대역폭 문제 없음. 단 서명 URL에 **HEAD를 보내면 401**이라 HEAD로 먼저 검사하는 다운로드 매니저는 오류를 표시할 수 있다(GET·이어받기는 정상). 문의가 오면 "브라우저로 직접 받으세요"로 안내.
5. **TLS** — 주 호스트의 SAN은 `feiven.teniv.kr`을 덮고 있어 구조적으로 정상이나, 만료일·발급자는 이 샌드박스에서 확인 불가. 공지 전 운영자가 `openssl s_client -servername feiven.teniv.kr`로 notAfter를 직접 확인할 것. raw-IP 폴백 경로는 4절 2번 참조.

---
근거 파일: 설치파일 인벤토리·백엔드 프로브 원자료는 세션 작업 폴더에만 두었고(원본 IP 등 포함) 저장소에는 요약본인 이 문서, `docs-review.md`, `dc-post-draft.md`만 커밋했다. 이 보고서에 없는 수치는 관측하지 않은 것이다.
