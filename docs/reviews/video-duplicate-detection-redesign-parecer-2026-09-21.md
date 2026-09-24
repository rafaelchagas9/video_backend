# Parecer sobre o plano de revisão da detecção de duplicatas de vídeo

Documento revisado: [docs/plans/video-duplicate-detection-redesign-2026-09-21.md](../plans/video-duplicate-detection-redesign-2026-09-21.md).
Data do parecer: 21/09/2026. Veredito: **aprovar com alterações**.

Este é um parecer técnico interno, produzido com acesso ao código e aos artefatos locais do
incidente. **Não substitui a revisão externa independente** que a seção 1 do plano solicita: quem o
escreveu teve acesso à proposta antes de registrar uma avaliação cega do problema, exatamente a
ancoragem que o plano tentava evitar. A decisão de prosseguir, reduzir escopo ou encerrar continua
com o responsável pelo repositório.

## 1. Veredito e razão

A recomendação central do plano — **não retomar o backlog com o motor atual; aprovar definição,
conjunto rotulado e orçamento antes de gastar** — está correta e é mais bem sustentada do que o
próprio documento admite. As evidências da seção 2 foram reproduzidas e conferem integralmente.

As alterações exigidas não estão no diagnóstico, e sim naquilo que o plano deixa de concluir:

1. O plano subestima a alternativa B0, que já cumpre o gate de regressão com custo zero.
2. O gate de falso positivo da seção 7 não sustenta uma varredura completa, e existem dados
   melhores já disponíveis do que o conjunto proposto.
3. O plano se recusa a projetar custo, e a projeção — derivável — desqualifica a arquitetura atual
   independentemente da qualidade de classificação.
4. O orçamento da seção 8 não financia o próprio teto de entrada da seção 8.

Sem essas correções, um piloto pode passar nos gates sem responder à pergunta que decide o caso.

## 2. Verificação independente das afirmações do plano

| Afirmação do plano | Situação |
| --- | --- |
| 18 pares, 7 `verified` e 11 `ambiguous` | confirmado exatamente |
| Cobertura abaixo de 2% nos dois arquivos em 16 dos 18 pares | confirmado |
| Mediana do maior trecho por par: 5 s | confirmado (5,0 s) |
| 6 casos `verified` restritos à abertura, 0–6 s | confirmado; todos com `a_start` entre 0 e 1 s |
| Onyx 179/180 com aproximadamente 71% | confirmado (0,711 / 0,710) |
| Índice de aproximadamente 2,17 GiB, 2.939 chunks de minuto, 134 entradas | confirmado (2,2 GiB, 2.939 `.npz`, 134 entradas) |
| Lista de 16 pares negativos completa e coerente com os 18 | confirmado |
| Candidatos podem nascer de 5 frames em 4 s; confirmação usa no máximo 12 frames | confirmado em `video_copy_match.py` |
| `verified` não exige cobertura, apenas movimento, energia e similaridade | confirmado em `video_copy_match.py` |
| 3.631 vídeos implicam 6.590.265 pares | aritmética correta |
| Piloto anterior: oito fontes, 28 pares de controle | confirmado no spike |

Medições adicionais extraídas do mesmo cache, não registradas no plano: **8.911 pares efetivamente
comparados** (o triângulo completo entre os 134 vídeos indexados), **46,6 h de mídia indexadas**,
**96 pares com `candidate_limited`** (1,1%) e um journal remanescente (`catalog-work-186.json`, 44
pares concluídos), coerente com o cancelamento relatado.

## 3. Achados que exigem alteração do plano

### 3.1 B0 já cumpre o gate de regressão, com custo zero de processamento

Nos 18 pares observados, o único positivo verdadeiro se separa de todo o resto por margem de 69×
em duração casada: **1.386 s casados em 179/180 contra no máximo 20 s em todos os outros 17**
(64/65 com 20 s; 38/42 com 13 s). O critério `min(cobertura) >= 0,05` produz a mesma separação
limpa: 0,710 contra 0,027 contra no máximo 0,006.

