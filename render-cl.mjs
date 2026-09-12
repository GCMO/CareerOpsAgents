#!/usr/bin/env node
/**
 * render-cl.mjs — Cover letter JSON → HTML → PDF (P2 Packager)
 *
 * Usage:
 *   node render-cl.mjs <content.json> <output.pdf> [--format=a4|letter] [--html-out=path]
 *
 * content.json schema:
 * {
 *   "candidate_name", "email", "phone", "portfolio",
 *   "company", "role", "object", "date", "att",
 *   "opening", "fit_heading", "fit_body_html",
 *   "bring_heading", "bring_bullets": ["..."],
 *   "closing",
 *   "gate": {
 *     "jd_requirements": ["..."],   // phrases that must appear (case-insensitive)
 *     "product": ["..."],
 *     "stack": ["..."],
 *     "location_policy": ["..."]
 *   }
 * }
 *
 * Exit 2 if quality gate fails.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(ROOT, 'templates/cl-template.html');

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function paragraphsToHtml(text) {
  const t = String(text ?? '').trim();
  if (!t) return '<p></p>';
  // Allow simple HTML paragraphs if already provided
  if (/<[a-z][\s\S]*>/i.test(t)) return t;
  return t
    .split(/\n\s*\n/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

function runGate(fullText, gate) {
  if (!gate || typeof gate !== 'object') {
    return { ok: false, errors: ['gate object required (jd_requirements, product, stack, location_policy)'] };
  }
  const text = fullText.toLowerCase();
  const errors = [];
  const requiredKeys = ['jd_requirements', 'product', 'stack', 'location_policy'];

  for (const key of requiredKeys) {
    const phrases = gate[key];
    if (!Array.isArray(phrases) || phrases.length === 0) {
      errors.push(`gate.${key} must be a non-empty array of phrases that appear in the letter`);
      continue;
    }
    const missing = phrases.filter((p) => !text.includes(String(p).toLowerCase()));
    if (missing.length === phrases.length) {
      errors.push(`gate.${key}: none of [${phrases.join(' | ')}] found in letter body`);
    }
  }

  // Company name must appear (anti rename-only)
  return { ok: errors.length === 0, errors };
}

function fillTemplate(tpl, data) {
  const bullets = (data.bring_bullets || [])
    .map((b) => `<li>${escapeHtml(b)}</li>`)
    .join('\n');
  const portfolio = data.portfolio ? ` · ${data.portfolio}` : '';

  const map = {
    CANDIDATE_NAME: escapeHtml(data.candidate_name || ''),
    COMPANY: escapeHtml(data.company || ''),
    ROLE: escapeHtml(data.role || ''),
    OBJECT: escapeHtml(data.object || data.role || ''),
    DATE: escapeHtml(data.date || ''),
    ATT: escapeHtml(data.att || ''),
    OPENING: escapeHtml(data.opening || ''),
    FIT_HEADING: escapeHtml(data.fit_heading || 'Am I a good fit?'),
    FIT_BODY: paragraphsToHtml(data.fit_body_html || data.fit_body || ''),
    BRING_HEADING: escapeHtml(data.bring_heading || 'What will I bring?'),
    BRING_BULLETS: bullets,
    CLOSING: escapeHtml(data.closing || ''),
    EMAIL: escapeHtml(data.email || ''),
    PHONE: escapeHtml(data.phone || ''),
    PORTFOLIO_LINE: escapeHtml(portfolio),
  };

  let html = tpl;
  for (const [k, v] of Object.entries(map)) {
    html = html.split(`{{${k}}}`).join(v);
  }
  return html;
}

function main() {
  const args = process.argv.slice(2);
  const jsonPath = args.find((a) => !a.startsWith('--'));
  const pdfPath = args.filter((a) => !a.startsWith('--'))[1];
  const formatArg = args.find((a) => a.startsWith('--format='));
  const format = formatArg ? formatArg.split('=')[1] : 'a4';
  const htmlOutArg = args.find((a) => a.startsWith('--html-out='));
  const skipGate = args.includes('--skip-gate');

  if (!jsonPath || !pdfPath) {
    console.error('Usage: node render-cl.mjs <content.json> <output.pdf> [--format=a4|letter] [--html-out=path]');
    process.exit(1);
  }

  if (!existsSync(TEMPLATE)) {
    console.error(`Missing template: ${TEMPLATE}`);
    process.exit(1);
  }

  const data = JSON.parse(readFileSync(resolve(jsonPath), 'utf8'));
  const tpl = readFileSync(TEMPLATE, 'utf8');
  const html = fillTemplate(tpl, data);

  const gateText = [
    data.company,
    data.role,
    data.opening,
    data.fit_body_html || data.fit_body,
    ...(data.bring_bullets || []),
    data.closing,
  ]
    .filter(Boolean)
    .join('\n');

  if (!skipGate) {
    const gate = runGate(gateText, data.gate);
    if (!gate.ok) {
      console.error(JSON.stringify({ ok: false, errors: gate.errors }, null, 2));
      process.exit(2);
    }
    if (!String(gateText).toLowerCase().includes(String(data.company || '').toLowerCase())) {
      console.error(JSON.stringify({ ok: false, errors: ['company name must appear in letter body'] }, null, 2));
      process.exit(2);
    }
  }

  mkdirSync(dirname(resolve(pdfPath)), { recursive: true });
  const htmlPath = htmlOutArg
    ? resolve(htmlOutArg.split('=')[1])
    : resolve(pdfPath.replace(/\.pdf$/i, '.html'));
  writeFileSync(htmlPath, html, 'utf8');

  const gen = spawnSync(
    process.execPath,
    [join(ROOT, 'generate-pdf.mjs'), htmlPath, resolve(pdfPath), `--format=${format}`],
    { cwd: ROOT, encoding: 'utf8' }
  );

  if (gen.status !== 0) {
    console.error(gen.stdout || '');
    console.error(gen.stderr || '');
    process.exit(gen.status || 1);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        html: htmlPath,
        pdf: resolve(pdfPath),
        company: data.company,
        role: data.role,
      },
      null,
      2
    )
  );
}

main();
