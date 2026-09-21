# PsyWrite — Prontuário Eletrônico & Gestão Clínica

Sistema web moderno para clínicas e consultórios com foco em prontuário eletrônico, acompanhamento longitudinal de pacientes, exames estruturados com suporte a IA multimodal, prescrições médicas em 2 vias, agenda e interoperabilidade em saúde (FHIR R4 / LGPD).

---

## 🛠️ Stack Tecnológica & Arquitetura

- **Framework**: Next.js 16 (App Router) & React 19 (Server e Client Components)
- **Linguagem**: TypeScript (tipagem estrita ponta a ponta)
- **Banco de Dados & Backend**: Supabase (PostgreSQL com Row Level Security - RLS, MFA, Auth e Storage privado)
- **Inteligência Artificial Multimodal**: Google Gemini API & OpenAI API (extração de dados estruturados com JSON Schema e transcrição de laudos/fotos)
- **Visualização & PDFs**: Recharts (gráficos temporais de exames) e gerador de PDF sob medida com fontes incorporadas (receituários em 2 vias A4)
- **Estilização**: CSS modular nativo por recurso, garantindo alta performance sem dependências pesadas de runtime

---

## 🚀 O Que o Projeto Tem (Funcionalidades)

### 1. Prontuário & Atendimento Clínico
- **Evolução em Texto Livre**: Registro ágil do atendimento com salvamento automático seguro e controle de versões.
- **Histórico Imutável & Adendos**: Consultas finalizadas são congeladas com registro de autor e carimbo de data/hora; retificações são registradas por adendos rastreáveis.
- **Painel de Contexto Longitudinal**: Acesso rápido a diagnósticos/CID, medicamentos em uso contínuo e alergias diretamente no painel lateral da consulta.

### 2. Agenda de Atendimentos
- Criação, edição, reagendamento e cancelamento de consultas.
- Identificação visual de status do agendamento com atalho em um clique para abertura direta do prontuário do paciente.

### 3. Gestão e Cadastro de Pacientes
- Ficha cadastral completa com validação de CPF, dados demográficos, contatos e controle de versionamento cadastral.
- Busca rápida e listagem otimizada por nome e documento.

### 4. Documentos & Prescrições Médicas
- Emissão de atestados, declarações, pedidos de exames e receituários.
- **Receituário em 2 Vias (Farmácia / Paciente)**: Geração instantânea de PDF em folha A4 com endereço do consultório, modelos pré-definidos e fontes vetoriais incorporadas.
- Histórico de versões e rascunhos.

### 5. Anexos & Captura Multimodal via Celular
- Recebimento de laudos em PDF e fotos de exames físicos.
- **Captura via QR Code**: Abertura de canal seguro para fotografar documentos pelo celular (`/celular`) sem expor credenciais do médico.
- Classificação, arquivamento e visualização segura de anexos em bucket privado do Supabase Storage.

### 6. Biblioteca & Acompanhamento de Exames Laboratoriais
- **Catálogo Estruturado da Clínica**: Definição de exames reutilizáveis com parâmetros dinâmicos (numéricos, opções pré-definidas ou texto).
- **Extração Assistida por IA**: Upload de laudos (PDF ou imagem) com leitura estruturada via modelos Gemini ou OpenAI.
- **Revisão Humana Obrigatória**: Nenhuma sugestão de IA entra no prontuário sem conferência explícita de valores, unidades e referências pelo profissional, exibindo o trecho original do documento como evidência.
- **Histórico Longitudinal & Gráficos**: Gráficos temporais interativos com agrupamento automático de unidades compatíveis (ex: séries de hemograma).
- **Correções Auditáveis**: Retificação de resultados com motivo obrigatório, preservando o valor anterior para fins periciais e legais.

### 7. Interoperabilidade, Importação & Exportação
- **Importador LGPD JSON & FHIR R4**: Carga em lote de prontuários com pré-visualização, identificação de duplicados, vínculo explícito e possibilidade de reversão de lote com auditoria.
- **Exportação FHIR R4**: Exportação padronizada dos dados do paciente e exames ativos conforme os padrões internacionais de saúde.

### 8. Segurança, Governança & Multi-tenant
- Isolamento estrito por clínica (`clinic_id`) com Row Level Security (RLS) no PostgreSQL.
- Controle de acesso baseado em papéis (RBAC): médicos e proprietários têm acesso integral a evoluções e laudos; secretárias acessam cadastro, agenda e recepção de anexos.
- Trilha de auditoria para operações sensíveis e proteção de MFA verificada inclusive a nível de banco de dados.

---

## 🏗️ Refatoração Arquitetural Recente