Uma política de relevância aplicada aos resultados já persistidos produz exatamente um report na
lista principal — o Onyx — e envia 38/42 (vídeo de 35 s com 13 s casados, 37% do menor) para
similaridade, exatamente onde o usuário o classificou.

A seção 5 descreve B0 como servindo "para medir quanto do ruído era classificação". A resposta
medida é: **todo ele**. B0 deve ser promovido de régua de medição a candidato de entrega para a
camada de classificação, e a avaliação deve ser reorientada para a única pergunta que B0 não
responde: recall e custo.

### 3.2 Os dados do incidente não contêm nenhum exemplo do caso de uso principal

Dos 18 reports, um é cópia quase integral e um é parcial curto. **Não existe nenhum "clip de 30 s
dentro de uma live de 2 h"** — ou seja, a rodada de três horas não produziu evidência alguma sobre
o requisito que motivou a construção, em nenhuma direção.

A seção 2 enquadra a falha como precisão. O enquadramento honesto é: a precisão falhou **e** o
recall nunca foi medido. Isso tem consequência direta na seção 7 — o grupo de regressão só valida o
lado da rejeição. Todo positivo de clip-em-live será sintético, logo o gate de 95% de recuperação
repousa inteiramente sobre variantes geradas por nós, cuja dificuldade é um parâmetro que
escolhemos. Essa limitação precisa estar escrita no próprio gate.

### 3.3 O conjunto negativo são 5 situações independentes, não 16 pares

Os 16 reports indesejados vêm de cinco famílias:

| Família | Pares no conjunto |
| --- | --- |
| 72, 73, 74, 75, 76 (cinco arquivos com a mesma abertura) | 10 |
| 64, 65, 66 | 2 |
| 187, 192, 194 | 2 |
| 146, 147 | 1 |
| 149, 150 | 1 |

"Zero dos 16 na lista principal" é lido como um gate de 16 casos e é, na prática, um gate de cinco
situações, com 63% dele concentrado em uma única família. Registrar isso na seção 7 e exigir que os
100 negativos difíceis sejam contados **por família**, não por par.

### 3.4 O gate de falso positivo não autoriza varredura completa, e já há dado melhor disponível

Zero falso positivo em 100 negativos difíceis limita a taxa a aproximadamente 3% (IC 95%), o que
sobre 6.590.265 pares admite cerca de 200.000 falsos positivos. A rodada oferece uma medição real
no lugar disso: **16 reports indesejados em 8.911 pares comparados, ou 1,8 × 10⁻³**, projetando
cerca de **12.000 reports indesejados** em todo o catálogo.

Alterações necessárias:

- Reescrever o gate como **falsos positivos por 10⁶ pares, com intervalo de confiança**.
- Usar como conjunto negativo as **8.911 comparações já em cache**: custo zero de decodificação e
  amostra 89× maior que a proposta. Mesmo um resultado perfeito de 0 em 8.911 limita a taxa a
  3,4 × 10⁻⁴, isto é, até cerca de 2.200 reports no catálogo — e é esse número que decide se a
  varredura completa é apresentável.

### 3.5 A projeção de custo que o plano recusa é derivável e desqualifica a arquitetura atual

A seção 2 afirma que o custo da primeira centena não permite projetar taxa constante. Correto — mas
um **limite inferior** é legítimo e decisivo:

| Grandeza | Medição | Projeção para 3.631 vídeos |
| --- | --- | --- |
| Tempo | 8.911 pares e 46,6 h de mídia em aproximadamente 3 h, isto é 1,21 s por par | **aproximadamente 92 dias** de processamento contínuo |
| Leitura de índice | `video_copy_catalog.py` recarrega e descomprime o índice da referência a cada par; 16,8 MiB por vídeo em média | **aproximadamente 100 TiB** lidos na varredura completa |
| Índice em disco | 45 MiB por hora de mídia; 2,2 GiB para 46,6 h | **aproximadamente 40 GiB** para cerca de 900 h de mídia |

