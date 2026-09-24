# Plano de revisão da detecção de duplicatas de vídeo

Data: 21/09/2026. Revisão documental: 2, após parecer técnico. Estado: **implementação iniciada após autorização do usuário; backlog integral condicionado aos gates**.

O [parecer recebido](../reviews/video-duplicate-detection-redesign-parecer-2026-09-21.md) concluiu “aprovar com alterações” e declarou que não constitui revisão externa cega. Esta revisão incorpora as constatações confirmadas e registra ressalvas na [resposta técnica ao parecer](../reviews/video-duplicate-detection-redesign-resposta-2026-09-21.md). O parecer original foi preservado. Nenhum desses documentos autorizava, por si só, processamento ou implantação. Posteriormente o usuário autorizou iniciar a implementação; a primeira entrega é B0, sem retomada do backlog. O avanço de B1/B2 continua condicionado às evidências e aos limites abaixo.

## 1. Problema a resolver — contexto independente da solução

### Produto, acervo e necessidade

O **Kura** é a interface web/mobile de uma biblioteca pessoal de vídeos, atendida pelo backend deste repositório (`conversor-video`). O acervo contém gravações longas, inclusive lives de horas, e vídeos menores que podem ter sido extraídos dessas gravações. Arquivos com o mesmo conteúdo podem ter resoluções, compressão, enquadramento e duração diferentes. Pessoas, roupas, cenários, estúdios e aberturas também podem se repetir em gravações que não são cópias umas das outras.

Já existe um fluxo de duplicatas exatas. A necessidade adicional é reconhecer **reutilização do mesmo conteúdo gravado**, mesmo quando o arquivo foi transformado ou apenas um trecho foi preservado. Comparar apenas os bytes não atende a esse caso. Por outro lado, reconhecer que dois vídeos mostram a mesma pessoa ou o mesmo lugar também não atende: isso pode acontecer em sessões distintas.

A saída desejada deve permitir ao usuário entender **quais vídeos compartilham conteúdo e onde esse conteúdo está em cada um**, distinguindo cópia integral, clip extraído e eventual sobreposição relevante. O usuário continuará responsável pela revisão; não foi solicitada exclusão automática.

### Exemplos de comportamento esperado

Os exemplos abaixo são ilustrativos do requisito, não medições da biblioteca nem limiares já aprovados.

| Situação | Resultado esperado | Motivo |
| --- | --- | --- |
| Mesma gravação de 30 min em 1080p e 480p | Identificar cópia do conteúdo | A resolução mudou; a gravação é a mesma |
| Clip de 30 s extraído do meio de uma live de 2 h | Identificar o clip e localizar o trecho na live | Quase todo o clip é cópia, embora represente apenas 0,42% da live |
| Mesmo clip com recorte lateral que remove parte da imagem | Continuar reconhecendo quando houver evidência suficiente | O enquadramento mudou; a sequência gravada foi preservada |
| Duas lives de 2 h com a mesma abertura de 5 s | Não classificar as lives como duplicatas por esse motivo | A abertura é compartilhada, mas não estabelece duplicação do restante |
| Mesma pessoa, roupa e estúdio em gravações distintas | Não classificar como cópia apenas pela aparência | Semelhança de cena não comprova reutilização da gravação |
| Duas gravações longas com vários minutos realmente compartilhados | Localizar a sobreposição; decidir sua relevância com regra explícita | Há conteúdo reutilizado, mas isso não torna necessariamente os arquivos inteiros duplicatas |

**Crop** significa recortar parte da imagem, não apenas remover barras pretas. **Cobertura** é a fração temporal de um vídeo que corresponde ao outro; há uma cobertura para cada arquivo. Um clip pode ter cobertura próxima de 100% e a live correspondente ter menos de 1%. Esses conceitos são necessários para avaliar o requisito, independentemente do algoritmo escolhido.

### Falha que motivou esta revisão

Foi implementado e executado um detector perceptual, isto é, baseado no conteúdo visual em vez da identidade dos bytes. Na rodada real, o usuário relatou aproximadamente três horas para 133 itens concluídos, cinco falhas e muitos resultados indesejados. Somando implementação e primeira execução, relatou quase cinco horas de investimento. Só um report foi confirmado como correto; outro foi considerado aceitável por similaridade. O restante incluía coincidências de poucos segundos em vídeos longos e aberturas compartilhadas.

O problema tem duas dimensões: **a lista apresentada não separa adequadamente cópia útil de semelhança ou conteúdo comum; e o processamento consumiu tempo e recursos sem benefício proporcional demonstrado**. Não há medição de energia nem avaliação completa de falsos negativos. Os dados detalhados e sua origem estão na seção 2.

### Restrições e prioridades declaradas

- Precisão é mais importante que velocidade, mas custo de execução e energia precisam de limites. Evitar falsos positivos não pode significar simplesmente deixar de encontrar todos os clips.
- Execução local em Linux, com Ryzen 5 5600G e GPU AMD RX 7800 XT registrada no ambiente. Preferir aceleração GPU quando ela trouxer benefício medido; não presumir que toda etapa será mais eficiente na GPU.
- Mídias originais devem ser preservadas. O acervo existente será processado por disparo manual, com acompanhamento e cancelamento na web/mobile; análise automática foi solicitada apenas para vídeos novos incluídos.
- A rodada examinada abrangia 3.631 itens. A distribuição completa de duração, resolução, codec e proporção real de duplicatas ainda não foi caracterizada para dimensionamento.
- Não é objetivo reconhecer identidade de pessoas, agrupar vídeos por assunto ou similaridade estética, nem substituir as rotinas independentes de rostos e previews da biblioteca.

O usuário inicialmente sugeriu perceptual hash como possibilidade. **Isso não é uma exigência de tecnologia.** SSCD, áudio, busca vetorial, ferramentas prontas e reaproveitamento do código atual são alternativas a avaliar, não requisitos do problema.

### Mandato da revisão independente

Avaliar se há uma abordagem que satisfaça os exemplos e restrições com custo aceitável, qual evidência falta para decidir e qual é o menor experimento capaz de refutar uma abordagem inadequada. A revisão pode recomendar outro método, reduzir o escopo ou não prosseguir.

