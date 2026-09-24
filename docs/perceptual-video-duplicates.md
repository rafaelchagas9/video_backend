# Duplicatas perceptuais de vídeo

## Escopo atual

Este recurso compara de 2 a 12 vídeos escolhidos pelo usuário e procura cópias integrais ou
trechos reaproveitados em velocidade fixa, inclusive com mudança de resolução, compressão e
recorte. Edições que alteram a velocidade de reprodução não têm suporte. A execução é assíncrona
porque a indexação pode percorrer horas de mídia.

`GET /api/videos/duplicates` continua inalterado. Ele agrupa arquivos com o mesmo `file_hash` e
permanece sendo a opção barata para cópias exatas. A comparação perceptual usa endpoints e
resultados próprios e não altera o significado de `file_hash`.

A API de lotes selecionados e a [sincronização da biblioteca](library-synchronization.md) usam o
mesmo índice global. A sincronização acrescenta processamento incremental do catálogo, backlog
manual, automação somente para vídeos novos e acompanhamento no Kura web/mobile. A tela original
de duplicatas exatas mantém seu significado.

Nenhum resultado remove arquivos ou registros. `coverage_a` e `coverage_b` descrevem cobertura
temporal observada, não autorização de exclusão. O sistema também não calcula “espaço
recuperável”: relações por trecho, ambiguidades e ausência de transitividade tornam essa conta
enganosa sem revisão humana.

## Arquitetura

1. O backend autentica o usuário, valida o lote e cria um `durable_job` do tipo
   `vision.perceptual-duplicates`.
2. O worker mantém lease e heartbeat e executa na classe `background` do agendador de mídia.
3. O backend resolve IDs disponíveis, registra a identidade dos arquivos e inicia um processo
   Python isolado. Caminhos locais nunca aparecem na resposta HTTP.
4. O FFmpeg decodifica pela RX 7800 XT com VAAPI. Falha de hardware é explícita; não há fallback
   silencioso que transfira toda a decodificação para o Ryzen 5 5600G.
5. A indexação usa timestamps reais a 1 fps e 11 descritores SSCD de 512 dimensões por frame:
   o quadro 288 × 288 inteiro, cinco faixas verticais e cinco faixas horizontais sobrepostas.
6. O SSCD roda em lotes fixos de oito imagens, FP32, exclusivamente no
   `MIGraphXExecutionProvider`. O cache grava os descritores em FP16; leitura, normalização,
   recuperação e inferência usam FP32. O processo recusa inferência FP16 e fallback para CPU.
7. A geração `sscd-temporal-v4` publica os descritores no índice global `retrieval-v4`. A busca
   consulta somente membros elegíveis da geração atual e usa âncoras esparsas para formar hipóteses
   temporais em velocidade fixa; descritores não confirmam cópias por si sós.
8. As hipóteses coerentes são refinadas em janelas temporais. A consulta é decodificada a 1 fps e
   a referência a 5 fps. Um orçamento adaptativo escolhe quantas janelas verificar, com teto de 128
   por par. A API sinaliza quando a recuperação ou a verificação atingiu limites.
9. A etapa fina extrai 512 × 512 com proporção preservada e barras pretas. As três primeiras
   amostras procuram âncoras SIFT; âncoras periódicas renovam a geometria. Entre elas, uma
   transformação aceita só é reutilizada quando os testes completos de pixels, gradientes,
   suporte espacial e continuidade temporal também passam.
10. A decisão exige ao menos nove amostras, oito alinhadas e cerca de oito segundos observados.
    Movimento correlacionado e transformação estável produzem `verified`; pouca informação produz
    `ambiguous`.

Preservar a proporção é obrigatório em recortes verticais severos. Esticar separadamente um frame
16:9 e seu recorte 9:16 para quadrados destrói correspondências SIFT antes do RANSAC. Letterbox
restaura uma transformação aproximadamente isotrópica e permite verificar recortes com cerca de
30% da largura original. A cobertura e a distribuição dos pontos são medidas dentro da região
visível compartilhada; barras pretas e partes que o crop removeu não entram nesse denominador.
Os pisos de inliers e as checagens fotométricas continuam obrigatórios.

