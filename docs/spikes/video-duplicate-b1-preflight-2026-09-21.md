# B1 — preflight documental do Video Duplicate Finder

Data: 21/09/2026. Escopo: inspeção somente leitura da documentação e do código-fonte público do VDF. Não houve download de artefato, instalação, build, execução do programa, FFmpeg, GPU, acesso a mídia ou alteração de serviços.

## Versão fixada

- Release diária mutável: [`4.1.x`](https://github.com/0x90d/videoduplicatefinder/releases/tag/4.1.x).
- Último build indicado pela release durante este preflight: commit completo [`83ce18691aa5813b0747667c8d2c22befbd0c9cf`](https://github.com/0x90d/videoduplicatefinder/commit/83ce18691aa5813b0747667c8d2c22befbd0c9cf).
- Metadado publicado pela [API da release `4.1.x`](https://api.github.com/repos/0x90d/videoduplicatefinder/releases/tags/4.1.x) para `CLI-linux-x64.tar.gz`: atualizado em `2026-09-21T06:27:32Z`, 14.141.069 bytes, SHA-256 `9980869c66856a8ad74fd7163ec5d994e61ae9b10f87937f10e027ccd81cf0dd`. O artefato não foi baixado; o hash foi conferido apenas no metadado da API da release.

Como os anexos de `4.1.x` são substituídos a cada commit, qualquer ensaio posterior deve registrar novamente o SHA completo do commit e o digest do artefato antes de executar.

## Resultado dos requisitos

| Requisito | Constatação no commit fixado | Resultado |
| --- | --- | --- |
| 1. Configurar razão mínima parcial em `0.001` | A CLI expõe `--partial-clip-min-ratio` como `double`, sem arredondamento nem clamp na aplicação ao `Settings`; o laço usa diretamente `ratio < PartialClipMinRatio`. Para 10 s em 2 h, `10 / 7200 = 0,001388…`, portanto o filtro de duração deixa o par passar com `0.001`. Fontes: [`SharedOptions.cs` L118-L126](https://github.com/0x90d/videoduplicatefinder/blob/83ce18691aa5813b0747667c8d2c22befbd0c9cf/VDF.CLI/Commands/SharedOptions.cs#L118-L126), [`SharedOptions.cs` L212-L220](https://github.com/0x90d/videoduplicatefinder/blob/83ce18691aa5813b0747667c8d2c22befbd0c9cf/VDF.CLI/Commands/SharedOptions.cs#L212-L220), [`ScanEngine.cs` L2123-L2154](https://github.com/0x90d/videoduplicatefinder/blob/83ce18691aa5813b0747667c8d2c22befbd0c9cf/VDF.Core/ScanEngine.cs#L2123-L2154). | **Passa** como configuração aceita pelo código. Não prova recall. |
| 2. Amostragem compatível com clips de pelo menos 10 s em lives de 2 h, inclusive clip silencioso com crop | O modo por áudio não cobre silêncio. O modo visual DINOv2 é declarado como apto a silêncio e crop, mas sua amostragem não é configurável pela CLI: intervalo-base mínimo de 5 s, máximo de 400 frames e intervalo da fonte de 2 h ampliado para 18 s pelo limite de frames. A aceitação exige pelo menos quatro hits com offset coerente. Assim, um clip de 10 s fornece poucos instantes próprios e pode cair entre amostras da fonte; o código não sustenta um compromisso de cobertura para esse limite. A implementação usa frames completos redimensionados para 224×224; não há vistas de crop explícitas nesse passe. Fontes: [`README.md` L30-L49](https://github.com/0x90d/videoduplicatefinder/blob/83ce18691aa5813b0747667c8d2c22befbd0c9cf/README.md#L30-L49), [`ScanEngine_AiPartial.cs` L22-L40](https://github.com/0x90d/videoduplicatefinder/blob/83ce18691aa5813b0747667c8d2c22befbd0c9cf/VDF.Core/ScanEngine_AiPartial.cs#L22-L40), [`ScanEngine_AiPartial.cs` L95-L135](https://github.com/0x90d/videoduplicatefinder/blob/83ce18691aa5813b0747667c8d2c22befbd0c9cf/VDF.Core/ScanEngine_AiPartial.cs#L95-L135), [`ScanEngine_AiPartial.cs` L260-L310](https://github.com/0x90d/videoduplicatefinder/blob/83ce18691aa5813b0747667c8d2c22befbd0c9cf/VDF.Core/ScanEngine_AiPartial.cs#L260-L310), [`FfmpegEngine.cs` L1127-L1169](https://github.com/0x90d/videoduplicatefinder/blob/83ce18691aa5813b0747667c8d2c22befbd0c9cf/VDF.Core/FFTools/FfmpegEngine.cs#L1127-L1169). | **Não passa** o gate de desenho para `>=10 s`. Crop/silêncio são capacidade declarada, mas o recall real e a severidade de crop tolerada permanecem desconhecidos. |
| 3. Evitar força bruta entre todos os pares por índice global ou equivalente | O cache `DenseEmbeddings.db` guarda embeddings por arquivo, mas não é um índice de recuperação de candidatos. Tanto áudio quanto visual chamam `CollectPartialMatchCandidates`, que faz varredura triangular `i/j`; só reduz por razão de duração, pasta, presença de dados e arquivos já agrupados. Dentro de cada par visual há um pré-filtro Hamming antes do cosseno, mas ele não evita formar o par de vídeos. Com `0.001`, o filtro de razão permanece amplo. Fontes: [`DenseEmbeddingStore.cs` L20-L43](https://github.com/0x90d/videoduplicatefinder/blob/83ce18691aa5813b0747667c8d2c22befbd0c9cf/VDF.Core/AI/DenseEmbeddingStore.cs#L20-L43), [`ScanEngine.cs` L2111-L2154](https://github.com/0x90d/videoduplicatefinder/blob/83ce18691aa5813b0747667c8d2c22befbd0c9cf/VDF.Core/ScanEngine.cs#L2111-L2154), [`ScanEngine_AiPartial.cs` L217-L240](https://github.com/0x90d/videoduplicatefinder/blob/83ce18691aa5813b0747667c8d2c22befbd0c9cf/VDF.Core/ScanEngine_AiPartial.cs#L217-L240). | **Não passa** para escala de catálogo. O nome de log “building fingerprint index” do áudio não corresponde a um índice global de candidatos entre vídeos. |
| 4. Consultar referências delimitadas sem nova varredura fria da biblioteca inteira | A CLI separa `scan` e `compare`; hashes e embeddings são persistidos, portanto um `compare` quente pode evitar nova decodificação clássica. Porém `compare` não aceita `--include`: sem `IncludeList`, força `ScanAgainstEntireDatabase = true`; com `IncludeList` vinda de JSON, filtra ambos os lados para esse escopo. Não há contrato de consulta assimétrica “queries novas versus referências globais cacheadas”. Além disso, `--ai-partial` percorre todos os vídeos elegíveis do banco, carrega/extrai o sidecar faltante e então compara os pares. Fontes: [`CompareCommand.cs` L20-L40](https://github.com/0x90d/videoduplicatefinder/blob/83ce18691aa5813b0747667c8d2c22befbd0c9cf/VDF.CLI/Commands/CompareCommand.cs#L20-L40), [`SharedOptions.cs` L222-L254](https://github.com/0x90d/videoduplicatefinder/blob/83ce18691aa5813b0747667c8d2c22befbd0c9cf/VDF.CLI/Commands/SharedOptions.cs#L222-L254), [`ScanEngine.cs` L523-L553](https://github.com/0x90d/videoduplicatefinder/blob/83ce18691aa5813b0747667c8d2c22befbd0c9cf/VDF.Core/ScanEngine.cs#L523-L553), [`ScanEngine_AiPartial.cs` L42-L66](https://github.com/0x90d/videoduplicatefinder/blob/83ce18691aa5813b0747667c8d2c22befbd0c9cf/VDF.Core/ScanEngine_AiPartial.cs#L42-L66). | **Parcial para cache; não passa** o requisito de consultas query→referências delimitadas. Um banco isolado com manifesto pequeno é possível, mas não equivale a consultar o catálogo global sem comparação integral. |

## Fatos, alegações e incógnitas

Fatos observáveis no commit:

- `0.001` chega ao filtro de razão sem perda de precisão relevante para 10 s em 2 h.
- O modo parcial de áudio exige fingerprint utilizável e exclui faixas silenciosas.
- O modo parcial visual é CPU/ONNX, persiste embeddings e parte de uma amostragem de 5–15 s, com intervalo ampliado quando necessário para respeitar 400 frames por arquivo; 2 h resultam em 18 s.
- A recuperação parcial é uma varredura de pares elegíveis, não uma busca em índice global.
- A CLI pode reutilizar o banco para um compare quente, mas não expõe seleção assimétrica de queries e referências.

Alegações upstream ainda não comprovadas neste ambiente:

- tolerância do DINOv2 a crop, espelhamento e edição pesada;
- funcionamento em vídeos silenciosos no conjunto real;
- custo aproximado, qualidade e tamanho de cache descritos no README.

Incógnitas que exigiriam mídia e por isso ficaram fora deste preflight:

- recall e localização em clips naturais de 10 s, 30 s e 60 s dentro de lives de 2 h;
- limite de crop tolerado e comportamento com movimento baixo, intros e cenas recorrentes;
- tempo, energia, memória, volume de candidatos e falsos reports no hardware e no conjunto rotulado do Kura.

## Recomendação

**B1 não passa o gate pré-mídia para a finalidade completa. Não executar o piloto de mídia com este build como candidato de produção.** O requisito 1 passa, mas os requisitos 2, 3 e 4 não são atendidos pelo desenho exposto no commit fixado.

O VDF ainda pode servir, se houver decisão explícita, como baseline restrito a um banco/manifesto pequeno para conhecer sua qualidade, sem receber crédito por escala ou por consultas incrementais. Essa execução não deve ser iniciada só para confirmar limitações já visíveis no código. Pelo plano revisado, a falha em requisitos obrigatórios é evidência suficiente para decidir entre B2, redução de escopo ou encerramento, sem implementar algoritmo novo neste preflight.
