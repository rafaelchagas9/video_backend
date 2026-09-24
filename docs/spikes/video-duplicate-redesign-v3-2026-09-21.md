# Redesenho de duplicatas: implementação e avaliação

Data: 21/09/2026. Estado: **sem aprovação para varrer o catálogo completo**. Este relatório descreve uma implementação experimental, não uma garantia de precisão ou custo de produção. A liberação de processamento perceptual fica desabilitada por padrão; as rotinas de rostos e storyboard/VTT continuam independentes.

## O problema, sem depender da conversa

O Kura precisa encontrar uma gravação copiada ou um clip contido em uma live, incluindo reencodes, resoluções diferentes e crops fixos. Compartilhar pessoa, estúdio, roupa, abertura ou alguns frames não torna duas gravações duplicatas úteis. A biblioteca tem aproximadamente 1.669 horas; a máquina tem Ryzen 5 5600G, 32 GiB de RAM e Radeon RX 7800 XT.

O motor anterior consumiu cerca de três horas para processar a primeira centena de vídeos, com cinco falhas relatadas. Nos artefatos auditados havia 134 entradas e 8.911 comparações entre pares. Dos 18 reports, o usuário confirmou um como cópia (179/180), aceitou um como similaridade (38/42) e considerou 16 indesejados. Esses 16 pertencem a apenas cinco famílias; as outras comparações sem report não são negativos rotulados. O motor inferia trechos a partir de poucas amostras e fazia comparação exaustiva entre índices de vídeos.

O plano e o parecer exigiram duas correções independentes: classificar relevância sem promover intros ou baixa cobertura a duplicatas; e medir recuperação/custo de uma arquitetura que não compare todos os pares de vídeos. Os positivos de clip-em-live disponíveis para teste são transformações sintéticas de fontes reais. Não existe neste conjunto um corpus independente de clips naturais rotulados.

## Implementação

- A apresentação mantém a política `relevance-v1`: cópia quase integral, clip contido e sobreposição relevante ficam separados de similaridade opcional. Lacunas e alinhamentos incompatíveis não são somados como cobertura contínua. O replay histórico permanece uma ferramenta de auditoria.
- O extrator usa 11 vistas a 1 fps: quadro inteiro, cinco recortes ao longo da largura e cinco ao longo da altura. VAAPI decodifica e MIGraphX executa SSCD em FP32. Armazenar os descritores em FP16 economiza disco; não muda a precisão da inferência. O caminho frio e o cache aplicam a mesma normalização.
- A recuperação candidata final usa FAISS HNSW-SQ8, M=16, `efSearch=2048`, com shards e memória limitados. Todos os shards elegíveis participam do top-K global antes dos votos temporais. Resultados antigos e o próprio vídeo são filtrados antes da seleção. O modo exato só atende ao bootstrap pequeno. **O custo de pesquisar muitos shards continua sendo uma limitação de produção.**
- A confirmação usa geometria local e evolução temporal dos pixels. Observa a consulta a 1 fps e a referência a 5 fps, em janelas sobrepostas de 15 segundos. Após confirmar uma semente, pode verificar frames vizinhos; esses frames só acrescentam cobertura se passarem pelas mesmas provas. O alinhamento suportado tem velocidade constante 1×; ajustes locais de offset não prometem suporte a mudança de velocidade.
- O número de janelas é adaptativo, com teto de 128. Um vídeo longo que seja cópia integral pode ser apresentado apenas como sobreposição parcial, porque somente a parcela efetivamente confirmada entra na cobertura. Nenhuma amostragem esparsa recebe retrospectivamente o selo de vídeo inteiro duplicado.
- A geração de resultados é `sscd-hnswsq8-dense-v3`. O identificador interno de cache de descritores permanece `sscd-ivfpq-dense-v3`, um nome histórico opaco independente do codec de busca; isso permite reaproveitar os descritores já extraídos sem promover decisões antigas. O índice de recuperação tem diretório próprio `retrieval-v3-hnsw`.
- Web/mobile expõem pendências da nova geração e incompletude inclusive em listas vazias. Migração de checkpoints preserva rostos/VTT, cancelamentos e cursores independentes. Backlog é manual; ativação automática, quando o motor estiver habilitado, considera somente cadastros novos. Não houve reinício de serviços, escrita no banco de produção nem disparo do backlog real nesta avaliação.

