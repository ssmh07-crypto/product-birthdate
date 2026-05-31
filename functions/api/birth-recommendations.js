const SAZU_API_URL = "https://api.sazu.app/v1/sazu/calculate";
const CACHE_TTL_SECONDS = 24 * 60 * 60;

const stems = ["갑", "을", "병", "정", "무", "기", "경", "신", "임", "계"];
const branches = ["자", "축", "인", "묘", "진", "사", "오", "미", "신", "유", "술", "해"];
const stemElement = {
  갑: "wood", 을: "wood", 병: "fire", 정: "fire", 무: "earth",
  기: "earth", 경: "metal", 신: "metal", 임: "water", 계: "water",
};
const branchElement = {
  자: "water", 해: "water", 인: "wood", 묘: "wood", 사: "fire",
  오: "fire", 신: "metal", 유: "metal", 진: "earth", 술: "earth",
  축: "earth", 미: "earth",
};

export async function onRequestPost(context) {
  try {
    if (!context.env.SAZU_API_KEY) {
      return json({ ok: false, error: "서버의 SAZU_API_KEY가 설정되지 않았습니다." }, 500);
    }

    const input = await context.request.json();
    validateInput(input);

    const cache = globalThis.caches?.default;
    const cacheKey = await makeCacheKey(input);
    const cached = cache ? await cache.match(cacheKey) : null;
    if (cached) return cached;

    const data = await recommendBirthDates(input, context.env.SAZU_API_KEY);
    const response = json({ ok: true, data }, 200, {
      "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
    });
    if (cache) context.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    console.error("Birth recommendation error", error.code || "", error.message || error);
    return json({ ok: false, error: publicError(error) }, error.statusCode || 500);
  }
}

export function onRequest() {
  return json({ ok: false, error: "지원하지 않는 요청입니다." }, 405);
}

async function recommendBirthDates(input, apiKey) {
  const dueDate = parseDate(input.dueDate);
  const startDate = addDays(dueDate, -28);
  const approximateCandidates = [];

  for (let date = startDate; date <= dueDate; date = addDays(date, 1)) {
    for (let hour = 1; hour < 24; hour += 2) {
      const saju = makeApproximateSaju(date, hour);
      approximateCandidates.push({
        date: toDateString(date),
        hour,
        approximateScore: scoreBalance(countElements(saju)),
      });
    }
  }

  const [candidate] = pickCandidates(approximateCandidates, 1);
  const [mother, father, child] = await Promise.all([
    calculatePerson(input.motherDate, input.motherTime, true, input.birthCity, apiKey),
    calculatePerson(input.fatherDate, input.fatherTime, false, input.birthCity, apiKey),
    calculatePerson(candidate.date, toTimeString(candidate.hour), input.babyGender === "female", input.birthCity, apiKey),
  ]);
  const count = getApiElementCount(child);

  return {
    range: { startDate: toDateString(startDate), endDate: toDateString(dueDate) },
    candidates: [{
      ...candidate,
      saju: normalizePillars(child),
      count,
      balance: scoreBalance(count),
      motherHarmony: scoreHarmony(count, getApiElementCount(mother)),
      fatherHarmony: scoreHarmony(count, getApiElementCount(father)),
      sociality: count.fire + count.wood >= 3 ? 91 : 84,
      rank: "1순위",
      timeText: formatTimeRange(candidate.hour),
    }],
  };
}

