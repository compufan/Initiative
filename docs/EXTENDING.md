# Erweitern – ein Kochbuch

Initiative ist als Plattform gebaut: Ein neues Stück App kostet einen Ordner und
eine Zeile in einer Registry. Der Kern – Transport, Authentifizierung,
Realtime, Offline, Push – bleibt unangetastet.

| Ich will …                      | Datei(en)                                  | Zeile in                                     |
| ------------------------------- | ------------------------------------------ | -------------------------------------------- |
| eigene REST-Routen              | `apps/api/src/modules/<name>.rs`           | `modules/mod.rs`                             |
| eine neue Tabelle               | `apps/api/migrations/000X_<name>.sql`      | – (läuft beim Start)                         |
| einen Tab, Screens, Chat-Blasen | `apps/web/src/modules/<name>/module.ts`    | `modules/registry.ts`                        |
| einen neuen Nachrichtentyp      | Expander im Backend + Renderer im Frontend | `services/expanders.rs`                      |
| ein Mini-Spiel                  | `apps/api/src/games/<name>.rs`             | `games/mod.rs` + zwei Registries im Frontend |

Vorher lohnt ein Blick in [ARCHITECTURE.md](ARCHITECTURE.md) (wie die Teile
zusammenhängen) und [API.md](API.md) (welcher Vertrag schon existiert).

---

## 1. Neues Backend-Modul

Beispiel: eine gemeinsame Aufgabenliste.

### 1.1 Migration schreiben

Neue Datei `apps/api/migrations/0002_tasks.sql`. Die Nummer muss **größer** sein
als alle bestehenden, der Name danach ist frei.

```sql
-- Gemeinsame Aufgaben pro Chat.
create table if not exists tasks (
  id              uuid primary key,
  conversation_id uuid not null references conversations (id) on delete cascade,
  created_by      uuid references users (id) on delete set null,
  title           text not null,
  done_at         timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists tasks_conversation_idx on tasks (conversation_id, id desc);
```

Regeln, die sich bewährt haben:

- IDs sind **UUID v7** (`Uuid::now_v7()` im Rust-Code) – dadurch sind sie
  zeitlich sortiert und `where id < $cursor` reicht als Pagination.
- `create table if not exists` und `create index if not exists`, damit ein
  erneuter Lauf nie scheitert.
- Fremdschlüssel mit `on delete cascade` auf `conversations`, sonst bleiben
  Waisen zurück, wenn ein Chat verschwindet.
- Migrationen sind **einkompiliert** (`sqlx::migrate!` in `lib.rs`) und laufen
  beim Start. Eine schon angewandte Migration darf **nie** nachträglich
  geändert werden – sqlx prüft Prüfsummen und verweigert sonst den Start.
  Änderungen kommen als neue Datei.

### 1.2 Zeilen-Typ ergänzen

In `apps/api/src/db.rs`:

```rust
#[derive(Debug, Clone, FromRow)]
pub struct TaskRow {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub created_by: Option<Uuid>,
    pub title: String,
    pub done_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}
```

### 1.3 Modul anlegen

`apps/api/src/modules/tasks.rs`:

```rust
//! Gemeinsame Aufgabenliste pro Chat.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::db::TaskRow;
use crate::dto::ListResult;
use crate::error::AppResult;
use crate::realtime::Event;
use crate::services::conversations::{assert_membership, member_ids};
use crate::state::AppState;
use crate::validate::Validator;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/conversations/{id}/tasks", get(list).post(create))
        .route("/tasks/{id}/done", post(toggle_done))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDto {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub created_by: Option<Uuid>,
    pub title: String,
    pub done_at: Option<chrono::DateTime<chrono::Utc>>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

fn to_dto(row: TaskRow) -> TaskDto {
    TaskDto {
        id: row.id,
        conversation_id: row.conversation_id,
        created_by: row.created_by,
        title: row.title,
        done_at: row.done_at,
        created_at: row.created_at,
    }
}

async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Path(conversation_id): Path<Uuid>,
) -> AppResult<Json<ListResult<TaskDto>>> {
    // Ohne diese Zeile könnte jeder jede Liste lesen.
    assert_membership(&state.pool, conversation_id, user.id()).await?;

    let rows = sqlx::query_as::<_, TaskRow>(
        "select * from tasks where conversation_id = $1 order by id desc limit 200",
    )
    .bind(conversation_id)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(ListResult::new(rows.into_iter().map(to_dto).collect())))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateInput {
    title: String,
}

async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Path(conversation_id): Path<Uuid>,
    Json(input): Json<CreateInput>,
) -> AppResult<(StatusCode, Json<TaskDto>)> {
    assert_membership(&state.pool, conversation_id, user.id()).await?;
    let title = input.title.trim().to_string();
    Validator::new().length("title", &title, 1, 200).finish()?;

    let row = sqlx::query_as::<_, TaskRow>(
        "insert into tasks (id, conversation_id, created_by, title)
         values ($1, $2, $3, $4) returning *",
    )
    .bind(Uuid::now_v7())
    .bind(conversation_id)
    .bind(user.id())
    .bind(&title)
    .fetch_one(&state.pool)
    .await?;

    let dto = to_dto(row);
    // Alle Mitglieder erfahren sofort davon – ohne Nachfragen per REST.
    let audience = member_ids(&state.pool, conversation_id).await?;
    state
        .hub
        .publish(audience, Event::new("task.updated", serde_json::json!({ "task": dto })))
        .await;

    Ok((StatusCode::CREATED, Json(dto)))
}

async fn toggle_done(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<TaskDto>> {
    let row = sqlx::query_as::<_, TaskRow>("select * from tasks where id = $1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| crate::error::AppError::not_found("Aufgabe nicht gefunden"))?;
    assert_membership(&state.pool, row.conversation_id, user.id()).await?;

    let updated = sqlx::query_as::<_, TaskRow>(
        "update tasks set done_at = case when done_at is null then now() else null end
         where id = $1 returning *",
    )
    .bind(id)
    .fetch_one(&state.pool)
    .await?;

    let dto = to_dto(updated);
    let audience = member_ids(&state.pool, row.conversation_id).await?;
    state
        .hub
        .publish(audience, Event::new("task.updated", serde_json::json!({ "task": dto })))
        .await;

    Ok(Json(dto))
}
```

