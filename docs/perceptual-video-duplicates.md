# Detecção de duplicatas de vídeo

## Escopo

Encontra cópias do mesmo material na biblioteca mesmo quando o arquivo foi reencodado, trocou de
resolução ou codec, recebeu crop, barras ou logo, foi aparado no início/fim, ou é um trecho
(clip/highlights) de uma gravação maior, como uma live. Livestreams diferentes gravadas no mesmo
quarto, com a mesma roupa e a mesma música de fundo **não** são cópias e são rejeitadas.

`GET /api/videos/duplicates` continua agrupando arquivos com o mesmo `file_hash` (cópias exatas).
Nada aqui remove arquivos ou registros; a cobertura descreve intervalos comprovados, não uma
autorização de exclusão.

## Arquitetura (`audio-visual-v1`)

A decisão tem duas etapas com papéis diferentes:

1. **Áudio propõe.** Cada vídeo recebe uma impressão digital Chromaprint do primeiro stream de
   áudio: um inteiro de 32 bits a cada ~0,124 s (mono, 11 025 Hz, reamostrado contra os timestamps
   do container para que lacunas virem silêncio e o item *k* continue em *k* × 0,124 s). Crop, logo,
   resolução e codec de vídeo não alteram o áudio; clips e trims preservam o alinhamento temporal.
2. **Vídeo confirma.** Música de fundo compartilhada entre lives diferentes produz um alinhamento
   de áudio perfeito. Por isso, cada alinhamento relevante é conferido nos quadros daquele instante:
   uma cópia mostra os mesmos pixels e o mesmo movimento; outra live mostra outra pose sobre o mesmo
   cenário.

### Recuperação global

O worker Python (`vision_service.copy_detection`) recebe todas as impressões num arquivo binário e
faz um *self-join* por item idêntico: cada par de posições com o mesmo valor vota em
(vídeo A, vídeo B, deslocamento). Valores presentes em mais de 48 posições (silêncio, clipping,
tons) são descartados como *stop words*. Não há índice aproximado nem limite de candidatos: a
biblioteca inteira cabe em memória (~50 milhões de itens, ~200 MB) e o join leva segundos.

Para cada deslocamento com pelo menos 4 votos (um clip de 10 s reencodado tem só ~5 itens idênticos), a taxa de bits divergentes (BER) é medida item a
item. Trechos com BER suavizada abaixo de 0,30 (aleatório ≈ 0,46–0,50) viram segmentos. Um segmento
só vale se a BER no deslocamento alinhado for pelo menos 0,12 menor que em deslocamentos de 1 a 5 s:
silêncio, zumbido e ruído estacionário casam em qualquer deslocamento e são rejeitados aqui.

Cada item resume ~20 quadros de áudio sobrepostos (~2,7 s), então um trecho de itens `[s, e)`
cobre o áudio `[s × hop, e × hop + 2,6 s]`. Sem essa correção um clip de 10 s mediria 7,3 s.

### Confirmação visual

Só vão para a etapa visual os pares cuja evidência de áudio poderia alcançar uma classe exibida
(mesmos cortes da política de relevância abaixo). Intros e vinhetas de estúdio de poucos segundos
ficam de fora sem custo.

Os segmentos de um par são agrupados por deslocamento; cada grupo é verificado em até cinco
instantes, parando quando duas amostras concordam:

- decodifica ~0,6 s de A e ~2,6 s de B ao redor do instante: cópias diferem em sincronia
  áudio/vídeo em até ~0,7 s (reencode, priming do codec, contêiner);
- escolhe o quadro de B registrando cada candidato (grade de 0,125 s, depois quadro a quadro nos
  dois melhores) com SIFT + RANSAC de similaridade e ficando com o menor erro de pixels
  normalizado. Mais inliers não basta (com câmera parada o quarto registra em qualquer instante)
  e uma transformação única não basta (com câmera na mão ela muda a cada quadro). Depois da
  primeira amostra verificada, as seguintes começam pela mesma defasagem A/V;
- compara na menor das duas resoluções efetivas: fração de células texturizadas cujos gradientes
  concordam (**aparência**) e correlação das diferenças entre quadros nos pixels em movimento
  (**movimento**). Um crop vertical de vídeo horizontal é decodificado na altura do vertical.

