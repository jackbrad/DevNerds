/**
 * Deploy-Verify — Confirm pushed code landed on each repo's remote main.
 *
 * Multi-repo: iterate every repo in build_order (or worktree_paths) and
 * check that the build SHA from auto-commit (per repo) is reachable on
 * origin/main. Aggregate. Best-effort — never blocks pipeline.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export default async function deployVerify(task, artifacts, projectConfig) {
  const buildOrder = artifacts?.build_order || Object.keys(artifacts?.worktree_paths || {});
  if (buildOrder.length === 0) {
    return { verdict: 'PASSED', summary: 'Nothing to verify — no build_order' };
  }

  const batchMode = projectConfig.deploy?.batch_push;
  const verifyRef = batchMode ? 'main' : 'origin/main';

  // Read per-repo commit hashes from auto-commit output
  let commitHashes = {};
  try {
    const artifactsDir = path.join(projectConfig.artifactsPath || './artifacts', task.id);
    const commitOutput = JSON.parse(fs.readFileSync(path.join(artifactsDir, 'auto-commit_output.json'), 'utf-8'));
    // Could be an aggregate (per_repo) or single-repo result
    if (commitOutput.commit_hashes) {
      commitHashes = commitOutput.commit_hashes;
    } else if (commitOutput.per_repo) {
      for (const entry of commitOutput.per_repo) {
        // auto-commit returns commit_hashes (map) not commit_hash (scalar)
        const hash = entry.result?.commit_hashes?.[entry.repo] || entry.result?.commit_hash;
        if (hash) commitHashes[entry.repo] = hash;
      }
    }
  } catch { /* missing — fall through */ }

  const results = [];
  let failed = 0;

  for (const repo of buildOrder) {
    const proj = projectConfig.projects?.[repo];
    if (!proj) { results.push({ repo, ok: false, error: 'unknown repo' }); failed++; continue; }
    const cwd = proj.repo_path;

    if (!batchMode) {
      try { execSync('git fetch origin main', { cwd, timeout: 30_000, encoding: 'utf-8' }); } catch {}
    }

    let targetHead;
    try {
      targetHead = execSync(`git rev-parse ${verifyRef}`, { cwd, encoding: 'utf-8' }).trim();
    } catch (err) {
      results.push({ repo, ok: false, error: `rev-parse failed: ${err.message}` });
      failed++; continue;
    }

    const sha = commitHashes[repo];
    if (sha && targetHead.startsWith(sha.slice(0, 7))) {
      results.push({ repo, ok: true, summary: `${sha.slice(0,7)} on ${verifyRef}` });
      continue;
    }
    if (sha) {
      try {
        execSync(`git merge-base --is-ancestor ${sha} ${verifyRef}`, { cwd, timeout: 10_000 });
        results.push({ repo, ok: true, summary: `${sha.slice(0,7)} in ${verifyRef} history` });
        continue;
      } catch {}
    }

    if (!sha) {
      results.push({ repo, ok: false, error: 'no recorded SHA from auto-commit — auto-commit did not run or its artifact is missing' });
      failed++;
      continue;
    }

    results.push({ repo, ok: false, error: `${sha.slice(0,7)} not on ${verifyRef} (HEAD: ${targetHead.slice(0,7)})` });
    failed++;
  }

  return {
    verdict: failed === 0 ? 'PASSED' : 'FAILED',
    summary: failed === 0
      ? `Verified ${results.length} repo push(es)`
      : `${failed}/${results.length} repo verifications failed`,
    results,
  };
}
