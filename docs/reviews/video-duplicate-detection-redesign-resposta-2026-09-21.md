# Resposta técnica ao parecer de detecção de duplicatas

Data: 21/09/2026. Documento de origem: [parecer recebido](video-duplicate-detection-redesign-parecer-2026-09-21.md). Resultado: [plano atualizado, revisão 2](../plans/video-duplicate-detection-redesign-2026-09-21.md).

## Decisão documental

Incorporar os achados reproduzidos e corrigir as extrapolações que não podem ser tratadas como prova. O parecer original permanece inalterado. Esta resposta não aprova implementação, entrega de B0, novos ensaios de mídia ou retomada do backlog. O próprio parecer se identifica como interno e não cego; continua pendente a decisão do responsável sobre os próximos investimentos.

O diagnóstico central é mantido: houve falha na relevância dos reports, recall de clips em lives permanece desconhecido e o laço exaustivo do catálogo não deve ser promovido. A revisão também mostrou que corrigir a apresentação dos resultados já disponíveis merece avaliação como entrega limitada, antes de investir em outro recuperador.

## Conferência realizada

Somente leitura dos JSON do cache, metadados/tamanhos dos `.npz` e código. Não houve decodificação, inferência, inspeção visual de mídia, instalação de dependências ou alteração de serviços/banco/cache.

| Medição | Valor reproduzido |
| --- | --- |
| Entradas e resultados publicados | 134 e 134 |
| Soma de `compared_videos` | 8.911 |
| Reports | 18 |
| Soma de `candidate_limited_pairs` | 96 |
| Resultados com `truncated_matches` | 0 |
| Duração das fontes indexadas | 46,630459 h |
| Mediana da duração | 893,7045 s |
| Índices `.npz` | 2.939; 2,173569 GiB |
| Journal remanescente | `catalog-work-186.json`, 44 pares |
| Replay `min(coverage_a, coverage_b) >= 0.05` | Somente 179/180 passa |

O replay foi apenas uma avaliação da expressão sobre os 18 resultados persistidos. Nenhum resultado foi reclassificado no sistema. Onyx tem cobertura mínima de 0,71025; 38/42, 0,02668; os demais, no máximo 0,00627. Os 44 pares do journal não foram somados ao universo publicado.

## Tratamento de cada achado

| Item do parecer | Tratamento | Alteração no plano |
| --- | --- | --- |
| 3.1 — valor de B0 | Aceito com limite de escopo | B0 é candidato de entrega para classificação de reports existentes; o filtro foi reproduzido. Não se torna regra universal de containment |
| 3.2 — ausência de clip natural em live | Aceito | Essa ausência aparece no diagnóstico, na composição do conjunto e no próprio gate de recuperação |
| 3.3 — cinco famílias, não 16 situações | Aceito | Famílias explicitadas; diversidade contada por família. Uma campanha maior fica separada do piloto inicial |
| 3.4 — métricas de falsos positivos e 8.911 pares | Aceito parcialmente | Usar replay e reportar frequência por milhão, por consulta e entre sugestões; não chamar os 8.911 de negativos rotulados nem independentes |
| 3.5 — custo e proibição de comparação exaustiva | Aceito com correção da inferência | Cenários de 92,4 dias, 104,4 TiB lógicos e 42 GiB documentados com hipóteses. Não são limites inferiores comprovados |
| 3.6 — orçamento de entrada | Aceito | Cache quente como base; até 4 h acumuladas de mídia recém-decodificada; prevalece o teto de 30 min de parede |
| 3.7 — geometria do cache | Aceito com correção de abrangência | Descrever as vistas existentes; incluir recorte em altura, proporção e barras no escopo proposto; diagnosticar espelhamento/rotação sem prometer suporte |
| 3.8 — piso de duração | Aceito como proposta de produto | Fixar escopo de pelo menos 10 s antes do piloto. Não afirmar impossibilidade abaixo disso nem invalidação automática de todo o cache |
| 3.9 — truncamentos | Aceito | Expor ambos os sinais na análise e na UI futura; distinguir match sustentado de busca completa |
| 3.10 — encerramento já implementado | Aceito como evidência de código | Reutilizar e verificar o runner; não reimplementá-lo. A latência de encerramento e o orçamento acumulado ainda precisam de verificação |

## Ressalvas que mudam a interpretação

### 1. B0 resolve a rejeição dos reports conhecidos, não o requisito inteiro

O filtro proposto separa Onyx dos outros 17 reports existentes. Isso é útil e foi subestimado no primeiro plano. Porém um clip de 30 s totalmente contido em uma live de 2 h tem cobertura de aproximadamente 100% no menor e 0,42% no maior: `min(cobertura) >= 5%` o descarta. Portanto esse filtro não pode reger todas as classes.

O destino de 38/42 como similaridade vem da avaliação do usuário. A condição de 5% sozinha apenas o remove da lista principal; não cria uma regra de similaridade que também exclua os outros negativos. Essa apresentação separada precisa de política/teste próprios. Ajustes que reproduzem os rótulos conhecidos não demonstram generalização.