Uma amostra é `same` com aparência ≥ 0,65 e movimento ≥ 0,5, e `different` com aparência < 0,60
ou movimento < 0,3 — mas só com registro forte (≥ 25 inliers): uma transformação fraca pode
estar errada e explicaria qualquer divergência. Quadros ricos em textura sem nenhuma
correspondência geométrica na janela (`no_correspondence`) indicam outro vídeo com a mesma trilha.
O grupo é decidido pela mediana das amostras: `verified`, `rejected` ou, para cena estática,
registro impossível ou evidência dividida, `ambiguous`.

Playlists em loop fazem a mesma música reaparecer em outros deslocamentos do mesmo par. Depois que
um grupo é verificado, grupos que remapeiam o mesmo trecho de qualquer um dos vídeos são marcados
`superseded` sem gastar amostras: não somam cobertura e não aparecem como alinhamento conflitante.

### Persistência

- `video_audio_fingerprints`: uma linha por vídeo com os itens (`bytea`, little-endian), revisão,
  identidade do arquivo (tamanho + `mtime_ns`) e `matched_at`. `no_audio` registra vídeos sem
  áudio utilizável.
- `video_copy_pairs`: cada par decidido (`match` ou `rejected`), com segmentos, coberturas e a
  evidência por grupo (deslocamento, BER, amostras, aparência, movimento, inliers, escala).
  Rejeições ficam salvas para que uma passada retomada não as verifique de novo.

Reextrair a impressão de um arquivo alterado apaga os pares daquele vídeo e o devolve à fila de
comparação. As duas tabelas usam `ON DELETE CASCADE` a partir de `videos`.

## Operação

A sincronização da biblioteca (tarefa `perceptual`) processa cada vídeo extraindo apenas a
impressão — trabalho limitado pelo disco — e, ao fim do laço, executa **uma** comparação global de
todas as impressões ainda não comparadas (`matched_at IS NULL`) contra a biblioteca inteira. Os
pares decididos são gravados à medida que chegam; cancelar ou reiniciar perde no máximo o par em
andamento, e uma execução retomada entre as duas etapas roda só a comparação.

Custos medidos nesta máquina (Ryzen 5 5600G, biblioteca em HDD ST4000DM004):

- Extração: limitada pela leitura sequencial do HDD (~130 MB/s, ~200–250× tempo real); a CPU
  do Chromaprint é desprezível. Uma primeira passada nos ~2,9 TB leva ~6 h; depois, só vídeos novos.
- Comparação: join de segundos; ~1 s por amostra visual, só nos pares candidatos.

A extração roda com prioridade mínima de CPU/IO, sem ocupar vaga GPU do agendador de mídia. Um
watchdog encerra um decoder travado após 5 min sem áudio.

Configuração (`.env.example`):

```dotenv
COPY_DETECTION_ENABLED=true
COPY_DETECTION_PYTHON_PATH=./vision-service/.venv/bin/python
COPY_DETECTION_WORK_DIR=./vision-service
COPY_DETECTION_CACHE_DIR=./data/copy-detection
COPY_DETECTION_TIMEOUT_MS=43200000
FPCALC_PATH=fpcalc
```

Requer `fpcalc` (Chromaprint, pacote `chromaprint`) além de FFmpeg. O worker Python usa NumPy e
OpenCV já presentes no ambiente do `vision-service`; não usa GPU nem modelo de rede neural.
`COPY_DETECTION_ENABLED=false` responde `COPY_ENGINE_NOT_READY` sem afetar rostos e timeline.

## Limites conhecidos

- **Sem áudio ou áudio substituído**: não há recuperação. A biblioteca atual tem 4 vídeos sem
  áudio; clips com trilha trocada não são encontrados.
- **Velocidade alterada** não tem suporte: a 1,05× só trechos curtos alinham (cobertura parcial
  de ~30–50%). **EQ agressivo** (passa-faixa 200 Hz–6 kHz) reduz muito os itens idênticos; nas
  variantes avaliadas ainda foi recuperado, mas sem garantia. Loudnorm, compressão, passa-baixa,
  mixagem de música a −10 dB, áudio mono de 24 kbps e troca de codec funcionam.
- Cenas estáticas sem movimento ficam `ambiguous` (aparecem só como similaridade).
- Espelhamento e rotação não são registrados pelo SIFT de similaridade; com quadros ricos em
  textura, a falta de correspondência é tratada como outro vídeo e o par é rejeitado.
- Trechos compartilhados curtos (intro de estúdio, < 60 s e < 25% do menor) não são exibidos.

As medições da validação estão no [relatório de avaliação](spikes/audio-visual-duplicates-2026-09-26.md).
