import crypto from 'node:crypto';
import * as asn1js from 'asn1js';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  decodePDFRawStream,
} from 'pdf-lib';
import type {
  PadesPdfIntegrityResult,
  PdfIncrementalRevisionClassification,
  PdfRevisionPolicy,
  PdfSignatureRevisionSummary,
} from './types.ts';

interface EofBoundary {
  eofTokenOffset: number;
  endByte: number;
  startXrefOffset: number | null;
}

export const MAX_PDF_BYTES = 25 * 1024 * 1024; // 25 MiB
export const MAX_PDF_REVISIONS = 32;
export const MAX_TRAVERSAL_DEPTH = 48;
export const MAX_INDIRECT_OBJECTS = 10_000;
export const MAX_PAGE_COUNT = 500;
export const MAX_CONTENTS_HEX_LENGTH = 512 * 1024; // 512 KiB
export const MAX_DECODED_STREAM_BYTES = 10 * 1024 * 1024; // 10 MiB

interface ResolvedSigEntry {
  sigRef: PDFRef | null;
  sigDict: PDFDict;
  widgetRef: PDFRef | null;
  widgetDict: PDFDict | null;
  fieldName: string | null;
  type: 'Sig' | 'DocTimeStamp';
  filter: string | null;
  subFilter: string | null;
  byteRange: [number, number, number, number];
}

function sha256Hex(data: Uint8Array | Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function pdfNameToString(obj: PDFObject | undefined): string | null {
  if (!obj) return null;
  if (obj instanceof PDFName) {
    return obj.decodeText();
  }
  return null;
}

function pdfTextToString(obj: PDFObject | undefined): string | null {
  if (!obj) return null;
  if (obj instanceof PDFString || obj instanceof PDFHexString) {
    return obj.decodeText();
  }
  if (obj instanceof PDFName) {
    return obj.decodeText();
  }
  return null;
}

/**
 * Locates all `%%EOF` revision boundaries in the PDF buffer.
 */
function findAllEofBoundaries(pdfBuffer: Buffer): EofBoundary[] {
  const boundaries: EofBoundary[] = [];
  const token = Buffer.from('%%EOF', 'latin1');
  let searchFrom = 0;

  while (searchFrom < pdfBuffer.length) {
    const idx = pdfBuffer.indexOf(token, searchFrom);
    if (idx === -1) break;

    // Ensure %%EOF is preceded by start of line or whitespace
    const prevByte = idx > 0 ? pdfBuffer[idx - 1] : 0x0a;
    const isLineStart =
      prevByte === 0x0a ||
      prevByte === 0x0d ||
      prevByte === 0x20 ||
      prevByte === 0x09;

    let end = idx + token.length;
    if (end < pdfBuffer.length && pdfBuffer[end] === 0x0d) end += 1;
    if (end < pdfBuffer.length && pdfBuffer[end] === 0x0a) end += 1;

    const afterByte = end < pdfBuffer.length ? pdfBuffer[end] : -1;
    const isValidTokenEnd =
      afterByte === -1 ||
      prevByte === 0x0a ||
      prevByte === 0x0d ||
      isLineStart;

    if (isLineStart && isValidTokenEnd) {
      const lookbackStart = Math.max(0, idx - 128);
      const tailAscii = pdfBuffer.subarray(lookbackStart, idx).toString('latin1');
      const startXrefMatch = tailAscii.match(/startxref\s+(\d+)\s*$/);
      if (startXrefMatch) {
        boundaries.push({
          eofTokenOffset: idx,
          endByte: end,
          startXrefOffset: Number(startXrefMatch[1]),
        });
      }
    }

    searchFrom = idx + token.length;
  }

  return boundaries;
}

/**
 * Verifies that a parsed PDFDocument has a bounded object count, bounded nesting depth,
 * and an acyclic `/Pages` and `/AcroForm` tree before calling higher-level traversal helpers.
 */
function assertAcyclicAndBoundedStructure(doc: PDFDocument): string | null {
  const indirectObjects = doc.context.enumerateIndirectObjects();
  if (indirectObjects.length > MAX_INDIRECT_OBJECTS) {
    return `PDF excede o limite de objetos indiretos (${indirectObjects.length} > ${MAX_INDIRECT_OBJECTS}).`;
  }

  // 1. Check /Pages tree for cycles or excessive depth before doc.getPages() is ever invoked
  const pagesRootRaw = doc.catalog.get(PDFName.of('Pages'));
  if (!pagesRootRaw) {
    return 'Dicionário /Catalog não possui referência /Pages.';
  }
  const activePageRefs = new Set<string>();
  const visitedPageRefs = new Set<string>();
  let leafPageCount = 0;

  const checkPageNode = (
    nodeOrRef: PDFObject | undefined,
    depth: number,
  ): string | null => {
    if (!nodeOrRef) return null;
    if (depth > MAX_TRAVERSAL_DEPTH) {
      return `Árvore /Pages excede a profundidade máxima permitida (${MAX_TRAVERSAL_DEPTH}).`;
    }
    let refKey: string | null = null;
    if (nodeOrRef instanceof PDFRef) {
      refKey = `${nodeOrRef.objectNumber}:${nodeOrRef.generationNumber}`;
      if (activePageRefs.has(refKey)) {
        return `Referência circular detectada na árvore /Pages (${refKey}).`;
      }
      if (visitedPageRefs.has(refKey)) {
        return `Referência duplicada/ciclo detectado na árvore /Pages (${refKey}).`;
      }
      activePageRefs.add(refKey);
      visitedPageRefs.add(refKey);
    }

    const resolved = doc.context.lookup(nodeOrRef);
    if (!(resolved instanceof PDFDict)) {
      if (refKey) activePageRefs.delete(refKey);
      return 'Nó inválido encontrado na árvore /Pages.';
    }

    const typeName = pdfNameToString(
      doc.context.lookup(resolved.get(PDFName.of('Type'))),
    );
    if (typeName === 'Page') {
      leafPageCount += 1;
      if (leafPageCount > MAX_PAGE_COUNT) {
        if (refKey) activePageRefs.delete(refKey);
        return `Quantidade de páginas excede o limite permitido (${MAX_PAGE_COUNT}).`;
      }
    } else {
      const kidsRaw = resolved.get(PDFName.of('Kids'));
      const kids = doc.context.lookup(kidsRaw);
      if (kids instanceof PDFArray) {
        if (kids.size() > MAX_PAGE_COUNT) {
          if (refKey) activePageRefs.delete(refKey);
          return `Vetor /Kids em /Pages excede o limite permitido (${kids.size()}).`;
        }
        for (let i = 0; i < kids.size(); i += 1) {
          const err = checkPageNode(kids.get(i), depth + 1);
          if (err) {
            if (refKey) activePageRefs.delete(refKey);
            return err;
          }
        }
      }
    }

    if (refKey) activePageRefs.delete(refKey);
    return null;
  };

  const pageTreeErr = checkPageNode(pagesRootRaw, 0);
  if (pageTreeErr) return pageTreeErr;

  // 2. Check all indirect objects for excessive inline nesting or direct self-reference cycles
  const checkInlineDepth = (
    obj: PDFObject | undefined,
    depth: number,
    activeRefs: Set<string>,
  ): string | null => {
    if (!obj) return null;
    if (depth > MAX_TRAVERSAL_DEPTH) {
      return `Estrutura PDF excede a profundidade máxima de aninhamento (${MAX_TRAVERSAL_DEPTH}).`;
    }
    if (obj instanceof PDFRef) {
      const key = `${obj.objectNumber}:${obj.generationNumber}`;
      if (activeRefs.has(key)) {
        return `Referência circular indireta detectada no objeto ${key}.`;
      }
      return null;
    }
    if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i += 1) {
        const err = checkInlineDepth(obj.get(i), depth + 1, activeRefs);
        if (err) return err;
      }
      return null;
    }
    if (obj instanceof PDFDict) {
      for (const [k, val] of obj.entries()) {
        const keyStr = k.decodeText();
        if (keyStr === 'Parent' || keyStr === 'P') continue;
        const err = checkInlineDepth(val, depth + 1, activeRefs);
        if (err) return err;
      }
      return null;
    }
    if (obj instanceof PDFStream) {
      return checkInlineDepth(obj.dict, depth + 1, activeRefs);
    }
    return null;
  };

  for (const [ref, obj] of indirectObjects) {
    const refKey = `${ref.objectNumber}:${ref.generationNumber}`;
    const activeSet = new Set<string>([refKey]);
    const err = checkInlineDepth(obj, 0, activeSet);
    if (err) return err;
  }

  // 3. Check AcroForm /Fields -> /Kids for cycles
  const acroFormObj = doc.catalog.get(PDFName.of('AcroForm'));
  const acroForm = doc.context.lookup(acroFormObj);
  if (acroForm instanceof PDFDict) {
    const fieldsObj = doc.context.lookup(acroForm.get(PDFName.of('Fields')));
    if (fieldsObj instanceof PDFArray) {
      const activeFieldRefs = new Set<string>();
      const checkFieldNode = (
        rawItem: PDFObject | undefined,
        depth: number,
      ): string | null => {
        if (!rawItem) return null;
        if (depth > MAX_TRAVERSAL_DEPTH) {
          return `Hierarquia /AcroForm /Fields excede a profundidade máxima (${MAX_TRAVERSAL_DEPTH}).`;
        }
        let refKey: string | null = null;
        if (rawItem instanceof PDFRef) {
          refKey = `${rawItem.objectNumber}:${rawItem.generationNumber}`;
          if (activeFieldRefs.has(refKey)) {
            return `Referência circular detectada em /AcroForm /Fields (${refKey}).`;
          }
          activeFieldRefs.add(refKey);
        }
        const dict = doc.context.lookup(rawItem);
        if (dict instanceof PDFDict) {
          const kids = doc.context.lookup(dict.get(PDFName.of('Kids')));
          if (kids instanceof PDFArray) {
            for (let i = 0; i < kids.size(); i += 1) {
              const err = checkFieldNode(kids.get(i), depth + 1);
              if (err) {
                if (refKey) activeFieldRefs.delete(refKey);
                return err;
              }
            }
          }
        }
        if (refKey) activeFieldRefs.delete(refKey);
        return null;
      };
      for (let i = 0; i < fieldsObj.size(); i += 1) {
        const err = checkFieldNode(fieldsObj.get(i), 0);
        if (err) return err;
      }
    }
  }

  return null;
}

