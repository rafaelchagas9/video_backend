# Detecção de cópias de vídeo: correção v4 e evidências

Data: 21/09/2026. Este documento substitui as recomendações operacionais da tentativa v3,
mas preserva seu [relatório de reprovação](video-duplicate-redesign-v3-2026-09-21.md).

## Problema e resultado esperado

A biblioteca contém 3.631 vídeos, aproximadamente 1.669 horas. O usuário precisa encontrar
um clip dentro de uma gravação maior, inclusive após recompressão, mudança de resolução ou crop.
Cenas diferentes no mesmo estúdio, roupa, pessoa ou abertura não devem aparecer como cópias.
A rodada original consumiu cerca de três horas para 133–134 itens, teve cinco falhas e produziu
18 reports: um confirmado como cópia, um aceitável como similaridade e 16 indesejados.
Os 16 negativos representam cinco famílias relacionadas, não 16 situações independentes.
A tentativa seguinte deixou o recurso bloqueado na interface, portanto não era uma entrega utilizável.

O objetivo desta correção é entregar a análise acionável na tela de manutenção do Kura,
com backlog manual, cancelamento/retomada e automação opcional somente para novos cadastros.
Não há remoção automática de mídia. A cobertura apresentada deve corresponder apenas aos
intervalos realmente comprovados; descobrir parte de uma cópia não autoriza rotular todo o arquivo.

## Mudanças no motor

- **Descoberta global em duas etapas.** Descritores SSCD de todas as vistas em âncoras a cada
  dois segundos consultam HNSW-SQ8 (`M=16`, busca `ef=64`). Sequências coerentes abrem corredores
  temporais locais, refinados com descritores a 1 fps. Frames de SSCD fracos no meio de um crop
  não eliminam a sequência antes da confirmação visual.
- **Concorrência entre referências.** A seleção considera a diferença em relação a outros vídeos,
  além da similaridade bruta. Isso reduz a prioridade de cenários comuns; não constitui prova de cópia.
- **Crop e movimento.** Frames de verificação preservam a proporção. Três âncoras geométricas
  independentes estabelecem a transformação; checagens de pixels/gradientes a propagam entre
  frames com poucos pontos SIFT. Uma extensão pode reutilizar a transformação de um trecho já
  verificado. A decisão continua exigindo evolução temporal correlacionada, transformação estável
  e amostras densas. Não basta reconhecer um fundo estático.
- **Movimento distribuído.** A auditoria construiu um estúdio estático com a mesma tarja animada
  sobre ações diferentes. Correlação global sozinha o aceitava. A confirmação agora exige movimento
  compartilhado repetido e distribuído na região visível comum; o mesmo vídeo com a tarja continua
  aceito. Casos adversariais também deslocam a tarja para fronteiras da grade, para que uma mudança
  de posição não transforme a mesma faixa estreita em prova espacial independente.
- **Alinhamento de frações de segundo.** Dentro de ±0,45 s, o alinhamento fotométrico escolhe o
  frame correspondente, em vez de sempre escolher o timestamp mais próximo. Limiar de movimento
  não foi reduzido para fazer os positivos passarem.
- **Custo limitado.** Cache de frames/feições evita decodificar janelas sobrepostas repetidamente;
  elegibilidade de tokens é vetorizada. Blocos HNSW fechados usam leitura mapeada somente para
  leitura; blocos em atualização preservam o carregamento normal. Candidatos e janelas têm tetos,
  e a resposta informa quando a busca ficou incompleta.
- **Lacunas reais de timestamps.** Um negativo revelou salto de 1,616 s na referência 66.
  Essa janela agora é rejeitada e contabilizada como verificação incompleta; não derruba as
  outras comparações da consulta. Regressão de timestamps, falha VAAPI e erro do FFmpeg continuam
  fatais. O limite de continuidade não foi aumentado nem se inventam frames para fechar lacunas.
- **Independência da ordem de inclusão.** A confirmação usa o vídeo menor como consulta e
  converte os candidatos e resultados para preservar a orientação pública. Isso corrige um
  crop aceito como clip→gravação, mas perdido como gravação→clip, sem relaxar limiares.
- **Geração nova.** Resultados pertencem a `sscd-temporal-v4`; o índice global fica em `retrieval-v4`.
  Decisões antigas não são promovidas. Descritores compatíveis podem ser reaproveitados.

A classificação do produto permanece independente do recuperador: clip contido exige pelo menos
85% do menor vídeo; sobreposição parcial exige pelo menos 60 s e 5% dos dois; similaridade fica
separada e é opcional. Intro curta ou 1% de uma live não entra na lista principal de cópias.
A automação publica preferência, geração e referência de maior ID numa transação sob o mesmo lock,
para que reativá-la não transforme o acervo antigo em novos cadastros.

## Métodos comparados e descartados

1. Exigir nove hits fortes e consecutivos de SSCD no refinamento recuperou apenas 9/24 casos
   de desenvolvimento. Foi descartado: score de descritor não deve substituir verificação do crop.
