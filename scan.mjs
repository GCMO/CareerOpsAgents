#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner
 *
 * Fetches public job-board APIs / JSON feeds directly, applies title
 * filters from portals.yml, deduplicates against existing history,
 * and appends new offers to pipeline.md + scan-history.tsv.
 *
 * Supported providers (zero Claude API tokens — pure HTTP + JSON):
 *   Greenhouse, Ashby, Lever, Teamtailor (jobs.json), Workable widget,
 *   RemoteOK, The Hub, Arbetsförmedlingen JobTech,
 *   Remotive, Jobicy, Himalayas, Arbeitnow, Landing.jobs, Remote1stJobs
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { pathToFileURL } from 'url';
import yaml from 'js-yaml';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });

const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 15_000;
const HUB_PAGE_SIZE = 100;
const HUB_MAX_PAGES = 15;
const JOBTECH_PAGE_SIZE = 100;
const JOBTECH_MAX_PAGES = 10;
const ARBEITNOW_MAX_PAGES = 5; // Cloudflare challenges aggressive pagination
const HIMALAYAS_MAX_PAGES = 2;
const HIMALAYAS_PAGE_SIZE = 20;

// ── Helpers ─────────────────────────────────────────────────────────

function decodeEntities(str = '') {
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function jobsJsonFromCareersUrl(careersUrl) {
  const base = careersUrl.replace(/\/+$/, '');
  if (base.endsWith('.json')) return base;
  if (/\/jobs$/i.test(base)) return `${base}.json`;
  return `${base}/jobs.json`;
}

function inferProviderFromApiUrl(apiUrl = '') {
  if (apiUrl.includes('greenhouse')) return 'greenhouse';
  if (apiUrl.includes('ashbyhq.com')) return 'ashby';
  if (apiUrl.includes('api.lever.co') || apiUrl.includes('jobs.lever.co')) return 'lever';
  if (apiUrl.includes('jobs.json') || apiUrl.includes('teamtailor.com')) return 'teamtailor';
  if (apiUrl.includes('apply.workable.com')) return 'workable';
  if (apiUrl.includes('remoteok.com')) return 'remoteok';
  if (apiUrl.includes('thehub.io')) return 'thehub';
  if (apiUrl.includes('jobtechdev.se') || apiUrl.includes('arbetsformedlingen')) return 'jobtech';
  if (apiUrl.includes('remotive.com')) return 'remotive';
  if (apiUrl.includes('jobicy.com')) return 'jobicy';
  if (apiUrl.includes('himalayas.app')) return 'himalayas';
  if (apiUrl.includes('arbeitnow.com')) return 'arbeitnow';
  if (apiUrl.includes('landing.jobs')) return 'landingjobs';
  if (apiUrl.includes('remote1stjobs.com')) return 'remote1st';
  return null;
}

function slugToName(slug = '') {
  return decodeEntities(slug)
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

/** Drop only when the posting clearly requires US work authorization / US-only eligibility.
 *  Worldwide / open remote without a US-permit ask is allowed. */
function requiresUsWorkAuth(location = '') {
  const loc = String(location).toLowerCase();
  if (!loc) return false;
  return /us citizen|u\.s\. citizen|green card|h-?1b|opt\b|ead\b|uscis|must be (based )?in (the )?(us|usa|united states)|only (open to |for )?(us|usa|united states) (based |residents?|candidates?|citizens?)|us work (auth|authorization|permit|visa)|right to work in the (us|usa|united states)|eligible to work in the (us|usa|united states)|require[sd]?.*(us|usa).*work (auth|permit|visa)|us[- ]only|usa[- ]only|united states only|must have us work/.test(loc);
}

// ── API detection ───────────────────────────────────────────────────

function detectApi(company) {
  // Explicit provider + api URL from portals.yml
  if (company.api_provider && company.api) {
    return {
      type: company.api_provider,
      url: company.api,
      queries: company.api_queries || [],
      company,
    };
  }

  // Explicit api URL — infer provider
  if (company.api) {
    const type = company.api_provider || inferProviderFromApiUrl(company.api);
    if (type) {
      return { type, url: company.api, queries: company.api_queries || [], company };
    }
  }

  const url = company.careers_url || '';

  // Ashby
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
      company,
    };
  }

  // Lever
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return {
      type: 'lever',
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`,
      company,
    };
  }

  // Greenhouse hosted boards
  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
      company,
    };
  }

  // Workable
  const workableMatch = url.match(/apply\.workable\.com\/([^/?#]+)/);
  if (workableMatch) {
    return {
      type: 'workable',
      url: `https://apply.workable.com/api/v1/widget/accounts/${workableMatch[1]}`,
      company,
    };
  }

  // Teamtailor hosted boards only (custom domains need api: / api_provider: in portals.yml —
  // many careers.* hosts are not Teamtailor and return HTML on /jobs.json)
  if (/teamtailor\.com/i.test(url)) {
    return {
      type: 'teamtailor',
      url: jobsJsonFromCareersUrl(url),
      company,
    };
  }

  // RemoteOK
  if (/remoteok\.com/i.test(url)) {
    return { type: 'remoteok', url: 'https://remoteok.com/api', company };
  }

  // The Hub
  if (/thehub\.io/i.test(url)) {
    return {
      type: 'thehub',
      url: 'https://www.thehub.io/api/jobs',
      queries: company.api_queries || [],
      company,
    };
  }

  // Arbetsförmedlingen / JobTech
  if (/arbetsformedlingen\.se|platsbanken|jobtechdev\.se/i.test(url)) {
    const qMatch = url.match(/[?&]q=([^&]+)/);
    const defaultQ = qMatch ? decodeURIComponent(qMatch[1]) : 'systemutvecklare';
    return {
      type: 'jobtech',
      url: 'https://jobsearch.api.jobtechdev.se/search',
      queries: company.api_queries?.length ? company.api_queries : [defaultQ],
      company,
    };
  }

  // Remotive
  if (/remotive\.com/i.test(url)) {
    return {
      type: 'remotive',
      url: 'https://remotive.com/api/remote-jobs',
      queries: company.api_queries || ['software-dev'],
      company,
    };
  }

  // Jobicy
  if (/jobicy\.com/i.test(url)) {
    return {
      type: 'jobicy',
      url: 'https://jobicy.com/api/v2/remote-jobs',
      queries: company.api_queries || [],
      company,
    };
  }

  // Himalayas
  if (/himalayas\.app/i.test(url)) {
    return {
      type: 'himalayas',
      url: 'https://himalayas.app/jobs/api/search',
      queries: company.api_queries || [],
      company,
    };
  }

  // Arbeitnow
  if (/arbeitnow\.com/i.test(url)) {
    return {
      type: 'arbeitnow',
      url: 'https://www.arbeitnow.com/api/job-board-api',
      company,
    };
  }

  // Landing.jobs
  if (/landing\.jobs/i.test(url)) {
    return {
      type: 'landingjobs',
      url: 'https://landing.jobs/api/v1/jobs',
      company,
    };
  }

  // Remote1stJobs
  if (/remote1stjobs\.com/i.test(url)) {
    return {
      type: 'remote1st',
      url: 'https://www.remote1stjobs.com/jobs.json',
      company,
    };
  }

  return null;
}

