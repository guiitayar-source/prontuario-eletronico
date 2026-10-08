/** Ponte local do Anamnesator (app de transcrição que roda neste computador). */
const BRIDGE = 'http://127.0.0.1:8767';
const CLIENT_HEADERS = { 'X-Anamnesator-Client': 'psywrite' };

export type Provider = {
  id: string;
  label: string;
  configured: boolean;
  privacy: 'local' | 'api';
  models: { id: string; label: string }[];
};

export type Capabilities = {
  transcription_providers: Provider[];
  draft_providers: Provider[];
  audio_retention: 'delete_after_processing' | 'owner_configured_local_copy';
};

export function extensionFor(type: string) {
  if (type.includes('ogg')) return '.ogg';
  if (type.includes('mp4') || type.includes('m4a')) return '.m4a';
  return '.webm';
}

export async function bridgeJson(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  for (const [key, value] of Object.entries(CLIENT_HEADERS))
    headers.set(key, value);
  const response = await fetch(`${BRIDGE}${path}`, {
    ...init,
    headers,
    cache: 'no-store',
  });
  const payload: unknown = await response.json();
  const result =
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  if (!response.ok)
    throw new Error(
      typeof result.message === 'string'
        ? result.message
        : 'O Anamnesator não conseguiu concluir a operação.',
    );
  return result;
}

export async function waitForJob(
  id: string,
  field: 'transcription' | 'anamnese',
) {
  for (;;) {
    const job = await bridgeJson(`/v1/jobs/${id}`);
    if (job.state === 'failed' || job.state === 'cancelled')
      throw new Error(
        typeof job.error === 'string'
          ? job.error
          : 'O processamento foi interrompido.',
      );
    if (job.state === 'completed') {
      const result = await bridgeJson(`/v1/jobs/${id}/result`);
      await bridgeJson(`/v1/jobs/${id}`, { method: 'DELETE' }).catch(() => {});
      const value = result[field];
      if (typeof value !== 'string' || !value.trim())
        throw new Error('O Anamnesator devolveu um resultado vazio.');
      return value.trim();
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
