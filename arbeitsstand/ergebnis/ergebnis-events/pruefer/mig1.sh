set -e
M=/home/user/Initiative/apps/api/migrations
psql "$DATABASE_URL" -q -c "drop schema if exists pruefer_mig cascade" -c "create schema pruefer_mig"
export PGOPTIONS='-c search_path=pruefer_mig'
for f in $(ls $M/00{01..22}_*.sql); do psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -f $f >/dev/null; done
echo "0001..0022 ok"
