# Validação da entrega e revisão independente

Esta entrega não pode ser considerada validada somente porque compilou ou porque a suíte de regressão passou. A primeira rodada se concentrou em demo e fixtures; a maioria dos 614 testes backend já existia. A revisão posterior cruzou cada frente com um agente que não a implementou e encontrou falhas reais.

## Armazenamento

Erro reproduzido em PostgreSQL real, somente leitura: `42703 column directory_id does not exist`. O CTE não selecionava a coluna usada pelo filtro. Corrigido; listagem e agregação agora compartilham o CTE. Foco produção agrega numa consulta em vez de listar/paginar toda a biblioteca repetidamente.

Consultas SELECT reais verificadas após a correção:

| Caso                                 | Evidência                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------- |
| Foco global                          | 732 grupos, consulta inicial 1378 ms neste host                            |
| Filtro criador                       | total da listagem coincide com total do grupo; membros conferidos          |
| Filtro estúdio                       | total da listagem coincide com total do grupo                              |
| Filtro pasta                         | total da listagem coincide com total do grupo; 2402 candidatos nessa pasta |
| Criador inexistente                  | lista vazia e total zero                                                   |
| Mantidos / depois / exclusão marcada | disposição de cada registro confere; nenhuma exclusão executada            |

Nova regressão em SQLite temporário: grupo de 1005 vídeos além do seed, última página, filtros antes da paginação, soma dos bytes e grupo totalmente revisado. A demo deixou de cortar a listagem em 1000 registros. Grupos concluídos permanecem selecionáveis para revisitar decisões. Web/mobile ganharam busca e estados de carregamento; mobile limita renderização inicial, mostra progresso e permite carregar mais grupos. Resumo web acompanha o foco escolhido e identifica progresso diário como global. Erro de consulta no mobile não é apresentado como fila vazia.

## Limites das provas

- Nenhuma alteração de mídia ou metadados da biblioteca real foi necessária para esta validação; consultas reais foram somente leitura.
- SQLite demo não comprova sintaxe ou comportamento PostgreSQL. Casos que envolvem transações reais precisam de banco temporário independente ou consultas somente leitura.
- Fixtures HTTP confirmam composição e tratamento de respostas, não credenciais/contas válidas nem o comportamento real de todos os provedores.
- Não houve envio real de contribuições externas.
- FansDB autenticado aguarda convite e chave.
- Ainda não há prova física de Quest 3, interface HereSphere/DeoVR no headset, decodificação simultânea e ergonomia dos controles. Streams HTTP 206 não comprovam reprodução/decodificação no aparelho.
- Mobile foi verificado por tipos e contratos; testes físicos de toque, teclado, rolagem e conectividade ainda são necessários.
- Reutilizar componentes e registrar telas para um designer não equivale a validar usabilidade. As correções de UX desta revisão tratam atritos específicos identificados por análise e alguns fluxos web; não cobrem toda a experiência.

As regressões detalhadas de coleções, fontes e VR estão nos respectivos arquivos de testes e nos documentos de handoff. O índice de telas para revisão visual fica no repositório Kura, `docs/designer-handoff.md`.

## Coleções de criadores: correções e provas adicionais

A revisão independente encontrou perda de acesso às coleções no merge, referências removidas que impediam salvar e seleção de vídeos limitada à página visível. Corrigidos: o merge transfere ambos os documentos preservando UUIDs/ordem, aumenta revisão e registra snapshots na auditoria; demo remapeia IDs de galeria. Leituras removem referências inválidas da seleção ativa mantendo IDs no histórico, e saves validam membros em transação com locks. O editor web/mobile consulta toda a filmografia com busca e páginas de 24 itens, preservando escolhas entre páginas e exibindo carregamento, erro/retry e vazio.

Provas executadas separadamente (nenhuma mutação na biblioteca real):

- Domínio + lifecycle SQLite temporário: 8 testes, 34 assertions; merge com IDs de galeria conflitantes, ordem, 400 coleções preservadas, revisão antiga, pertencimento e histórico de referências removidas.
- Persistência demo regressão: 3 testes, 8 assertions.
- Lifecycle PostgreSQL em container efêmero: 2 testes, 20 assertions; ramo real de merge, HTTP, auditoria, referência removida, dois saves concorrentes (apenas um vence) e DELETE de galeria concorrente com save (save espera o lock e rejeita nova referência inválida).
- Merge PostgreSQL existente em container efêmero: 4 testes, 27 assertions.
- Overlay autorizado local em SQLite temporário: 1 teste, 9 assertions; duas fotos/filmes pertencem ao criador, aplicação repetida estável e documento intencionalmente vazio do usuário preservado. Este teste é explicitamente pulado no CI sem o overlay local ignorado.
- Backend `tsc --noEmit`, web/mobile typechecks e ESLint do componente web passaram após as correções.
- Demo servido: GET `/api/creator-collections/1778` retornou 200, revisão 1, coleção SFW `79123348-7469-4d14-91e4-97a731ac0045`, 2 imagens fictícias geradas e 2 clipes demo. Seed é opcional, inserido somente se não houver documento existente; nenhum overwrite de coleções.

Limites: o seletor foi posteriormente conferido no navegador com busca vazia e títulos nulos, mas não houve prova física em celular, ergonomia completa ou revisão visual. UUID duplicado entre documentos causa conflito explícito no merge, preservando ambos em rollback. Documentos mesclados acima de 200 coleções são preservados integralmente; o limite existente de criação de novas coleções continua em 200. Não foi adicionada exclusão de coleção nesta rodada.

## Fontes e VR: provas da rodada ampliada

- Suíte unitária backend nesta rodada: 644 passaram, zero falhas. O número inclui regressões existentes; não representa 644 cenários exclusivos desta entrega.
- Suíte web: 49 passaram, incluindo 7 casos de lifecycle WebXR com concessão tardia/cancelamento/rejeição/erro e 3 de geometria. Build web e tipos mobile passaram; build mantém aviso de tamanho de chunks já reportado pelo Vite.
- VR backend: matriz de flags/lentes/overrides e resolução de artwork curada/ausente, 31 testes. Testes de sessão são controlados, sem hardware físico.
- Enrichment: 19 testes Python, 13 Node focados e 11 integrações HTTP/PostgreSQL efêmero. Cobrem schema standard estrito, título nulo, imagens data URL, imagem inválida, todas as fontes falhando, sucesso parcial e sucesso sem resultados, com erros preservados no histórico.
- Leitura LIVE ThePornDB e StashDB, com configurações atuais e nome público: 90 e 87 candidatos respectivamente. Nenhuma proposta foi salva na biblioteca. O StashDB implantado aceita o dialeto legado; não se confundiu schema upstream develop com schema do serviço implantado.
- Descoberta LIVE Stash local: 5 scrapers, configuração da ponte disponível. Não foi executado scraping externo de imagens, geração Stash ou envio de draft.
- Navegador web: busca de grupo, seleção de criador e resumo (742 MB/3 vídeos) conferidos. Coleção SFW preenchida e editor aberto; busca vazia preserva dois vídeos selecionados. Esta conferência encontrou ainda labels em branco em vídeos de título nulo e indicação de página 1/0, corrigidos e reconferidos no navegador: nomes e aria-labels agora usam nome do arquivo quando o título está ausente, e busca vazia mostra página 1/1 sem perder escolhas. Nenhuma edição de coleção foi salva nesta conferência.

A captura de erros e esses cenários melhoram a confiança sobre casos concretos. Não constituem garantia de ausência de bugs nem prova de UX completa.
