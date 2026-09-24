# Duplicatas perceptuais: implementação AMD e validação de crop

Data: 21/09/2026. Implementação `sscd-regions-sift-temporal-v2`.

## Resultado e escopo

Motor e API assíncrona implementados, com índices reutilizáveis e comparação de lotes de 2–12 vídeos. A API de hashes exatos foi preservada. Não há varredura automática de todo o catálogo nem interface nova no Kura nesta entrega.

A solução combina SSCD de 512 dimensões (seis vistas por frame) em FP32/MIGraphX, busca exata na GPU, decode/resize VAAPI, SIFT/RANSAC com cobertura da região compartilhada e confirmação do movimento ao longo do tempo. Resultados ambíguos são separados dos verificados; não há exclusão automática.

## Pesquisa AMD e escolha técnica

- A linha de produção mais recente é ROCm 10.0.0 (26/08/2026); a manutenção 7.14.1 saiu em 02/09/2026. A transição TheRock altera empacotamento. [Histórico AMD](https://rocm.docs.amd.com/en/latest/release/versions.html), [guia de transição](https://rocm.docs.amd.com/en/develop/about/transition-guide-TheRock.html).
- A máquina já usa ROCm/HIP/MIOpen 7.2.4, MIGraphX 7.2.3 e ONNX Runtime MIGraphX 1.25.0. Mantive essa combinação, validada diretamente na RX 7800 XT. Arch não consta entre as distribuições Radeon oficialmente validadas. [Matriz AMD](https://rocm.docs.amd.com/en/latest/compatibility/compatibility-matrix.html).
- SSCD tem pesos oficiais e licença MIT; é especializado em cópias. O repositório está arquivado, mas o modelo foi exportado sem depender do antigo framework de treino. Alternativas como XFeat/LightGlue são úteis para pesquisa de correspondências locais; não substituí o caminho ONNX comprovado por uma nova pilha PyTorch. [SSCD](https://github.com/facebookresearch/sscd-copy-detection), [XFeat](https://github.com/verlab/accelerated_features), [LightGlue](https://github.com/cvg/LightGlue).

## Método do ensaio

Oito fontes reais foram lidas sem alteração. Foram usados os mesmos trechos de 180 s do primeiro piloto e transformações conhecidas feitas em cópias privadas. Os crops estreitos/móveis foram gerados para as seis fontes landscape. A busca não recebeu o offset correto. Os 28 pares entre fontes diferentes são controles, sem rotulagem manual exaustiva; não constituem uma estimativa estatística de falsos positivos da biblioteca.

| Transformação | Verificados | Ambíguos | Sem correspondência | Total |
|---|---:|---:|---:|---:|
| Crop: 80% da largura e altura (64% da área) | 8 | 0 | 0 | 8 |
| Crop estreito: cerca de 31,6% da largura | 5 | 1 | 0 | 6 |
| Crop estreito com posição variável | 4 | 2 | 0 | 6 |
| Trecho de 10 s | 7 | 1 | 0 | 8 |
| Trecho de 30 s | 8 | 0 | 0 | 8 |
| Overlay de 18% da altura | 7 | 1 | 0 | 8 |
| Velocidade 1,2× | 8 | 0 | 0 | 8 |
| Ordem temporal invertida | 0 | 1 | 1 | 2 |

Controles entre fontes: 0 relações retornadas em 28 pares. Mediana por consulta: 9.03 s, com as referências já indexadas; inclui indexação da consulta quando necessária, recuperação adicional de candidatos para diagnóstico e confirmação. Esses tempos não incluem a primeira compilação do modelo nem a indexação inicial das referências.

No piloto anterior, dHash/pHash/PDQ reconheceram 0/8 crops moderados. O ganho aqui depende tanto da recuperação por regiões quanto da correção do denominador espacial: áreas removidas pelo crop e barras pretas não devem reduzir artificialmente a cobertura de pontos válidos.

## Live inteira

Uma fonte de 20512.46 s foi indexada integralmente: 20513 frames, 317.70 s de parede e 365.52 s de CPU acumulada (Python + FFmpeg). Este é um arquivo H.264 800×600; não extrapolar esse tempo para o catálogo inteiro.

- crop20: verified; offset conhecido 8447.500 s; consulta em 8.58 s.
  - Query 0.000–29.000 s ↔ live 8447.477–8476.727 s.
- clip10: ambiguous; offset conhecido 8493.450 s; consulta em 6.95 s.
  - Query 0.000–9.000 s ↔ live 8493.477–8502.477 s.

## Provas de execução e integração

- ONNX/MIGraphX versus TorchScript oficial: maior erro absoluto 4.32e-07; menor cosseno 0.999999881.
- Perfil de warmup confirmou nós executados no MIGraphX. CPU fallback desabilitado; FP32 obrigatório. Busca GPU Top-K concordou com a referência exata CPU em teste de múltiplos blocos.
- Primeira compilação SSCD ~84 s; rede aquecida ~11 ms por oito imagens. Esses números são apenas da rede, não do pipeline.
- Bun runner → CLI Python → FFmpeg/MIGraphX → validação Zod: sucesso real, revisão `sscd-regions-sift-temporal-v2`, 1 relação retornada.
- Os 99 arquivos da suíte unitária do backend passaram, incluindo 11 testes focados de rotas/runner; 4 integrações PostgreSQL descartáveis, TypeScript e ESLint também passaram. Os 102 testes Python passaram e incluem cache, cancelamento/lock, geometria, negativos com logo compartilhado, temporalidade e erros sem vazamento de caminhos.
- Identidades das oito fontes após o ensaio: preservadas=True. Fonte da live após o teste integral: preservada=True. Banco real e arquivos de mídia não foram modificados pelo piloto.

## Limites que permanecem

- Evidência em transformações controladas não demonstra precisão de produção sobre todas as duplicatas naturais. Os limiares ainda precisam de uma coleção rotulada de positivos/negativos difíceis.
- Pouca textura/movimento, reutilização de fundos e alinhamentos concorrentes podem resultar em ambiguidade ou ausência de resultado. Nenhum resultado autoriza apagar mídia.
- Há oito hipóteses por par. `candidate_limited_pairs` informa quando esse orçamento limita a busca. Trechos curtos, reversão, espelhamento e edições extremas não têm cobertura garantida.
- Os intervalos são estimativas a partir de amostras. `timing_error_seconds` é resíduo do ajuste, não um limite garantido para o erro absoluto das bordas.
- Cache limitado a 32 GiB por padrão, reserva de 1 GiB livre e lock compartilhado entre workers. Nenhuma alteração de driver/runtime do host foi necessária.

Veja o [guia de operação e API](../perceptual-video-duplicates.md). Artefatos privados ficam em `data/perceptual-pilot/2026-09-21/crop-v2/`, fora do Git.