// ── API parsers ─────────────────────────────────────────────────────

function parseGreenhouse(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
  }));
}

function parseAshby(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.jobUrl || '',
    company: companyName,
    location: j.location || '',
  }));
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
  }));
}

function parseTeamtailor(json, companyName) {
  const items = json.items || [];
  return items.map(j => {
    const posting = j._jobposting || {};
    const loc = posting.jobLocation?.address?.addressLocality
      || posting.jobLocation?.address?.addressCountry
      || '';
    return {
      title: j.title || posting.title || '',
      url: j.url || '',
      company: companyName,
      location: loc,
    };
  });
}

function parseWorkable(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.url || j.shortlink || '',
    company: companyName,
    location: [j.city, j.state, j.country].filter(Boolean).join(', '),
  }));
}

function parseRemoteOK(json) {
  if (!Array.isArray(json)) return [];
  // First element is legal/metadata, not a job
  return json.slice(1).map(j => ({
    title: decodeEntities(j.position || ''),
    url: j.url || (j.slug ? `https://remoteok.com/remote-jobs/${j.slug}` : ''),
    company: decodeEntities(j.company || 'RemoteOK'),
    location: decodeEntities(j.location || 'Remote'),
  })).filter(j => j.title && j.url);
}

function parseTheHub(json) {
  const docs = json.docs || [];
  return docs.map(j => ({
    title: j.title || '',
    url: j.absoluteJobUrl || (j.id ? `https://thehub.io/jobs/${j.id}` : ''),
    company: j.company?.name || 'The Hub',
    location: j.location?.address
      || [j.location?.locality, j.location?.country].filter(Boolean).join(', ')
      || (j.isRemote ? 'Remote' : ''),
  })).filter(j => j.title && j.url);
}

