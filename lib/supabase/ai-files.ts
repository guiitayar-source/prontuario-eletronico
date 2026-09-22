import _sharp from 'sharp';
import { fileType, MAX_FILE } from '../file-utils.ts';
import type { ExamDefinition } from '../exams.ts';
import {
  isAiProviderConfigured,
  requestOpenAiFile,
  requestGeminiFile,
} from '../ai/client.ts';
import {
  examExtractionSchema,
  extractionInstructions,
  normalizeDocumentTranscription,
  normalizeExamExtraction,
  transcriptionInstructions,
  transcriptionSchema,
} from '../openai-files.ts';
import { body, check, handle, HttpError, json, writeGuard } from './server.ts';

type SharpInstance = {
  metadata(): Promise<{ width?: number; height?: number }>;
  rotate(): SharpInstance;
  resize(options: {
    width?: number;
    height?: number;
    fit?: string;
    withoutEnlargement?: boolean;
  }): SharpInstance;
  jpeg(options: { quality?: number; mozjpeg?: boolean }): SharpInstance;
  toBuffer(): Promise<Buffer>;
};
type SharpFn = (
  input?: Buffer | Uint8Array,
  options?: { failOnError?: boolean },
) => SharpInstance;
const sharp = _sharp as unknown as SharpFn;

export function adaptSchemaForGemini(schema: object): object {
  const jsonStr = JSON.stringify(schema);
  return JSON.parse(jsonStr, (_key, value) => {
    if (value && typeof value === 'object' && Array.isArray(value.type)) {
      const types = value.type as string[];
      if (types.includes('null') && types.length === 2) {
        const actualType = types.find((t) => t !== 'null');
        return { ...value, type: actualType, nullable: true };
      }
    }
    return value;
  });
}