`Event::new` erwartet einen `&'static str` – Ereignistypen sind Konstanten, keine
zur Laufzeit gebauten Strings.

### 1.4 Registrieren

In `apps/api/src/modules/mod.rs` **drei** Stellen:

```rust
pub mod tasks;                       // 1. Modul bekannt machen

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(auth::router())
        // …
        .merge(tasks::router())      // 2. Routen einhängen
}

pub const MODULE_KEYS: &[&str] = &[
    "auth",
    // …
    "tasks",                          // 3. taucht unter GET / auf
];
```

### 1.5 Ausprobieren

```bash
cd /home/user/Initiative
cargo run --manifest-path apps/api/Cargo.toml --bin initiative-api

curl -X POST http://localhost:8080/api/v1/conversations/$CHAT/tasks \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":"Karten besorgen"}'
```

### Was du beachten musst

- **Jede** Route, die Chat-Daten anfasst, ruft `assert_membership` auf. Es gibt
  keine zentrale Prüfung, die das für dich erledigt.
- Fehler entstehen nur über `AppError::*` – so bleibt das Format
  `{ error: { code, message, details } }` überall gleich.
- Feldnamen im DTO in camelCase (`#[serde(rename_all = "camelCase")]`).
- `sqlx::query_as` statt der Makros: Das Projekt baut ohne laufende Datenbank,
  was CI und Docker-Build einfach hält.

---

## 2. Neues Frontend-Modul

`apps/web/src/modules/tasks/`:

```
tasks/
├─ module.ts        Contract: nav, routes, messageRenderers, composerActions
├─ TasksScreen.tsx  Bildschirm
├─ TaskBubble.tsx   Chat-Blase
├─ TaskComposer.tsx Sheet im Anhang-Menü
├─ useTasks.ts      Daten laden, Realtime abonnieren
└─ styles.css       nur Klassen dieses Moduls
```

### 2.1 `module.ts`

```ts
import { createElement } from 'react';
import { defineWebModule } from '../types.js';
import { TaskBubble } from './TaskBubble.js';
import { TaskComposer } from './TaskComposer.js';
import { TasksScreen } from './TasksScreen.js';
import './styles.css';

/**
 * Aufgaben – gemeinsame Listen pro Chat.
 */
export default defineWebModule({
  key: 'tasks',
  title: 'Aufgaben',
  description: 'Gemeinsame Listen: wer bringt was mit.',
  nav: [{ path: '/aufgaben', label: 'Aufgaben', icon: '✅', order: 40 }],
  routes: [{ path: '/aufgaben', element: createElement(TasksScreen) }],
  messageRenderers: { task: TaskBubble },
  composerActions: [{ key: 'task', label: 'Aufgabe', icon: '✅', order: 90, render: TaskComposer }],
});
```

### 2.2 Registrieren

`apps/web/src/modules/registry.ts`:

```ts
import tasks from './tasks/module.js';

export const appModules: AppModuleDefinition[] = [
  messenger,
  media,
  calendar,
  games,
  stickers,
  polls,
  tasks, // ← neu
  profile,
];
```

Mehr ist nicht nötig: Navigation, Routen, Chat-Blasen und Composer-Aktionen
werden aus der Registry eingesammelt.

### 2.3 Der Contract im Einzelnen

| Feld                      | Wofür                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `key`                     | eindeutiger Schlüssel des Moduls                                                   |
| `title`, `description`    | Anzeigename und ein Satz für Übersichten                                           |
| `nav`                     | Einträge in der unteren Leiste: `{ path, label, icon, order, useBadge? }`          |
| `routes`                  | React-Router-Routen (`RouteObject[]`)                                              |
| `messageRenderers`        | `{ '<messageType>': Component }` – Chat-Blase für eigene Typen                     |
| `composerActions`         | Einträge im Anhang-Menü: `{ key, label, icon, order, render }`                     |
| `init`                    | läuft einmal beim Start mit angemeldeter Sitzung, darf Aufräumfunktion zurückgeben |
| `overlay` / `overlayNode` | genau einmal in der App-Hülle gerendert (Sheets, globale Listener)                 |