## AMD no Linux

O histórico da AMD lista ROCm 10.0.0 em 26 de agosto de 2026 e ROCm 7.14.1 em 2 de setembro de
2026. Consulte a [tabela de versões](https://rocm.docs.amd.com/en/latest/release/versions.html) e a
[matriz de compatibilidade](https://rocm.docs.amd.com/en/latest/compatibility/compatibility-matrix.html)
antes de trocar componentes.

Arch Linux não consta como sistema oficialmente suportado para Radeon nessa matriz. Uma versão
mais nova não justifica substituir uma combinação validada. Este recurso usa a pilha comprovada
nesta máquina: VAAPI para decode e ONNX Runtime MIGraphX 1.25 para inferência. Não atualize ROCm,
kernel, Mesa ou driver do host como parte deste setup.

Em uma medição histórica, a primeira compilação MIGraphX levou cerca de 84 segundos; depois,
somente a rede SSCD levou cerca de 11 ms por lote de oito. Isso não inclui decode, geração das 11
vistas, cache, recuperação, SIFT ou verificação temporal e não representa o desempenho final da
geração atual. Pilotos e benchmarks ficam em relatórios separados.

## Preparação do ambiente

Pré-requisitos: Python 3.12 para o `uv`, FFmpeg com VAAPI, acesso a `/dev/dri/renderD128` e
MIGraphX funcional. O ambiente é local ao `vision-service`; estes passos não alteram pacotes Python
do sistema. Sincronize o runtime pelo lockfile. `onnx` atende à busca GPU e o runtime preserva
`onnxruntime-migraphx` 1.25.

```bash
cd /home/rafael/Documentos/projetos/conversor-video/vision-service
uv sync --frozen --python 3.12
.venv/bin/python -c "import onnxruntime as ort; print(ort.__version__, ort.get_available_providers())"
```

A saída deve conter `1.25.0` e `MIGraphXExecutionProvider`. Ao iniciar um trabalho, o engine ainda
faz warmup perfilado e confirma execução exclusiva nesse provider.

Converta uma vez o modelo oficial SSCD. A exportação usa outro ambiente, somente CPU; PyTorch não
participa do runtime de produção.

```bash
cd /home/rafael/Documentos/projetos/conversor-video/vision-service
mkdir -p models/copies
curl --fail --location \
  https://dl.fbaipublicfiles.com/sscd-copy-detection/sscd_disc_mixup.torchscript.pt \
  --output models/copies/sscd_disc_mixup.torchscript.pt
printf '%s  %s\n' \
  9f26bd4c848cc19b73d2ae92eea6e04886f61a7b764ceb7a13aeee62e6a6db56 \
  models/copies/sscd_disc_mixup.torchscript.pt | sha256sum --check
uv venv --python 3.12 ../data/copy-model-export
uv pip install --python ../data/copy-model-export/bin/python \
  --index-url https://download.pytorch.org/whl/cpu torch==2.9.1
uv pip install --python ../data/copy-model-export/bin/python numpy==1.26.4 onnx==1.20.1
../data/copy-model-export/bin/python scripts/export_copy_model.py \
  models/copies/sscd_disc_mixup.torchscript.pt \
  models/copies/sscd_disc_mixup.onnx
```

O exportador valida o SHA-256 da origem, verifica o ONNX e cria o manifesto
`models/copies/sscd_disc_mixup.json` com procedência e SHA-256 do ONNX. O runtime recusa arquivos
que não correspondam ao manifesto.

Configuração padrão de `.env.example`:

```dotenv
PERCEPTUAL_DUPLICATES_ENABLED=true
PERCEPTUAL_DUPLICATES_PYTHON_PATH=./vision-service/.venv/bin/python
PERCEPTUAL_DUPLICATES_MODULE=vision_service.video_copies
PERCEPTUAL_DUPLICATES_WORK_DIR=./vision-service
PERCEPTUAL_DUPLICATES_CACHE_DIR=./data/perceptual-duplicates-cache
PERCEPTUAL_DUPLICATES_TIMEOUT_MS=3600000
PERCEPTUAL_DUPLICATES_MAX_OUTPUT_BYTES=4194304
PERCEPTUAL_DUPLICATES_MAX_ACTIVE_JOBS=1
VAAPI_DEVICE=/dev/dri/renderD128
```

`true` disponibiliza lotes manuais e a etapa perceptual da sincronização. Definir a flag como
`false` retorna `503` com código `COPY_ENGINE_NOT_READY` para novos inícios e faz jobs perceptuais
já enfileirados falharem antes do decode. Rostos e storyboard/VTT continuam disponíveis, inclusive
nas demais etapas de jobs mistos. A varredura do backlog sempre exige ação explícita do usuário;
a automação para vídeos novos é separada e começa desabilitada.

Mantenha um trabalho ativo por usuário. O schema permite até quatro, mas aumentar esse valor gera
contenção de GPU, disco e CPU; o agendador compartilhado ainda limita trabalhos de fundo.

## API

Todos os endpoints exigem autenticação. Inicie um lote com IDs distintos:

```http
POST /api/perceptual-duplicates/jobs
Content-Type: application/json

{"video_ids":[12,44,105]}
```

São aceitos 2 a 12 vídeos disponíveis. Cada um deve durar entre 5 segundos e 24 horas; a soma não
pode exceder 72 horas. A resposta é `202 Accepted`, inclui `Location` e retorna `reused: true`
quando já existe um trabalho ativo equivalente do mesmo usuário.

```http
GET /api/perceptual-duplicates/jobs/123
```

Estados: `queued`, `running`, `retry_wait`, `completed`, `failed` e `cancelled`. Fases públicas:
`queued`, `preparing`, `comparing`, `completed`, `failed` e `cancelled`.
`progress.completed_units` ainda não é progresso por minuto; passa de zero ao total no final.

```http
DELETE /api/perceptual-duplicates/jobs/123
```

O cancelamento registra a solicitação, interrompe a árvore do processo Python e é idempotente em
jobs terminais. Cada usuário acessa somente seus jobs. O worker usa lease de 60 segundos,
heartbeat de 20 segundos e até duas retentativas para falhas recuperáveis.

O resultado possui `videos`, `matches` e `runtime`. Cada match informa os IDs, `coverage_a`,
`coverage_b`, `status` e `segments`. Cada segmento informa intervalos nos dois vídeos, velocidade,
quadros confirmados, inliers, movimento e resíduo do ajuste temporal. Esse resíduo mede
a consistência entre amostras; não é uma garantia de precisão absoluta das bordas do trecho.
`runtime.retrieval_truncated` indica recuperação global truncada;
`runtime.verification_limited_pairs` indica pares que atingiram o orçamento de verificação.
Esses sinais limitam qualquer conclusão negativa, inclusive quando `matches` está vazio.

O payload interno do job inclui a geração atual, que também participa da deduplicação de pedidos.
O backend só publica um resultado cuja `revision` seja `sscd-temporal-v4`. Jobs ativos de
outra geração falham antes de executar o engine; resultados concluídos antigos são apresentados
como obsoletos, sem expor o resultado como evidência atual. Jobs já cancelados continuam
cancelados. Alterações posteriores nas mídias também exigem um novo lote.

`verified` é evidência forte para revisão, não ordem de remoção. `ambiguous` significa que existe
correspondência visual/temporal, mas o movimento não distingue com segurança cópia, cena estática,
fundo reaproveitado ou alinhamentos concorrentes.

## Cache, privacidade e integridade

O cache usa diretório `0700` e processo com `umask 0077`. Guarda descritores FP16, timestamps reais
e miniaturas 16 × 16 em chunks de um minuto; não guarda frames 288/512 completos. Ao carregar um
chunk, o engine converte e normaliza os descritores em FP32 antes da busca.

A chave inclui identidade (`device`, inode, tamanho, `mtime_ns`, `ctime_ns`), SHA-256 do modelo,
revisão, início e duração. Cada `.npz` é validado, escrito em arquivo temporário e publicado por
troca atômica. Cache inválido é removido e gera falha explícita para repetição segura.
O limite padrão do cache é 128 GiB (`COPY_CACHE_MAX_BYTES`), com reserva mínima de 1 GiB livre no
volume. Ao atingir o limite, o job falha com `COPY_CACHE_FULL`. `runtime.cache_bytes` informa o
tamanho observado. Arquivos temporários de escritas interrompidas são removidos sob o lock do
worker, sem tocar nas mídias.

O índice global fica em `retrieval-v4`. Manifestos e shards são validados e publicados
por troca atômica. Sua associação com a revisão, o modelo, a identidade da fonte e os tokens de
membro impede que arquivos ausentes ou de outra geração participem da busca atual.

Um lock de arquivo serializa estes workers entre processos no mesmo host, desde que compartilhem
`PERCEPTUAL_DUPLICATES_CACHE_DIR`. O timeout de uma hora inclui espera por esse lock. O lock é
liberado pelo kernel se o processo terminar ou for encerrado à força.

O Python verifica a identidade antes, durante e depois da indexação. O backend compara caminho e
`stat` antes de publicar. Isso detecta substituições e alterações normais, mas não equivale a hash
integral do conteúdo.

O processo recebe paths apenas por `stdin`, limita entrada, saída e tempo e não inclui paths em
erros públicos. As mídias são abertas somente para leitura. Escritas ficam no cache privado e nos
registros de durable jobs.

## Limites conhecidos

- A API de lotes limita a busca aos vídeos selecionados. A sincronização consulta os membros
  elegíveis do índice global e publica resultados incrementais para o catálogo.
- A recuperação global é aproximada e os tetos de recuperação e de 128 janelas de verificação por
  par podem omitir trechos em montagens extensas.
- A verificação termina quando reúne evidência suficiente para uma classe útil. Uma cópia integral
  longa pode, portanto, aparecer como `partial_overlap` somente sobre a porção confirmada; o engine
  não infere cobertura integral a partir de amostras esparsas.
- O escopo atual aceita somente velocidade fixa. Alterações de velocidade de reprodução podem
  falhar ou aparecer apenas como diagnóstico sem suporte.
- Conteúdo parado, slides e fundos comuns tendem a `ambiguous`; sem movimento não há prova forte.
- Recortes precisam conservar detalhes locais. Overlay extenso, espelhamento, rotação forte e
  edição quadro a quadro podem falhar.
- A confirmação exige ao menos nove amostras e, na prática, cerca de oito segundos; clips
  prometidos pela interface continuam limitados a pelo menos dez segundos. Áudio não participa da decisão.
- Antes de oferecer exclusão ou espaço recuperável na interface, é preciso validar positivos e
  negativos naturais, definir revisão humana e representar relações por intervalo sem agrupamento
  transitivo de sobreposições parciais.

## Histórico: geração v3 não promovida

Arquitetura, métricas e limites medidos da geração experimental `sscd-hnswsq8-dense-v3` ficam no
[relatório v3](spikes/video-duplicate-redesign-v3-2026-09-21.md). A primeira consulta sentinela
concluiu em 177,248775 s, sem match, com recuperação truncada e um par limitado pela verificação;
uma consulta sentinela subsequente foi interrompida durante a verificação. As 24 variantes
reservadas foram indexadas, mas não consultadas.
O resultado final da v3 foi **sem promoção para produção**; ele não descreve a operação da v4. O
[relatório da implementação anterior](spikes/perceptual-video-implementation-2026-09-21.md) fica
preservado como histórico; seus resultados e tempos não validam o índice global atual.

## Evidências da geração atual

O [relatório v4](spikes/video-duplicate-redesign-v4-2026-09-21.md) registra os testes reais,
negativos históricos, custos medidos e limites da geração em operação.

A confirmação normaliza cada par pela linha temporal do vídeo menor, mantendo os IDs,
intervalos e coberturas na orientação original da API. Isso cobre também a inclusão de uma
gravação completa depois dos seus clips já catalogados.
