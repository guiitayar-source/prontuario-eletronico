# Anamnesator nativo e áudio privado

## Fluxo implementado no código

No atendimento, abra Anamnesator → Celular e textos salvos → Vincular app ao atendimento.
No Android, o botão abre o pacote com.anamnesator.android; no notebook, leia o QR pelo app Android.
O QR concede uma autorização limitada para devolver texto desse atendimento. Não contém a chave do PC de casa.

O Android confirma o paciente, utiliza o perfil PC de casa já pareado e grava em arquivo privado.
Ao finalizar, aguarda o MediaRecorder fechar o arquivo e envia o áudio diretamente ao PC de casa
pelo Tailscale. Após salvar a transcrição localmente, devolve somente texto ao PsyWrite.
O rascunho Ollama também retorna como texto após a geração solicitada pelo usuário.

Celular e notebook consultam os rascunhos salvos a cada cinco segundos enquanto o painel está visível.
A incorporação à evolução depende do botão de acrescentar e da revisão médica.
Resultados tardios permanecem separados da evolução, inclusive se o atendimento foi finalizado.

A transcrição obtida no notebook pela ponte local também é salva como rascunho compartilhado.
Se o salvamento falhar, o texto continua visível e o botão Salvar texto no PsyWrite permite tentar novamente.
O áudio e o texto ainda não salvos dessa sessão web permanecem em memória: não feche a página antes de confirmar o salvamento.
Os seletores do PsyWrite oferecem somente provedores privados; as opções API do app desktop independente continuam disponíveis.

## Limites de confiança

- Pareamento: capacidade aleatória de 256 bits; validade de 10 minutos, uso por um dispositivo.
- Retorno: outra capacidade, gerada pelo app; validade de 8 horas e limitada ao resultado do atendimento.
- O banco guarda hashes das capacidades. Consultas autenticadas não têm acesso às colunas dos hashes.
- A criação exige médico autorizado, segundo fator e autoria da consulta. Uma nova autorização Android revoga a anterior, preservando textos já recebidos.
- Encerrar autorização revoga imediatamente o retorno. Remover o solicitante da equipe também bloqueia o retorno.
- O endpoint nativo rejeita Origin de navegador, aceita somente JSON de texto e não oferece armazenamento de áudio ou leitura do prontuário.
- O app envia texto somente para https://psywrite.vercel.app, sem seguir redirecionamentos.
- O destino de áudio remoto deve resolver para IPv4 Tailscale; o cliente usa o IP resolvido e rejeita destinos fora de 100.64.0.0/10.
- O link Android usa intent com pacote explícito. Há confirmação do paciente no app; QR pode ser lido diretamente no scanner do app.
- A biblioteca e a fila de texto ficam no armazenamento interno privado do Android; backup do app está desabilitado.
- Tentativas repetidas têm revisão monotônica. Uma revisão antiga não substitui a mais recente.
- A auditoria registra ação, solicitante e pedido; não registra áudio, conteúdo do texto ou capacidades.

O fluxo mantém o áudio fora da infraestrutura do PsyWrite. Transcrições e rascunhos são dados clínicos
e ficam no banco protegido do prontuário. Ele não elimina riscos de um dispositivo ou aplicação comprometidos.

## Recuperação

O Android preserva áudio e resultados locais. Se o retorno ao PsyWrite falhar, o texto entra numa fila
persistente e é reenviado ao reabrir o app ou usar Reenviar textos pendentes.
Se a autorização expirar, gere outro vínculo para o mesmo atendimento e abra-o no app:
o resultado da consulta local selecionada pode ser enviado com a nova autorização.
Desvincular deste aparelho remove o envio pendente daquela consulta, preservando áudio e textos;
para revogação no servidor, encerre a autorização pelo prontuário.
Processos mortos pelo Android podem interromper a gravação/processamento; o comportamento com
tela bloqueada, rotação, troca de app e retomada precisa de validação no celular real.

## Colocar em funcionamento

1. Aplicar supabase/migrations/20261012010000_anamnesator_native.sql no ambiente de destino.
2. Publicar a versão correspondente do PsyWrite. As rotas nativas utilizam a credencial de servidor já usada pelo projeto.
3. Instalar o APK correspondente de anamnesator-android. Uma instalação existente precisa ter assinatura compatível para atualização sem apagar a biblioteca.
4. Conectar o celular ao Tailscale e parear uma vez o perfil PC de casa pelo QR do Anamnesator desktop.
5. Validar o fluxo completo com áudio fictício, inclusive retorno sem conexão, autorização expirada,
   cancelamento, atendimento trocado e evolução já finalizada.

Nenhuma configuração HTTPS ou CORS nova é necessária no PC de casa, nem abertura de portas públicas.
O servidor remoto existente permanece na porta privada 8766; o navegador do notebook continua usando somente a ponte local 8767.

Validação local: npm run test:anamnesator, npm run test:signature-flow, TypeScript, lint e build;
no projeto Android: :app:assembleDebug e :app:testDebugUnitTest.
Aplicação da migração, publicação e validação com celular são etapas separadas da verificação local.