function parseJobtech(json) {
  const hits = json.hits || [];
  return hits.map(j => ({
    title: j.headline || '',
    url: j.webpage_url || '',
    company: j.employer?.name || 'Arbetsförmedlingen',
    location: j.workplace_address?.municipality
      || j.workplace_address?.region
      || j.workplace_address?.country
      || '',
  })).filter(j => j.title && j.url);
}

function parseRemotive(json) {
  const jobs = json.jobs || [];
  return jobs
    .map(j => ({
      title: j.title || '',
      url: j.url || '',
      company: j.company_name || 'Remotive',
      location: j.candidate_required_location || 'Remote',
    }))
    .filter(j => j.title && j.url && !requiresUsWorkAuth(j.location));
}

function parseJobicy(json) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.jobTitle || '',
    url: j.url || '',
    company: j.companyName || 'Jobicy',
    location: Array.isArray(j.jobGeo) ? j.jobGeo.join(', ') : (j.jobGeo || 'Remote'),
  })).filter(j => j.title && j.url);
}

function summarizeLocations(restrictions = [], { prefer = ['Sweden', 'Germany', 'Netherlands', 'Portugal', 'Spain', 'France', 'Ireland', 'United Kingdom', 'Denmark', 'Norway', 'Finland', 'Europe'] } = {}) {
  if (!Array.isArray(restrictions) || restrictions.length === 0) return 'Remote';
  if (restrictions.length <= 3) return restrictions.join(', ');
  const hits = prefer.filter(p => restrictions.some(r => String(r).toLowerCase() === p.toLowerCase()));
  if (hits.length) return `${hits.join(', ')} (+${restrictions.length - hits.length} more)`;
  return `${restrictions.slice(0, 3).join(', ')} (+${restrictions.length - 3} more)`;
}

function parseHimalayas(json) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.guid || j.applicationLink || '',
    company: j.companyName || 'Himalayas',
    location: summarizeLocations(j.locationRestrictions),
  })).filter(j => j.title && j.url);
}

function parseArbeitnow(json) {
  const jobs = json.data || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.url || '',
    company: j.company_name || 'Arbeitnow',
    location: j.remote ? `Remote${j.location ? ` / ${j.location}` : ''}` : (j.location || ''),
  })).filter(j => j.title && j.url);
}

function parseLandingJobs(json) {
  const jobs = Array.isArray(json) ? json : [];
  return jobs.map(j => {
    const slugMatch = String(j.url || '').match(/landing\.jobs\/at\/([^/]+)/i);
    const locs = (j.locations || [])
      .map(l => [l.city, l.country_code].filter(Boolean).join(', '))
      .filter(Boolean);
    return {
      title: j.title || '',
      url: j.url || '',
      company: slugToName(slugMatch?.[1] || '') || 'Landing.jobs',
      location: j.remote ? `Remote${locs.length ? ` / ${locs.join('; ')}` : ''}` : (locs.join('; ') || ''),
    };
  }).filter(j => j.title && j.url);
}

function parseRemote1st(json) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: (j.url || '').split('?')[0],
    company: j.company || 'Remote1stJobs',
    location: j.location || 'Remote',
  })).filter(j => j.title && j.url);
}

const PARSERS = {
  greenhouse: parseGreenhouse,
  ashby: parseAshby,
  lever: parseLever,
  teamtailor: parseTeamtailor,
  workable: parseWorkable,
  remoteok: parseRemoteOK,
  thehub: parseTheHub,
  jobtech: parseJobtech,
  remotive: parseRemotive,
  jobicy: parseJobicy,
  himalayas: parseHimalayas,
  arbeitnow: parseArbeitnow,
  landingjobs: parseLandingJobs,
  remote1st: parseRemote1st,
};