Para reduzir ancoragem, registrar primeiro uma avaliação do problema e das evidências das seções 1–2, antes de examinar as recomendações. A pesquisa da seção 3 é uma seleção de fontes, não um levantamento exaustivo; as classes, alternativas, arquitetura, metas e orçamentos das seções 4–9 são propostas do autor. O revisor não deve presumir que estão corretos nem se limitar a escolher entre elas. O custo já incorrido explica a necessidade de controle, mas não justifica preservar uma solução ruim.

Este documento é autossuficiente para entender a demanda e o incidente. Links para código e artefatos permitem conferir afirmações técnicas; as mídias e evidências privadas não estão anexadas. Sem acesso a elas, o terceiro pode revisar o desenho e a suficiência das provas, mas não certificar a qualidade visual dos resultados.

Esta entrega contém apenas pesquisa e planejamento. Não instala ferramentas, altera serviços, inicia FFmpeg, reprocessa vídeos ou modifica mídia. Os limites propostos dependem de revisão, não são autorização implícita de execução.

## 2. O que falhou e qual evidência temos

O usuário relata quase cinco horas somando implementação e primeira rodada, além de energia consumida. A energia não foi medida; não há valor confiável em kWh ou reais.

Na auditoria registrada em 21/09/2026, a execução de sincronização identificada como `203` estava cancelada, com 3.631 itens: 133 concluídos, 5 falhos, 1 ignorado e 3.492 pendentes. O cache tinha 134 entradas publicadas; as contagens têm etapas de registro distintas e não devem ser tratadas como equivalentes; a diferença isolada não comprova perda nem conclusão de trabalho.

| Evidência do snapshot | Resultado |
| --- | --- |
| Pares apresentados | 18: 7 `verified`, 11 `ambiguous` |
| Cobertura estimada abaixo de 2% nos dois arquivos | 16 dos 18 pares |
| Mediana do maior trecho por par | 5 segundos |
| Casos `verified` | 6 apenas na abertura, nos primeiros 0–6 s; 1 caso Onyx |
| Índice derivado existente | 2,174 GiB de `.npz`; 2.939 chunks de minuto; 46,630 h de mídia |
| Comparações publicadas | 8.911, soma dos contadores dos 134 resultados |
| Busca com hipóteses limitadas | 96 comparações, aproximadamente 1,08% |
| Publicação de matches limitada | Nenhum resultado com `truncated_matches` neste snapshot; limite de 50 existe no código |
| Trabalho não publicado | Journal `catalog-work-186.json` com 44 pares concluídos, separado dos 8.911 |

Esses números descrevem os resultados emitidos e os metadados do cache, não uma auditoria visual independente de todos os vídeos. São um snapshot do incidente, não monitoramento em tempo real.

**Origem e limites das evidências:** o relato de utilidade vem do usuário; contagens e intervalos vêm da inspeção de resultados persistidos; as regras do detector vêm da leitura do código. `verified` e `ambiguous` são classificações automáticas antigas, respectivamente “verificado pelo motor” e “ambíguo”; nenhuma delas significa validação humana. As cinco falhas são erros de processamento, separados dos falsos positivos, e suas causas não foram individualmente diagnosticadas neste plano.

**Rótulos de referência fornecidos pelo usuário (ground truth parcial):**

- IDs **179/180**, Onyx_17 / Onyx Fans Scene 16: único report confirmado como correto. Os limites temporais reais ainda precisam de anotação; os aproximadamente 71% calculados pelo motor antigo não são ground truth.
- IDs **38/42**, SexySteph75: sugestão aceitável por similaridade. Não converter essa aceitação em prova de cópia ou containment. Preservar como caso de revisão, separado das métricas de cópia confirmada.
- Demais 16 reports: resultados indesejados para esta finalidade. Se algum contém uma intro realmente copiada, isso continua sendo negativo na classificação de duplicata entre os arquivos.

Os 16 negativos pertencem a apenas **cinco famílias**: `{72,73,74,75,76}` concentra dez pares; `{64,65,66}` e `{187,192,194}` têm dois cada; `{146,147}` e `{149,150}` têm um cada. Não são 16 observações independentes.

Nenhum dos 18 reports é um caso natural confirmado de clip curto contido em live de horas. Portanto o incidente comprova resultados indesejados, mas não mede recall desse requisito principal. Das 8.911 comparações, 8.893 não emitiram report: isso é saída do motor, não rótulo humano de ausência de cópia.

Pares de regressão negativos: `72/75`, `74/75`, `76/72`, `76/74`, `76/75`, `74/72`, `73/75`, `65/66`, `65/64`, `187/194`, `187/192`, `150/149`, `73/76`, `73/72`, `147/146`, `73/74`.

### Implementação avaliada e interpretação das falhas

O motor atual extrai amostras a 1 frame por segundo e calcula descritores SSCD, vetores numéricos de aparência voltados à comparação de cópias, em seis vistas de cada frame. Usa decode FFmpeg/VAAPI e inferência MIGraphX na GPU. Busca correspondências visuais, tenta alinhá-las no tempo e confirma candidatos com SIFT/RANSAC, métodos de correspondência de pontos e ajuste geométrico, mais testes de movimento. Persiste índices para reutilização. Esse resumo descreve o mecanismo existente; não demonstra sua adequação ao objetivo.

As constatações abaixo distinguem regra implementada de conclusão sobre sua consequência:

- [video_copy_match.py](../../vision-service/src/vision_service/video_copy_match.py), funções `temporal_candidates`, `verify_candidate` e `compare`: candidatos podem nascer de cinco frames ao longo de quatro segundos; a confirmação usa no máximo 12 frames. Um segmento curto pode classificar o par como `verified`, sem exigência de cobertura relevante dos arquivos.
- A confirmação espacial/temporal pode estar correta sobre uma intro. O erro é promover essa evidência à classificação de duplicata do vídeo. Aumentar apenas a similaridade ou trocar SSCD por outro modelo não corrige essa regra.
- A cobertura usa intervalos inferidos de amostras. Não deve preencher lacunas sem evidência nem somar hipóteses temporais incompatíveis.
- [video_copy_catalog.py](../../vision-service/src/vision_service/video_copy_catalog.py): cada novo vídeo é comparado aos anteriores elegíveis. Para 3.631 vídeos, são potencialmente **6.590.265 pares**, antes do custo interno de frames e verificações. O custo da primeira centena não permite projetar uma taxa constante para o restante.
- Há carregamento repetido de índices e extrações FFmpeg na confirmação. Precisamos medir a participação de cada etapa antes de atribuir o gargalo à CPU ou GPU.

O [piloto anterior](../spikes/perceptual-video-implementation-2026-09-21.md) demonstrou funcionamento técnico e transformações controladas, mas usou oito fontes e 28 pares de controle sem rotulagem exaustiva. Não justificava liberar a classificação para um catálogo com fundos, estúdios e intros repetidos. A falha foi também no critério de promoção do piloto, não apenas nos limiares.

### Cenários de custo, não limites inferiores

O parecer permite quantificar o risco de escala. As projeções abaixo foram recalculadas, mas suas hipóteses impedem tratá-las como medições ou limites inferiores do catálogo inteiro.

| Cenário condicional | Cálculo e resultado | Limitação |
| --- | --- | --- |
| Repetir o tempo total médio por par da rodada | `3 h × 6.590.265 / 8.911 ≈ 92,4 dias` | As 3 h são aproximadas e misturam indexação, busca, verificação e outros custos. Não é custo isolado de comparação nem piso garantido |
| Recarregar índices do tamanho médio observado em todos os pares | `2,174 GiB / 134 × 6.590.265 ≈ 104,4 TiB` | Volume lógico de arquivos comprimidos; cache do sistema pode evitar leitura física. Tamanho/ordem das referências e descompressão afetam o custo |
| Armazenar 900 h com densidade igual à amostra | `2,174 GiB / 46,630 h × 900 h ≈ 42,0 GiB` | 900 h é cenário derivado da mediana da amostra, não duração total medida nem limite inferior. Média e mediana geram projeções diferentes |

Esses cenários são suficientes para impedir a promoção da arquitetura atual sem estudo de escala. **B2 não pode preservar o laço de comparação exaustiva entre todos os vídeos.** B1 deve demonstrar índice global ou mecanismo equivalente de redução de candidatos, ou permanecer restrito ao lote pequeno; boa classificação isolada não aprova produção.

Para dimensionamento posterior, medir separadamente `tempo de indexação + construção do índice de busca + recuperação de candidatos + confirmação + I/O`. Medir a distribuição real de durações por metadados antes de extrapolar. A quantidade de referências aumenta o número de pares; não multiplica novamente o custo de cada par. A energia total continua desconhecida.

## 3. Pesquisa: o que aplicações reais fazem

Fontes primárias consultadas em 21/09/2026. Documentação de produto mostra comportamento declarado; não equivale a um benchmark independente na máquina do usuário. Nenhuma das ferramentas abaixo foi executada nesta pesquisa.

| Aplicação / fonte | Comportamento documentado | Consequência para o Kura |
| --- | --- | --- |
| **Video Duplicate Finder (VDF)**, README e releases [1][2] | Combina comparação visual, detecção parcial por áudio com confirmação visual e modo opcional de embeddings DINOv2, inclusive alinhamento temporal de clips. Cache e CLI disponíveis. | Candidato a baseline externo local, ainda sem comparação empírica com as alternativas. Seus resultados ainda exigem nosso teste de negativos e relevância. Não assumir que adotar o programa resolve o incidente. |
| **Czkawka/Krokiet 12.0.2**, guia do core [3][4] | Hashes perceptuais em janelas temporais, fração mínima de janelas, tratamento de duração, subclips e áudio opcional. O crop documentado remove barras. | Referência de baseline barato e cache. A documentação não prova resistência a crop arbitrário ou boa recuperação de clips muito curtos em lives extensas. |
| **YouTube Content ID**, documentação operacional [5][6] | Compara uploads com referências audiovisuais; prevê referências distintivas, exclusão de segmentos e revisão manual para determinados casos. | Correspondência e decisão são etapas distintas. Adotar esse princípio de qualidade de evidência; não atribuir ao YouTube um algoritmo interno, hash ou limiar que não publica. |
| **Videntifier Identification Engine**, produto comercial [7] | Declara indexação de fingerprints e retorno de matches parciais com timestamps; descreve descritores locais para transformações [8]. | Exemplo comercial de identificação por trechos e regiões. Alegações de velocidade/precisão não foram validadas; custo, licença e operação local não estão estabelecidos. Não enviar biblioteca ou fingerprints a uma API. |
| **Immich**, Duplicates Utility [9] | Agrupa similaridade visual para revisão pelo usuário. | Exemplo de UX de revisão, não evidência de localização temporal de clips em vídeos. |
| **PhotoPrism**, Duplicate Detection [10] | Documenta detecção de arquivos idênticos por tamanho e SHA-1 e distingue arquivos relacionados. | Serve ao caso de duplicata exata; não demonstra solução para o requisito de crop/clip. |

### Versões e limites que afetam a decisão

O VDF publica builds mutáveis em `4.1.x`. A página consultada apontava o último build para `83ce186`; o artefato `CLI-linux-x64.tar.gz` tinha SHA-256 `9980869c66856a8ad74fd7163ec5d994e61ae9b10f87937f10e027ccd81cf0dd`. Antes de um ensaio, resolver o commit completo e verificar o artefato: não usar `latest` como identificação reproduzível. [2]

No VDF, o mínimo padrão de duração clip/fonte é 10%; 30 s em 2 h representam 0,42% e seriam excluídos por esse filtro. O modo neural documentado executa na CPU. Há também o relato aberto #908 de confirmação visual que não bloqueou um match de áudio; não reproduzido aqui e não comprovado na build atual. Exigir regressão específica antes de adotá-lo. [1][11]

