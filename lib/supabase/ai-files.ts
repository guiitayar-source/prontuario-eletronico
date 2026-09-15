import { fileType, MAX_FILE } from '../capture.ts';
import type { ExamDefinition } from '../exams.ts';
import {
  examExtractionSchema,
  extractionInstructions,
  normalizeDocumentTranscription,
  normalizeExamExtraction,
  responseOutputText,
  transcriptionInstructions,
  transcriptionSchema,
} from '../openai-files.ts';
import { body, check, handle, HttpError, json, writeGuard } from './server.ts';

const ALLOWED_MIMES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

type OpenAIResponse = {
  status?: string;
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  output?: unknown;
};

async function askOpenAI({
  bytes,
  mime,
  name,
  model,
  instructions,
  schemaName,
  schema,
  maxOutputTokens,
}: {
  bytes: Uint8Array;
  mime: string;
  name: string;
  model: string;
  instructions: string;
  schemaName: string;
  schema: object;
  maxOutputTokens: number;
}) {
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
  let result: OpenAIResponse;
  try {
    result = (await response.json()) as OpenAIResponse;
  } catch {
    throw new HttpError(
      502,
      'O serviço de leitura devolveu uma resposta inválida.',
    );
  }
  if (!response.ok) {
    console.error('OpenAI file extraction failed', response.status);
    throw new HttpError(
      response.status === 429 ? 429 : 502,
      response.status === 429
        ? 'O limite temporário de leituras foi atingido. Tente novamente em instantes.'
        : 'O serviço de leitura não conseguiu processar o arquivo.',
    );
  }
  if (result.status && result.status !== 'completed') {
    console.error('OpenAI file extraction incomplete');
    throw new HttpError(
      422,
      'A leitura ficou incompleta. Tente um arquivo menor ou páginas mais nítidas.',
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

export const aiFiles = handle(async (request, { db, clinic, role }) => {
  if (!['owner', 'doctor'].includes(role))
    throw new HttpError(
      403,
      'Leitura por IA disponível somente à equipe médica.',
    );
  writeGuard(request, 'X-AI-Action');
  const url = new URL(request.url);
  const patientId = url.searchParams.get('patientId');
  if (!patientId || patientId.length > 180)
    throw new HttpError(400, 'Selecione um paciente.');
  const data = await body(request);
  const action = data.action;
  const attachmentId = data.attachmentId;
  if (
    !['extract-exams', 'transcribe-document'].includes(String(action)) ||
    typeof attachmentId !== 'string' ||
    !/^[a-f0-9-]{36}$/i.test(attachmentId)
  )
    throw new HttpError(422, 'Selecione um arquivo válido.');

  const attachment = check(
    await db
      .from('attachments')
      .select('id,name,mime,size,category,storage_path')
      .eq('id', attachmentId)
      .eq('clinic_id', clinic)
      .eq('patient_id', patientId)
      .is('archived_at', null)
      .maybeSingle(),
  );
  if (!attachment)
    throw new HttpError(404, 'Arquivo não encontrado para este paciente.');
  if (
    (action === 'extract-exams' && attachment.category !== 'exam') ||
    (action === 'transcribe-document' &&
      !['report', 'other'].includes(attachment.category))
  )
    throw new HttpError(
      422,
      'Classifique o arquivo antes de usar a leitura por IA.',
    );
  if (!ALLOWED_MIMES.has(attachment.mime) || Number(attachment.size) > MAX_FILE)
    throw new HttpError(
      415,
      'Use um arquivo JPG, PNG, WebP ou PDF de até 12 MB.',
    );

  const downloaded = await db.storage
    .from('clinical-files')
    .download(attachment.storage_path);
  if (downloaded.error || !downloaded.data)
    throw new HttpError(503, 'Não foi possível abrir o arquivo armazenado.');
  const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
  if (
    bytes.length !== Number(attachment.size) ||
    fileType(bytes.slice(0, 12)) !== attachment.mime
  )
    throw new HttpError(
      415,
      'O conteúdo do arquivo não corresponde ao tipo registrado.',
    );

  const extractedAt = new Date().toISOString();
  if (action === 'transcribe-document') {
    const model =
      process.env.OPENAI_TRANSCRIPTION_MODEL ||
      process.env.OPENAI_EXAM_MODEL ||
      'gpt-4o-mini';
    const result = await askOpenAI({
      bytes,
      mime: attachment.mime,
      name: attachment.name,
      model,
      instructions: transcriptionInstructions,
      schemaName: 'clinical_document_transcription',
      schema: transcriptionSchema,
      maxOutputTokens: 16_000,
    });
    try {
      return json({
        proposal: normalizeDocumentTranscription(result, {
          attachmentId,
          provider: 'OpenAI',
          model,
          extractedAt,
        }),
      });
    } catch (error) {
      throw new HttpError(422, (error as Error).message);
    }
  }

  const definitions = check(
    await db
      .from('exam_definitions')
      .select('*')
      .or(`clinic_id.is.null,clinic_id.eq.${clinic}`)
      .order('name'),
  ) as ExamDefinition[];
  const model = process.env.OPENAI_EXAM_MODEL || 'gpt-4o-mini';
  const result = await askOpenAI({
    bytes,
    mime: attachment.mime,
    name: attachment.name,
    model,
    instructions: extractionInstructions(definitions),
    schemaName: 'exam_extraction_proposal',
    schema: examExtractionSchema,
    maxOutputTokens: 16_000,
  });
  try {
    return json({
      proposal: normalizeExamExtraction(
        result,
        { attachmentId, provider: 'OpenAI', model, extractedAt },
        definitions,
      ),
    });
  } catch (error) {
    throw new HttpError(422, (error as Error).message);
  }
});
