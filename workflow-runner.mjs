#!/usr/bin/env node
/**
 * workflow-runner.mjs — P1 Ranker queue for career-ops orchestration
 *
 * Commands:
 *   node workflow-runner.mjs sync-discovered [--dry-run]
 *   node workflow-runner.mjs queue [--limit N] [--dry-run]
 *   node workflow-runner.mjs status
 *   node workflow-runner.mjs mark --id ID --state STATE [--score X.X] [--report PATH] [--notes TEXT]
 *
 * Reads: data/pipeline.md, data/workflow.yml, config/profile.yml
 * Writes: data/workflow.yml, batch/ranker-queue.json, batch/batch-input.tsv (on queue)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PIPELINE_PATH = join(ROOT, 'data/pipeline.md');
const WORKFLOW_PATH = join(ROOT, 'data/workflow.yml');
const PROFILE_PATH = join(ROOT, 'config/profile.yml');
const QUEUE_JSON = join(ROOT, 'batch/ranker-queue.json');
const BATCH_INPUT = join(ROOT, 'batch/batch-input.tsv');

const args = process.argv.slice(2);
const cmd = args[0] || 'status';
const dryRun = args.includes('--dry-run');

function flagValue(name, fallback = null) {
  const i = args.indexOf(name);
  if (i === -1 || i === args.length - 1) return fallback;
  return args[i + 1];
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function loadProfile() {
  if (!existsSync(PROFILE_PATH)) return {};
  return yaml.load(readFileSync(PROFILE_PATH, 'utf8')) || {};
}

function loadWorkflow() {
  if (!existsSync(WORKFLOW_PATH)) {
    return {
      version: 1,
      updated: today(),
      defaults: {
        submit_policy: 'human_approve_only',
        auto_skip_below: 4.0,
        auto_package_at_or_above: 4.5,
      },
      jobs: [],
    };
  }
  const doc = yaml.load(readFileSync(WORKFLOW_PATH, 'utf8')) || {};
  if (!Array.isArray(doc.jobs)) doc.jobs = [];
  return doc;
}

function saveWorkflow(doc) {
  doc.updated = today();
  const body = yaml.dump(doc, {
    lineWidth: 120,
    noRefs: true,
    sortingKeys: false,
  });
  if (dryRun) {
    console.log('[dry-run] would write data/workflow.yml');
    console.log(body.slice(0, 500) + (body.length > 500 ? '\n…' : ''));
    return;
  }
  writeFileSync(WORKFLOW_PATH, body, 'utf8');
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function jobId(company, role, url) {
  const base = `${slugify(company) || 'co'}-${slugify(role) || 'role'}`;
  let hash = 0;
  for (let i = 0; i < url.length; i++) hash = (hash * 31 + url.charCodeAt(i)) >>> 0;
  return `${base}-${hash.toString(16).slice(0, 6)}`;
}

/** Hard title filters aligned with profile deal-breakers (pre-LLM). */
function hardSkipReason(role) {
  const t = String(role || '').toLowerCase();
  const hasModernJs =
    /react|next\.?js|typescript|javascript|\bnode\b|frontend|front-end|front end|fullstack|full-stack|full stack/.test(
      t
    );

  if (/\.net|c#|asp\.net|dynamics\s*365/.test(t) && !hasModernJs) {
    return '.NET-only / no modern JS-TS frontend path';
  }
  if (/\bjava\b/.test(t) && !/javascript|react|kotlin/.test(t) && !hasModernJs) {
    return 'Java-only / no modern JS-TS frontend path';
  }
  if (/\bbi\b|business intelligence|power\s*bi|qlik|tableau/.test(t) && !hasModernJs) {
    return 'BI-only — outside target archetypes';
  }
  if (/embedded|hil developer|c\+\+|firmware|plc\b/.test(t) && !hasModernJs) {
    return 'Embedded/systems-only — outside target archetypes';
  }
  return null;
}