### 2. Contador de comparações não equivale a conjunto negativo

Os 8.911 comparados incluem um positivo confirmado, uma sugestão aceitável, 16 reports indesejados e 8.893 pares sem report. O último grupo pode conter falsos negativos; não foi rotulado visualmente. Além disso, os arquivos se repetem entre pares e dez dos negativos conhecidos pertencem à mesma família.

A expressão `16 / 8.911 × 10⁶ ≈ 1.796` mede reports indesejados conhecidos por milhão de pares examinados nesta rodada. Não é FPR sobre um conjunto de negativos verdadeiros. Projetá-la para todo o catálogo produz aproximadamente 11.833 reports apenas sob hipótese de representatividade da frequência observada.

A conta de zero erros em 8.911 ensaios resultar em limite superior unilateral de 95% de aproximadamente 0,000336 é matematicamente correta para ensaios binomiais independentes e representativos. O cache não satisfaz comprovadamente essas premissas, nem contém 8.911 negativos rotulados. Portanto a projeção de aproximadamente 2.215 falsos reports não é um intervalo de confiança válido do catálogo atual.

Usar a amostra maior ajuda a auditar comportamento anterior, mas não substitui rótulos e desenho amostral. Novos recuperadores também podem emitir candidatos que o cache antigo nunca armazenou. As métricas e denominadores precisam acompanhar essa mudança, sem usar os antigos não-reports como prova de ausência de cópia.

### 3. Extrapolação não é limite inferior

`3 h × 6.590.265 / 8.911 ≈ 92,4 dias` mistura custo de indexação e comparação na taxa inicial. Como a indexação e a comparação crescem de maneiras diferentes, multiplicar esse total pelo fator de pares não demonstra um piso para a execução completa. Tampouco temos a distribuição real de duração/codec do catálogo. A projeção continua sendo um alerta válido, apresentado como cenário.

A média de aproximadamente 16,61 MiB comprimidos por índice, multiplicada por todos os pares, dá cerca de 104,4 TiB de leituras lógicas sob hipótese de referências do mesmo tamanho médio. Cache do sistema operacional pode evitar parte das leituras físicas; descompressão e alocação repetidas podem continuar caras. Não atribuir automaticamente 104,4 TiB ao dispositivo de armazenamento.

Os aproximadamente 900 h decorrem da mediana da amostra multiplicada pelo número de vídeos. Isso não estima de forma garantida a soma, sobretudo com durações assimétricas. Os 42 GiB derivados não são piso de armazenamento; não incluem um índice global novo. A distribuição real por metadados é necessária para projeção de produção.

A preocupação arquitetural permanece: há milhões de pares potenciais e recarga repetida de índices. B2 precisa eliminar a confirmação/busca exaustiva pareada; B1 precisa demonstrar redução de candidatos ou ficar restrito ao ensaio pequeno. Não é necessário chamar cenários de limites inferiores para sustentar essa decisão.

### 4. Ausência de vistas específicas não prova recuperação impossível

O código usa faixas verticais de altura inteira deslocadas horizontalmente, além do frame completo. A lacuna para recorte em altura e transformações sem vista dedicada é real. Entretanto o descritor global pode tolerar algumas mudanças; a inspeção de código não prova recall zero para todas elas. O requisito será avaliado por transformação, sem alegação de garantia geral.

O piso de 10 s é uma decisão conservadora proposta para o primeiro escopo, não teorema decorrente de cinco amostras. Se o escopo ou pré-processamento mudar, índices incompatíveis não devem ser reutilizados como se fossem equivalentes. Isso também não exige apagar todos os índices antigos: eles podem continuar válidos no escopo original, com complementos/versionamento para novas representações quando tecnicamente viável.

### 5. Tempo de encerramento e vazão precisam de medição compatível

SIGTERM e escalada para SIGKILL após 2 s já existem no runner. Timers no código não comprovam, isoladamente, encerramento de toda a árvore em até 10 s, ausência de órfãos ou orçamento global entre vários jobs e ferramentas externas. A tarefa passa de implementar para verificar/adaptar a contenção necessária ao piloto.

O parecer sugere produção em até 24 h e usa aproximadamente 10 s de mídia por segundo como referência de vazão. Esses critérios não são equivalentes: 900 h de mídia a 10 s/s exigem 90 h, sem acrescentar busca e confirmação. O plano mantém 24 h como proposta a aprovar e exige projeção do pipeline completo. Nem essa duração de acervo nem o teto foram confirmados pelo usuário.

## Próximo passo documental

Revisar a versão 2 e decidir: escopo mínimo, teto aceitável de reports indesejados, orçamento do ensaio e suficiência da revisão independente. B0 pode ser aprovado separadamente como mudança limitada de classificação, sem autorizar nova varredura. A entrega do piloto e a liberação do backlog são decisões distintas; nenhuma foi tomada nesta resposta.
