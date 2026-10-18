#!/bin/bash
# Where Postgres spends its time, read only — which queries and tables a turn makes the database work on:
#
#   host.py ops NAME db-hot.sh [app|world]
#
# For the app database (default) or the Workflow world's, prints the statements with the most total time
# from pg_stat_statements when the extension is there (calls, total and mean ms, rows per call; the text
# as the extension normalizes it, constants already `$n`, cut to 160 characters), the tables by sequential
# scans against index scans with their live rows, and the largest tables with their indexes. Statistics
# and sizes only: no row of a table is read.
source "$(dirname "$0")/db-lib.sh"
WHICH=${1:-app}
[[ "$WHICH" == app || "$WHICH" == world ]] || die "app or world"
connection SRC "$WHICH"
PGOPTIONS="-c default_transaction_read_only=on" psql_on SRC <<'SQL'
\pset tuples_only off
\pset format aligned
\pset footer off
SELECT current_database() AS database, now() AT TIME ZONE 'UTC' AS utc,
       (SELECT count(*) FROM pg_extension WHERE extname = 'pg_stat_statements') AS has_statements,
       (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()) AS stats_since;
SELECT relname AS table_name,
       n_live_tup AS live_rows,
       seq_scan,
       seq_tup_read,
       idx_scan,
       n_tup_ins + n_tup_upd + n_tup_del AS writes
FROM pg_stat_user_tables
ORDER BY seq_tup_read DESC
LIMIT 15;
SELECT c.relname AS table_name,
       pg_size_pretty(pg_table_size(c.oid)) AS data,
       pg_size_pretty(pg_indexes_size(c.oid)) AS indexes,
       c.reltuples::bigint AS rows_estimate
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY pg_total_relation_size(c.oid) DESC
LIMIT 12;
SQL
if PGOPTIONS="-c default_transaction_read_only=on" psql_on SRC -tAc \
  "SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'" | grep -q 1; then
  PGOPTIONS="-c default_transaction_read_only=on" psql_on SRC <<'SQL'
\pset tuples_only off
\pset format aligned
\pset footer off
SELECT s.calls,
       round(s.total_exec_time::numeric) AS total_ms,
       round(s.mean_exec_time::numeric, 2) AS mean_ms,
       round((s.rows::numeric / greatest(s.calls, 1)), 1) AS rows_per_call,
       left(regexp_replace(s.query, '\s+', ' ', 'g'), 160) AS statement
FROM pg_stat_statements s
JOIN pg_database d ON d.oid = s.dbid
WHERE d.datname = current_database()
ORDER BY s.total_exec_time DESC
LIMIT 25;
SQL
fi
