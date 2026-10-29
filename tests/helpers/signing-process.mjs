// Processo de aplicação isolado. Transporte de banco/Storage/HSM pertence ao harness pai.
import { register } from 'node:module';
const root = new URL('../../', import.meta.url).href;
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(s,c,next){if(s.startsWith('@/'))return next(new URL(s.slice(2)+(/\\.[a-z]+$/.test(s)?'':'.ts'),${JSON.stringify(root)}).href,c);return next(s,c);}`,
    ),
  import.meta.url,
);
const { DocumentSigningService } =
  await import('../../lib/signature/document-signing-service.ts');
const { setCustomSignatureProvider } =
  await import('../../lib/signature/provider-factory.ts');
globalThis.fetch = async () => {
  throw Error('Rede real proibida no processo de teste.');
};
let sequence = 0;
const pending = new Map();
function call(kind, args) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    process.send({ id, kind, args });
  });
}
function query(table, steps = []) {
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (key === 'then')
          return (resolve, reject) =>
            call('query', { table, steps }).then(resolve, reject);
        return (...args) => query(table, [...steps, [key, args]]);
      },
    },
  );
}
const db = {
  from: (table) => query(table),
  rpc: (name, args) => call('rpc', { name, args }),
  storage: {
    from: (bucket) => ({
      upload: (path, bytes, options) =>
        call('upload', {
          bucket,
          path,
          pdf: Buffer.from(bytes).toString('base64'),
          options,
        }),
      download: async (path) => {
        const r = await call('download', { bucket, path });
        return {
          data: r.pdf ? new Blob([Buffer.from(r.pdf, 'base64')]) : null,
          error: r.error,
        };
      },
    }),
  },
};
setCustomSignatureProvider({ signHash: (args) => call('hsm', args) });
process.on('message', async (message) => {
  if (message.start) {
    try {
      const result = await new DocumentSigningService(
        () => db,
      ).signClinicalDocument({ db, ...message.start });
      process.send({
        done: true,
        result: {
          success: result.success,
          signedPdfPath: result.signedPdfPath,
        },
      });
    } catch (error) {
      process.send({
        done: true,
        error: { status: error.status, message: error.message },
      });
    }
    process.disconnect();
    return;
  }
  const item = pending.get(message.id);
  if (!item) return;
  pending.delete(message.id);
  if (message.error) item.reject(Error(message.error));
  else item.resolve(message.result);
});
