# Sincronização da biblioteca

A aba **Maintenance → Library Sync** na web e a tela **More → Library synchronization** no mobile iniciam trabalhos duráveis no servidor. Fechar a tela não interrompe a execução. A atualização do progresso usa consultas periódicas; não depende de manter uma conexão aberta.

## Rotinas

- **Duplicatas perceptuais:** a geração `sscd-temporal-v4` indexa cada vídeo uma vez e usa recuperação global com coerência temporal para propor candidatos antes da verificação espacial. A revisão de apresentação `relevance-v1` separa cópias prováveis, clips contidos e sobreposição relevante das sugestões opcionais de similaridade. O escopo atual cobre material em velocidade fixa; edições que alteram a velocidade de reprodução não têm suporte.
- **Rostos:** usa a fila de extração existente. Um trabalho concluído com zero rostos conta como processado. Falhas anteriores podem ser tentadas novamente.
- **Prévias da timeline:** gera storyboard e VTT quando não existe um conjunto de arquivos válido. Não se trata de transcrição ou legendagem do áudio.

A execução manual captura os IDs disponíveis naquele momento. O progresso separa itens concluídos, falhos e ignorados. Uma nova execução verifica novamente as pendências e reutiliza artefatos válidos da geração atual. A troca da geração perceptual invalida apenas os checkpoints e resultados perceptuais; o progresso válido de rostos e storyboards permanece. As mídias originais não são removidas por essas rotinas.

Cancelar impede os próximos itens e interrompe o worker perceptual. Uma extração de rostos ou
geração de storyboard já iniciada pode concluir, pois esses serviços podem compartilhar a mesma
execução com outra solicitação. O cancelamento não desfaz os artefatos já publicados.

## Vídeos novos

A análise perceptual vem habilitada por padrão por `PERCEPTUAL_DUPLICATES_ENABLED=true`. O operador pode desabilitá-la sem afetar rostos ou timeline; nesse estado, o servidor responde `COPY_ENGINE_NOT_READY` e jobs perceptuais param antes de decodificar mídia. O backlog continua sendo iniciado somente por ação explícita do usuário. A automação para vídeos novos é uma configuração separada, `library_sync_auto_perceptual`, desabilitada por padrão. Ao ativá-la, o servidor registra o maior ID existente como ponto de partida: isso não dispara o backlog. Somente novos cadastros pelo watcher e por renders entram na fila, e reativar a opção começa dos vídeos novos a partir daquele momento.

O primeiro vídeo de um catálogo vazio publica descritores e passa a compor o índice global. Os seguintes consultam os membros já publicados. A cobertura da biblioteca cresce somente quando o backlog é executado manualmente; ativar a automação não analisa os arquivos antigos que ficaram fora da geração atual. Depois de uma troca de geração, a tela sinaliza essas pendências para que o usuário inicie a varredura manual.

## API

Todos os endpoints exigem autenticação e operam sobre a biblioteca compartilhada:

- `GET /api/library-sync`: pendências, configuração, geração atual, execução ativa e histórico recente.
- `POST /api/library-sync/runs` com `{"tasks":["perceptual","faces","storyboards"]}`: inicia o backlog selecionado.
- `GET /api/library-sync/runs/:id`: consulta progresso persistido.
- `DELETE /api/library-sync/runs/:id`: solicita cancelamento.
- `PATCH /api/library-sync/settings` com `{"auto_perceptual":true}`: configura vídeos novos.
- `GET /api/library-sync/perceptual-results?view=copies&limit=20&offset=0`: consulta resultados da geração atual sem caminhos privados. `view=similarity` mostra apenas sugestões opcionais; o padrão é `copies`. A paginação é aplicada depois da classificação e da deduplicação. Para pares repetidos, prevalece a publicação válida mais recente por `mtime`, com ID apenas como desempate; uma avaliação antiga não reaparece em outra aba quando uma publicação mais recente muda a classificação.