`order` bestimmt die Reihenfolge: Chats 10, Kalender 20, Spiele 30, Profil 90.
Beim Composer sind 10–80 vergeben (Kamera bis Spiel).

`useBadge` ist ein Hook – er darf `useChat` und andere Stores benutzen:

```ts
nav: [{
  path: '/aufgaben',
  label: 'Aufgaben',
  icon: '✅',
  order: 40,
  useBadge: () => useTaskStore((state) => state.openCount),
}],
```

### 2.4 Ein Composer-Sheet

`ComposerActionProps` liefert `conversationId` und `onClose`:

```tsx
import { useState } from 'react';
import type { ComposerActionProps } from '../types.js';
import { Sheet } from '../../components/Sheet.js';
import { request } from '../../lib/api.js';
import { toast } from '../../state/ui.js';

export function TaskComposer({ conversationId, onClose }: ComposerActionProps) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      await request('POST', `/conversations/${conversationId}/tasks`, {
        body: { title: title.trim() },
      });
      toast('Aufgabe angelegt');
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Aufgabe fehlgeschlagen', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open title="Neue Aufgabe" onClose={onClose}>
      <input
        className="input"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Was ist zu tun?"
        maxLength={200}
        autoFocus
      />
      <button className="btn btn-primary" onClick={submit} disabled={busy || !title.trim()}>
        {busy ? 'Wird angelegt …' : 'Anlegen'}
      </button>
    </Sheet>
  );
}
```

### Was du beachten musst

- **Kein eigener `fetch`.** Alles geht über `lib/api.ts` – dort sitzen
  Token-Erneuerung, Fehlerübersetzung und Offline-Erkennung. Bestehende
  Endpunkte rufst du über das getippte `api`-Objekt auf (`api.messages.send(…)`),
  eigene über die exportierte Funktion `request(method, path, options)`. Wer
  mag, ergänzt für sein Modul einen eigenen Block in `api.ts`.
- **Fehler immer abfangen** und mit `toast(text, 'error')` melden.
- **Lade- und Leerzustände gehören dazu** – `components/Feedback.tsx` bringt sie
  fertig mit.
- **Eigenes CSS** nur in der `styles.css` deines Ordners, importiert in
  `module.ts`. Klassennamen mit dem Modulnamen präfixen (`task-row`, nicht `row`).
  Bestehende Klassen aus `styles/global.css` (`.btn`, `.card`, `.sheet`,
  `.list-row`, `.input`, `.muted`, `.truncate`) zuerst nutzen.
- **Mobile first**: Touch-Ziele mindestens 44 px, Safe-Area-Variablen beachten
  (`env(safe-area-inset-bottom)` steckt bereits in den Tokens).
- **Relative Importe mit `.js`-Endung** – das Projekt fährt ESM.

Prüfen:

```bash
pnpm --filter @initiative/web exec tsc -p tsconfig.json --noEmit
pnpm --filter @initiative/web test
```

---

## 3. Neuer Nachrichtentyp

Eine Chat-Nachricht besteht aus `type`, optionalem `body`, Anhängen und einem
freien `metadata`-Objekt. Für etwas Eigenes im Chat gibt es zwei Wege.

### Weg A – alles steckt in `metadata`

Für kleine, unveränderliche Daten reicht das. Kein Backend-Code nötig:

```ts
await sendMessage(conversationId, {
  type: 'task',
  body: 'Karten besorgen',
  metadata: { taskTitle: 'Karten besorgen', assignee: userId },
});
```

Dazu einen Renderer im Frontend (siehe unten) – fertig. Nachteil: Der Inhalt
friert ein. Wird die Aufgabe abgehakt, ändert sich die Nachricht nicht mit.

### Weg B – `metadata` verweist auf eine Entität (Expander)

So machen es Umfragen, Termine, Spiele und Sticker: Die Nachricht speichert nur
die ID, und ein **MessageExpander** hängt beim Ausliefern den aktuellen Stand an.
Dadurch zeigt eine alte Nachricht immer den heutigen Zustand.

**1. Beim Senden nur die ID mitgeben**

```json
{ "type": "task", "metadata": { "taskId": "018f…" } }
```

**2. Feld in `Expansion` ergänzen** (`apps/api/src/services/expanders.rs`):

```rust
#[derive(Debug, Default, Clone)]
pub struct Expansion {
    pub poll: Option<PollDto>,
    pub event: Option<CalendarEventDto>,
    pub game: Option<GameSessionDto>,
    pub sticker: Option<StickerDto>,
    pub task: Option<TaskDto>,     // ← neu
}
```

und im Zusammenführen in `run()` eine Zeile:

```rust
if expansion.task.is_some() {
    entry.task = expansion.task;
}
```

**3. Expander schreiben** (in deinem Modul, z. B. `services/tasks.rs`):

