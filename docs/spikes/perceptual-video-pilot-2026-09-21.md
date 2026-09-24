# Piloto de duplicatas perceptuais em vídeos — 2026-09-21

## Decisão

O piloto confirma a viabilidade de reconhecer versões recomprimidas e clipes dentro de gravações longas usando a RX 7800 XT. Nos limiares testados, dHash com alinhamento temporal a 5 frames/s foi a melhor base exploratória: localizou os 40 positivos sem crop. Isso modifica a preferência inicial por PDQ; os resultados locais não sustentam usá-lo como detector principal nem como confirmação obrigatória que possa vetar o dHash.

A recomendação é um primeiro detector para revisão humana, com intervalos e resultados ambíguos explícitos. Ainda não há evidência para remoção automática, limiares de produção ou precisão sobre a biblioteca inteira. Crop e material quase estático continuam problemas abertos.

## Escopo e proteção da biblioteca

- Catálogo consultado exclusivamente com `default_transaction_read_only=on`: 3.631 vídeos disponíveis, aproximadamente 1.669 horas; H.264 2.063, AV1 1.212, HEVC 356.
- Backup custom do PostgreSQL criado antes do processamento; `pg_restore --file=/dev/null` validou sua leitura/descompressão. SHA-256 conferido ao final.
- Oito fontes reais: IDs 5535, 5270, 711, 1108, 2586, 112, 7 e 10. Janelas de 180 s, codecs H.264/HEVC/AV1, formatos horizontal e vertical, de 800×600 até 1920×1080/1080×1920.
- Cinquenta consultas controladas: seis transformações por fonte, mais dois controles de inversão temporal. Os positivos são derivados gerados a partir dos originais; não são pares naturais de arquivos duplicados previamente rotulados.
- Uma gravação completa de 20.512,465 s (5h41min52s), ID 5535, indexada adicionalmente e pesquisada sem informar a posição esperada ao algoritmo.
- A fonte inicial 5391 foi excluída: uma janela pedida de 180 s entregou apenas 467 frames a 5 fps; uma inspeção limitada de pacotes também mostrou comportamento de seek/PTS incompatível com a janela. Não foi diagnosticada/reparada a causa, nem contada como falha do hash.
- As nove fontes lidas, incluindo a excluída, conservaram device/inode/tamanho/mtime/ctime e SHA-256 amostral de início/meio/fim. Não foi feito um segundo hash integral de cada mídia.
- Ao final: 3.631 vídeos disponíveis, nenhuma conversão/job ativo nas filas consultadas e nenhum processo ffmpeg/ffprobe remanescente. Nenhum endpoint de mutação foi chamado.
- Saídas, dependências Python e backup ficam em `data/perceptual-pilot/2026-09-21/`, diretório privado, ignorado pelo Git. Foram mantidos cerca de 62,3 MiB de derivados de teste para reprodução; nenhuma mídia original foi removida.

## GPU e custo medido

Host verificado: Ryzen 5 5600G, RX 7800 XT, Mesa 26.2.2, FFmpeg n9.0.1, VAAPI em `/dev/dri/renderD128`. Não foi utilizado fallback silencioso para CPU. O caminho exige frames VAAPI, amostra enquanto os frames permanecem na GPU, reduz com `scale_vaapi` para 256×256 e só então faz `hwdownload`. Os hashes trabalham na CPU com as imagens pequenas.

A opção foi FFmpeg externo + `pdqhash`, porque a API Python de vPDQ não expõe configuração do dispositivo de aceleração. Nenhuma dependência dos serviços existentes foi alterada.

Comparação com o mesmo conteúdo, 30 s por codec, 5 fps, duas passagens em ordem GPU → CPU → CPU → GPU, CPU configurada com duas threads. Os arquivos já haviam sido lidos; isto não é uma medição de disco frio. Tempo total abaixo é a soma da extração e cálculo dos três hashes, sem busca no índice.

| Codec | Extração CPU | Extração GPU | Extração + hashes CPU | Extração + hashes GPU | Redução do tempo de CPU acumulado, pipeline |
|---|---:|---:|---:|---:|---:|
| H.264 | 1.99 s | 0.86 s | 2.22 s | 1.15 s | 81.7% |
| HEVC | 2.17 s | 0.75 s | 2.43 s | 0.99 s | 84.7% |
| AV1 | 2.73 s | 0.83 s | 3.00 s | 1.09 s | 90.8% |

A gravação completa foi indexada a 1 fps em **142.72 s**, com **81.08 s de CPU acumulados** para extração + três hashes. Foram 20,513 amostras, em 35 blocos de até dez minutos. O arquivo comprimido com os três descritores, qualidade e timestamps tem 644,174 bytes (~629 KiB), sem overhead de banco/índices.

