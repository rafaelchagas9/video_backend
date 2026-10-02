# Auditoria dos contratos de metadados

## Correções confirmadas

- O dialect `standard` de Stash-box não seleciona mais `Performer.death_date`, ausente no schema upstream atual. O campo legado continua disponível nos dialects anteriores.
- Cenas com título nulo preservam as demais sugestões sem interromper a fonte.
- Imagens inline `data:image/...;base64` de scrapers Stash são decodificadas e validadas antes de usar o escritor existente da galeria. As dimensões também são lidas dessas imagens.
- A biografia raspada recebe a mesma identidade de resultado das demais sugestões, mantendo o agrupamento no web/mobile.
- Falha em todas as fontes resulta em execução `error`; resultados parciais preservam sugestões e mensagens de erro; busca válida vazia permanece `success`.
- Ferramentas de fingerprints oferecem apenas Stash-box; URL de scraper oferece apenas Stash local. Web/mobile mostram erros retornados e identificam claramente a simulação demo.

## Evidências e limites

- Schema primário consultado: `stashapp/stash-box`, branch `develop`, arquivos `graphql/schema/types/performer.graphql`, `scene.graphql` e `schema.graphql`.
- Schema primário Stash consultado: `stashapp/stash`, branch `develop`, tipos `scraper.graphql`, `scraped-performer.graphql`, `stash-box.graphql` e raiz `schema.graphql`.
- Stash local v0.31.1: introspecção confirmou os campos utilizados pelo bridge; a listagem retornou cinco scrapers, quatro com suporte a performer. Preparação de contribuição para ID inexistente retornou erro esperado. Todas essas chamadas foram somente leitura.
- 19 testes Python passaram, incluindo seleção de campos com allowlist rigorosa, resultados nulos, imagens inline e identidade das sugestões.
- 13 testes Node focados passaram; leitura real de PNG em memória verificou bytes e dimensões sem HTTP.
- 11 testes de integração HTTP/Postgres passaram, com 157 assertions. O banco foi um container descartável: escrita, aceitação de propostas e histórico ocorreram somente nesse banco. A resposta Python foi simulada nesse teste.
- Typecheck web/mobile e lint dos arquivos alterados passaram.
- O overlay demo reproduz amostras locais: não valida comunicação com plataformas externas.
- Busca LIVE somente leitura, com as credenciais e configuração existentes e um nome público: ThePornDB (`tpdb`) retornou 90 candidates; StashDB (`stashbox`) retornou 87 candidates. O StashDB implantado aceitou o contrato legado, incluindo `searchPerformers` e `death_date`; por isso o default legado foi preservado. O schema da branch upstream `develop` não deve ser confundido com a versão do serviço implantado.
- FansDB autenticado e envio real de contribuições ainda não foram exercitados. Nenhuma contribuição externa, varredura Stash ou alteração da biblioteca real foi feita nesta auditoria.

## Handoff de interface

Telas existentes alteradas: ferramentas de fontes no detalhe do criador e ferramentas de fingerprints/URL na revisão de metadados da cena, em web e mobile. Revisar apresentação de erro parcial, aviso de simulação e troca de fonte ao alternar modo; nenhuma nova página criada por esta correção.