```rust
pub struct TaskExpander;

#[async_trait]
impl MessageExpander for TaskExpander {
    fn key(&self) -> &'static str {
        "tasks"
    }

    async fn expand(
        &self,
        state: &AppState,
        _viewer_id: Uuid,
        messages: &[MessageRow],
    ) -> AppResult<HashMap<Uuid, Expansion>> {
        // Sammelt alle metadata.taskId eines Stapels – eine Abfrage, nicht N.
        let ids = referenced_ids(messages, "taskId");
        if ids.is_empty() {
            return Ok(HashMap::new());
        }

        let rows = sqlx::query_as::<_, TaskRow>("select * from tasks where id = any($1)")
            .bind(&ids)
            .fetch_all(&state.pool)
            .await?;
        let tasks: HashMap<Uuid, TaskDto> =
            rows.into_iter().map(|row| (row.id, to_dto(row))).collect();

        let mut result = HashMap::new();
        for message in messages {
            if let Some(task_id) = metadata_id(message, "taskId") {
                if let Some(task) = tasks.get(&task_id) {
                    result.insert(
                        message.id,
                        Expansion { task: Some(task.clone()), ..Default::default() },
                    );
                }
            }
        }
        Ok(result)
    }
}
```

**4. Registrieren** in `EXPANDERS` (`services/expanders.rs`):

```rust
static EXPANDERS: LazyLock<Vec<Box<dyn MessageExpander>>> = LazyLock::new(|| {
    vec![
        Box::new(super::polls::PollExpander) as Box<dyn MessageExpander>,
        Box::new(super::calendar::EventExpander),
        Box::new(super::games::GameExpander),
        Box::new(super::stickers::StickerExpander),
        Box::new(super::tasks::TaskExpander),   // ← neu
    ]
});
```

**5. `MessageDto` ergänzen** (`apps/api/src/dto.rs`) und in
`packages/shared/src/schemas/message.ts` spiegeln:

```rust
#[serde(skip_serializing_if = "Option::is_none")]
pub task: Option<TaskDto>,
```

**6. Typ freischalten**: `"task"` in `MESSAGE_TYPES`
(`apps/api/src/constants.rs` **und** `packages/shared/src/constants.ts`). Beide
Seiten prüfen gegen diese Liste – wer nur eine ändert, bekommt eine `422`.

Ein Expander, der scheitert, nimmt nie den ganzen Chat mit: Der Fehler landet im
Log, die Nachricht kommt ohne Anreicherung an.

### 7. Renderer im Frontend

```tsx
import type { MessageRendererProps } from '../types.js';

export function TaskBubble({ message, isMine }: MessageRendererProps) {
  const task = message.task;
  // Ein Client, der den Typ (noch) nicht kennt, darf nicht abstürzen.
  if (!task) return <p className="muted">Aufgabe nicht verfügbar</p>;

  return (
    <div className={`bubble task-bubble${isMine ? ' is-mine' : ''}`}>
      <span className="task-title">{task.title}</span>
      {task.doneAt ? <span className="task-done">erledigt</span> : null}
    </div>
  );
}
```

und in `module.ts`:

```ts
messageRenderers: { task: TaskBubble },
```

Fehlt für einen Typ ein Renderer, fällt der Chat auf die Textblase zurück –
eine unbekannte Nachricht macht die App also nicht kaputt.

---

## 4. Neues Mini-Spiel: „Schere Stein Papier"

Ein Spiel braucht drei Teile:

1. **Regeln in Rust** (`apps/api/src/games/`) – der Server entscheidet.
2. **TypeScript-Spiegel** (`packages/shared/src/games/`) – nur für die
   optimistische Anzeige und den Katalog offline.
3. **Spielbrett** (`apps/web/src/modules/games/boards/`) – die Darstellung.

Der Rest – Sitzung anlegen, Chat-Nachricht, Realtime, Push „Du bist am Zug",
Revanche – kommt von der Plattform.

### 4.1 Regeln: `apps/api/src/games/rock_paper_scissors.rs`

