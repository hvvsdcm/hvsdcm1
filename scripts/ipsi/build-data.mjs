// 입시 진단 데이터 생성기.
//   scripts/ipsi/source/adiga-2026.json  (어디가 2026학년도 최종등록자 70% 컷 — 학점나비 집계 페이지에서 파싱)
//   scripts/ipsi/source/rules-2027.json  (2027학년도 정시 수능 반영 방법 — 각 대학 시행계획)
//   scripts/ipsi/source/scales-2026.json (수능 등급컷 기준표)
// 를 합쳐 ipsi/assets/js/data.js(window.IPSI_DATA)를 만든다. 생성물은 손으로 고치지 않는다 —
// 소스를 고치고 `node scripts/ipsi/build-data.mjs`를 다시 돌린다. scripts/ipsi/ipsi.test.mjs가
// 생성물의 범위·출처 불변식을 검사한다.
//
// 계열 분류는 모집단위 이름의 키워드로 정한다. 어디가 표에는 계열이 없으므로 여기서 도출하고,
// 애매한 이름은 인문으로 둔다(자연계 가산점을 잘못 얹는 쪽보다 안전하다).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SOURCE = path.join(ROOT, 'scripts/ipsi/source');
const OUTPUT = path.join(ROOT, 'ipsi/assets/js/data.js');

const read = (file) => JSON.parse(readFileSync(path.join(SOURCE, file), 'utf8'));

// 유명 대학 라인(서열 묶음). 화면의 대학 순서와 필터 묶음이 이 표를 쓴다.
export const LINES = [
  { label: '서연고', ids: ['snu', 'yonsei', 'korea'] },
  { label: '서성한', ids: ['sogang', 'skku', 'hanyang'] },
  { label: '중경외시이', ids: ['cau', 'khu', 'hufs', 'uos', 'ewha'] },
  { label: '건동홍숙', ids: ['konkuk', 'dongguk', 'hongik', 'sookmyung'] },
  { label: '국숭세단', ids: ['kookmin', 'soongsil', 'sejong', 'dankook'] },
  { label: '광명상가', ids: ['kw', 'mju', 'smu', 'catholic'] },
  { label: '한서삼', ids: ['hansung', 'skuniv', 'syu'] },
];
const SHORT = {
  snu: '서울대', yonsei: '연세대', korea: '고려대', sogang: '서강대', skku: '성균관대', hanyang: '한양대',
  cau: '중앙대', khu: '경희대', hufs: '한국외대', uos: '서울시립대', ewha: '이화여대',
  konkuk: '건국대', dongguk: '동국대', hongik: '홍익대', sookmyung: '숙명여대',
  kookmin: '국민대', soongsil: '숭실대', sejong: '세종대', dankook: '단국대',
  kw: '광운대', mju: '명지대', smu: '상명대', catholic: '가톨릭대',
  hansung: '한성대', skuniv: '서경대', syu: '삼육대',
};

const MEDICAL = /의예|의학|치의|한의|약학|수의|간호|물리치료|임상병리|방사선|치위생|작업치료|응급구조|보건/u;
const ARTS = /음악|미술|디자인|회화|조소|조형|무용|체육|스포츠|연극|영화|연기|뮤지컬|작곡|성악|피아노|관현악|국악|공예|도예|사진|애니메이션|만화|패션|뷰티|모델|실용음악|예술|골프|경기지도|아트|서예|의상|공연/u;
const FREE = /자유전공|자율전공|열린전공|광역|무전공|혁신칼리지|융합자유|창의융합자유/u;
const SCIENCE = /공학|공과|과학|물리|화학|생명|생물|지구|천문|수학|통계|전자|전기|기계|컴퓨터|소프트웨어|정보|데이터|인공지능|AI|ICT|반도체|신소재|재료|건축|토목|환경|에너지|화공|산업|시스템|로봇|항공|자동차|조선|해양|원자력|바이오|식품|농|원예|산림|축산|동물|의생명|나노|모빌리티|자연|IT|메카|융합보안|보안|응용|디스플레이|스마트|기술|섬유|주거|의류|식영|영양|아동|가정|간호|수의|약학|이과|공대|SW|테크|지능|네트워크|배터리|양자|우주|사이버|전산/u;
const HUMAN_OVERRIDE = /경영정보|정보사회|문헌정보|정보문화|기술경영|식품자원경제|농경제|사회복지|아동가족|아동학|의류|소비자|주거환경|융합바이오공학경영|정보디스플레이|지리학과\(인문\)|컴퓨터･AI학부\(인문\)/u;
const ENGINEERING = /공학부|공학과|공학$|공과대학|공학계열/u;
const BUSINESS = /경영|경제|무역|금융|회계|세무|통상|상경|비즈니스|글로벌경영|경상|국제통상|재무|마케팅|유통|물류|호텔|관광|부동산|광고|핀테크/u;