/**
 * Collects all AcroForm terminal fields recursively via `/Fields` and `/Kids`.
 */
function collectAcroFormFields(
  doc: PDFDocument,
): Array<{ ref: PDFRef | null; dict: PDFDict }> {
  const result: Array<{ ref: PDFRef | null; dict: PDFDict }> = [];
  const visited = new Set<string>();

  const acroFormObj = doc.catalog.get(PDFName.of('AcroForm'));
  const acroForm = doc.context.lookup(acroFormObj);
  if (!(acroForm instanceof PDFDict)) return result;

  const fieldsObj = doc.context.lookup(acroForm.get(PDFName.of('Fields')));
  if (!(fieldsObj instanceof PDFArray)) return result;

  const visitField = (rawItem: PDFObject | undefined, depth: number) => {
    if (!rawItem || depth > MAX_TRAVERSAL_DEPTH) return;
    let ref: PDFRef | null = null;
    if (rawItem instanceof PDFRef) {
      const key = `${rawItem.objectNumber}:${rawItem.generationNumber}`;
      if (visited.has(key)) return;
      visited.add(key);
      ref = rawItem;
    }
    const dict = doc.context.lookup(rawItem);
    if (!(dict instanceof PDFDict)) return;

    const kids = doc.context.lookup(dict.get(PDFName.of('Kids')));
    const hasFT = dict.has(PDFName.of('FT')) || dict.has(PDFName.of('V'));
    if (hasFT || !(kids instanceof PDFArray)) {
      result.push({ ref, dict });
    }
    if (kids instanceof PDFArray) {
      for (let i = 0; i < kids.size(); i += 1) {
        visitField(kids.get(i), depth + 1);
      }
    }
  };

  for (let i = 0; i < fieldsObj.size(); i += 1) {
    visitField(fieldsObj.get(i), 0);
  }

  return result;
}

function parseByteRangeArray(
  doc: PDFDocument,
  brObj: PDFObject | undefined,
): [number, number, number, number] | null {
  const resolved = doc.context.lookup(brObj);
  if (!(resolved instanceof PDFArray) || resolved.size() !== 4) return null;
  const nums: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const item = doc.context.lookup(resolved.get(i));
    if (!(item instanceof PDFNumber)) return null;
    const val = item.asNumber();
    if (!Number.isSafeInteger(val) || val < 0) return null;
    nums.push(val);
  }
  return [nums[0], nums[1], nums[2], nums[3]];
}

/**
 * Resolves all signature dictionaries referenced via AcroForm `/Fields` in `doc`
 * and checks for any unreferenced/orphan `/Type /Sig`, `/Type /DocTimeStamp`, or `/ByteRange` objects.
 */