Cada execução informa `generation`. Checkpoints de outra geração perceptual não são retomados como se fossem atuais. Uma execução antiga que também continha rostos ou storyboards conserva o progresso dessas rotinas e refaz somente a etapa perceptual necessária.

## Classificação dos resultados salvos (`relevance-v1`)

A política é independente da revisão do extrator. Consultar a listagem não executa FFmpeg, inferência ou gravações no cache. Os resultados brutos permanecem disponíveis para auditoria, sem receber retrospectivamente um selo de validação humana.

Cada match visível recebe `assessment` com revisão, classe, grupo, motivos, cobertura estimada dos dois vídeos, segundos estimados e `segment_indices`. Estes índices selecionam os intervalos originais que sustentam a classificação; a interface não deve apresentar hipóteses conflitantes como uma sequência única. O estado antigo `verified` significa apenas que passou nos testes do motor.

Cutoffs conservadores da política inicial (heurísticas de apresentação, não probabilidades):

| Classe | Critério sobre intervalos temporalmente compatíveis |
| --- | --- |
| `near_duplicate` | Evidência verificada com pelo menos 90% de cobertura nos dois arquivos |
| `contained_clip` | Evidência verificada cobrindo pelo menos 85% do menor e 8 s na sua linha temporal; fonte menor com pelo menos 10 s |
| `partial_overlap` | Evidência verificada com pelo menos 60 s em ambos e 5% de cobertura em ambos |
| `similarity` | Para revisão opcional: pelo menos 8 s e 25% do vídeo menor, sem atender aos critérios anteriores |
| `shared_fragment` / `insufficient_evidence` | Não aparece nas duas listas; permanece nos artefatos brutos |

Usa-se a união de intervalos de um alinhamento temporal compatível, sem preencher lacunas entre segmentos. Isso não remove as incertezas internas dos intervalos antigos, inferidos a partir de amostras. A UI mostra **cobertura estimada**. A correspondência do cenário/pessoa e a localização no início não são prova de intro: não há descarte cego dos primeiros segundos. A detecção geral de conteúdo recorrente permanece fora desta entrega.

A camada retorna `assessment_revision` e `diagnostics` globais, independentes da página/filtro: vídeos com recuperação limitada, pares com verificação limitada, vídeos cuja publicação foi truncada e matches suprimidos por relevância. `retrieval_limited_videos`, `candidate_limited_pairs` e `truncated_matches` indicam incompletude mesmo quando a página ou a lista filtrada está vazia. Uma lista vazia não comprova ausência de duplicatas.

Clientes web/mobile sem metadados de avaliação mostram resultados antigos apenas como evidência que precisa de revisão. Trocar entre cópias e similaridade reinicia a paginação.

## Cache e custo

O motor reutiliza VAAPI para decode e MIGraphX para inferência SSCD em FP32. Cada amostra a 1 fps gera 11 vistas: o quadro inteiro, cinco faixas verticais e cinco faixas horizontais. O cache persiste esses descritores em FP16 para reduzir espaço; eles voltam a FP32 para normalização, busca e verificação. A confirmação espacial usa CPU com paralelismo limitado. A indexação e a busca seguem o agendador de mídia; um lock de arquivo protege o cache perceptual entre processos.

`COPY_CACHE_MAX_BYTES` limita o cache a **128 GiB por padrão**, sem reservar esse espaço antecipadamente, e mantém uma reserva de 1 GiB livre no volume. O custo de 11 descritores por segundo continua substancial em bibliotecas grandes. O orçamento é compartilhado com a comparação manual de vídeos. Ao esgotá-lo, o worker falha explicitamente e nunca apaga mídia.

`catalog.json`, resultados, journals e o índice global ficam no cache privado. Manifestos e shards são publicados por troca atômica sob o lock. A identidade das fontes e a revisão/modelo invalidam artefatos antigos; membros ausentes ou divergentes voltam a aparecer como pendentes. Resultados referentes a fontes editadas, removidas, indisponíveis ou a outra geração não são expostos como evidência atual.

