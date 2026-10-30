import {
  parseNumberingResponse,
  SncrError,
  type NumberingInput,
  type SncrClient,
} from './client.ts';

type Store = {
  update: (fields: Record<string, unknown>) => Promise<unknown>;
  storeNumbers: (numbers: string[]) => Promise<void>;
};
// Called ONLY after durable one-use claim. Separating this sequence allows
// partial-failure tests without a live Anvisa/Supabase connection.
export async function completeNumbering(params: {
  client: Pick<SncrClient, 'exchange' | 'requestNumbers'>;
  store: Store;
  sessionId: string;
  input: NumberingInput;
  platformCnpj: string;
}) {
  const { client, store, sessionId, input, platformCnpj } = params;
  let token: string;
  try {
    token = await client.exchange(sessionId);
  } catch {
    await store.update({ state: 'AUTH_FAILED' });
    throw new SncrError(401, false);
  }
  let raw: Record<string, unknown>;
  try {
    raw = await client.requestNumbers(token, input, platformCnpj);
  } catch (e) {
    const error = e instanceof SncrError ? e : new SncrError(503, true);
    await store.update({
      state: error.uncertain ? 'UNKNOWN' : 'REJECTED',
      http_status: error.httpStatus,
    });
    throw error;
  }
  // If this fails, REQUESTING is retained and becomes UNKNOWN. No retry.
  await store.update({ raw_response: raw });
  return storeParsed(store, input, raw);
}
// Rereads a response already preserved in CONTRACT_REVIEW (after the parser
// learned a new format). Called ONLY after sncr_reprocess_request moved it back
// to REQUESTING; never contacts Anvisa again.
export async function storeParsed(
  store: Store,
  input: NumberingInput,
  raw: Record<string, unknown>,
) {
  let numbers: string[];
  try {
    numbers = parseNumberingResponse(input, raw);
  } catch {
    await store.update({ state: 'CONTRACT_REVIEW' });
    return { state: 'CONTRACT_REVIEW', issuanceAvailable: false };
  }
  try {
    await store.storeNumbers(numbers);
  } catch {
    await store.update({ state: 'CONTRACT_REVIEW' });
    return { state: 'CONTRACT_REVIEW', issuanceAvailable: false };
  }
  return {
    state: 'RECEIVED_UNVERIFIED',
    count: numbers.length,
    issuanceAvailable: false,
  };
}