function resolveDocumentSignatures(doc: PDFDocument): {
  signatures: ResolvedSigEntry[];
  orphanError?: string;
} {
  const fields = collectAcroFormFields(doc);
  const signatures: ResolvedSigEntry[] = [];
  const referencedSigObjNums = new Set<number>();

  for (const field of fields) {
    const ftName = pdfNameToString(
      doc.context.lookup(field.dict.get(PDFName.of('FT'))),
    );
    const rawV = field.dict.get(PDFName.of('V'));
    if (ftName !== 'Sig' && !rawV) continue;

    if (!rawV) continue;
    const sigRef = rawV instanceof PDFRef ? rawV : null;
    const sigDict = doc.context.lookup(rawV);
    if (!(sigDict instanceof PDFDict)) {
      return {
        signatures: [],
        orphanError: 'Campo de assinatura /FT /Sig aponta para /V inválido.',
      };
    }

    const typeName = pdfNameToString(
      doc.context.lookup(sigDict.get(PDFName.of('Type'))),
    );
    const subFilter = pdfNameToString(
      doc.context.lookup(sigDict.get(PDFName.of('SubFilter'))),
    );
    const filter = pdfNameToString(
      doc.context.lookup(sigDict.get(PDFName.of('Filter'))),
    );
    const fieldName = pdfTextToString(
      doc.context.lookup(field.dict.get(PDFName.of('T'))),
    );

    const byteRange = parseByteRangeArray(
      doc,
      sigDict.get(PDFName.of('ByteRange')),
    );
    if (!byteRange) {
      return {
        signatures: [],
        orphanError:
          'Dicionário de assinatura não possui /ByteRange estruturalmente válido de 4 inteiros.',
      };
    }

    const isDocTimeStamp =
      typeName === 'DocTimeStamp' || subFilter === 'ETSI.RFC3161';

    if (sigRef) {
      referencedSigObjNums.add(sigRef.objectNumber);
    }

    signatures.push({
      sigRef,
      sigDict,
      widgetRef: field.ref,
      widgetDict: field.dict,
      fieldName,
      type: isDocTimeStamp ? 'DocTimeStamp' : 'Sig',
      filter,
      subFilter,
      byteRange,
    });
  }

  // Verify no orphan /Type /Sig, /Type /DocTimeStamp, or /ByteRange exists in indirect objects
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    const dict =
      obj instanceof PDFDict
        ? obj
        : obj instanceof PDFStream
          ? obj.dict
          : null;
    if (!dict) continue;
    const typeName = pdfNameToString(
      doc.context.lookup(dict.get(PDFName.of('Type'))),
    );
    const hasByteRange = dict.has(PDFName.of('ByteRange'));
    if (
      typeName === 'Sig' ||
      typeName === 'DocTimeStamp' ||
      hasByteRange
    ) {
      if (!referencedSigObjNums.has(ref.objectNumber)) {
        return {
          signatures: [],
          orphanError: `Objeto de assinatura órfão ou não referenciado pelo AcroForm detectado (${ref.objectNumber} ${ref.generationNumber} R).`,
        };
      }
    }
  }

  // Sort signatures by revision end byte (b2 + b3)
  signatures.sort(
    (a, b) =>
      a.byteRange[2] + a.byteRange[3] - (b.byteRange[2] + b.byteRange[3]),
  );

  return { signatures };
}

/**
 * Decodes all content streams of a PDFPageLeaf and returns their combined hash and object refs.
 */
function inspectPageContentStreams(
  doc: PDFDocument,
  pageDict: PDFDict,
): {
  streamRefs: string[];
  decodedHash: string;
  rawHash: string;
  oversizedError?: string;
} {
  const rawContents = pageDict.get(PDFName.of('Contents'));
  if (!rawContents) {
    return { streamRefs: [], decodedHash: sha256Hex(''), rawHash: sha256Hex('') };
  }

  const streamRefs: string[] = [];
  const decodedChunks: Buffer[] = [];
  const rawChunks: Buffer[] = [];
  let totalDecodedBytes = 0;
  let oversizedError: string | undefined;

  const processStreamObj = (objOrRef: PDFObject | undefined) => {
    if (!objOrRef || oversizedError) return;
    if (objOrRef instanceof PDFRef) {
      streamRefs.push(`${objOrRef.objectNumber}:${objOrRef.generationNumber}`);
    }
    const resolved = doc.context.lookup(objOrRef);
    if (resolved instanceof PDFRawStream) {
      const rawBytes = resolved.getContents();
      if (rawBytes.byteLength > MAX_DECODED_STREAM_BYTES) {
        oversizedError = `Stream /Contents excede o tamanho máximo permitido (${rawBytes.byteLength} bytes).`;
        return;
      }
      rawChunks.push(Buffer.from(rawBytes));
      try {
        const decoded = decodePDFRawStream(resolved).decode();
        totalDecodedBytes += decoded.byteLength;
        if (totalDecodedBytes > MAX_DECODED_STREAM_BYTES) {
          oversizedError = `Stream /Contents descompactado excede o limite de segurança (${totalDecodedBytes} bytes).`;
          return;
        }
        decodedChunks.push(Buffer.from(decoded));
      } catch {
        decodedChunks.push(Buffer.from(rawBytes));
      }
    } else if (resolved instanceof PDFStream) {
      const bytes = resolved.getContents();
      totalDecodedBytes += bytes.byteLength;
      if (totalDecodedBytes > MAX_DECODED_STREAM_BYTES) {
        oversizedError = `Stream /Contents excede o limite de segurança (${totalDecodedBytes} bytes).`;
        return;
      }
      rawChunks.push(Buffer.from(bytes));
      decodedChunks.push(Buffer.from(bytes));
    }
  };

  if (rawContents instanceof PDFRef) {
    const lookedUp = doc.context.lookup(rawContents);
    if (lookedUp instanceof PDFArray) {
      for (let i = 0; i < lookedUp.size(); i += 1) {
        processStreamObj(lookedUp.get(i));
      }
    } else {
      processStreamObj(rawContents);
    }
  } else if (rawContents instanceof PDFArray) {
    for (let i = 0; i < rawContents.size(); i += 1) {
      processStreamObj(rawContents.get(i));
    }
  } else {
    processStreamObj(rawContents);
  }

  if (oversizedError) {
    return {
      streamRefs,
      decodedHash: '',
      rawHash: '',
      oversizedError,
    };
  }

  return {
    streamRefs,
    decodedHash: sha256Hex(Buffer.concat(decodedChunks)),
    rawHash: sha256Hex(Buffer.concat(rawChunks)),
  };
}

/**
 * Collects all indirect object numbers reachable from a root PDFObject with bounded depth.
 */
function collectReachableObjectNumbers(
  doc: PDFDocument,
  rootObj: PDFObject | undefined,
  stopAtObjNums?: Set<number>,
): Set<number> {
  const visited = new Set<number>();
  const walk = (obj: PDFObject | undefined, depth: number) => {
    if (!obj || depth > MAX_TRAVERSAL_DEPTH) return;
    if (obj instanceof PDFRef) {
      if (visited.has(obj.objectNumber)) return;
      if (stopAtObjNums?.has(obj.objectNumber)) return;
      visited.add(obj.objectNumber);
      const target = doc.context.lookup(obj);
      walk(target, depth + 1);
      return;
    }
    if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i += 1) {
        walk(obj.get(i), depth + 1);
      }
      return;
    }
    if (obj instanceof PDFDict) {
      for (const [, val] of obj.entries()) {
        walk(val, depth + 1);
      }
      return;
    }
    if (obj instanceof PDFStream) {
      walk(obj.dict, depth + 1);
    }
  };
  walk(rootObj, 0);
  return visited;
}

/**
 * Computes a structural fingerprint of an indirect PDFObject (dict/array/stream)
 * so that two parsed PDFDocument revisions can be diffed structurally at the object-table level.
 */