O Czkawka tinha release 12.0.2, de 09/09/2026, commit abreviado `f9be31f`. O guia consultado também existe nessa tag, não apenas em `master`. Isso identifica a versão documental; não comprova comportamento medido. [3][4]

Como referência de pesquisa, o baseline **Meta VSC2022** combina SSCD a 1 fps, busca indexada e localização temporal baseada em VCSL. Ele reforça a separação entre busca e localização, mas não comprova que o mesmo pipeline está em produção no Facebook, nem fornece nossos limiares de produto. [12]

**Conclusão da pesquisa:** testar reaproveitamento de software antes de construir outro motor; manter a classificação de relevância sob controle do Kura. Similaridade visual, quantidade de frames e correspondência de áudio isoladas não são critérios suficientes para a necessidade relatada.

## 4. Contrato de resultado antes do algoritmo

| Classe | Evidência necessária | Apresentação |
| --- | --- | --- |
| Arquivo idêntico | Hash exato pelo fluxo existente | Duplicata exata |
| Cópia integral transformada | Mesma sequência audiovisual em praticamente todo o conteúdo, com exceções explicitadas | Cópia provável, revisável |
| Clip contido | A maior parte do **vídeo menor** corresponde a uma sequência localizada no maior | Clip contido, com timestamps nos dois |
| Sobreposição parcial relevante | Trecho comprovado e relevante para o usuário, sem cobertura suficiente para containment | Conteúdo compartilhado, separado de cópia integral |
| Semelhança sem cópia comprovada | Evidência útil para revisão, sem sequência suficientemente comprovada | Sugestão de similaridade opcional |
| Intro, logo, fundo ou música comum | Evidência restrita ao conteúdo comum | Não aparece na lista principal de duplicatas |
| Evidência insuficiente / análise limitada | Orçamento esgotado, baixa textura, hipóteses conflitantes, falha, `candidate_limited_pairs > 0` ou `truncated_matches` | Aviso explícito de análise incompleta; nunca equivalente a “não há duplicata”. Matches sustentados podem continuar visíveis, sem alegar busca completa |

**Coverage:** calcular separadamente a união de intervalos comprovados no vídeo A e no B, dividida pela duração correspondente. Com velocidade diferente, os dois intervalos têm durações diferentes. Não usar a duração da live como único denominador para rejeitar clips. Não unir lacunas ou contar duas vezes trechos sobrepostos. Informar cobertura observada/estimada e incerteza das bordas.

Um clip de 30 s quase todo localizado em uma live pode ser relevante apesar de representar menos de 1% dela. Dois vídeos de horas com cinco segundos de intro em comum não devem ser duplicatas. Um trecho substancial copiado entre duas lives pode merecer a classe de sobreposição mesmo com percentuais baixos: percentual sozinho também não decide.

Os valores preliminares sugeridos pelo autor — 85–90% de cobertura do menor, ou 60 s mais 20% — **não estão validados e não serão adotados como padrão**. O revisor deve aprovar exemplos-limite, duração mínima suportada e regras distintas para cada classe. A configuração será calibrada apenas no conjunto de desenvolvimento e congelada antes do teste reservado.

## 5. Recomendação do autor e alternativas para contestação

**Recomendação, não premissa da revisão:** não retomar o backlog com o motor atual. Primeiro aprovar a definição de duplicata, um conjunto rotulado e um orçamento; depois comparar uma ferramenta existente com uma alternativa mínima que reutilize os índices já produzidos. Só integrar a alternativa que demonstrar utilidade nesse teste. Encerrar a iniciativa também é um resultado válido.

A arquitetura candidata separa recuperação de candidatos, comprovação do trecho e relevância da relação entre os vídeos. É uma proposta derivada da investigação, não um padrão universal comprovado para esta biblioteca. O revisor pode rejeitar essa decomposição ou propor uma alternativa fora da seleção abaixo.

1. **B0 — candidato de entrega para a classificação dos resultados existentes:** filtrar relevância sem decodificação ou inferência nova. O replay dos 18 reports com `min(cobertura_a, cobertura_b) >= 0,05` deixa somente Onyx na lista principal. Isso resolve a rejeição do ruído conhecido, mas é um ajuste retrospectivo. O filtro não determina sozinho uma sugestão útil para 38/42, nem pode virar regra universal: também rejeita um clip de 30 s inteiramente contido em 2 h. Regras de containment e similaridade permanecem separadas. B0 pode ser uma entrega limitada e testável, sem retomar indexação ou alegar melhora de recall; é a primeira alternativa a avaliar, não apenas uma régua.
2. **B1 — ferramenta existente:** avaliar VDF em um manifesto pequeno, com mídia somente leitura, saídas isoladas e parâmetros registrados. Validar seus filtros de duração, amostragem de lives e confirmação visual antes do processamento. Czkawka é controle opcional apenas se B1 for inviável por instalação/licença; não abrir três frentes de implementação.
3. **B2 — alternativa mínima própria:** somente se B1 falhar em requisito obrigatório e houver orçamento restante, reutilizar SSCD/cache compatível para um protótipo isolado de recuperação e confirmação. Eliminar a comparação exaustiva entre vídeos é condição de aprovação do desenho antes de construí-lo. Sem API, interface ou migração nesta etapa. A comparação precisa demonstrar vantagem concreta sobre B0/B1.
4. **Decidir:** adotar B1, desenvolver B2, reduzir o escopo ou encerrar. A existência de código já escrito não é justificativa para continuar gastando.

Antes de incorporar dependências, registrar licença da versão e dos modelos. O VDF declara AGPLv3 [1]; qualquer integração/distribuição precisa de avaliação específica, sem presumir que executar via CLI elimina obrigações. Não há decisão de incorporação neste documento.

## 6. Arquitetura candidata se houver justificativa para B2

### Recuperação com custo limitado

