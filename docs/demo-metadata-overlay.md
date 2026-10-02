# Amostra real de metadados com mídia demo SFW

A exportação é explicitamente autorizada pelo usuário e lê somente metadados. O
script `bun scripts/export-demo-metadata-overlay.ts --read-only-export` abre uma
transação PostgreSQL `REPEATABLE READ READ ONLY` e confirma
`transaction_read_only=on`. Não consulta paths de imagens, miniaturas ou arquivos,
não copia vídeos nem acessa provedores externos. O resultado local, ignorado pelo
Git, fica em `demo_mode/metadata-overlay.json`.

A seleção atual contém 8 criadores com fontes externas, aliases, atributos,
plataformas e links. Inclui 14 registros de vídeos relacionados com títulos,
descrições, tags e estúdios. Nomes e metadados são reais, conforme solicitado.
Todos os novos streams usam o mesmo clip seguro já presente no demo; nenhuma
cópia de mídia da biblioteca foi criada. Esses registros não representam tamanho,
duração nem frames dos vídeos reais.

Duas imagens de portfólio fictício foram geradas pelo **built-in imagegen**, sem
usar retratos reais como referência, e inspecionadas visualmente:

- `demo_mode/sfw/portfolio-studio.png`, 1536 × 1024: profissional adulta fictícia
  vestida num estúdio de arquitetura.
- `demo_mode/sfw/portfolio-gallery.png`, 1536 × 1024: profissional adulta fictícia
  vestida numa galeria de arte.

Os prompts completos e a origem estão em `demo_mode/sfw/manifest.json`. As imagens
ilustram a apresentação da coleção; **não são fotos dos criadores identificados**.
As galerias identificam expressamente a arte como fictícia e SFW.

O hook `applyDemoMetadataOverlay()` aplica o overlay após restauração do baseline
e dos exemplos padrão. Ele é idempotente, usa IDs reservados para vídeos e mídia
do overlay e resolve todos os arquivos dentro de `DEMO_ASSETS_DIR`. O baseline
original continua intacto. Em `NODE_ENV=test`, o hook ignora o arquivo local por
padrão, preservando o isolamento dos fixtures. `allowInTests` existe somente para
validação explícita em uma cópia SQLite separada.

Provas locais: importação em cópia separada aplicada duas vezes com 8 criadores e
14 vídeos sem duplicação; `PRAGMA foreign_key_check` sem violações;
`PRAGMA quick_check=ok`; PostgreSQL confirmou transação read-only; zero arquivos
de mídia original copiados; assets de imagem ausentes do exportador real.