O projeto passou por uma ampla auditoria e refatoração arquitetural com foco em manutenibilidade, previsibilidade e drástica redução de custo de tokens/contexto para agentes de IA:

### O Que Foi Feito na Refatoração

#### 1. Eliminação de UI Zumbi (Dead Code)
- **Remoção de 60 arquivos não utilizados** em `components/ui/` (antigos componentes shadcn/ui não referenciados) e do arquivo `components.json`.
- **Economia de 7.565 linhas** de código morto, eliminando ruído e consumo excessivo de tokens nas análises do codebase.

#### 2. Desacoplamento do Domínio Ativo vs Legado D1
- **Criação de `lib/file-utils.ts`**: Centralização de constantes e detecção pura de tipos de arquivo (`MAX_FILE`, `fileType`).
- **Expansão de `lib/patient-fields.ts`**: Funções puras de validação cadastral e de CPF (`validCpf`, `validate`).
- **Desacoplamento Completo**: Módulos ativos do Supabase (`lib/supabase/patients.ts`, `lib/imports/normalize.ts`, `lib/supabase/capture.ts`, `lib/supabase/ai-files.ts`) agora usam módulos desacoplados em vez de importar arquivos legados de Cloudflare D1.
- **Compatibilidade Preservada**: Os módulos legados (`lib/patients.ts`, `lib/capture.ts`) reexportam os novos utilitários para manter compatibilidade retroativa.

#### 3. Unificação dos Clientes de IA
- **Criação de `lib/ai/client.ts`**:
  - Centralização de requisições de texto com JSON Schema estruturado (`requestOpenAiText`, `requestGeminiText`) e processamento multimodal de arquivos (`requestOpenAiFile`, `requestGeminiFile`).
  - Verificação unificada de status de configuração de chaves (`isAiProviderConfigured`).
- **Eliminação de ~400 linhas duplicadas** de chamadas HTTP, payloads e adaptação de schemas em `lib/supabase/document-ai.ts` e `lib/supabase/ai-files.ts`.

#### 4. Navegação Lateral Centralizada (`NavigationRail`)
- **Criação de `components/navigation-rail.tsx`**:
  - Ponto único de verdade para rotas e menus (Agenda, Pacientes, Importar, Equipe, Configurações, atalho Celular e Logout).
- Substituição de blocos duplicados de navegação nas 6 telas da aplicação (`agenda.tsx`, `clinical-record.tsx`, `registry.tsx`, `imports.tsx`, `team.tsx`, `settings.tsx`).

#### 5. Modularização do Módulo de Exames (`components/exams.tsx`)
- O monólito de 1.343 linhas foi fatiado e reduzido em 40% (para 801 linhas), com a extração de componentes dedicados em `components/exams/`:
  - **`exam-chart.tsx`**: Isolamento de Recharts, eixos de data e formatação temporal.
  - **`exam-definition-form.tsx`**: Criação de novos exames com campos e tipos dinâmicos.
  - **`exam-proposals-section.tsx`**: Painel de sugestões de extração por IA.
  - **`exam-result-form.tsx`**: Lançamento de resultados, correções e conferência de evidência/laudo.

#### 6. Balanço de Impacto
- **-8.873 linhas líquidas removidas** no repositório.
- **Zero regressão funcional**: Regras de validação, integridade de dados, contratos de API e testes automatizados 100% íntegros.

---

## 🧪 Como Executar e Verificar

### Execução Local

1. Configure as variáveis de ambiente:
   ```sh
   cp .env.example .env.local
   ```
2. Instale as dependências e inicie o servidor:
   ```sh
   npm ci
   npm run dev
   ```

### Verificação de Tipos e Testes Automatizados

```sh
# Verificação estrita de TypeScript (0 erros)
npm exec tsc -- --noEmit

# Testes de unidade e banco de exames (regras clínicas, LOINC/FHIR, IA e RLS)
npm run test:exams

# Teste de emissão do receituário médico em PDF (2 vias A4)
node tests/prescription-pdf.test.mjs

# Build de produção do Next.js (validação completa de páginas e rotas dinâmicas)
npm run build
```

---

## 📚 Documentação Complementar

- [EXAMES.md](./EXAMES.md): Detalhes técnicos, modelos de IA suportados, validações clínicas e catálogo de exames.
- [OPERACAO_SEGURA.md](./OPERACAO_SEGURA.md): Protocolos de MFA, backup criptografado, controles de acesso e diretrizes de auditoria.
- [SUPABASE_MIGRATION.md](./SUPABASE_MIGRATION.md): Histórico da migração para o Supabase e pendências do legado.