function titlePriority(role) {
  const t = String(role || '').toLowerCase();
  let score = 0;
  if (/frontend|front-end|front end|react|next/.test(t)) score += 30;
  if (/fullstack|full-stack|full stack/.test(t)) score += 20;
  if (/typescript|node/.test(t)) score += 8;
  if (/senior|medior|lead/.test(t)) score += 4;
  if (/backend|back-end/.test(t) && !/fullstack|full-stack|frontend|front-end|react/.test(t)) score -= 10;
  if (/⚠️|\.net|c#|java\b|dynamics|bi utvecklar|bi developer/.test(t)) score -= 25;
  return score;
}

function regionRank(mode) {
  const m = String(mode || '').toLowerCase();
  if (m.includes('sweden') || m.includes('stockholm')) return 0;
  if (m.includes('remote')) return 1;
  return 2;
}

function extractLink(cell) {
  const md = cell.match(/\[([^\]]*)\]\(([^)]+)\)/);
  if (md) return md[2].trim();
  const bare = cell.match(/https?:\/\/\S+/);
  return bare ? bare[0].replace(/[)>.,;]+$/, '') : null;
}

/**
 * Parse latest Sweden + Remote shortlist tables under ## Pendientes.
 * Only the first (top) Sweden heading and first Remote heading — those are the newest scans.
 * Checkbox `- [ ]` lines are ignored unless includeCheckboxes=true (they flood historical URLs).
 */