- Preservar hashes exatos e índices SSCD válidos. Identificar cache por versão de modelo, extração e identidade do arquivo. Mudança de decisão não exige necessariamente extrair frames novamente.
- Construir um índice global de descritores com vídeo, timestamp e região. Recuperar vizinhos e agregar votos em hipóteses temporais; confirmar apenas candidatos promissores. Não continuar a comparação exaustiva de cada vídeo contra todos os anteriores.
- Evitar candidatos concentrados apenas em um frame, intro ou região estática. Distribuir o orçamento por janelas de tempo e por vídeo de referência. Frequência de ocorrência pode reduzir o peso de trechos genéricos, mas frequência alta não prova que um trecho é descartável: cópias legítimas também se repetem.
- Definir cadência pela menor duração de clip suportada. Extrair um número fixo pequeno de thumbnails por arquivo pode deixar minutos sem observação em lives. O cache atual a 1 fps é um ponto de partida para avaliação, não uma garantia de recall.
- Busca aproximada precisa de comparação com busca exata no pequeno conjunto do piloto, medindo perda de candidatos. Estourar top-K ou orçamento gera diagnóstico de incompletude; não silêncio.

### Crop e comprovação temporal

**Lacuna confirmada:** o índice existente reduz o frame para 288×288 sem preservar proporção e gera cinco faixas verticais de altura inteira, deslizando ao longo do eixo horizontal (`frame[:, x:x+96]`), além do frame completo. Não há vistas dedicadas a recorte em altura, espelhamento ou rotação. O descritor global ainda pode recuperar alguns desses casos; ausência de vista específica não prova recall zero. A robustez precisa ser medida.

Reutilizar esse cache economiza extração, mas não cria informação regional ausente. Para descritores adicionais, preservar entradas compatíveis e versionar um complemento quando possível; se o pré-processamento mudar, medir a reextração necessária e cobrá-la no orçamento. Não prometer suporte a crop vertical com base apenas no piloto horizontal.

**Escopo inicial proposto, fixado antes do ensaio:** clips de pelo menos 10 s; reencode/resolução; crop fixo em largura e em altura; mudança de proporção/barras. Crop móvel é cenário exploratório; espelhamento e rotação ficam fora da promessa inicial, mas entram como testes diagnósticos para expor limitações. Qualquer redução adicional do escopo deve constar do relatório. Isso é decisão de produto a aprovar, não um limite matemático imposto pelo código.

Cinco amostras a 1 fps cobrindo pelo menos 4 s são necessárias no motor atual. O piso de 10 s oferece margem operacional, sem garantir recuperação. Investigar clips menores poderá exigir outra cadência e/ou critérios, mas não torna automaticamente inutilizáveis todos os índices a 1 fps: dados válidos podem permanecer para seu escopo original e novos dados exigem versionamento separado.

- Crop deve ser recuperável na primeira etapa: manter informação regional ou local na busca. Um verificador resistente a crop não ajuda se o par nunca é candidato.
- Confirmar correspondências espaciais dentro da região realmente compartilhada, com transformação coerente. Verificar que a evidência não vem apenas de logo, parede ou mobiliário.
- Confirmar a **mesma evolução visual no tempo** em janelas distribuídas. Não basta ambas as cenas terem movimento. Examinar evidência dinâmica após alinhamento e confrontar alternativas concorrentes.
- Reutilizar SIFT/RANSAC existente inicialmente, medindo seu custo. Não introduzir novos modelos de correspondência sem demonstrar que a etapa atual é o limitante de precisão ou tempo.
- Agrupar extrações próximas em janelas, reduzir reinícios FFmpeg e reutilizar frames/features. Refinar começo, fim e lacunas só nos trechos promissores; não inferir minutos de cobertura a partir de poucos frames distantes.
- Crop móvel exige transformações que evoluem de forma coerente por janela. Em cenas estáticas, crop extremo ou alinhamentos ambíguos, abster-se quando faltar evidência distintiva. Nenhuma promessa de suporte universal.

### Conteúdo comum e áudio

Não ignorar cegamente os primeiros 30 segundos: clips legítimos podem começar ali. Identificar evidência de intro/conteúdo recorrente e exigir correspondência fora dela para classificar os arquivos como duplicatas. Manter evidência e motivo da rejeição para auditoria. Um vídeo constituído apenas pela intro pode ser marcado como trecho contido com bandeira de conteúdo recorrente, fora da lista principal; essa regra de apresentação também precisa de aprovação.

Áudio é caminho complementar de candidatos/alinhamento e corroboração visual. A mesma música em sessões distintas não confirma cópia; ausência de áudio não elimina um candidato visual. Avaliar áudio somente se resolver casos do conjunto rotulado ou reduzir custo medido. Não implementar transcrição/VTT como prova de identidade audiovisual.

### AMD/Linux e custo real

Preferir o caminho de decode VAAPI e inferência MIGraphX já validado no piloto local, sem atualizar drivers para tentar corrigir um problema de classificação. O Ryzen 5 5600G e a RX 7800 XT são o hardware registrado; versões/providers devem ser recapturados antes de qualquer execução futura.

O Faiss atual documenta suporte ROCm por compilação, mas o guia de instalação consultado ainda não oferece pacote GPU AMD pronto; a versão estável indicada é 1.15.1. Isso é uma opção técnica, não uma dependência aprovada nem desempenho comprovado na RX 7800 XT. [13]

Começar pela alternativa de índice mais simples que atinja as metas no piloto. Um índice CPU pode evitar milhões de comparações GPU e ainda ganhar no tempo total, mas isso precisa ser medido nessa CPU. Não compilar uma nova pilha ROCm como pré-requisito do teste. Inferência, decode, transferência, busca, SIFT e I/O terão tempos separados; GPU ativa não é sinônimo de pipeline eficiente.

## 7. Conjunto de avaliação e critérios de aceitação

### Manifesto reproduzível

Preparar um manifesto privado com IDs, identidades dos arquivos, durações, origem/família, rótulo e intervalos esperados. Não depender de títulos para identificar cópias. Salvar parâmetros, versões, hashes de artefatos e resultados por caso. Fontes e saídas serão somente leitura/isoladas; não colocar mídia ou caminhos privados no repositório.

Manter três grupos:

- **Regressão do incidente:** os 18 pares acima. Onyx positivo; SexySteph75 revisão aceitável; demais 16 fora das sugestões principais. Este grupo já é conhecido e não pode ser chamado de teste cego.
- **Desenvolvimento:** positivos controlados e negativos difíceis adicionais para escolher parâmetros. Transformações derivadas da mesma origem ficam no mesmo grupo.
- **Teste reservado:** famílias de origem/sessão separadas do desenvolvimento, com cenários de mesmo estúdio representados. Rótulos congelados antes da execução; não ajustar parâmetros após observar suas respostas e continuar chamando o resultado de teste reservado.

Separar o **piloto de viabilidade** da **validação para produção**. No primeiro, usar a regressão e até 20 consultas transformadas de famílias distintas, com divisão de desenvolvimento/reservado feita antes do ensaio; ampliar para pelo menos dez famílias somente se houver rótulos e orçamento. Contar e reportar famílias, não inflar a amostra combinando pares correlacionados. O piloto pequeno pode reprovar uma alternativa, mas não aprova backlog.

Para validação posterior, buscar diversidade de pelo menos 100 famílias negativas difíceis, se viável, com pares internos identificados e unidades de amostragem explícitas. Esse número é proposta de diversidade, não demonstração estatística de segurança; a campanha precisa de orçamento e aprovação próprios. Não prometer anotá-la dentro das duas horas do primeiro piloto.

Usar os 8.911 comparados como universo de replay do comportamento antigo, sem decodificar novamente. Os JSON publicados guardam contadores e matches, não rótulos humanos completos nem todas as hipóteses descartadas. Servem para testar a classificação dos 18 reports e contabilizar o universo examinado. Não servem como 8.911 negativos confirmados, nem validam um novo recuperador que encontra candidatos antes ausentes.

Casos obrigatórios dentro do escopo: cópia reencodada/resoluções diferentes; clip de 10/30/60 s em live de pelo menos 2 h; crops fixos moderados e estreitos em largura e altura; mudança de proporção e letterbox/pillarbox; clip sem áudio e com áudio alterado; mesma música com imagens diferentes; mesma pessoa/estúdio/roupa em outra sessão; intro compartilhada; logo/overlay; cena estática; trechos em começo/meio/fim; duas lives com sobreposição longa. Crop móvel, espelhamento e rotação devem aparecer no relatório como diagnósticos fora da promessa inicial, nunca sumir do relatório após falhar.

Não há positivo natural confirmado de clip-em-live no incidente. Enquanto os positivos desse cenário forem apenas sintéticos, o gate mede recuperação das transformações que nós escolhemos gerar. Documentar a receita, a distribuição e os limites dessas transformações; passar não prova recall de clips naturais. Buscar exemplos naturais com anotação independente é pré-requisito para ampliar a alegação.

### Métricas e gates

| Gate | Condição proposta |
| --- | --- |
| Regressão | Onyx recuperado e corretamente apresentado; SexySteph75 disponível apenas como revisão; zero dos 16 indesejados na lista principal |
| Recuperação | Pelo menos 95% das consultas positivas do teste reservado dentro do escopo chegam à confirmação; publicar numerador/denominador, famílias e resultado por transformação. Se forem sintéticas, o gate vale somente para esse conjunto sintético |
| Classificação no piloto | Zero falso positivo observado de cópia/containment nas famílias rotuladas reservadas; não é autorização de backlog. Nenhum erro deve reaparecer como sugestão principal sob rótulo “ambíguo” |
| Escala de produção, posterior | Taxa de reports indesejados por milhão de pares examinados e por vídeo consultado, proporção entre sugestões apresentadas, denominadores auditáveis e incerteza conforme a amostragem; projeção de carga de revisão dentro de um teto aprovado pelo usuário. Sem teto e evidência suficientes, backlog bloqueado |
| Utilidade | Recuperar pelo menos 90% dos positivos suportados na saída útil; não vencer emitindo zero resultados ou remetendo tudo à revisão |
| Localização | Meta inicial de erro de borda ≤2 s nos clips controlados; reportar também erro máximo e lacunas. Resíduo do ajuste temporal não substitui erro contra ground truth |
| Custo | Cumprir orçamento da seção 8 e registrar tempo total, cache, RAM/VRAM e energia disponível |
| Operação | Cancelar, retomar e distinguir falha, sem match e análise incompleta; nenhuma alteração de mídia |

Essas metas são propostas para aprovação. Aprovar um piloto pequeno **não demonstra 99% de precisão na biblioteca**. Pares do mesmo estúdio e variantes da mesma fonte são correlacionados. Reportar matriz de confusão, tamanho da amostra e limitações; não apresentar apenas “acurácia”. Medir também quantidade de sugestões por consulta e falsos positivos entre resultados realmente apresentados, além de recall dos positivos conhecidos.

### Interpretação estatística e carga de revisão

Na amostra antiga, os 16 reports indesejados em 8.911 comparados equivalem a aproximadamente **1.796 reports indesejados por milhão de pares examinados**. Aplicar essa frequência a 6.590.265 pares dá cerca de **11.833 reports**. É uma extrapolação condicional do comportamento antigo, não previsão nem taxa de falso positivo medida entre negativos conhecidos. Quase todos os pares continuam sem rótulo, e vídeos/famílias se repetem entre comparações.

Para ilustrar o tamanho da incerteza: sob a hipótese de ensaios binomiais independentes e representativos, zero erros em `n` negativos teria limite superior unilateral de 95% igual a `1 - 0,05^(1/n)`. Em 100 seria 2,95%; em 8.911, 0,0336%, equivalente a cerca de 2.215 reports no universo completo se todas essas hipóteses fossem válidas. **Elas não foram demonstradas neste cache.** Não publicar esse cálculo como intervalo de confiança da qualidade real do detector.

O protocolo posterior deve definir amostragem por família/vídeo, rótulos e pesos antes de estimar taxas; apresentar intervalo compatível com dependência e seleção ou declarar que a amostra não permite estimativa populacional. Não assumir independência entre todas as combinações nem usar ausência de report como ground truth negativo. Índices que reduzem candidatos também mudam os denominadores: reportar pares recuperados, pares confirmados e consultas, sem diluir erros em bilhões de comparações que não aconteceram.

