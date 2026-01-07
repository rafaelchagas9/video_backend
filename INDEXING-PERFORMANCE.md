# Indexing Performance Guide

## 📊 Overview

O processo de indexação agora possui logs detalhados para identificar gargalos e monitorar o progresso em tempo real.

### Tipos de Scan

O sistema pode iniciar um scan de três formas diferentes:

1. **Scan Inicial** (`triggeredBy: "initial"`) - Quando um diretório é registrado pela primeira vez
2. **Scan Manual** (`triggeredBy: "manual"`) - Quando disparado manualmente via API
3. **Scan Agendado** (`triggeredBy: "scheduler"`) - Quando executado automaticamente pelo scheduler

Todos os tipos geram os mesmos logs detalhados para facilitar o monitoramento.

## 🔍 Logs Adicionados

### 1. **Início e Fim do Scan**
- Log de início com ID do diretório
- Log final com resumo completo e tempo total

### 2. **Descoberta de Arquivos**
- Tempo gasto escaneando diretórios recursivamente
- Quantidade de arquivos encontrados
- Exemplo: `Found 150 video files in 2.35s`

### 3. **Progresso de Indexação**
- Logs a cada 10 arquivos processados
- Tempo médio por arquivo
- ETA (tempo estimado restante)
- Exemplo: `Indexed 40/150 files (ETA: 125s)`

### 4. **Detalhamento por Arquivo**
Cada arquivo indexado agora mostra:
- **DB Check**: Tempo para verificar se o vídeo já existe
- **File Size**: Tempo para obter tamanho do arquivo
- **Metadata Extraction**: Tempo de execução do ffprobe
- **Hash Computation**: Tempo para calcular SHA256
- **Total**: Tempo total de indexação do arquivo

### 5. **Alertas de Performance**
Logs de **WARN** são gerados quando:
- Extração de metadados > 3s
- Cálculo de hash > 2s  
- Indexação de arquivo > 5s

### 6. **Arquivos Removidos**
- Detecta arquivos que existem no DB mas não no disco
- Marca como indisponíveis

## 📈 Como Identificar Gargalos

### Executar o scan

**Scan Manual:**
```bash
# Iniciar o servidor em modo desenvolvimento
bun dev

# Em outro terminal, triggerar um scan manual
curl -X POST http://localhost:3000/api/v1/directories/1/scan
```

**Scan Agendado:**
```bash
# O scheduler inicia automaticamente com o servidor
# Verifique a configuração do diretório:
curl http://localhost:3000/api/v1/directories/1
# auto_scan: true/false
# scan_interval_minutes: intervalo em minutos
```

### Identificar tipo de scan nos logs

Procure pelo campo `triggeredBy` nos logs:

```log
# Scan inicial (criação de diretório)
[INFO] Directory registered, triggering initial scan directoryId=1 path=/videos

# Scan manual (endpoint POST /directories/:id/scan)
[INFO] Manual scan triggered by user directoryId=1 path=/videos triggeredBy=manual

# Scan automático (scheduler)
[INFO] Running scheduled scan (interval: 30min) directoryId=1 path=/videos triggeredBy=scheduler
```

### Analisar os logs

1. **Tempo de descoberta muito alto?**
   ```
   Found 150 video files in 45.23s  # ⚠️ PROBLEMA
   ```
   - **Causa**: Muitos arquivos ou I/O lento
   - **Solução**: Considere paralelizar ou usar índices do sistema de arquivos

2. **Metadata extraction lenta?**
   ```
   Metadata extraction took 8.50s - consider optimization  # ⚠️ PROBLEMA
   ```
   - **Causa**: ffprobe é lento em alguns formatos/codecs
   - **Solução**: Verificar se ffprobe está otimizado, considerar cache

3. **Hash computation lenta?**
   ```
   Hash computation took 5.20s  # ⚠️ PROBLEMA
   ```
   - **Causa**: Arquivo muito grande ou I/O lento
   - **Solução**: Considere calcular hash de forma assíncrona ou em background

4. **Tempo médio por arquivo alto?**
   ```
   avgTimePerFileMs: 8500  # ⚠️ PROBLEMA (8.5s por arquivo)
   ```
   - **Causa**: Combinação dos problemas acima
   - **Solução**: Identificar qual operação é o gargalo

## 🎯 Níveis de Log

### Development Mode (default)
```bash
bun dev  # Logs em nível DEBUG
```
- Mostra todos os detalhes
- Logs para cada etapa de cada arquivo
- Ideal para debugging

### Production Mode
```bash
bun start  # Logs em nível INFO
```
- Mostra apenas logs importantes
- Progresso a cada 10 arquivos
- Resumo final
- Alertas de performance

## 🔧 Otimizações Possíveis

Com base nos logs, você pode implementar:

### 1. Paralelização
Se o gargalo é I/O ou ffprobe:
```typescript
// Processar múltiplos arquivos simultaneamente
const BATCH_SIZE = 5;
for (let i = 0; i < videoFiles.length; i += BATCH_SIZE) {
  const batch = videoFiles.slice(i, i + BATCH_SIZE);
  await Promise.all(batch.map(file => this.indexVideo(file, directoryId)));
}
```

### 2. Cache de Metadados
Se ffprobe é lento:
```typescript
// Armazenar metadados em cache por hash do arquivo
const cacheKey = `metadata:${fileHash}`;
```

### 3. Hash Incremental
Se hash é lento em arquivos grandes:
```typescript
// Calcular hash apenas dos primeiros X MB + tamanho total
const partialHash = await computePartialFileHash(filePath, 10 * 1024 * 1024);
```

### 4. Skip Metadata para Arquivos Existentes
Se arquivo não mudou:
```typescript
if (existing && existing.file_size_bytes === fileSize) {
  // Pular extração de metadados
  return;
}
```

## 📊 Exemplo de Output

```
[INFO] Starting directory scan directoryId=1
[DEBUG] Directory loaded directoryId=1 path=/videos
[INFO] Scanning for video files... directoryId=1 path=/videos
[INFO] Found 150 video files in 2.35s directoryId=1 count=150 durationMs=2350
[INFO] Starting video indexing... directoryId=1 totalFiles=150
[DEBUG] Extracting metadata... filePath=/videos/movie1.mp4
[DEBUG] ffprobe completed in 1250ms filePath=/videos/movie1.mp4
[DEBUG] Computing file hash... filePath=/videos/movie1.mp4
[DEBUG] Hash computed in 850ms filePath=/videos/movie1.mp4
[INFO] Indexed 10/150 files (ETA: 125s) progress=10/150 avgTimePerFileMs=2150
[WARN] Metadata extraction took 5.50s - consider optimization filePath=/videos/large.mkv durationMs=5500
[INFO] Indexed 150 files in 322.50s filesIndexed=150 durationMs=322500
[INFO] Directory scan completed in 325.10s - Found: 150, Added: 145, Removed: 5, Errors: 0
```

## 🚀 Próximos Passos

1. Execute um scan e analise os logs
2. Identifique o gargalo principal (metadata, hash, ou I/O)
3. Implemente a otimização apropriada
4. Re-teste e compare os tempos

## 💡 Dicas

- Use `bun dev` para ver logs detalhados durante desenvolvimento
- Em produção, monitore logs de WARN para identificar problemas
- Se você tem muitos vídeos (>1000), considere paralelização
- Para arquivos muito grandes (>4GB), o hash pode ser o gargalo
