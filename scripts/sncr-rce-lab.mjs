// Isolated localhost laboratory. No .env, no shared Supabase, no real patients.
// The signing provider is always synthetic; normal app routes never use it.
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import {
  localRceDatabase,
  syntheticSnapshot,
} from '../tests/helpers/sncr-rce-db.mjs';
import { MockBirdIdProvider } from '../lib/signature/mock-birdid-provider.ts';
import {
  SncrClient,
  validCnpj,
  sncrLoginUrl,
  validateNumberingInput,
} from '../lib/sncr/client.ts';
import { completeNumbering } from '../lib/sncr/workflow.ts';
import { originalRce, signRce, sha256 } from '../lib/sncr/rce-workflow.ts';
import { rcePdf } from '../lib/sncr/rce-pdf.ts';

const root = resolve(process.env.SNCR_LAB_DIRECTORY || '/tmp/psywrite-rce-lab'),
  origin = 'http://127.0.0.1:3027';
await mkdir(root, { recursive: true });
const local = await localRceDatabase(root + '/db');
const csrf = randomBytes(32).toString('hex');
const artifacts = {
  read: async (path) => {
    try {
      return new Uint8Array(await readFile(resolve(root, 'files', path)));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  },
  writeOnce: async (path, bytes) => {
    const full = resolve(root, 'files', path);
    if (!full.startsWith(root + '/files/')) throw new Error('Invalid path');
    await mkdir(dirname(full), { recursive: true });
    try {
      await writeFile(full, bytes, { flag: 'wx' });
    } catch (e) {
      const old = await readFile(full);
      if (sha256(old) !== sha256(bytes)) throw e;
    }
  },
};
const provider = new MockBirdIdProvider({
  mockCpf: '52998224725',
  doctorName: 'PRESCRITOR FICTICIO',
});
const [cert] = await provider.getCertificates('synthetic-only');
let signerCalls = 0;
const getSigner = async () => ({
  cpf: cert.cpf,
  fingerprint: cert.fingerprint256,
  provider: 'synthetic-local-only',
  sign: async (digest) => {
    signerCalls++;
    return provider.signHash({
      accessToken: 'synthetic-only',
      certificateAlias: cert.alias,
      hashHex: digest,
      documentAlias: 'TESTE SEM VALIDADE',
    });
  },
});
const json = (res, data, status = 200) => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
};
const page =
  () => `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Teste local da RCE</title>
<style>body{font:16px system-ui;max-width:960px;margin:30px auto;padding:0 20px;color:#182927;background:#f4f7f5}section{background:white;border:1px solid #bed1ca;border-radius:12px;padding:20px;margin:18px 0}button,input{font:inherit;padding:9px;margin:5px}button{cursor:pointer}label{display:block}iframe{width:100%;height:650px}pre{white-space:pre-wrap}strong{color:#822b16}</style>
<h1>RCE: teste local completo</h1><p><strong>Sem validade para dispensação. Paciente, medicamento e certificado são fictícios.</strong> Nenhum dado do prontuário é acessado. A assinatura nesta bancada é simulada; o aplicativo utiliza Bird ID/VIDaaS.</p>
<section><h2>1. Preparar a receita fictícia</h2><button id="simulate">Preparar com numeração simulada</button><p>Funciona sem login e sem chamar a Anvisa.</p>
<details><summary>Testar a comunicação real com a Anvisa, em treinamento</summary><p>Esse teste solicita somente numeração em homologação. Não envia dados de pacientes. Você fará o login no gov.br pessoalmente.</p>
<label>CNPJ da empresa mantenedora do PsyWrite <input id="cnpj" inputmode="numeric" maxlength="18"></label><label>Seu CRM <input id="crm" inputmode="numeric"></label><label>UF do CRM <input id="uf" maxlength="2" value="SP"></label>
<button id="login">Entrar no gov.br e solicitar lote RCE de teste</button><button id="realPrepare">Preparar receita fictícia com número de treinamento já recebido</button><p id="numbering" role="status"></p></details></section>
<section><h2>2. Revisar e assinar</h2><pre id="review">Nenhuma preparação selecionada.</pre><p><a href="https://sncr-treinamento.anvisa.gov.br/" target="_blank" rel="noreferrer">Abrir SNCR de treinamento para conferir o número, quando recebido da Anvisa</a></p>
<label><input type="checkbox" id="checked"> Revisei os dados fictícios. Se o número veio da Anvisa, conferi seu vínculo com meu CRM/UF no portal de treinamento.</label>
<button id="sign" disabled>Assinar ou recuperar esta mesma RCE de teste</button><button id="refresh">Consultar resultado</button></section>
<section><h2>3. Recuperar o original</h2><button id="download" disabled>Baixar original assinado de teste</button><p id="message" role="status"></p><iframe id="pdf" title="RCE fictícia"></iframe></section>
<script>
const csrf=${JSON.stringify(csrf)};let emission=null,pdfUrl='',simulation=true;
const $=id=>document.getElementById(id);const message=text=>$('message').textContent=text;
function numbering(n){if(!n){$('numbering').textContent='Ainda não houve solicitação de numeração real nesta bancada.';return;}const labels={AUTH_PENDING:'Aguardando o retorno do login gov.br.',AUTH_EXPIRED:'O login expirou antes da solicitação. Inicie novamente.',AUTH_FAILED:'Não foi possível concluir a autenticação.',REQUESTING:'Aguardando resposta da Anvisa. Não solicite outro lote.',UNKNOWN:'O resultado é incerto. Confira no portal antes de qualquer nova solicitação.',REJECTED:'A Anvisa recusou a solicitação. Confira o CRM/UF e a disponibilidade no portal.',CONTRACT_REVIEW:'A resposta foi preservada, mas o formato precisa de conferência técnica. Não solicite outro lote.',RECEIVED_UNVERIFIED:'Numeração recebida da Anvisa. Confira o vínculo com seu CRM/UF no portal de treinamento.',ALLOCATED:'Os números recebidos já foram reservados para testes.'};$('numbering').textContent=(labels[n.state]||n.state)+(n.httpStatus?' HTTP '+n.httpStatus+'.':'')+(n.count?' '+n.count+' números preservados.':'');}
async function call(path,payload){const r=await fetch(path,payload?{method:'POST',headers:{'Content-Type':'application/json','X-Lab-CSRF':csrf},body:JSON.stringify(payload)}:{});const data=await r.json();if(!r.ok)throw new Error(data.error);return data;}
function render(e){emission=e;if(!e)return;$('review').textContent='Estado: '+e.state+'\\nNúmero: '+e.number+'\\nPaciente: '+e.snapshot.patient.name+'\\nPrescritor: '+e.snapshot.prescriber.name+' — CRM '+e.snapshot.prescriber.crm+'/'+e.snapshot.prescriber.uf+'\\n'+e.snapshot.medicine.name+' '+e.snapshot.medicine.concentration+'\\n'+e.snapshot.medicine.dosage;$('sign').disabled=!$('checked').checked||e.state==='SIGNED';$('download').disabled=e.state!=='SIGNED';message(e.state==='SIGNED'?'Teste completo: original assinado disponível. Sem validade para dispensação.':'Revise o PDF antes de assinar.');}
async function pdf(original=false){if(!emission)return;const r=await fetch('/api/pdf?id='+emission.id+'&kind='+(original?'original':'preview'));if(!r.ok)throw new Error((await r.json()).error);if(pdfUrl)URL.revokeObjectURL(pdfUrl);pdfUrl=URL.createObjectURL(await r.blob());$('pdf').src=pdfUrl;if(original){const a=document.createElement('a');a.href=pdfUrl;a.download='rce-ficticia-assinada.pdf';a.click();}}
function run(fn){return async()=>{try{await fn();}catch(e){message(e.message);}};}
$('simulate').onclick=run(async()=>{const data=await call('/api/prepare',{simulation:true});simulation=true;render(data.emission);await pdf();});
$('realPrepare').onclick=run(async()=>{const data=await call('/api/prepare',{simulation:false});simulation=false;render(data.emission);await pdf();});
$('checked').onchange=()=>{$('sign').disabled=!emission||!$('checked').checked||emission.state==='SIGNED';};
$('sign').onclick=run(async()=>{if(!emission||!$('checked').checked)return;const data=await call('/api/sign',{id:emission.id,hash:emission.snapshot_hash,checked:true,simulation});render(data.emission);});
$('download').onclick=run(()=>pdf(true));$('refresh').onclick=run(async()=>{const data=await call('/api/state');if(data.emission)render(data.emission);numbering(data.numbering);});
$('login').onclick=run(async()=>{const data=await call('/api/login',{cnpj:$('cnpj').value,crm:$('crm').value,uf:$('uf').value.toUpperCase()});location.assign(data.loginUrl);});
run(async()=>{const q=new URLSearchParams(location.search),sid=q.get('session_id');history.replaceState({},'','/sncr');if(sid){document.querySelector('details').open=true;message('Concluindo autenticação no servidor…');try{const data=await call('/api/complete',{sessionId:sid});message('Anvisa: '+data.state+'. Nenhuma receita foi emitida.');}finally{const data=await call('/api/state');numbering(data.numbering);}}else{const data=await call('/api/state');if(data.emission)render(data.emission);numbering(data.numbering);}})();
</script></html>`;
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  try {
    if (req.headers.host !== '127.0.0.1:3027')
      return json(res, { error: 'Host não autorizado.' }, 403);
    const url = new URL(req.url, origin);
    if (req.method === 'GET' && ['/', '/sncr'].includes(url.pathname)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(page());
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const n = (
        await local.db.query(`select r.id,r.state,r.http_status,r.updated_at,
      (select count(*)::int from public.sncr_numbering_items i where i.request_id=r.id) as count,
      r.raw_response->>'inicio' as inicio,r.raw_response->>'fim' as fim
      from public.sncr_numbering_requests r where r.input ? 'platformCnpj' order by r.created_at desc limit 1`)
      ).rows[0];
      return json(res, {
        emission:
          (
            await local.db.query(
              "select * from public.sncr_rce_emissions where state<>'CANCELLED' order by created_at desc limit 1",
            )
          ).rows[0] || null,
        signerCalls,
        numbering: n
          ? {
              state:
                n.state === 'REQUESTING' &&
                Date.parse(n.updated_at) < Date.now() - 30000
                  ? 'UNKNOWN'
                  : n.state,
              httpStatus: n.http_status,
              count: n.count,
              inicio: n.inicio,
              fim: n.fim,
            }
          : null,
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/pdf') {
      const e = await local.get(url.searchParams.get('id'));
      if (!e) throw new Error('Emissão não encontrada.');
      const bytes =
        url.searchParams.get('kind') === 'original'
          ? await originalRce(local.repo(e.id), artifacts)
          : await rcePdf(e.snapshot, e.number, new Date(), 'hmg');
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      return res.end(bytes);
    }
    if (
      req.method !== 'POST' ||
      req.headers.origin !== origin ||
      req.headers['x-lab-csrf'] !== csrf
    )
      return json(res, { error: 'Origem não autorizada.' }, 403);
    let size = 0;
    const parts = [];
    for await (const part of req) {
      size += part.length;
      if (size > 16384) throw new Error('Corpo excede o limite.');
      parts.push(part);
    }
    const p = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (url.pathname === '/api/prepare') {
      const snapshot = syntheticSnapshot();
      if (p.simulation === true) {
        const count = (
          await local.db.query(
            "select count(*)::int as n from public.sncr_numbering_items where number like '0000.0-00.%'",
          )
        ).rows[0].n;
        await local.addNumbers([
          '0000.0-00.' + String(count + 1).padStart(7, '0'),
        ]);
      } else {
        const row = (
          await local.db.query(
            "select input from public.sncr_numbering_requests where category='RCE' and raw_response is not null and input ? 'platformCnpj' order by created_at desc limit 1",
          )
        ).rows[0];
        if (!row)
          throw new Error(
            'Faça o login no gov.br e receba numeração de treinamento antes.',
          );
        snapshot.prescriber.crm = row.input.documento;
        snapshot.prescriber.uf = row.input.uf;
      }
      return json(res, { emission: await local.reserve(snapshot) });
    }
    if (url.pathname === '/api/sign')
      return json(res, {
        emission: await signRce({
          repository: local.repo(p.id),
          artifacts,
          reviewedHash: p.hash,
          numberChecked: p.checked === true,
          getSigner,
          numberCheckMode:
            p.simulation === true ? 'simulated' : 'prescriber_checked',
        }),
      });
    if (url.pathname === '/api/login') {
      p.cnpj = String(p.cnpj || '').replace(/[./-]|\s/g, '');
      if (!validCnpj(p.cnpj))
        throw new Error('Informe o CNPJ válido da mantenedora do PsyWrite.');
      await local.db.query(
        "update public.sncr_numbering_requests set state='AUTH_EXPIRED',updated_at=now() where state='AUTH_PENDING' and expires_at<now()",
      );
      const pending = (
        await local.db.query(
          "select state from public.sncr_numbering_requests where user_id=$1 and category='RCE' and state in ('AUTH_PENDING','REQUESTING','UNKNOWN','RECEIVED_UNVERIFIED','CONTRACT_REVIEW') limit 1",
          [local.user],
        )
      ).rows[0];
      if (pending)
        throw new Error(
          'Já existe uma solicitação aguardando conclusão ou conferência. Consulte o resultado; não solicite outro lote.',
        );
      const input = validateNumberingInput({
          category: 'RCE',
          conselho: 'CRM',
          documento: p.crm,
          uf: p.uf,
        }),
        rid = randomUUID(),
        secret = randomBytes(32).toString('hex');
      await local.db.query(
        `insert into public.sncr_numbering_requests(id,clinic_id,user_id,environment,category,input,browser_hash)
    values($1,$2,$3,'hmg','RCE',$4::jsonb,$5)`,
        [
          rid,
          local.clinic,
          local.user,
          JSON.stringify({ ...input, platformCnpj: p.cnpj }),
          sha256(secret),
        ],
      );
      res.setHeader(
        'Set-Cookie',
        `rce_lab_flow=${rid}.${secret}; HttpOnly; SameSite=Lax; Path=/api; Max-Age=600`,
      );
      return json(res, { loginUrl: sncrLoginUrl('hmg', origin + '/sncr') });
    }
    if (url.pathname === '/api/complete') {
      const cookie =
        req.headers.cookie
          ?.split(';')
          .map((s) => s.trim())
          .find((s) => s.startsWith('rce_lab_flow='))
          ?.slice(13) || '';
      const [rid, secret] = cookie.split('.');
      if (!rid || !secret) throw new Error('Inicie o login nesta bancada.');
      const row = (
        await local.db.query(
          'select public.sncr_claim_request($1,$2,$3,$4) as r',
          [rid, local.clinic, local.user, sha256(secret)],
        )
      ).rows[0].r;
      const update = async (fields) => {
        const keys = Object.keys(fields);
        await local.db.query(
          `update public.sncr_numbering_requests set ${keys.map((k, i) => k + '=$' + (i + 2)).join(',')},updated_at=now() where id=$1`,
          [
            rid,
            ...keys.map((k) =>
              typeof fields[k] === 'object'
                ? JSON.stringify(fields[k])
                : fields[k],
            ),
          ],
        );
      };
      return json(
        res,
        await completeNumbering({
          client: new SncrClient('hmg', origin),
          sessionId: p.sessionId,
          input: validateNumberingInput(row.input),
          platformCnpj: row.input.platformCnpj,
          store: {
            update,
            storeNumbers: async (numbers) => {
              await local.db.query(
                'select public.sncr_store_numbers($1,$2,$3,$4::jsonb)',
                [rid, local.clinic, local.user, JSON.stringify(numbers)],
              );
            },
          },
        }),
      );
    }
    return json(res, { error: 'Rota não encontrada.' }, 404);
  } catch (e) {
    return json(res, { error: e.message }, 400);
  }
});
server.listen(3027, '127.0.0.1', () =>
  console.log(
    'Bancada local: ' +
      origin +
      '/sncr — dados e assinatura fictícios. Sem deploy.',
  ),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () =>
    server.close(() => void local.db.close().finally(() => process.exit(0))),
  );
