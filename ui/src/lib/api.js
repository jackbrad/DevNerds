import { apiFetch } from '../auth/api-client';

export async function fetchTasks() {
  // Hit the dedicated /tasks endpoint — '/' bundles a quips S3 lookup
  // that can fail and take the whole task list down with it.
  const data = await apiFetch('/tasks');
  return data.tasks || [];
}

export async function fetchTaskDetail(taskId) {
  return apiFetch(`/tasks/${taskId}`);
}

export async function fetchArtifacts(taskId) {
  const data = await apiFetch(`/tasks/${taskId}/artifacts`);
  return data.files || [];
}

export async function fetchArtifactContent(taskId, filename) {
  return apiFetch(`/tasks/${taskId}/artifacts/${filename}`);
}

export async function fetchBlueprints() {
  const data = await apiFetch('/blueprints');
  return data.blueprints || [];
}

export async function addNote(taskId, author, text) {
  return apiFetch(`/tasks/${taskId}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ author, text }),
  });
}

export async function updateTask(taskId, fields) {
  return apiFetch('/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId, ...fields }),
  });
}