## Alternativas medidas e descartadas

O Video Duplicate Finder foi inspecionado antes de qualquer ensaio de mídia. O [preflight B1](video-duplicate-b1-preflight-2026-09-21.md) registra o commit e as fontes: a configuração aceita a razão de duração necessária, mas a grade visual de uma live de duas horas chega a 18 s, exige quatro hits e não sustenta o piso de clip de 10 s. A comparação parcial ainda enumera pares de vídeos e a CLI não oferece a consulta assimétrica necessária ao fluxo incremental. Por isso não houve instalação nem piloto de mídia desse candidato. Isso é reprovação dos requisitos de desenho, não uma medição de sua precisão real.

Todas as auditorias abaixo usam os mesmos 32 descritores de desenvolvimento e 1.007.514 descritores de referência previamente extraídos, distribuídos em 134 vídeos. A busca exata foi executada em blocos. “Temporal ±2 s” aceita outra vista do mesmo vídeo nesse intervalo; é uma métrica mais permissiva, apresentada ao lado da identidade exata, não em substituição a ela. São medidas de vizinhos, não de cópias confirmadas.

| Índice e configuração | Recuperação de IDs exatos | Recuperação temporal ±2 s | Busca de 32 descritores |
| --- | ---: | ---: | ---: |
| IVF-PQ, nprobe 256, K=128 | 47,29% | 69,56% | 1,21 s |
| IVF-SQ8, nprobe 512, K=128 | 92,36% | 96,39% | 1,72 s |
| HNSW-SQ8, M16, ef2048, K=128 | 94,17% | 96,39% | 0,065 s |
| HNSW-SQ8, M16, ef4096, K=128 | 95,95% | 98,10% | 0,164 s |
| HNSW-PQ, L2, M8, ef8192, K=2048 | 28,91% | 72,24% | 0,435 s |

HNSW-SQ8 construiu o milhão de descritores em 86,0 s, produziu 661.194.838 bytes de índice e teve pico de RSS de aproximadamente 1,16 GiB no harness. HNSW-PQ/L2 produziu 146.177.907 bytes, mas não preservou recuperação suficiente mesmo consultando 16 vezes mais vizinhos.

Houve ainda uma tentativa HNSW-PQ com produto interno na versão 1.12.0 do FAISS. A busca no grafo recuperava apenas 9,3% dos vizinhos da própria busca PQ plana. A inspeção da implementação identificou a combinação de distâncias de consulta por produto interno com a tabela simétrica de distâncias L2 usada pelo PQ. Essa tentativa foi descartada como incompatibilidade do caminho de implementação; não foi contabilizada como evidência de incapacidade intrínseca da compressão PQ. A tentativa L2 subsequente foi medida separadamente.

Qdrant e PostgreSQL/pgvector foram avaliados documentalmente como alternativas de operação. Não houve instalação de outro serviço. O [parecer de alternativas de armazenamento](video-duplicate-retrieval-alternatives-2026-09-21.md) registra os requisitos de memória, disco, GPU e consistência.

## Limites da decisão de escala

O snapshot disponível contém aproximadamente 1.669 horas. Onze descritores por segundo representam cerca de 66 milhões de vetores. Extrapolar a latência de um shard para consultar todos os shards de cada vídeo não demonstra um backlog de até 24 horas. A alternativa precisa manter recuperação, RAM, disco, publicação atômica e custo de consultas simultaneamente; uma boa medição de 1 milhão de vetores não prova esse conjunto de condições.

Os índices por grafo comprimidos que poderiam caber globalmente na RAM não passaram pela auditoria de recuperação. O grafo SQ8 passou pela auditoria restrita, mas precisaria de dezenas de GiB como índice único, além do restante do aplicativo. Dividi-lo em shards limita a RAM por processo e multiplica as buscas. Não há nesta avaliação uma projeção aprovada que permita liberar o backlog completo.

Energia total na tomada não foi medida. Não há estimativa de kWh ou de economia de energia. Tempo pesado, mídia decodificada e volume de derivados são os limites observáveis do piloto. As fontes originais permanecem intactas; todos os experimentos usam saídas privadas e cache isolado.

## Resultados finais de mídia e testes