function fingerprintPdfObject(obj: PDFObject): string {
  if (obj instanceof PDFRawStream) {
    return `RawStream:${obj.dict.toString()}:${sha256Hex(Buffer.from(obj.getContents()))}`;
  }
  if (obj instanceof PDFStream) {
    return `Stream:${obj.dict.toString()}:${sha256Hex(Buffer.from(obj.getContents()))}`;
  }
  return obj.toString();
}

/**
 * Structurally diffs all indirect objects between `prevDoc` and `currDoc`,
 * returning object numbers that were added, modified, or removed in `currDoc`.
 */
function diffIndirectObjectsStructurally(
  prevDoc: PDFDocument,
  currDoc: PDFDocument,
): number[] {
  const prevMap = new Map<number, string>();
  for (const [ref, obj] of prevDoc.context.enumerateIndirectObjects()) {
    prevMap.set(
      ref.objectNumber,
      `${ref.generationNumber}:${fingerprintPdfObject(obj)}`,
    );
  }
  const changed = new Set<number>();
  const currSeen = new Set<number>();
  for (const [ref, obj] of currDoc.context.enumerateIndirectObjects()) {
    currSeen.add(ref.objectNumber);
    const currFp = `${ref.generationNumber}:${fingerprintPdfObject(obj)}`;
    const prevFp = prevMap.get(ref.objectNumber);
    if (prevFp !== currFp) {
      changed.add(ref.objectNumber);
    }
  }
  for (const objNum of prevMap.keys()) {
    if (!currSeen.has(objNum)) {
      changed.add(objNum);
    }
  }
  return [...changed].sort((a, b) => a - b);
}

/**
 * Parses indirect object numbers defined in a raw incremental revision slice.
 */
function extractModifiedObjectNumbersFromSlice(
  deltaBytes: Buffer,
): { objectNumbers: number[]; hasValidStructure: boolean } {
  const str = deltaBytes.toString('latin1');
  const objMatches = [...str.matchAll(/(?:^|[\r\n])\s*(\d+)\s+(\d+)\s+obj\b/g)];
  const objectNumbers = objMatches.map((m) => Number(m[1]));
  const hasStartXref = /startxref\s+\d+\s*%%EOF\s*$/.test(str);
  return {
    objectNumbers,
    hasValidStructure: hasStartXref && objectNumbers.length > 0,
  };
}

/**
 * Compares two consecutive parsed PDFDocument revisions (`prevDoc` -> `currDoc`)
 * to determine if the incremental update is a legitimate PAdES LTV / co-signature update
 * or an unauthorized post-signature modification.
 */
