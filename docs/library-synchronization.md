# Sincronização da biblioteca

A aba **Maintenance → Library Sync** na web e a tela **More → Library synchronization** no mobile iniciam trabalhos duráveis no servidor. Fechar a tela não interrompe a execução. A atualização do progresso usa consultas periódicas; não depende de manter uma conexão aberta.

## Rotinas

- **Duplicatas:** a geração `audio-visual-v1` extrai uma impressão Chromaprint por vídeo e, ao fim do laço, compara de uma vez todas as impressões novas com a biblioteca; alinhamentos de áudio relevantes são confirmados nos quadros. Detalhes em [detecção de duplicatas](perceptual-video-duplicates.md). A revisão de apresentação `relevance-v1` separa cópias prováveis, clips contidos e sobreposição relevante das sugestões opcionais de similaridade. Edições que alteram a velocidade de reprodução não têm suporte.
- **Rostos:** usa a fila de extração existente. Um trabalho concluído com zero rostos conta como processado. Falhas anteriores podem ser tentadas novamente.
- **Prévias da timeline:** gera storyboard e VTT quando não existe um conjunto de arquivos válido. Não se trata de transcrição ou legendagem do áudio.

A execução manual captura os IDs disponíveis naquele momento. O progresso separa itens concluídos, falhos e ignorados. Uma nova execução verifica novamente as pendências e reutiliza artefatos válidos da geração atual. A troca da geração perceptual invalida apenas os checkpoints e resultados perceptuais; o progresso válido de rostos e storyboards permanece. As mídias originais não são removidas por essas rotinas.

Cancelar impede os próximos itens e interrompe a extração ou a comparação em andamento; pares já decididos permanecem salvos. Uma extração de rostos ou
geração de storyboard já iniciada pode concluir, pois esses serviços podem compartilhar a mesma
execução com outra solicitação. O cancelamento não desfaz os artefatos já publicados.

## Vídeos novos

A detecção de duplicatas vem habilitada por padrão por `COPY_DETECTION_ENABLED=true`. O operador pode desabilitá-la sem afetar rostos ou timeline; nesse estado, o servidor responde `COPY_ENGINE_NOT_READY` e jobs perceptuais param antes de decodificar mídia. O backlog continua sendo iniciado somente por ação explícita do usuário. A automação para vídeos novos é uma configuração separada, `library_sync_auto_perceptual`, desabilitada por padrão. Ao ativá-la, o servidor registra o maior ID existente como ponto de partida: isso não dispara o backlog. Somente novos cadastros pelo watcher e por renders entram na fila, e reativar a opção começa dos vídeos novos a partir daquele momento.

Um vídeo novo é comparado com todas as impressões já extraídas. A cobertura da biblioteca cresce somente quando o backlog é executado manualmente; ativar a automação não analisa os arquivos antigos que ficaram fora da geração atual. Depois de uma troca de geração, a tela sinaliza essas pendências para que o usuário inicie a varredura manual.

## API

Todos os endpoints exigem autenticação e operam sobre a biblioteca compartilhada:

- `GET /api/library-sync`: pendências, configuração, geração atual, execução ativa e histórico recente.
- `POST /api/library-sync/runs` com `{"tasks":["perceptual","faces","storyboards"]}`: inicia o backlog selecionado.
- `GET /api/library-sync/runs/:id`: consulta progresso persistido.
- `DELETE /api/library-sync/runs/:id`: solicita cancelamento.
- `PATCH /api/library-sync/settings` com `{"auto_perceptual":true}`: configura vídeos novos.
- `GET /api/library-sync/perceptual-results?view=copies&limit=20&offset=0`: consulta resultados da geração atual sem caminhos privados. `view=similarity` mostra apenas sugestões opcionais; o padrão é `copies`. Cada par aparece uma vez, agrupado sob o vídeo mais longo (uma live reúne todos os seus clips). A paginação é aplicada depois da classificação.

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

A camada retorna `assessment_revision` e `diagnostics` globais, independentes da página/filtro. A geração atual não tem truncamento de recuperação nem teto de candidatos; `suppressed_matches` conta pares ocultados pela política de relevância. Uma lista vazia não comprova ausência de duplicatas: vídeos sem áudio, com trilha substituída ou velocidade alterada não são recuperados.

Trocar entre cópias e similaridade reinicia a paginação.

## Armazenamento e custo

As impressões ficam em `video_audio_fingerprints` (~4 bytes por 0,124 s de áudio; ~200 MB para
toda a biblioteca) e as decisões em `video_copy_pairs`. O único arquivo em disco é o pacote
temporário das impressões entregue ao worker durante a comparação, criado em
`COPY_DETECTION_CACHE_DIR` com modo `0600` e removido ao final. A primeira passada é limitada pela
leitura do HDD (~6 h para ~2,9 TB); passadas seguintes só extraem vídeos novos ou alterados.