Esse custo não deve ser extrapolado diretamente para as 1.669 horas: a gravação completa é H.264 800×600. As outras resoluções/codecs e o armazenamento apresentaram custos diferentes. O monitor de RSS mede apenas o filho FFmpeg, não o pico total de Python + buffers; a utilização GPU é uma amostragem grosseira, não consumo exclusivo do piloto.

## Como os métodos foram comparados

- Descritores: pHash DCT de 64 bits, dHash horizontal de 64 bits e PDQ de 256 bits. Todos recebem os mesmos frames RGB reduzidos.
- Limiares exploratórios: Hamming ≤10 para pHash/dHash e ≤31 para PDQ. Não houve calibração para igualar taxa de falsos positivos; a preferência observada não prova superioridade geral.
- Máscara de qualidade PDQ ≥50 aplicada igualmente aos três métodos. Cobertura calculada sobre amostras informativas; pelo menos metade da consulta precisa ser informativa.
- Aceitação: cobertura ≥80%, suporte temporal de pelo menos 5 s com lacunas limitadas, cinco hashes distintos. Hashes apenas distintos não garantem movimento ou diversidade semântica; esse limite apareceu no controle invertido.
- Mesma busca de velocidades 1,0 e 1,2 para todas as consultas. Não há suporte demonstrado a velocidades arbitrárias, montagens, cortes internos ou alinhamento elástico.
- Comparação das janelas em 1 e 5 fps; os dados de 1 fps foram subamostrados dos descritores de 5 fps. A gravação completa foi extraída diretamente a 1 fps.
- Os timestamps do harness são posições na grade após `setpts`/`fps`. Os erros abaixo são relativos ao recorte solicitado, não prova de precisão absoluta sobre PTS de VFR/arquivos com descontinuidades. Produção precisa preservar os PTS reais.

## Resultados nas oito janelas

Valores abaixo significam **detecção aceita e localização com erro ≤1 s**, a 5 fps. Cada célula tem oito positivos conhecidos.

| Transformação controlada | dHash | pHash | PDQ |
|---|---:|---:|---:|
| Janela integral, reduzida/recomprimida | 8/8 | 8/8 | 8/8 |
| Clipe de 30 s, reduzido/recomprimido | 8/8 | 8/8 | 8/8 |
| Clipe de 10 s, reduzido/recomprimido | 8/8 | 8/8 | 7/8 |
| Faixa branca cobrindo 18% da altura | 8/8 | 3/8 | 2/8 |
| Crop central: remove 20% da largura e da altura | 0/8 | 0/8 | 0/8 |
| 36 s reproduzidos em 30 s, velocidade 1,2× | 8/8 | 8/8 | 5/8 |

As transformações usam H.264 VAAPI QP30, 24 fps, dimensão máxima de 640 px. O crop conserva 80% de cada dimensão (64% da área). O overlay é uma faixa horizontal sólida; o bom desempenho do dHash nesse caso não prova robustez a logos ou layouts arbitrários.

Sem crop, dHash localizou 40/40, pHash 35/40 e PDQ 30/40. pHash aceitou um overlay adicional, mas escolheu uma posição cerca de 30,6 s distante da verdadeira. Portanto, contar somente matches aceitos esconderia uma falha de localização.

Com 1 fps, os matches aceitos sem crop caíram para 28/40 no dHash, 24/40 no pHash e 13/40 no PDQ. Indexar apenas a 1 fps com o mesmo limiar rígido pode perder clipes.

Nenhum dos três métodos disparou nas 336 comparações entre as 48 consultas transformadas e as sete outras fontes, em cada taxa. Esses pares não foram rotulados manualmente e não são independentes: isso é um controle exploratório, não estimativa de precisão da biblioteca.

Dois clipes também foram invertidos temporalmente: todos os métodos rejeitaram um e aceitaram o outro. O resultado não prova uma duplicata indevida (o conteúdo foi de fato reutilizado), mas prova que o alinhador não consegue garantir direção/posição em material visualmente repetitivo. O produto deve poder responder “ambíguo”, sem inventar confiança probabilística.

## Busca na gravação completa

A busca inicial percorreu os fingerprints de toda a gravação a 1 fps. Somente a posição encontrada foi relida a 5 fps para refinamento; o offset conhecido foi usado exclusivamente para avaliação.

| Consulta | Posição solicitada na gravação | dHash: erro após refinamento | pHash: erro | PDQ: erro |
|---|---:|---:|---:|---:|
| Clipe de 30 s | 8447.50 s | 0.10 s | 0.10 s | 0.10 s |
| Clipe de 10 s | 8493.45 s | 0.25 s | 0.05 s | 0.05 s |