async function calculatePerson(date, time, isFemale, birthCity, apiKey) {
  const parsed = parseDate(date);
  const [birthHour, birthMinute] = time.split(":").map(Number);
  const response = await fetch(SAZU_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "X-Client-Type": "pages-function" },
    body: JSON.stringify({
      birthYear: parsed.getFullYear(), birthMonth: parsed.getMonth() + 1, birthDay: parsed.getDate(),
      birthHour, birthMinute, isFemale, isLunar: false, birthCity,
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success !== true) {
    const error = new Error(body?.error?.message || "만세력 API 응답을 받지 못했습니다.");
    error.code = body?.error?.code;
    error.statusCode = response.status === 429 ? 429 : 502;
    throw error;
  }
  return body.data;
}

function validateInput(input) {
  const required = ["motherDate", "motherTime", "fatherDate", "fatherTime", "dueDate", "babyGender", "birthCity"];
  for (const field of required) if (!input[field]) throw badRequest("모든 입력 항목을 입력해주세요.");
  if (!["male", "female"].includes(input.babyGender)) throw badRequest("아이 성별을 확인해주세요.");
  for (const field of ["motherDate", "fatherDate", "dueDate"]) parseDate(input[field]);
  for (const field of ["motherTime", "fatherTime"]) {
    if (!/^\d{2}:\d{2}$/.test(input[field])) throw badRequest("출생 시간을 확인해주세요.");
  }
}

function pickCandidates(candidates, limit) {
  return [...candidates].sort((a, b) => b.approximateScore - a.approximateScore || a.date.localeCompare(b.date) || a.hour - b.hour).slice(0, limit);
}

function normalizePillars(result) {
  const source = result.modules?.fourPillars || {};
  return { time: normalizePillar(source.hour), day: normalizePillar(source.day), month: normalizePillar(source.month), year: normalizePillar(source.year) };
}

function normalizePillar(pillar = {}) {
  const hangul = pillar.hangul || pillar.korean || pillar.ganji || pillar.full || "";
  const stem = pillar.stem?.hangul || pillar.stemHangul || pillar.stem || pillar.sky || hangul[0];
  const branch = pillar.branch?.hangul || pillar.branchHangul || pillar.branch || pillar.earth || hangul[1];
  if (!stemElement[stem] || !branchElement[branch]) throw new Error("만세력 API 응답 형식을 해석하지 못했습니다.");
  return [stem, branch];
}

function getApiElementCount(result) { return countElements(normalizePillars(result)); }
function scoreHarmony(child, parent) { return Math.max(60, 100 - Object.keys(child).reduce((sum, key) => sum + Math.abs(child[key] - parent[key]), 0) * 5); }
function makeApproximateSaju(date, hour) { return { time: getTimePillar(date, hour), day: getDayPillar(date), month: getMonthPillar(date), year: getYearPillar(date.getFullYear()) }; }
function getYearPillar(year) { return [stems[(year - 4) % 10], branches[(year - 4) % 12]]; }
function getMonthPillar(date) { const month = date.getMonth() + 1; const branchIndex = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, 11: 11, 12: 0 }; const yearStemIndex = (date.getFullYear() - 4) % 10; return [stems[(yearStemIndex * 2 + month + 1) % 10], branches[branchIndex[month]]]; }
function getDayPillar(date) { const diff = Math.floor((date - new Date(1900, 0, 31)) / 86400000); return [stems[((diff % 10) + 10) % 10], branches[(((diff + 4) % 12) + 12) % 12]]; }
function getTimePillar(date, hour) { const dayStemIndex = stems.indexOf(getDayPillar(date)[0]); const branchIndex = getTimeBranch(hour); const firstStem = { 0: 0, 5: 0, 1: 2, 6: 2, 2: 4, 7: 4, 3: 6, 8: 6, 4: 8, 9: 8 }[dayStemIndex]; return [stems[(firstStem + branchIndex) % 10], branches[branchIndex]]; }
function getTimeBranch(hour) { return hour >= 23 || hour < 1 ? 0 : Math.floor((hour + 1) / 2); }
function countElements(saju) { const count = { wood: 0, fire: 0, earth: 0, metal: 0, water: 0 }; Object.values(saju).forEach(([stem, branch]) => { count[stemElement[stem]]++; count[branchElement[branch]]++; }); return count; }
function scoreBalance(count) { const values = Object.values(count); return Math.max(60, 100 - (Math.max(...values) - Math.min(...values)) * 12); }
function formatTimeRange(hour) { return `${formatHour(hour)} ~ ${formatHour((hour + 2) % 24)}`; }
function formatHour(hour) { if (hour === 0) return "오전 12시"; if (hour < 12) return `오전 ${hour}시`; if (hour === 12) return "오후 12시"; return `오후 ${hour - 12}시`; }
function toTimeString(hour) { return `${String(hour).padStart(2, "0")}:00`; }
function parseDate(value) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw badRequest("날짜 형식을 확인해주세요."); const [year, month, day] = value.split("-").map(Number); const date = new Date(year, month - 1, day); if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw badRequest("유효하지 않은 날짜입니다."); return date; }
function addDays(date, days) { const result = new Date(date); result.setDate(result.getDate() + days); return result; }
function toDateString(date) { return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-"); }
function badRequest(message) { return Object.assign(new Error(message), { statusCode: 400 }); }
function publicError(error) { if (error.statusCode === 400) return error.message; if (error.statusCode === 429) return "만세력 API 호출 한도를 초과했습니다. 잠시 후 다시 시도해주세요."; if (error.code === "INVALID_API_KEY") return "만세력 API 인증에 실패했습니다. 서버의 SAZU_API_KEY를 확인해주세요."; return "만세력 API 응답을 받지 못했습니다. 잠시 후 다시 시도해주세요."; }
function json(body, status = 200, headers = {}) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } }); }
async function makeCacheKey(input) { const bytes = new TextEncoder().encode(JSON.stringify(input)); const hash = await crypto.subtle.digest("SHA-256", bytes); const hex = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); return new Request(`https://cache.product-birthdate/recommendations/${hex}`); }