Os 92 dias são otimistas: o custo por par é O(N_consulta × N_referência) em frames e o conjunto de
referência médio durante a rodada era de 67 vídeos, não 3.630.

Consequência: a diretriz da seção 6 — "não continuar a comparação exaustiva de cada vídeo contra
todos os anteriores" — não é preferência de desenho, é **condição de aprovação de B2**. Um B2 que
preserve o laço pareado do catálogo não deve ser construído. E B1 precisa ser avaliado por ter ou
não índice global, não apenas pela qualidade dos matches. O teto de 5 GiB de saídas da seção 8
continua adequado para o piloto, mas os 40 GiB de produção pertencem à seção 9.

### 3.6 O orçamento da seção 8 não financia o teto de entrada da seção 8

Até 24 fontes e 20 h de mídia dentro de 30 minutos de processamento de parede implicam cerca de
40 h de mídia por hora. A vazão observada na rodada foi de aproximadamente 15 h de mídia por hora de
parede — 46,6 h indexadas a frio somadas a 8.911 comparações em cerca de 3 h — e o piloto também
pagará comparações. Além disso, a geração de variantes (crops, reencodes, clips de 10/30/60 s, uma
live de 2 h) é tempo de FFmpeg cobrado no mesmo teto de 30 minutos.

Escolher uma das duas saídas e escrevê-la:

- limitar a mídia **recém-decodificada** a aproximadamente 4 h e declarar explicitamente que o
  piloto roda sobre o cache quente de 2,2 GiB; ou
- elevar o teto de processamento.

Como está, o piloto falha o próprio orçamento na largada, e isso será lido como alternativa
reprovada.

### 3.7 Lacuna de recall em crop que nenhuma seção nomeia

As cinco vistas regionais são faixas **horizontais** de altura total — `frame[:, x : x + 96]` sobre
um frame já achatado para 288×288 sem preservação de proporção (`video_copy_index.py` e
`video_copy_frames.py`). Portanto **crop vertical, mudança de letterbox/pillarbox, mudança de
proporção, rotação e espelhamento não têm caminho de recuperação algum**, e o descritor de frame
inteiro se desloca sob mudança de proporção porque o fator de achatamento muda.

Isso é estrutural para o plano: as seções 6 e 8 se apoiam em reutilizar o cache existente, e essa
reutilização congela a cobertura de crop em apenas horizontal. Acrescentar crop vertical, mudança
de proporção e espelhamento à lista obrigatória da seção 7, e declarar quais deles o plano **opta
por não suportar**.

### 3.8 A duração mínima de clip já está decidida pelo código, e a decisão antecede o piloto

As duas etapas exigem pelo menos 5 frames distintos a 1 fps cobrindo pelo menos 4 s. Nada abaixo de
aproximadamente 5 s é detectável, e 10 s é o menor valor que vale prometer. Porém suportar algo
mais curto exige reindexar acima de 1 fps, o que **invalida todos os 2.939 chunks**. A seção 10
pede que o revisor fixe o piso: o piso é 10 s, e ele precisa ser fixado **antes** do piloto, porque
determina se o cache é ativo reutilizável ou restrição herdada.

### 3.9 Dois sinais de incompletude já existem e faltam no contrato de produto

`candidate_limited_pairs` disparou em 96 dos 8.911 pares (1,1%), efeito do truncamento em oito
hipóteses; e `video_copy_catalog.py` limita a publicação a 50 matches por vídeo, com bandeira
`truncated_matches`. A classe "Inconclusivo" da seção 4 deve ser ligada explicitamente aos dois, e
os requisitos de interface da seção 9, item 4, devem citar o teto de 50 por vídeo.

### 3.10 Correção menor: um item do orçamento da seção 8 já está implementado

O supervisor com encerramento verificável de subprocesso já existe em
`src/modules/perceptual-duplicates/perceptual-duplicates.runner.ts`: SIGTERM no grupo de processos
com escalada para SIGKILL após 2 s, sob timeout por job. A meta de parar em até 10 s está atendida
por construção. Retirar o item do orçamento de preparação e substituí-lo por uma verificação.