2. IVF-PQ foi reavaliado pela recuperação da origem correta, não apenas por recall arbitrário de
   vizinhos. No mesmo corpus de 1.007.514 descritores e 14 consultas, HNSW-SQ8 recuperou 14/14;
   IVF-PQ com `nprobe=16` e `64` recuperou 12/14, perdendo crop horizontal e barras. Além disso,
   a busca do positivo natural levou 4,64/10,39 s no IVF-PQ contra 0,45 s no HNSW. Não foi adotado.
3. Recalcular SIFT em todos os frames perdeu crops de pouco detalhe e repetiu trabalho. A solução
   mantém provas geométricas independentes no início e confirma pixels/movimento ao propagar a transformação.
4. Aceitar imediatamente uma transformação derivada de uma única âncora foi rejeitado na auditoria;
   o código final exige três âncoras no início de uma sequência nova.

## Protocolo e medições

As variantes foram geradas anteriormente de oito fontes reais, sem modificar os originais:
clips de 10/30 s, crop de 20%, crop severo vertical/horizontal e barras. Quatro fontes formaram
24 casos de desenvolvimento; quatro outras formaram 24 casos inicialmente reservados.
A busca incluiu 139 referências e 1.023.354 descritores, misturando o acervo original de seis
vistas e oito referências do piloto com onze vistas. Ela não recebeu o ID correto como dica.
A confirmação recebeu apenas os candidatos retornados pelo índice global.

Na regressão final com três âncoras e movimento distribuído, desenvolvimento: **24/24**
recuperados e confirmados com cobertura do clip ≥85%, 148,47 s totais, mediana 5,53 s.
Reservados: **24/24**, 123,89 s totais, mediana 5,72 s. Cada consulta retornou exatamente
uma referência candidata, a correta. Esses tempos usam descritores existentes, mas fazem
decodificação e confirmação reais. As duas execuções registraram hashes de código iguais
no início e no fim. O conjunto reservado já havia sido consultado durante o desenvolvimento;
essa reexecução é regressão, não um novo teste cego.

Um teste separado pelo runner Bun/Python real iniciou sem descritores para dois clips de 30 s:
**6,62 s** para inicialização, indexação, busca e confirmação, com cobertura observada de 91,94%.
O perfil confirmou `MIGraphXExecutionProvider`, FP32, ONNX Runtime 1.25 e decode VAAPI.
O compilado do modelo já existia; portanto não é uma medição de primeira compilação da rede.
Identidade dos arquivos de entrada foi conferida antes/depois e permaneceu igual.

Após congelar o verificador com movimento distribuído, foram gerados quatro novos crops
(40% da largura/altura) de duas outras fontes, 20 e 87. Contra as fontes completas, de 230,7 e
1.306,6 segundos, indexadas com onze vistas: **4/4** recuperados e confirmados, uma referência por
consulta, cobertura de 91,89%, 20,65 s totais de busca/confirmação com descritores existentes.
Uma primeira consulta desses crops contra as referências legadas de seis vistas perdeu os dois
crops horizontais; por isso essa configuração não é reutilizada como índice final de produção.
O código de migração precisa completar as cinco vistas horizontais antes de publicar a referência.
Essa falha está preservada em `fresh/results-legacy-six-view.json`.

O par natural confirmado pelo usuário (179/180) foi recuperado sozinho. A consulta completa de
179 levou **22,46 s** usando descritores existentes e verificou cerca de 5,48%/5,50% dos arquivos,
classificado como sobreposição parcial. Isso preserva o positivo sem inventar cobertura integral.
O par 38/42 foi recuperado, mas a correção não confirmou uma cópia; similaridade não é uma
exigência de recuperação de cópias. Não se atribui rótulo de verdade aos demais pares desconhecidos.

### Validação final e publicação

- **Negativos históricos:** nenhum dos 16 pares indesejados entrou na lista principal de
  cópias. São cinco famílias independentes. Fragmentos ambíguos de cerca de 23 s e 9 s foram
  suprimidos pela política de relevância; isso não é evidência de ausência de qualquer trecho comum.
- **Contrato de produção:** o runner real Bun/Python passou pela validação estrita do resultado.
  O runner de catálogo publicou a primeira referência e, na segunda chamada, reutilizou-a e
  confirmou a cópia. As saídas ficaram isoladas do catálogo operacional.
- **Motor Python:** 109/109 testes passaram na versão final, incluindo crops, movimento
  distribuído, inversão temporal, índices vazios, recuperação e integridade do catálogo.
- **Backend e interfaces:** passaram os testes de integração de sincronização (14) e análise
  perceptual (7), testes do transporte (6), apresentação do catálogo (8), web Playwright (2)
  e componentes mobile (6). Typecheck passou nos dois repositórios; lint sem erros, com avisos
  preexistentes no Kura. Os testes mobile não substituem execução em aparelho físico.
