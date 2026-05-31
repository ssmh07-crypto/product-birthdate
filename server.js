import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SazuApiError, SazuClient } from "@sazuapp/client";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT || 3000);

await loadEnv(join(ROOT, ".env"));

if (!process.env.SAZU_API_KEY) {
  throw new Error("SAZU_API_KEY is missing. Add it to .env before starting the server.");
}

const sazu = new SazuClient({ apiKey: process.env.SAZU_API_KEY });
const SAZU_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SAZU_CACHE_MAX_ENTRIES = 1000;
const sazuCache = new Map();

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

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && req.url === "/api/birth-recommendations") {
      const body = await readJson(req);
      const result = await recommendBirthDates(body);
      return sendJson(res, 200, { ok: true, data: result });
    }

    if (req.method !== "GET") {
      return sendJson(res, 405, { ok: false, error: "지원하지 않는 요청입니다." });
    }

    await serveStatic(req.url === "/" ? "/index.html" : req.url, res);
  } catch (error) {
    if (error instanceof SazuApiError) {
      console.error("SAZU API error", error.code, error.responseId || "");
      return sendJson(res, error.isRateLimited ? 429 : 502, {
        ok: false,
        error: error.isRateLimited
          ? "만세력 API 호출 한도를 초과했습니다. 잠시 후 다시 시도해주세요."
          : error.isAuthError
            ? "만세력 API 인증에 실패했습니다. 서버의 SAZU_API_KEY를 확인해주세요."
            : "만세력 API 응답을 받지 못했습니다. 잠시 후 다시 시도해주세요.",
      });
    }

    console.error(error);
    sendJson(res, error.statusCode || 500, {
      ok: false,
      error: error.message || "서버 오류가 발생했습니다.",
    });
  }
});

server.listen(PORT, () => {
  console.log(`Birthdate app listening on http://localhost:${PORT}`);
});

async function recommendBirthDates(input) {
  validateInput(input);

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

  const shortlisted = pickSpreadCandidates(approximateCandidates, 1);
  const [mother, father, ...children] = await Promise.all([
    calculatePerson(input.motherDate, input.motherTime, true, input.birthCity),
    calculatePerson(input.fatherDate, input.fatherTime, false, input.birthCity),
    ...shortlisted.map((candidate) =>
      calculatePerson(candidate.date, toTimeString(candidate.hour), input.babyGender === "female", input.birthCity)
    ),
  ]);

  const candidates = shortlisted.map((candidate, index) => {
    const child = children[index];
    const count = getApiElementCount(child);
    const balance = scoreBalance(count);
    const motherHarmony = scoreHarmony(count, getApiElementCount(mother));
    const fatherHarmony = scoreHarmony(count, getApiElementCount(father));

    return {
      ...candidate,
      saju: normalizePillars(child),
      count,
      balance,
      motherHarmony,
      fatherHarmony,
      sociality: count.fire + count.wood >= 3 ? 91 : 84,
    };
  });

  candidates.sort((a, b) =>
    totalScore(b) - totalScore(a) || a.date.localeCompare(b.date) || a.hour - b.hour
  );

  return {
    range: { startDate: toDateString(startDate), endDate: toDateString(dueDate) },
    candidates: candidates.map((candidate, index) => ({
      ...candidate,
      rank: `${index + 1}순위`,
      timeText: formatTimeRange(candidate.hour),
    })),
  };
}

async function calculatePerson(date, time, isFemale, birthCity) {
  const parsed = parseDate(date);
  const [hour] = time.split(":").map(Number);
  const input = {
    birthYear: parsed.getFullYear(),
    birthMonth: parsed.getMonth() + 1,
    birthDay: parsed.getDate(),
    birthHour: hour,
    isFemale,
    isLunar: false,
    birthCity,
  };
  const key = JSON.stringify(input);
  const cached = sazuCache.get(key);

  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) sazuCache.delete(key);

  const value = sazu.calculate(input);
  sazuCache.set(key, { value, expiresAt: Date.now() + SAZU_CACHE_TTL_MS });

  try {
    const result = await value;
    pruneSazuCache();
    return result;
  } catch (error) {
    sazuCache.delete(key);
    throw error;
  }
}

function pruneSazuCache() {
  const now = Date.now();
  for (const [key, cached] of sazuCache) {
    if (cached.expiresAt <= now) sazuCache.delete(key);
  }
  while (sazuCache.size > SAZU_CACHE_MAX_ENTRIES) {
    sazuCache.delete(sazuCache.keys().next().value);
  }
}

function validateInput(input) {
  const required = ["motherDate", "motherTime", "fatherDate", "fatherTime", "dueDate", "babyGender", "birthCity"];
  for (const field of required) {
    if (!input[field]) throw badRequest("모든 입력 항목을 입력해주세요.");
  }

  if (!["male", "female"].includes(input.babyGender)) {
    throw badRequest("아이 성별을 확인해주세요.");
  }

  for (const field of ["motherDate", "fatherDate", "dueDate"]) parseDate(input[field]);
  for (const field of ["motherTime", "fatherTime"]) {
    if (!/^\d{2}:\d{2}$/.test(input[field])) throw badRequest("출생 시간을 확인해주세요.");
  }
}

