#!/bin/bash
# Neon read-only for its app, for the move to Cloud.ru and its rollback window (docs/cloudru-migration.md,
# «Переключение»):
#
#   db-neon-mode.sh status       Neon's database default (default_transaction_read_only) and the other
#                                sessions of its role
#   db-neon-mode.sh read-only    ALTER DATABASE <neon's> SET default_transaction_read_only = on, then end the
#                                other sessions of the role: Vercel (and Neon's pooler) reconnect read-only,
#                                every write of Bro on Vercel fails from then on, reads work
#   db-neon-mode.sh writable     RESET it, then end the other sessions: they come back writable (a rollback)
#
# The setting is only a default: db-copy.sh's own sessions still write (the rollback copy app → neon), a
# client that turns it off for itself too; Bro does not. A change only on production's VM (HOST_PROFILE=prod),
# with NEON_DATABASE_URL in /etc/bro/ops-env (host.py env NAME --profile prod --with-neon).
source "$(dirname "$0")/db-lib.sh"
[ $# = 1 ] || die "usage: db-neon-mode.sh status|read-only|writable"
case "$1" in
  status) ;;
  read-only | writable)
    [ "${HOST_PROFILE:-}" = prod ] || die "Neon's mode changes only from production's VM (HOST_PROFILE=prod)"
    db_lock  # not in the middle of a copy into or out of Neon (db-copy.sh)
    ;;
  *) die "usage: db-neon-mode.sh status|read-only|writable" ;;
esac
connection NEON neon

end_other_sessions() {
  psql_on NEON -c "SELECT count(pg_catalog.pg_terminate_backend(pid)) FROM pg_catalog.pg_stat_activity
    WHERE datname = current_database() AND usename = current_user AND pid <> pg_backend_pid()"
}

case "$1" in
  read-only)
    # The session itself writable: once the default is on, a repeat (or the RESET below) would be refused.
    PGOPTIONS="$WRITABLE" psql_on NEON <<'SQL'
SELECT format('ALTER DATABASE %I SET default_transaction_read_only = on', current_database()) \gexec
SQL
    echo "ended $(end_other_sessions) other sessions"
    ;;
  writable)
    PGOPTIONS="$WRITABLE" psql_on NEON <<'SQL'
SELECT format('ALTER DATABASE %I RESET default_transaction_read_only', current_database()) \gexec
SQL
    echo "ended $(end_other_sessions) other sessions"
    ;;
esac
# A new session reads the database's default: what Vercel's next connection gets.
echo "neon: default_transaction_read_only=$(read_only_default NEON), other sessions $(other_sessions NEON)" \
  "($(other_sessions NEON busy) in a transaction)"
