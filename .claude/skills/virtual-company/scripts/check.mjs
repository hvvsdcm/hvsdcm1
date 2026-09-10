#!/usr/bin/env node
// virtual-company 스킬 구조 검증기.
// 저장소 루트에서 `node .claude/skills/virtual-company/scripts/check.mjs` 로 실행한다.
// 의존성 없음(Node 20+). 실패가 하나라도 있으면 종료코드 1.
// 경로는 이 스크립트 위치를 기준으로 계산하므로 어느 디렉터리에서 실행해도 같은 결과가 나온다.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(SKILL_DIR, '..', '..', '..');
const AGENTS_DIR = join(REPO_ROOT, '.claude', 'agents');

// (a) 12개 부서 id. 이 목록이 스킬 전체의 단일 원본이다.
const DEPARTMENTS = [
  'strategy',
  'product',
  'engineering',
  'design',
  'marketing',
  'paid-media',
  'sales',
  'finance',
  'project-management',
  'support',
  'specialized',
  'academic',
];

// (c) 부서 reference가 이 순서로 가져야 하는 H2 헤딩.
const REQUIRED_HEADINGS = [
  '## 1. 역할과 구성원',
  '## 2. 소집 조건',
  '## 3. 수집해야 할 정보',
  '## 4. 도구와 플러그인',
  '## 5. 작업 지침',
  '## 6. 산출물 템플릿',
  '## 7. 다른 부서와의 인터페이스',
  '## 8. 완료 체크리스트',
];

// 3절 하위 헤딩. 내부/외부/의존성 구분이 빠지면 브리프 체크리스트를 발췌할 수 없다.
const REQUIRED_SUBHEADINGS = [
  '### 3.1 사용자·저장소에서 (내부)',
  '### 3.2 웹·외부 소스에서 (외부)',
  '### 3.3 다른 부서로부터 (입력 의존성)',
];

const ALLOWED_MODELS = ['opus', 'sonnet', 'haiku', 'inherit'];
const SKILL_BODY_MAX_LINES = 500;

const failures = [];

function fail(file, reason) {
  failures.push({ file: relative(REPO_ROOT, file) || file, reason });
}

function readIfExists(file, label) {
  if (!existsSync(file)) {
    fail(file, `${label} 파일이 없다`);
    return null;
  }
  return readFileSync(file, 'utf8');
}

// `---` 로 감싼 frontmatter를 얕게 파싱한다. 값은 첫 콜론 뒤 전부.
function parseFrontmatter(text) {
  const lines = text.split('\n');
  if (lines[0].trim() !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end === -1) return null;
  const data = {};
  for (const line of lines.slice(1, end)) {
    const at = line.indexOf(':');
    if (at === -1) continue;
    data[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { data, bodyLines: lines.slice(end + 1) };
}

// (e) SKILL.md
function checkSkill() {
  const file = join(SKILL_DIR, 'SKILL.md');
  const text = readIfExists(file, 'SKILL.md');
  if (text === null) return;

  const fm = parseFrontmatter(text);
  if (!fm) {
    fail(file, 'frontmatter(--- 블록)를 찾지 못했다');
    return;
  }
  if (fm.data.name !== 'virtual-company') {
    fail(file, `frontmatter name이 "virtual-company"가 아니다 (현재: ${fm.data.name ?? '없음'})`);
  }
  if (!fm.data.description) {
    fail(file, 'frontmatter description이 비어 있다');
  }

  const bodyCount = fm.bodyLines.length;
  if (bodyCount > SKILL_BODY_MAX_LINES) {
    fail(file, `본문이 ${bodyCount}줄로 상한 ${SKILL_BODY_MAX_LINES}줄을 넘었다. 세부는 references로 옮겨라`);
  }
}

// (f)(g) routing.md / tooling.md 에 12개 id가 모두 등장하는지.
function checkIdCoverage(name) {
  const file = join(SKILL_DIR, 'references', name);
  const text = readIfExists(file, name);
  if (text === null) return;

  const missing = DEPARTMENTS.filter((id) => !text.includes(id));
  if (missing.length > 0) {
    fail(file, `부서 id가 빠졌다: ${missing.join(', ')}`);
  }
}

// (b)(c) 부서 reference 파일
function checkDepartmentReference(id) {
  const file = join(SKILL_DIR, 'references', 'departments', `${id}.md`);
  const text = readIfExists(file, `${id} reference`);
  if (text === null) return;

  const h1 = text.split('\n').find((line) => line.startsWith('# '));
  if (!h1 || !h1.trimEnd().endsWith(`(${id})`)) {
    fail(file, `H1 제목이 "# <한국어 명칭> (${id})" 형식이 아니다`);
  }

  let cursor = 0;
  for (const heading of REQUIRED_HEADINGS) {
    const at = text.indexOf(`\n${heading}`, cursor);
    if (at === -1) {
      const anywhere = text.includes(`\n${heading}`);
      fail(file, anywhere ? `헤딩 순서가 어긋났다: "${heading}"` : `필수 헤딩이 없다: "${heading}"`);
      return;
    }
    cursor = at + heading.length;
  }

  const section3 = text.slice(text.indexOf('\n## 3.'), text.indexOf('\n## 4.'));
  const missingSub = REQUIRED_SUBHEADINGS.filter((sub) => !section3.includes(sub));
  if (missingSub.length > 0) {
    fail(file, `3절 하위 헤딩이 없다: ${missingSub.join(' / ')}`);
  }
}

// (b)(d) 부서 에이전트 파일
function checkDepartmentAgent(id) {
  const file = join(AGENTS_DIR, `dept-${id}.md`);
  const text = readIfExists(file, `dept-${id} agent`);
  if (text === null) return;

  const fm = parseFrontmatter(text);
  if (!fm) {
    fail(file, 'frontmatter(--- 블록)를 찾지 못했다');
    return;
  }
  if (fm.data.name !== `dept-${id}`) {
    fail(file, `frontmatter name이 "dept-${id}"가 아니다 (현재: ${fm.data.name ?? '없음'})`);
  }
  if (!fm.data.description) {
    fail(file, 'frontmatter description이 비어 있다');
  }
  if (!fm.data.model) {
    fail(file, 'frontmatter model이 없다');
  } else if (!ALLOWED_MODELS.includes(fm.data.model)) {
    fail(file, `model 값이 허용 목록에 없다: ${fm.data.model} (허용: ${ALLOWED_MODELS.join(', ')})`);
  }
}

checkSkill();
checkIdCoverage('routing.md');
checkIdCoverage('tooling.md');
for (const id of DEPARTMENTS) {
  checkDepartmentReference(id);
  checkDepartmentAgent(id);
}

const checked = 3 + DEPARTMENTS.length * 2;
if (failures.length === 0) {
  console.log(`virtual-company: ${checked}개 파일 검사, 문제 없음 (부서 ${DEPARTMENTS.length}개)`);
  process.exit(0);
}

console.error(`virtual-company: ${failures.length}건 실패 / ${checked}개 파일 검사`);
for (const { file, reason } of failures) {
  console.error(`${file}: ${reason}`);
}
process.exit(1);
