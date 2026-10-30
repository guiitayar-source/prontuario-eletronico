# Roteiro: RCE e RET reais no validador do ITI

Objetivo: assinar uma RCE e uma RET com o seu Bird ID (ou VIDaaS) e conferir no validador oficial
do ITI (https://validar.iti.gov.br/) se os PDFs saem aprovados. É a mesma verificação que a
farmácia faz (RDC 1.000/2025, art. 13, I).

**Use só dados fictícios** de paciente: o arquivo é enviado ao serviço do ITI. O CPF de teste
`111.444.777-35` é válido no cálculo, mas não é de ninguém conhecido.

## 1. Ambiente local

Siga os passos 1 a 4 de `docs/auditorias/6f2d/ROTEIRO-BIRDID.md` (caminho B): Supabase local,
migrações pendentes só no banco local, conta e clínica locais e `npm run dev` com as variáveis
locais por cima do `.env.local`.

O filtro do passo 2 (`$3 > "20261016010000_z"`) já inclui a `20261030120000`, que libera a RET.

## 2. Cadastros

Em http://localhost:3000:

1. **Ajustes → dados profissionais.** CPF igual ao do certificado, CRM, timbre com endereço
   completo e telefone.
2. **Paciente "Paciente Teste"** com:
   - CPF `111.444.777-35`;
   - data de nascimento, por exemplo 15/11/1990;
   - gênero/sexo, por exemplo "Feminino";
   - logradouro, número, cidade, UF e CEP.

## 3. RCE

1. Nova Receita, tipo **Receita de Controle Especial**.
2. Na seção **RCE eletrônica (modelo oficial da Anvisa)**, preencha: CRM, UF, medicamento,
   concentração, forma farmacêutica, quantidade e posologia. Use um medicamento por receita.
3. Escreva também o texto da receita, que é o usado na impressão.
4. Conecte o Bird ID e assine.
5. Baixe o PDF assinado.

**O que conferir no PDF:**
- é o modelo oficial da Anvisa;
- no campo do número: "Sem numeração SNCR (período de transição)";
- CPF do paciente e endereço;
- prescritor com CRM/UF, endereço e telefone;
- data de hoje;
- rodapé "Verifique a assinatura digital em validar.iti.gov.br";
- nenhuma marca de "HOMOLOGAÇÃO".

## 4. RET

1. Nova Receita, tipo **Receita sujeita à retenção**, com o texto da receita.
2. Assine e baixe.

**O que conferir:**
- duas vias ("1ª via - Farmácia" e "2ª via - Paciente");
- título "Receituário sujeito à retenção";
- "Idade: N anos  Sexo: …" na linha do paciente;
- data de hoje;
- endereço e telefone do consultório no rodapé.

## 5. Validador do ITI

Para cada PDF:
1. Abra https://validar.iti.gov.br/.
2. Envie o arquivo e anote o resultado.

| Campo | O que esperar |
|---|---|
| Resultado geral | aprovado/válido |
| Assinante | seu nome e CPF |
| Cadeia | ICP-Brasil, AC do Bird ID (AC Soluti Múltipla v5) |
| Integridade | íntegra |
| Data da assinatura | hoje, compatível com a data impressa |
| Política de assinatura | provavelmente "sem política" ou "não identificada" (ver abaixo) |

**Se aparecer ressalva sobre política de assinatura:** o PsyWrite assina em PAdES básico, sem
política de assinatura ICP-Brasil (DOC-ICP-15) e sem carimbo do tempo. Se o validador marcar isso
como ressalva, ou não como aprovado, me mande a saída. Esse é o próximo ajuste: incluir a política
AD-RB e, depois, o carimbo do tempo.

## 6. O que me mandar

- O resultado do validador para a RCE e para a RET: print ou texto, sem dados de paciente reais.
- Qualquer divergência entre a data impressa e a data da assinatura mostrada pelo ITI.

## 7. Limpeza

```bash
rm -f /tmp/psywrite-local.env
npx supabase db reset   # apaga só os dados locais
```

Nunca use `--linked`, `db push` ou `link` neste roteiro.
