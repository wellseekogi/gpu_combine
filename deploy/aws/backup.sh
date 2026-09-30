#!/usr/bin/env bash
# Consistent SQLite + administrator key backup. Briefly pauses the coordinator.
set -euo pipefail
cd -- "$(dirname -- "$0")"
if [[ $# -ne 1 || "$1" != /* ]]; then
    echo 'Usage: sudo bash backup.sh /absolute/path/relay-backup.tar.gz' >&2
    exit 1
fi
backup_path="$1"
if [[ -e "$backup_path" ]]; then
    echo 'Choose a new backup filename; existing backups are never overwritten.' >&2
    exit 1
fi
umask 077
docker compose config --quiet
if [[ -z "$(docker compose ps --status running -q relay)" ]]; then
    echo 'Relay must be running before taking this backup.' >&2
    exit 1
fi
# Exclusive temporary file, in the same directory for atomic publication.
backup_temp="$(mktemp "${backup_path}.partial.XXXXXX")"
chmod 600 "$backup_temp"
restart_relay=0
finish_backup() {
    backup_status=$?
    trap - EXIT
    if [[ "$restart_relay" == 1 ]] && ! docker compose start relay >/dev/null; then
        echo 'Backup cleanup could not restart Relay. Run docker compose up -d.' >&2
        backup_status=1
    fi
    rm -f -- "$backup_temp"
    exit "$backup_status"
}
trap finish_backup EXIT
# Register cleanup before stop so an interrupted stop still restarts the service.
restart_relay=1
docker compose stop -t 30 relay
docker compose run --rm --no-deps -T --entrypoint tar relay \
    -C /var/lib/relay -czf - . > "$backup_temp"
# link refuses an existing destination; never overwrite a concurrent backup.
ln -- "$backup_temp" "$backup_path"
echo "Backup saved: $backup_path (contains private keys; keep it private)."