export function classifyTrack(name) {
  const text = String(name || '');
  // '자유전공학부'의 '전공학'이 '공학'에 걸리지 않도록 계열 판정은 '전공'을 뺀 이름으로 한다.
  const base = text.replace(/전공/gu, '');
  if (FREE.test(text)) {
    if (/자연|이공|공학|IT|과학/u.test(base)) return { track: '자연', ruleTrack: null };
    if (/인문|사회|경영|경제/u.test(text)) return { track: '인문', ruleTrack: BUSINESS.test(text) ? '상경' : null };
    return { track: '자유전공', ruleTrack: null };
  }
  if (MEDICAL.test(text) && !/보건행정|보건관리|의료경영|의료산업/u.test(text)) return { track: '의약', ruleTrack: null };
  if (ARTS.test(text) && !/스포츠경영|공연기획|예술경영|문화예술경영|영상학과|미디어/u.test(text)) return { track: '예체능', ruleTrack: null };
  if (ENGINEERING.test(base) && !/\(인문\)/u.test(text)) return { track: '자연', ruleTrack: null };
  if (HUMAN_OVERRIDE.test(text)) return { track: '인문', ruleTrack: null };
  if (/\(인문\)|\(문\)/u.test(text)) return { track: '인문', ruleTrack: BUSINESS.test(text) ? '상경' : null };
  if (/\(자연\)|\(이\)/u.test(text)) return { track: '자연', ruleTrack: null };
  if (SCIENCE.test(base)) return { track: '자연', ruleTrack: null };
  return { track: '인문', ruleTrack: BUSINESS.test(text) ? '상경' : null };
}

function buildUniversities(adiga, rules) {
  const byId = new Map(adiga.map((row) => [row.id, row]));
  const universities = [];
  let order = 0;
  for (const line of LINES) {
    for (const id of line.ids) {
      const source = byId.get(id);
      const rule = rules.universities[id];
      order += 1;
      const departments = (source?.departments || [])
        .filter((dept) => Object.keys(dept.jeongsi || {}).length > 0)
        .map((dept) => {
          const { track, ruleTrack } = classifyTrack(dept.name);
          const jeongsi = {};
          for (const [year, row] of Object.entries(dept.jeongsi)) {
            if (year === 'alts') continue;
            jeongsi[year] = {
              cut70: row.pct70 ?? null, cut50: row.pct50 ?? null, score70: row.score70 ?? null,
              metric: row.pct70 !== null && row.pct70 !== undefined ? 'pct' : 'score',
              group: row.group || null, quota: row.quota ?? null, rate: row.rate ?? null, fill: row.fill ?? null,
              typeName: row.typeName || '', source: row.source, url: row.url,
            };
          }
          const susi = (kind) => {
            const out = {};
            for (const [year, row] of Object.entries(dept[kind] || {})) {
              out[year] = { cut70: row.cut70, cut50: row.cut50 ?? null, typeName: row.typeName || '', quota: row.quota ?? null, rate: row.rate ?? null, source: row.source, url: row.url };
            }
            return out;
          };
          return { name: dept.name, track, ruleTrack, jeongsi, gyogwa: susi('gyogwa'), hakjong: susi('hakjong') };
        })
        .sort((left, right) => left.name.localeCompare(right.name, 'ko'));
      universities.push({
        id, name: rule?.name || source?.name || id, short: SHORT[id] || id, line: line.label, order,
        resultUrl: source?.url || null, departments,
      });
    }
  }
  return universities;
}

export function buildData() {
  const adiga = read('adiga-2026.json');
  const rules = read('rules-2027.json');
  const scales = read('scales-2026.json');
  const universities = buildUniversities(adiga, rules);
  const ruleMap = {};
  for (const [id, rule] of Object.entries(rules.universities)) ruleMap[id] = rule;
  return {
    generatedAt: new Date().toISOString().slice(0, 10),
    lines: LINES,
    universities,
    rules: ruleMap,
    scales,
    sources: {
      results: { title: '대입정보포털 어디가 2026학년도 입시결과(학점나비 집계 페이지 경유)', url: 'https://www.adiga.kr/', note: '최종등록자 상위 70% 컷. 정시는 국·수·탐(2) 백분위 평균, 수시는 학생부 등급.' },
      rules: { title: '각 대학 2027학년도 대학입학전형 시행계획(2025.4~5)', url: 'https://www.kcue.or.kr/', note: '영역별 반영비율·영어/한국사 처리·선택과목 가산.' },
    },
  };
}

function render(data) {
  const universityCount = data.universities.length;
  const departmentCount = data.universities.reduce((sum, university) => sum + university.departments.length, 0);
  return `// 생성물 — scripts/ipsi/build-data.mjs가 scripts/ipsi/source/*.json에서 만든다. 손으로 고치지 않는다.
// 불변식: 대학 ${universityCount}개, 정시 결과가 있는 모집단위 ${departmentCount}개, 2027 반영 규칙 ${Object.keys(data.rules).length}개 대학.
// 내용은 공개 입시 통계(어디가·대학 입학처)라 보호 학습 콘텐츠가 아니며 정적으로 실린다.
window.IPSI_DATA = ${JSON.stringify(data)};
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT, 'scripts/ipsi/build-data.mjs')) {
  const data = buildData();
  writeFileSync(OUTPUT, render(data), 'utf8');
  const departments = data.universities.reduce((sum, university) => sum + university.departments.length, 0);
  console.log(`wrote ${path.relative(ROOT, OUTPUT)}: ${data.universities.length} universities, ${departments} departments`);
}