A geração `sscd-temporal-v4` mantém o índice global no diretório `retrieval-v4`. Âncoras temporais esparsas recuperam hipóteses de deslocamento em velocidade fixa; somente janelas coerentes seguem para refinamento e verificação. A consulta é decodificada a 1 fps e a referência a 5 fps. A verificação usa âncoras SIFT independentes e reaproveita uma transformação aceita apenas quando os testes fotométricos e de continuidade temporal também passam. O orçamento é adaptativo, com teto de 128 janelas por par. A API informa quando a recuperação, a verificação ou a publicação atingiu limites. A tela não oferece exclusão automática baseada em semelhança.

A verificação para assim que reúne evidência suficiente para uma classe útil ou alcança o teto. Por
isso, uma cópia integral longa pode aparecer apenas como `partial_overlap` sobre a porção realmente
confirmada. O sistema não promove esse resultado a `near_duplicate` a partir de amostras esparsas;
os diagnósticos de limite permanecem visíveis.

Arquivos da geração anterior deixam de ser evidência atual e exigem uma nova varredura manual do backlog. Essa mudança não reinicia trabalhos de rostos ou storyboards e não dispara automaticamente toda a biblioteca.

## Histórico: validação da implementação original

- Backend: suíte unitária completa (101 arquivos), contratos de rotas/demo e seis cenários de integração em PostgreSQL descartável.
- Catálogo: 107 testes Python e execução real em GPU pelo runner do servidor, usando duas cópias privadas do piloto. O primeiro vídeo publicou seu índice; o segundo foi comparado com ele e retornou um trecho verificado.
- Kura: typecheck e lint da raiz passaram, mantendo os limites de avisos existentes; suíte completa com 136 testes mobile, 30 web, 18 de domínio e cinco de dependências. Build web e fluxo Playwright sintético passaram; layout conferido em desktop e 390 px sem overflow horizontal.
- Mobile: exportação Expo Android concluída (bundle Hermes). Isso verifica empacotamento, não instalação ou comportamento em aparelho; não houve validação em dispositivo nesta execução.
- Os testes de fila não dispararam o backlog real. Os arquivos originais da biblioteca não foram alterados.

## Histórico: validação de `relevance-v1`

O [relatório B0](spikes/perceptual-relevance-b0-2026-09-21.md) registra o replay real da geração anterior (1 report principal, 1 similaridade opcional e 16 suprimidos), testes de backend e interfaces e os limites daquela entrega. O [preflight B1](spikes/video-duplicate-b1-preflight-2026-09-21.md) registra a reprovação do VDF para o escopo completo sem executar mídia. Esses números não medem o motor atual.

## Histórico: geração v3 não promovida

Arquitetura, métricas, falhas dos gates e limites medidos da geração experimental
`sscd-hnswsq8-dense-v3` pertencem ao
[relatório v3](spikes/video-duplicate-redesign-v3-2026-09-21.md). O piloto acumulou
1.606,964602 s de trabalho pesado, 9.464,062364 s de mídia decodificada e 2.926.165.818 bytes de
saída. A primeira consulta sentinela concluiu em 177,248775 s, sem match, com recuperação truncada
e um par limitado pela verificação; uma consulta sentinela subsequente foi interrompida durante a
verificação. As 24 variantes reservadas foram indexadas, mas não consultadas. Esses resultados
reprovaram especificamente a geração v3 e não descrevem a operação da v4.

## Evidências da geração atual

O [relatório v4](spikes/video-duplicate-redesign-v4-2026-09-21.md) registra os testes reais,
negativos históricos, custos medidos e limites da geração em operação.

A confirmação normaliza cada par pela linha temporal do vídeo menor, mantendo os IDs,
intervalos e coberturas na orientação original da API. Isso cobre também a inclusão de uma
gravação completa depois dos seus clips já catalogados.
