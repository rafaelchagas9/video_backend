# Duplicatas por áudio + confirmação visual (`audio-visual-v1`): avaliação

Data: 26/09/2026. Substitui a geração `sscd-temporal-v4` (SSCD + HNSW + SIFT), removida do código.

## Por que trocar

Na execução real de 26/09 (job 244) a geração anterior levou ~3 h 50 min para 200 vídeos da
biblioteca (163 concluídos, 37 com `COPY_DECODE_FAILED` em arquivos que o FFmpeg decodifica
normalmente) e a maioria das consultas terminou com recuperação truncada. O par
`_babby_doll_2025-08-01_21-36-33.mp4` ↔ `babby-doll-2025-08-01-21-36-33-highlights.mkv`
(mesma live, 16 s aparados no fim) aparecia com 5%/6% de cobertura: a verificação parava ao
juntar evidência mínima. O relatório v4 projetava ~47 h só de indexação para ~1.669 h de mídia.

Na geração nova esse par tem 100% de cobertura nos dois arquivos, BER de áudio 1,6% alinhado
(46% desalinhado), aparência 1,0 e movimento 1,0.

## Custo medido

- Biblioteca: 3.470 vídeos disponíveis, ~2,9 TB (3.442 no HDD ST4000DM004, 28 no NVMe).
- Impressão de áudio: ~1,9 s de CPU para 20 min de áudio; a extração é limitada pelo disco:
  **130–154 MB/s** no HDD (~200–250× tempo real), ou seja, uma passada inicial de ~6 h.
  Dois processos simultâneos no HDD não aumentam a vazão.
- Join global: ~1,3 s para 783 impressões (9,1 M itens); alinhamento de 1.254 candidatos em
  ~11 s.
- Confirmação visual: 1,0–3,3 s por grupo (2–3 amostras), só para pares relevantes.

## Protocolo

Variantes geradas de 9 vídeos da biblioteca com formatos diferentes (lives AV1/Opus no NVMe,
incluindo uma de 2,6 h; HEVC 1080p, H.264 vertical e H.264 1080p no HDD), sem alterar os
originais: reencode 480p AAC 96k; crop 70% + duas caixas de logo, Opus 64k; crop vertical 9:16;
clips de 30 s e 10 s; trim de 17 s no início e ~23 s no fim; 360p com áudio mono 24 kbps;
música de outro vídeo mixada a −10 dB; passa-faixa 200 Hz–6 kHz + loudnorm; velocidade 1,05×;
trilha substituída pela de outro vídeo; e uma compilação de dois trechos de fontes diferentes.
As consultas não receberam o ID correto; o motor de produção comparou tudo com as impressões
da biblioteca disponíveis no momento.

Negativos difíceis:

- **Mesmo quarto, mesma música, outra live**: `ophelia_blue` 08/09 × 09/09 compartilham 445 s
  de música de fundo alinhada com BER 0,08. Visual: aparência ~0,48, movimento ~0 → rejeitado.
- **Mesma trilha, outro vídeo** (9 variantes "trilha substituída"): sem correspondência
  geométrica em quadros ricos em textura → rejeitados.

## Problemas encontrados e corrigidos durante a avaliação

Cada item abaixo causava falsos negativos ou positivos reais nas variantes:

1. Cada item Chromaprint resume ~2,7 s de áudio; sem somar essa cauda um clip de 10 s media
   7,3 s e ficava abaixo do piso de 8 s.
2. Playlists em loop realinham o mesmo trecho em outros deslocamentos; após um grupo
   verificado, grupos que remapeiam o mesmo trecho viram `superseded`.
3. Cópias diferem em sincronia áudio/vídeo em **0,3–0,7 s** (reencode, priming, contêiner):
   o quadro correspondente é procurado ±1 s em torno do instante do áudio.
4. Escolher o quadro de B por pixels sob uma transformação ajustada no instante do áudio falha
   com câmera na mão; escolher por mais inliers falha com câmera parada (o quarto registra em
   qualquer instante). Cada candidato é registrado com a própria transformação e escolhido pelo
   menor erro de pixels normalizado (grade de 0,125 s e refino quadro a quadro nos dois melhores).
5. A defasagem A/V é constante por par de arquivos: amostras seguintes começam pela defasagem já
   verificada.
6. Registro fraco (< 25 inliers) pode ser a transformação errada e nunca vota "diferente";
   grupos são decididos pela mediana, não por votos.
7. Um desempate por aparência alta permitia aceitar outra live com performer pequeno no quadro;
   a concordância de movimento é sempre exigida.
8. Gravações do goondvr podem ter PTS de áudio afastados 20+ min do vídeo; as impressões seguem
   os PTS do contêiner (`aresample=async`), o mesmo eixo usado no seek dos quadros.
9. FFmpeg registra uma linha por quadro AAC corrompido; stderr não drenado trava o decoder
   (a extração de produção drena continuamente e tem watchdog de 5 min).
10. Um clip de 10 s reencodado tem só ~5 itens idênticos à fonte; o piso de votos caiu de 10
    para 4 — o alinhamento por BER/contraste é o filtro barato e estrito.

## Resultado

_Preenchido após a execução completa (variantes + biblioteca)._

## Limites

Ver [detecção de duplicatas](../perceptual-video-duplicates.md#limites-conhecidos).
