# Primeira entrega: classificação dos resultados perceptuais existentes

Data: 21/09/2026. Política: `relevance-v1`. Etapa B0 do [plano revisado](../plans/video-duplicate-detection-redesign-2026-09-21.md), iniciada após autorização do usuário.

## Resultado verificável

Replay somente dos JSON existentes, sem FFmpeg, inferência ou escrita no cache:

| Grupo | Resultado |
| --- | --- |
| Lista principal | 1 par: 179/180, sobreposição relevante |
| Similaridade opcional | 1 par: 38/42 |
| Suprimidos por relevância | Os outros 16 reports do incidente |
| Universo do replay | 134 resultados publicados, 8.911 comparações contabilizadas e 18 reports distintos |
| Busca limitada registrada | 96 pares; nenhum resultado publicado com truncamento de matches neste snapshot |

Uma execução medida do processo CLI completo levou **0,079 s**, usando relógio monotônico e cache já existente. Não é medição do tempo da API com consultas ao banco/identidade dos arquivos, nem estimativa de indexação ou busca. A energia total não foi medida; não foi iniciado trabalho de mídia/GPU.

A saída reproduz os rótulos conhecidos. É regressão sobre dados usados no desenvolvimento, **não teste cego nem estimativa de precisão/recall no restante da biblioteca**.

## Implementação

- O backend reavalia relevância durante a leitura do catálogo; mantém o extrator e os dados brutos existentes. Revisão da política separada da revisão do índice.
- A listagem usa `view=copies` por padrão e `view=similarity` explicitamente. Classificação/deduplicação precedem paginação. Para pares repetidos, prevalece a publicação válida mais recente por `mtime`; o ID só desempata datas iguais. Conteúdo e data são lidos do mesmo descritor de arquivo. Metadados privados de arquivos não são retornados.
- A política distingue cópia provável, clip contido e sobreposição parcial. Containment usa a cobertura do menor vídeo, sem exigir que um clip represente percentual relevante de uma live inteira.
- Cobertura é calculada pela união de intervalos de um alinhamento temporal compatível. Não soma hipóteses conflitantes nem preenche lacunas entre segmentos. A saída inclui `segment_indices`, e a interface mostra os intervalos selecionados.
- Hipóteses concorrentes para o mesmo trecho, verificadas nos dois lados do par, impedem promoção automática à lista principal. O par 38/42 continua disponível para revisão, com cobertura do alinhamento selecionado e aviso de conflito.
- Diagnósticos globais de busca limitada/publicação truncada continuam visíveis mesmo quando o filtro/paginação não apresenta matches. A lista vazia não declara inexistência de cópias.
- Web/mobile separam cópias prováveis de similaridade, apresentam cobertura estimada e tratam resultados sem avaliação nova como evidência antiga que precisa de revisão.

Os cutoffs e o contrato estão no [guia de sincronização](../library-synchronization.md). São heurísticas conservadoras de apresentação, calibradas no incidente. Não há regra por ID/título de vídeo no código de produção.

## Reprodução

A partir da raiz do backend:

```bash
bun scripts/replay-perceptual-relevance.ts --cache-dir data/perceptual-duplicates-cache
```

A saída padrão é JSON no stdout, contendo IDs, classes e contagens, sem títulos, caminhos ou identidades. `--output` aceita somente um arquivo novo fora do cache; não sobrescreve arquivos existentes. A fixture de regressão contém exclusivamente metadados numéricos dos 18 pares, sem mídia ou caminhos.

O replay avalia o snapshot do cache. A API, adicionalmente, verifica disponibilidade/identidade das fontes antes de apresentá-las. Não interpretar o replay como certificação de disponibilidade atual de mídia.

## Validação do backend

- 12 testes da política: intro compartilhada, clip de 30 s em live de 2 h em ambas as direções, clip no início, piso de 10 s, sobreposição, similaridade, lacunas, duplicação de intervalos, velocidade, limites inválidos e alinhamentos concorrentes.
- 4 testes da leitura do catálogo com arquivos sintéticos: seleção/paginação, avisos na página vazia, preservação dos bytes de fontes/cache e precedência da publicação mais recente, inclusive quando ela tem ID menor ou suprime uma cópia anterior.
- 6 testes de replay: regressão do incidente, ausência de metadados privados, deduplicação por publicação mais recente, CLI, saídas protegidas e entradas inválidas.
- Contratos relacionados: 2 testes de catálogo, 6 de rotas de sincronização, 5 de rotas perceptuais e 6 do runner, incluindo cancelamento com subprocesso sintético.
- 7 testes de integração da fila passaram em PostgreSQL descartável, com adaptadores de mídia simulados. Nenhuma fila real foi disparada.
- TypeScript e ESLint do backend passaram.

## Validação das interfaces

- `pnpm typecheck` na raiz do Kura: 7/7 tarefas passaram.
- `pnpm lint`: zero erros; 36 avisos web e 41 mobile dentro dos baselines existentes, sem novos avisos.
- Jest mobile focado na sincronização: 5/5 testes passaram.
- Playwright Chromium, `e2e/library-sync.spec.ts`, com dados sintéticos: 1/1 passou. Exercita alternância entre listas, paginação, avisos de limite, evidência legada e segmentos da avaliação.
- Não houve validação em aparelho mobile nem navegação na biblioteca real. Os testes de interface não certificam precisão do detector.
- O replay também comparou tamanho e mtime das 139 entradas no diretório raiz do cache antes/depois: inalterados. O script só leu JSON, sem acessar as mídias.

## Limites e decisão sobre a próxima alternativa

Esta entrega corrige a classificação de resultados disponíveis. **O motor de descoberta ainda não foi substituído:** a busca pareada antiga continua no código, e a detecção geral de conteúdo recorrente, recall de crop/clip e escalabilidade permanecem pendentes. Os testes sintéticos de timestamps validam a decisão sobre evidência fornecida, não a capacidade de descobrir essa evidência em mídia.

A [pré-checagem do VDF](video-duplicate-b1-preflight-2026-09-21.md) reprovou B1 como motor para o escopo completo, antes de qualquer execução com mídia: amostragem insuficiente para o compromisso de clips curtos, busca parcial pareada e ausência de consulta incremental delimitada. Nenhuma dependência nova foi instalada para esse ensaio.

B2 exige um desenho de recuperação que reduza candidatos antes da comparação, seguido pelo piloto limitado e pelos gates de qualidade/custo do plano. Não se libera o backlog porque a lista antiga ficou limpa. Nenhuma configuração persistida de automação, mídia original ou run cancelado foi alterado nesta etapa. Não houve commit, push ou reinício de serviço por esta implementação.