O overlay também foi encontrado por dHash e pHash; PDQ ficou abaixo do limiar. O crop não foi aceito por nenhum método. A busca 1→5 fps funcionou nesses clipes da gravação completa, mas sua sensibilidade ainda precisa ser validada em outras fontes antes de substituir o baseline de 5 fps.

## Controle MPEG-7 / FFmpeg signature

Foram feitas sondagens a 5 fps e um controle separado a 24 fps em duas fontes, sempre com frames 256×256 e VAAPI antes do filtro CPU. A etapa de 24 fps exigiu suporte mínimo de 120 frames (~5 s). Ela não usa a mesma regra de cobertura de 80% do alinhador, portanto não integra a tabela comparativa principal.

Na montagem inicial, colocar o clipe curto na última entrada encerrou o processamento antes da leitura integral da referência e sem diagnóstico de matching. A montagem revisada coloca a referência por último; no controle 24 fps, recebeu um segundo final preto para tornar a ordem de EOF inequívoca. Uma execução de equivalência ainda terminou sem diagnóstico de comparação e foi mantida como inconclusiva, não como “sem match”.

No controle 24 fps, os quatro clipes de 10/30 s tiveram correspondências reportadas; os dois overlays e os dois crops não tiveram. As duas variantes 1,2× e a equivalência da fonte 5270 também tiveram correspondências; a equivalência 5535 ficou inconclusiva. Os dois controles invertidos também tiveram correspondências. Foram reportados segmentos de aproximadamente cinco segundos, sem provar cobertura integral. O filtro não mostrou vantagem suficiente para ser a base do primeiro índice e exige mais trabalho de integração/calibração.

## Próximo desenho recomendado

1. Baseline de dHash a 5 fps com timestamps reais, alinhamento e indicação de ambiguidade. Manter pHash/PDQ como alternativas avaliáveis; não exigir concordância com PDQ para aceitar um candidato.
2. Aproveitar VAAPI e jobs duráveis existentes, com concorrência baixa, cancelamento, checkpoint e publicação vinculada à revisão do arquivo. O hashing fica na CPU após redução da imagem.
3. Recuperar candidatos por índice de distância Hamming/buckets; o piloto fez comparação exaustiva em memória. Seus 2.400 pares/métodos consumiram ~19,5 s, mas isso não representa latência de uma busca sobre a biblioteca inteira.
4. Estudar a cascata de busca permissiva em 1 fps + refinamento em 5 fps como otimização separada. Nunca interpretar falta de match num índice grosseiro como certeza de ausência de trecho.
5. Para crops, testar fingerprints por regiões/múltiplos recortes ou descritores locais. Para cenas estáticas, testar evidência de movimento, margens entre alinhamentos concorrentes e/ou áudio auxiliar. Não simplesmente afrouxar todos os limiares.
6. Antes de produção, ampliar o conjunto com pares naturais da biblioteca e negativos difíceis rotulados, separar calibração/avaliação e medir a recuperação do índice. No Kura, expor equivalência, conteúdo contido e sobreposição, com intervalos e cobertura nos dois sentidos.

## Evidência e reprodução

Os resultados detalhados estão no diretório privado `data/perceptual-pilot/2026-09-21/`:

- `preflight.json`, `backup.json`, `postcheck.json`, `verification.json`: catálogo, backup e integridade.
- `samples.private.json`, `catalog.private.json`, `excluded.private.json`: seleção e caminhos privados; não publicar.
- `cases.json`, `matches.json`, `summary.json`: matriz de 50 consultas, 2.400 comparações e resultados.
- `timings.jsonl`, `full-index.json`, `full-matches.json`, `signature24-results.json`: medições por etapa e gravação completa.
- `pilot.py`, `compare.py`, `long_video.py`, `signature24.py`: scripts do experimento; `requirements.lock` e `manifest.json` registram versões/checksums.

Para reproduzir, usar um novo diretório de execução e repetir preflight/seleção; os caches deste harness exploratório usam nomes de arquivo e não são um contrato de invalidação para produção. Os scripts não devem ser instalados como worker da aplicação sem revisão. Nenhum endpoint, schema ou serviço da aplicação foi alterado.

Referências técnicas: [vPDQ e suas limitações temporais](https://github.com/facebook/ThreatExchange/blob/main/vpdq/README.md), [binding PDQ](https://pypi.org/project/pdqhash/), [signature do FFmpeg](https://ffmpeg.org/ffmpeg-filters.html#signature), [implementação e ordem de EOF](https://github.com/FFmpeg/FFmpeg/blob/master/libavfilter/vf_signature.c).
