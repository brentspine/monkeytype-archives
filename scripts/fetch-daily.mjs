#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const BASE_URL = "https://api.monkeytype.com/leaderboards/daily";

const CONFIG = Object.freeze({
  pageSize: 200,
  pages: [0, 1, 2, 3, 4],
  mode: "time",
  mode2Values: ["15", "60"],
  languages: [
    "english",
    "spanish",
    "german",
    "portuguese",
    "indonesian",
    "italian",
    "french",
  ],
  daysBefore: 1,
  requestTimeoutMs: 20_000,
  delayBetweenRequestsMs: 350,
  maxAttempts: 4,
  initialBackoffMs: 1_000,
  maxBackoffMs: 15_000,
  jitterMs: 500,
});

const EXPECTED_FILES = CONFIG.languages.length * CONFIG.mode2Values.length;
const EXPECTED_REQUESTS = EXPECTED_FILES * CONFIG.pages.length;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function yesterdayUtcDateString(daysBefore) {
  const now = new Date();
  const todayUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const targetUtcMs = todayUtcMs - daysBefore * 24 * 60 * 60 * 1000;

  return new Date(targetUtcMs).toISOString().slice(0, 10);
}

function buildUrl({ language, mode2, page }) {
  const params = new URLSearchParams({
    pageSize: String(CONFIG.pageSize),
    page: String(page),
    mode: CONFIG.mode,
    language,
    daysBefore: String(CONFIG.daysBefore),
  });

  params.set("mode2", JSON.stringify(mode2));

  return `${BASE_URL}?${params.toString()}`;
}

function sourceUrlTemplate() {
  return `${BASE_URL}?pageSize={pageSize}&page={page}&mode={mode}&mode2={jsonStringMode2}&language={language}&daysBefore={daysBefore}`;
}

function backoffDelayMs(attempt) {
  const exponentialMs = CONFIG.initialBackoffMs * 2 ** (attempt - 1);
  const cappedMs = Math.min(exponentialMs, CONFIG.maxBackoffMs);
  const jitterMs = Math.floor(Math.random() * CONFIG.jitterMs);

  return cappedMs + jitterMs;
}

function errorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function validateLeaderboardResponse(json, request) {
  if (json === null || typeof json !== "object") {
    throw new Error(`Invalid JSON shape for ${request.label}: response is not an object`);
  }

  if (json.data === null || typeof json.data !== "object") {
    throw new Error(`Invalid JSON shape for ${request.label}: missing data object`);
  }

  if (!Array.isArray(json.data.entries)) {
    throw new Error(`Invalid JSON shape for ${request.label}: data.entries is not an array`);
  }

  return json;
}