function classifyPostSignatureRevision(params: {
  prevDoc: PDFDocument;
  currDoc: PDFDocument;
  revisionIndex: number;
  startByte: number;
  endByte: number;
  eofOffset: number;
  deltaBytes: Buffer;
  signatureAtThisRevision?: ResolvedSigEntry;
}): PdfIncrementalRevisionClassification {
  const {
    prevDoc,
    currDoc,
    revisionIndex,
    startByte,
    endByte,
    eofOffset,
    deltaBytes,
    signatureAtThisRevision,
  } = params;

  const { objectNumbers: sliceObjectNumbers, hasValidStructure } =
    extractModifiedObjectNumbersFromSlice(deltaBytes);
  const structuralDiffObjectNumbers = diffIndirectObjectsStructurally(
    prevDoc,
    currDoc,
  );
  const modifiedSet = new Set([
    ...sliceObjectNumbers,
    ...structuralDiffObjectNumbers,
  ]);
  const modifiedObjectNumbers = [...modifiedSet].sort((a, b) => a - b);

  const reject = (reason: string): PdfIncrementalRevisionClassification => ({
    revisionIndex,
    startByte,
    endByte,
    eofOffset,
    kind: 'UNAUTHORIZED_POST_SIGNATURE_MODIFICATION',
    coveredByFinalSignature: false,
    modifiedObjectNumbers,
    reason,
  });

  if (!hasValidStructure && structuralDiffObjectNumbers.length === 0) {
    return reject(
      'Bytes adicionados após a assinatura não formam uma revisão incremental PDF válida.',
    );
  }

  // 1. Check page count and page object references
  const prevPages = prevDoc.getPages();
  const currPages = currDoc.getPages();
  if (prevPages.length !== currPages.length) {
    return reject(
      `Quantidade de páginas alterada após a assinatura (${prevPages.length} -> ${currPages.length}).`,
    );
  }

  const allowedNewWidgetObjNum =
    signatureAtThisRevision?.widgetRef?.objectNumber ?? null;

  for (let i = 0; i < prevPages.length; i += 1) {
    const prevPage = prevPages[i];
    const currPage = currPages[i];
    if (
      prevPage.ref.objectNumber !== currPage.ref.objectNumber ||
      prevPage.ref.generationNumber !== currPage.ref.generationNumber
    ) {
      return reject(`Referência da página ${i + 1} substituída após a assinatura.`);
    }

    // Check page geometry and dangerous keys
    const geometryKeys = [
      'MediaBox',
      'CropBox',
      'BleedBox',
      'TrimBox',
      'ArtBox',
      'Rotate',
      'AA',
      'PieceInfo',
      'UserUnit',
    ];
    for (const key of geometryKeys) {
      const k = PDFName.of(key);
      const prevVal = prevPage.node.lookup(k)?.toString() ?? null;
      const currVal = currPage.node.lookup(k)?.toString() ?? null;
      if (prevVal !== currVal) {
        return reject(
          `Atributo estrutural /${key} da página ${i + 1} modificado após a assinatura.`,
        );
      }
    }

    // Check page /Contents streams (refs, raw bytes, and decoded bytes)
    const prevContentInfo = inspectPageContentStreams(prevDoc, prevPage.node);
    const currContentInfo = inspectPageContentStreams(currDoc, currPage.node);
    if (prevContentInfo.oversizedError || currContentInfo.oversizedError) {
      return reject(
        prevContentInfo.oversizedError ||
          currContentInfo.oversizedError ||
          'Fluxo de conteúdo (/Contents) excede o tamanho máximo permitido.',
      );
    }
    if (
      prevContentInfo.decodedHash !== currContentInfo.decodedHash ||
      prevContentInfo.rawHash !== currContentInfo.rawHash ||
      prevContentInfo.streamRefs.join(',') !==
        currContentInfo.streamRefs.join(',')
    ) {
      return reject(
        `Fluxo de conteúdo (/Contents) da página ${i + 1} foi modificado após a assinatura.`,
      );
    }

    // Ensure no existing content stream object or resource object was redefined
    const prevContentReachable = collectReachableObjectNumbers(
      prevDoc,
      prevPage.node.get(PDFName.of('Contents')),
    );
    for (const objNum of prevContentReachable) {
      if (modifiedSet.has(objNum)) {
        return reject(
          `Objeto de fluxo de conteúdo (${objNum} 0 R) da página ${i + 1} redefinido após a assinatura.`,
        );
      }
    }

    const prevResObj = prevPage.node.get(PDFName.of('Resources'));
    const currResObj = currPage.node.get(PDFName.of('Resources'));
    if ((prevResObj?.toString() ?? '') !== (currResObj?.toString() ?? '')) {
      return reject(
        `Dicionário /Resources da página ${i + 1} foi alterado após a assinatura.`,
      );
    }
    const prevResReachable = collectReachableObjectNumbers(prevDoc, prevResObj);
    for (const objNum of prevResReachable) {
      if (modifiedSet.has(objNum)) {
        return reject(
          `Objeto de recurso (${objNum} 0 R) da página ${i + 1} foi redefinido após a assinatura.`,
        );
      }
    }

    // Check /Annots on page
    const prevAnnotsRaw = prevDoc.context.lookup(
      prevPage.node.get(PDFName.of('Annots')),
    );
    const currAnnotsRaw = currDoc.context.lookup(
      currPage.node.get(PDFName.of('Annots')),
    );
    const prevAnnotList: PDFObject[] =
      prevAnnotsRaw instanceof PDFArray
        ? Array.from({ length: prevAnnotsRaw.size() }, (_, idx) =>
            prevAnnotsRaw.get(idx),
          )
        : [];
    const currAnnotList: PDFObject[] =
      currAnnotsRaw instanceof PDFArray
        ? Array.from({ length: currAnnotsRaw.size() }, (_, idx) =>
            currAnnotsRaw.get(idx),
          )
        : [];

    if (currAnnotList.length < prevAnnotList.length) {
      return reject(
        `Anotações existentes foram removidas da página ${i + 1} após a assinatura.`,
      );
    }

    for (let aIdx = 0; aIdx < prevAnnotList.length; aIdx += 1) {
      const pRef = prevAnnotList[aIdx];
      const cRef = currAnnotList[aIdx];
      if (pRef.toString() !== cRef.toString()) {
        return reject(
          `Anotação existente na página ${i + 1} foi substituída ou reordenada após a assinatura.`,
        );
      }
      if (pRef instanceof PDFRef && modifiedSet.has(pRef.objectNumber)) {
        return reject(
          `Anotação existente (${pRef.objectNumber} 0 R) na página ${i + 1} foi modificada após a assinatura.`,
        );
      }
    }

    // Check any newly added annotations on this page
    const addedAnnots = currAnnotList.slice(prevAnnotList.length);
    for (const added of addedAnnots) {
      if (
        !signatureAtThisRevision ||
        !(added instanceof PDFRef) ||
        added.objectNumber !== allowedNewWidgetObjNum
      ) {
        return reject(
          `Anotação não autorizada (${added.toString()}) adicionada à página ${i + 1} após a assinatura.`,
        );
      }
    }
  }

  // 2. Check Catalog modifications
  const forbiddenCatalogKeys = [
    'Pages',
    'OpenAction',
    'AA',
    'Names',
    'Outlines',
    'Threads',
    'URI',
    'OCProperties',
  ];
  for (const key of forbiddenCatalogKeys) {
    const k = PDFName.of(key);
    const prevVal = prevDoc.catalog.get(k)?.toString() ?? null;
    const currVal = currDoc.catalog.get(k)?.toString() ?? null;
    if (prevVal !== currVal) {
      return reject(
        `Chave sensível /${key} do /Catalog foi alterada após a assinatura.`,
      );
    }
  }

  // 3. Verify that all previous AcroForm fields (including previous signatures) remain intact
  const prevFields = collectAcroFormFields(prevDoc);
  const currFields = collectAcroFormFields(currDoc);
  for (const prevField of prevFields) {
    const prevName = pdfTextToString(
      prevDoc.context.lookup(prevField.dict.get(PDFName.of('T'))),
    );
    const prevV = prevField.dict.get(PDFName.of('V'))?.toString() ?? null;
    const match = currFields.find((cf) => {
      if (prevField.ref && cf.ref) {
        return (
          prevField.ref.objectNumber === cf.ref.objectNumber &&
          prevField.ref.generationNumber === cf.ref.generationNumber
        );
      }
      const cfName = pdfTextToString(
        currDoc.context.lookup(cf.dict.get(PDFName.of('T'))),
      );
      return cfName === prevName;
    });
    if (!match) {
      return reject(
        `Campo AcroForm pré-existente (${prevName ?? 'sem nome'}) foi removido após a assinatura.`,
      );
    }
    const currV = match.dict.get(PDFName.of('V'))?.toString() ?? null;
    if (prevV && prevV !== currV) {
      return reject(
        `Valor /V de campo AcroForm pré-existente (${prevName ?? 'sem nome'}) foi alterado após a assinatura.`,
      );
    }
    if (prevField.ref && modifiedSet.has(prevField.ref.objectNumber)) {
      return reject(
        `Campo AcroForm pré-existente (${prevField.ref.objectNumber} 0 R) foi redefinido após a assinatura.`,
      );
    }
  }

  // 4. Classify into SUBSEQUENT_SIGNATURE_REVISION, PADES_DOC_TIMESTAMP_REVISION, or PADES_LTV_DSS_REVISION
  if (signatureAtThisRevision) {
    // Verify no extra non-signature fields were added
    if (currFields.length > prevFields.length + 1) {
      return reject(
        'Múltiplos campos AcroForm adicionados em uma única revisão de assinatura pós-assinatura.',
      );
    }
    return {
      revisionIndex,
      startByte,
      endByte,
      eofOffset,
      kind:
        signatureAtThisRevision.type === 'DocTimeStamp'
          ? 'PADES_DOC_TIMESTAMP_REVISION'
          : 'SUBSEQUENT_SIGNATURE_REVISION',
      coveredByFinalSignature: true,
      modifiedObjectNumbers,
    };
  }

  // Must be a pure DSS LTV revision
  const currDssRaw = currDoc.catalog.get(PDFName.of('DSS'));
  const currDss = currDoc.context.lookup(currDssRaw);
  if (!(currDss instanceof PDFDict)) {
    return reject(
      'Revisão incremental posterior à assinatura não contém assinatura nem dicionário /DSS válido.',
    );
  }

  // Check allowed keys in /DSS
  const allowedDssKeys = new Set(['Type', 'Certs', 'OCSPs', 'CRLs', 'VRI']);
  for (const [k] of currDss.entries()) {
    const keyName = k.decodeText();
    if (!allowedDssKeys.has(keyName)) {
      return reject(`Chave não permitida /${keyName} encontrada no dicionário /DSS.`);
    }
  }

  // Check that every modified object in this revision is either the Catalog or reachable from /DSS
  const rootRef = currDoc.context.trailerInfo.Root;
  const rootObjNum = rootRef instanceof PDFRef ? rootRef.objectNumber : -1;
  const dssReachable = collectReachableObjectNumbers(currDoc, currDssRaw);
  for (const modObjNum of modifiedObjectNumbers) {
    if (modObjNum !== rootObjNum && !dssReachable.has(modObjNum)) {
      return reject(
        `Objeto ${modObjNum} 0 R modificado em revisão LTV não pertence ao /Catalog nem à subárvore /DSS.`,
      );
    }
  }

  return {
    revisionIndex,
    startByte,
    endByte,
    eofOffset,
    kind: 'PADES_LTV_DSS_REVISION',
    coveredByFinalSignature: false,
    modifiedObjectNumbers,
  };
}

