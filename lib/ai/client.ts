import { HttpError } from '../supabase/server.ts';
import { responseOutputText } from '../openai-files.ts';

export type AiProvider = 'openai';

export type AiUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type AiTextResponse = {
  text: string;
  usage: AiUsage;
};

export function isAiProviderConfigured(provider: AiProvider): boolean {
  return provider === 'openai' && Boolean(process.env.OPENAI_API_KEY);
}

export async function requestOpenAiText({
  model,
  instructions,
  prompt,
  maxOutputTokens = 5_000,
}: {
  model: string;
  instructions: string;
  prompt: string;
  maxOutputTokens?: number;
}): Promise<AiTextResponse> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new HttpError(503, 'OpenAI não configurada no servidor.');

  let response: Response;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        store: false,
        instructions,
        input: prompt,
        max_output_tokens: maxOutputTokens,
        ...(model.includes('gpt-5.6') ? { reasoning: { effort: 'low' } } : {}),
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError')
      throw new HttpError(
        504,
        'A geração demorou além do esperado. Tente novamente.',
      );
    throw new HttpError(
      503,
      'Não foi possível conectar à OpenAI. Tente novamente.',
    );
  }

  let result: Record<string, unknown>;
  try {
    result = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new HttpError(502, 'A OpenAI devolveu uma resposta inválida.');
  }

  if (!response.ok) {
    const message = (result.error as { message?: string } | undefined)?.message;
    console.error('OpenAI text request failed', response.status, message);
    throw new HttpError(
      response.status === 429 ? 429 : 502,
      response.status === 429
        ? 'O limite temporário da OpenAI foi atingido. Tente novamente em instantes.'
        : 'A OpenAI não conseguiu gerar a resposta.',
    );
  }

  const text = responseOutputText(result).trim();
  if (!text) throw new HttpError(422, 'A IA não devolveu uma resposta.');

  const raw = result.usage as
    | { input_tokens?: number; output_tokens?: number; total_tokens?: number }
    | undefined;

  return {
    text,
    usage: {
      inputTokens: raw?.input_tokens,
      outputTokens: raw?.output_tokens,
      totalTokens: raw?.total_tokens,
    },
  };
}

export async function requestOpenAiFile({
  model,
  instructions,
  bytes,
  mime,
  name,
  schemaName,
  schema,
  maxOutputTokens = 8_000,
}: {
  model: string;
  instructions: string;
  bytes: Uint8Array;
  mime: string;
  name: string;
  schemaName: string;
  schema: object;
  maxOutputTokens?: number;
}): Promise<unknown> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey)
    throw new HttpError(
      503,
      'Leitura por IA ainda não configurada. Adicione OPENAI_API_KEY ao ambiente do servidor.',
    );

  const dataUrl = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
  const fileContent =
    mime === 'application/pdf'
      ? {
          type: 'input_file',
          filename: name,
          file_data: dataUrl,
        }
      : {
          type: 'input_image',
          image_url: dataUrl,
          detail: 'high',
        };

  let response: Response;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        store: false,
        instructions,
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: 'Leia somente o arquivo anexado e devolva a extração solicitada.',
              },
              fileContent,
            ],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: schemaName,
            strict: true,
            schema,
          },
        },
        max_output_tokens: maxOutputTokens,
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError')
      throw new HttpError(
        504,
        'A leitura demorou além do esperado. Tente novamente.',
      );
    throw new HttpError(
      503,
      'Não foi possível conectar ao serviço de leitura. Tente novamente.',
    );
  }

  type OpenAIFileResponse = {
    status?: string;
    incomplete_details?: { reason?: string };
    output?: unknown[];
    error?: { message?: string };
  };

  let result: OpenAIFileResponse;
  try {
    result = (await response.json()) as OpenAIFileResponse;
  } catch {
    throw new HttpError(
      502,
      'O serviço de leitura devolveu uma resposta inválida.',
    );
  }

  if (!response.ok) {
    const apiDetail = result?.error?.message ? `: ${result.error.message}` : '';
    console.error('OpenAI file extraction failed', response.status, result);
    throw new HttpError(
      response.status === 429 ? 429 : 502,
      response.status === 429
        ? 'O limite temporário de leituras foi atingido. Tente novamente em instantes.'
        : `O serviço de leitura não conseguiu processar o arquivo${apiDetail}.`,
    );
  }

  if (result.status && result.status !== 'completed') {
    const reason = result.incomplete_details?.reason
      ? ` (${result.incomplete_details.reason})`
      : '';
    console.error('OpenAI file extraction incomplete', result.incomplete_details);
    throw new HttpError(
      422,
      `A leitura ficou incompleta${reason}. Tente um arquivo menor ou páginas mais nítidas.`,
    );
  }

  const text = responseOutputText(result);
  if (!text)
    throw new HttpError(422, 'Nenhuma informação legível foi encontrada.');

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(502, 'O serviço de leitura devolveu dados inválidos.');
  }
}
