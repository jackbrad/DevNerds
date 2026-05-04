/**
 * Notify — Send alerts when the pipeline encounters critical failures.
 *
 * Uses AWS SES to email the owner. Falls back to console.error if SES fails.
 */

import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

const ses = new SESClient({ region: process.env.DEVNERDS_SES_REGION || 'us-east-1' });
const FROM = process.env.DEVNERDS_ALERT_FROM;
const TO = process.env.DEVNERDS_ALERT_TO;

// Rate limiting: max 1 email per subject per 10 minutes
const RATE_LIMIT_MS = 600_000;
const recentAlerts = new Map(); // subject → timestamp

/**
 * Send an alert email.
 * @param {string} subject - Email subject
 * @param {string} body - Plain text body
 */
export async function alert(subject, body) {
  const fullSubject = `[DevNerds] ${subject}`;

  // Rate limit: skip if we sent this same subject recently
  const lastSent = recentAlerts.get(fullSubject);
  if (lastSent && Date.now() - lastSent < RATE_LIMIT_MS) {
    console.error(`[ALERT] Rate-limited (sent ${Math.round((Date.now() - lastSent) / 1000)}s ago): ${fullSubject}`);
    return;
  }

  console.error(`[ALERT] ${fullSubject}: ${body.slice(0, 200)}`);

  if (!FROM || !TO) {
    console.error(`[ALERT] ${fullSubject}: ${body.slice(0, 200)} (DEVNERDS_ALERT_FROM/TO unset — skipping email)`);
    return;
  }

  try {
    await ses.send(new SendEmailCommand({
      Source: FROM,
      Destination: { ToAddresses: [TO] },
      Message: {
        Subject: { Data: fullSubject },
        Body: { Text: { Data: body } },
      },
    }));
    recentAlerts.set(fullSubject, Date.now());
    console.log(`[ALERT] Email sent to ${TO}`);
  } catch (err) {
    console.error(`[ALERT] Email failed: ${err.message} — alert was: ${fullSubject}`);
  }
}

/**
 * Alert for pipeline infrastructure failures (not task failures).
 */
export async function alertInfra(component, error) {
  await alert(
    `${component} is broken`,
    `The ${component} component failed with an error that needs attention:\n\n${error}\n\nThis is not a task failure — this is a pipeline infrastructure issue that will block all tasks until fixed.`
  );
}

/**
 * Alert for task failures that need human review.
 */
export async function alertTaskFailed(taskId, node, reason) {
  await alert(
    `Task ${taskId} failed at ${node}`,
    `Task ${taskId} failed at the ${node} node.\n\nReason: ${reason}\n\nReview the task in DynamoDB or run:\n  node engine/run-single-task.js ${taskId}`
  );
}

/**
 * Summary email after a task loader run.
 */
export async function alertTaskLoaderSummary(queued, blocked, errors) {
  if (errors.length === 0 && blocked === 0) return; // Only alert on problems

  const lines = [`TaskLoader completed: ${queued} queued, ${blocked} blocked, ${errors.length} errors`];
  if (errors.length > 0) {
    lines.push('\nErrors:');
    for (const err of errors) {
      lines.push(`  - ${err}`);
    }
  }
  await alert('TaskLoader run summary', lines.join('\n'));
}

// Backward compat alias
export const alertForemanSummary = alertTaskLoaderSummary;