/**
 * Performs comprehensive structural verification of a PAdES PDF buffer:
 * - Resolves indirect objects, /Catalog, /Pages, /Page, /Contents, /Annots, /AcroForm, /DSS, /Sig.
 * - Verifies ByteRange boundaries and decoded /Contents zero-padding (Adjustment 5).
 * - Classifies all incremental revisions (pre-signature, signature, subsequent signature, LTV DSS/DocTimeStamp, or unauthorized tampering).
 */
export async function validatePadesPdfStructure(
  pdfBuffer: Buffer,
  policy: PdfRevisionPolicy = 'PADES_LTV_ALLOWED',
): Promise<PadesPdfIntegrityResult> {
  const makeInvalid = (
    error: string,
    partial?: Partial<PadesPdfIntegrityResult>,
  ): PadesPdfIntegrityResult => ({
    valid: false,
    policy,
    byteRange: null,
    coversWholeDocument: false,
    unsignedTrailingBytes: 0,
    contentsHexValid: false,
    contentsPaddingValid: false,
    totalRevisionsCount: 0,
    preSignatureRevisionsCount: 0,
    signatureRevisionsCount: 0,
    postSignatureLtvRevisionsCount: 0,
    hasUnauthorizedPostSignatureUpdate: false,
    revisions: [],
    signatures: [],
    ...partial,
    error,
  });

  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length < 64) {
    return makeInvalid('Buffer PDF vazio ou curto demais.');
  }

  if (pdfBuffer.length > MAX_PDF_BYTES) {
    return makeInvalid(
      `Arquivo PDF (${pdfBuffer.length} bytes) excede o limite máximo de segurança (${MAX_PDF_BYTES} bytes).`,
    );
  }

  const headerStr = pdfBuffer.subarray(0, 8).toString('latin1');
  if (!headerStr.startsWith('%PDF-1.') && !headerStr.startsWith('%PDF-2.')) {
    return makeInvalid('Cabeçalho %PDF- inválido ou ausente no início do arquivo.');
  }

  const eofBoundaries = findAllEofBoundaries(pdfBuffer);
  if (eofBoundaries.length === 0) {
    return makeInvalid('Marcador de fim de arquivo (startxref / %%EOF) ausente ou PDF truncado.');
  }

  if (eofBoundaries.length > MAX_PDF_REVISIONS) {
    return makeInvalid(
      `PDF possui ${eofBoundaries.length} revisões incrementais, excedendo o limite de segurança (${MAX_PDF_REVISIONS}).`,
      { totalRevisionsCount: eofBoundaries.length },
    );
  }

  const lastBoundary = eofBoundaries[eofBoundaries.length - 1];
  const trailingAfterLastEof = pdfBuffer.length - lastBoundary.endByte;
  if (trailingAfterLastEof > 0) {
    return makeInvalid(
      `Existem ${trailingAfterLastEof} bytes soltos após o último %%EOF do PDF.`,
      {
        unsignedTrailingBytes: trailingAfterLastEof,
        totalRevisionsCount: eofBoundaries.length,
      },
    );
  }

  // Parse each revision slice [0, endByte] structurally with PDFDocument.load
  const revisionDocs: PDFDocument[] = [];
  for (let r = 0; r < eofBoundaries.length; r += 1) {
    const boundary = eofBoundaries[r];
    const slice = pdfBuffer.subarray(0, boundary.endByte);
    try {
      const doc = await PDFDocument.load(slice, {
        updateMetadata: false,
        ignoreEncryption: false,
      });
      if (doc.isEncrypted) {
        return makeInvalid('PDF criptografado não é aceito para verificação PAdES.');
      }
      const structureErr = assertAcyclicAndBoundedStructure(doc);
      if (structureErr) {
        return makeInvalid(
          `Estrutura malformada na revisão PDF #${r + 1}: ${structureErr}`,
          { totalRevisionsCount: eofBoundaries.length },
        );
      }
      revisionDocs.push(doc);
    } catch (err) {
      return makeInvalid(
        `Falha ao analisar estruturalmente a revisão PDF #${r + 1} (offset 0..${boundary.endByte}): ${
          err instanceof Error ? err.message : String(err)
        }`,
        { totalRevisionsCount: eofBoundaries.length },
      );
    }
  }

  const finalDoc = revisionDocs[revisionDocs.length - 1];
  const { signatures: resolvedSigs, orphanError } =
    resolveDocumentSignatures(finalDoc);
  if (orphanError) {
    return makeInvalid(orphanError, {
      totalRevisionsCount: eofBoundaries.length,
    });
  }

  if (resolvedSigs.length === 0) {
    return makeInvalid(
      'Nenhum dicionário de assinatura /Type /Sig estruturalmente referenciado pelo /AcroForm foi encontrado.',
      { totalRevisionsCount: eofBoundaries.length },
    );
  }

  // Verify raw /ByteRange occurrences match the number of resolved signature dictionaries
  const rawPdfStr = pdfBuffer.toString('latin1');
  const rawByteRangeMatches = [...rawPdfStr.matchAll(/\/ByteRange\s*\[/g)];
  if (rawByteRangeMatches.length !== resolvedSigs.length) {
    return makeInvalid(
      `Quantidade de marcadores /ByteRange no arquivo (${rawByteRangeMatches.length}) diverge dos dicionários de assinatura referenciados (${resolvedSigs.length}).`,
      { totalRevisionsCount: eofBoundaries.length },
    );
  }

  const sigSummaries: PdfSignatureRevisionSummary[] = [];
  const revIndexToSig = new Map<number, ResolvedSigEntry>();

  for (let sIdx = 0; sIdx < resolvedSigs.length; sIdx += 1) {
    const entry = resolvedSigs[sIdx];
    const [b0, b1, b2, b3] = entry.byteRange;
    const revEndByte = b2 + b3;

    // 1. Validate ByteRange bounds
    if (
      b0 !== 0 ||
      b1 <= 0 ||
      b2 <= b1 + 2 ||
      b3 <= 0 ||
      revEndByte > pdfBuffer.length
    ) {
      const errMsg =
        b0 !== 0
          ? `ByteRange da assinatura #${sIdx + 1} não inicia no byte 0 (inicia em ${b0}).`
          : revEndByte > pdfBuffer.length
            ? `PDF truncado: ByteRange da assinatura #${sIdx + 1} exige ${revEndByte} bytes, mas o arquivo possui ${pdfBuffer.length}.`
            : `ByteRange da assinatura #${sIdx + 1} possui limites inválidos [${b0}, ${b1}, ${b2}, ${b3}].`;
      sigSummaries.push({
        signatureIndex: sIdx,
        fieldName: entry.fieldName,
        filter: entry.filter,
        subFilter: entry.subFilter,
        type: entry.type,
        byteRange: entry.byteRange,
        revisionEndByte: revEndByte,
        valid: false,
        contentsHexValid: false,
        contentsPaddingValid: false,
        coversUntilRevisionEof: false,
        error: errMsg,
      });
      return makeInvalid(errMsg, {
        byteRange: entry.byteRange,
        totalRevisionsCount: eofBoundaries.length,
        signatures: sigSummaries,
      });
    }

    // 2. Verify that [b2, b2 + b3) ends at a valid %%EOF revision boundary
    // (allowing optional trailing \r/\n between %%EOF and the next revision)
    // and contains no internal %%EOF before revEndByte
    const matchedRevIndex = eofBoundaries.findIndex(
      (b) => revEndByte >= b.eofTokenOffset + 5 && revEndByte <= b.endByte,
    );
    const targetRevIndex =
      matchedRevIndex !== -1 ? matchedRevIndex : undefined;
    const hasInternalEofInSecondRange = eofBoundaries.some(
      (b, idx) =>
        idx !== targetRevIndex &&
        b.eofTokenOffset >= b2 &&
        b.eofTokenOffset + 5 < revEndByte,
    );
    if (targetRevIndex === undefined || hasInternalEofInSecondRange) {
      const errMsg = hasInternalEofInSecondRange
        ? `Assinatura #${sIdx + 1} contém múltiplas revisões %%EOF embutidas dentro do segundo trecho do ByteRange [${b2}, ${revEndByte}).`
        : `O fim do ByteRange (${revEndByte}) da assinatura #${sIdx + 1} não coincide com o fechamento %%EOF de uma revisão válida.`;
      sigSummaries.push({
        signatureIndex: sIdx,
        fieldName: entry.fieldName,
        filter: entry.filter,
        subFilter: entry.subFilter,
        type: entry.type,
        byteRange: entry.byteRange,
        revisionEndByte: revEndByte,
        valid: false,
        contentsHexValid: false,
        contentsPaddingValid: false,
        coversUntilRevisionEof: false,
        error: errMsg,
      });
      return makeInvalid(errMsg, {
        byteRange: entry.byteRange,
        totalRevisionsCount: eofBoundaries.length,
        signatures: sigSummaries,
      });
    }

    // Normalize the boundary's endByte to match the exact signed revision end
    eofBoundaries[targetRevIndex].endByte = revEndByte;

    if (revIndexToSig.has(targetRevIndex)) {
      return makeInvalid(
        `Duas assinaturas distintas encerram na mesma revisão PDF #${targetRevIndex + 1}.`,
        {
          byteRange: entry.byteRange,
          totalRevisionsCount: eofBoundaries.length,
        },
      );
    }
    revIndexToSig.set(targetRevIndex, entry);

    // 3. Verify <hex> delimiters at [b1, b2)
    if (pdfBuffer[b1] !== 0x3c || pdfBuffer[b2 - 1] !== 0x3e) {
      const errMsg = `Lacuna /Contents da assinatura #${sIdx + 1} não é delimitada exatamente por '<' em ${b1} e '>' em ${b2 - 1}.`;
      sigSummaries.push({
        signatureIndex: sIdx,
        fieldName: entry.fieldName,
        filter: entry.filter,
        subFilter: entry.subFilter,
        type: entry.type,
        byteRange: entry.byteRange,
        revisionEndByte: revEndByte,
        valid: false,
        contentsHexValid: false,
        contentsPaddingValid: false,
        coversUntilRevisionEof: true,
        error: errMsg,
      });
      return makeInvalid(errMsg, {
        byteRange: entry.byteRange,
        contentsHexValid: false,
        totalRevisionsCount: eofBoundaries.length,
        signatures: sigSummaries,
      });
    }

    const hexByteLen = b2 - 1 - (b1 + 1);
    if (hexByteLen <= 0 || hexByteLen > MAX_CONTENTS_HEX_LENGTH) {
      const errMsg = `Tamanho de /Contents da assinatura #${sIdx + 1} (${hexByteLen} bytes hex) excede o limite de segurança (${MAX_CONTENTS_HEX_LENGTH}).`;
      sigSummaries.push({
        signatureIndex: sIdx,
        fieldName: entry.fieldName,
        filter: entry.filter,
        subFilter: entry.subFilter,
        type: entry.type,
        byteRange: entry.byteRange,
        revisionEndByte: revEndByte,
        valid: false,
        contentsHexValid: false,
        contentsPaddingValid: false,
        coversUntilRevisionEof: true,
        error: errMsg,
      });
      return makeInvalid(errMsg, {
        byteRange: entry.byteRange,
        contentsHexValid: false,
        totalRevisionsCount: eofBoundaries.length,
        signatures: sigSummaries,
      });
    }

    const hexAscii = pdfBuffer.subarray(b1 + 1, b2 - 1).toString('latin1');
    if (
      hexAscii.length === 0 ||
      hexAscii.length % 2 !== 0 ||
      !/^[0-9a-fA-F]+$/.test(hexAscii)
    ) {
      const errMsg = `Conteúdo /Contents da assinatura #${sIdx + 1} não é hexadecimal par válido.`;
      sigSummaries.push({
        signatureIndex: sIdx,
        fieldName: entry.fieldName,
        filter: entry.filter,
        subFilter: entry.subFilter,
        type: entry.type,
        byteRange: entry.byteRange,
        revisionEndByte: revEndByte,
        valid: false,
        contentsHexValid: false,
        contentsPaddingValid: false,
        coversUntilRevisionEof: true,
        error: errMsg,
      });
      return makeInvalid(errMsg, {
        byteRange: entry.byteRange,
        contentsHexValid: false,
        totalRevisionsCount: eofBoundaries.length,
        signatures: sigSummaries,
      });
    }

    // 4. Decode hex to binary and validate ASN.1 DER + zero-byte padding (Adjustment 5)
    const decodedBytes = Buffer.from(hexAscii, 'hex');
    const decodedArrayBuffer = new Uint8Array(decodedBytes).buffer;
    const asn1 = asn1js.fromBER(decodedArrayBuffer);
    if (
      asn1.offset === -1 ||
      !asn1.result ||
      asn1.offset <= 0 ||
      asn1.offset > decodedBytes.length
    ) {
      const errMsg = `Falha ao decodificar ASN.1 DER no /Contents da assinatura #${sIdx + 1}.`;
      sigSummaries.push({
        signatureIndex: sIdx,
        fieldName: entry.fieldName,
        filter: entry.filter,
        subFilter: entry.subFilter,
        type: entry.type,
        byteRange: entry.byteRange,
        revisionEndByte: revEndByte,
        valid: false,
        contentsHexValid: true,
        contentsPaddingValid: false,
        coversUntilRevisionEof: true,
        error: errMsg,
      });
      return makeInvalid(errMsg, {
        byteRange: entry.byteRange,
        contentsHexValid: true,
        contentsPaddingValid: false,
        totalRevisionsCount: eofBoundaries.length,
        signatures: sigSummaries,
      });
    }

    const cmsDerBytes = decodedBytes.subarray(0, asn1.offset);
    const paddingBytes = decodedBytes.subarray(asn1.offset);
    let contentsPaddingValid = true;
    for (let p = 0; p < paddingBytes.length; p += 1) {
      if (paddingBytes[p] !== 0x00) {
        contentsPaddingValid = false;
        break;
      }
    }

    if (!contentsPaddingValid) {
      const errMsg = `Padding de /Contents da assinatura #${sIdx + 1} contém bytes diferentes de 0x00 após o término do ASN.1 DER (offset ${asn1.offset}).`;
      sigSummaries.push({
        signatureIndex: sIdx,
        fieldName: entry.fieldName,
        filter: entry.filter,
        subFilter: entry.subFilter,
        type: entry.type,
        byteRange: entry.byteRange,
        revisionEndByte: revEndByte,
        valid: false,
        contentsHexValid: true,
        contentsPaddingValid: false,
        coversUntilRevisionEof: true,
        asn1ByteLength: cmsDerBytes.length,
        paddingByteLength: paddingBytes.length,
        error: errMsg,
      });
      return makeInvalid(errMsg, {
        byteRange: entry.byteRange,
        contentsHexValid: true,
        contentsPaddingValid: false,
        totalRevisionsCount: eofBoundaries.length,
        signatures: sigSummaries,
      });
    }

    const signedContentBytes = Buffer.concat([
      pdfBuffer.subarray(b0, b0 + b1),
      pdfBuffer.subarray(b2, b2 + b3),
    ]);

    sigSummaries.push({
      signatureIndex: sIdx,
      fieldName: entry.fieldName,
      filter: entry.filter,
      subFilter: entry.subFilter,
      type: entry.type,
      byteRange: entry.byteRange,
      revisionEndByte: revEndByte,
      valid: true,
      contentsHexValid: true,
      contentsPaddingValid: true,
      coversUntilRevisionEof: true,
      cmsDerBytes,
      signedContentBytes,
      asn1ByteLength: cmsDerBytes.length,
      paddingByteLength: paddingBytes.length,
    });
  }

  // Ensure at least one /Type /Sig signature exists
  const regularSigs = sigSummaries.filter((s) => s.type === 'Sig');
  if (regularSigs.length === 0) {
    return makeInvalid(
      'O documento contém apenas DocTimeStamp, sem assinatura /Type /Sig.',
      { totalRevisionsCount: eofBoundaries.length },
    );
  }

  const firstSigEndByte = sigSummaries[0].revisionEndByte;
  const finalSigOrTimestampEndByte =
    sigSummaries[sigSummaries.length - 1].revisionEndByte;
  const primarySig = regularSigs[regularSigs.length - 1];

  // Classify all revisions 0..R-1
  const revisions: PdfIncrementalRevisionClassification[] = [];
  let preSignatureRevisionsCount = 0;
  let signatureRevisionsCount = 0;
  let postSignatureLtvRevisionsCount = 0;
  let hasUnauthorizedPostSignatureUpdate = false;
  let unauthorizedReason: string | undefined;

  for (let r = 0; r < eofBoundaries.length; r += 1) {
    const startByte = r === 0 ? 0 : eofBoundaries[r - 1].endByte;
    const endByte = eofBoundaries[r].endByte;
    const eofOffset = eofBoundaries[r].eofTokenOffset;
    const deltaBytes = pdfBuffer.subarray(startByte, endByte);
    const { objectNumbers } = extractModifiedObjectNumbersFromSlice(deltaBytes);
    const sigAtRev = revIndexToSig.get(r);

    if (endByte < firstSigEndByte) {
      preSignatureRevisionsCount += 1;
      revisions.push({
        revisionIndex: r,
        startByte,
        endByte,
        eofOffset,
        kind: 'PRE_SIGNATURE_REVISION',
        coveredByFinalSignature: endByte <= finalSigOrTimestampEndByte,
        modifiedObjectNumbers: objectNumbers,
      });
    } else if (endByte === firstSigEndByte) {
      signatureRevisionsCount += 1;
      revisions.push({
        revisionIndex: r,
        startByte,
        endByte,
        eofOffset,
        kind: 'SIGNED_REVISION',
        coveredByFinalSignature: true,
        modifiedObjectNumbers: objectNumbers,
      });
    } else {
      const classification = classifyPostSignatureRevision({
        prevDoc: revisionDocs[r - 1],
        currDoc: revisionDocs[r],
        revisionIndex: r,
        startByte,
        endByte,
        eofOffset,
        deltaBytes,
        signatureAtThisRevision: sigAtRev,
      });
      revisions.push(classification);

      if (classification.kind === 'SUBSEQUENT_SIGNATURE_REVISION') {
        signatureRevisionsCount += 1;
      } else if (
        classification.kind === 'PADES_LTV_DSS_REVISION' ||
        classification.kind === 'PADES_DOC_TIMESTAMP_REVISION'
      ) {
        postSignatureLtvRevisionsCount += 1;
      } else {
        hasUnauthorizedPostSignatureUpdate = true;
        if (!unauthorizedReason) {
          unauthorizedReason = classification.reason;
        }
      }
    }
  }

  const coversWholeDocument =
    primarySig.revisionEndByte === pdfBuffer.length;
  const unsignedTrailingBytes =
    pdfBuffer.length - finalSigOrTimestampEndByte;

  if (hasUnauthorizedPostSignatureUpdate) {
    return {
      valid: false,
      policy,
      byteRange: primarySig.byteRange,
      coversWholeDocument,
      unsignedTrailingBytes,
      contentsHexValid: true,
      contentsPaddingValid: true,
      totalRevisionsCount: eofBoundaries.length,
      preSignatureRevisionsCount,
      signatureRevisionsCount,
      postSignatureLtvRevisionsCount,
      hasUnauthorizedPostSignatureUpdate: true,
      revisions,
      signatures: sigSummaries,
      error:
        unauthorizedReason ||
        'Revisão incremental posterior à assinatura modificou conteúdo ou estrutura protegida.',
    };
  }

  if (
    policy === 'STRICT_SINGLE_REVISION_AT_SIGNING' &&
    (!coversWholeDocument ||
      postSignatureLtvRevisionsCount > 0 ||
      signatureRevisionsCount !== 1)
  ) {
    return {
      valid: false,
      policy,
      byteRange: primarySig.byteRange,
      coversWholeDocument,
      unsignedTrailingBytes,
      contentsHexValid: true,
      contentsPaddingValid: true,
      totalRevisionsCount: eofBoundaries.length,
      preSignatureRevisionsCount,
      signatureRevisionsCount,
      postSignatureLtvRevisionsCount,
      hasUnauthorizedPostSignatureUpdate: false,
      revisions,
      signatures: sigSummaries,
      error:
        'Política estrita de emissão (STRICT_SINGLE_REVISION_AT_SIGNING) exige assinatura única cobrindo até o byte final do PDF sem revisões posteriores.',
    };
  }

  return {
    valid: true,
    policy,
    byteRange: primarySig.byteRange,
    coversWholeDocument,
    unsignedTrailingBytes,
    contentsHexValid: true,
    contentsPaddingValid: true,
    totalRevisionsCount: eofBoundaries.length,
    preSignatureRevisionsCount,
    signatureRevisionsCount,
    postSignatureLtvRevisionsCount,
    hasUnauthorizedPostSignatureUpdate: false,
    revisions,
    signatures: sigSummaries,
  };
}
