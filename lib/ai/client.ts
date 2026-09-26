import { HttpError } from '../supabase/server.ts';
import { geminiOutputText, responseOutputText } from '../openai-files.ts';

export type AiProvider = 'openai' | 'gemini';

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
  return Boolean(
    provider === 'gemini'
      ? process.env.GEMINI_API_KEY
      : process.env.OPENAI_API_KEY,
  );
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
        ...(model === 'gpt-6-luna' ? { reasoning: { effort: 'medium' } } : {}),
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

export async function requestGeminiText({
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
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new HttpError(503, 'Gemini não configurado no servidor.');
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(model))
    throw new HttpError(503, 'O modelo Gemini configurado é inválido.');

  let response: Response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instructions }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens, temperature: 0.2 },
        }),
        signal: AbortSignal.timeout(90_000),
      },
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError')
      throw new HttpError(
        504,
        'A geração demorou além do esperado. Tente novamente.',
      );
    throw new HttpError(
      503,
      'Não foi possível conectar ao Gemini. Tente novamente.',
    );
  }

  let result: Record<string, unknown>;
  try {
    result = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new HttpError(502, 'O Gemini devolveu uma resposta inválida.');
  }

  if (!response.ok) {
    const message = (result.error as { message?: string } | undefined)?.message;
    console.error('Gemini text request failed', response.status, message);
    throw new HttpError(
      response.status === 429 ? 429 : 502,
      response.status === 429
        ? 'O limite temporário do Gemini foi atingido. Tente novamente em instantes.'
        : 'O Gemini não conseguiu gerar a resposta.',
    );
  }

  const text = geminiOutputText(result).trim();
  if (!text) throw new HttpError(422, 'A IA não devolveu uma resposta.');

  const raw = result.usageMetadata as
    | {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      }
    | undefined;

  return {
    text,
    usage: {
      inputTokens: raw?.promptTokenCount,
      outputTokens: raw?.candidatesTokenCount,
      totalTokens: raw?.totalTokenCount,
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
        ...(model === 'gpt-6-luna' ? { reasoning: { effort: 'medium' } } : {}),
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

export async function requestGeminiFile({
  model,
  instructions,
  bytes,
  mime,
  geminiSchema,
  maxOutputTokens = 8_000,
}: {
  model: string;
  instructions: string;
  bytes: Uint8Array;
  mime: string;
  geminiSchema: object;
  maxOutputTokens?: number;
}): Promise<unknown> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey)
    throw new HttpError(
      503,
      'Gemini ainda não configurado. Adicione GEMINI_API_KEY ao ambiente do servidor.',
    );
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(model))
    throw new HttpError(503, 'O modelo Gemini configurado é inválido.');

  let response: Response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instructions }] },
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: 'Leia somente o arquivo anexado e devolva a extração solicitada.',
                },
                {
                  inlineData: {
                    mimeType: mime,
                    data: Buffer.from(bytes).toString('base64'),
                  },
                },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            responseJsonSchema: geminiSchema,
            maxOutputTokens,
          },
        }),
        signal: AbortSignal.timeout(90_000),
      },
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError')
      throw new HttpError(
        504,
        'A leitura demorou além do esperado. Tente novamente.',
      );
    throw new HttpError(
      503,
      'Não foi possível conectar ao Gemini. Tente novamente.',
    );
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new HttpError(502, 'O Gemini devolveu uma resposta inválida.');
  }

  if (!response.ok) {
    const errorBody = result as { error?: { message?: string } };
    const apiDetail = errorBody?.error?.message
      ? `: ${errorBody.error.message}`
      : '';
    console.error('Gemini file extraction failed', response.status, errorBody);
    throw new HttpError(
      response.status === 429 ? 429 : 502,
      response.status === 429
        ? 'O limite temporário de leituras do Gemini foi atingido. Tente novamente em instantes.'
        : `O Gemini não conseguiu processar o arquivo${apiDetail}.`,
    );
  }

  const text = geminiOutputText(result);
  if (!text) {
    const raw = result as {
      promptFeedback?: { blockReason?: string };
      candidates?: { finishReason?: string }[];
    };
    const reason =
      raw?.promptFeedback?.blockReason || raw?.candidates?.[0]?.finishReason;
    const detail = reason ? ` (motivo: ${reason})` : '';
    throw new HttpError(
      422,
      `O Gemini não encontrou informação legível ou bloqueou a resposta${detail}.`,
    );
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(502, 'O Gemini devolveu dados inválidos.');
  }
}