function pickSpreadCandidates(candidates, limit) {
  const sorted = [...candidates].sort((a, b) =>
    b.approximateScore - a.approximateScore || a.date.localeCompare(b.date) || a.hour - b.hour
  );
  const picked = [];

  for (const candidate of sorted) {
    if (picked.every((item) => item.date !== candidate.date)) picked.push(candidate);
    if (picked.length === limit) break;
  }

  return picked;
}

function normalizePillars(result) {
  const source = result.modules?.fourPillars || result.fourPillars || result.four_pillars || {};
  return {
    time: normalizePillar(source.hour || source.time),
    day: normalizePillar(source.day),
    month: normalizePillar(source.month),
    year: normalizePillar(source.year),
  };
}

function normalizePillar(pillar = {}) {
  const hangul = pillar.hangul || pillar.korean || pillar.ganji || pillar.full || "";
  const stem = pillar.stem?.hangul || pillar.stemHangul || pillar.stem || pillar.sky || hangul[0];
  const branch = pillar.branch?.hangul || pillar.branchHangul || pillar.branch || pillar.earth || hangul[1];
  if (!stemElement[stem] || !branchElement[branch]) {
    throw new Error("만세력 API 응답 형식을 해석하지 못했습니다.");
  }
  return [stem, branch];
}

function getApiElementCount(result) {
  const pillars = normalizePillars(result);
  return countElements(pillars);
}

function scoreHarmony(child, parent) {
  const distance = Object.keys(child).reduce((sum, key) => sum + Math.abs(child[key] - parent[key]), 0);
  return Math.max(60, 100 - distance * 5);
}

function totalScore(candidate) {
  return candidate.balance * 0.6 + candidate.motherHarmony * 0.2 + candidate.fatherHarmony * 0.2;
}

function makeApproximateSaju(date, hour) {
  return {
    time: getTimePillar(date, hour),
    day: getDayPillar(date),
    month: getMonthPillar(date),
    year: getYearPillar(date.getFullYear()),
  };
}

function getYearPillar(year) {
  return [stems[(year - 4) % 10], branches[(year - 4) % 12]];
}

function getMonthPillar(date) {
  const month = date.getMonth() + 1;
  const branchIndex = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, 11: 11, 12: 0 };
  const yearStemIndex = (date.getFullYear() - 4) % 10;
  return [stems[(yearStemIndex * 2 + month + 1) % 10], branches[branchIndex[month]]];
}

function getDayPillar(date) {
  const diff = Math.floor((date - new Date(1900, 0, 31)) / 86400000);
  return [stems[((diff % 10) + 10) % 10], branches[(((diff + 4) % 12) + 12) % 12]];
}

function getTimePillar(date, hour) {
  const dayStemIndex = stems.indexOf(getDayPillar(date)[0]);
  const branchIndex = getTimeBranch(hour);
  const firstStem = { 0: 0, 5: 0, 1: 2, 6: 2, 2: 4, 7: 4, 3: 6, 8: 6, 4: 8, 9: 8 }[dayStemIndex];
  return [stems[(firstStem + branchIndex) % 10], branches[branchIndex]];
}

function getTimeBranch(hour) {
  if (hour >= 23 || hour < 1) return 0;
  return Math.floor((hour + 1) / 2);
}

function countElements(saju) {
  const count = { wood: 0, fire: 0, earth: 0, metal: 0, water: 0 };
  Object.values(saju).forEach(([stem, branch]) => {
    count[stemElement[stem]]++;
    count[branchElement[branch]]++;
  });
  return count;
}

function scoreBalance(count) {
  const values = Object.values(count);
  return Math.max(60, 100 - (Math.max(...values) - Math.min(...values)) * 12);
}

function formatTimeRange(hour) {
  return `${formatHour(hour)} ~ ${formatHour((hour + 2) % 24)}`;
}

function formatHour(hour) {
  if (hour === 0) return "오전 12시";
  if (hour < 12) return `오전 ${hour}시`;
  if (hour === 12) return "오후 12시";
  return `오후 ${hour - 12}시`;
}

function toTimeString(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
}

function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw badRequest("날짜 형식을 확인해주세요.");
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw badRequest("유효하지 않은 날짜입니다.");
  }
  return date;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function toDateString(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

async function serveStatic(url, res) {
  const allowed = new Set(["/index.html", "/style.css", "/main.js"]);
  const path = allowed.has(url) ? url : "/index.html";
  const content = await readFile(join(ROOT, path));
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
  res.writeHead(200, { "Content-Type": types[extname(path)] });
  res.end(content);
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 20_000) throw badRequest("요청 데이터가 너무 큽니다.");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw badRequest("요청 형식을 확인해주세요.");
  }
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

async function loadEnv(path) {
  try {
    const source = await readFile(path, "utf8");
    for (const line of source.split(/\r?\n/)) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match && !(match[1] in process.env)) process.env[match[1]] = match[2].trim();
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
