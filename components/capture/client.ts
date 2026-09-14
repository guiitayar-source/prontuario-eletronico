import { apiFetch } from '@/lib/supabase/http';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
export type CaptureRequest = {
  id: string;
  patient_name: string;
  patient_id: string;
  category: string;
  expires_at: number;
  state: string;
};
export type Pairing = {
  id: string;
  token: string;
  expires_at: number;
  request?: CaptureRequest;
};
export type Received = {
  id: string;
  request_id: string;
  name: string;
  mime: string;
  size: number;
  category: string;
  created_at: number;
};
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
export const categoryNames: Record<string, string> = {
  pending: 'A conferir',
  exam: 'Exame',
  report: 'Relatório externo',
  other: 'Outro documento',
};
type DeviceState = {
  request: CaptureRequest | null;
  expires_at: number;
  connected: boolean;
};
export function api(
  action: 'list' | `list&patientId=${string}` | `archived&patientId=${string}`,
): Promise<{ attachments: Received[] }>;
export function api(
  action: 'connect',
  data: unknown,
): Promise<Pairing & { request: CaptureRequest }>;
export function api(
  action: 'request',
  data: unknown,
): Promise<{ request: CaptureRequest }>;
export function api(
  action: `pair&id=${string}` | `mobile&id=${string}`,
  data?: undefined,
  token?: string,
): Promise<DeviceState>;
export function api(
  action: string,
  data?: unknown,
  token?: string,
): Promise<{ ok?: boolean }>;
export async function api(
  action: string,
  data?: unknown,
  token?: string,
): Promise<unknown> {
  if (action === 'upload' && data instanceof FormData) {
    const file = data.get('file') as File;
    const details = { requestId: data.get('requestId'), uploadId: data.get('uploadId'), name: file.name, mime: file.type, size: file.size };
    const lease = await api('prepare', details, token) as { path?: string; alreadyReceived?: boolean };
    if (lease.alreadyReceived) return lease;
    if (!lease.path) throw new Error('Não foi possível preparar o envio.');
    const result = await getSupabaseBrowserClient().storage.from('clinical-files').upload(lease.path, file, { contentType: file.type, upsert: false });
    if (result.error && !['409','400'].includes(String(result.error.statusCode))) throw new Error('Falha no envio. Tente novamente.');
    return api('commit', { ...details, path: lease.path }, token);
  }
  const response = await apiFetch(`/api/capture?action=${action}`, {
    method: data === undefined ? 'GET' : 'POST',
    cache: 'no-store',
    headers: {
      ...(data === undefined
        ? {}
        : {
            'X-Capture-Action': '1',
            ...(data instanceof FormData
              ? {}
              : { 'Content-Type': 'application/json' }),
          }),
      ...(token ? { 'X-Device-Token': token } : {}),
    },
    body:
      data === undefined
        ? undefined
        : data instanceof FormData
          ? data
          : JSON.stringify(data),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(
      'Acesso interrompido. Recarregue a página e entre novamente.',
    );
  }
  if (!response.ok)
    throw new ApiError(
      (result as { error?: string }).error ||
        'Falha na conexão. Tente novamente.',
      response.status,
    );
  return result;
}
export const formatBytes = (n: number) =>
  n < 1024 * 1024
    ? `${Math.ceil(n / 1024)} KB`
    : `${(n / 1024 / 1024).toFixed(1)} MB`;