async function fetchJsonOnce(request) {
  const response = await fetch(request.url, {
    signal: AbortSignal.timeout(CONFIG.requestTimeoutMs),
    headers: {
      Accept: "application/json",
      "User-Agent": "monkeytype-daily-leaderboard-archive/1.0",
    },
  });

  const text = await response.text();

  if (!response.ok) {
    const preview = text.slice(0, 300).replaceAll("\n", " ");
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${preview}`);
  }

  const json = JSON.parse(text);

  return validateLeaderboardResponse(json, request);
}

async function fetchJsonWithRetry(request) {
  let lastError = new Error(`No attempts made for ${request.label}`);

  for (let attempt = 1; attempt <= CONFIG.maxAttempts; attempt += 1) {
    try {
      return await fetchJsonOnce(request);
    } catch (error) {
      lastError = error;
      console.warn(`[retry] ${request.label} attempt ${attempt}/${CONFIG.maxAttempts} failed: ${errorMessage(error)}`);
    }

    const finalAttempt = attempt === CONFIG.maxAttempts;

    if (finalAttempt) {
      break;
    }

    const waitMs = backoffDelayMs(attempt);
    console.log(`[retry] waiting ${waitMs}ms before retrying ${request.label}`);
    await sleep(waitMs);
  }

  throw lastError;
}

async function atomicWriteJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });

  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const json = `${JSON.stringify(value, null, 2)}\n`;

  try {
    await writeFile(tempPath, json, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

function pageSummary(pageResult) {
  return {
    page: pageResult.page,
    url: pageResult.url,
    message: pageResult.json.message ?? null,
    reportedCount: pageResult.json.data.count ?? null,
    reportedMinWpm: pageResult.json.data.minWpm ?? null,
    reportedPageSize: pageResult.json.data.pageSize ?? null,
    entriesFetched: pageResult.json.data.entries.length,
  };
}

function buildCombinedOutput({ generatedAt, leaderboardDate, language, mode2, pageResults }) {
  const entries = pageResults.flatMap((pageResult) => pageResult.json.data.entries);

  return {
    generatedAt,
    leaderboardDate,
    source: {
      baseUrl: BASE_URL,
      sourceUrlTemplate: sourceUrlTemplate(),
      daysBefore: CONFIG.daysBefore,
      pageSize: CONFIG.pageSize,
      mode: CONFIG.mode,
      mode2,
      language,
      pages: CONFIG.pages,
    },
    data: {
      entries,
      combinedEntryCount: entries.length,
    },
    pageSummaries: pageResults.map(pageSummary),
  };
}

function buildManifest({ generatedAt, leaderboardDate, successfulRequests, writtenFiles, failures }) {
  return {
    generatedAt,
    leaderboardDate,
    sourceUrl: sourceUrlTemplate(),
    sourceUrlExample: buildUrl({
      language: CONFIG.languages[0],
      mode2: CONFIG.mode2Values[0],
      page: CONFIG.pages[0],
    }),
    daysBefore: CONFIG.daysBefore,
    expectedNumberOfFiles: EXPECTED_FILES,
    expectedNumberOfRequests: EXPECTED_REQUESTS,
    configuration: {
      pageSize: CONFIG.pageSize,
      pages: CONFIG.pages,
      mode: CONFIG.mode,
      mode2Values: CONFIG.mode2Values,
      languages: CONFIG.languages,
    },
    successes: {
      requests: successfulRequests,
      files: writtenFiles.length,
      filesWritten: writtenFiles,
    },
    failures,
  };
}

async function collectPair({ generatedAt, leaderboardDate, language, mode2, requestCounter }) {
  const pageResults = [];
  const failures = [];
  let successfulRequests = 0;
  let currentRequestCounter = requestCounter;

  for (const page of CONFIG.pages) {
    currentRequestCounter += 1;

    const url = buildUrl({ language, mode2, page });
    const label = `${language}-${mode2} page ${page}`;
    const request = { language, mode2, page, url, label };

    console.log(`[fetch] ${currentRequestCounter}/${EXPECTED_REQUESTS} ${label}`);

    try {
      const json = await fetchJsonWithRetry(request);
      pageResults.push({ page, url, json });
      successfulRequests += 1;
      console.log(`[ok] ${label}: ${json.data.entries.length} entries`);
    } catch (error) {
      const failure = { language, mode2, page, url, error: errorMessage(error) };
      failures.push(failure);
      console.error(`[failed] ${label}: ${failure.error}`);
    }

    await sleep(CONFIG.delayBetweenRequestsMs);
  }

  const result = {
    currentRequestCounter,
    successfulRequests,
    failures,
    writtenFile: null,
  };

  if (failures.length > 0) {
    console.warn(`[skip] not writing ${language}-${mode2}.json because at least one page failed`);
    return result;
  }

  const output = buildCombinedOutput({ generatedAt, leaderboardDate, language, mode2, pageResults });
  const relativePath = join("data", leaderboardDate, `${language}-${mode2}.json`);

  await atomicWriteJson(relativePath, output);

  result.writtenFile = relativePath.replaceAll("\\", "/");
  console.log(`[write] ${result.writtenFile}: ${output.data.combinedEntryCount} combined entries`);

  return result;
}

async function main() {
  const generatedAt = new Date().toISOString();
  const leaderboardDate = yesterdayUtcDateString(CONFIG.daysBefore);
  const failures = [];
  const writtenFiles = [];
  let successfulRequests = 0;
  let requestCounter = 0;

  console.log(`[start] Monkeytype daily leaderboard fetch`);
  console.log(`[date] leaderboardDate=${leaderboardDate} generatedAt=${generatedAt}`);
  console.log(`[plan] ${EXPECTED_REQUESTS} requests, ${EXPECTED_FILES} combined files`);

  for (const language of CONFIG.languages) {
    for (const mode2 of CONFIG.mode2Values) {
      const result = await collectPair({ generatedAt, leaderboardDate, language, mode2, requestCounter });

      requestCounter = result.currentRequestCounter;
      successfulRequests += result.successfulRequests;
      failures.push(...result.failures);

      if (result.writtenFile !== null) {
        writtenFiles.push(result.writtenFile);
      }
    }
  }

  const manifest = buildManifest({
    generatedAt,
    leaderboardDate,
    successfulRequests,
    writtenFiles,
    failures,
  });

  const manifestPath = join("data", leaderboardDate, "manifest.json");

  await atomicWriteJson(manifestPath, manifest);
  console.log(`[write] ${manifestPath.replaceAll("\\", "/")}`);
  console.log(`[done] ${successfulRequests}/${EXPECTED_REQUESTS} requests succeeded; ${writtenFiles.length}/${EXPECTED_FILES} files written`);

  if (failures.length > 0) {
    console.error(`[fail] ${failures.length} request(s) failed. See manifest.json for details.`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[fatal] ${errorMessage(error)}`);
  process.exitCode = 1;
});