```rust
//! Schere Stein Papier – zwei gewonnene Runden entscheiden.
//!
//! Beide wählen gleichzeitig: `apply_move` prüft deshalb nicht die Reihenfolge,
//! sondern nur, dass niemand zweimal in derselben Runde wählt.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{GameDefinition, GameSeat, MoveContext, Outcome};

const ROUNDS_TO_WIN: i32 = 2;
const SHAPES: [&str; 3] = ["schere", "stein", "papier"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    /// Wahl je Sitzplatz in dieser Runde, `None` = steht noch aus.
    pub choices: Vec<Option<String>>,
    pub scores: Vec<i32>,
    pub round: i32,
    /// Aufgedeckte Wahl der letzten Runde, nur für die Anzeige.
    pub last: Option<Vec<String>>,
    pub winner: Option<i32>,
    pub draw: bool,
}

#[derive(Debug, Deserialize)]
struct Move {
    shape: String,
}

/// 0 = unentschieden, 1 = `a` gewinnt, 2 = `b` gewinnt.
fn compare(a: &str, b: &str) -> u8 {
    match (a, b) {
        (x, y) if x == y => 0,
        ("schere", "papier") | ("stein", "schere") | ("papier", "stein") => 1,
        _ => 2,
    }
}

pub struct RockPaperScissors;

impl GameDefinition for RockPaperScissors {
    fn key(&self) -> &'static str { "schere-stein-papier" }
    fn name(&self) -> &'static str { "Schere Stein Papier" }
    fn description(&self) -> &'static str { "Zwei gewonnene Runden – ihr wählt gleichzeitig." }
    fn emoji(&self) -> &'static str { "✌️" }
    fn min_players(&self) -> usize { 2 }
    fn max_players(&self) -> usize { 2 }

    fn initial_state(&self, _players: &[GameSeat]) -> Value {
        serde_json::to_value(State {
            choices: vec![None, None],
            scores: vec![0, 0],
            round: 1,
            last: None,
            winner: None,
            draw: false,
        })
        .expect("state serialises")
    }

    fn apply_move(&self, state: &Value, mv: &Value, ctx: &MoveContext<'_>) -> Result<Value, String> {
        let mut state: State = serde_json::from_value(state.clone())
            .map_err(|_| "Ungültiger Spielstand".to_string())?;
        let mv: Move =
            serde_json::from_value(mv.clone()).map_err(|_| "Ungültiger Zug".to_string())?;

        if state.choices.len() < 2 || state.scores.len() < 2 {
            return Err("Ungültiger Spielstand".into());
        }
        if state.winner.is_some() {
            return Err("Das Spiel ist beendet.".into());
        }
        if !SHAPES.contains(&mv.shape.as_str()) {
            return Err("Wähle Schere, Stein oder Papier.".into());
        }

        let seat = ctx.seat as usize;
        if state.choices.get(seat).map(Option::is_some).unwrap_or(true) {
            return Err("Du hast in dieser Runde schon gewählt.".into());
        }
        state.choices[seat] = Some(mv.shape);

        // Runde auswerten, sobald beide gewählt haben.
        if let (Some(a), Some(b)) = (state.choices[0].clone(), state.choices[1].clone()) {
            match compare(&a, &b) {
                1 => state.scores[0] += 1,
                2 => state.scores[1] += 1,
                _ => {}
            }
            state.last = Some(vec![a, b]);
            state.choices = vec![None, None];
            state.round += 1;
            if state.scores[0] >= ROUNDS_TO_WIN {
                state.winner = Some(0);
            } else if state.scores[1] >= ROUNDS_TO_WIN {
                state.winner = Some(1);
            }
        }

        serde_json::to_value(state).map_err(|_| "Spielstand nicht speicherbar".to_string())
    }

    /// Wer noch wählen muss. Bei gleichzeitigen Zügen ist das nur ein Hinweis
    /// für die Oberfläche – blockieren tut `apply_move`.
    fn current_seat(&self, state: &Value) -> Option<i32> {
        let state: State = serde_json::from_value(state.clone()).ok()?;
        if state.winner.is_some() {
            return None;
        }
        state.choices.iter().position(Option::is_none).map(|seat| seat as i32)
    }

    fn outcome(&self, state: &Value) -> Outcome {
        let Ok(state) = serde_json::from_value::<State>(state.clone()) else {
            return Outcome::default();
        };
        match state.winner {
            Some(seat) => Outcome { finished: true, draw: false, winner_seats: vec![seat] },
            None => Outcome::default(),
        }
    }

    fn describe(&self, state: &Value) -> String {
        let Ok(state) = serde_json::from_value::<State>(state.clone()) else {
            return "Schere Stein Papier".to_string();
        };
        let score = format!("{}:{}", state.scores.first().unwrap_or(&0), state.scores.get(1).unwrap_or(&0));
        match state.winner {
            Some(seat) => format!("Spieler {} gewinnt {score}", seat + 1),
            None => format!("Runde {} – {score}", state.round),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn seats() -> Vec<GameSeat> {
        vec![
            GameSeat { seat: 0, user_id: Uuid::now_v7() },
            GameSeat { seat: 1, user_id: Uuid::now_v7() },
        ]
    }

    fn play(state: Value, seat: i32, shape: &str, players: &[GameSeat]) -> Value {
        RockPaperScissors
            .apply_move(
                &state,
                &serde_json::json!({ "shape": shape }),
                &MoveContext { seat, user_id: players[seat as usize].user_id, players },
            )
            .expect("gültiger Zug")
    }

    #[test]
    fn stein_schlaegt_schere_und_zwei_runden_gewinnen() {
        let players = seats();
        let mut state = RockPaperScissors.initial_state(&players);
        for _ in 0..2 {
            state = play(state, 0, "stein", &players);
            state = play(state, 1, "schere", &players);
        }
        let outcome = RockPaperScissors.outcome(&state);
        assert!(outcome.finished);
        assert_eq!(outcome.winner_seats, vec![0]);
    }

    #[test]
    fn zweimal_waehlen_ist_verboten() {
        let players = seats();
        let state = RockPaperScissors.initial_state(&players);
        let state = play(state, 0, "stein", &players);
        assert!(RockPaperScissors
            .apply_move(
                &state,
                &serde_json::json!({ "shape": "papier" }),
                &MoveContext { seat: 0, user_id: players[0].user_id, players: &players },
            )
            .is_err());
    }
}
```

### 4.2 Eintragen in `apps/api/src/games/mod.rs`

