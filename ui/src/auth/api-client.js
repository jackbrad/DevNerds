import { fetchAuthSession } from 'aws-amplify/auth';

const API_BASE = import.meta.env.VITE_API_URL;

export async function apiFetch(path, opts = {}) {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();

  const headers = {
    ...(opts.headers || {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });

  if (res.status === 401) {
    // Token may have expired — try once more after a fresh session
    const retrySession = await fetchAuthSession({ forceRefresh: true });
    const retryToken = retrySession.tokens?.idToken?.toString();
    const retryHeaders = {
      ...(opts.headers || {}),
      ...(retryToken ? { Authorization: `Bearer ${retryToken}` } : {}),
    };
    const retryRes = await fetch(`${API_BASE}${path}`, { ...opts, headers: retryHeaders });
    if (!retryRes.ok) {
      const body = await retryRes.json().catch(() => ({}));
      throw new Error(body.error || `API error ${retryRes.status}`);
    }
    return retryRes.json();
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `API error ${res.status}`);
  }
  return res.json();
}
