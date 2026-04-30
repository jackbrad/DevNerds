/**
 * Task Database — DynamoDB operations for task management.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

let docClient = null;

// Keys that updateTaskStatus sets automatically — caller-supplied metadata
// must not redeclare them or DynamoDB rejects the request with
// "Two document paths overlap".
const RESERVED_STATUS_KEYS = new Set(['status', 'failCount', 'claimedAt', 'completedAt', 'verifiedAt', 'updatedAt']);

async function withRetry(fn, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries || !isRetryable(err)) throw err;
      const delay = Math.min(1000 * 2 ** attempt, 5000);
      console.log(`  [task-db] Retryable error (attempt ${attempt + 1}/${maxRetries}): ${err.name || err.message}. Retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function isRetryable(err) {
  const name = err.name || '';
  const msg = err.message || '';
  return name === 'ProvisionedThroughputExceededException' ||
         name === 'ThrottlingException' ||
         name === 'ServiceUnavailable' ||
         name === 'InternalServerError' ||
         msg.includes('ECONNRESET') ||
         msg.includes('connect ETIMEDOUT') ||
         msg.includes('socket hang up');
}

// Migrate old persona values to agentType on read so tasks created
// before the rename still work correctly.
const PERSONA_MAP = { pixel: 'frontend', runway: 'backend', lander: 'backend' };

function migrateTask(task) {
  if (!task) return task;
  if (!task.agentType && task.persona) {
    task.agentType = PERSONA_MAP[task.persona] || task.persona;
  }
  return task;
}

function getClient(projectConfig) {
  if (!docClient) {
    const client = new DynamoDBClient({ region: projectConfig.aws_region || 'us-east-1' });
    docClient = DynamoDBDocumentClient.from(client);
  }
  return docClient;
}

export async function getTask(taskId, projectConfig) {
  const client = getClient(projectConfig);
  const result = await withRetry(() => client.send(new GetCommand({
    TableName: projectConfig.task_table,
    Key: { pk: `TASK#${taskId}`, sk: 'DETAILS' },
  })));
  return migrateTask(result.Item || null);
}

export async function getTaskStatus(taskId, projectConfig) {
  const task = await getTask(taskId, projectConfig);
  return task?.status || null;
}

export async function getTasksByStatus(status, projectConfig) {
  const client = getClient(projectConfig);
  const result = await withRetry(() => client.send(new QueryCommand({
    TableName: projectConfig.task_table,
    IndexName: 'status-index',
    KeyConditionExpression: '#status = :status',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':status': status },
  })));
  return (result.Items || []).map(migrateTask);
}

export async function updateTaskStatus(taskId, newStatus, projectConfig, metadata = {}) {
  const client = getClient(projectConfig);
  const now = new Date().toISOString();

  const updateExpr = ['#status = :status', 'updatedAt = :now'];
  const exprValues = { ':status': newStatus, ':now': now };
  const exprNames = { '#status': 'status' };

  if (newStatus === 'IN_PROGRESS') {
    updateExpr.push('claimedAt = :now');
  } else if (newStatus === 'TESTING') {
    updateExpr.push('completedAt = :now');
  } else if (newStatus === 'CLOSED') {
    updateExpr.push('verifiedAt = :now');
  } else if (newStatus === 'FAILED') {
    updateExpr.push('failCount = if_not_exists(failCount, :zero) + :one');
    exprValues[':one'] = 1;
    exprValues[':zero'] = 0;
  }

  for (const [key, value] of Object.entries(metadata)) {
    if (RESERVED_STATUS_KEYS.has(key)) continue; // skip keys we already set above
    const attrName = `#${key}`;
    const attrValue = `:${key}`;
    updateExpr.push(`${attrName} = ${attrValue}`);
    exprNames[attrName] = key;
    exprValues[attrValue] = value;
  }

  await withRetry(() => client.send(new UpdateCommand({
    TableName: projectConfig.task_table,
    Key: { pk: `TASK#${taskId}`, sk: 'DETAILS' },
    UpdateExpression: `SET ${updateExpr.join(', ')}`,
    ExpressionAttributeNames: exprNames,
    ExpressionAttributeValues: exprValues,
  })));
}

/**
 * Update multiple fields in a single atomic DDB UpdateCommand.
 * Pass `null`/`undefined` for any field to REMOVE that attribute.
 */
export async function updateTaskFields(taskId, fields, projectConfig) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;

  const setParts = ['updatedAt = :now'];
  const removeParts = [];
  const exprNames = {};
  const exprValues = { ':now': new Date().toISOString() };

  for (const k of keys) {
    const attrName = `#${k}`;
    exprNames[attrName] = k;
    if (fields[k] === null || fields[k] === undefined) {
      removeParts.push(attrName);
    } else {
      const attrValue = `:${k}`;
      setParts.push(`${attrName} = ${attrValue}`);
      exprValues[attrValue] = fields[k];
    }
  }

  let updateExpression = `SET ${setParts.join(', ')}`;
  if (removeParts.length > 0) updateExpression += ` REMOVE ${removeParts.join(', ')}`;

  const client = getClient(projectConfig);
  await withRetry(() => client.send(new UpdateCommand({
    TableName: projectConfig.task_table,
    Key: { pk: `TASK#${taskId}`, sk: 'DETAILS' },
    UpdateExpression: updateExpression,
    ExpressionAttributeNames: exprNames,
    ExpressionAttributeValues: exprValues,
  })));
}

export async function updateTaskField(taskId, field, value, projectConfig) {
  const client = getClient(projectConfig);
  // value=null/undefined → REMOVE the attribute (cleaner than writing DDB NULL).
  if (value === null || value === undefined) {
    await withRetry(() => client.send(new UpdateCommand({
      TableName: projectConfig.task_table,
      Key: { pk: `TASK#${taskId}`, sk: 'DETAILS' },
      UpdateExpression: `REMOVE #field SET updatedAt = :now`,
      ExpressionAttributeNames: { '#field': field },
      ExpressionAttributeValues: { ':now': new Date().toISOString() },
    })));
    return;
  }
  await withRetry(() => client.send(new UpdateCommand({
    TableName: projectConfig.task_table,
    Key: { pk: `TASK#${taskId}`, sk: 'DETAILS' },
    UpdateExpression: `SET #field = :value, updatedAt = :now`,
    ExpressionAttributeNames: { '#field': field },
    ExpressionAttributeValues: { ':value': value, ':now': new Date().toISOString() },
  })));
}

export async function appendTaskNote(taskId, author, text, projectConfig) {
  const client = getClient(projectConfig);
  await withRetry(() => client.send(new UpdateCommand({
    TableName: projectConfig.task_table,
    Key: { pk: `TASK#${taskId}`, sk: 'DETAILS' },
    UpdateExpression: 'SET notes = list_append(if_not_exists(notes, :empty), :note), updatedAt = :now',
    ExpressionAttributeValues: {
      ':note': [{ author, timestamp: new Date().toISOString(), text }],
      ':empty': [],
      ':now': new Date().toISOString(),
    },
  })));
}
