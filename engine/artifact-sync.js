/**
 * Artifact Sync — Uploads pipeline artifacts to S3 for UI access.
 *
 * Each artifact is stored at: s3://devnerds-artifacts/{taskId}/{filename}
 * Called by blueprint-engine.js after each node writes output.
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const BUCKET = process.env.DEVNERDS_ARTIFACTS_BUCKET || 'devnerds-artifacts';
const REGION = process.env.AWS_REGION || 'us-east-1';

let s3Client = null;

function getClient() {
  if (!s3Client) {
    s3Client = new S3Client({ region: REGION });
  }
  return s3Client;
}

/**
 * Upload a single artifact file to S3.
 *
 * @param {string} taskId - Task ID (e.g., "GF-TEST-002")
 * @param {string} filename - File name (e.g., "build_output.json")
 * @param {string|Buffer} content - File content
 * @param {string} [contentType] - MIME type (auto-detected from extension if omitted)
 */
export async function syncArtifact(taskId, filename, content) {
  const key = `${taskId}/${filename}`;
  const contentType = detectContentType(filename);

  try {
    await getClient().send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: typeof content === 'string' ? content : JSON.stringify(content),
      ContentType: contentType,
    }));
  } catch (err) {
    // Log but don't fail the pipeline over a sync error
    console.error(`  [artifact-sync] Failed to upload ${key}: ${err.message}`);
  }
}

/**
 * Upload accumulated metrics for a task to S3.
 * Stored as a JSON array at {taskId}/metrics.json.
 *
 * @param {string} taskId
 * @param {Object[]} metrics - Array of metric entries for this task
 */
export async function syncMetrics(taskId, metrics) {
  await syncArtifact(taskId, 'metrics.json', JSON.stringify(metrics, null, 2));
}

/**
 * Delete local artifact directory for a task.
 * Call after pipeline completes (success or failure) and artifacts are in S3.
 *
 * @param {string} artifactsDir - Path to task artifacts directory (e.g., ./artifacts/GF-200)
 */
export async function cleanupLocalArtifacts(artifactsDir) {
  const fs = await import('fs/promises');
  try {
    await fs.rm(artifactsDir, { recursive: true, force: true });
    console.log(`  [artifact-sync] Cleaned up local artifacts: ${artifactsDir}`);
  } catch (err) {
    console.error(`  [artifact-sync] Failed to cleanup ${artifactsDir}: ${err.message}`);
  }
}

/**
 * Detect content type from filename extension.
 */
function detectContentType(filename) {
  if (filename.endsWith('.json')) return 'application/json';
  if (filename.endsWith('.md')) return 'text/markdown';
  if (filename.endsWith('.jsonl')) return 'application/x-ndjson';
  return 'text/plain';
}
