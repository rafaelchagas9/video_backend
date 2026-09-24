# Alternativas para recuperação global de duplicatas de vídeo

Data: 2026-09-21

## Decisão

Não adicionar Qdrant ou outro banco vetorial nesta entrega. Qdrant é a alternativa externa mais
plausível para um spike posterior, mas não é uma troca isolada do índice: exige um novo serviço,
um protocolo de publicação entre o catálogo e o banco vetorial e uma mudança no armazenamento dos
descritores para caber nos limites atuais.

Esta avaliação foi somente leitura. Nenhuma imagem foi baixada, nenhum serviço foi instalado ou
iniciado, nenhuma mídia foi aberta e nenhum arquivo derivado da biblioteca foi criado.

## Evidência atual

- A versão estável mais recente observada foi a
  [Qdrant v1.19.1](https://github.com/qdrant/qdrant/releases/tag/v1.19.1).
- Qdrant oferece vetores densos `float16`, reduzindo o original de quatro para dois bytes por
  dimensão. O tipo do vetor original é diferente da quantização, que cria outra representação ao
  lado dele. Consulte [Vectors](https://qdrant.tech/documentation/manage-data/vectors/).
- A quantização pode ficar em RAM enquanto o original permanece em disco e pode fazer rescore nos
  originais. A documentação recomenda medir recall no próprio conjunto; product quantization
  prioriza memória quando precisão e velocidade não são críticas. Para 512 dimensões, as opções
  binárias mais agressivas também precisam de validação específica. Consulte
  [Quantization](https://qdrant.tech/documentation/manage-data/quantization/).
- Qdrant usa WAL e versões por ponto/segmento para recuperar alterações depois de uma queda. Isso
  resolve durabilidade dentro do serviço, mas não cria uma transação única com `catalog.json` e os
  checkpoints do backend. Consulte [Storage](https://qdrant.tech/documentation/manage-data/storage/).
- Desde a versão 1.13, a construção de HNSW pode usar GPU em instalações locais e o backend Vulkan
  inclui AMD. A evidência publicada cobre aceleração da **construção** do índice; ela não demonstra
  busca GPU para esta carga. Consulte o
  [anúncio da versão 1.13](https://qdrant.tech/blog/qdrant-1.13.x/) e o guia de
  [GPU HNSW](https://qdrant.tech/documentation/tutorials-operations/gpu-accelerated-hnsw-indexing/).

## Capacidade para 66 milhões de descritores

Estimativa para 66 milhões de pontos, 512 dimensões, uma réplica e HNSW `m = 16`, aplicando as
fórmulas oficiais de [Capacity Planning](https://qdrant.tech/documentation/capacity-planning/):

| Estrutura | Cálculo | Tamanho aproximado |
| --- | --- | ---: |
| Originais FP16 | `66 M × 512 × 2 B` | 67,58 GB / 62,94 GiB |
| Grafo HNSW | `66 M × 16 × 2 × 4 B × 1,2` | 10,14 GB / 9,44 GiB |
| ID tracker | `66 M × 52 B` | 3,43 GB / 3,20 GiB |
| Cópia PQ 16× | `66 M × 512 × 4 B ÷ 16` | 8,45 GB / 7,87 GiB |
| Subtotal | sem payload e índices de payload | 89,60 GB / 83,45 GiB |
| Planejamento em disco | subtotal com 20% de folga | 107,52 GB / 100,14 GiB |

A folga recomendada cobre WAL, snapshots e segmentos temporários, mas a conta ainda exclui payload,
índices de payload e o cache local do conversor. O cache local FP16 das 11 vistas ocupa cerca de
63 GiB somente em descritores no cenário de 66 milhões. Manter esse cache e também os originais
FP16 no Qdrant passa de 160 GiB antes de todas as estruturas, acima do contrato de 128 GiB.

Remover o cache local não é uma otimização transparente. O worker precisa das vistas do vídeo que
atua como consulta e dos timestamps/miniaturas para montar e verificar janelas. Recuperar dezenas
de milhares de vetores por vídeo pela API, ou decodificar novamente toda vez, muda o custo e o
modelo de falha. Usar `turbo4` como original reduziria disco, mas mudaria a evidência de recuperação
e exigiria um novo gate de recall.

Para RAM, grafo HNSW, PQ 16× e ID tracker somam cerca de 22,02 GB; com 20% de folga, 26,42 GB
(24,61 GiB). Isso já encosta na recomendação oficial de manter um nó abaixo de 80% dos 31 GiB
físicos desta máquina, antes de payload indexes, Qdrant, PostgreSQL, backend e sistema operacional.
Mover o grafo para a camada fria economiza RAM, mas a própria documentação alerta que as leituras
aleatórias da travessia HNSW sofrem com a latência de disco.

## Integração e recuperação de falhas

Cada ponto precisaria carregar, no mínimo, `video_id`, timestamp, vista e alguma identidade da
fonte. A comparação manual requer filtro positivo para 2–12 vídeos; o catálogo requer excluir
fontes removidas, alteradas, ainda não publicadas ou de outra geração sem permitir que vetores
obsoletos ocupem todo o `top-k`.

O WAL do Qdrant protege operações aceitas pelo serviço, mas a substituição de todos os pontos de um
vídeo e a publicação do catálogo são commits em sistemas diferentes. Uma integração segura precisa
de duas fases:

1. gravar os novos pontos sob um token ainda inelegível;
2. conferir contagem, identidade e visibilidade;
3. tornar o token elegível no catálogo;
4. retirar os pontos antigos de forma repetível;
5. reconciliar uploads parciais no startup antes de responder buscas.

Sem esse protocolo, uma queda pode deixar descritores antigos ou parciais competindo no `top-k` e
produzir falso negativo. Com o protocolo, a solução deixa de ser uma simples substituição de
arquivos FAISS e passa a incluir cliente, health check, migração, autenticação local, backup,
monitoramento e recuperação de duas fontes de verdade.

## Inventário local

O host tem Docker e armazenamento NVMe, mas não havia container, imagem ou configuração Qdrant.
Existe uma imagem PostgreSQL com pgvector usada pelos testes e o projeto já usa pgvector para
rostos. Isso não torna PostgreSQL uma boa opção para esta carga: os 67,58 GB de `halfvec` vêm antes
do overhead de linhas/páginas e do HNSW, e a carga concorreria com o banco da aplicação.

## Próximo gate, se a alternativa for retomada

Um spike separado pode testar Qdrant 1.19.1 com 1–5 milhões de descritores representativos. A
adoção exige, antes de qualquer backlog real:

- recall contra vizinhos exatos e contra os sentinelas rotulados;
- p50/p95 com filtro por vídeo e com atualização incremental;
- pico de RAM, disco, WAL e espaço temporário durante otimização;
- queda injetada em cada fase da troca de token e reconciliação no restart;
- prova de que payloads obsoletos não ocupam o `top-k` elegível;
- estimativa validada para 66 milhões dentro dos 32 GiB de RAM e 128 GiB de cache.

Até esses gates passarem, adicionar o serviço aumenta a superfície operacional sem comprovar que
remove o limite de custo da recuperação global nesta máquina.
