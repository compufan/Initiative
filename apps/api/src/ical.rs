//! iCalendar (RFC 5545) serialisation.
//!
//! Used for the per-user subscription feed that iOS, Android and Outlook can
//! subscribe to, and for single-event downloads straight from a chat bubble.

use chrono::{DateTime, Datelike, Duration, Timelike, Utc};

pub struct IcsEvent {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub all_day: bool,
    pub rrule: Option<String>,
    pub url: Option<String>,
    pub updated_at: DateTime<Utc>,
    pub reminder_minutes: Vec<i32>,
}

pub struct IcsCalendar {
    pub name: String,
    pub description: Option<String>,
    pub refresh_interval: Option<String>,
    pub domain: String,
}

fn utc_stamp(value: DateTime<Utc>) -> String {
    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        value.year(),
        value.month(),
        value.day(),
        value.hour(),
        value.minute(),
        value.second()
    )
}

fn date_stamp(value: DateTime<Utc>) -> String {
    format!("{:04}{:02}{:02}", value.year(), value.month(), value.day())
}

fn escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace(';', "\\;")
        .replace(',', "\\,")
        .replace("\r\n", "\\n")
        .replace('\n', "\\n")
}

/// RFC 5545 requires lines to be folded at 75 octets.
fn fold(line: &str) -> String {
    if line.len() <= 74 {
        return line.to_string();
    }
    let bytes = line.as_bytes();
    let mut out = String::with_capacity(line.len() + line.len() / 70);
    let mut index = 0usize;
    let mut limit = 74usize;
    while index < bytes.len() {
        let mut end = (index + limit).min(bytes.len());
        // Never split a UTF-8 sequence.
        while end > index && !line.is_char_boundary(end) {
            end -= 1;
        }
        if index > 0 {
            out.push_str("\r\n ");
        }
        out.push_str(&line[index..end]);
        index = end;
        limit = 73;
    }
    out
}

fn event_lines(event: &IcsEvent, domain: &str, out: &mut Vec<String>) {
    out.push("BEGIN:VEVENT".to_string());
    out.push(format!("UID:{}@{}", event.id, domain));
    out.push(format!("DTSTAMP:{}", utc_stamp(event.updated_at)));

    if event.all_day {
        out.push(format!(
            "DTSTART;VALUE=DATE:{}",
            date_stamp(event.starts_at)
        ));
        // DTEND is exclusive for all-day events.
        out.push(format!(
            "DTEND;VALUE=DATE:{}",
            date_stamp(event.ends_at + Duration::days(1))
        ));
    } else {
        out.push(format!("DTSTART:{}", utc_stamp(event.starts_at)));
        out.push(format!("DTEND:{}", utc_stamp(event.ends_at)));
    }

    out.push(format!("SUMMARY:{}", escape(&event.title)));
    if let Some(description) = &event.description {
        out.push(format!("DESCRIPTION:{}", escape(description)));
    }
    if let Some(location) = &event.location {
        out.push(format!("LOCATION:{}", escape(location)));
    }
    if let Some(url) = &event.url {
        out.push(format!("URL:{}", escape(url)));
    }
    if let Some(rrule) = &event.rrule {
        out.push(format!("RRULE:{}", rrule.trim_start_matches("RRULE:")));
    }
    for minutes in &event.reminder_minutes {
        out.push("BEGIN:VALARM".to_string());
        out.push("ACTION:DISPLAY".to_string());
        out.push(format!("DESCRIPTION:{}", escape(&event.title)));
        out.push(format!("TRIGGER:-PT{minutes}M"));
        out.push("END:VALARM".to_string());
    }
    out.push("END:VEVENT".to_string());
}