- **Disponibilidade:** a configuração padrão agora habilita a análise perceptual. O serviço
  local em modo watch recarregou e respondeu HTTP 200 no health. Não existe override local
  desabilitando o recurso. A preferência persistida de automação estava **ativada** e foi
  preservada; a geração atual usa o ID 5651 como referência para processar somente novos
  cadastros posteriores. O backlog antigo continua manual e não foi iniciado nesta correção.
- **Limite da verificação visual:** o navegador disponível ficou na tela de login. A revisão
  automática de permissões rejeitou obter uma sessão assinada a partir de credenciais do banco
  e segredo da aplicação. Essa via não foi repetida. Não houve validação da tela real autenticada
  nem disparo HTTP de um job operacional; os testes de interface usaram fixtures autenticadas.

O teste da ordem de inclusão inicialmente confirmou apenas três dos quatro crops quando a
consulta era a gravação inteira. Após normalizar a confirmação pela linha temporal menor,
**4/4** foram confirmados na ordem inversa, com cobertura dos clips entre 91,89% e 100%, em
35,10 s totais. O positivo natural permaneceu verificado na lista principal (`partial_overlap`).
Os 52 ensaios na direção clip→fonte seguem pelo mesmo ramo do verificador que já passava;
a nova direção tem regressão própria. O erro temporal diagnóstico é convertido para a unidade
do eixo público B quando se inverte o par, e índices vazios se abstêm sem criar amostras.
Esses dois últimos ajustes de diagnóstico/entrada vazia foram testados pela suíte CPU após o
ensaio de mídia; não alteram sua classificação ou segmentos. Hash final de `video_copy_match.py`:
`f26387f452fec9f1aab3752131529b4ec7dba4d949ec647abd96298762930063`.

## Recursos, limites e interpretação

Um bloco de 1.007.514 descritores mediu 661,2 MB de índice e 29,2 MB de metadados. Abertura
mapeada: 4 ms e 319 MiB RSS após uma busca; abertura convencional: 107 ms e 680 MiB.
O processo percorre um bloco por vez; não mantém 66 blocos simultaneamente em RAM.
A projeção de disco para cerca de 66 milhões de descritores é 43,4 GB de índice + 1,9 GB de
metadados, além dos descritores privados (até 67,7 GB antes da compressão NPZ). A cota padrão
é 128 GiB, com verificação de espaço livre e reserva para gravações atômicas. O tamanho final
completo ainda não foi medido. O mapeamento não elimina a leitura de páginas acessadas pela busca.

Indexação fria adicional sobre fontes originais, sem resultados/descritores reaproveitados:
três janelas de 180 s levaram 4,51 s, 10,19 s e 4,37 s; as duas fontes completas de 230,7 s e
1.306,6 s levaram 6,83 s e 32,27 s. No conjunto, cerca de 34,6 minutos de mídia em 58,17 s:
aproximadamente 35,7 segundos de mídia por segundo. Uma extrapolação puramente linear para
1.669 horas daria **cerca de 47 horas apenas para indexação**, antes de construção/busca global
e confirmação. A amostra é pequena e mistura resoluções/codecs; isso não é um ETA certificado.
A faixa observada das janelas isoladas variou aproximadamente de 18× a 41×. A indexação inicial
continua sendo trabalho de longa duração; o ganho não a transforma em uma tarefa de minutos.

Não foi feita uma varredura das 1.669 horas nesta correção, nem medida energia em kWh. Os tempos
acima não são uma promessa de duração total do backlog. O índice global elimina a comparação
visual exaustiva entre todos os pares; indexação fria, quantidade de candidatos e I/O ainda afetam
a primeira passagem. O usuário pode iniciar o backlog e acompanhar/cancelar pela tela.

52 variantes de dez fontes não demonstram recall universal, e os negativos históricos não são
centenas de famílias independentes. Alteração de velocidade, crops extremos além do ensaiado,
vídeos sem evolução visual suficiente e fontes com falhas podem ficar sem confirmação. Limites
atingidos são apresentados como incompletude, não como prova de ausência de cópias.

## Referências e reprodução

- [Baseline oficial VSC/Meta](https://github.com/facebookresearch/vsc2022/blob/main/docs/baseline.md):
  descritores SSCD, recuperação e localização temporal. A normalização aqui usa competidores do
  catálogo; não é reprodução da normalização com conjunto de ruído independente do baseline.
- [VCSL](https://github.com/alipay/VCSL): separar recuperação de localização temporal.
- [FAISS index I/O](https://github.com/facebookresearch/faiss/blob/main/faiss/index_io.h):
  suporte `IO_FLAG_MMAP_IFC` para o armazenamento de códigos usado no ensaio.

Artefatos privados e executáveis do ensaio: `data/perceptual-pilot/2026-09-21/redesign-v4/`.
`evaluate.py` executa recuperação global + confirmação; `codec_compare.py` compara os codecs
sobre o mesmo corpus; `cold-runner.ts` exercita o transporte de produção com saídas isoladas.
Os arquivos privados contêm caminhos locais e não devem ser publicados junto com este relatório.
