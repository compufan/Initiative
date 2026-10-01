#!/bin/bash
cd "$(dirname "$0")"
psql "$DATABASE_URL" -q -f parallel-aufbau.sql >/dev/null
VARS="-v jetzt=2030-01-02T10:00:00+00 -v max=10 -v reserve=2 -v stapel=100"
( psql "$DATABASE_URL" -q $VARS -c "set search_path to erinn_probe, public" -c "begin" -f anspruch.sql -c "select pg_sleep(3)" -c "commit" > s1.out 2>&1 ) &
sleep 1
( psql "$DATABASE_URL" -q $VARS -c "set search_path to erinn_probe, public" -c "begin" -f anspruch.sql -c "commit" > s2.out 2>&1 ) &
wait
echo "--- Sitzung 1:"; grep -c "0000000001" s1.out
echo "--- Sitzung 2:"; grep -c "0000000001" s2.out
psql "$DATABASE_URL" -Atc "set search_path to erinn_probe, public; select count(*), count(distinct user_id) from event_erinnerungen"
psql "$DATABASE_URL" -q -c "drop schema erinn_probe cascade"