pub fn build_calendar(events: &[IcsEvent], calendar: &IcsCalendar) -> String {
    let mut lines = vec![
        "BEGIN:VCALENDAR".to_string(),
        "VERSION:2.0".to_string(),
        "PRODID:-//Initiative//Kalender//DE".to_string(),
        "CALSCALE:GREGORIAN".to_string(),
        "METHOD:PUBLISH".to_string(),
        format!("X-WR-CALNAME:{}", escape(&calendar.name)),
        format!("NAME:{}", escape(&calendar.name)),
    ];
    if let Some(description) = &calendar.description {
        lines.push(format!("X-WR-CALDESC:{}", escape(description)));
        lines.push(format!("DESCRIPTION:{}", escape(description)));
    }
    if let Some(interval) = &calendar.refresh_interval {
        lines.push(format!("REFRESH-INTERVAL;VALUE=DURATION:{interval}"));
        lines.push(format!("X-PUBLISHED-TTL:{interval}"));
    }
    for event in events {
        event_lines(event, &calendar.domain, &mut lines);
    }
    lines.push("END:VCALENDAR".to_string());

    let folded: Vec<String> = lines.iter().map(|line| fold(line)).collect();
    format!("{}\r\n", folded.join("\r\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn sample() -> IcsEvent {
        IcsEvent {
            id: "01234567-89ab-7def-8000-000000000000".to_string(),
            title: "Wöchentliches Treffen; mit Kaffee".to_string(),
            description: Some("Zeile eins\nZeile zwei".to_string()),
            location: Some("Küche, 2. Stock".to_string()),
            starts_at: Utc.with_ymd_and_hms(2026, 8, 24, 10, 0, 0).unwrap(),
            ends_at: Utc.with_ymd_and_hms(2026, 8, 24, 11, 0, 0).unwrap(),
            all_day: false,
            rrule: Some("FREQ=WEEKLY;COUNT=4".to_string()),
            url: Some("https://example.com/kalender".to_string()),
            updated_at: Utc.with_ymd_and_hms(2026, 8, 20, 8, 0, 0).unwrap(),
            reminder_minutes: vec![60],
        }
    }

    #[test]
    fn writes_a_valid_calendar() {
        let ics = build_calendar(
            &[sample()],
            &IcsCalendar {
                name: "Initiative".to_string(),
                description: None,
                refresh_interval: Some("PT1H".to_string()),
                domain: "example.com".to_string(),
            },
        );
        assert!(ics.starts_with("BEGIN:VCALENDAR\r\n"));
        assert!(ics.ends_with("END:VCALENDAR\r\n"));
        assert!(ics.contains("DTSTART:20260824T100000Z"));
        assert!(ics.contains("RRULE:FREQ=WEEKLY;COUNT=4"));
        assert!(ics.contains("BEGIN:VALARM"));
        assert!(ics.contains("TRIGGER:-PT60M"));
    }

    #[test]
    fn escapes_special_characters() {
        let ics = build_calendar(
            &[sample()],
            &IcsCalendar {
                name: "Test".to_string(),
                description: None,
                refresh_interval: None,
                domain: "example.com".to_string(),
            },
        );
        assert!(ics.contains("Wöchentliches Treffen\\; mit Kaffee"));
        assert!(ics.contains("Zeile eins\\nZeile zwei"));
        assert!(ics.contains("Küche\\, 2. Stock"));
    }

    #[test]
    fn folds_long_lines_without_breaking_utf8() {
        let mut event = sample();
        event.title = "Ü".repeat(200);
        let ics = build_calendar(
            &[event],
            &IcsCalendar {
                name: "Test".to_string(),
                description: None,
                refresh_interval: None,
                domain: "example.com".to_string(),
            },
        );
        for line in ics.split("\r\n") {
            assert!(line.len() <= 75, "line too long: {}", line.len());
        }
        // Unfolding must restore the original title.
        let unfolded = ics.replace("\r\n ", "");
        assert!(unfolded.contains(&"Ü".repeat(200)));
    }

    #[test]
    fn all_day_events_use_exclusive_end_dates() {
        let mut event = sample();
        event.all_day = true;
        let ics = build_calendar(
            &[event],
            &IcsCalendar {
                name: "Test".to_string(),
                description: None,
                refresh_interval: None,
                domain: "example.com".to_string(),
            },
        );
        assert!(ics.contains("DTSTART;VALUE=DATE:20260824"));
        assert!(ics.contains("DTEND;VALUE=DATE:20260825"));
    }
}
