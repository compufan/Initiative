-- Ausgaben: wer hat was ausgelegt, wer schuldet wem wie viel.

-- ---------------------------------------------------------------------------
-- Eine Ausgabe.
--
-- Beträge stehen in Cent. Fließkomma wäre hier falsch: 0.1 + 0.2 ist in
-- Fließkomma nicht 0.3, und bei Geld summiert sich das zu Beträgen, die
-- niemand nachrechnen kann.
-- ---------------------------------------------------------------------------
create table if not exists expenses (
  id              uuid primary key,
  conversation_id uuid references conversations (id) on delete cascade,
  -- Zu welchem Termin sie gehört, falls zu einem.
  event_id        uuid references calendar_events (id) on delete set null,
  created_by      uuid references users (id) on delete set null,
  title           text        not null,
  note            text,
  amount_cents    bigint      not null check (amount_cents > 0),
  currency        text        not null default 'EUR',
  -- Wer ausgelegt hat.
  paid_by         uuid references users (id) on delete set null,
  spent_at        timestamptz not null default now(),
  -- participants – alle mit einem Anteil (Voreinstellung)
  -- conversation – alle im zugehörigen Chat
  -- listed       – nur namentlich Genannte
  visibility      text        not null default 'participants'
                    check (visibility in ('participants', 'conversation', 'listed')),
  settled_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
create index if not exists expenses_conversation_idx on expenses (conversation_id, spent_at desc);
create index if not exists expenses_event_idx on expenses (event_id);
create index if not exists expenses_payer_idx on expenses (paid_by);

-- Wer welchen Anteil trägt. Die Summe der Anteile ergibt den Betrag.
create table if not exists expense_shares (
  expense_id   uuid   not null references expenses (id) on delete cascade,
  user_id      uuid   not null references users (id) on delete cascade,
  amount_cents bigint not null check (amount_cents >= 0),
  settled_at   timestamptz,
  primary key (expense_id, user_id)
);
create index if not exists expense_shares_user_idx on expense_shares (user_id);

-- Bei `visibility = 'listed'`: wer sie sehen darf.
create table if not exists expense_viewers (
  expense_id uuid not null references expenses (id) on delete cascade,
  user_id    uuid not null references users (id) on delete cascade,
  primary key (expense_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Wer sie ausdrücklich NICHT sehen soll.
--
-- Der Anlass ist das Geschenk: Drei legen zusammen, der Beschenkte ist im
-- selben Chat und soll nichts davon merken.
--
-- Wichtig – und in der Anwendungsschicht erzwungen: verbergen lässt sich eine
-- Ausgabe nur vor jemandem, der KEINEN Anteil daran hat. Sonst schuldete er
-- Geld, das in seinem eigenen Saldo nicht auftaucht, und der Saldo wäre still
-- falsch statt sichtbar unvollständig.
-- ---------------------------------------------------------------------------
create table if not exists expense_hidden_from (
  expense_id uuid not null references expenses (id) on delete cascade,
  user_id    uuid not null references users (id) on delete cascade,
  primary key (expense_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Wie man jemandem Geld zurückgibt.
--
-- Ausdrücklich OHNE PayPal-Geschäftskonto: `paypal_me` ist nur der Name aus
-- dem persönlichen PayPal.Me-Link, den jeder kostenlos anlegen kann. Die App
-- baut daraus eine Adresse mit Betrag – es läuft kein Geld über uns, es gibt
-- keine Gebühren und nichts einzurichten.
--
-- Dazu Bankdaten für eine gewöhnliche Überweisung.
-- ---------------------------------------------------------------------------
create table if not exists payment_profiles (
  user_id        uuid primary key references users (id) on delete cascade,
  -- Nur der Name, nicht die ganze Adresse: "maxmuster", nicht "paypal.me/maxmuster".
  paypal_me      text,
  iban           text,
  bic            text,
  account_holder text,
  note           text,
  updated_at     timestamptz not null default now()
);