```rust
pub mod connect_four;
pub mod rock_paper_scissors;         // ← neu
pub mod tic_tac_toe;

static REGISTRY: LazyLock<Vec<Box<dyn GameDefinition>>> = LazyLock::new(|| {
    vec![
        Box::new(tic_tac_toe::TicTacToe) as Box<dyn GameDefinition>,
        Box::new(connect_four::ConnectFour),
        Box::new(rock_paper_scissors::RockPaperScissors),   // ← neu
    ]
});
```

Damit erscheint das Spiel sofort in `GET /api/v1/games` und lässt sich über
`POST /api/v1/games/sessions` starten.

### 4.3 TypeScript-Spiegel: `packages/shared/src/games/rock-paper-scissors.ts`

Dieselben Regeln, damit der Client einen Zug sofort anzeigen kann, ohne auf die
Antwort zu warten – und damit er offline weiß, wie das Spiel heißt.
**Autoritativ bleibt Rust.** Weichen beide ab, gewinnt der Server, und der Client
korrigiert sich mit dem nächsten `game.updated`.

```ts
import type { GameDefinition, GameMoveResult, GameOutcome, GameSeat } from './types.js';

export type Shape = 'schere' | 'stein' | 'papier';

export interface RockPaperScissorsState {
  choices: (Shape | null)[];
  scores: number[];
  round: number;
  last: Shape[] | null;
  winner: number | null;
  draw: boolean;
}

export interface RockPaperScissorsMove {
  shape: Shape;
}

const SHAPES: Shape[] = ['schere', 'stein', 'papier'];
const ROUNDS_TO_WIN = 2;

/** 0 = unentschieden, 1 = a gewinnt, 2 = b gewinnt. */
function compare(a: Shape, b: Shape): 0 | 1 | 2 {
  if (a === b) return 0;
  const aWins =
    (a === 'schere' && b === 'papier') ||
    (a === 'stein' && b === 'schere') ||
    (a === 'papier' && b === 'stein');
  return aWins ? 1 : 2;
}

export const rockPaperScissors: GameDefinition<RockPaperScissorsState, RockPaperScissorsMove> = {
  key: 'schere-stein-papier',
  name: 'Schere Stein Papier',
  description: 'Zwei gewonnene Runden – ihr wählt gleichzeitig.',
  emoji: '✌️',
  minPlayers: 2,
  maxPlayers: 2,

  createInitialState(): RockPaperScissorsState {
    return {
      choices: [null, null],
      scores: [0, 0],
      round: 1,
      last: null,
      winner: null,
      draw: false,
    };
  },

  parseMove(raw: unknown): RockPaperScissorsMove | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const shape = (raw as { shape?: unknown }).shape;
    return typeof shape === 'string' && SHAPES.includes(shape as Shape)
      ? { shape: shape as Shape }
      : null;
  },

  applyMove(state, move, ctx): GameMoveResult<RockPaperScissorsState> {
    if (state.winner != null) return { ok: false, error: 'Das Spiel ist beendet.' };
    if (state.choices[ctx.seat] != null) {
      return { ok: false, error: 'Du hast in dieser Runde schon gewählt.' };
    }

    const next: RockPaperScissorsState = {
      ...state,
      choices: state.choices.slice(),
      scores: state.scores.slice(),
    };
    next.choices[ctx.seat] = move.shape;

    const [a, b] = next.choices;
    if (a && b) {
      const result = compare(a, b);
      if (result === 1) next.scores[0] += 1;
      if (result === 2) next.scores[1] += 1;
      next.last = [a, b];
      next.choices = [null, null];
      next.round += 1;
      if (next.scores[0] >= ROUNDS_TO_WIN) next.winner = 0;
      else if (next.scores[1] >= ROUNDS_TO_WIN) next.winner = 1;
    }
    return { ok: true, state: next };
  },

  currentSeat(state): number | null {
    if (state.winner != null) return null;
    const open = state.choices.findIndex((choice) => choice == null);
    return open < 0 ? null : open;
  },

  getOutcome(state): GameOutcome {
    return {
      finished: state.winner != null,
      draw: false,
      winnerSeats: state.winner != null ? [state.winner] : [],
    };
  },

  describe(state, _players: GameSeat[]): string {
    const score = `${state.scores[0] ?? 0}:${state.scores[1] ?? 0}`;
    return state.winner != null
      ? `Spieler ${state.winner + 1} gewinnt ${score}`
      : `Runde ${state.round} – ${score}`;
  },
};
```

Dann in `packages/shared/src/games/registry.ts`:

```ts
import { rockPaperScissors } from './rock-paper-scissors.js';

registerGame(ticTacToe);
registerGame(connectFour);
registerGame(rockPaperScissors); // ← neu
```

und in `packages/shared/src/index.ts`:

```ts
export * from './games/rock-paper-scissors.js';
```

### 4.4 Spielbrett: `apps/web/src/modules/games/boards/RockPaperScissorsBoard.tsx`

