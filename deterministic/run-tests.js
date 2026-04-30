/**
 * Run Tests — Per-repo (or per-worktree) test runner.
 *
 * Two modes:
 * - for_each_repo: blueprint engine passes currentRepo, we test only that repo.
 * - aggregate: no currentRepo, iterate all worktree_paths and aggregate.
 *
 * Compacts CI output before it reaches any agentic node.
 */

import { execSync } from 'child_process';

function runRepo(repoName, worktreePath, projectConfig) {
  const proj = projectConfig.projects?.[repoName];
  if (!proj) return { repo: repoName, ok: false, output: `unknown repo` };

  const cmds = proj.test_commands || {};
  const envType = proj.env_type;
  const repoResult = { repo: repoName, ok: true, sections: [] };

  // Detect what changed in this worktree to decide scope
  let changed = '';
  try { changed = execSync('git diff --name-only HEAD', { cwd: worktreePath, encoding: 'utf-8', timeout: 5_000 }); } catch {}
  let untracked = '';
  try { untracked = execSync('git ls-files --others --exclude-standard', { cwd: worktreePath, encoding: 'utf-8', timeout: 5_000 }); } catch {}
  const allFiles = [...changed.split('\n'), ...untracked.split('\n')].filter(Boolean);
  const hasFrontendChanges = allFiles.some(f => f.startsWith('src/') || f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.jsx'));
  const hasBackendChanges = allFiles.some(f => f.endsWith('.py') || f.startsWith('lambda_functions/') || f.startsWith('layers/'));

  // Frontend tests
  if (cmds.frontend && (envType === 'node' || envType === 'python+node') && hasFrontendChanges) {
    const cmd = `${cmds.frontend} 2>&1`;
    try {
      const output = execSync(cmd, { cwd: worktreePath, timeout: 120_000, encoding: 'utf-8' });
      repoResult.sections.push({ suite: 'frontend', passed: true, output: compactTestOutput(output) });
    } catch (err) {
      if (isRunnerCrash(err)) return { repo: repoName, ok: false, infra: true, output: `Frontend runner crash in ${repoName}: ${err.message}` };
      if (isNoTestsCollected(err)) {
        repoResult.sections.push({ suite: 'frontend', passed: true, skipped: true, output: 'No tests found (treated as pass)' });
      } else {
        repoResult.ok = false;
        repoResult.sections.push({ suite: 'frontend', passed: false, output: compactTestOutput(err.stdout || err.message) });
      }
    }
  }

  // Backend tests
  if (cmds.backend && (envType === 'python' || envType === 'python+node') && hasBackendChanges) {
    const cmd = `${cmds.backend} 2>&1`;
    try {
      const output = execSync(cmd, { cwd: worktreePath, timeout: 120_000, encoding: 'utf-8' });
      repoResult.sections.push({ suite: 'backend', passed: true, output: compactTestOutput(output) });
    } catch (err) {
      if (isRunnerCrash(err)) return { repo: repoName, ok: false, infra: true, output: `Backend runner crash in ${repoName}: ${err.message}` };
      if (isNoTestsCollected(err)) {
        repoResult.sections.push({ suite: 'backend', passed: true, skipped: true, output: 'No tests collected (treated as pass)' });
      } else {
        repoResult.ok = false;
        repoResult.sections.push({ suite: 'backend', passed: false, output: compactTestOutput(err.stdout || err.message) });
      }
    }
  }

  // No relevant changes — skip
  if (repoResult.sections.length === 0) {
    repoResult.skipped = true;
  }

  return repoResult;
}

export default function runTests(task, artifacts, projectConfig, currentRepo) {
  const worktreePaths = artifacts?.worktree_paths || {};
  const repos = currentRepo ? [currentRepo] : Object.keys(worktreePaths);

  if (repos.length === 0) {
    return { verdict: 'PASSED', summary: 'No repos to test' };
  }

  let testsRun = 0;
  let testsPassed = 0;
  const repoResults = [];
  const failureBlocks = [];

  for (const repo of repos) {
    const wt = worktreePaths[repo];
    if (!wt) {
      return { verdict: 'FAILED', error: `No worktree path for ${repo}` };
    }
    const r = runRepo(repo, wt, projectConfig);
    if (r.infra) {
      // Attach already-collected results so the failure report shows which
      // repos finished cleanly before the crash.
      return { verdict: 'FAILED', error: r.output, infra: true, repo_results: [...repoResults, r] };
    }
    repoResults.push(r);

    for (const section of r.sections || []) {
      const counts = extractTestCounts(section.output);
      testsRun += counts.total;
      testsPassed += counts.passed;
      if (!section.passed) {
        failureBlocks.push(`### ${repo} / ${section.suite}\n${section.output}`);
      }
    }
  }

  const allPassed = repoResults.every(r => r.ok);
  if (allPassed) {
    return {
      verdict: 'PASSED',
      tests_run: testsRun,
      tests_passed: testsPassed,
      summary: `${testsPassed}/${testsRun} tests passed across ${repos.length} repo(s)`,
      repo_results: repoResults,
    };
  }

  return {
    verdict: 'FAILED',
    tests_run: testsRun,
    tests_passed: testsPassed,
    summary: `${testsPassed}/${testsRun} tests passed; ${repoResults.filter(r => !r.ok).map(r => r.repo).join(', ')} failed`,
    compact_failures: failureBlocks.join('\n\n'),
    repo_results: repoResults,
  };
}

function compactTestOutput(output) {
  if (!output) return '(no output)';
  const lines = output.split('\n');
  const compacted = [];
  let inFailure = false;
  let failureLines = 0;

  for (const line of lines) {
    if (line.match(/Tests?:?\s+\d+/i) || line.match(/\d+\s+(passed|failed)/i) ||
        line.match(/^=+\s+.*\d+\s+(passed|failed)/) ||
        line.match(/^FAILED\s/) || line.match(/^ERROR\s/)) {
      compacted.push(line); inFailure = true; failureLines = 0; continue;
    }
    if (line.includes('FAIL') || line.includes('Error') || line.includes('AssertionError') ||
        line.includes('AssertError') || line.includes('✗') || line.includes('✕') ||
        line.includes('FAILED') || line.match(/^E\s/) || line.match(/^>\s/) ||
        line.includes('assert ')) {
      inFailure = true; failureLines = 0; compacted.push(line); continue;
    }
    if (inFailure) {
      compacted.push(line);
      failureLines++;
      if (line.trim() === '' || failureLines > 8) inFailure = false;
    }
  }
  const lastLines = lines.slice(-5);
  for (const line of lastLines) {
    if (line.match(/\d+\s+(passed|failed)/i) && !compacted.includes(line)) compacted.push(line);
  }
  return compacted.slice(0, 100).join('\n');
}

function extractTestCounts(output) {
  const vitestLine = output.match(/Tests\s+.*?\((\d+)\)/);
  if (vitestLine) {
    const line = vitestLine[0];
    const passedMatch = line.match(/(\d+)\s+passed/i);
    const failedMatch = line.match(/(\d+)\s+failed/i);
    const total = parseInt(vitestLine[1]);
    return { passed: passedMatch ? parseInt(passedMatch[1]) : 0, failed: failedMatch ? parseInt(failedMatch[1]) : 0, total };
  }
  const jestLine = output.match(/Tests?:.*?(\d+\s+total)/i);
  if (jestLine) {
    const line = jestLine[0];
    const passedMatch = line.match(/(\d+)\s+passed/i);
    const failedMatch = line.match(/(\d+)\s+failed/i);
    const totalMatch = line.match(/(\d+)\s+total/i);
    const passed = passedMatch ? parseInt(passedMatch[1]) : 0;
    const failed = failedMatch ? parseInt(failedMatch[1]) : 0;
    return { passed, failed, total: totalMatch ? parseInt(totalMatch[1]) : passed + failed };
  }
  const pytestMatch = output.match(/(\d+)\s+passed/i);
  if (pytestMatch) {
    const passed = parseInt(pytestMatch[1]) || 0;
    const failedMatch = output.match(/(\d+)\s+failed/i);
    const failed = failedMatch ? parseInt(failedMatch[1]) : 0;
    return { passed, failed, total: passed + failed };
  }
  return { passed: 0, failed: 0, total: 0 };
}

function isNoTestsCollected(err) {
  if (err.status === 5) return true;
  const out = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`;
  return /no tests (collected|ran|found)|collected 0 items|0 passing|No test files found|file or directory not found:\s*tests/i.test(out);
}

function isRunnerCrash(err) {
  const msg = err.message || '';
  const stderr = err.stderr || '';
  const stdout = err.stdout || '';
  const combined = msg + stderr + stdout;
  return combined.includes('ENOENT') ||
         combined.includes('command not found') ||
         combined.includes('Cannot find module') ||
         combined.includes('ERR_MODULE_NOT_FOUND') ||
         combined.includes('jest is not defined') ||
         (err.killed && err.signal === 'SIGTERM');
}