Os reports anteriores não permitem medir quantas duplicatas deixaram de ser encontradas. O teste reservado deve incluir positivos que não foram selecionados pelo motor antigo. Se faltarem dados naturais suficientes, restringir a conclusão e manter revisão humana obrigatória. B0 é avaliado pela apresentação dos resultados existentes; os gates de recuperação se aplicam a B1/B2, não podem ser reivindicados por B0.

## 8. Orçamento, energia e regras de parada

**Tetos propostos para a primeira avaliação, após aprovação externa:**

| Atividade | Teto |
| --- | --- |
| Preparação, anotação, configuração e análise técnica | 2 horas acumuladas de trabalho; sem expansão automática |
| Preparação de ferramentas novas | 15 minutos dentro das 2 h; incompatibilidade exige registrar bloqueio, não compilar indefinidamente |
| Processamento pesado total do piloto, somando alternativas e eventuais repetições | 30 minutos de parede; inclui geração de variantes, warmup, extração e confirmação |
| Entrada já indexada | Reutilizar o cache de 134 vídeos / 46,630 h para replay e busca compatível, sem recodificá-los nem decodificá-los integralmente outra vez |
| Entrada recém-decodificada | Até 4 h acumuladas de mídia efetivamente processada, incluindo releituras de fontes, geração de variantes e indexação por alternativas; teto de 30 min de parede prevalece |
| Saídas derivadas novas | Até 5 GiB, sem apagar índices existentes para caber |
| Concorrência | Um worker pesado; não competir com conversões/extração de rostos |
| Energia da máquina, se houver medição adequada | Até 0,15 kWh brutos no piloto; parar no primeiro limite atingido |

O piloto é deliberadamente baseado em **cache quente** para B0/B2. B1 não recebe crédito por esse cache se não puder utilizá-lo: sua extração entra integralmente no limite de 4 h, incluindo releituras. Os subconjuntos efetivamente consultados devem ser iguais para comparações de qualidade; relatar custo frio/quente separadamente. Se uma ferramenta não couber, registrar orçamento insuficiente ou incompatibilidade, sem atribuir automaticamente falha de precisão.

Esses tetos limitam gasto; não são estimativas de que todo o teste caberá neles. Resultado incompleto não autoriza aumentar o orçamento. No máximo uma recalibração no desenvolvimento, ainda dentro dos limites. Falha em um gate encerra a promoção; não fazer rodadas sucessivas de tuning no teste reservado.

Primeiro executar um pequeno conjunto sentinela: Onyx, SexySteph75, intros e mesmo estúdio. Falhar nele interrompe a alternativa antes de processar o restante. O sentinela não substitui o teste reservado.

O runner existente já tem timeout por job e sinalização ao grupo de processos, com SIGTERM e escalada para SIGKILL após 2 s (`perceptual-duplicates.runner.ts`). Reutilizar e **verificar** esse mecanismo, em vez de planejar sua reimplementação. Isso não comprova sozinho encerramento em 10 s, ausência de processos órfãos ou controle do orçamento acumulado entre vários jobs e ferramentas externas. O harness precisa verificar esses casos e contabilizar o limite global de 30 min. Sem contenção verificável, não executar mídia. A meta de parada em até 10 s e sua margem de custo continuam no teste.

### Medição

Registrar tempo de inicialização/compilação, decode, inferência, busca e confirmação, separando cache frio e quente. Medir segundos por hora de mídia, latência p50/p95 quando a amostra permitir, candidatos por consulta, leituras, cache por hora de mídia e pico de RAM/VRAM. Não usar somente “itens por hora”.

Para energia, preferir medidor na tomada. Integrar potência medida: `kWh = soma(W × segundos) / 3.600.000`; registrar consumo bruto e, se disponível, consumo incremental sobre o idle medido. Telemetria GPU cobre apenas parte do computador. TDP não é consumo medido e não deve virar estimativa apresentada como fato.

Sem medição integral, declarar energia total desconhecida e usar os tetos de tempo/processamento. A revisão deverá aceitar explicitamente essa limitação ou exigir medidor; não afirmar que o teto de kWh foi cumprido com dados só da GPU. Custo em reais depende da tarifa fornecida pelo usuário.

Para examinar escalabilidade sem nova decodificação, usar subconjuntos de 20/50/100 entradas já indexadas, dentro dos mesmos 30 minutos. Verificar crescimento de candidatos, I/O e tempo. Isso é diagnóstico, não prova de escala para 3.631 vídeos. A projeção final deve considerar duração, codec, resolução, repetição de conteúdo e densidade do índice, com faixa de incerteza.

## 9. Integração e migração, somente após os gates

1. Publicar o relatório do piloto, incluindo falhas, custos e decisão B1/B2/encerrar. O revisor deve aprovar a implementação escolhida e seu orçamento antes de mudanças no produto.
2. Versionar a decisão separadamente do índice. Resultados antigos permanecem auditáveis, mas não herdam o novo selo de cópia validada. Preservar cache compatível; reprocessar apenas o necessário.
3. Não executar migração pesada no startup. Avaliar índices e journals por versão/identidade; cancelamento e retomada não podem misturar decisões antigas e novas.
4. Na web/mobile, mostrar classe, intervalos nos dois vídeos, cobertura de cada um, motivo, limitações e revisão do algoritmo. Mostrar `candidate_limited_pairs` e a limitação de publicação `truncated_matches` (teto atual de 50 matches por vídeo), sem afirmar busca completa quando acionados. Similaridade opcional fica fora da lista principal. Não tratar grupos transitivos como prova de todos os pares: A/B e B/C não provam A/C.
5. No backlog manual, apresentar escopo e estimativa de tempo/energia antes do disparo. Dimensionar também o armazenamento de produção; 42 GiB para 900 h é apenas cenário dos descritores atuais, sem o custo adicional de um novo índice global. O parecer sugere teto de 24 h para o backlog, ainda sujeito à decisão do usuário; não usar 10 s de mídia/s como substituto, pois 900 h nessa vazão já exigiriam 90 h antes de outras etapas. Começar com lote limitado; só ampliar com evidência e autorização explícita, nunca reabrir automaticamente o run 203.
6. Depois da validação, análise automática apenas para vídeo novo incluído, conforme requisito do usuário. Não revarrer periodicamente todo o catálogo. Mudanças de conteúdo invalidam a identidade de forma explícita, sem gerar loops de reprocessamento.
7. Rotinas de rostos ausentes e storyboard/VTT ausente continuam independentes; falha perceptual não deve bloqueá-las. VTT aqui é o índice de previews da timeline, não transcrição. Preservar as correções de erro/telemetria existentes.
8. Nenhuma classe autoriza excluir automaticamente mídia. Testes usam fontes somente leitura, saídas privadas e verificação de identidade. Qualquer futura escrita no banco real exige backup verificado e plano de retorno; o piloto isolado não precisa alterar o banco de produção.