```tsx
import type { RockPaperScissorsState, Shape } from '@initiative/shared';
import type { GameBoardProps, GameMiniBoardProps } from './registry.js';
import { BoardStatus } from './BoardStatus.js';

const CHOICES: { shape: Shape; icon: string; label: string }[] = [
  { shape: 'schere', icon: '✌️', label: 'Schere' },
  { shape: 'stein', icon: '✊', label: 'Stein' },
  { shape: 'papier', icon: '✋', label: 'Papier' },
];

/** Liest den Serverstand defensiv – ein unbekanntes Format bleibt leer. */
function readState(raw: unknown): RockPaperScissorsState {
  const value = (
    typeof raw === 'object' && raw !== null ? raw : {}
  ) as Partial<RockPaperScissorsState>;
  return {
    choices: Array.isArray(value.choices) ? (value.choices as (Shape | null)[]) : [null, null],
    scores: Array.isArray(value.scores) ? (value.scores as number[]) : [0, 0],
    round: typeof value.round === 'number' ? value.round : 1,
    last: Array.isArray(value.last) ? (value.last as Shape[]) : null,
    winner: typeof value.winner === 'number' ? value.winner : null,
    draw: value.draw === true,
  };
}

export function RockPaperScissorsBoard({ session, mySeat, onMove, busy }: GameBoardProps) {
  const state = readState(session.state);
  const chosen = mySeat == null ? null : (state.choices[mySeat] ?? null);
  const canPlay = session.status === 'active' && mySeat != null && chosen == null;

  return (
    <div className="game-board-wrap">
      <p className="rps-score" aria-live="polite">
        Runde {state.round} · {state.scores[0] ?? 0} : {state.scores[1] ?? 0}
      </p>

      <div className="rps-choices" role="group" aria-label="Deine Wahl">
        {CHOICES.map(({ shape, icon, label }) => (
          <button
            key={shape}
            type="button"
            className={`rps-choice${chosen === shape ? ' is-chosen' : ''}`}
            aria-label={label}
            aria-pressed={chosen === shape}
            disabled={busy || !canPlay}
            onClick={() => onMove({ shape })}
          >
            <span className="rps-icon" aria-hidden="true">
              {icon}
            </span>
            <span className="rps-label">{label}</span>
          </button>
        ))}
      </div>

      {chosen && state.winner == null ? (
        <p className="muted">Gewählt – warte auf dein Gegenüber.</p>
      ) : null}
      {state.last ? <p className="muted">Letzte Runde: {state.last.join(' gegen ')}</p> : null}

      <BoardStatus session={session} />
    </div>
  );
}

/** Kompakte, nicht bedienbare Vorschau für die Chat-Blase. */
export function RockPaperScissorsMini({ session }: GameMiniBoardProps) {
  const state = readState(session.state);
  return (
    <span className="rps-mini">
      ✌️ {state.scores[0] ?? 0} : {state.scores[1] ?? 0}
    </span>
  );
}
```

Die Touch-Ziele sind mindestens 44 px hoch – in `styles.css` des Spiele-Moduls:

```css
.rps-choices {
  display: flex;
  gap: 0.75rem;
  justify-content: center;
}

.rps-choice {
  min-width: 5rem;
  min-height: 4.5rem;
  padding: 0.75rem;
  border-radius: var(--radius);
  border: 2px solid var(--border);
  background: var(--surface);
  display: grid;
  gap: 0.25rem;
  justify-items: center;
}

.rps-choice.is-chosen {
  border-color: var(--accent);
}

.rps-icon {
  font-size: 1.75rem;
  line-height: 1;
}
.rps-label {
  font-size: 0.8rem;
}
```

### 4.5 Brett registrieren

`apps/web/src/modules/games/boards/registry.ts`:

```ts
import { RockPaperScissorsBoard, RockPaperScissorsMini } from './RockPaperScissorsBoard.js';

export const gameBoards: Record<string, ComponentType<GameBoardProps>> = {
  'tic-tac-toe': TicTacToeBoard,
  'connect-four': ConnectFourBoard,
  'schere-stein-papier': RockPaperScissorsBoard, // ← neu
};

export const gameMiniBoards: Record<string, ComponentType<GameMiniBoardProps>> = {
  'tic-tac-toe': TicTacToeMini,
  'connect-four': ConnectFourMini,
  'schere-stein-papier': RockPaperScissorsMini, // ← neu
};
```

Der `gameKey` muss an **allen drei Stellen** identisch sein:
`schere-stein-papier`.

### 4.6 Testen

```bash
cargo test --manifest-path apps/api/Cargo.toml rock_paper
pnpm --filter @initiative/web exec tsc -p tsconfig.json --noEmit
pnpm dev
```

Dann in einem Chat auf **📎 → 🎮 Spiel → Schere Stein Papier**. Am besten zu
zweit testen: ein Fenster als `anna`, ein privates Fenster als `ben`.

---

## 5. Realtime-Ereignisse

```rust
// an bestimmte Benutzer – geht über den Bus auch an andere Instanzen
let audience = member_ids(&state.pool, conversation_id).await?;
state.hub.publish(audience, Event::new("task.updated", json!({ "task": dto }))).await;
```

Im Frontend abonnierst du deinen Typ über den Realtime-Client. `on()` gibt eine
Abmeldefunktion zurück – genau das, was `useEffect` erwartet:

```ts
import { useEffect } from 'react';
import { realtime } from '../../lib/realtime.js';

export function useTaskEvents(onTask: (task: TaskDto) => void): void {
  useEffect(() => realtime.on('task.updated', (payload) => onTask(payload.task)), [onTask]);
}
```

Damit `on('task.updated', …)` typsicher ist, gehört das Ereignis in `ServerEvent`
in `packages/shared/src/realtime/events.ts`:

```ts
| { type: 'task.updated'; payload: { task: TaskDto } }
```

Client → Server läuft über `realtime.send({ type: 'typing', payload: { … } })`;
neue Client-Ereignisse brauchen zusätzlich einen Zweig in `handle_client_event`
(`apps/api/src/realtime/ws.rs`) und einen Eintrag in `ClientEvent`.

Drei Dinge, die du wissen solltest:

- **Unbekannte Typen werden ignoriert**, auf beiden Seiten. Ein alter Client
  bricht also nicht, wenn ein neues Modul zu senden beginnt.
- **Der Bus hat ein Größenlimit.** `NOTIFY` in Postgres verträgt keine großen
  Nutzlasten. Wird es eng, schickt der Server stattdessen ein `sync.hint`
  (`{ scope, conversationId? }`) – dein Client muss dann per REST nachladen
  können. Plane das ein, statt große Objekte zu verschicken.
- **`publish` prüft keine Berechtigungen.** Du bestimmst die Empfängerliste –
  gib nur Mitglieder hinein.

## 6. Push-Benachrichtigungen

```rust
use crate::dto::PushPayload;
use crate::services::notify::notify_users;

notify_users(
    &state,
    &[assignee_id],
    &PushPayload {
        title: "Neue Aufgabe".to_string(),
        body: task.title.clone(),
        tag: Some(format!("task:{}", task.id)),
        url: format!("/aufgaben?task={}", task.id),
        conversation_id: Some(conversation_id),
        message_id: None,
        kind: "task".to_string(),
    },
)
.await;
```

- **Unter 4 KB bleiben** – mehr nimmt kein Push-Dienst an.
- **`tag`** fasst Benachrichtigungen zusammen: Gleicher Tag ersetzt die alte,
  statt eine zweite zu stapeln.
- **`url`** ist ein Pfad **innerhalb der PWA**; der Service Worker öffnet ihn
  beim Antippen.
- Ohne VAPID-Schlüssel passiert schlicht nichts – kein Fehler, keine Zustellung.
- Stummgeschaltete Chats werden in `services/notify.rs` bereits ausgesortiert;
  wenn dein Modul das auch braucht, orientiere dich dort.

## 7. Migrationen im Betrieb

- Neue Datei mit **höherer Nummer**: `0003_<name>.sql`.
- **Nie** eine ausgelieferte Migration ändern – sqlx vergleicht Prüfsummen und
  verweigert sonst den Start.
- Migrationen laufen beim Start automatisch (`RUN_MIGRATIONS=true`). Bei
  mehreren Instanzen ist das unkritisch: sqlx nimmt eine Sperre.
- Additiv denken: Spalten mit `default` hinzufügen, alte erst entfernen, wenn
  garantiert keine alte Instanz mehr läuft. Sonst fällt der Rolling Deploy auf
  die Nase.
- Vor größeren Umbauten in Produktion ein Backup ziehen
  (siehe [DEPLOYMENT.md](DEPLOYMENT.md)).

---

## Checkliste vor dem Pull Request

```bash
cd /home/user/Initiative

pnpm --filter @initiative/web exec tsc -p tsconfig.json --noEmit
pnpm -r test
cargo fmt --manifest-path apps/api/Cargo.toml
cargo clippy --manifest-path apps/api/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path apps/api/Cargo.toml
```

- [ ] Jede Route mit Chat-Bezug ruft `assert_membership`.
- [ ] Fehler kommen aus `AppError::*`, nicht als `panic!` oder nacktes `String`.
- [ ] DTO-Feldnamen in camelCase, gespiegelt in `packages/shared`.
- [ ] Neue Limits und Aufzählungen stehen **auf beiden Seiten** identisch
      (`apps/api/src/constants.rs` ↔ `packages/shared/src/constants.ts`).
- [ ] Im Frontend: Lade-, Leer- und Fehlerzustand vorhanden, Fehler per
      `toast(text, 'error')`.
- [ ] Sichtbare Texte auf Deutsch (du-Form), Bezeichner und Kommentare Englisch.
- [ ] Touch-Ziele ≥ 44 px, auf iPhone (Safari) und Android geprüft.
- [ ] Eigenes CSS ausschließlich in der `styles.css` des Moduls.
- [ ] Keine neuen npm-Abhängigkeiten (verfügbar: react, react-dom,
      react-router-dom, zustand, idb, `@initiative/shared`).
- [ ] Migration ist neu nummeriert und additiv.

## Weiterlesen

- [ARCHITECTURE.md](ARCHITECTURE.md) – Datenfluss und Erweiterungspunkte
- [API.md](API.md) – bestehender Vertrag
- [FEATURES.md](FEATURES.md) – was es schon gibt