**Decisão final: reprovar a promoção do motor experimental.** A recuperação de candidatos melhorou na auditoria limitada, mas a confirmação ainda não demonstrou confiabilidade e custo aceitáveis. Não existe resultado final aprovado de precisão/recall de cópias na biblioteca.

| Etapa | Resultado observado | O que permite concluir |
| --- | --- | --- |
| Desenvolvimento: 4 fontes reais × 6 variantes | 24/24 fontes recuperadas; 21/24 consultas com correspondência verificada cobrindo pelo menos 85% da consulta em uma rodada intermediária | Prova de funcionamento parcial, com parâmetros ajustados neste conjunto; não é avaliação independente nem resultado do código final |
| Crops difíceis do desenvolvimento | Falhas persistiram em crops de largura/altura, com cobertura parcial; tentativas posteriores também não resolveram todos os casos | Não há suporte confiável demonstrado para esses crops |
| Conjunto reservado: 4 fontes × 6 variantes | 24 variantes e 4 referências indexadas; **zero consultas de recuperação/confirmação executadas** | Nenhuma conclusão de qualidade em dados reservados |
| Sentinelas dos reports históricos, índice global de 134 vídeos | A primeira consulta usou a janela [8, 27) s de um vídeo de 35,33 s: terminou em 177,25 s, recuperou quatro referências e não confirmou matches, com truncamento e limites explícitos. A segunda consulta, janela [1360, 1874) s de outro vídeo, foi interrompida | Custo ponta a ponta reprovado nessa medição; uma consulta concluída não demonstra recuperação/rejeição dos 18 pares pelo novo motor |
| Otimização final de saída antecipada de janelas impossíveis | Testes automatizados passaram; nenhuma nova rodada de mídia depois da alteração | Não há medição que permita atribuir recuperação de desempenho a essa alteração |

Os 21/24 do desenvolvimento não devem ser comparados ao gate de 95% como se fossem um teste cego do candidato final. O índice global auditado reaproveitou seis vistas antigas por frame; isso mede a aproximação ANN nesse corpus, não a cobertura das onze vistas no catálogo completo. A preparação das variantes reservadas não as transforma em resultados avaliados. O replay B0 dos rótulos históricos é uma validação separada da política de apresentação, não uma confirmação nova da mídia.

O trabalho pesado ficou limitado a **1.606,964602 s (26 min 47 s)**, com **9.464,062364 s de mídia decodificada (2 h 37 min 44 s)** e **2.926.165.818 bytes (2,725 GiB)** de novas saídas ao encerrar o piloto. Os tetos eram 30 min, 4 h e 5 GiB, respectivamente. O tempo informado é processamento pesado contabilizado pelo harness, incluindo alternativas e repetições; não é o tempo total de desenvolvimento, revisão e testes. Houve um único trabalhador pesado por vez. O processo próprio foi interrompido e a checagem posterior encontrou zero processos FFmpeg. A medição não inclui energia elétrica, que permanece desconhecida.

A primeira sentinela recuperou as referências 51, 38, 47 e 50 para a consulta 42; portanto a referência conhecida 38 chegou à confirmação. O resultado registrou `retrieval_truncated=true`, `verification_limited_pairs=1` e `candidate_limited_pairs=1`. Zero matches nessa consulta limitada não equivale a ausência de conteúdo compartilhado. A duração isolada da segunda consulta interrompida não foi publicada, e não é inferida do tempo da primeira.

Os registros privados ficam em `data/perceptual-pilot/2026-09-21/redesign-v3/`: `protocol.json`, `budget.json`, `develop-results.json`, `develop-runtime.json`, as auditorias `ann-audit*.json`/`hnsw*-audit.json`, `reserved-index.log` e `sentinels.log`. O registro de desenvolvimento inclui hashes do código daquela rodada; alterações posteriores não herdam seus resultados. Não foram apagadas tentativas malsucedidas nem mídias originais. Um [resumo de métricas sem caminhos de mídia](video-duplicate-redesign-v3-2026-09-21-results.json) acompanha este relatório.

## Bloqueio operacional e entregas utilizáveis

