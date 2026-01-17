#!/bin/bash

# Service to PostgreSQL Async Converter
# Automates common conversion patterns

if [ -z "$1" ]; then
  echo "Usage: $0 <service-file.ts>"
  exit 1
fi

FILE="$1"

if [ ! -f "$FILE" ]; then
  echo "Error: File not found: $FILE"
  exit 1
fi

echo "Converting $FILE to async PostgreSQL..."

# Create backup
cp "$FILE" "$FILE.backup"

# 1. Update imports
sed -i "s/import { getDatabase } from '@\/config\/database';/import { query, queryOne, queryAll, transaction } from '@\/config\/database';/g" "$FILE"

# 2. Remove the db getter
sed -i '/private get db() {/,/}/d' "$FILE"

# 3. Convert .prepare().get() to queryOne
# This is complex, will need manual review

# 4. Convert .prepare().all() to queryAll
# This is complex, will need manual review

# 5. Convert .prepare().run() to query
# This is complex, will need manual review

# 6. Replace ? placeholders with numbered parameters
# This is complex and context-dependent, needs manual review

# 7. Replace SQLite-specific functions
sed -i "s/datetime('now')/CURRENT_TIMESTAMP/g" "$FILE"
sed -i "s/datetime(\"now\")/CURRENT_TIMESTAMP/g" "$FILE"

echo "✓ Basic conversions applied"
echo "⚠  Manual review required for:"
echo "  - .prepare().get() -> queryOne()"
echo "  - .prepare().all() -> queryAll()"
echo "  - .prepare().run() -> query()"
echo "  - ? -> \$1, \$2, \$3 placeholders"
echo "  - Transactions"
echo ""
echo "Backup saved to: $FILE.backup"
