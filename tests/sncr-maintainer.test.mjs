import {test} from 'node:test';
import assert from 'node:assert/strict';
import {platformMaintainer, normalizeMaintainerCnpj, rceRetMaintainerFields} from '../lib/sncr/maintainer.ts';
import {localSimulationEnabled, requireLocalSimulation} from '../lib/sncr/numbering.ts';

// Somente exemplos sintéticos de formato/dígitos, sem consulta cadastral.
const candidate={PSYWRITE_MAINTAINER_LEGAL_NAME:' Empresa Sintética LTDA ',PSYWRITE_MAINTAINER_CNPJ:'12.345.678/0001-95'};
test('configuração ausente não cria mantenedora nem usa CNPJ de clínica/legado',()=>{
 assert.equal(platformMaintainer({}),null);
 assert.equal(platformMaintainer({ANVISA_SNCR_CNPJ:'12345678000195',CLINIC_CNPJ:'12345678000195'}),null);
});
test('formato e dígitos válidos são normalizados sem fixar identidade no código',()=>{
 assert.equal(normalizeMaintainerCnpj('12.345.678/0001-95'),'12345678000195');
 assert.equal(normalizeMaintainerCnpj(' 12345678000195 '),'12345678000195');
 assert.equal(platformMaintainer(candidate).legalName,'Empresa Sintética LTDA');
});
test('CNPJ malformado, letras ou dígitos incorretos são recusados',()=>{
 for(const cnpj of ['','123','12.345.678/0001-99','00000000000000','11111111111111','CNPJ 12.345.678/0001-95','X12345678000195']) assert.throws(()=>normalizeMaintainerCnpj(cnpj));
});
test('configuração parcial e razão social inválida falham explicitamente',()=>{
 for(const value of [{PSYWRITE_MAINTAINER_CNPJ:candidate.PSYWRITE_MAINTAINER_CNPJ},{PSYWRITE_MAINTAINER_LEGAL_NAME:'Empresa'}, {...candidate,PSYWRITE_MAINTAINER_LEGAL_NAME:'Empresa\nOutra'}]) assert.throws(()=>platformMaintainer(value));
});
test('projeção para RCE/RET contém somente o campo oficial cnpj',()=>{
 assert.deepEqual(rceRetMaintainerFields(candidate),{cnpj:'12345678000195'});
 assert.throws(()=>rceRetMaintainerFields({}),/não configurada/);
});
test('validação matemática não declara habilitação regulatória',()=>{
 const configured=platformMaintainer(candidate);
 assert.equal(configured.regulatoryStatus,'unverified');
 assert.equal(Object.isFrozen(configured),true);
});
test('configuração e projeção não exigem certificado e-CNPJ ou identidade do prescritor',()=>{
 assert.ok(rceRetMaintainerFields(candidate).cnpj);
 assert.deepEqual(Object.keys(platformMaintainer(candidate)).sort(),['cnpj','legalName','regulatoryStatus']);
});
test('CNPJ configurado não libera modo de produção ou homologação externa',()=>{
 const keys=['NODE_ENV','PSYWRITE_SNCR_MODE','PSYWRITE_MAINTAINER_LEGAL_NAME','PSYWRITE_MAINTAINER_CNPJ'];
 const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 try {
  Object.assign(process.env,candidate,{NODE_ENV:'production',PSYWRITE_SNCR_MODE:'production'});
  assert.ok(platformMaintainer());
  assert.equal(localSimulationEnabled(),false);
  assert.throws(()=>requireLocalSimulation(),/bloqueada/);
 } finally {for(const k of keys) saved[k]===undefined?delete process.env[k]:process.env[k]=saved[k];}
});
