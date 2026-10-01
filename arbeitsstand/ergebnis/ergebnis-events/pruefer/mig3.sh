export PGOPTIONS='-c search_path=pruefer_mig'
psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -f mig2.sql && echo seeded
psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -1 -f /home/user/Initiative/apps/api/migrations/0023_einladen.sql && echo "lauf1 ok"
psql "$DATABASE_URL" -c "select e.title, u.username, a.status from event_attendees a join calendar_events e on e.id=a.event_id join users u on u.id=a.user_id order by 1,2"
psql "$DATABASE_URL" -c "select e.title, p.art, right(p.conversation_id::text,1) chat, right(p.message_id::text,2) msg, (select username from users where id=p.user_id) person from event_placements p join calendar_events e on e.id=p.event_id order by 1,3,4"
psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -1 -f /home/user/Initiative/apps/api/migrations/0023_einladen.sql && echo "lauf2 ok"