export async function optimizeImageForAi(
  bytes: Uint8Array,
  mime: string,
): Promise<{ bytes: Uint8Array; mime: string }> {
  if (mime === 'application/pdf') {
    return { bytes, mime };
  }
  try {
    const image = sharp(bytes, { failOnError: false });
    const metadata = await image.metadata();
    const maxDimension = Math.max(metadata.width || 0, metadata.height || 0);

    // Se a imagem já for leve (< 1.2 MB) e a maior dimensão for <= 2048px, preserva os bytes
    if (
      bytes.length < 1.2 * 1024 * 1024 &&
      maxDimension > 0 &&
      maxDimension <= 2048
    ) {
      return { bytes, mime };
    }

    let pipeline = image.rotate(); // auto-rotação conforme orientação EXIF da câmera
    if (maxDimension > 2048) {
      pipeline = pipeline.resize({
        width:
          metadata.width && metadata.width >= (metadata.height || 0)
            ? 2048
            : undefined,
        height:
          metadata.height && metadata.height > (metadata.width || 0)
            ? 2048
            : undefined,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    const outputBuffer = await pipeline
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();

    return {
      bytes: new Uint8Array(outputBuffer),
      mime: 'image/jpeg',
    };
  } catch (err) {
    console.warn(
      'Falha na otimização da imagem para IA, mantendo bytes originais:',
      err,
    );
    return { bytes, mime };
  }
}

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

type AiProviderId = 'openai' | 'gemini' | 'demo';
type AiAction = 'extract-exams' | 'transcribe-document';
type AiExamModelId = 'gemini-flash' | 'openai-luna' | 'openai-mini' | 'demo';

const EXAM_MODELS: Record<
  AiExamModelId,
  { provider: AiProviderId; label: string; model: string }
> = {
  'gemini-flash': {
    provider: 'gemini',
    label: 'Gemini · Flash',
    model: process.env.GEMINI_EXAM_MODEL || 'gemini-2.5-flash',
  },
  'openai-luna': {
    provider: 'openai',
    label: 'OpenAI · Luna',
    model:
      process.env.OPENAI_LUNA_MODEL ||
      process.env.OPENAI_EXAM_MODEL ||
      'gpt-6-luna',
  },
  'openai-mini': {
    provider: 'openai',
    label: 'OpenAI · 4o mini',
    model: 'gpt-4o-mini',
  },
  demo: {
    provider: 'demo',
    label: 'Demonstração · Simulação Local',
    model: 'simulacao-local',
  },
};

const providerLabel = (provider: AiProviderId) => {
  if (provider === 'gemini') return 'Gemini';
  if (provider === 'openai') return 'OpenAI';
  return 'Demonstração';
};

function providerModel(provider: AiProviderId, action: AiAction) {
  if (provider === 'gemini') {
    return action === 'transcribe-document'
      ? process.env.GEMINI_TRANSCRIPTION_MODEL ||
          process.env.GEMINI_EXAM_MODEL ||
          'gemini-2.5-flash'
      : process.env.GEMINI_EXAM_MODEL || 'gemini-2.5-flash';
  }
  if (provider === 'demo') {
    return 'simulacao-local';
  }
  return action === 'transcribe-document'
    ? process.env.OPENAI_TRANSCRIPTION_MODEL ||
        process.env.OPENAI_EXAM_MODEL ||
        'gpt-4o-mini'
    : process.env.OPENAI_EXAM_MODEL || 'gpt-4o-mini';
}

function providerConfigured(provider: AiProviderId) {
  if (provider === 'demo') return true;
  return isAiProviderConfigured(provider);
}

function availableExamModels() {
  return Object.entries(EXAM_MODELS).map(([id, choice]) => ({
    id,
    label: choice.label,
    model: choice.model,
    configured: providerConfigured(choice.provider),
  }));
}

type FileAiOptions = {
  bytes: Uint8Array;
  mime: string;
  name: string;
  model: string;
  instructions: string;
  schemaName: string;
  schema: object;
  maxOutputTokens: number;
};

async function askOpenAI(options: FileAiOptions) {
  return requestOpenAiFile(options);
}

async function askGemini(options: FileAiOptions) {
  return requestGeminiFile({
    model: options.model,
    instructions: options.instructions,
    bytes: options.bytes,
    mime: options.mime,
    geminiSchema: adaptSchemaForGemini(options.schema),
    maxOutputTokens: options.maxOutputTokens,
  });
}

function generateDemoExtraction(definitions: ExamDefinition[]) {
  const hemogramaDef = definitions.find((d) =>
    d.name.toLowerCase().includes('hemograma'),
  );
  const astDef = definitions.find((d) => d.name.toLowerCase().includes('ast'));
  const glicemiaDef = definitions.find((d) =>
    d.name.toLowerCase().includes('glicemia'),
  );
  const exams = [];
  const today = new Date().toISOString().slice(0, 10);
  if (hemogramaDef) {
    exams.push({
      definitionId: hemogramaDef.id,
      originalName: hemogramaDef.name,
      collectedOn: today,
      laboratory: 'Laboratório Central (Demonstração)',
      method: 'Automatizado / Citometria de Fluxo',
      specimen: 'Sangue total com EDTA',
      fields: [
        {
          fieldId: 'hemacias',
          originalName: 'Hemácias',
          value: '4,85',
          unit: 'milhões/µL',
          reference: '4,3 a 5,7',
          page: 1,
          originalText: 'Hemácias: 4,85 milhões/µL (Ref: 4,3 a 5,7)',
          confidence: 0.98,
          warnings: [],
        },
        {
          fieldId: 'hemoglobina',
          originalName: 'Hemoglobina',
          value: '14,2',
          unit: 'g/dL',
          reference: '13,5 a 17,5',
          page: 1,
          originalText: 'Hemoglobina: 14,2 g/dL (Ref: 13,5 a 17,5)',
          confidence: 0.98,
          warnings: [],
        },
        {
          fieldId: 'hematocrito',
          originalName: 'Hematócrito',
          value: '42,5',
          unit: '%',
          reference: '39 a 50',
          page: 1,
          originalText: 'Hematócrito: 42,5 % (Ref: 39 a 50)',
          confidence: 0.97,
          warnings: [],
        },
        {
          fieldId: 'leucocitos',
          originalName: 'Leucócitos',
          value: '6.400',
          unit: '/µL',
          reference: '4.000 a 10.000',
          page: 1,
          originalText: 'Leucócitos: 6.400 /µL (Ref: 4.000 a 10.000)',
          confidence: 0.96,
          warnings: [],
        },
        {
          fieldId: 'plaquetas',
          originalName: 'Plaquetas',
          value: '240.000',
          unit: '/µL',
          reference: '150.000 a 450.000',
          page: 1,
          originalText: 'Plaquetas: 240.000 /µL (Ref: 150.000 a 450.000)',
          confidence: 0.96,
          warnings: [],
        },
      ],
    });
  }
  if (astDef) {
    exams.push({
      definitionId: astDef.id,
      originalName: astDef.name,
      collectedOn: today,
      laboratory: 'Laboratório Central (Demonstração)',
      method: 'Cinético UV',
      specimen: 'Soro',
      fields: [
        {
          fieldId: 'value',
          originalName: 'AST / TGO',
          value: '22',
          unit: 'U/L',
          reference: 'Até 35',
          page: 1,
          originalText: 'AST / TGO: 22 U/L (Ref: Até 35)',
          confidence: 0.95,
          warnings: [],
        },
      ],
    });
  }
  if (glicemiaDef) {
    exams.push({
      definitionId: glicemiaDef.id,
      originalName: glicemiaDef.name,
      collectedOn: today,
      laboratory: 'Laboratório Central (Demonstração)',
      method: 'Enzimático / Hexoquinase',
      specimen: 'Plasma fluoretado',
      fields: [
        {
          fieldId: 'value',
          originalName: 'Glicemia de jejum',
          value: '88',
          unit: 'mg/dL',
          reference: '70 a 99',
          page: 1,
          originalText: 'Glicemia: 88 mg/dL (Ref: 70 a 99)',
          confidence: 0.97,
          warnings: [],
        },
      ],
    });
  }
  return {
    warnings: [
      'Leitura simulada em modo de demonstração. Adicione GEMINI_API_KEY ou OPENAI_API_KEY no servidor para análise real por IA.',
    ],
    exams,
  };
}

function askProvider(
  provider: AiProviderId,
  options: Parameters<typeof askOpenAI>[0],
) {
  return provider === 'gemini' ? askGemini(options) : askOpenAI(options);
}

export const aiFiles = handle(async (request, { db, clinic, role }) => {
  if (!['owner', 'doctor'].includes(role))
    throw new HttpError(
      403,
      'Leitura por IA disponível somente à equipe médica.',
    );
  if (request.method === 'GET') return json({ models: availableExamModels() });
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
  const selectedAction = action as AiAction;
  const requestedModel = data.model;
  const selectedChoice =
    selectedAction === 'extract-exams' && typeof requestedModel === 'string'
      ? EXAM_MODELS[requestedModel as AiExamModelId]
      : undefined;
  if (
    selectedAction === 'extract-exams' &&
    requestedModel !== undefined &&
    !selectedChoice
  )
    throw new HttpError(422, 'Selecione um modelo de IA válido.');
  const provider = data.provider === undefined ? 'openai' : data.provider;
  if (
    !selectedChoice &&
    (typeof provider !== 'string' || !['openai', 'gemini'].includes(provider))
  )
    throw new HttpError(422, 'Selecione um provedor de IA válido.');
  const selectedProvider =
    selectedChoice?.provider || (provider as AiProviderId);
  if (!providerConfigured(selectedProvider))
    throw new HttpError(
      503,
      `${providerLabel(selectedProvider)} ainda não está configurado no servidor.`,
    );

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
  const { bytes: aiBytes, mime: aiMime } = await optimizeImageForAi(
    bytes,
    attachment.mime,
  );

  if (action === 'transcribe-document') {
    const model = providerModel(selectedProvider, selectedAction);
    const result = await askProvider(selectedProvider, {
      bytes: aiBytes,
      mime: aiMime,
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
          provider: providerLabel(selectedProvider),
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
  const model =
    selectedChoice?.model || providerModel(selectedProvider, selectedAction);

  if (selectedProvider === 'demo') {
    const demoResult = generateDemoExtraction(definitions);
    try {
      return json({
        proposal: normalizeExamExtraction(
          demoResult,
          {
            attachmentId,
            provider: providerLabel(selectedProvider),
            model,
            extractedAt,
          },
          definitions,
        ),
      });
    } catch (error) {
      throw new HttpError(422, (error as Error).message);
    }
  }

  const result = await askProvider(selectedProvider, {
    bytes: aiBytes,
    mime: aiMime,
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
        {
          attachmentId,
          provider: providerLabel(selectedProvider),
          model,
          extractedAt,
        },
        definitions,
      ),
    });
  } catch (error) {
    throw new HttpError(422, (error as Error).message);
  }
});
