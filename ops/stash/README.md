# Stash local para Kura

Instância instalada com imagem oficial `stashapp/stash:v0.31.1`. Interface: `http://localhost:9999`; GraphQL: `http://localhost:9999/graphql`.

A porta escuta só em `127.0.0.1` e o Stash exige login: usuário, senha e chave de API ficam em `data/stash/credentials` (ignorado pelo Git, modo 0600). A chave também está no provedor "Stash local" do Kura. Para abrir a interface de outro aparelho, use um túnel SSH (`ssh -L 9999:127.0.0.1:9999 host`).

## O que o Kura delega ao Stash

- Fingerprints: o Kura sincroniza cada vídeo com a cena do Stash que tem o mesmo arquivo (caminho idêntico) e pede apenas pHash, sem previews, sprites ou capas. Novos arquivos e conversões sincronizam sozinhos; o painel Configurações → Stash mostra a cobertura e sincroniza a biblioteca. Medido: cerca de 8,6 s por arquivo com `parallelTasks = 1`.
- Buscas no StashDB, FansDB e ThePornDB, por fingerprint ou título, e os scrapers comunitários. Salvar a chave de um provedor no Kura também a grava no Stash.
- Contribuições de fingerprints e rascunhos, sempre com confirmação.

Continuam diretos no Kura: busca por ID ou link colado, o OSHASH do arquivo original guardado antes de uma conversão e a verificação de performers mesclados.

Cada pasta da biblioteca precisa estar montada com o mesmo caminho absoluto que o Kura usa (veja `compose.yml`).

## Atualizar o Stash

Troque a tag em `compose.yml`, recrie o container e rode, no serviço Python:

```sh
uv run python scripts/check_stash_contract.py "um título de cena"
```

O script consulta só leitura e aponta a primeira chamada cujo formato mudou.

```sh
docker compose -f ops/stash/compose.yml up -d
```

Estado próprio em `data/stash/` (ignorado pelo Git). O volume `/demo` monta apenas `demo_mode` como leitura. Nenhuma pasta da biblioteca real foi montada, escaneada ou modificada. Para incluir sua biblioteca no futuro, adicione explicitamente volumes de leitura e configure as pastas pelo Stash. Não há sincronização automática entre os bancos.

Na configuração inicial do Stash, selecione `/demo` como pasta e caminhos `/generated`, `/metadata`, `/cache` e `/blobs` para arquivos derivados. A instalação realizada já tem isso configurado. Fonte de scrapers usada: `https://stashapp.github.io/CommunityScrapers/stable/index.yml`. Instalados: Babepedia, IAFD e FreeonesCommunity, além dos scrapers internos. Instale outros pela tela de pacotes do Stash conforme as regras dos respectivos sites.

## Ponte de metadados

No serviço Python, configure `STASH_ENDPOINT=http://127.0.0.1:9999/graphql` e `ENABLE_STASH=true`, ou salve o provedor Stash pelas integrações do Kura. Se o serviço Python estiver em um container, use um endereço que alcance o container Stash.

Um serviço atualizado de validação foi iniciado na porta 8201; a instância preexistente na 8200 foi preservada. Para usar o atualizado no backend normal, configure `ENRICHMENT_SERVICE_URL=http://127.0.0.1:8201`, ou reinicie o serviço existente com o código novo e mantenha sua porta habitual. O backend demo responde com fixtures e nunca chama serviços externos.

FansDB exige o convite e uma chave válida. Cadastre o endpoint GraphQL e a chave na página de provedores. Consumo de metadados cria propostas revisáveis. Para contribuir, o registro deve existir no Stash local e o destino deve estar configurado também no Stash: preparar é leitura; enviar exige a ação explícita de confirmação.

OSHASH é calculado apenas quando solicitado para um vídeo. pHash é recuperado de fingerprints genuínos de um registro Stash já analisado; não é substituído por outro hash. Não foi executado scan automático ou geração sobre a biblioteca real.

## Players VR

Gere os links HereSphere/DeoVR em configurações mobile ou no multiplayer web. Abra o catálogo no navegador de mídia do player nativo. Os links incluem acesso limitado ao catálogo e streaming e expiram em 30 dias; gere novamente quando necessário. O endereço configurado do backend precisa ser alcançável pelo Quest.

O multiplayer espacial próprio está em `/multi`: selecione vídeos, abra o painel espacial e use um navegador com WebXR. A sessão imersiva requer HTTPS ou localhost; no Quest use o domínio HTTPS local que já atende o Kura. Protocolos, range e geometria foram testados; controles e desempenho no headset ainda requerem verificação física.