// ── Fetch with timeout ──────────────────────────────────────────────

async function fetchJson(url, { headers } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'career-ops-scanner/1.0 (+https://github.com/santifer/career-ops)',
        accept: 'application/json, application/feed+json, */*',
        ...headers,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function dedupeJobs(jobs) {
  const seen = new Set();
  const out = [];
  for (const job of jobs) {
    const key = job.url || `${job.company}::${job.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(job);
  }
  return out;
}

async function fetchTheHubJobs(api) {
  const jobs = [];
  const queries = api.queries?.length
    ? api.queries.map(q => ({ search: q }))
    : [{ countryCode: 'SE' }, { isRemote: 'true' }];

  for (const params of queries) {
    for (let page = 1; page <= HUB_MAX_PAGES; page++) {
      const qs = new URLSearchParams({
        limit: String(HUB_PAGE_SIZE),
        page: String(page),
        ...params,
      });
      const json = await fetchJson(`${api.url}?${qs}`);
      jobs.push(...parseTheHub(json));
      const pages = json.pages || 1;
      if (page >= pages || !(json.docs || []).length) break;
    }
  }
  return dedupeJobs(jobs);
}

async function fetchJobtechJobs(api) {
  const jobs = [];
  const queries = api.queries?.length ? api.queries : ['systemutvecklare'];

  for (const q of queries) {
    for (let page = 0; page < JOBTECH_MAX_PAGES; page++) {
      const offset = page * JOBTECH_PAGE_SIZE;
      const qs = new URLSearchParams({
        q,
        limit: String(JOBTECH_PAGE_SIZE),
        offset: String(offset),
      });
      const json = await fetchJson(`${api.url}?${qs}`);
      const batch = parseJobtech(json);
      jobs.push(...batch);
      const total = json.total?.value ?? json.total ?? 0;
      if (!batch.length || offset + batch.length >= total) break;
    }
  }
  return dedupeJobs(jobs);
}

async function fetchRemotiveJobs(api) {
  const categories = api.queries?.length ? api.queries : ['software-dev'];
  const jobs = [];
  for (const category of categories) {
    const qs = new URLSearchParams({ category });
    const json = await fetchJson(`${api.url}?${qs}`);
    jobs.push(...parseRemotive(json));
  }
  return dedupeJobs(jobs);
}

async function fetchJobicyJobs(api) {
  const geos = api.company?.api_geos?.length
    ? api.company.api_geos
    : ['europe', 'emea', 'sweden'];
  const industries = api.company?.api_industries?.length
    ? api.company.api_industries
    : ['dev'];
  const tags = api.queries?.length ? api.queries : [''];
  const jobs = [];

  for (const geo of geos) {
    for (const industry of industries) {
      for (const tag of tags) {
        const qs = new URLSearchParams({ count: '100', geo, industry });
        if (tag) qs.set('tag', tag);
        const json = await fetchJson(`${api.url}?${qs}`);
        jobs.push(...parseJobicy(json));
      }
    }
  }
  return dedupeJobs(jobs);
}

async function fetchHimalayasJobs(api) {
  const queries = api.queries?.length ? api.queries : ['react', 'fullstack', 'frontend'];
  const countries = api.company?.api_countries?.length
    ? api.company.api_countries
    : ['sweden', 'europe'];
  const jobs = [];

  for (const q of queries) {
    for (const country of countries) {
      for (let page = 1; page <= HIMALAYAS_MAX_PAGES; page++) {
        const qs = new URLSearchParams({
          q,
          country,
          page: String(page),
          sort: 'recent',
        });
        let json;
        try {
          json = await fetchJson(`${api.url}?${qs}`);
        } catch {
          // Himalayas rate-limits / 503s on deeper pages — keep what we have
          break;
        }
        const batch = parseHimalayas(json);
        jobs.push(...batch);
        const total = json.totalCount || 0;
        if (!batch.length || batch.length < HIMALAYAS_PAGE_SIZE || page * HIMALAYAS_PAGE_SIZE >= total) {
          break;
        }
      }
    }
  }
  return dedupeJobs(jobs);
}

async function fetchArbeitnowJobs(api) {
  const jobs = [];
  for (let page = 1; page <= ARBEITNOW_MAX_PAGES; page++) {
    let json;
    try {
      json = await fetchJson(`${api.url}?page=${page}`);
    } catch {
      break; // Cloudflare challenge after aggressive pagination
    }
    const batch = parseArbeitnow(json);
    jobs.push(...batch);
    if (!json.links?.next || !batch.length) break;
  }
  return dedupeJobs(jobs);
}

async function fetchLandingJobs(api) {
  const jobs = [];
  // API caps around 50 per request; fetch general + remote slices
  for (const params of [{ limit: '50' }, { limit: '50', remote: 'true' }]) {
    const qs = new URLSearchParams(params);
    const json = await fetchJson(`${api.url}?${qs}`);
    jobs.push(...parseLandingJobs(json));
  }
  return dedupeJobs(jobs);
}

async function fetchJobs(api, companyName) {
  switch (api.type) {
    case 'thehub':
      return fetchTheHubJobs(api);
    case 'jobtech':
      return fetchJobtechJobs(api);
    case 'remotive':
      return fetchRemotiveJobs(api);
    case 'jobicy':
      return fetchJobicyJobs(api);
    case 'himalayas':
      return fetchHimalayasJobs(api);
    case 'arbeitnow':
      return fetchArbeitnowJobs(api);
    case 'landingjobs':
      return fetchLandingJobs(api);
    case 'remoteok': {
      const json = await fetchJson(api.url);
      return parseRemoteOK(json);
    }
    case 'remote1st': {
      const json = await fetchJson(api.url);
      return parseRemote1st(json);
    }
    default: {
      const json = await fetchJson(api.url);
      const parser = PARSERS[api.type];
      if (!parser) throw new Error(`No parser for type ${api.type}`);
      return parser(json, companyName);
    }
  }
}

// ── Title filter ────────────────────────────────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());

  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// ── Dedup ───────────────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();

  // scan-history.tsv
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }

  // pipeline.md — extract URLs from checkbox lines
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(match[1]);
    }
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

// ── Pipeline writer ─────────────────────────────────────────────────

function appendToPipeline(offers) {
  if (offers.length === 0) return;

  let text = readFileSync(PIPELINE_PATH, 'utf-8');

  // Find "## Pendientes" section and append after it
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    // No Pendientes section — append at end before Procesadas
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    // Find the end of existing Pendientes content (next ## or end)
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const block = '\n' + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  // Ensure file + header exist
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }

  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  // 1. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];
  const titleFilter = buildTitleFilter(config.title_filter);

  // 2. Filter to enabled companies with detectable APIs
  const targets = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany))
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  const skipped = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany))
    .filter(c => detectApi(c) === null);

  console.log(`Scanning ${targets.length} companies via API (${skipped.length} skipped — no API detected)`);
  if (skipped.length > 0 && skipped.length <= 40) {
    console.log(`  Skipped: ${skipped.map(c => c.name).join(', ')}`);
  }
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 3. Load dedup sets
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 4. Fetch all APIs
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDupes = 0;
  const newOffers = [];
  const errors = [];
  const bySource = {};

  const tasks = targets.map(company => async () => {
    const api = company._api;
    try {
      const jobs = await fetchJobs(api, company.name);
      totalFound += jobs.length;
      bySource[api.type] = (bySource[api.type] || 0) + jobs.length;

      for (const job of jobs) {
        if (!titleFilter(job.title)) {
          totalFiltered++;
          continue;
        }
        if (seenUrls.has(job.url)) {
          totalDupes++;
          continue;
        }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) {
          totalDupes++;
          continue;
        }
        // Mark as seen to avoid intra-scan dupes
        seenUrls.add(job.url);
        seenCompanyRoles.add(key);
        newOffers.push({ ...job, source: `${api.type}-api` });
      }
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  // 5. Write results
  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  // 6. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  if (Object.keys(bySource).length) {
    console.log(`  By source: ${Object.entries(bySource).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
}

export {
  detectApi,
  fetchJobs,
  buildTitleFilter,
  loadSeenUrls,
  loadSeenCompanyRoles,
};

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}