## 10. Perguntas que o terceiro deve responder na revisão

- Qual é sua definição independente do problema e quais requisitos ainda estão ambíguos? Que abordagem consideraria antes de conhecer a proposta do autor?
- Quais afirmações deste documento são sustentadas por evidência, quais são hipóteses e quais podem induzir uma conclusão prematura? Há alternativa relevante omitida?
- A distinção entre cópia, containment, sobreposição, intro e semelhança atende ao objetivo? Aprova-se o piso inicial de 10 s e a exclusão de crop móvel/espelhamento/rotação da promessa inicial? A apresentação de intro inteira como conteúdo recorrente é adequada?
- Os exemplos de mesmo estúdio e clips curtos representam os casos difíceis reais? Como obter positivos naturais de clip-em-live? Como separar famílias e estimar carga de revisão sem tratar os 8.911 pares como negativos independentes?
- Os gates de recall, ausência de falsos positivos observados e localização são adequados? Quais classes podem ser apresentadas, e com qual incerteza?
- O VDF merece o baseline apesar das limitações documentadas? O custo/licença de integração compensa? Qual falha justificaria B2?
- A proposta de busca regional mantém recall para crop e clips em lives? Como detectar truncamento e evitar explosão de candidatos comuns?
- Os tetos de 2 h de trabalho, 30 min de processamento e 0,15 kWh medidos são aceitáveis? O que fazer se não houver medidor integral?
- Qual carga máxima de reports indesejados é aceitável no backlog e por consulta? O teto proposto de 24 h para a execução completa é aceitável? Qual é o orçamento máximo da implementação posterior? **Ainda não estimado nem aprovado.**

O parecer deve registrar **aprovar / aprovar com alterações / rejeitar**, limites e responsável pela decisão. Se qualquer requisito obrigatório ficar sem evidência, a recomendação é não liberar a varredura. Este documento não promete que outra implementação resolverá o problema; define como demonstrar utilidade antes de repetir o investimento.

## 11. Fontes

Todas acessadas em 21/09/2026. Links de branches e releases diárias podem mudar; fixar commits e hashes no futuro manifesto de execução.

1. [Video Duplicate Finder — README](https://github.com/0x90d/videoduplicatefinder): recursos, parâmetros, CPU, CLI e licenças.
2. [Video Duplicate Finder — releases](https://github.com/0x90d/videoduplicatefinder/releases): build diária, commit indicado e SHA-256 do artefato.
3. [Czkawka — guia do core na tag 12.0.2](https://github.com/qarmin/czkawka/blob/12.0.2/instructions/Instruction_Core.md#similar-videos): janelas, hashes, subclips e remoção de barras.
4. [Czkawka 12.0.2 — release](https://github.com/qarmin/czkawka/releases/tag/12.0.2): versão publicada.
5. [YouTube — How Content ID works](https://support.google.com/youtube/answer/2797370): matching no upload.
6. [YouTube — Content eligible for Content ID](https://support.google.com/youtube/answer/2605065): referências distintivas, segmentos e revisão.
7. [Videntifier — Identification Engine](https://videntifier.com/products/identification-engine): produto comercial e matches parciais.
8. [Videntifier — Solving Video Identification](https://videntifier.com/articles/solving-video-identification): descrição comercial de descritores locais; alegações não validadas aqui.
9. [Immich — Duplicates Utility](https://docs.immich.app/features/duplicates-utility/): similaridade e revisão pelo usuário.
10. [PhotoPrism — Duplicate Detection](https://docs.photoprism.app/user-guide/library/duplicates/): duplicatas exatas e distinção de arquivos relacionados.
11. [VDF — issue #908](https://github.com/0x90d/videoduplicatefinder/issues/908): relato aberto de falha de confirmação visual, não reproduzido nesta avaliação.
12. [Meta VSC2022 — baseline](https://github.com/facebookresearch/vsc2022/blob/main/docs/baseline.md): referência de pesquisa para recuperação e localização temporal.
13. [Faiss — instalação e compilação](https://github.com/facebookresearch/faiss/blob/main/INSTALL.md): ROCm por compilação e ausência documentada de pacote AMD GPU pronto.

## 12. Artefatos locais para auditoria

- [Relatório do piloto anterior](../spikes/perceptual-video-implementation-2026-09-21.md).
- [Primeiro piloto de hashes](../spikes/perceptual-video-pilot-2026-09-21.md).
- [Guia do motor existente](../perceptual-video-duplicates.md).
- [Sincronização da biblioteca](../library-synchronization.md).
- Código: `vision-service/src/vision_service/video_copy_match.py`, `video_copy_catalog.py`, `video_copy_index.py`, `video_copy_frames.py`, `video_copy_geometry.py`.
- Evidências privadas do incidente: `data/perceptual-duplicates-cache/` e registros do run `203`. Não copiar mídia, credenciais ou caminhos pessoais para um parecer público.

Os documentos antigos registram estágios anteriores e podem conter limites/configurações já modificados. Este plano não os transforma em prova de precisão de produção. O relatório do novo piloto deverá registrar o estado efetivamente executado.
