import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = resolve(ROOT, `.${pathname.endsWith('/') ? pathname + 'index.html' : pathname}`);
    if (!file.startsWith(resolve(ROOT) + sep)) throw new Error('outside root');
    const bytes = await readFile(file);
    response.writeHead(200, { 'content-type': ({ '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml' })[extname(file)] || 'application/octet-stream' });
    response.end(bytes);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const errors = [];
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks += 1; };
const wordPayload = Array.from({length:2000},(_,i)=>({id:`w${i+1}`,word:`word${i+1}`,meaning:`뜻${i+1}`,meanings:[`뜻${i+1}`],day:Math.floor(i/40)+1,number:i%40+1}));
const smPayload = {
  units: [{ id:'I', title:'사회·문화 현상의 탐구', subs:[{ id:'I-01', title:'사회·문화 현상', unitId:'I', unitTitle:'사회·문화 현상의 탐구', time:12, keywords:'사회 현상', sections:[{title:'기본 개념',points:['사회적 상호 작용'],trap:'자연 현상과 구분'}], visual:{question:'판별',flow:['대상','원인','결론'],checks:['의미','가치','규범']} }] }],
  questions: [{id:'q1',sub:'I-01',prompt:'다음 중 옳은 것은?',choices:['① A','② B','③ C','④ D','⑤ E'],answer:1,rate:55,tags:['사회 현상'],year:2026,round:'6월',number:1,weak:true}],
  notebooks: {'I-01':{headline:'사회·문화 현상의 핵심',summary:['사회적 의미를 파악한다'],keyPoints:[{label:'핵심',text:'사회적 상호 작용의 결과'}],diagrams:[],decision:['대상 확인','맥락 확인','선지 판별'],matrix:{title:'비교',headers:['구분','사회'],rows:[['의미','있음']]},recall:[{question:'핵심은?',answer:'사회적 의미'}],exam:{trend:'개념 구분',trap:'표현 바꾸기',tags:['사회 현상']},deepDive:[{term:'사회 현상',points:['사람 사이 관계']}]}},
  explanations: {GUIDES:{'I-01':{focus:'핵심',correctReason:'정답',wrongReason:'오답',checks:['1','2','3']}},EBS_PAST_EXAMS:'https://www.ebsi.co.kr/'},
  learningDesign:{title:'학습 설계',summary:'반복 학습',steps:[],evidence:[]}
};
const manifest = { exams: [
  {id:'2025-csat-korean-question',subject:'korean',year:2025,grade_year:2026,round:'csat',track:null,kind:'question',r2_key:'a.pdf',pages:12},
  {id:'2025-csat-korean-answer',subject:'korean',year:2025,grade_year:2026,round:'csat',track:null,kind:'answer',r2_key:'b.pdf',pages:1},
]};
async function contextFor(app) {
  const context = await browser.newContext({ viewport:{width:390,height:844}, colorScheme:'light' });
  await context.addInitScript(() => { localStorage.setItem('hvsdcm.token','fixture'); localStorage.setItem('hvsdcm.user','fixture'); });
  await context.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname === '/api/me') body={user:{id:1,username:'fixture'}};
    else if (url.pathname === '/api/progress/wordmaster' || url.pathname === '/api/progress/smstudy') body=route.request().method()==='PUT'?{ok:true}:{data:null};
    else if (url.pathname === '/api/answers/wordmaster' || url.pathname === '/api/answers/smstudy') body={answers:[]};
    else if (url.pathname === '/api/learning/wordmaster') body={words:wordPayload};
    else if (url.pathname === '/api/learning/smstudy') body={data:{UNITS:smPayload.units,QUESTIONS:smPayload.questions},notebook:{NOTEBOOKS:smPayload.notebooks,LEARNING_DESIGN:smPayload.learningDesign},explanations:smPayload.explanations};
    else if (url.pathname === '/api/gichul/manifest') body=manifest;
    else throw new Error(`Unexpected ${app} API ${url.pathname}`);
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  return context;
}
async function verify(path, readySelector) {
  const context = await contextFor(path);
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(`${path}: ${e.message}`));
  await page.goto(origin + path);
  await page.locator(readySelector).waitFor();
  check(await page.locator('#studyThemeToggle').isVisible(), `${path} theme toggle visible`);
  check(await page.evaluate(() => document.documentElement.dataset.theme === 'light'), `${path} starts light with OS`);
  const lightBg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  await page.click('#studyThemeToggle');
  check(await page.evaluate(() => document.documentElement.dataset.theme === 'dark'), `${path} toggles dark`);
  const darkBg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  check(lightBg !== darkBg, `${path} palettes differ`);
  await page.reload(); await page.locator(readySelector).waitFor();
  check(await page.evaluate(() => document.documentElement.dataset.theme === 'dark'), `${path} theme persists`);
  for (const width of [320,390,768,1024,1280]) {
    await page.setViewportSize({width,height:900});
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${path} no page overflow at ${width}`);
    check(await page.locator('main').isVisible(), `${path} main visible at ${width}`);
  }
  await context.close();
}
try {
  await verify('/WordMaster/', '#dailyStartBtn');
  await verify('/smstudy/', '#app');
  await verify('/gichul/', '#gichulBody');
  check(errors.length === 0, `no browser errors: ${errors.join(' | ')}`);
  console.log(`Study UI E2E passed (${checks} assertions).`);
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
}