`PERCEPTUAL_DUPLICATES_ENABLED=false` é o padrão da configuração e do exemplo de ambiente. O backend recusa novos pedidos perceptuais manuais e ativação automática com `COPY_ENGINE_NOT_READY`, não enfileira novos trabalhos automáticos e verifica a condição novamente antes de executar trabalhos duráveis. Web/mobile recebem a capacidade e o motivo do bloqueio. Rostos e storyboard/VTT continuam disponíveis; migração e retomada de trabalhos mistos preservam as etapas independentes.

O sinalizador permite testes controlados pelo operador, mas **não significa aprovação para o backlog**. Nenhum serviço em execução foi reiniciado nesta tarefa; o bloqueio passa a valer quando o código novo for carregado. A configuração do serviço existente e o banco de produção não foram alterados. Resultados e índices antigos não são aceitos como prova da geração nova. A correção de relevância e os diagnósticos de incompletude são entregas distintas da liberação do detector.

A suíte Python de duplicatas concluiu **88 testes aprovados**, incluindo recuperação, elegibilidade, persistência, alinhamento, movimento, cancelamento/erros e contratos do catálogo/manual. Os testes verificam invariantes e regressões construídas; não certificam precisão na biblioteca. O backend passou pelo typecheck e pelos 20 testes de relevância/replay/contrato, mais oito testes de apresentação e invalidação do catálogo. A revisão entre subagentes encontrou e corrigiu a aceitação de publicações com token de recuperação antigo e a validação incompleta do manifesto de busca. O backend exige identidade de descritores/token compatíveis, configuração do índice e arquivos necessários antes de considerar o cache atual.

Comandos focados reproduzíveis, sem uma rodada de mídia:

```bash
PYTHONDONTWRITEBYTECODE=1 vision-service/.venv/bin/python -m unittest discover -s vision-service/tests -p 'test_video_cop*.py'
bun run test:files -- tests/perceptual-relevance.test.ts tests/perceptual-relevance-replay.test.ts tests/perceptual-catalog.test.ts tests/perceptual-catalog-presentation.test.ts
bunx tsc --noEmit
```

Checagens finais de integração e interface, depois do bloqueio de prontidão:

| Verificação | Resultado |
| --- | --- |
| Typecheck do backend | Aprovado |
| Integração de sincronização | 13/13, incluindo retomada de etapas independentes e reativação sem backlog |
| Integração da comparação manual durável | 7/7, incluindo recusa antes de decodificar |
| Contratos de rotas de prontidão | 13/13 |
| Typecheck da raiz do Kura | 7/7 tarefas |
| Lint da raiz do Kura | Zero erros; 37 avisos mobile (teto 41), 36 web (teto 36) |
| Tela mobile de sincronização | 6/6 |
| Playwright da sincronização web | 2/2, incluindo detector bloqueado com rostos/timeline disponíveis |
| `git diff --check` nos dois repositórios | Aprovado |

A transição de desabilitado para habilitado grava uma nova referência de maior ID antes de admitir processamento automático. Vídeos adicionados durante o bloqueio continuam no backlog manual; o próximo cadastro novo pode entrar na fila. As atualizações dessa referência e a admissão usam o mesmo lock. A reativação da preferência automática publica a referência antes de habilitar a admissão.

As integrações usam PostgreSQL descartável; não o banco da biblioteca. Os cenários de interface usam respostas e mídias sintéticas. Esses testes não substituem validação em um aparelho Android físico nem um ensaio independente de qualidade de detecção.

## O que falta para uma solução liberável

O requisito original ainda não está concluído. O próximo gargalo é reduzir candidatos visualmente parecidos e o custo da confirmação antes de financiar outra varredura. A auditoria de vizinhos sozinha não resolve a seleção de trechos, e tornar o verificador mais permissivo para ganhar velocidade voltaria a aceitar cenários parecidos.

Uma futura promoção precisa demonstrar, no mesmo candidato congelado: recuperação e localização dos crops suportados; rejeição das famílias de falsos positivos; confirmação de clips naturais rotulados independentemente; custo ponta a ponta com distratores; e uma projeção explícita de RAM, disco e tempo para aproximadamente 66 milhões de descritores. A extração fria de onze vistas e o backlog em menos de 24 horas não foram validados. Reutilizar caches ou descartar a geração anterior é permitido pelo produto, mas não remove esses requisitos. Não foi iniciado outro piloto nem um processamento completo para tentar compensar a reprovação.