function parseShortlistTables(md, { includeCheckboxes = false } = {}) {
  const jobs = [];
  const pendientesIdx = md.indexOf('## Pendientes');
  if (pendientesIdx === -1) return jobs;
  const section = md.slice(pendientesIdx);
  const nextH2 = section.search(/\n## (?!#)/);
  const pendientes = nextH2 === -1 ? section : section.slice(0, nextH2);

  const headingRe = /^###\s+(Sweden|Remote)\s+[—\-–].+$/gim;
  const headings = [...pendientes.matchAll(headingRe)];
  const seenRegion = new Set();

  for (let h = 0; h < headings.length; h++) {
    const region = headings[h][1];
    if (seenRegion.has(region)) continue; // only latest table per region
    seenRegion.add(region);

    const heading = headings[h][0];
    const start = headings[h].index + heading.length;
    const end = h + 1 < headings.length ? headings[h + 1].index : pendientes.length;
    const block = pendientes.slice(start, end);
    const rows = block.split('\n').filter((l) => /^\|/.test(l) && !/^\|\s*[-:| ]+\|/.test(l) && !/^\|\s*Found\s*\|/i.test(l));

    for (const row of rows) {
      const cols = row
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim());
      if (cols.length < 6) continue;
      const company = cols[2];
      const role = cols[3];
      const mode = cols[4] || region;
      const url = extractLink(cols[5] || cols.slice(5).join('|'));
      if (!url || !company) continue;
      jobs.push({
        company,
        role,
        mode: mode || region,
        url,
        source: 'shortlist',
        region,
      });
    }
  }

  if (includeCheckboxes) {
    for (const line of pendientes.split('\n')) {
      const m = line.match(/^- \[ \] (\S+)(?:\s*\|\s*([^|]+)\s*\|\s*(.+))?/);
      if (!m) continue;
      const url = m[1];
      if (!/^https?:\/\//.test(url) && !url.startsWith('local:')) continue;
      jobs.push({
        company: (m[2] || '').trim() || 'Unknown',
        role: (m[3] || '').trim() || 'Unknown role',
        mode: 'pending',
        url,
        source: 'checkbox',
        region: 'Other',
      });
    }
  }

  return jobs;
}

function upsertDiscovered(workflow, incoming, { pruneDiscovered = true } = {}) {
  const byUrl = new Map(workflow.jobs.map((j) => [j.url, j]));
  const incomingUrls = new Set(incoming.map((i) => i.url));
  let added = 0;
  let skippedHard = 0;
  let updated = 0;
  let pruned = 0;

  for (const item of incoming) {
    const skip = hardSkipReason(item.role);
    const existing = byUrl.get(item.url);

    if (existing) {
      if (['submitted', 'approved', 'form_ready', 'packaged', 'evaluated'].includes(existing.state)) {
        continue;
      }
      existing.company = item.company;
      existing.role = item.role;
      existing.mode = item.mode;
      existing.region = item.region;
      existing.source = item.source;
      existing.updated = today();
      if (skip) {
        existing.state = 'skipped';
        existing.notes = skip;
        skippedHard++;
      } else if (existing.state === 'skipped' && !existing.notes?.includes('auto-skip score')) {
        // re-open title-only skips if now on shortlist without hard skip
        existing.state = 'discovered';
        existing.notes = '';
      } else if (existing.state !== 'skipped') {
        existing.state = 'discovered';
      }
      updated++;
      continue;
    }

    const entry = {
      id: jobId(item.company, item.role, item.url),
      url: item.url,
      company: item.company,
      role: item.role,
      mode: item.mode,
      region: item.region,
      source: item.source,
      state: skip ? 'skipped' : 'discovered',
      score: null,
      report: null,
      artifacts: { cv_pdf: null, cl_pdf: null },
      notes: skip || '',
      updated: today(),
    };
    workflow.jobs.push(entry);
    byUrl.set(item.url, entry);
    if (skip) skippedHard++;
    else added++;
  }

  if (pruneDiscovered) {
    const kept = [];
    for (const j of workflow.jobs) {
      if (j.state === 'discovered' && !incomingUrls.has(j.url)) {
        pruned++;
        continue;
      }
      // Drop prior hard-skipped rows that are not on the latest shortlist either
      if (j.state === 'skipped' && !j.score && !incomingUrls.has(j.url) && !j.report) {
        pruned++;
        continue;
      }
      kept.push(j);
    }
    workflow.jobs = kept;
  }

  return { added, updated, skippedHard, pruned };
}

function cmdSync() {
  const includeCheckboxes = args.includes('--include-checkboxes');
  const noPrune = args.includes('--no-prune');
  const md = readFileSync(PIPELINE_PATH, 'utf8');
  const incoming = parseShortlistTables(md, { includeCheckboxes });
  const workflow = loadWorkflow();
  const stats = upsertDiscovered(workflow, incoming, { pruneDiscovered: !noPrune });
  saveWorkflow(workflow);
  console.log(
    JSON.stringify(
      {
        command: 'sync-discovered',
        dryRun,
        includeCheckboxes,
        parsed: incoming.length,
        ...stats,
        discovered_total: workflow.jobs.filter((j) => j.state === 'discovered').length,
        skipped_total: workflow.jobs.filter((j) => j.state === 'skipped').length,
        jobs_total: workflow.jobs.length,
      },
      null,
      2
    )
  );
}

function sortQueue(jobs) {
  return [...jobs].sort((a, b) => {
    const rr = regionRank(a.region || a.mode) - regionRank(b.region || b.mode);
    if (rr !== 0) return rr;
    const tp = titlePriority(b.role) - titlePriority(a.role);
    if (tp !== 0) return tp;
    return String(a.company).localeCompare(String(b.company));
  });
}

function nextReportNumSync() {
  const reportsDir = join(ROOT, 'reports');
  if (!existsSync(reportsDir)) return 1;
  let max = 0;
  for (const f of readdirSync(reportsDir)) {
    const m = f.match(/^(\d{3})-/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

function cmdQueue() {
  const profile = loadProfile();
  const limit =
    Number(flagValue('--limit', profile?.automation?.ranker?.top_k ?? 10)) || 10;
  const workflow = loadWorkflow();
  const discovered = sortQueue(workflow.jobs.filter((j) => j.state === 'discovered'));
  const selected = discovered.slice(0, limit);
  const startNum = nextReportNumSync();

  const queue = selected.map((j, i) => ({
    id: j.id,
    url: j.url,
    company: j.company,
    role: j.role,
    region: j.region || j.mode,
    report_num: String(startNum + i).padStart(3, '0'),
    priority: i + 1,
  }));

  const payload = {
    generated: new Date().toISOString(),
    limit,
    selected: queue.length,
    remaining_discovered: Math.max(0, discovered.length - queue.length),
    auto_skip_below: workflow.defaults?.auto_skip_below ?? 4.0,
    auto_package_at_or_above: workflow.defaults?.auto_package_at_or_above ?? 4.5,
    jobs: queue,
    instructions:
      'For each job: Playwright JD → A-G report → tracker TSV → merge-tracker. Then: node workflow-runner.mjs mark --id ID --state evaluated|skipped --score X.X --report PATH. Do not package/apply/submit. Stop after queue.',
  };

  mkdirSync(join(ROOT, 'batch'), { recursive: true });
  const tsvHeader = 'id\turl\tcompany\trole\treport_num\n';
  const tsvBody = queue.map((j) => `${j.id}\t${j.url}\t${j.company}\t${j.role}\t${j.report_num}`).join('\n');

  if (dryRun) {
    console.log(JSON.stringify({ command: 'queue', dryRun: true, ...payload }, null, 2));
    return;
  }

  writeFileSync(QUEUE_JSON, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  writeFileSync(BATCH_INPUT, tsvHeader + tsvBody + (tsvBody ? '\n' : ''), 'utf8');

  console.log(
    JSON.stringify(
      {
        command: 'queue',
        wrote: ['batch/ranker-queue.json', 'batch/batch-input.tsv'],
        selected: queue.length,
        remaining_discovered: payload.remaining_discovered,
        jobs: queue,
      },
      null,
      2
    )
  );
}

function cmdStatus() {
  const workflow = loadWorkflow();
  const counts = {};
  for (const j of workflow.jobs) {
    counts[j.state] = (counts[j.state] || 0) + 1;
  }
  const discovered = sortQueue(workflow.jobs.filter((j) => j.state === 'discovered')).slice(0, 5);
  console.log(
    JSON.stringify(
      {
        command: 'status',
        updated: workflow.updated,
        total: workflow.jobs.length,
        counts,
        next_up: discovered.map((j) => ({
          id: j.id,
          company: j.company,
          role: j.role,
          region: j.region || j.mode,
          url: j.url,
        })),
      },
      null,
      2
    )
  );
}

function cmdMark() {
  const id = flagValue('--id');
  const state = flagValue('--state');
  if (!id || !state) {
    console.error('Usage: node workflow-runner.mjs mark --id ID --state STATE [--score X.X] [--report PATH] [--notes TEXT]');
    process.exit(1);
  }
  const allowed = [
    'discovered',
    'evaluated',
    'skipped',
    'packaged',
    'form_ready',
    'approved',
    'submitted',
    'follow_up_due',
  ];
  if (!allowed.includes(state)) {
    console.error(`Invalid state. Allowed: ${allowed.join(', ')}`);
    process.exit(1);
  }

  const workflow = loadWorkflow();
  const job = workflow.jobs.find((j) => j.id === id);
  if (!job) {
    console.error(`No job with id=${id}`);
    process.exit(1);
  }

  job.state = state;
  job.updated = today();
  const score = flagValue('--score');
  if (score != null) job.score = Number(score);
  const report = flagValue('--report');
  if (report != null) job.report = report;
  const notes = flagValue('--notes');
  if (notes != null) job.notes = notes;

  const profile = loadProfile();
  const packageAt = profile?.automation?.score_gates?.auto_package_at_or_above ?? 4.5;
  const skipBelow = profile?.automation?.score_gates?.auto_skip_below ?? 4.0;

  let package_queued = false;
  if (state === 'evaluated' && job.score != null && job.score < skipBelow) {
    job.state = 'skipped';
    job.notes = (job.notes ? job.notes + '; ' : '') + `auto-skip score ${job.score} < ${skipBelow}`;
  }
  if (job.state === 'evaluated' && job.score != null && job.score >= packageAt) {
    package_queued = true;
    job.notes = (job.notes ? job.notes + '; ' : '') + 'eligible for package (≥ auto_package gate)';
  }

  saveWorkflow(workflow);
  console.log(
    JSON.stringify(
      {
        command: 'mark',
        dryRun,
        id: job.id,
        state: job.state,
        score: job.score,
        report: job.report,
        package_queued,
      },
      null,
      2
    )
  );
}

function usage() {
  console.log(`Usage:
  node workflow-runner.mjs sync-discovered [--dry-run] [--include-checkboxes] [--no-prune]
  node workflow-runner.mjs queue [--limit N] [--dry-run]
  node workflow-runner.mjs status
  node workflow-runner.mjs mark --id ID --state STATE [--score X.X] [--report PATH] [--notes TEXT]`);
}

async function main() {
  switch (cmd) {
    case 'sync-discovered':
    case 'sync':
      cmdSync();
      break;
    case 'queue':
      cmdQueue();
      break;
    case 'status':
      cmdStatus();
      break;
    case 'mark':
      cmdMark();
      break;
    case 'help':
    case '--help':
    case '-h':
      usage();
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      usage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