## 4. Respostas às perguntas da seção 10

**Definição independente do problema.** É recuperação de trechos compartilhados mais uma decisão de
relevância. O incidente foi falha de relevância assentada sobre uma arquitetura de custo
quadrático. A ordem correta de ataque era relevância primeiro, porque é gratuita, e recuperação
como a pergunta financiada — o inverso de como as três horas foram gastas.

**Evidência contra hipótese.** Tudo na seção 2 é evidência e confere. Os limiares da seção 4, a
arquitetura da seção 6 e os valores de gate da seção 7 são hipóteses. A afirmação com maior risco de
conclusão prematura é a implícita "o motor encontra, só classifica errado": o recall não foi medido.

**Taxonomia de classes.** Adequada, e sustentada pelos dados observados. Piso de clip: 10 s. Uma
intro que seja o arquivo inteiro deve ser classificada como containment do menor com bandeira
explícita de conteúdo recorrente, e mantida fora da lista principal.

**Os casos difíceis estão representados?** Negativos: sim em natureza, não em diversidade — cinco
famílias. Positivos: não; não há nenhum caso natural de clip-em-live nos dados do incidente.

**Gates.** Recall e localização são razoáveis. O gate de falso positivo precisa ser substituído
conforme 3.4.

**VDF como baseline.** Merece um ensaio limitado, porém o filtro padrão de 10% de duração exclui o
caso principal por construção (30 s em 2 h são 0,42%). O ensaio precisa confirmar que esse filtro é
configurável para cerca de 0,1% **antes** de qualquer processamento de mídia; caso contrário B1 não
pode ser avaliado contra o requisito real e os 15 minutos de preparação de ferramenta rendem mais
em outro lugar. O que justifica B2: ausência de índice global, ou vazão abaixo de aproximadamente
10 s de mídia por segundo.

**Busca regional e recall.** Não como especificado — ver 3.7.

**Tetos de orçamento.** As 2 h de trabalho são aceitáveis. Os 30 minutos de processamento não são
compatíveis com 20 h de entrada (3.6). Sem medidor na tomada, declarar energia desconhecida e
governar por tempo; não apresentar o teto de kWh como cumprido a partir de telemetria de GPU.

**O que justifica o backlog completo.** Uma taxa de falso positivo por 10⁶ pares com intervalo de
confiança, mais uma projeção de custo total abaixo de aproximadamente 24 h de parede. Com os
números atuais — 92 dias e cerca de 100 TiB de leitura — o backlog completo não é financiável em
nenhuma forma, qualquer que seja a qualidade da classificação.

## 5. Limites deste parecer

- Parecer interno, com acesso prévio à proposta; não é a revisão cega pedida na seção 1.
- Nenhuma mídia foi inspecionada visualmente. A qualidade visual dos 18 reports não foi certificada;
  os rótulos de utilidade continuam sendo os do usuário.
- As cinco falhas de processamento da rodada 203 não foram diagnosticadas aqui: o banco de produção
  não estava acessível neste ambiente, apenas o cache e os backups.
- Nada foi executado sobre mídia, nenhum serviço foi alterado e nenhum arquivo do cache foi
  modificado. As medições vieram de leitura dos JSON publicados, dos `.npz` e do código.
- As projeções de 92 dias, 100 TiB e 40 GiB são limites inferiores obtidos por extrapolação da
  duração mediana de 894 s da amostra de 134 vídeos. A distribuição real do catálogo continua não
  caracterizada, como o próprio plano registra.

## 6. Como reproduzir as medições deste parecer

Todas as medições vêm de `data/perceptual-duplicates-cache/` e do código em
`vision-service/src/vision_service/`. Os pares, status, coberturas e durações casadas saem de
`catalog-result-*.json` agregados por par normalizado, com as durações lidas de `catalog.json`;
`compared_videos` e `candidate_limited_pairs` são somados dos mesmos arquivos; o volume do índice
sai de `du` e da contagem de `indexes/**/*.npz`. Não copiar títulos, caminhos pessoais nem mídia
para um parecer público.
